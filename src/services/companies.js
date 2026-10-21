import { all, get, insert, update, run, transaction } from '../db/index.js';
import { COMPANY_CASCADE } from '../db/schema.js';
import { seedCompanyDefaults } from '../db/seed.js';
import { logChange } from '../lib/editlog.js';
import { badRequest, notFound, toNum, toBool, toStr } from '../lib/http.js';

const COMPANY_FIELDS = [
  'name', 'mailing_name', 'address', 'state', 'country', 'pincode', 'phone',
  'mobile', 'email', 'website', 'financial_year_from', 'books_begin_from',
  'base_currency', 'currency_name', 'decimal_places', 'gstin',
  'gst_registration_type', 'pan', 'cin', 'tan', 'maintain',
  'edit_log_enabled', 'gst_enabled', 'tds_enabled',
];

const BOOL_FIELDS = new Set(['edit_log_enabled', 'gst_enabled', 'tds_enabled']);
const NUM_FIELDS = new Set(['decimal_places']);

function coerce(body, existing) {
  const out = {};
  for (const f of COMPANY_FIELDS) {
    if (body[f] === undefined) {
      if (existing) continue;
      continue;
    }
    if (NUM_FIELDS.has(f)) out[f] = toNum(body[f], 2);
    else if (BOOL_FIELDS.has(f)) out[f] = toBool(body[f], 1);
    else out[f] = toStr(body[f]);
  }
  return out;
}

export function listCompanies() {
  return all('SELECT * FROM companies ORDER BY name');
}

export async function getCompany(id) {
  const row = await get('SELECT * FROM companies WHERE id = ?', [id]);
  if (!row) throw notFound('Company not found');
  return row;
}

export async function createCompany(body, actor) {
  const data = coerce(body, null);
  if (!toStr(data.name).trim()) throw badRequest('Company name is required');
  data.name = data.name.trim();
  if (await get('SELECT id FROM companies WHERE name = ?', [data.name])) {
    throw badRequest(`Company "${data.name}" already exists`);
  }
  const fyFrom = data.financial_year_from || defaultFinancialYear();
  data.financial_year_from = fyFrom;
  data.books_begin_from = data.books_begin_from || fyFrom;
  data.mailing_name = data.mailing_name || data.name;
  data.base_currency = data.base_currency || 'Rs.';
  data.currency_name = data.currency_name || 'INR';
  data.decimal_places = data.decimal_places ?? 2;
  data.edit_log_enabled = data.edit_log_enabled ?? 1;

  return transaction(async () => {
    const id = await insert('companies', data);
    await seedCompanyDefaults(id, { ...data, id });
    const row = await getCompany(id);
    await logChange({
      companyId: id,
      entityType: 'company',
      entityKind: 'Master',
      entityId: id,
      entityName: row.name,
      entityLabel: `Company: ${row.name}`,
      action: 'Created',
      before: null,
      after: companySnapshot(row),
      user: actor,
    });
    return row;
  });
}

export async function updateCompany(id, body, actor) {
  const row = await getCompany(id);
  const data = coerce(body, row);
  const before = companySnapshot(row);
  return transaction(async () => {
    await update('companies', id, data);
    const after = await getCompany(id);
    await logChange({
      companyId: id,
      entityType: 'company',
      entityKind: 'Master',
      entityId: id,
      entityName: after.name,
      entityLabel: `Company: ${after.name}`,
      action: 'Altered',
      before,
      after: companySnapshot(after),
      user: actor,
    });
    return after;
  });
}

export async function deleteCompany(id, actor) {
  const row = await getCompany(id);
  // The log entry is written first; the cascade then clears it with the rest
  // of the company's rows, so no orphaned audit trail is left behind.
  return transaction(async () => {
    await logChange({
      companyId: id,
      entityType: 'company',
      entityKind: 'Master',
      entityId: id,
      entityName: row.name,
      entityLabel: `Company: ${row.name}`,
      action: 'Deleted',
      before: companySnapshot(row),
      after: companySnapshot(row),
      user: actor,
    });
    for (const statement of COMPANY_CASCADE) {
      await run(statement, [id]);
    }
    return { deleted: true, id };
  });
}

function companySnapshot(row) {
  const snap = {};
  for (const f of COMPANY_FIELDS) {
    snap[f] = BOOL_FIELDS.has(f) ? (row[f] ? 'Yes' : 'No') : row[f] ?? '';
  }
  return snap;
}

/** 1 April of the current Indian financial year. */
export function defaultFinancialYear(today = new Date()) {
  const y = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;
  return `${y}-04-01`;
}

export function financialYearEnd(from) {
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate() - 1);
  return localDate(end);
}

/** `toISOString` would shift the day in any timezone east of UTC. */
function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
