import { all, get, insert, run, transaction } from '../db/index.js';
import { MASTERS, createMaster } from './masters.js';
import { createVoucher } from './vouchers.js';
import { getCompany, createCompany } from './companies.js';
import { badRequest, notFound } from '../lib/http.js';
import { APP_NAME } from '../lib/brand.js';
import { trialBalance, stockSummary, ledgerBalances, period } from './reports.js';
import { listVouchers } from './vouchers.js';
import { listLog } from './editlog.js';

/**
 * Tables carried by a company backup, in dependency order. `self` names a
 * column that points back at the same table and therefore needs a second pass.
 */
const TABLES = [
  { table: 'groups', self: 'parent_id' },
  { table: 'currencies' },
  { table: 'cost_categories' },
  { table: 'cost_centres', self: 'parent_id', refs: { category_id: 'cost_categories' } },
  { table: 'budgets', self: 'parent_id' },
  { table: 'scenarios' },
  { table: 'voucher_types' },
  { table: 'stock_groups', self: 'parent_id' },
  { table: 'stock_categories', self: 'parent_id' },
  { table: 'units', selfMany: ['base_unit_id', 'additional_unit_id'] },
  { table: 'godowns', self: 'parent_id' },
  { table: 'ledgers', refs: { group_id: 'groups' } },
  {
    table: 'stock_items',
    refs: { stock_group_id: 'stock_groups', category_id: 'stock_categories', unit_id: 'units' },
  },
  { table: 'gst_registrations' },
  { table: 'gst_classifications' },
  { table: 'tds_natures' },
  { table: 'vouchers', refs: { voucher_type_id: 'voucher_types', party_ledger_id: 'ledgers' } },
];

/** Child tables keyed off a voucher rather than the company. */
const CHILD_TABLES = [
  {
    table: 'voucher_entries',
    parent: 'voucher_id',
    refs: { voucher_id: 'vouchers', ledger_id: 'ledgers', cost_centre_id: 'cost_centres' },
  },
  {
    table: 'voucher_inventory',
    parent: 'voucher_id',
    refs: {
      voucher_id: 'vouchers', stock_item_id: 'stock_items',
      godown_id: 'godowns', unit_id: 'units',
    },
  },
  {
    table: 'bill_allocations',
    parent: 'voucher_id',
    refs: { voucher_id: 'vouchers', ledger_id: 'ledgers', entry_id: 'voucher_entries' },
  },
];

/** entity_type in the edit log maps back to the table it points at. */
function tableForEntityType(type) {
  if (type === 'voucher') return 'vouchers';
  if (type === 'company') return null;
  return MASTERS[type]?.table || null;
}

/** A complete, self-contained snapshot of one company. */
export async function backupCompany(companyId) {
  const company = await getCompany(companyId);
  const data = {};
  for (const { table } of TABLES) {
    data[table] = await all(`SELECT * FROM ${table} WHERE company_id = ?`, [companyId]);
  }
  const voucherIds = data.vouchers.map((v) => v.id);
  for (const { table, parent } of CHILD_TABLES) {
    data[table] = voucherIds.length
      ? await all(
        `SELECT * FROM ${table} WHERE ${parent} IN (${voucherIds.map(() => '?').join(',')})`,
        voucherIds,
      )
      : [];
  }
  data.edit_log = await all('SELECT * FROM edit_log WHERE company_id = ?', [companyId]);

  return {
    format: 'ledgertrail.backup',
    version: 1,
    created_at: new Date().toISOString(),
    company,
    data,
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
  };
}

/**
 * Recreates a backed-up company under a new id, remapping every foreign key
 * and carrying the edit log across so the audit trail survives the round trip.
 */
export async function restoreCompany(dump, { name } = {}) {
  if (!dump || dump.format !== 'ledgertrail.backup') {
    throw badRequest(`That file is not a ${APP_NAME} backup`);
  }
  const src = dump.company;
  if (!src) throw badRequest('The backup has no company record');

  return transaction(async () => {
    const wanted = (name || src.name || 'Restored Company').trim();
    const finalName = await uniqueCompanyName(wanted);
    const { id: _ignored, ...companyFields } = src;
    const companyId = await insert('companies', { ...companyFields, name: finalName });

    const maps = {};
    const put = (table, oldId, newId) => {
      (maps[table] ||= new Map()).set(Number(oldId), newId);
    };
    const look = (table, oldId) => {
      if (oldId === null || oldId === undefined || oldId === '') return null;
      return maps[table]?.get(Number(oldId)) ?? null;
    };

    const d = dump.data || {};

    for (const spec of TABLES) {
      const rows = d[spec.table] || [];
      const selfCols = spec.selfMany || (spec.self ? [spec.self] : []);
      for (const row of rows) {
        const { id: oldId, ...rest } = row;
        const payload = { ...rest, company_id: companyId };
        for (const col of selfCols) payload[col] = null;
        for (const [col, target] of Object.entries(spec.refs || {})) {
          payload[col] = look(target, row[col]);
        }
        put(spec.table, oldId, await insert(spec.table, payload));
      }
      // second pass for self references, now that every row has an id
      for (const col of selfCols) {
        for (const row of rows) {
          if (row[col] === null || row[col] === undefined) continue;
          const newId = look(spec.table, row.id);
          const newParent = look(spec.table, row[col]);
          if (newId && newParent) {
            await run(`UPDATE ${spec.table} SET ${col} = ? WHERE id = ?`, [newParent, newId]);
          }
        }
      }
    }

    for (const spec of CHILD_TABLES) {
      for (const row of d[spec.table] || []) {
        const { id: oldId, ...rest } = row;
        const payload = { ...rest };
        for (const [col, target] of Object.entries(spec.refs || {})) {
          payload[col] = look(target, row[col]);
        }
        if (!payload[spec.parent]) continue;
        put(spec.table, oldId, await insert(spec.table, payload));
      }
    }

    for (const row of d.edit_log || []) {
      const { id: _old, ...rest } = row;
      const target = tableForEntityType(row.entity_type);
      const mapped = target ? look(target, row.entity_id) : companyId;
      await insert('edit_log', {
        ...rest,
        company_id: companyId,
        entity_id: mapped ?? row.entity_id,
      });
    }

    return { company: await getCompany(companyId), restored: dump.counts || {} };
  });
}

async function uniqueCompanyName(name) {
  let candidate = name;
  let n = 2;
  while (await get('SELECT id FROM companies WHERE name = ?', [candidate])) {
    candidate = `${name} (${n})`;
    n += 1;
  }
  return candidate;
}

/* ------------------------------------------------------------------ CSV */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}

/** The data sets the Export screen offers. */
export const EXPORT_KINDS = {
  ledgers: 'Ledgers',
  groups: 'Groups',
  'stock-items': 'Stock Items',
  vouchers: 'Vouchers',
  'day-book': 'Day Book',
  'trial-balance': 'Trial Balance',
  'stock-summary': 'Stock Summary',
  'edit-log': 'Edit Log',
};

export async function exportDataset(kind, companyId, q = {}) {
  const p = await period(companyId, q);

  switch (kind) {
    case 'ledgers': {
      const rows = await all(
        `SELECT l.name, g.name AS under, l.opening_balance, l.opening_balance_type,
                l.gstin, l.registration_type, l.state, l.email, l.phone,
                l.credit_period_days, l.credit_limit
           FROM ledgers l JOIN groups g ON g.id = l.group_id
          WHERE l.company_id = ? ORDER BY l.name COLLATE NOCASE`,
        [companyId],
      );
      return {
        headers: ['Name', 'Under', 'Opening Balance', 'Dr/Cr', 'GSTIN', 'Registration Type',
          'State', 'E-Mail', 'Phone', 'Credit Period', 'Credit Limit'],
        rows: rows.map((r) => Object.values(r)),
        json: rows,
      };
    }
    case 'groups': {
      const rows = await all(
        `SELECT g.name, p.name AS under, g.nature, g.is_primary, g.is_reserved
           FROM groups g LEFT JOIN groups p ON p.id = g.parent_id
          WHERE g.company_id = ? ORDER BY g.sort_position, g.name COLLATE NOCASE`,
        [companyId],
      );
      return {
        headers: ['Name', 'Under', 'Nature', 'Primary', 'Reserved'],
        rows: rows.map((r) => [r.name, r.under || '', r.nature, r.is_primary ? 'Yes' : 'No',
          r.is_reserved ? 'Yes' : 'No']),
        json: rows,
      };
    }
    case 'stock-items': {
      const rows = await all(
        `SELECT s.name, sg.name AS under, u.symbol AS units, s.opening_qty, s.opening_rate,
                s.opening_value, s.hsn_sac, s.tax_rate, s.standard_price
           FROM stock_items s
           LEFT JOIN stock_groups sg ON sg.id = s.stock_group_id
           LEFT JOIN units u ON u.id = s.unit_id
          WHERE s.company_id = ? ORDER BY s.name COLLATE NOCASE`,
        [companyId],
      );
      return {
        headers: ['Name', 'Under', 'Units', 'Opening Qty', 'Opening Rate', 'Opening Value',
          'HSN/SAC', 'Tax Rate', 'Standard Price'],
        rows: rows.map((r) => Object.values(r)),
        json: rows,
      };
    }
    case 'vouchers':
    case 'day-book': {
      const vouchers = await listVouchers(companyId, { from: p.from, to: p.to, limit: 10000 });
      const rows = [];
      for (const v of vouchers) {
        for (const e of v.entries) {
          rows.push([
            v.date, v.voucher_type_name, v.voucher_number, v.party_name || '',
            e.ledger_name, e.dr_cr, e.amount, v.narration,
            v.is_cancelled ? 'Cancelled' : v.is_optional ? 'Optional' : 'Active',
            v.version_no,
          ]);
        }
      }
      return {
        headers: ['Date', 'Voucher Type', 'Voucher No.', 'Party', 'Ledger', 'Dr/Cr',
          'Amount', 'Narration', 'Status', 'Version'],
        rows,
        json: vouchers,
      };
    }
    case 'trial-balance': {
      const tb = await trialBalance(companyId, q);
      const flat = flattenTree(tb.rows);
      return {
        headers: ['Particulars', 'Level', 'Type', 'Opening', 'Debit', 'Credit', 'Closing'],
        rows: flat.map((n) => [
          `${'  '.repeat(n.depth)}${n.name}`, n.depth, n.type,
          n.opening, n.debit, n.credit, n.closing,
        ]),
        json: tb,
      };
    }
    case 'stock-summary': {
      const ss = await stockSummary(companyId, q);
      return {
        headers: ['Item', 'Under', 'Unit', 'Opening Qty', 'Opening Value', 'Inwards Qty',
          'Outwards Qty', 'Closing Qty', 'Closing Rate', 'Closing Value'],
        rows: ss.rows.map((r) => [r.name, r.stock_group_name, r.unit_name, r.openingQty,
          r.openingValue, r.inwardQty, r.outwardQty, r.closingQty, r.closingRate, r.closingValue]),
        json: ss,
      };
    }
    case 'edit-log': {
      const rows = await listLog(companyId, { limit: 10000 });
      return {
        headers: ['Logged At', 'User', 'Action', 'Record Type', 'Particulars', 'Version',
          'Voucher Date', 'Voucher No.', 'Amount', 'Fields Changed', 'Machine'],
        rows: rows.map((r) => [r.logged_at, r.username, r.action, r.entity_type, r.entity_label,
          r.version_no, r.voucher_date, r.voucher_number, r.amount, r.changeCount, r.machine]),
        json: rows,
      };
    }
    default:
      throw notFound(`Unknown export "${kind}"`);
  }
}

/* --------------------------------------------------------------- import */

export const IMPORT_KINDS = {
  ledgers: { label: 'Ledgers', master: 'ledger' },
  groups: { label: 'Groups', master: 'group' },
  'stock-items': { label: 'Stock Items', master: 'stock-item' },
  units: { label: 'Units', master: 'unit' },
  godowns: { label: 'Godowns', master: 'godown' },
  vouchers: { label: 'Vouchers', master: null },
};

/**
 * Imports rows through the normal create paths, so validation runs and every
 * imported record lands in the Edit Log exactly like a hand-keyed one.
 */
export async function importRows(kind, companyId, rows, actor) {
  const spec = IMPORT_KINDS[kind];
  if (!spec) throw notFound(`Unknown import "${kind}"`);
  if (!Array.isArray(rows) || !rows.length) throw badRequest('Nothing to import');

  const created = [];
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (spec.master) {
        const payload = await resolveNames(spec.master, companyId, row);
        created.push(await createMaster(spec.master, companyId, payload, actor));
      } else {
        const payload = await resolveVoucher(companyId, row);
        created.push(await createVoucher(companyId, payload, actor));
      }
    } catch (err) {
      failed.push({ line: i + 1, error: err.message, row });
    }
  }

  return { imported: created.length, failed, total: rows.length };
}

/** Lets an import refer to masters by name instead of by id. */
async function resolveNames(masterKey, companyId, row) {
  const out = { ...row };
  const byName = async (table, name, col = 'name') => {
    if (!name) return null;
    const found = await get(
      `SELECT id FROM ${table} WHERE company_id = ? AND ${col} = ?`,
      [companyId, String(name).trim()],
    );
    return found ? found.id : null;
  };

  if (masterKey === 'ledger' && (out.under || out.group)) {
    out.group_id = await byName('groups', out.under || out.group);
    if (!out.group_id) throw badRequest(`Unknown group "${out.under || out.group}"`);
  }
  if (masterKey === 'group' && (out.under || out.parent)) {
    out.parent_id = await byName('groups', out.under || out.parent);
  }
  if (masterKey === 'stock-item') {
    if (out.under || out.stock_group) {
      out.stock_group_id = await byName('stock_groups', out.under || out.stock_group);
    }
    if (out.units || out.unit) out.unit_id = await byName('units', out.units || out.unit, 'symbol');
  }
  if (masterKey === 'godown' && (out.under || out.parent)) {
    out.parent_id = await byName('godowns', out.under || out.parent);
  }
  return out;
}

async function resolveVoucher(companyId, row) {
  const out = { ...row };
  const ledgerId = async (name) => {
    const found = await get(
      'SELECT id FROM ledgers WHERE company_id = ? AND name = ?',
      [companyId, String(name || '').trim()],
    );
    if (!found) throw badRequest(`Unknown ledger "${name}"`);
    return found.id;
  };
  if (out.party && !out.party_ledger_id) out.party_ledger_id = await ledgerId(out.party);
  if (Array.isArray(out.entries)) {
    const resolved = [];
    for (const e of out.entries) {
      resolved.push({ ...e, ledger_id: e.ledger_id || await ledgerId(e.ledger) });
    }
    out.entries = resolved;
  }
  return out;
}

/** Light maintenance: refresh the query planner's statistics. */
export async function repairData() {
  await run('EXEC sp_updatestats');
  return { ok: true, message: 'Statistics rebuilt for every table.' };
}

export { createCompany };
