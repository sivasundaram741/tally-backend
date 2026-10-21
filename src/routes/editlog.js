import { Router } from 'express';
import { wrap, badRequest } from '../lib/http.js';
import { listLog, summary, entities, entityHistory, compare, logUsers } from '../services/editlog.js';

const router = Router();

function companyId(req) {
  const id = Number(req.query.companyId || req.get('x-company-id'));
  if (!id) throw badRequest('A company must be selected');
  return id;
}

router.get('/', wrap(async (req, res) => res.json(await listLog(companyId(req), req.query))));
router.get('/summary', wrap(async (req, res) => res.json(await summary(companyId(req), req.query))));
router.get('/entities', wrap(async (req, res) => res.json(await entities(companyId(req), req.query))));
router.get('/users', wrap(async (req, res) => res.json(await logUsers(companyId(req)))));

router.get('/:entityType/:entityId', wrap(async (req, res) => {
  res.json(await entityHistory(companyId(req), req.params.entityType, Number(req.params.entityId)));
}));

router.get('/:entityType/:entityId/compare', wrap(async (req, res) => {
  const out = await compare(
    companyId(req),
    req.params.entityType,
    Number(req.params.entityId),
    req.query.a,
    req.query.b,
  );
  if (!out) return res.status(404).json({ error: 'Versions not found' });
  res.json(out);
}));

export default router;
