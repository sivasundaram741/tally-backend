import { Router } from 'express';
import { wrap } from '../lib/http.js';
import {
  listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
  defaultFinancialYear, financialYearEnd,
} from '../services/companies.js';
import { masterCounts } from '../services/masters.js';
import { voucherTypes } from '../services/vouchers.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const list = await listCompanies();
  res.json(list.map((c) => ({
    ...c,
    financial_year_to: financialYearEnd(c.financial_year_from),
  })));
}));

router.get('/defaults', wrap(async (req, res) => {
  const from = defaultFinancialYear();
  res.json({ financial_year_from: from, financial_year_to: financialYearEnd(from), books_begin_from: from });
}));

router.get('/:id', wrap(async (req, res) => {
  const c = await getCompany(Number(req.params.id));
  res.json({ ...c, financial_year_to: financialYearEnd(c.financial_year_from) });
}));

router.get('/:id/overview', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await getCompany(id);
  res.json({
    company: { ...c, financial_year_to: financialYearEnd(c.financial_year_from) },
    counts: await masterCounts(id),
    voucherTypes: await voucherTypes(id),
  });
}));

router.post('/', wrap(async (req, res) => {
  res.status(201).json(await createCompany(req.body, req.actor));
}));

router.put('/:id', wrap(async (req, res) => {
  res.json(await updateCompany(Number(req.params.id), req.body, req.actor));
}));

router.delete('/:id', wrap(async (req, res) => {
  res.json(await deleteCompany(Number(req.params.id), req.actor));
}));

export default router;
