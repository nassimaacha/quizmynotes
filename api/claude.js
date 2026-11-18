// QuizMyNotes: private proxy to the Anthropic API.
// Keeps the API key on the server, only answers logged in users with an active trial,
// applies daily spending caps and records usage for the admin page.
import {
  hasDb, authUser, usageToday, recordUsage, DAILY_USER_USD, DAILY_TOTAL_USD
} from '../lib/store.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MARK = '\n[[QMN:';
const MAX_PROMPT_CHARS = 400000;
const MAX_GRADE_CHARS = 60000;
const MAX_IMAGES = 12;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const config = { maxDuration: 300 };

// Only a short code goes to the browser; details stay in the Vercel logs.
function fail(code, status) {
  return Response.json({ error: code }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY || !hasDb()) return fail('not_configured', 500);

  let auth;
  try { auth = await authUser(request); } catch (e) { console.error('auth', e); return fail('upstream_error', 502); }
  if (auth.error) return fail(auth.error, auth.status);
  const user = auth.user;
  if ((Number(user.trialEnd) || 0) <= Date.now()) return fail('trial_over', 402);

  let body;
  try { body = await request.json(); } catch { return fail('invalid_request', 400); }

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return fail('invalid_request', 400);
  if (prompt.length > MAX_PROMPT_CHARS) return fail('prompt_too_large', 413);
  const purpose = body.purpose === 'grade' ? 'grade' : 'generate';
  const part = Math.max(1, Math.floor(Number(body.part) || 1));
  if (purpose === 'grade' && prompt.length > MAX_GRADE_CHARS) return fail('prompt_too_large', 413);

  // Daily caps. Grading is cheap and never blocked by the personal cap,
  // so nobody gets stuck halfway through a test. Later parts of a long test get some extra room.
  let used;
  try { used = await usageToday(user.email); } catch (e) { console.error('usage read', e); return fail('upstream_error', 502); }
  if (used.all >= DAILY_TOTAL_USD) return fail('quota_global', 429);
  if (purpose === 'generate' && used.user >= DAILY_USER_USD * (part === 1 ? 1 : 1.5)) return fail('quota_user', 429);

  const images = purpose === 'grade' ? [] : (Array.isArray(body.images) ? body.images : [])
    .filter(im => im && IMAGE_TYPES.has(im.media_type) && typeof im.data === 'string' && im.data.length > 0)
    .slice(0, MAX_IMAGES);
  const maxTokens = Math.max(256, Math.min(Number(body.max_tokens) || 8000, 20000));

  const content = [
    ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
    { type: 'text', text: prompt }
  ];

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream: true, messages: [{ role: 'user', content }] }),
      signal: request.signal
    });
  } catch {
    return fail('upstream_error', 502);
  }

  if (!upstream.ok) {
    let type = '', message = '';
    try { const j = await upstream.json(); type = j?.error?.type || ''; message = j?.error?.message || ''; } catch {}
    console.error('Anthropic error', upstream.status, type, message);
    if (upstream.status === 429) return fail('rate_limited', 429, message);
    if (upstream.status === 401 || upstream.status === 403) return fail('bad_key', 502, message);
    if (upstream.status === 413) return fail('prompt_too_large', 413, message);
    if (/credit balance/i.test(message)) return fail('no_credits', 402, message);
    if (upstream.status === 529 || type === 'overloaded_error') return fail('overloaded', 503, message);
    if (upstream.status === 404 || /model/i.test(message)) return fail('bad_model', 502, message);
    if (/too long|too large|maximum/i.test(message)) return fail('prompt_too_large', 413, message);
    return fail('upstream_error', 502, message);
  }

  // Turn Anthropic's event stream into plain text for the page, and count tokens on the way.
  const enc = new TextEncoder();
  let inTok = 0, outTok = 0;
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const evt = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = evt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
            if (!data) continue;
            let d;
            try { d = JSON.parse(data); } catch { continue; }
            if (d.type === 'message_start') {
              const u = d.message?.usage || {};
              inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            } else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
              controller.enqueue(enc.encode(d.delta.text));
            } else if (d.type === 'message_delta') {
              if (typeof d.usage?.output_tokens === 'number') outTok = d.usage.output_tokens;
              if (d.delta?.stop_reason === 'max_tokens') controller.enqueue(enc.encode(MARK + 'truncated]]'));
            } else if (d.type === 'error') {
              controller.enqueue(enc.encode(MARK + (d.error?.type === 'overloaded_error' ? 'overloaded' : 'upstream_error') + ']]'));
            }
          }
        }
      } catch {
        if (!request.signal?.aborted) { try { controller.enqueue(enc.encode(MARK + 'upstream_error]]')); } catch {} }
      }
      if (inTok || outTok) {
        try { await recordUsage(user.email, inTok, outTok, purpose === 'generate' && part === 1 && outTok > 0); }
        catch (e) { console.error('usage write', e); }
      }
      try { controller.close(); } catch {}
    },
    cancel() { try { upstream.body.cancel(); } catch {} }
  });

  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
