import { Router } from 'express';
import { wrap, badRequest } from '../lib/http.js';
import {
  trialBalance, balanceSheet, profitAndLoss, ledgerStatement, stockSummary,
  outstandings, groupSummary, ratioAnalysis, cashBankBooks, dashboard, period,
} from '../services/reports.js';

const router = Router();

function companyId(req) {
  const id = Number(req.query.companyId || req.get('x-company-id'));
  if (!id) throw badRequest('A company must be selected');
  return id;
}

const q = (req) => ({ from: req.query.from, to: req.query.to });

router.get('/period', wrap(async (req, res) => res.json(await period(companyId(req), q(req)))));
router.get('/dashboard', wrap(async (req, res) => res.json(await dashboard(companyId(req), q(req)))));
router.get('/trial-balance', wrap(async (req, res) => res.json(await trialBalance(companyId(req), q(req)))));
router.get('/balance-sheet', wrap(async (req, res) => res.json(await balanceSheet(companyId(req), q(req)))));
router.get('/profit-loss', wrap(async (req, res) => res.json(await profitAndLoss(companyId(req), q(req)))));
router.get('/stock-summary', wrap(async (req, res) => res.json(await stockSummary(companyId(req), q(req)))));
router.get('/ratio-analysis', wrap(async (req, res) => res.json(await ratioAnalysis(companyId(req), q(req)))));
router.get('/cash-bank', wrap(async (req, res) => res.json(await cashBankBooks(companyId(req), q(req)))));

router.get('/outstandings/:kind', wrap(async (req, res) => {
  res.json(await outstandings(companyId(req), req.params.kind, q(req)));
}));

router.get('/ledger/:id', wrap(async (req, res) => {
  const out = await ledgerStatement(companyId(req), Number(req.params.id), q(req));
  if (!out) return res.status(404).json({ error: 'Ledger not found' });
  res.json(out);
}));

router.get('/group/:id', wrap(async (req, res) => {
  const out = await groupSummary(companyId(req), Number(req.params.id), q(req));
  if (!out) return res.status(404).json({ error: 'Group not found' });
  res.json(out);
}));

export default router;
