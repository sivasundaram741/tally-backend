import { Router } from 'express';
import { wrap, badRequest } from '../lib/http.js';
import {
  backupCompany, restoreCompany, exportDataset, importRows, repairData,
  toCsv, EXPORT_KINDS, IMPORT_KINDS,
} from '../services/datafile.js';

const router = Router();

function companyId(req) {
  const id = Number(req.query.companyId || req.body?.companyId || req.get('x-company-id'));
  if (!id) throw badRequest('A company must be selected');
  return id;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = () => new Date().toISOString().slice(0, 10);

/** What the Data, Import and Export screens offer. */
router.get('/catalogue', wrap((req, res) => {
  res.json({
    exports: Object.entries(EXPORT_KINDS).map(([key, label]) => ({ key, label })),
    imports: Object.entries(IMPORT_KINDS).map(([key, v]) => ({ key, label: v.label })),
  });
}));

/** Full company backup, including the edit log. */
router.get('/backup', wrap(async (req, res) => {
  const id = companyId(req);
  const dump = await backupCompany(id);
  if (req.query.download === '1') {
    const name = `${slug(dump.company.name)}-${today()}.ledgertrail.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'application/json');
  }
  res.json(dump);
}));

router.post('/restore', wrap(async (req, res) => {
  const dump = req.body?.dump || req.body;
  res.status(201).json(await restoreCompany(dump, { name: req.body?.name }));
}));

/** Tabular export of one data set, as CSV or JSON. */
router.get('/export/:kind', wrap(async (req, res) => {
  const id = companyId(req);
  const { kind } = req.params;
  const out = await exportDataset(kind, id, { from: req.query.from, to: req.query.to });

  if ((req.query.format || 'csv') === 'json') {
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-${today()}.json"`);
    }
    return res.json(out.json);
  }

  const csv = toCsv(out.headers, out.rows);
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-${today()}.csv"`);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.send(`﻿${csv}`);
}));

/** Preview without writing anything, so the screen can show what will happen. */
router.get('/export/:kind/preview', wrap(async (req, res) => {
  const out = await exportDataset(req.params.kind, companyId(req), {
    from: req.query.from, to: req.query.to,
  });
  res.json({ headers: out.headers, rows: out.rows.slice(0, 50), total: out.rows.length });
}));

router.post('/import/:kind', wrap(async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
  res.json(await importRows(req.params.kind, companyId(req), rows, req.actor));
}));

router.post('/repair', wrap(async (req, res) => {
  res.json(await repairData());
}));

export default router;
