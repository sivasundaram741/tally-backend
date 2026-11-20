import { Router } from 'express';
import { wrap } from '../lib/http.js';
import { login, logout, createUser, listUsers, publicUser } from '../lib/auth.js';
import { findOne } from '../db/index.js';

const router = Router();

router.post('/login', wrap(async (req, res) => {
  res.json(await login(req.body.username, req.body.password));
}));

router.post('/logout', wrap(async (req, res) => {
  await logout(req.get('x-auth-token'));
  res.json({ ok: true });
}));

router.get('/me', wrap(async (req, res) => {
  const u = req.actor?.id ? await findOne('users', { id: req.actor.id }) : null;
  res.json({ user: publicUser(u), machine: req.actor?.machine, ip: req.actor?.ip });
}));

router.get('/users', wrap(async (req, res) => res.json(await listUsers())));

router.post('/users', wrap(async (req, res) => {
  res.status(201).json(await createUser(req.body));
}));

export default router;
