import { all, get, insert, update, run, transaction } from '../db/index.js';
import { logChange, historyFor } from '../lib/editlog.js';
import { badRequest, notFound, conflict, toNum, toBool, toStr } from '../lib/http.js';

/**
 * Field kinds: t = text, n = number, b = boolean(0/1), r = reference(id).
 * A reference also carries the table it points at so snapshots can store the
 * readable name instead of a meaningless row id.
 */
const t = (col, def = '') => ({ col, kind: 't', def });
const n = (col, def = 0) => ({ col, kind: 'n', def });
const b = (col, def = 0) => ({ col, kind: 'b', def });
const r = (col, table, nameCol = 'name') => ({ col, kind: 'r', table, nameCol });

/** Every master type the application knows about. */
export const MASTERS = {
  group: {
    table: 'groups',
    label: 'Group',
    plural: 'Groups',
    kind: 'Accounting',
    nameCol: 'name',
    parentCol: 'parent_id',
    fields: [
      t('name'), t('alias'), r('parent_id', 'groups'), t('nature', 'Assets'),
      b('is_deemed_positive', 1), b('affects_gross_profit'), b('net_debit_credit'),
      b('used_for_calculation'), b('is_inactive'),
    ],
  },
  ledger: {
    table: 'ledgers',
    label: 'Ledger',
    plural: 'Ledgers',
    kind: 'Accounting',
    nameCol: 'name',
    fields: [
      t('name'), t('alias'), r('group_id', 'groups'),
      n('opening_balance'), t('opening_balance_type', 'Dr'),
      t('mailing_name'), t('address'), t('state'), t('country', 'India'), t('pincode'),
      t('phone'), t('email'), t('contact_person'),
      t('pan'), t('gstin'), t('registration_type', 'Unregistered'),
      t('gst_applicable', 'Not Applicable'), t('hsn_sac'), t('tax_type'), n('tax_rate'),
      t('bank_account_no'), t('bank_ifsc'), t('bank_name'), t('bank_branch'),
      b('is_bill_wise'), b('is_cost_centre'), b('inventory_affected'),
      n('credit_period_days'), n('credit_limit'), b('is_inactive'),
    ],
  },
  currency: {
    table: 'currencies',
    label: 'Currency',
    plural: 'Currencies',
    kind: 'Accounting',
    nameCol: 'symbol',
    fields: [
      t('symbol'), t('formal_name'), n('decimal_places', 2), b('is_base'),
      b('suffix_symbol'), b('space_between', 1), t('amount_in_words'), t('decimal_words'),
      b('is_inactive'),
    ],
  },
  budget: {
    table: 'budgets',
    label: 'Budget',
    plural: 'Budgets',
    kind: 'Accounting',
    nameCol: 'name',
    parentCol: 'parent_id',
    fields: [t('name'), r('parent_id', 'budgets'), t('period_from'), t('period_to'), b('is_inactive')],
  },
  scenario: {
    table: 'scenarios',
    label: 'Scenario',
    plural: 'Scenarios',
    kind: 'Accounting',
    nameCol: 'name',
    fields: [t('name'), t('include_types'), t('exclude_types'), b('is_inactive')],
  },
  'voucher-type': {
    table: 'voucher_types',
    label: 'Voucher Type',
    plural: 'Voucher Types',
    kind: 'Accounting',
    nameCol: 'name',
    fields: [
      t('name'), t('alias'), t('parent_type', 'Journal'), t('abbreviation'),
      t('numbering_method', 'Automatic'), t('restart_numbering', 'Yearly'),
      t('prefix'), t('suffix'), n('starting_number', 1),
      b('use_common_narration', 1), b('narration_per_entry'), b('print_after_saving'),
      b('is_optional_default'), b('affects_stock'), b('allow_zero_valued'), b('is_inactive'),
    ],
  },
  'cost-category': {
    table: 'cost_categories',
    label: 'Cost Category',
    plural: 'Cost Categories',
    kind: 'Accounting',
    nameCol: 'name',
    fields: [t('name'), t('alias'), b('allocate_revenue', 1), b('allocate_non_revenue'), b('is_inactive')],
  },
  'cost-centre': {
    table: 'cost_centres',
    label: 'Cost Centre',
    plural: 'Cost Centres',
    kind: 'Accounting',
    nameCol: 'name',
    parentCol: 'parent_id',
    fields: [
      t('name'), t('alias'), r('category_id', 'cost_categories'),
      r('parent_id', 'cost_centres'), b('is_inactive'),
    ],
  },
  'stock-group': {
    table: 'stock_groups',
    label: 'Stock Group',
    plural: 'Stock Groups',
    kind: 'Inventory',
    nameCol: 'name',
    parentCol: 'parent_id',
    fields: [
      t('name'), t('alias'), r('parent_id', 'stock_groups'),
      b('quantities_added', 1), t('hsn_sac'), n('tax_rate'), b('is_inactive'),
    ],
  },
  'stock-category': {
    table: 'stock_categories',
    label: 'Stock Category',
    plural: 'Stock Categories',
    kind: 'Inventory',
    nameCol: 'name',
    parentCol: 'parent_id',
    fields: [t('name'), t('alias'), r('parent_id', 'stock_categories'), b('is_inactive')],
  },
  'stock-item': {
    table: 'stock_items',
    label: 'Stock Item',
    plural: 'Stock Items',
    kind: 'Inventory',
    nameCol: 'name',
    fields: [
      t('name'), t('alias'), t('part_number'),
      r('stock_group_id', 'stock_groups'), r('category_id', 'stock_categories'),
      r('unit_id', 'units', 'symbol'),
      n('opening_qty'), n('opening_rate'), n('opening_value'),
      t('gst_applicable', 'Applicable'), t('hsn_sac'), t('taxability', 'Taxable'),
      n('tax_rate'), n('cess_rate'),
      n('standard_cost'), n('standard_price'), t('costing_method', 'Avg. Cost'),
      b('maintain_batches'), n('reorder_level'), n('min_order_qty'), b('is_inactive'),
    ],
  },
  unit: {
    table: 'units',
    label: 'Unit',
    plural: 'Units',
    kind: 'Inventory',
    nameCol: 'symbol',
    fields: [
      t('symbol'), t('formal_name'), t('unit_type', 'Simple'), n('decimal_places'),
      r('base_unit_id', 'units', 'symbol'), r('additional_unit_id', 'units', 'symbol'),
      n('conversion', 1), b('is_inactive'),
    ],
  },
  godown: {
    table: 'godowns',
    label: 'Godown',
    plural: 'Godowns',
    kind: 'Inventory',
    nameCol: 'name',
    parentCol: 'parent_id',
    fields: [
      t('name'), t('alias'), r('parent_id', 'godowns'), t('address'),
      b('allow_storage', 1), b('is_inactive'),
    ],
  },
  'gst-registration': {
    table: 'gst_registrations',
    label: 'GST Registration',
    plural: 'GST Registrations',
    kind: 'Statutory',
    nameCol: 'name',
    fields: [
      t('name'), t('state'), t('registration_type', 'Regular'), t('gstin'),
      t('applicable_from'), t('periodicity', 'Monthly'), b('is_default'), b('is_inactive'),
    ],
  },
  'gst-classification': {
    table: 'gst_classifications',
    label: 'GST Classification',
    plural: 'GST Classifications',
    kind: 'Statutory',
    nameCol: 'name',
    fields: [
      t('name'), t('hsn_sac'), t('description'), t('taxability', 'Taxable'),
      n('tax_rate'), n('cess_rate'), t('applicable_from'), b('is_inactive'),
    ],
  },
  'tds-nature': {
    table: 'tds_natures',
    label: 'TDS Nature of Payment',
    plural: 'TDS Natures of Payment',
    kind: 'Statutory',
    nameCol: 'name',
    fields: [
      t('name'), t('section'), t('payment_code'), n('rate_individual'),
      n('rate_company'), n('rate_no_pan', 20), n('threshold'), b('is_inactive'),
    ],
  },
};

/** Tables that reference a master, used to block deletion of masters in use. */
const USAGE = {
  groups: [
    ['ledgers', 'group_id', 'ledger'],
    ['groups', 'parent_id', 'group'],
  ],
  ledgers: [
    ['voucher_entries', 'ledger_id', 'voucher entry'],
    ['vouchers', 'party_ledger_id', 'voucher'],
    ['bill_allocations', 'ledger_id', 'bill reference'],
  ],
  stock_items: [['voucher_inventory', 'stock_item_id', 'voucher']],
  units: [['stock_items', 'unit_id', 'stock item']],
  godowns: [['voucher_inventory', 'godown_id', 'voucher']],
  stock_groups: [
    ['stock_items', 'stock_group_id', 'stock item'],
    ['stock_groups', 'parent_id', 'stock group'],
  ],
  stock_categories: [['stock_items', 'category_id', 'stock item']],
  voucher_types: [['vouchers', 'voucher_type_id', 'voucher']],
  cost_centres: [['voucher_entries', 'cost_centre_id', 'voucher entry']],
  cost_categories: [['cost_centres', 'category_id', 'cost centre']],
};

export function def(key) {
  const d = MASTERS[key];
  if (!d) throw notFound(`Unknown master type "${key}"`);
  return d;
}

export function masterCatalogue() {
  return Object.entries(MASTERS).map(([key, d]) => ({
    key, label: d.label, plural: d.plural, kind: d.kind, nameCol: d.nameCol,
  }));
}

/** Coerces an incoming payload to the columns declared for this master. */
function coerce(d, body, existing) {
  const out = {};
  for (const f of d.fields) {
    let v = body[f.col];
    if (v === undefined) {
      if (existing) continue;            // leave untouched on partial update
      v = f.def;
    }
    if (f.kind === 'n') out[f.col] = toNum(v, f.def ?? 0);
    else if (f.kind === 'b') out[f.col] = toBool(v, f.def ?? 0);
    else if (f.kind === 'r') out[f.col] = v === '' || v === null ? null : toNum(v, null);
    else out[f.col] = toStr(v, f.def ?? '');
  }
  return out;
}

/** One query per referenced table, rather than one per row and column. */
async function refNameMaps(d, rows) {
  const maps = {};
  for (const f of d.fields) {
    if (f.kind !== 'r') continue;
    const ids = [...new Set(rows.map((row) => row[f.col]).filter((v) => v != null))];
    const key = `${f.table}.${f.nameCol}`;
    maps[key] ||= new Map();
    const missing = ids.filter((id) => !maps[key].has(Number(id)));
    if (!missing.length) continue;
    const found = await all(
      `SELECT id, ${f.nameCol} AS n FROM ${f.table} WHERE id IN (${missing.map(() => '?').join(',')})`,
      missing,
    );
    for (const row of found) maps[key].set(Number(row.id), row.n);
  }
  return maps;
}

const refLabel = (maps, f, value) =>
  (value == null ? '' : maps[`${f.table}.${f.nameCol}`]?.get(Number(value)) ?? '');

/** Converts reference ids into their display names for the Edit Log. */
export async function snapshot(d, row) {
  if (!row) return null;
  const maps = await refNameMaps(d, [row]);
  return snapshotWith(d, row, maps);
}

function snapshotWith(d, row, maps) {
  const snap = {};
  for (const f of d.fields) {
    const v = row[f.col];
    if (f.kind === 'r') snap[f.col] = refLabel(maps, f, v);
    else if (f.kind === 'b') snap[f.col] = v ? 'Yes' : 'No';
    else snap[f.col] = v ?? '';
  }
  return snap;
}

/** Adds display helpers (parent name, group name, ...) used by list screens. */
function decorateWith(d, row, maps) {
  const out = { ...row, _key: d.table, _display: row[d.nameCol] };
  for (const f of d.fields) {
    if (f.kind === 'r' && row[f.col]) out[`${f.col}_name`] = refLabel(maps, f, row[f.col]);
  }
  return out;
}

export async function decorate(d, row) {
  const maps = await refNameMaps(d, [row]);
  return decorateWith(d, row, maps);
}

export async function listMasters(key, companyId, { search = '', includeInactive = false } = {}) {
  const d = def(key);
  const where = ['company_id = ?'];
  const params = [companyId];
  if (!includeInactive) where.push('is_inactive = 0');
  if (search) {
    where.push(`${d.nameCol} LIKE ?`);
    params.push(`%${search}%`);
  }
  const rows = await all(
    `SELECT * FROM ${d.table} WHERE ${where.join(' AND ')} ORDER BY ${d.nameCol}`,
    params,
  );
  const maps = await refNameMaps(d, rows);
  return rows.map((row) => decorateWith(d, row, maps));
}

export async function getMaster(key, companyId, id) {
  const d = def(key);
  const row = await get(`SELECT * FROM ${d.table} WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!row) throw notFound(`${d.label} not found`);
  return decorate(d, row);
}

export async function findByName(key, companyId, name) {
  const d = def(key);
  const row = await get(
    `SELECT * FROM ${d.table} WHERE company_id = ? AND ${d.nameCol} = ?`,
    [companyId, name],
  );
  return row ? decorate(d, row) : null;
}

async function assertUniqueName(d, companyId, name, excludeId) {
  const row = await get(
    `SELECT id FROM ${d.table} WHERE company_id = ? AND ${d.nameCol} = ?`,
    [companyId, name],
  );
  if (row && row.id !== excludeId) {
    throw conflict(`${d.label} "${name}" already exists`);
  }
}

async function assertNoCycle(d, id, parentId) {
  if (!d.parentCol || !parentId) return;
  let cur = parentId;
  const seen = new Set();
  while (cur) {
    if (cur === id) throw badRequest('A master cannot be placed under itself');
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = await get(`SELECT ${d.parentCol} AS p FROM ${d.table} WHERE id = ?`, [cur]);
    cur = row ? row.p : null;
  }
}

export async function createMaster(key, companyId, body, actor) {
  const d = def(key);
  const data = coerce(d, body, null);
  const name = toStr(data[d.nameCol]).trim();
  if (!name) throw badRequest(`${d.label} name is required`);
  data[d.nameCol] = name;
  await assertUniqueName(d, companyId, name);

  return transaction(async () => {
    const id = await insert(d.table, { ...data, company_id: companyId });
    const row = await get(`SELECT * FROM ${d.table} WHERE id = ?`, [id]);
    await logChange({
      companyId,
      entityType: key,
      entityKind: 'Master',
      entityId: id,
      entityName: name,
      entityLabel: `${d.label}: ${name}`,
      action: 'Created',
      before: null,
      after: await snapshot(d, row),
      user: actor,
    });
    return decorate(d, row);
  });
}

export async function updateMaster(key, companyId, id, body, actor) {
  const d = def(key);
  const row = await get(`SELECT * FROM ${d.table} WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!row) throw notFound(`${d.label} not found`);

  const data = coerce(d, body, row);
  if (data[d.nameCol] !== undefined) {
    const name = toStr(data[d.nameCol]).trim();
    if (!name) throw badRequest(`${d.label} name is required`);
    data[d.nameCol] = name;
    await assertUniqueName(d, companyId, name, id);
  }
  if (d.parentCol && data[d.parentCol] !== undefined) {
    await assertNoCycle(d, id, data[d.parentCol]);
  }
  if (row.is_reserved && data[d.nameCol] && data[d.nameCol] !== row[d.nameCol]) {
    throw badRequest(`"${row[d.nameCol]}" is a reserved ${d.label.toLowerCase()} and cannot be renamed`);
  }

  const before = await snapshot(d, row);
  return transaction(async () => {
    await update(d.table, id, data);
    const after = await get(`SELECT * FROM ${d.table} WHERE id = ?`, [id]);
    await logChange({
      companyId,
      entityType: key,
      entityKind: 'Master',
      entityId: id,
      entityName: after[d.nameCol],
      entityLabel: `${d.label}: ${after[d.nameCol]}`,
      action: 'Altered',
      before,
      after: await snapshot(d, after),
      user: actor,
    });
    return decorate(d, after);
  });
}

export async function deleteMaster(key, companyId, id, actor) {
  const d = def(key);
  const row = await get(`SELECT * FROM ${d.table} WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!row) throw notFound(`${d.label} not found`);
  if (row.is_reserved) {
    throw badRequest(`"${row[d.nameCol]}" is a reserved ${d.label.toLowerCase()} and cannot be deleted`);
  }
  for (const [table, col, what] of USAGE[d.table] || []) {
    const used = await get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, [id]);
    if (used && used.c > 0) {
      throw conflict(`Cannot delete - this ${d.label.toLowerCase()} is used by ${used.c} ${what}(s)`);
    }
  }

  const before = await snapshot(d, row);
  return transaction(async () => {
    await logChange({
      companyId,
      entityType: key,
      entityKind: 'Master',
      entityId: id,
      entityName: row[d.nameCol],
      entityLabel: `${d.label}: ${row[d.nameCol]}`,
      action: 'Deleted',
      before,
      after: before,
      user: actor,
    });
    await run(`DELETE FROM ${d.table} WHERE id = ?`, [id]);
    return { deleted: true, id };
  });
}

export function masterHistory(key, companyId, id) {
  return historyFor(companyId, key, id);
}

/** Chart of Accounts style counts for the "List of Masters" screen. */
export async function masterCounts(companyId) {
  const counts = {};
  for (const [key, d] of Object.entries(MASTERS)) {
    const row = await get(`SELECT COUNT(*) AS c FROM ${d.table} WHERE company_id = ?`, [companyId]);
    counts[key] = row ? row.c : 0;
  }
  return counts;
}
