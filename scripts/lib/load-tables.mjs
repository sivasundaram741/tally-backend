/**
 * Loads table-shaped data - `{ tableName: rows[] }`, the layout of the old SQL
 * Server and SQLite databases - into MongoDB, keeping every id so all the
 * references between rows stay valid without remapping.
 *
 *  - voucher_entries / voucher_inventory / bill_allocations are folded into
 *    the voucher they belong to
 *  - edit_log snapshots stored as JSON text become real documents
 *  - columns the current schema does not have are dropped (and reported)
 *  - id counters are moved past the highest loaded id
 *
 * A collection that already holds documents is skipped, unless `replace` is
 * set, in which case it is emptied first.
 */
import {
  migrate, col, importRows, buildChildren, syncCounters,
} from '../../src/db/index.js';
import { COLLECTIONS, CHILDREN, CHILD_TABLES } from '../../src/db/schema.js';

/** Collections in load order (the order no longer matters for integrity). */
const ORDER = [
  'users', 'companies', 'groups', 'currencies', 'cost_categories', 'cost_centres',
  'budgets', 'scenarios', 'voucher_types', 'stock_groups', 'stock_categories',
  'units', 'godowns', 'ledgers', 'stock_items', 'gst_registrations',
  'gst_classifications', 'tds_natures', 'vouchers', 'edit_log', 'sessions',
];

function pick(fields, row, dropped, label) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || key in fields) out[key] = typeof value === 'bigint' ? Number(value) : value;
    else (dropped[label] ||= new Set()).add(key);
  }
  return out;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function loadTables(tables, { replace = false, log = console.log } = {}) {
  await migrate();
  const dropped = {};
  const loaded = {};

  // voucher lines grouped by the voucher that owns them
  const linesByVoucher = {};
  for (const [table, kind] of Object.entries(CHILD_TABLES)) {
    const byVoucher = new Map();
    for (const row of tables[table] || []) {
      const vid = Number(row.voucher_id);
      if (!byVoucher.has(vid)) byVoucher.set(vid, []);
      byVoucher.get(vid).push(row);
    }
    linesByVoucher[kind] = byVoucher;
  }

  for (const name of ORDER) {
    const rows = tables[name] || [];
    if (!rows.length) continue;

    const existing = await col(name).countDocuments();
    if (existing > 0) {
      if (!replace) {
        log(`  skipped ${name} (already holds ${existing} documents)`);
        continue;
      }
      await col(name).deleteMany({});
    }

    const { fields } = COLLECTIONS[name];
    let docs = rows.map((row) => pick(fields, row, dropped, name));

    if (name === 'vouchers') {
      docs = await Promise.all(docs.map(async (v) => {
        const lines = {};
        for (const [kind, spec] of Object.entries(CHILDREN)) {
          const source = linesByVoucher[kind].get(Number(v.id)) || [];
          const sorted = [...source].sort((a, b) => ((a.line_no ?? 0) - (b.line_no ?? 0)) || (a.id - b.id));
          lines[kind] = await buildChildren(kind, sorted.map((line) => pick(spec.fields, line, dropped, kind)));
        }
        return { ...v, ...lines };
      }));
      for (const [table, kind] of Object.entries(CHILD_TABLES)) {
        loaded[table] = docs.reduce((n, v) => n + v[kind].length, 0);
      }
    }

    if (name === 'edit_log') {
      docs = docs.map((r) => ({
        ...r,
        snapshot: parseJson(r.snapshot, {}),
        changes: parseJson(r.changes, []),
      }));
    }

    loaded[name] = await importRows(name, docs);
    log(`  loaded ${String(loaded[name]).padStart(5)} ${name}`);
  }

  for (const [table, n] of Object.entries(loaded)) {
    if (CHILD_TABLES[table]) log(`  folded ${String(n).padStart(5)} ${table} into vouchers`);
  }
  for (const [label, cols] of Object.entries(dropped)) {
    // `voucher_id` on a line is implied by the voucher that now holds it
    const real = [...cols].filter((c) => !(CHILDREN[label] && c === 'voucher_id'));
    if (real.length) log(`  note: dropped unknown column(s) on ${label}: ${real.join(', ')}`);
  }

  await syncCounters();
  return loaded;
}
