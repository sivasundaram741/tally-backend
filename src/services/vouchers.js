import { all, get, insert, update, run, transaction } from '../db/index.js';
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

export function voucherTypes(companyId) {
  return all(
    `SELECT * FROM voucher_types WHERE company_id = ? AND is_inactive = 0
      ORDER BY sort_position, name`,
    [companyId],
  );
}

async function typeById(companyId, id) {
  const vt = await get('SELECT * FROM voucher_types WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!vt) throw notFound('Voucher type not found');
  return vt;
}

function typeByName(companyId, name) {
  return get('SELECT * FROM voucher_types WHERE company_id = ? AND name = ?', [companyId, name]);
}

/** Next automatic voucher number for a type within the financial year. */
export async function nextVoucherNumber(companyId, voucherTypeId, date) {
  const vt = await typeById(companyId, voucherTypeId);
  if (vt.numbering_method === 'Manual' || vt.numbering_method === 'None') return '';
  const company = await get('SELECT financial_year_from FROM companies WHERE id = ?', [companyId]);
  const from = company?.financial_year_from || `${new Date().getFullYear()}-04-01`;
  const to = financialYearEnd(from);
  const scoped = vt.restart_numbering === 'Never' ? [] : [from, to];
  const rows = await all(
    `SELECT voucher_number FROM vouchers
      WHERE company_id = ? AND voucher_type_id = ? AND is_deleted = 0
      ${scoped.length ? 'AND date BETWEEN ? AND ?' : ''}`,
    [companyId, voucherTypeId, ...scoped],
  );
  let max = vt.starting_number - 1;
  for (const row of rows) {
    const digits = String(row.voucher_number).replace(/\D/g, '');
    if (digits) max = Math.max(max, parseInt(digits, 10));
  }
  const next = Math.max(max + 1, vt.starting_number);
  return `${vt.prefix || ''}${next}${vt.suffix || ''}`;
}

/** Loads a voucher with all of its child rows, resolved for display. */
export async function getVoucher(companyId, id, { includeDeleted = false } = {}) {
  const v = await get(
    `SELECT v.*, vt.name AS voucher_type_name, vt.parent_type, vt.affects_stock,
            l.name AS party_name
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
      WHERE v.id = ? AND v.company_id = ?`,
    [id, companyId],
  );
  if (!v || (v.is_deleted && !includeDeleted)) throw notFound('Voucher not found');
  return hydrateVoucher(v);
}

async function hydrateVoucher(v) {
  const entries = await all(
    `SELECT e.*, l.name AS ledger_name, c.name AS cost_centre_name
       FROM voucher_entries e
       JOIN ledgers l ON l.id = e.ledger_id
       LEFT JOIN cost_centres c ON c.id = e.cost_centre_id
      WHERE e.voucher_id = ? ORDER BY e.line_no, e.id`,
    [v.id],
  );
  const inventory = await all(
    `SELECT i.*, s.name AS stock_item_name, g.name AS godown_name, u.symbol AS unit_name
       FROM voucher_inventory i
       JOIN stock_items s ON s.id = i.stock_item_id
       LEFT JOIN godowns g ON g.id = i.godown_id
       LEFT JOIN units u ON u.id = i.unit_id
      WHERE i.voucher_id = ? ORDER BY i.line_no, i.id`,
    [v.id],
  );
  const bills = await all(
    `SELECT b.*, l.name AS ledger_name FROM bill_allocations b
       JOIN ledgers l ON l.id = b.ledger_id
      WHERE b.voucher_id = ? ORDER BY b.id`,
    [v.id],
  );
  return { ...v, entries, inventory, bills };
}

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
      const exists = await get('SELECT id FROM ledgers WHERE id = ? AND company_id = ?', [e.ledger_id, companyId]);
      if (!exists) throw badRequest('Unknown ledger in entries');
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
    const exists = await get('SELECT id FROM stock_items WHERE id = ? AND company_id = ?', [i.stock_item_id, companyId]);
    if (!exists) throw badRequest('Unknown stock item in inventory entries');
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

async function writeChildren(voucherId, entries, inventory, bills) {
  // bill allocations reference entries, so they go first
  await run('DELETE FROM bill_allocations WHERE voucher_id = ?', [voucherId]);
  await run('DELETE FROM voucher_entries WHERE voucher_id = ?', [voucherId]);
  await run('DELETE FROM voucher_inventory WHERE voucher_id = ?', [voucherId]);
  for (const e of entries) await insert('voucher_entries', { ...e, voucher_id: voucherId });
  for (const i of inventory) await insert('voucher_inventory', { ...i, voucher_id: voucherId });
  for (const b of bills) await insert('bill_allocations', { ...b, voucher_id: voucherId, entry_id: null });
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
      party_ledger_id: body.party_ledger_id ? toNum(body.party_ledger_id, null) : null,
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
    });
    await writeChildren(id, entries, inventory, bills);
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

  const before = voucherSnapshot(existing);

  return transaction(async () => {
    await update('vouchers', id, {
      voucher_type_id: vt.id,
      voucher_number: toStr(body.voucher_number ?? existing.voucher_number),
      date: toStr(body.date ?? existing.date),
      reference_no: toStr(body.reference_no ?? existing.reference_no),
      reference_date: toStr(body.reference_date ?? existing.reference_date),
      party_ledger_id: body.party_ledger_id !== undefined
        ? (body.party_ledger_id ? toNum(body.party_ledger_id, null) : null)
        : existing.party_ledger_id,
      narration: toStr(body.narration ?? existing.narration),
      place_of_supply: toStr(body.place_of_supply ?? existing.place_of_supply),
      mode: toStr(body.mode ?? existing.mode),
      is_optional: toBool(body.is_optional ?? existing.is_optional),
      is_post_dated: toBool(body.is_post_dated ?? existing.is_post_dated),
      total_amount: computeTotal(entries, inventory),
      version_no: existing.version_no + 1,
      altered_by: actor?.username || 'admin',
      altered_at: nowStamp(),
    });
    await writeChildren(id, entries, inventory, bills);
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
  const where = ['v.company_id = ?'];
  const params = [companyId];
  if (!opts.includeDeleted) where.push('v.is_deleted = 0');
  if (opts.from) { where.push('v.date >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('v.date <= ?'); params.push(opts.to); }
  if (opts.voucherTypeId) { where.push('v.voucher_type_id = ?'); params.push(toNum(opts.voucherTypeId)); }
  if (opts.voucherType) { where.push('vt.name = ?'); params.push(opts.voucherType); }
  if (opts.parentType) { where.push('vt.parent_type = ?'); params.push(opts.parentType); }
  if (opts.ledgerId) {
    where.push('EXISTS (SELECT 1 FROM voucher_entries e WHERE e.voucher_id = v.id AND e.ledger_id = ?)');
    params.push(toNum(opts.ledgerId));
  }
  if (opts.search) {
    where.push('(v.voucher_number LIKE ? OR v.narration LIKE ? OR l.name LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  const limit = toNum(opts.limit, 500);
  const rows = await all(
    `SELECT v.*, vt.name AS voucher_type_name, vt.parent_type, l.name AS party_name
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.date DESC, v.id DESC
      LIMIT ?`,
    [...params, limit],
  );
  if (!rows.length) return [];

  // one query for every voucher's entries rather than one query per voucher
  const ids = rows.map((v) => v.id);
  const entries = await all(
    `SELECT e.*, l.name AS ledger_name FROM voucher_entries e
       JOIN ledgers l ON l.id = e.ledger_id
      WHERE e.voucher_id IN (${ids.map(() => '?').join(',')})
      ORDER BY e.line_no, e.id`,
    ids,
  );
  const byVoucher = new Map();
  for (const e of entries) {
    if (!byVoucher.has(e.voucher_id)) byVoucher.set(e.voucher_id, []);
    byVoucher.get(e.voucher_id).push(e);
  }
  return rows.map((v) => ({ ...v, entries: byVoucher.get(v.id) || [] }));
}

export function voucherHistory(companyId, id) {
  return historyFor(companyId, 'voucher', id);
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
