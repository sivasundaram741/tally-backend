import { Router } from 'express';
import { wrap, badRequest } from '../lib/http.js';
import {
  MASTERS, masterCatalogue, listMasters, getMaster, createMaster,
  updateMaster, deleteMaster, masterHistory, masterCounts, findByName,
} from '../services/masters.js';

const router = Router({ mergeParams: true });

function companyId(req) {
  const id = Number(req.params.companyId || req.query.companyId || req.get('x-company-id'));
  if (!id) throw badRequest('A company must be selected');
  return id;
}

router.get('/catalogue', wrap(async (req, res) => {
  res.json(masterCatalogue());
}));

router.get('/counts', wrap(async (req, res) => {
  res.json(await masterCounts(companyId(req)));
}));

/** Everything needed to populate the pick-lists on an entry screen. */
router.get('/lookups', wrap(async (req, res) => {
  const id = companyId(req);
  const pick = (key) => listMasters(key, id, { includeInactive: false });
  const keys = [
    ['groups', 'group'], ['ledgers', 'ledger'], ['stockItems', 'stock-item'],
    ['stockGroups', 'stock-group'], ['stockCategories', 'stock-category'],
    ['units', 'unit'], ['godowns', 'godown'], ['costCentres', 'cost-centre'],
    ['costCategories', 'cost-category'], ['currencies', 'currency'],
    ['voucherTypes', 'voucher-type'], ['gstRegistrations', 'gst-registration'],
    ['gstClassifications', 'gst-classification'],
  ];
  const lists = await Promise.all(keys.map(([, key]) => pick(key)));
  res.json(Object.fromEntries(keys.map(([name], i) => [name, lists[i]])));
}));

router.get('/:type', wrap(async (req, res) => {
  const { type } = req.params;
  if (!MASTERS[type]) throw badRequest(`Unknown master type "${type}"`);
  res.json(await listMasters(type, companyId(req), {
    search: req.query.search || '',
    includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
  }));
}));

router.get('/:type/by-name/:name', wrap(async (req, res) => {
  const row = await findByName(req.params.type, companyId(req), req.params.name);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
}));

router.get('/:type/:id', wrap(async (req, res) => {
  res.json(await getMaster(req.params.type, companyId(req), Number(req.params.id)));
}));

router.get('/:type/:id/history', wrap(async (req, res) => {
  res.json(await masterHistory(req.params.type, companyId(req), Number(req.params.id)));
}));

router.post('/:type', wrap(async (req, res) => {
  res.status(201).json(await createMaster(req.params.type, companyId(req), req.body, req.actor));
}));

router.put('/:type/:id', wrap(async (req, res) => {
  res.json(await updateMaster(req.params.type, companyId(req), Number(req.params.id), req.body, req.actor));
}));

router.delete('/:type/:id', wrap(async (req, res) => {
  res.json(await deleteMaster(req.params.type, companyId(req), Number(req.params.id), req.actor));
}));

export default router;
