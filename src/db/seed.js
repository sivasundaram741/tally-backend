import { insert, findOne, exists, update } from './index.js';

/**
 * The 28 groups every new company starts with.
 * `parent` is null for the 15 primary groups.
 */
export const DEFAULT_GROUPS = [
  // --- primary groups -------------------------------------------------------
  { name: 'Branch / Divisions',      parent: null, nature: 'Liabilities', primary: 1, dp: 1, sort: 10 },
  { name: 'Capital Account',         parent: null, nature: 'Liabilities', primary: 1, dp: 0, sort: 20 },
  { name: 'Current Assets',          parent: null, nature: 'Assets',      primary: 1, dp: 1, sort: 30 },
  { name: 'Current Liabilities',     parent: null, nature: 'Liabilities', primary: 1, dp: 0, sort: 40 },
  { name: 'Direct Expenses',         parent: null, nature: 'Expenses',    primary: 1, dp: 1, sort: 50, gp: 1 },
  { name: 'Direct Incomes',          parent: null, nature: 'Income',      primary: 1, dp: 0, sort: 60, gp: 1 },
  { name: 'Fixed Assets',            parent: null, nature: 'Assets',      primary: 1, dp: 1, sort: 70 },
  { name: 'Indirect Expenses',       parent: null, nature: 'Expenses',    primary: 1, dp: 1, sort: 80 },
  { name: 'Indirect Incomes',        parent: null, nature: 'Income',      primary: 1, dp: 0, sort: 90 },
  { name: 'Investments',             parent: null, nature: 'Assets',      primary: 1, dp: 1, sort: 100 },
  { name: 'Loans (Liability)',       parent: null, nature: 'Liabilities', primary: 1, dp: 0, sort: 110 },
  { name: 'Misc. Expenses (ASSET)',  parent: null, nature: 'Assets',      primary: 1, dp: 1, sort: 120 },
  { name: 'Purchase Accounts',       parent: null, nature: 'Expenses',    primary: 1, dp: 1, sort: 130, gp: 1 },
  { name: 'Sales Accounts',          parent: null, nature: 'Income',      primary: 1, dp: 0, sort: 140, gp: 1 },
  { name: 'Suspense A/c',            parent: null, nature: 'Liabilities', primary: 1, dp: 0, sort: 150 },
  // --- sub groups -----------------------------------------------------------
  { name: 'Bank Accounts',               parent: 'Current Assets',      nature: 'Assets',      dp: 1, sort: 31 },
  { name: 'Bank OD A/c',                 parent: 'Loans (Liability)',   nature: 'Liabilities', dp: 0, sort: 111, alias: 'Bank OCC A/c' },
  { name: 'Cash-in-Hand',                parent: 'Current Assets',      nature: 'Assets',      dp: 1, sort: 32 },
  { name: 'Deposits (Asset)',            parent: 'Current Assets',      nature: 'Assets',      dp: 1, sort: 33 },
  { name: 'Duties & Taxes',              parent: 'Current Liabilities', nature: 'Liabilities', dp: 0, sort: 41 },
  { name: 'Loans & Advances (Asset)',    parent: 'Current Assets',      nature: 'Assets',      dp: 1, sort: 34 },
  { name: 'Provisions',                  parent: 'Current Liabilities', nature: 'Liabilities', dp: 0, sort: 42 },
  { name: 'Reserves & Surplus',          parent: 'Capital Account',     nature: 'Liabilities', dp: 0, sort: 21, alias: 'Retained Earnings' },
  { name: 'Secured Loans',               parent: 'Loans (Liability)',   nature: 'Liabilities', dp: 0, sort: 112 },
  { name: 'Stock-in-Hand',               parent: 'Current Assets',      nature: 'Assets',      dp: 1, sort: 35 },
  { name: 'Sundry Creditors',            parent: 'Current Liabilities', nature: 'Liabilities', dp: 0, sort: 43 },
  { name: 'Sundry Debtors',              parent: 'Current Assets',      nature: 'Assets',      dp: 1, sort: 36 },
  { name: 'Unsecured Loans',             parent: 'Loans (Liability)',   nature: 'Liabilities', dp: 0, sort: 113 },
];

/** The predefined voucher types, with their F-key shortcuts. */
export const DEFAULT_VOUCHER_TYPES = [
  { name: 'Contra',             parent: 'Contra',             abbr: 'Ctra', stock: 0, sort: 10 },
  { name: 'Payment',            parent: 'Payment',            abbr: 'Pymt', stock: 0, sort: 20 },
  { name: 'Receipt',            parent: 'Receipt',            abbr: 'Rcpt', stock: 0, sort: 30 },
  { name: 'Journal',            parent: 'Journal',            abbr: 'Jrnl', stock: 0, sort: 40 },
  { name: 'Sales',              parent: 'Sales',              abbr: 'Sale', stock: 1, sort: 50 },
  { name: 'Credit Note',        parent: 'Credit Note',        abbr: 'C/Nt', stock: 1, sort: 60 },
  { name: 'Purchase',           parent: 'Purchase',           abbr: 'Purc', stock: 1, sort: 70 },
  { name: 'Debit Note',         parent: 'Debit Note',         abbr: 'D/Nt', stock: 1, sort: 80 },
  { name: 'Reversing Journal',  parent: 'Reversing Journal',  abbr: 'Rev',  stock: 0, sort: 90 },
  { name: 'Memorandum',         parent: 'Memorandum',         abbr: 'Memo', stock: 0, sort: 100 },
  { name: 'Sales Order',        parent: 'Sales Order',        abbr: 'SOrd', stock: 1, sort: 110 },
  { name: 'Purchase Order',     parent: 'Purchase Order',     abbr: 'POrd', stock: 1, sort: 120 },
  { name: 'Delivery Note',      parent: 'Delivery Note',      abbr: 'DNot', stock: 1, sort: 130 },
  { name: 'Receipt Note',       parent: 'Receipt Note',       abbr: 'RcptNote', stock: 1, sort: 140 },
  { name: 'Rejections In',      parent: 'Rejections In',      abbr: 'RejIn', stock: 1, sort: 150 },
  { name: 'Rejections Out',     parent: 'Rejections Out',     abbr: 'RejOut', stock: 1, sort: 160 },
  { name: 'Stock Journal',      parent: 'Stock Journal',      abbr: 'StkJrnl', stock: 1, sort: 170 },
  { name: 'Physical Stock',     parent: 'Physical Stock',     abbr: 'PhysStk', stock: 1, sort: 180 },
  { name: 'Material In',        parent: 'Material In',        abbr: 'MatIn', stock: 1, sort: 190 },
  { name: 'Material Out',       parent: 'Material Out',       abbr: 'MatOut', stock: 1, sort: 200 },
  { name: 'Job Work In Order',  parent: 'Job Work In Order',  abbr: 'JWIn', stock: 1, sort: 210 },
  { name: 'Job Work Out Order', parent: 'Job Work Out Order', abbr: 'JWOut', stock: 1, sort: 220 },
  { name: 'Payroll',            parent: 'Payroll',            abbr: 'Pyrl', stock: 0, sort: 230 },
  { name: 'Attendance',         parent: 'Attendance',         abbr: 'Attd', stock: 0, sort: 240 },
];

/** Creates the reserved masters a brand-new company starts with. */
export async function seedCompanyDefaults(companyId, company) {
  const ids = {};
  for (const g of DEFAULT_GROUPS) {
    ids[g.name] = await insert('groups', {
      company_id: companyId,
      name: g.name,
      alias: g.alias || '',
      parent_id: g.parent ? ids[g.parent] : null,
      nature: g.nature,
      is_primary: g.primary || 0,
      is_reserved: 1,
      affects_gross_profit: g.gp || 0,
      is_deemed_positive: g.dp,
      sort_position: g.sort,
    });
  }

  for (const vt of DEFAULT_VOUCHER_TYPES) {
    await insert('voucher_types', {
      company_id: companyId,
      name: vt.name,
      parent_type: vt.parent,
      abbreviation: vt.abbr,
      numbering_method: 'Automatic',
      is_reserved: 1,
      affects_stock: vt.stock,
      sort_position: vt.sort,
    });
  }

  await insert('currencies', {
    company_id: companyId,
    symbol: company.base_currency || 'Rs.',
    formal_name: company.currency_name || 'INR',
    decimal_places: company.decimal_places ?? 2,
    is_base: 1,
    amount_in_words: 'Rupees',
    decimal_words: 'paise',
  });

  await insert('godowns', {
    company_id: companyId,
    name: 'Main Location',
    is_primary: 1,
    allow_storage: 1,
  });

  await insert('stock_groups', {
    company_id: companyId,
    name: 'Primary',
    is_primary: 1,
  });

  await insert('ledgers', {
    company_id: companyId,
    name: 'Cash',
    group_id: ids['Cash-in-Hand'],
    is_reserved: 1,
    opening_balance_type: 'Dr',
  });

  await insert('ledgers', {
    company_id: companyId,
    name: 'Profit & Loss A/c',
    group_id: ids['Capital Account'],
    is_reserved: 1,
    opening_balance_type: 'Cr',
  });

  if (company.gstin || company.gst_enabled) {
    await insert('gst_registrations', {
      company_id: companyId,
      name: company.state ? `${company.state} - Regular` : 'Primary Registration',
      state: company.state || '',
      registration_type: company.gst_registration_type || 'Regular',
      gstin: company.gstin || '',
      applicable_from: company.books_begin_from,
      is_default: 1,
    });
  }

  return ids;
}

/** Ensures at least one administrator exists. */
export async function seedAdminUser() {
  const existing = await findOne('users', {}, { sort: { id: 1 }, project: { id: 1 } });
  if (existing) {
    // Databases created before the rename hold the old salt; re-stamp the
    // untouched factory password so signing in still works.
    const admin = await findOne('users', { username: 'admin' }, { project: { id: 1, password_hash: 1 } });
    if (admin && admin.password_hash === hashPassword('admin', 'tally')) {
      await update('users', admin.id, { password_hash: hashPassword('admin') });
    }
    return existing.id;
  }
  return insert('users', {
    username: 'admin',
    full_name: 'Administrator',
    password_hash: hashPassword('admin'),
    security_level: 'Owner',
  });
}

export function hashPassword(pwd, salt = 'ledgertrail') {
  // Lightweight, dependency-free digest. Adequate for a local/offline app.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const salted = `${salt}::${pwd}`;
  for (let i = 0; i < salted.length; i++) {
    h1 ^= salted.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ salted.charCodeAt(i), 0x85ebca6b) + i) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function listDefaultGroupNames() {
  return DEFAULT_GROUPS.map((g) => g.name);
}

export function companyHasData(companyId) {
  return exists('vouchers', { company_id: companyId });
}
