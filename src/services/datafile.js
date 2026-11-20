import {
  find, findOne, exists, insertMany, updateWhere, transaction, nextIds, buildChildren,
  namesById, runCommand, syncCounters,
} from '../db/index.js';
import { COLLECTIONS, CHILD_TABLES } from '../db/schema.js';
import { parseStored } from '../lib/editlog.js';
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

/**
 * Voucher lines. MongoDB keeps them inside each voucher; a backup lists them
 * as separate tables, exactly as SQL Server stored them, so backups made
 * before and after the move to MongoDB are interchangeable.
 */
const LINE_TABLES = [
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
    data[table] = await find(table, { company_id: companyId }, { sort: { id: 1 } });
  }

  // lay the embedded voucher lines out as the tables a backup has always had
  const vouchers = data.vouchers;
  data.vouchers = vouchers.map(({ entries, inventory, bills, ...header }) => header);
  for (const { table } of LINE_TABLES) {
    const kind = CHILD_TABLES[table];
    data[table] = vouchers
      .flatMap((v) => v[kind].map(({ id, ...line }) => (
        kind === 'bills'
          ? { id, entry_id: line.entry_id, voucher_id: v.id, ...line }
          : { id, voucher_id: v.id, ...line })))
      .sort((a, b) => a.id - b.id);
  }

  // the backup format keeps snapshots as JSON text, as SQL Server stored them
  data.edit_log = (await find('edit_log', { company_id: companyId }, { sort: { id: 1 } }))
    .map((r) => ({ ...r, snapshot: JSON.stringify(r.snapshot ?? {}), changes: JSON.stringify(r.changes ?? []) }));

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
    const { id: _ignored, financial_year_to: _derived, ...companyFields } = src;
    const [companyId] = await insertMany('companies', [{ ...companyFields, name: finalName }]);

    const maps = {};
    const put = (table, oldId, newId) => {
      (maps[table] ||= new Map()).set(Number(oldId), newId);
    };
    const look = (table, oldId) => {
      if (oldId === null || oldId === undefined || oldId === '') return null;
      return maps[table]?.get(Number(oldId)) ?? null;
    };
    const remap = (row, refs) => {
      const out = { ...row };
      for (const [col, target] of Object.entries(refs || {})) out[col] = look(target, row[col]);
      return out;
    };

    const d = dump.data || {};

    for (const spec of TABLES) {
      if (spec.table === 'vouchers') continue; // below, once their lines are ready
      const rows = d[spec.table] || [];
      const selfCols = spec.selfMany || (spec.self ? [spec.self] : []);
      const payloads = rows.map(({ id: _old, ...rest }) => {
        const payload = remap({ ...rest, company_id: companyId }, spec.refs);
        for (const col of selfCols) payload[col] = null;
        return payload;
      });
      const ids = await insertMany(spec.table, payloads);
      rows.forEach((row, i) => put(spec.table, row.id, ids[i]));

      // second pass for self references, now that every row has an id
      for (const col of selfCols) {
        for (const row of rows) {
          if (row[col] === null || row[col] === undefined) continue;
          const newId = look(spec.table, row.id);
          const newParent = look(spec.table, row[col]);
          if (newId && newParent) await updateWhere(spec.table, { id: newId }, { [col]: newParent });
        }
      }
    }

    // voucher lines, grouped under the voucher they belong to
    const voucherIds = new Set((d.vouchers || []).map((v) => Number(v.id)));
    const linesOf = (table) => {
      const byVoucher = new Map();
      for (const row of d[table] || []) {
        if (!voucherIds.has(Number(row.voucher_id))) continue;
        if (!byVoucher.has(Number(row.voucher_id))) byVoucher.set(Number(row.voucher_id), []);
        byVoucher.get(Number(row.voucher_id)).push(row);
      }
      return byVoucher;
    };
    const lineSpec = Object.fromEntries(LINE_TABLES.map((t) => [t.table, t.refs]));
    const entryRows = linesOf('voucher_entries');
    const inventoryRows = linesOf('voucher_inventory');
    const billRows = linesOf('bill_allocations');

    // entries get their new ids up front so bill allocations can point at them
    const entryTotal = [...entryRows.values()].reduce((n, list) => n + list.length, 0);
    let nextEntryId = entryTotal ? await nextIds('voucher_entries', entryTotal) : 0;
    for (const list of entryRows.values()) {
      for (const row of list) put('voucher_entries', row.id, nextEntryId++);
    }

    const lineFields = (row, refs, extra = {}) => {
      const { id: _old, voucher_id: _v, ...rest } = remap(row, refs);
      return { ...rest, ...extra };
    };

    const voucherRows = d.vouchers || [];
    const voucherDocs = [];
    for (const row of voucherRows) {
      const oldId = Number(row.id);
      const { id: _old, entries: _e, inventory: _i, bills: _b, ...header } = row;
      voucherDocs.push({
        ...remap({ ...header, company_id: companyId }, TABLES.find((t) => t.table === 'vouchers').refs),
        entries: await buildChildren('entries', (entryRows.get(oldId) || []).map((e) => ({
          ...lineFields(e, lineSpec.voucher_entries),
          id: look('voucher_entries', e.id),
        }))),
        inventory: await buildChildren('inventory', (inventoryRows.get(oldId) || [])
          .map((i) => lineFields(i, lineSpec.voucher_inventory))),
        bills: await buildChildren('bills', (billRows.get(oldId) || [])
          .map((b) => lineFields(b, lineSpec.bill_allocations))),
      });
    }
    const newVoucherIds = await insertMany('vouchers', voucherDocs);
    voucherRows.forEach((row, i) => put('vouchers', row.id, newVoucherIds[i]));

    const logRows = (d.edit_log || []).map(({ id: _old, ...rest }) => {
      const target = tableForEntityType(rest.entity_type);
      const mapped = target ? look(target, rest.entity_id) : companyId;
      return {
        ...rest,
        company_id: companyId,
        entity_id: mapped ?? rest.entity_id,
        snapshot: parseStored(rest.snapshot, {}),
        changes: parseStored(rest.changes, []),
      };
    });
    await insertMany('edit_log', logRows);

    return { company: await getCompany(companyId), restored: dump.counts || {} };
  });
}

async function uniqueCompanyName(name) {
  let candidate = name;
  let n = 2;
  while (await exists('companies', { name: candidate })) {
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
      const ledgers = await find('ledgers', { company_id: companyId }, { sort: { name: 1 } });
      const groups = await namesById('groups', ledgers.map((l) => l.group_id));
      const rows = ledgers.filter((l) => groups.has(l.group_id)).map((l) => ({
        name: l.name,
        under: groups.get(l.group_id),
        opening_balance: l.opening_balance,
        opening_balance_type: l.opening_balance_type,
        gstin: l.gstin,
        registration_type: l.registration_type,
        state: l.state,
        email: l.email,
        phone: l.phone,
        credit_period_days: l.credit_period_days,
        credit_limit: l.credit_limit,
      }));
      return {
        headers: ['Name', 'Under', 'Opening Balance', 'Dr/Cr', 'GSTIN', 'Registration Type',
          'State', 'E-Mail', 'Phone', 'Credit Period', 'Credit Limit'],
        rows: rows.map((r) => Object.values(r)),
        json: rows,
      };
    }
    case 'groups': {
      const groups = await find('groups', { company_id: companyId }, { sort: { sort_position: 1, name: 1 } });
      const parents = await namesById('groups', groups.map((g) => g.parent_id));
      const rows = groups.map((g) => ({
        name: g.name,
        under: parents.get(g.parent_id) ?? null,
        nature: g.nature,
        is_primary: g.is_primary,
        is_reserved: g.is_reserved,
      }));
      return {
        headers: ['Name', 'Under', 'Nature', 'Primary', 'Reserved'],
        rows: rows.map((r) => [r.name, r.under || '', r.nature, r.is_primary ? 'Yes' : 'No',
          r.is_reserved ? 'Yes' : 'No']),
        json: rows,
      };
    }
    case 'stock-items': {
      const items = await find('stock_items', { company_id: companyId }, { sort: { name: 1 } });
      const [groups, units] = await Promise.all([
        namesById('stock_groups', items.map((s) => s.stock_group_id)),
        namesById('units', items.map((s) => s.unit_id), 'symbol'),
      ]);
      const rows = items.map((s) => ({
        name: s.name,
        under: groups.get(s.stock_group_id) ?? null,
        units: units.get(s.unit_id) ?? null,
        opening_qty: s.opening_qty,
        opening_rate: s.opening_rate,
        opening_value: s.opening_value,
        hsn_sac: s.hsn_sac,
        tax_rate: s.tax_rate,
        standard_price: s.standard_price,
      }));
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
    const found = await findOne(table, { company_id: companyId, [col]: String(name).trim() }, { project: { id: 1 } });
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
    const found = await findOne('ledgers', { company_id: companyId, name: String(name || '').trim() }, {
      project: { id: 1 },
    });
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

/**
 * Light maintenance: has MongoDB check every collection and its indexes for
 * damage, and realigns the id counters with the data.
 */
export async function repairData() {
  const names = [...Object.keys(COLLECTIONS), 'counters'];
  const problems = [];
  for (const name of names) {
    const result = await runCommand({ validate: name });
    if (!result.valid) problems.push(`${name}: ${(result.errors || []).join('; ') || 'invalid'}`);
  }
  await syncCounters();
  if (problems.length) {
    return { ok: false, message: `Problems found in ${problems.length} collection(s): ${problems.join(' | ')}` };
  }
  return { ok: true, message: `Checked ${names.length} collections - no problems found. Id counters realigned.` };
}

export { createCompany };
