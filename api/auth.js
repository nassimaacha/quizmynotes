// QuizMyNotes: sign up, log in, log out, and "who am I".
// New accounts start as "pending" until approved on the admin page.
import {
  db, pipe, hasDb, json, getUser, publicUser, hashPw, checkPw, cleanEmail, cleanName,
  newSession, endSession, authUser, bearer, dayKey, isPremium, readTheme, ACCENTS
} from '../lib/store.js';

const MAX_FAILS = 10;      // wrong passwords before a 15 minute lock
const MAX_SIGNUPS_DAY = 30;

// Current user (used when the page opens).
export async function GET(request) {
  if (!hasDb()) return json({ error: 'not_configured' }, 500);
  try {
    const a = await authUser(request);
    if (a.error) return json({ error: a.error }, a.status);
    return json({ user: publicUser(a.user) });
  } catch (e) {
    console.error('auth me', e);
    return json({ error: 'upstream_error' }, 502);
  }
}

export async function POST(request) {
  if (!hasDb()) return json({ error: 'not_configured' }, 500);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  try {
    if (b.action === 'signup') return await signup(b);
    if (b.action === 'login') return await login(b);
    if (b.action === 'logout') { await endSession(bearer(request)); return json({ ok: true }); }
    if (b.action === 'theme') return await saveTheme(request, b);
  } catch (e) {
    console.error('auth', b && b.action, e);
    return json({ error: 'upstream_error' }, 502);
  }
  return json({ error: 'invalid_request' }, 400);
}

// Premium only: dark mode and second color, saved on the account.
async function saveTheme(request, b) {
  const a = await authUser(request);
  if (a.error) return json({ error: a.error }, a.status);
  if (!isPremium(a.user)) return json({ error: 'not_premium' }, 403);
  const theme = { dark: b.dark === true, accent: ACCENTS[b.accent] ? b.accent : 'green' };
  await db('HSET', 'u:' + a.user.email, 'theme', JSON.stringify(theme));
  return json({ theme: readTheme({ theme: JSON.stringify(theme) }) });
}

async function signup(b) {
  if (String(process.env.SIGNUPS_OPEN || 'true').toLowerCase() === 'false') return json({ error: 'signups_closed' }, 403);
  const name = cleanName(b.name), email = cleanEmail(b.email), pw = String(b.password || '');
  if (!name) return json({ error: 'bad_name' }, 400);
  if (!email) return json({ error: 'bad_email' }, 400);
  if (pw.length < 8 || pw.length > 200) return json({ error: 'bad_password' }, 400);

  const existing = await getUser(email);
  if (existing) return json({ error: existing.status === 'pending' ? 'pending' : 'exists' }, 409);

  const dayCount = 'signups:' + dayKey();
  const [n] = await pipe([['INCR', dayCount], ['EXPIRE', dayCount, 172800]]);
  if (Number(n) > MAX_SIGNUPS_DAY) return json({ error: 'signups_closed' }, 429);

  const claimed = await db('HSETNX', 'u:' + email, 'email', email);
  if (Number(claimed) !== 1) return json({ error: 'exists' }, 409);
  await pipe([
    ['HSET', 'u:' + email, 'name', name, 'pw', await hashPw(pw), 'status', 'pending', 'created', Date.now()],
    ['SADD', 'users', email]
  ]);
  return json({ ok: true, status: 'pending' });
}

async function login(b) {
  const email = cleanEmail(b.email), pw = String(b.password || '');
  if (!email || !pw) return json({ error: 'bad_login' }, 401);
  const failKey = 'fail:' + email;
  if ((Number(await db('GET', failKey)) || 0) >= MAX_FAILS) return json({ error: 'too_many_attempts' }, 429);

  const u = await getUser(email);
  const ok = await checkPw(pw, u && u.pw);
  if (!u || !ok) {
    await pipe([['INCR', failKey], ['EXPIRE', failKey, 900]]);
    return json({ error: 'bad_login' }, 401);
  }
  if (u.status === 'pending') return json({ error: 'pending' }, 403);
  if (u.status === 'refused') return json({ error: 'refused' }, 403);
  if (u.status === 'disabled') return json({ error: 'disabled' }, 403);
  if (u.status !== 'active') return json({ error: 'bad_login' }, 401);

  await db('DEL', failKey);
  const token = await newSession(email);
  return json({ token, user: publicUser(u) });
}
