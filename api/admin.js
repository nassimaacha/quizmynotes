// QuizMyNotes: admin actions (approve accounts, extend trials, reset passwords, pilot stats).
// Open to the admin account (ADMIN_EMAIL, logged in) or to ADMIN_PASSWORD.
// The page itself is quizmynotes-admin.html, served at /admin.
import {
  db, pipe, hasDb, json, same, obj, getUser, cleanEmail, hashPw, tempPassword,
  endAllSessions, forgetUsage, lastDays, weekOf, DAY_MS, TRIAL_DAYS, DAILY_USER_USD, DAILY_TOTAL_USD,
  authUser, bearer, ADMIN_EMAIL
} from '../lib/store.js';

// Who may use the admin page: the admin account's session, or the admin password.
async function isAdmin(request) {
  if (bearer(request)) {
    const a = await authUser(request);
    if (!a.error && a.user.email === ADMIN_EMAIL) return true;
  }
  const pw = request.headers.get('x-admin-password');
  if (pw && process.env.ADMIN_PASSWORD) {
    if (same(pw, process.env.ADMIN_PASSWORD)) return true;
    await pipe([['INCR', 'afail'], ['EXPIRE', 'afail', 900]]);
  }
  return false;
}

export async function POST(request) {
  if (!hasDb()) return json({ error: 'not_configured' }, 500);
  try {
    const fails = Number(await db('GET', 'afail')) || 0;
    if (fails >= 20) return json({ error: 'too_many_attempts' }, 429);
    if (!(await isAdmin(request))) return json({ error: 'unauthorized' }, 401);
    let b;
    try { b = await request.json(); } catch { return json({ error: 'invalid_request' }, 400); }
    if (b.action === 'list') return json(await list());

    const email = cleanEmail(b.email);
    const u = await getUser(email);
    if (!u) return json({ error: 'not_found' }, 404);
    const key = 'u:' + email, now = Date.now();

    switch (b.action) {
      case 'approve':
        await db('HSET', key, 'status', 'active', 'approved', now, 'trialEnd', now + TRIAL_DAYS * DAY_MS);
        break;
      case 'refuse':
        await db('HSET', key, 'status', 'refused');
        await endAllSessions(email);
        break;
      case 'extend': {
        const days = Math.max(1, Math.min(365, Math.floor(Number(b.days) || 30)));
        await db('HSET', key, 'trialEnd', Math.max(Number(u.trialEnd) || 0, now) + days * DAY_MS);
        break;
      }
      case 'disable':
        await db('HSET', key, 'status', 'disabled');
        await endAllSessions(email);
        break;
      case 'enable':
        await db('HSET', key, 'status', 'active');
        break;
      case 'reset': {
        const password = tempPassword();
        await db('HSET', key, 'pw', await hashPw(password));
        await endAllSessions(email);
        await db('DEL', 'fail:' + email);
        return json({ ok: true, password });
      }
      case 'delete':
        await endAllSessions(email);
        await pipe([['DEL', key], ['SREM', 'users', email], ['DEL', 'fail:' + email]]);
        await forgetUsage(email);
        break;
      default:
        return json({ error: 'invalid_request' }, 400);
    }
    return json({ ok: true });
  } catch (e) {
    console.error('admin', e);
    return json({ error: 'upstream_error' }, 502);
  }
}

async function list() {
  const emails = (await db('SMEMBERS', 'users')) || [];
  const users = (await pipe(emails.map(e => ['HGETALL', 'u:' + e]))).map(obj).filter(u => u.email);
  const days = lastDays(56);
  const data = (await pipe(days.map(d => ['HGETALL', 'day:' + d]))).map(obj);

  const per = {};
  const weeks = new Map();
  days.forEach((d, i) => {
    const row = data[i];
    const wk = weekOf(d);
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, users: new Set(), tests: 0, usd: 0 });
    const W = weeks.get(wk);
    W.usd += Number(row['_all|usd']) || 0;
    for (const [field, val] of Object.entries(row)) {
      const cut = field.lastIndexOf('|');
      const email = field.slice(0, cut), kind = field.slice(cut + 1);
      if (email === '_all') continue;
      const p = per[email] || (per[email] = { tests7: 0, tests28: 0, usd30: 0, weeks: new Set() });
      const v = Number(val) || 0;
      if (kind === 'tests' && v > 0) {
        W.tests += v; W.users.add(email);
        if (i < 7) p.tests7 += v;
        if (i < 28) { p.tests28 += v; p.weeks.add(wk); }
      }
      if (kind === 'usd' && i < 30) p.usd30 += v;
    }
  });

  return {
    trialDays: TRIAL_DAYS,
    caps: { user: DAILY_USER_USD, total: DAILY_TOTAL_USD },
    todayUsd: Number(data[0]['_all|usd']) || 0,
    weeks: [...weeks.values()].slice(0, 8).map(w => ({ week: w.week, active: w.users.size, tests: w.tests, usd: Math.round(w.usd * 10000) / 10000 })),
    users: users.map(u => {
      const p = per[u.email] || { tests7: 0, tests28: 0, usd30: 0, weeks: new Set() };
      return {
        name: u.name, email: u.email, status: u.status,
        created: Number(u.created) || 0, approved: Number(u.approved) || 0,
        trialEnd: Number(u.trialEnd) || 0, lastSeen: Number(u.lastSeen) || 0,
        tests7: p.tests7, tests28: p.tests28, usd30: Math.round(p.usd30 * 10000) / 10000, weeks4: p.weeks.size
      };
    }).sort((a, b) => (b.lastSeen || b.created) - (a.lastSeen || a.created))
  };
}
