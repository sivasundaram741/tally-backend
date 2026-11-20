import { Router } from 'express';
import { wrap, badRequest } from '../lib/http.js';
import { exists } from '../db/index.js';
import { createCompany } from '../services/companies.js';
import { createMaster, findByName, updateMaster } from '../services/masters.js';
import { createVoucher, updateVoucher, deleteVoucher, cancelVoucher } from '../services/vouchers.js';

const router = Router();

/**
 * Builds a fully populated demo company so every report and the Edit Log have
 * something meaningful to show on a fresh install.
 */
router.post('/seed', wrap(async (req, res) => {
  const name = req.body?.name || 'Acme Traders Pvt Ltd';
  // the companies collection is case-insensitive, like the old NOCASE match
  if (await exists('companies', { name })) {
    throw badRequest(`Company "${name}" already exists`);
  }
  const actor = req.actor;
  const fyFrom = req.body?.financial_year_from || defaultFy();

  const company = await createCompany({
    name,
    mailing_name: name,
    address: '14, Industrial Estate, Guindy',
    state: 'Tamil Nadu',
    country: 'India',
    pincode: '600032',
    phone: '044-28150000',
    email: 'accounts@acmetraders.example',
    financial_year_from: fyFrom,
    books_begin_from: fyFrom,
    gstin: '33AACCA1234F1Z5',
    pan: 'AACCA1234F',
    gst_registration_type: 'Regular',
    maintain: 'Accounts with Inventory',
  }, actor);

  const cid = company.id;
  const M = (type, body) => createMaster(type, cid, body, actor);
  const groupId = async (n) => (await findByName('group', cid, n))?.id;

  // ---- units & inventory masters -----------------------------------------
  const nos = await M('unit', { symbol: 'Nos', formal_name: 'Numbers', decimal_places: 0 });
  const kg = await M('unit', { symbol: 'Kg', formal_name: 'Kilograms', decimal_places: 3 });
  const electronics = await M('stock-group', { name: 'Electronics', quantities_added: 1 });
  const hardware = await M('stock-group', { name: 'Hardware', quantities_added: 1 });
  const mainGodown = await findByName('godown', cid, 'Main Location');
  const warehouse = await M('godown', { name: 'Warehouse - Chennai', address: 'Ambattur' });

  const laptop = await M('stock-item', {
    name: 'Laptop 14" i5', stock_group_id: electronics.id, unit_id: nos.id,
    opening_qty: 10, opening_rate: 42000, opening_value: 420000,
    hsn_sac: '84713010', tax_rate: 18, standard_price: 52000,
  });
  const monitor = await M('stock-item', {
    name: 'LED Monitor 24"', stock_group_id: electronics.id, unit_id: nos.id,
    opening_qty: 25, opening_rate: 8500, opening_value: 212500,
    hsn_sac: '85285900', tax_rate: 18, standard_price: 11500,
  });
  const cable = await M('stock-item', {
    name: 'HDMI Cable 2m', stock_group_id: hardware.id, unit_id: nos.id,
    opening_qty: 150, opening_rate: 180, opening_value: 27000,
    hsn_sac: '85444299', tax_rate: 18, standard_price: 320,
  });

  // ---- ledgers ------------------------------------------------------------
  const L = async (n, g, extra = {}) => M('ledger', { name: n, group_id: await groupId(g), ...extra });

  const sbi = await L('SBI Current A/c', 'Bank Accounts', {
    opening_balance: 850000, opening_balance_type: 'Dr',
    bank_name: 'State Bank of India', bank_account_no: '31245678901', bank_ifsc: 'SBIN0001234',
  });
  // Opening capital equals opening bank + opening stock so the books balance.
  const capital = await L('Share Capital', 'Capital Account', {
    opening_balance: 1509500, opening_balance_type: 'Cr',
  });
  const sales = await L('Sales - Local', 'Sales Accounts', { gst_applicable: 'Applicable' });
  const salesInter = await L('Sales - Interstate', 'Sales Accounts', { gst_applicable: 'Applicable' });
  const purchase = await L('Purchase - Local', 'Purchase Accounts', { gst_applicable: 'Applicable' });
  const cgst = await L('CGST', 'Duties & Taxes', { tax_type: 'CGST', tax_rate: 9 });
  const sgst = await L('SGST', 'Duties & Taxes', { tax_type: 'SGST', tax_rate: 9 });
  const igst = await L('IGST', 'Duties & Taxes', { tax_type: 'IGST', tax_rate: 18 });
  const rent = await L('Rent', 'Indirect Expenses');
  const salary = await L('Salaries', 'Indirect Expenses');
  const power = await L('Electricity Charges', 'Indirect Expenses');
  const commission = await L('Commission Received', 'Indirect Incomes');

  const infotech = await L('Bright InfoTech', 'Sundry Debtors', {
    is_bill_wise: 1, state: 'Tamil Nadu', gstin: '33AAFCB5678K1Z2',
    registration_type: 'Regular', credit_period_days: 30, credit_limit: 500000,
  });
  const nova = await L('Nova Systems', 'Sundry Debtors', {
    is_bill_wise: 1, state: 'Karnataka', gstin: '29AABCN9012L1Z8',
    registration_type: 'Regular', credit_period_days: 45,
  });
  const supplier = await L('Vertex Distributors', 'Sundry Creditors', {
    is_bill_wise: 1, state: 'Tamil Nadu', gstin: '33AADCV3456M1Z1',
    registration_type: 'Regular', credit_period_days: 30,
  });

  // ---- vouchers -----------------------------------------------------------
  const d = (offset) => shiftDate(fyFrom, offset);
  const V = (body) => createVoucher(cid, body, actor);

  await V({
    voucher_type: 'Purchase', date: d(5), reference_no: 'VD/4411',
    party_ledger_id: supplier.id, place_of_supply: 'Tamil Nadu',
    narration: 'Stock purchased against invoice VD/4411.',
    inventory: [
      { stock_item_id: laptop.id, godown_id: mainGodown.id, quantity: 10, rate: 41000, unit_id: nos.id, direction: 'In' },
      { stock_item_id: monitor.id, godown_id: mainGodown.id, quantity: 20, rate: 8200, unit_id: nos.id, direction: 'In' },
    ],
    entries: [
      { ledger_id: purchase.id, dr_cr: 'Dr', amount: 574000 },
      { ledger_id: cgst.id, dr_cr: 'Dr', amount: 51660 },
      { ledger_id: sgst.id, dr_cr: 'Dr', amount: 51660 },
      { ledger_id: supplier.id, dr_cr: 'Cr', amount: 677320 },
    ],
    bills: [{ ledger_id: supplier.id, bill_name: 'VD/4411', bill_type: 'New Ref', amount: 677320, dr_cr: 'Cr', due_date: d(35) }],
  });

  const inv1 = await V({
    voucher_type: 'Sales', date: d(9),
    party_ledger_id: infotech.id, place_of_supply: 'Tamil Nadu',
    narration: 'Sale of laptops and monitors.',
    inventory: [
      { stock_item_id: laptop.id, godown_id: mainGodown.id, quantity: 4, rate: 52000, unit_id: nos.id, direction: 'Out' },
      { stock_item_id: monitor.id, godown_id: mainGodown.id, quantity: 6, rate: 11500, unit_id: nos.id, direction: 'Out' },
    ],
    entries: [
      { ledger_id: infotech.id, dr_cr: 'Dr', amount: 326860 },
      { ledger_id: sales.id, dr_cr: 'Cr', amount: 277000 },
      { ledger_id: cgst.id, dr_cr: 'Cr', amount: 24930 },
      { ledger_id: sgst.id, dr_cr: 'Cr', amount: 24930 },
    ],
    bills: [{ ledger_id: infotech.id, bill_name: 'S/1', bill_type: 'New Ref', amount: 326860, dr_cr: 'Dr', due_date: d(39) }],
  });

  const inv2 = await V({
    voucher_type: 'Sales', date: d(14),
    party_ledger_id: nova.id, place_of_supply: 'Karnataka',
    narration: 'Interstate sale - monitors and cables.',
    inventory: [
      { stock_item_id: monitor.id, godown_id: warehouse.id, quantity: 8, rate: 11200, unit_id: nos.id, direction: 'Out' },
      { stock_item_id: cable.id, godown_id: warehouse.id, quantity: 50, rate: 300, unit_id: nos.id, direction: 'Out' },
    ],
    entries: [
      { ledger_id: nova.id, dr_cr: 'Dr', amount: 123428 },
      { ledger_id: salesInter.id, dr_cr: 'Cr', amount: 104600 },
      { ledger_id: igst.id, dr_cr: 'Cr', amount: 18828 },
    ],
    bills: [{ ledger_id: nova.id, bill_name: 'S/2', bill_type: 'New Ref', amount: 123428, dr_cr: 'Dr', due_date: d(59) }],
  });

  await V({
    voucher_type: 'Receipt', date: d(20),
    narration: 'Part payment received from Bright InfoTech by NEFT.',
    entries: [
      { ledger_id: sbi.id, dr_cr: 'Dr', amount: 200000 },
      { ledger_id: infotech.id, dr_cr: 'Cr', amount: 200000 },
    ],
    bills: [{ ledger_id: infotech.id, bill_name: 'S/1', bill_type: 'Agst Ref', amount: 200000, dr_cr: 'Cr' }],
  });

  await V({
    voucher_type: 'Payment', date: d(22),
    narration: 'Payment to Vertex Distributors.',
    entries: [
      { ledger_id: supplier.id, dr_cr: 'Dr', amount: 400000 },
      { ledger_id: sbi.id, dr_cr: 'Cr', amount: 400000 },
    ],
    bills: [{ ledger_id: supplier.id, bill_name: 'VD/4411', bill_type: 'Agst Ref', amount: 400000, dr_cr: 'Dr' }],
  });

  await V({
    voucher_type: 'Payment', date: d(25), narration: 'Office rent for the month.',
    entries: [
      { ledger_id: rent.id, dr_cr: 'Dr', amount: 45000 },
      { ledger_id: sbi.id, dr_cr: 'Cr', amount: 45000 },
    ],
  });

  await V({
    voucher_type: 'Payment', date: d(28), narration: 'Staff salaries.',
    entries: [
      { ledger_id: salary.id, dr_cr: 'Dr', amount: 185000 },
      { ledger_id: sbi.id, dr_cr: 'Cr', amount: 185000 },
    ],
  });

  const powerVch = await V({
    voucher_type: 'Journal', date: d(29), narration: 'Electricity charges provision.',
    entries: [
      { ledger_id: power.id, dr_cr: 'Dr', amount: 12000 },
      { ledger_id: commission.id, dr_cr: 'Cr', amount: 12000 },
    ],
  });

  const contra = await V({
    voucher_type: 'Contra', date: d(30), narration: 'Cash withdrawn from bank for office use.',
    entries: [
      { ledger_id: (await findByName('ledger', cid, 'Cash')).id, dr_cr: 'Dr', amount: 50000 },
      { ledger_id: sbi.id, dr_cr: 'Cr', amount: 50000 },
    ],
  });

  // ---- create some Edit Log history --------------------------------------
  await updateVoucher(cid, inv1.id, {
    narration: 'Sale of laptops and monitors. Rate revised as per approved quotation.',
    entries: [
      { ledger_id: infotech.id, dr_cr: 'Dr', amount: 329220 },
      { ledger_id: sales.id, dr_cr: 'Cr', amount: 279000 },
      { ledger_id: cgst.id, dr_cr: 'Cr', amount: 25110 },
      { ledger_id: sgst.id, dr_cr: 'Cr', amount: 25110 },
    ],
    inventory: [
      { stock_item_id: laptop.id, godown_id: mainGodown.id, quantity: 4, rate: 52500, unit_id: nos.id, direction: 'Out' },
      { stock_item_id: monitor.id, godown_id: mainGodown.id, quantity: 6, rate: 11500, unit_id: nos.id, direction: 'Out' },
    ],
    bills: [{ ledger_id: infotech.id, bill_name: 'S/1', bill_type: 'New Ref', amount: 329220, dr_cr: 'Dr', due_date: d(39) }],
  }, actor);

  await updateVoucher(cid, inv2.id, {
    reference_no: 'PO-NOVA-118',
    narration: 'Interstate sale - monitors and cables. Customer PO reference added.',
  }, actor);

  await cancelVoucher(cid, contra.id, actor);
  await deleteVoucher(cid, powerVch.id, actor);

  await updateMaster('ledger', cid, infotech.id, {
    credit_limit: 750000,
    credit_period_days: 45,
    contact_person: 'R. Krishnan',
    phone: '98400 11223',
  }, actor);

  await updateMaster('stock-item', cid, cable.id, { standard_price: 349, reorder_level: 50 }, actor);

  res.status(201).json({
    company,
    message: 'Demo company created with masters, vouchers and edit-log history.',
  });
}));

function defaultFy(today = new Date()) {
  const y = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;
  return `${y}-04-01`;
}

function shiftDate(from, days) {
  const d = new Date(`${from}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default router;
