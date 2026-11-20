import { insert, find, findOne } from '../db/index.js';

/**
 * Human readable captions for master/voucher fields, so the Edit Log reads
 * readably ("Under", "Opening Balance", ...).
 */
export const FIELD_LABELS = {
  name: 'Name',
  alias: 'Alias',
  parent_id: 'Under',
  group_id: 'Under',
  stock_group_id: 'Under',
  category_id: 'Category',
  unit_id: 'Units',
  nature: 'Nature of Group',
  opening_balance: 'Opening Balance',
  opening_balance_type: 'Opening Balance Dr/Cr',
  opening_qty: 'Opening Quantity',
  opening_rate: 'Opening Rate',
  opening_value: 'Opening Value',
  mailing_name: 'Mailing Name',
  address: 'Address',
  state: 'State',
  country: 'Country',
  pincode: 'Pincode',
  phone: 'Phone',
  email: 'E-Mail',
  contact_person: 'Contact Person',
  pan: 'PAN/IT No.',
  gstin: 'GSTIN/UIN',
  registration_type: 'Registration Type',
  gst_applicable: 'GST Applicability',
  hsn_sac: 'HSN/SAC',
  tax_type: 'Type of Duty/Tax',
  tax_rate: 'Tax Rate',
  cess_rate: 'Cess Rate',
  taxability: 'Taxability',
  bank_account_no: 'A/c No.',
  bank_ifsc: 'IFS Code',
  bank_name: 'Bank Name',
  bank_branch: 'Branch',
  is_bill_wise: 'Maintain balances bill-by-bill',
  is_cost_centre: 'Cost centres are applicable',
  credit_period_days: 'Credit Period',
  credit_limit: 'Credit Limit',
  is_inactive: 'Is Inactive',
  symbol: 'Symbol',
  formal_name: 'Formal Name',
  decimal_places: 'Number of Decimal Places',
  unit_type: 'Type',
  conversion: 'Conversion',
  parent_type: 'Type of Voucher',
  abbreviation: 'Abbreviation',
  numbering_method: 'Method of Voucher Numbering',
  affects_stock: 'Affects Stock',
  standard_cost: 'Standard Cost',
  standard_price: 'Standard Price',
  costing_method: 'Costing Method',
  reorder_level: 'Re-order Level',
  part_number: 'Part No.',
  // voucher fields
  date: 'Date',
  voucher_number: 'Voucher No.',
  reference_no: 'Reference No.',
  reference_date: 'Reference Date',
  narration: 'Narration',
  party_ledger_id: 'Party A/c Name',
  place_of_supply: 'Place of Supply',
  total_amount: 'Amount',
  is_optional: 'Optional',
  is_post_dated: 'Post-Dated',
  is_cancelled: 'Cancelled',
  mode: 'Mode',
  entries: 'Ledger Entries',
  inventory: 'Inventory Entries',
  bills: 'Bill-wise Details',
};

/** Fields that never belong in a diff. */
const IGNORED = new Set([
  'id', 'company_id', 'version_no', 'created_at', 'created_by',
  'altered_at', 'altered_by', 'is_reserved', 'sort_position', 'is_deleted',
]);

function label(field) {
  return FIELD_LABELS[field] || toTitle(field);
}

function toTitle(s) {
  return String(s)
    .replace(/_id$/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isEqual(a, b) {
  if (a === b) return true;
  if (a == null && (b === '' || b == null)) return true;
  if (b == null && (a === '' || a == null)) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 0.0000001;
  }
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === 'object' && typeof b === 'object' && a && b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a ?? '') === String(b ?? '');
}

/**
 * Builds the list of field level changes between two snapshots. Array valued
 * fields (ledger entries, inventory lines) are diffed row by row so the log
 * can show "Ledger Entries > Line 2 > Amount" style detail.
 */
export function diffSnapshots(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;

    if (Array.isArray(a) || Array.isArray(b)) {
      const arrA = Array.isArray(a) ? a : [];
      const arrB = Array.isArray(b) ? b : [];
      const len = Math.max(arrA.length, arrB.length);
      for (let i = 0; i < len; i++) {
        const rowA = arrA[i];
        const rowB = arrB[i];
        if (!rowA && rowB) {
          changes.push({
            field: `${label(key)} > Line ${i + 1}`,
            from: '',
            to: describeRow(rowB),
            kind: 'added',
          });
        } else if (rowA && !rowB) {
          changes.push({
            field: `${label(key)} > Line ${i + 1}`,
            from: describeRow(rowA),
            to: '',
            kind: 'removed',
          });
        } else if (rowA && rowB) {
          for (const sub of new Set([...Object.keys(rowA), ...Object.keys(rowB)])) {
            if (IGNORED.has(sub) || sub === 'voucher_id' || sub === 'entry_id' || sub === 'line_no') continue;
            if (!isEqual(rowA[sub], rowB[sub])) {
              changes.push({
                field: `${label(key)} > Line ${i + 1} > ${label(sub)}`,
                from: fmt(rowA[sub]),
                to: fmt(rowB[sub]),
                kind: 'modified',
              });
            }
          }
        }
      }
      continue;
    }

    if (!isEqual(a, b)) {
      changes.push({
        field: label(key),
        from: fmt(a),
        to: fmt(b),
        kind: before == null ? 'added' : 'modified',
      });
    }
  }
  return changes;
}

function describeRow(row) {
  if (!row) return '';
  const parts = [];
  for (const [k, v] of Object.entries(row)) {
    if (IGNORED.has(k) || k === 'voucher_id' || k === 'entry_id' || k === 'line_no') continue;
    if (v === '' || v == null) continue;
    parts.push(`${label(k)}: ${fmt(v)}`);
  }
  return parts.join(', ');
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

/** Next version number for an entity. */
export async function nextVersion(companyId, entityType, entityId) {
  const row = await findOne(
    'edit_log',
    { company_id: companyId, entity_type: entityType, entity_id: entityId },
    { sort: { version_no: -1 }, project: { version_no: 1 } },
  );
  return (row && row.version_no ? Number(row.version_no) : 0) + 1;
}

/**
 * Writes one Edit Log entry. Returns the stored row id.
 *
 * @param {object} o
 * @param {number} o.companyId
 * @param {string} o.entityType   table-ish key, e.g. 'ledger', 'voucher'
 * @param {string} o.entityKind   'Master' | 'Voucher'
 * @param {number} o.entityId
 * @param {string} o.entityName
 * @param {string} [o.entityLabel]
 * @param {'Created'|'Altered'|'Deleted'|'Cancelled'|'Restored'} o.action
 * @param {object|null} o.before
 * @param {object|null} o.after
 * @param {object} [o.user]
 * @param {object} [o.meta]  voucher_date / voucher_type / voucher_number / amount
 */
export async function logChange(o) {
  const changes = o.action === 'Created'
    ? diffSnapshots({}, o.after || {})
    : diffSnapshots(o.before || {}, o.after || o.before || {});

  const version = await nextVersion(o.companyId, o.entityType, o.entityId);
  const meta = o.meta || {};

  return insert('edit_log', {
    company_id: o.companyId,
    entity_type: o.entityType,
    entity_kind: o.entityKind || 'Master',
    entity_id: o.entityId,
    entity_name: o.entityName || '',
    entity_label: o.entityLabel || o.entityName || '',
    action: o.action,
    version_no: version,
    user_id: o.user?.id ?? null,
    username: o.user?.username || 'admin',
    machine: o.user?.machine || 'WEB',
    ip_address: o.user?.ip || '',
    logged_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    voucher_date: meta.date || '',
    voucher_type: meta.voucherType || '',
    voucher_number: meta.voucherNumber || '',
    amount: meta.amount || 0,
    snapshot: o.after ?? o.before ?? {},
    changes,
  });
}

/** Full version history for one entity, oldest first. */
export async function historyFor(companyId, entityType, entityId) {
  const rows = await find(
    'edit_log',
    { company_id: companyId, entity_type: String(entityType), entity_id: entityId },
    { sort: { version_no: 1, id: 1 } },
  );
  return rows.map(hydrate);
}

/** Snapshots are stored as documents; rows restored from old backups may hold JSON text. */
export function hydrate(row) {
  return {
    ...row,
    snapshot: parseStored(row.snapshot, {}),
    changes: parseStored(row.changes, []),
  };
}

export function parseStored(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Compares two stored versions of the same entity. */
export async function compareVersions(companyId, entityType, entityId, vA, vB) {
  const rows = await historyFor(companyId, entityType, entityId);
  const a = rows.find((r) => r.version_no === Number(vA));
  const b = rows.find((r) => r.version_no === Number(vB));
  if (!a || !b) return null;
  return {
    left: a,
    right: b,
    changes: diffSnapshots(a.snapshot, b.snapshot),
  };
}
