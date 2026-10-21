import { Router } from 'express';
import { wrap, badRequest } from '../lib/http.js';
import {
  listVouchers, getVoucher, createVoucher, updateVoucher, deleteVoucher,
  cancelVoucher, restoreVoucher, voucherHistory, voucherTypes, nextVoucherNumber,
} from '../services/vouchers.js';

const router = Router();

function companyId(req) {
  const id = Number(req.query.companyId || req.body?.companyId || req.get('x-company-id'));
  if (!id) throw badRequest('A company must be selected');
  return id;
}

router.get('/types', wrap(async (req, res) => {
  res.json(await voucherTypes(companyId(req)));
}));

router.get('/next-number', wrap(async (req, res) => {
  const id = companyId(req);
  res.json({
    voucher_number: await nextVoucherNumber(id, Number(req.query.voucherTypeId), req.query.date),
  });
}));

router.get('/', wrap(async (req, res) => {
  res.json(await listVouchers(companyId(req), {
    from: req.query.from,
    to: req.query.to,
    voucherTypeId: req.query.voucherTypeId,
    voucherType: req.query.voucherType,
    parentType: req.query.parentType,
    ledgerId: req.query.ledgerId,
    search: req.query.search,
    limit: req.query.limit,
    includeDeleted: req.query.includeDeleted === '1' || req.query.includeDeleted === 'true',
  }));
}));

router.get('/:id', wrap(async (req, res) => {
  res.json(await getVoucher(companyId(req), Number(req.params.id), {
    includeDeleted: req.query.includeDeleted === '1',
  }));
}));

router.get('/:id/history', wrap(async (req, res) => {
  res.json(await voucherHistory(companyId(req), Number(req.params.id)));
}));

router.post('/', wrap(async (req, res) => {
  res.status(201).json(await createVoucher(companyId(req), req.body, req.actor));
}));

router.put('/:id', wrap(async (req, res) => {
  res.json(await updateVoucher(companyId(req), Number(req.params.id), req.body, req.actor));
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  res.json(await cancelVoucher(companyId(req), Number(req.params.id), req.actor));
}));

router.post('/:id/restore', wrap(async (req, res) => {
  res.json(await restoreVoucher(companyId(req), Number(req.params.id), req.actor));
}));

router.delete('/:id', wrap(async (req, res) => {
  res.json(await deleteVoucher(companyId(req), Number(req.params.id), req.actor));
}));

export default router;
