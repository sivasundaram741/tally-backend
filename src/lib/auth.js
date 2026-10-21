import crypto from 'node:crypto';
import { get, insert, run, all } from '../db/index.js';
import { hashPassword } from '../db/seed.js';
import { unauthorized, badRequest } from './http.js';

const DAY = 24 * 60 * 60 * 1000;

export async function login(username, password) {
  const user = await get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
  if (!user || user.password_hash !== hashPassword(password)) {
    throw unauthorized('Invalid user name or password');
  }
  const token = crypto.randomUUID().replace(/-/g, '');
  await insert('sessions', {
    token,
    user_id: user.id,
    expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
  });
  return { token, user: publicUser(user) };
}

export async function logout(token) {
  if (token) await run('DELETE FROM sessions WHERE token = ?', [token]);
}

export async function createUser({ username, password, full_name, security_level }) {
  if (!username || !password) throw badRequest('User name and password are required');
  if (await get('SELECT id FROM users WHERE username = ?', [username])) {
    throw badRequest('That user name already exists');
  }
  const id = await insert('users', {
    username,
    full_name: full_name || username,
    password_hash: hashPassword(password),
    security_level: security_level || 'Data Entry',
  });
  return publicUser(await get('SELECT * FROM users WHERE id = ?', [id]));
}

export async function listUsers() {
  return all('SELECT id, username, full_name, security_level, is_active, created_at FROM users ORDER BY id');
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    security_level: u.security_level,
  };
}

/**
 * Resolves the acting user for a request. The app is usable without signing in
 * (users are only enforced when security control is switched on), in
 * which case every action is attributed to the built-in administrator.
 */
export async function currentUser(req) {
  const token = req.get('x-auth-token') || '';
  let user = null;
  if (token) {
    const session = await get('SELECT * FROM sessions WHERE token = ?', [token]);
    if (session && new Date(session.expires_at) > new Date()) {
      user = await get('SELECT * FROM users WHERE id = ?', [session.user_id]);
    }
  }
  if (!user) user = await get("SELECT * FROM users WHERE username = 'admin'");
  return {
    id: user?.id ?? null,
    username: user?.username || 'admin',
    machine: req.get('x-client-machine') || 'WEB-CLIENT',
    ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().replace('::ffff:', ''),
  };
}

export function attachUser(req, _res, next) {
  currentUser(req)
    .then((actor) => { req.actor = actor; next(); })
    .catch(next);
}
