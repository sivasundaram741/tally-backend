import {
  find, findOne, exists, insert, update, transaction, buildChildren, namesById, contains, distinct,
} from '../db/index.js';
import { logChange, historyFor } from '../lib/editlog.js';
import { badRequest, notFound, toNum, toBool, toStr, money } from '../lib/http.js';
import { financialYearEnd } from './companies.js';

/** Voucher types that move stock but need no balanced ledger entries. */
const INVENTORY_ONLY = new Set([
  'Stock Journal', 'Physical Stock', 'Delivery Note', 'Receipt Note',
  'Rejections In', 'Rejections Out', 'Material In', 'Material Out',
  'Sales Order', 'Purchase Order', 'Job Work In Order', 'Job Work Out Order',
]);

/** Voucher types that record no financial effect at all. */
const NON_ACCOUNTING = new Set(['Memorandum', 'Reversing Journal', 'Attendance']);

/** A query-string value as a plain string (never an object/operator). */
const str = (v) => (v == null || typeof v === 'object' ? '' : String(v));

export function voucherTypes(companyId) {
  return find('voucher_types', { company_id: companyId, is_inactive: 0 }, {
    sort: { sort_position: 1, name: 1 },
  });
}

async function typeById(companyId, id) {
  const vt = await findOne('voucher_types', { id, company_id: companyId });
  if (!vt) throw notFound('Voucher type not found');
  return vt;
}

function typeByName(companyId, name) {
  return findOne('voucher_types', { company_id: companyId, name: String(name) });
}

/** Next automatic voucher number for a type within the financial year. */
export async function nextVoucherNumber(companyId, voucherTypeId, date) {
  const vt = await typeById(companyId, voucherTypeId);
  if (vt.numbering_method === 'Manual' || vt.numbering_method === 'None') return '';
  const company = await findOne('companies', { id: companyId }, { project: { financial_year_from: 1 } });
  const from = company?.financial_year_from || `${new Date().getFullYear()}-04-01`;
  const to = financialYearEnd(from);
  const filter = { company_id: companyId, voucher_type_id: voucherTypeId, is_deleted: 0 };
  if (vt.restart_numbering !== 'Never') filter.date = { $gte: from, $lte: to };
  const rows = await find('vouchers', filter, { project: { voucher_number: 1 } });
  let max = vt.starting_number - 1;
  for (const row of rows) {
    const digits = String(row.voucher_number).replace(/\D/g, '');
    if (digits) max = Math.max(max, parseInt(digits, 10));
  }
  const next = Math.max(max + 1, vt.starting_number);
  return `${vt.prefix || ''}${next}${vt.suffix || ''}`;
}

/** Lines in their entry order, as SQL's `ORDER BY line_no, id` returned them. */
const byLine = (a, b) => (a.line_no - b.line_no) || (a.id - b.id);

/** Splits the stored document into the voucher header and its embedded lines. */
function splitVoucher(doc) {
  const { entries = [], inventory = [], bills = [], ...header } = doc;
  return { header, entries, inventory, bills };
}

/** Loads a voucher with all of its lines, resolved for display. */
export async function getVoucher(companyId, id, { includeDeleted = false } = {}) {
  const doc = await findOne('vouchers', { id, company_id: companyId });
  if (!doc || (doc.is_deleted && !includeDeleted)) throw notFound('Voucher not found');
  const { header, entries, inventory, bills } = splitVoucher(doc);
  const vt = await findOne('voucher_types', { id: header.voucher_type_id });
  if (!vt) throw notFound('Voucher not found');

  const ledgerIds = [header.party_ledger_id, ...entries.map((e) => e.ledger_id), ...bills.map((b) => b.ledger_id)];
  const [ledgers, costCentres, items, godowns, units] = await Promise.all([
    namesById('ledgers', ledgerIds),
    namesById('cost_centres', entries.map((e) => e.cost_centre_id)),
    namesById('stock_items', inventory.map((i) => i.stock_item_id)),
    namesById('godowns', inventory.map((i) => i.godown_id)),
    namesById('units', inventory.map((i) => i.unit_id), 'symbol'),
  ]);

  return {
    ...header,
    voucher_type_name: vt.name,
    parent_type: vt.parent_type,
    affects_stock: vt.affects_stock,
    party_name: ledgers.get(header.party_ledger_id) ?? null,
    entries: entries
      .filter((e) => ledgers.has(e.ledger_id))
      .sort(byLine)
      .map((e) => ({
        id: e.id,
        voucher_id: header.id,
        ...withoutId(e),
        ledger_name: ledgers.get(e.ledger_id),
        cost_centre_name: costCentres.get(e.cost_centre_id) ?? null,
      })),
    inventory: inventory
      .filter((i) => items.has(i.stock_item_id))
      .sort(byLine)
      .map((i) => ({
        id: i.id,
        voucher_id: header.id,
        ...withoutId(i),
        stock_item_name: items.get(i.stock_item_id),
        godown_name: godowns.get(i.godown_id) ?? null,
        unit_name: units.get(i.unit_id) ?? null,
      })),
    bills: bills
      .filter((b) => ledgers.has(b.ledger_id))
      .sort((a, b) => a.id - b.id)
      .map((b) => ({
        id: b.id,
        entry_id: b.entry_id,
        voucher_id: header.id,
        ...withoutId(b),
        ledger_name: ledgers.get(b.ledger_id),
      })),
  };
}

const withoutId = ({ id: _id, ...rest }) => rest;

/** The readable snapshot stored in the Edit Log. */
export function voucherSnapshot(v) {
  return {
    date: v.date,
    voucher_type: v.voucher_type_name,
    voucher_number: v.voucher_number,
    reference_no: v.reference_no,
    reference_date: v.reference_date,
    party_ledger_id: v.party_name || '',
    narration: v.narration,
    place_of_supply: v.place_of_supply,
    mode: v.mode,
    is_optional: v.is_optional ? 'Yes' : 'No',
    is_post_dated: v.is_post_dated ? 'Yes' : 'No',
    is_cancelled: v.is_cancelled ? 'Yes' : 'No',
    total_amount: money(v.total_amount),
    entries: (v.entries || []).map((e) => ({
      ledger: e.ledger_name,
      dr_cr: e.dr_cr,
      amount: money(e.amount),
      cost_centre: e.cost_centre_name || '',
      narration: e.narration || '',
    })),
    inventory: (v.inventory || []).map((i) => ({
      stock_item: i.stock_item_name,
      godown: i.godown_name || '',
      quantity: i.quantity,
      unit: i.unit_name || '',
      rate: money(i.rate),
      discount_pct: i.discount_pct,
      amount: money(i.amount),
      direction: i.direction,
    })),
    bills: (v.bills || []).map((b) => ({
      ledger: b.ledger_name,
      bill_name: b.bill_name,
      bill_type: b.bill_type,
      amount: money(b.amount),
      dr_cr: b.dr_cr,
      due_date: b.due_date || '',
    })),
  };
}

async function validate(companyId, vt, body, entries, inventory) {
  if (!body.date) throw badRequest('Voucher date is required');
  if (NON_ACCOUNTING.has(vt.parent_type)) return;

  if (!entries.length && !inventory.length) {
    throw badRequest('A voucher must have at least one ledger or inventory entry');
  }

  if (entries.length) {
    let dr = 0;
    let cr = 0;
    for (const e of entries) {
      if (!e.ledger_id) throw badRequest('Each ledger entry needs a ledger');
      if (!(await exists('ledgers', { id: e.ledger_id, company_id: companyId }))) {
        throw badRequest('Unknown ledger in entries');
      }
      if (e.dr_cr === 'Dr') dr += e.amount;
      else cr += e.amount;
    }
    const diff = money(dr - cr);
    if (!INVENTORY_ONLY.has(vt.parent_type) && Math.abs(diff) > 0.009) {
      throw badRequest(
        `Debit and Credit totals do not match. Difference: ${Math.abs(diff).toFixed(2)} ${diff > 0 ? 'Dr' : 'Cr'}`,
      );
    }
  }

  for (const i of inventory) {
    if (!i.stock_item_id) throw badRequest('Each inventory line needs a stock item');
    if (!(await exists('stock_items', { id: i.stock_item_id, company_id: companyId }))) {
      throw badRequest('Unknown stock item in inventory entries');
    }
  }
}

/**
 * Every id a voucher points at must exist in the same company - the guarantee
 * SQL Server's foreign keys used to give, for the references `validate` does
 * not already check.
 */
async function assertReferences(companyId, partyLedgerId, entries, inventory, bills) {
  const checks = [
    ['ledgers', [partyLedgerId, ...entries.map((e) => e.ledger_id), ...bills.map((b) => b.ledger_id)]],
    ['cost_centres', entries.map((e) => e.cost_centre_id)],
    ['stock_items', inventory.map((i) => i.stock_item_id)],
    ['godowns', inventory.map((i) => i.godown_id)],
    ['units', inventory.map((i) => i.unit_id)],
  ];
  for (const [table, values] of checks) {
    const ids = [...new Set(values.filter((v) => v != null))];
    if (!ids.length) continue;
    const found = await distinct(table, 'id', { id: { $in: ids }, company_id: companyId });
    if (found.length !== ids.length) {
      throw badRequest('That reference does not exist. Pick an existing record from the list.');
    }
  }
}

function parseEntries(body) {
  return (body.entries || [])
    .filter((e) => e && (e.ledger_id || e.ledger))
    .map((e, idx) => ({
      line_no: idx,
      ledger_id: toNum(e.ledger_id, null),
      dr_cr: toStr(e.dr_cr, 'Dr') === 'Cr' ? 'Cr' : 'Dr',
      amount: Math.abs(money(toNum(e.amount, 0))),
      cost_centre_id: e.cost_centre_id ? toNum(e.cost_centre_id, null) : null,
      narration: toStr(e.narration),
    }))
    .filter((e) => e.amount !== 0 || e.ledger_id);
}

function parseInventory(body) {
  return (body.inventory || [])
    .filter((i) => i && i.stock_item_id)
    .map((i, idx) => {
      const qty = toNum(i.quantity, 0);
      const rate = toNum(i.rate, 0);
      const disc = toNum(i.discount_pct, 0);
      const gross = qty * rate;
      const amount = i.amount !== undefined && i.amount !== '' && i.amount !== null
        ? money(toNum(i.amount, 0))
        : money(gross - (gross * disc) / 100);
      return {
        line_no: idx,
        stock_item_id: toNum(i.stock_item_id, null),
        godown_id: i.godown_id ? toNum(i.godown_id, null) : null,
        batch: toStr(i.batch),
        quantity: qty,
        unit_id: i.unit_id ? toNum(i.unit_id, null) : null,
        rate,
        discount_pct: disc,
        amount,
        direction: toStr(i.direction, 'In') === 'Out' ? 'Out' : 'In',
      };
    });
}

function parseBills(body) {
  return (body.bills || [])
    .filter((b) => b && b.ledger_id)
    .map((b) => ({
      ledger_id: toNum(b.ledger_id, null),
      bill_name: toStr(b.bill_name),
      bill_type: toStr(b.bill_type, 'New Ref'),
      amount: money(toNum(b.amount, 0)),
      dr_cr: toStr(b.dr_cr, 'Dr'),
      due_date: toStr(b.due_date),
    }));
}

/** The embedded lines as stored: defaults applied and fresh line ids. */
async function buildLines(entries, inventory, bills) {
  return {
    entries: await buildChildren('entries', entries),
    inventory: await buildChildren('inventory', inventory),
    bills: await buildChildren('bills', bills.map((b) => ({ ...b, entry_id: null }))),
  };
}

function computeTotal(entries, inventory) {
  if (entries.length) {
    const dr = entries.filter((e) => e.dr_cr === 'Dr').reduce((s, e) => s + e.amount, 0);
    const cr = entries.filter((e) => e.dr_cr === 'Cr').reduce((s, e) => s + e.amount, 0);
    return money(Math.max(dr, cr));
  }
  return money(inventory.reduce((s, i) => s + i.amount, 0));
}

export async function createVoucher(companyId, body, actor) {
  const vt = body.voucher_type_id
    ? await typeById(companyId, toNum(body.voucher_type_id))
    : await typeByName(companyId, toStr(body.voucher_type));
  if (!vt) throw badRequest('Voucher type is required');

  const entries = parseEntries(body);
  const inventory = parseInventory(body);
  const bills = parseBills(body);
  await validate(companyId, vt, body, entries, inventory);
  const partyLedgerId = body.party_ledger_id ? toNum(body.party_ledger_id, null) : null;
  await assertReferences(companyId, partyLedgerId, entries, inventory, bills);

  let number = toStr(body.voucher_number).trim();
  if (!number && vt.numbering_method !== 'Manual' && vt.numbering_method !== 'None') {
    number = await nextVoucherNumber(companyId, vt.id, body.date);
  }

  return transaction(async () => {
    const id = await insert('vouchers', {
      company_id: companyId,
      voucher_type_id: vt.id,
      voucher_number: number,
      date: toStr(body.date),
      reference_no: toStr(body.reference_no),
      reference_date: toStr(body.reference_date),
      party_ledger_id: partyLedgerId,
      narration: toStr(body.narration),
      place_of_supply: toStr(body.place_of_supply),
      mode: toStr(body.mode, 'Item Invoice'),
      is_invoice: toBool(body.is_invoice),
      is_optional: toBool(body.is_optional),
      is_post_dated: toBool(body.is_post_dated),
      total_amount: computeTotal(entries, inventory),
      version_no: 1,
      created_by: actor?.username || 'admin',
      created_at: nowStamp(),
      ...(await buildLines(entries, inventory, bills)),
    });
    const full = await getVoucher(companyId, id);
    await logChange({
      companyId,
      entityType: 'voucher',
      entityKind: 'Voucher',
      entityId: id,
      entityName: `${vt.name} ${number}`.trim(),
      entityLabel: `${vt.name} No. ${number || '-'}`,
      action: 'Created',
      before: null,
      after: voucherSnapshot(full),
      user: actor,
      meta: {
        date: full.date,
        voucherType: vt.name,
        voucherNumber: number,
        amount: full.total_amount,
      },
    });
    return full;
  });
}

export async function updateVoucher(companyId, id, body, actor) {
  const existing = await getVoucher(companyId, id);
  const vt = body.voucher_type_id
    ? await typeById(companyId, toNum(body.voucher_type_id))
    : await typeById(companyId, existing.voucher_type_id);

  const entries = body.entries ? parseEntries(body) : existing.entries.map(stripEntry);
  const inventory = body.inventory ? parseInventory(body) : existing.inventory.map(stripInv);
  const bills = body.bills ? parseBills(body) : existing.bills.map(stripBill);
  const merged = { ...existing, ...body };
  await validate(companyId, vt, merged, entries, inventory);
  const partyLedgerId = body.party_ledger_id !== undefined
    ? (body.party_ledger_id ? toNum(body.party_ledger_id, null) : null)
    : existing.party_ledger_id;
  await assertReferences(companyId, partyLedgerId, entries, inventory, bills);

  const before = voucherSnapshot(existing);

  return transaction(async () => {
    await update('vouchers', id, {
      voucher_type_id: vt.id,
      voucher_number: toStr(body.voucher_number ?? existing.voucher_number),
      date: toStr(body.date ?? existing.date),
      reference_no: toStr(body.reference_no ?? existing.reference_no),
      reference_date: toStr(body.reference_date ?? existing.reference_date),
      party_ledger_id: partyLedgerId,
      narration: toStr(body.narration ?? existing.narration),
      place_of_supply: toStr(body.place_of_supply ?? existing.place_of_supply),
      mode: toStr(body.mode ?? existing.mode),
      is_optional: toBool(body.is_optional ?? existing.is_optional),
      is_post_dated: toBool(body.is_post_dated ?? existing.is_post_dated),
      total_amount: computeTotal(entries, inventory),
      version_no: existing.version_no + 1,
      altered_by: actor?.username || 'admin',
      altered_at: nowStamp(),
      ...(await buildLines(entries, inventory, bills)),
    });
    const full = await getVoucher(companyId, id);
    await logChange({
      companyId,
      entityType: 'voucher',
      entityKind: 'Voucher',
      entityId: id,
      entityName: `${vt.name} ${full.voucher_number}`.trim(),
      entityLabel: `${vt.name} No. ${full.voucher_number || '-'}`,
      action: 'Altered',
      before,
      after: voucherSnapshot(full),
      user: actor,
      meta: {
        date: full.date,
        voucherType: vt.name,
        voucherNumber: full.voucher_number,
        amount: full.total_amount,
      },
    });
    return full;
  });
}

const stripEntry = (e) => ({
  line_no: e.line_no, ledger_id: e.ledger_id, dr_cr: e.dr_cr, amount: e.amount,
  cost_centre_id: e.cost_centre_id, narration: e.narration,
});
const stripInv = (i) => ({
  line_no: i.line_no, stock_item_id: i.stock_item_id, godown_id: i.godown_id, batch: i.batch,
  quantity: i.quantity, unit_id: i.unit_id, rate: i.rate, discount_pct: i.discount_pct,
  amount: i.amount, direction: i.direction,
});
const stripBill = (b) => ({
  ledger_id: b.ledger_id, bill_name: b.bill_name, bill_type: b.bill_type,
  amount: b.amount, dr_cr: b.dr_cr, due_date: b.due_date,
});

/**
 * Deleting never destroys a voucher: it is marked deleted and every version
 * stays available in the log.
 */
export async function deleteVoucher(companyId, id, actor) {
  const existing = await getVoucher(companyId, id);
  const before = voucherSnapshot(existing);
  return transaction(async () => {
    await update('vouchers', id, {
      is_deleted: 1,
      version_no: existing.version_no + 1,
      altered_by: actor?.username || 'admin',
      altered_at: nowStamp(),
    });
    await logChange({
      companyId,
      entityType: 'voucher',
      entityKind: 'Voucher',
      entityId: id,
      entityName: `${existing.voucher_type_name} ${existing.voucher_number}`.trim(),
      entityLabel: `${existing.voucher_type_name} No. ${existing.voucher_number || '-'}`,
      action: 'Deleted',
      before,
      after: before,
      user: actor,
      meta: {
        date: existing.date,
        voucherType: existing.voucher_type_name,
        voucherNumber: existing.voucher_number,
        amount: existing.total_amount,
      },
    });
    return { deleted: true, id };
  });
}

export async function cancelVoucher(companyId, id, actor) {
  const existing = await getVoucher(companyId, id);
  const before = voucherSnapshot(existing);
  const cancel = !existing.is_cancelled;
  return transaction(async () => {
    await update('vouchers', id, {
      is_cancelled: cancel ? 1 : 0,
      version_no: existing.version_no + 1,
      altered_by: actor?.username || 'admin',
      altered_at: nowStamp(),
    });
    const full = await getVoucher(companyId, id);
    await logChange({
      companyId,
      entityType: 'voucher',
      entityKind: 'Voucher',
      entityId: id,
      entityName: `${existing.voucher_type_name} ${existing.voucher_number}`.trim(),
      entityLabel: `${existing.voucher_type_name} No. ${existing.voucher_number || '-'}`,
      action: cancel ? 'Cancelled' : 'Restored',
      before,
      after: voucherSnapshot(full),
      user: actor,
      meta: {
        date: full.date,
        voucherType: existing.voucher_type_name,
        voucherNumber: full.voucher_number,
        amount: full.total_amount,
      },
    });
    return full;
  });
}

export async function restoreVoucher(companyId, id, actor) {
  const existing = await getVoucher(companyId, id, { includeDeleted: true });
  if (!existing.is_deleted) return existing;
  const before = voucherSnapshot(existing);
  return transaction(async () => {
    await update('vouchers', id, {
      is_deleted: 0,
      version_no: existing.version_no + 1,
      altered_by: actor?.username || 'admin',
      altered_at: nowStamp(),
    });
    const full = await getVoucher(companyId, id);
    await logChange({
      companyId,
      entityType: 'voucher',
      entityKind: 'Voucher',
      entityId: id,
      entityName: `${existing.voucher_type_name} ${existing.voucher_number}`.trim(),
      entityLabel: `${existing.voucher_type_name} No. ${existing.voucher_number || '-'}`,
      action: 'Restored',
      before,
      after: voucherSnapshot(full),
      user: actor,
      meta: {
        date: full.date,
        voucherType: existing.voucher_type_name,
        voucherNumber: full.voucher_number,
        amount: full.total_amount,
      },
    });
    return full;
  });
}

/** Day Book / voucher register. */
export async function listVouchers(companyId, opts = {}) {
  const filter = { company_id: companyId };
  if (!opts.includeDeleted) filter.is_deleted = 0;
  if (str(opts.from) || str(opts.to)) {
    filter.date = {};
    if (str(opts.from)) filter.date.$gte = str(opts.from);
    if (str(opts.to)) filter.date.$lte = str(opts.to);
  }

  // voucher type filters: by id, by name and by parent type all narrow the type ids
  const typeFilter = { company_id: companyId };
  if (str(opts.voucherType)) typeFilter.name = str(opts.voucherType);
  if (str(opts.parentType)) typeFilter.parent_type = str(opts.parentType);
  const types = await find('voucher_types', typeFilter, { project: { id: 1, name: 1, parent_type: 1 } });
  const typeById = new Map(types.map((t) => [t.id, t]));
  let typeIds = types.map((t) => t.id);
  if (str(opts.voucherTypeId)) typeIds = typeIds.filter((id) => id === toNum(opts.voucherTypeId));
  filter.voucher_type_id = { $in: typeIds };

  if (str(opts.ledgerId)) filter['entries.ledger_id'] = toNum(opts.ledgerId);
  if (str(opts.search)) {
    const s = contains(str(opts.search));
    const parties = await find('ledgers', { company_id: companyId, name: s }, { project: { id: 1 } });
    filter.$or = [
      { voucher_number: s },
      { narration: s },
      { party_ledger_id: { $in: parties.map((l) => l.id) } },
    ];
  }

  const docs = await find('vouchers', filter, {
    sort: { date: -1, id: -1 },
    limit: toNum(opts.limit, 500),
    project: { inventory: 0, bills: 0 },
  });
  if (!docs.length) return [];

  const ledgerIds = docs.flatMap((v) => [v.party_ledger_id, ...v.entries.map((e) => e.ledger_id)]);
  const ledgers = await namesById('ledgers', ledgerIds);

  return docs.map(({ entries, ...v }) => {
    const vt = typeById.get(v.voucher_type_id);
    return {
      ...v,
      voucher_type_name: vt.name,
      parent_type: vt.parent_type,
      party_name: ledgers.get(v.party_ledger_id) ?? null,
      entries: entries
        .filter((e) => ledgers.has(e.ledger_id))
        .sort(byLine)
        .map((e) => ({ id: e.id, voucher_id: v.id, ...withoutId(e), ledger_name: ledgers.get(e.ledger_id) })),
    };
  });
}

export function voucherHistory(companyId, id) {
  return historyFor(companyId, 'voucher', id);
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
