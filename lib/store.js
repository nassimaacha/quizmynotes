// Stétho: shared helpers for accounts, sessions and usage.
// Data lives in Upstash Redis (Vercel Marketplace), reached over its REST API.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const DB_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const DAY_MS = 86400000;
export const SESSION_DAYS = 30;
export const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS) || 30);
export const DAILY_USER_USD = Number(process.env.DAILY_USER_USD) || 1;
export const DAILY_TOTAL_USD = Number(process.env.DAILY_TOTAL_USD) || 15;
const PRICE_IN = Number(process.env.PRICE_IN_PER_MTOK) || 2;   // USD per million input tokens
const PRICE_OUT = Number(process.env.PRICE_OUT_PER_MTOK) || 10; // USD per million output tokens
const KEEP_DAYS = 120;

export const hasDb = () => !!(DB_URL && DB_TOKEN);

async function call(path, body) {
  const r = await fetch(DB_URL + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + DB_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error('db ' + r.status + ' ' + ((j && j.error) || ''));
  return j;
}
const strs = cmd => cmd.map(x => String(x));
export async function db(...cmd) {
  const j = await call('', strs(cmd));
  if (j.error) throw new Error(j.error);
  return j.result;
}
export async function pipe(cmds) {
  if (!cmds.length) return [];
  const j = await call('/pipeline', cmds.map(strs));
  return j.map(x => { if (x && x.error) throw new Error(x.error); return x ? x.result : null; });
}
export function obj(arr) {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}
export const sha = s => createHash('sha256').update(String(s)).digest('hex');
export function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* passwords */
export async function hashPw(pw) {
  const salt = randomBytes(16).toString('hex');
  const h = await scrypt(String(pw), salt, 64);
  return `s1$${salt}$${h.toString('hex')}`;
}
export async function checkPw(pw, stored) {
  const [v, salt, hex] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !hex) { await scrypt(String(pw), 'dummy-salt', 64); return false; }
  const h = await scrypt(String(pw), salt, 64);
  const ref = Buffer.from(hex, 'hex');
  return ref.length === h.length && timingSafeEqual(ref, h);
}
export function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = randomBytes(10);
  return Array.from(b, x => abc[x % abc.length]).join('');
}

/* input cleaning */
export function cleanEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return s.length <= 120 && /^[^\s@|<>]+@[^\s@|<>]+\.[^\s@|<>]+$/.test(s) ? s : '';
}
export function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>|]/g, '').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 60 ? s : '';
}

/* days (Casablanca time, so a "day" matches the students' day) */
export function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function lastDays(n) {
  const [y, m, d] = dayKey().split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  return Array.from({ length: n }, (_, i) => new Date(base - i * DAY_MS).toISOString().slice(0, 10));
}
export function weekOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const wd = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(t - wd * DAY_MS).toISOString().slice(0, 10);
}

/* users and sessions */
export async function getUser(email) {
  if (!email) return null;
  const u = obj(await db('HGETALL', 'u:' + email));
  return u.email ? u : null;
}
export function publicUser(u) {
  const end = Number(u.trialEnd) || 0;
  return { name: u.name, email: u.email, trialEnd: end, daysLeft: Math.ceil((end - Date.now()) / DAY_MS) };
}
export async function newSession(email) {
  const tok = randomBytes(32).toString('base64url');
  const h = sha(tok), ttl = SESSION_DAYS * 86400;
  await pipe([['SET', 'sess:' + h, email, 'EX', ttl], ['SADD', 'usess:' + email, h], ['EXPIRE', 'usess:' + email, ttl]]);
  return tok;
}
export async function endSession(tok) {
  if (!tok) return;
  const h = sha(tok);
  const email = await db('GET', 'sess:' + h);
  await pipe([['DEL', 'sess:' + h], ...(email ? [['SREM', 'usess:' + email, h]] : [])]);
}
export async function endAllSessions(email) {
  const hs = (await db('SMEMBERS', 'usess:' + email)) || [];
  await pipe([...hs.map(h => ['DEL', 'sess:' + h]), ['DEL', 'usess:' + email]]);
}
export function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}
export async function authUser(request) {
  const tok = bearer(request);
  if (!tok || tok.length > 100) return { error: 'no_session', status: 401 };
  const email = await db('GET', 'sess:' + sha(tok));
  const user = email ? await getUser(email) : null;
  if (!user) return { error: 'no_session', status: 401 };
  if (user.status === 'disabled') return { error: 'disabled', status: 403 };
  if (user.status !== 'active') return { error: 'no_session', status: 401 };
  return { user, token: tok };
}

/* usage */
export const costUsd = (inTok, outTok) => (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6;
export async function usageToday(email) {
  const r = await db('HMGET', 'day:' + dayKey(), email + '|usd', '_all|usd');
  return { user: Number(r && r[0]) || 0, all: Number(r && r[1]) || 0 };
}
export async function recordUsage(email, inTok, outTok, isTest) {
  const usd = costUsd(inTok, outTok).toFixed(6);
  const k = 'day:' + dayKey();
  const cmds = [
    ['HINCRBY', k, email + '|calls', 1],
    ['HINCRBYFLOAT', k, email + '|usd', usd],
    ['HINCRBYFLOAT', k, '_all|usd', usd],
    ['HINCRBY', k, email + '|tin', inTok],
    ['HINCRBY', k, email + '|tout', outTok],
    ['EXPIRE', k, KEEP_DAYS * 86400],
    ['HSET', 'u:' + email, 'lastSeen', Date.now()]
  ];
  if (isTest) cmds.push(['HINCRBY', k, email + '|tests', 1]);
  await pipe(cmds);
}
export async function forgetUsage(email) {
  const fields = ['calls', 'usd', 'tin', 'tout', 'tests'].map(f => email + '|' + f);
  await pipe(lastDays(KEEP_DAYS).map(d => ['HDEL', 'day:' + d, ...fields]));
}
