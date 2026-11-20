/**
 * MongoDB schema for the application. MongoDB itself is schemaless, so the
 * rules SQL Server used to enforce live here and are applied by the helpers in
 * db/index.js on every write:
 *
 *  - each field's default (filled in when an insert leaves it out)
 *  - REQUIRED fields, which must be present and non-null
 *  - nullability: a field whose default is `null` may hold null; any other
 *    field may not
 *  - unknown fields are rejected, so a typo cannot silently store data
 *
 * Every collection is created with a case-insensitive collation, matching the
 * SQL Server database: names compare, sort and stay unique without regard to
 * case. Rows keep their numeric `id` (the API and the UI use it everywhere);
 * MongoDB's own `_id` is never exposed.
 *
 * Dates are kept as `yyyy-mm-dd` strings and timestamps as
 * `yyyy-mm-dd hh:mm:ss` strings: the reports compare and sort them as text.
 */

export const REQUIRED = Symbol('required');

/** Local time as `yyyy-mm-dd hh:mm:ss`, like SQL Server's GETDATE() style 120. */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const NOW = () => localStamp();

/** Case-insensitive, accent-sensitive - the SQL Server default (CI_AS). */
export const COLLATION = { locale: 'en', strength: 2 };

/** Fields shared by every per-company master. */
const company = { company_id: REQUIRED };

export const COLLECTIONS = {
  // ------------------------------ users ------------------------------------
  users: {
    fields: {
      username: REQUIRED,
      full_name: '',
      password_hash: REQUIRED,
      security_level: 'Owner',
      is_active: 1,
      created_at: NOW,
    },
    unique: [['username']],
  },

  sessions: {
    noId: true, // keyed by token
    fields: {
      token: REQUIRED,
      user_id: REQUIRED,
      created_at: NOW,
      expires_at: REQUIRED,
    },
    unique: [['token']],
  },

  // ---------------------------- companies ----------------------------------
  companies: {
    fields: {
      name: REQUIRED,
      mailing_name: '',
      address: '',
      state: '',
      country: 'India',
      pincode: '',
      phone: '',
      mobile: '',
      email: '',
      website: '',
      financial_year_from: REQUIRED,
      books_begin_from: REQUIRED,
      base_currency: 'Rs.',
      currency_name: 'INR',
      decimal_places: 2,
      gstin: '',
      gst_registration_type: 'Regular',
      pan: '',
      cin: '',
      tan: '',
      maintain: 'Accounts with Inventory',
      edit_log_enabled: 1,
      gst_enabled: 1,
      tds_enabled: 0,
      is_active: 1,
      created_at: NOW,
    },
    unique: [['name']],
  },

  // ------------------------ accounting masters -----------------------------
  groups: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      parent_id: null,
      nature: 'Assets',
      is_primary: 0,
      is_reserved: 0,
      affects_gross_profit: 0,
      is_deemed_positive: 1,
      net_debit_credit: 0,
      used_for_calculation: 0,
      sort_position: 1000,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  currencies: {
    fields: {
      ...company,
      symbol: REQUIRED,
      formal_name: '',
      decimal_places: 2,
      is_base: 0,
      suffix_symbol: 0,
      space_between: 1,
      amount_in_words: 'Rupees',
      decimal_words: 'paise',
      is_inactive: 0,
    },
    unique: [['company_id', 'symbol']],
  },

  cost_categories: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      allocate_revenue: 1,
      allocate_non_revenue: 0,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  cost_centres: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      category_id: null,
      parent_id: null,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  budgets: {
    fields: {
      ...company,
      name: REQUIRED,
      parent_id: null,
      period_from: '',
      period_to: '',
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  scenarios: {
    fields: {
      ...company,
      name: REQUIRED,
      include_types: '',
      exclude_types: '',
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  voucher_types: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      parent_type: REQUIRED,
      abbreviation: '',
      numbering_method: 'Automatic',
      restart_numbering: 'Yearly',
      prefix: '',
      suffix: '',
      starting_number: 1,
      is_reserved: 0,
      use_common_narration: 1,
      narration_per_entry: 0,
      print_after_saving: 0,
      is_optional_default: 0,
      affects_stock: 0,
      allow_zero_valued: 0,
      sort_position: 1000,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  // ------------------------- inventory masters -----------------------------
  stock_groups: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      parent_id: null,
      is_primary: 0,
      quantities_added: 1,
      hsn_sac: '',
      tax_rate: 0,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  stock_categories: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      parent_id: null,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  units: {
    fields: {
      ...company,
      symbol: REQUIRED,
      formal_name: '',
      unit_type: 'Simple',
      decimal_places: 0,
      base_unit_id: null,
      additional_unit_id: null,
      conversion: 1,
      is_inactive: 0,
    },
    unique: [['company_id', 'symbol']],
  },

  godowns: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      parent_id: null,
      address: '',
      is_primary: 0,
      allow_storage: 1,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  ledgers: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      group_id: REQUIRED,
      opening_balance: 0,
      opening_balance_type: 'Dr',
      is_reserved: 0,
      mailing_name: '',
      address: '',
      state: '',
      country: 'India',
      pincode: '',
      phone: '',
      email: '',
      contact_person: '',
      pan: '',
      gstin: '',
      registration_type: 'Unregistered',
      gst_applicable: 'Not Applicable',
      hsn_sac: '',
      tax_type: '',
      tax_rate: 0,
      bank_account_no: '',
      bank_ifsc: '',
      bank_name: '',
      bank_branch: '',
      is_bill_wise: 0,
      is_cost_centre: 0,
      inventory_affected: 0,
      credit_period_days: 0,
      credit_limit: 0,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
    indexes: [['group_id']],
  },

  stock_items: {
    fields: {
      ...company,
      name: REQUIRED,
      alias: '',
      part_number: '',
      stock_group_id: null,
      category_id: null,
      unit_id: null,
      opening_qty: 0,
      opening_rate: 0,
      opening_value: 0,
      gst_applicable: 'Applicable',
      hsn_sac: '',
      taxability: 'Taxable',
      tax_rate: 0,
      cess_rate: 0,
      standard_cost: 0,
      standard_price: 0,
      costing_method: 'Avg. Cost',
      maintain_batches: 0,
      reorder_level: 0,
      min_order_qty: 0,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  // ------------------------- statutory masters -----------------------------
  gst_registrations: {
    fields: {
      ...company,
      name: REQUIRED,
      state: '',
      registration_type: 'Regular',
      gstin: '',
      applicable_from: '',
      periodicity: 'Monthly',
      is_default: 0,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  gst_classifications: {
    fields: {
      ...company,
      name: REQUIRED,
      hsn_sac: '',
      description: '',
      taxability: 'Taxable',
      tax_rate: 0,
      cess_rate: 0,
      applicable_from: '',
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  tds_natures: {
    fields: {
      ...company,
      name: REQUIRED,
      section: '',
      payment_code: '',
      rate_individual: 0,
      rate_company: 0,
      rate_no_pan: 20,
      threshold: 0,
      is_inactive: 0,
    },
    unique: [['company_id', 'name']],
  },

  // ------------------------------ vouchers ---------------------------------
  // Ledger entries, inventory lines and bill allocations are embedded in the
  // voucher (see CHILDREN), so a voucher and its lines are always written in
  // one atomic step.
  vouchers: {
    fields: {
      ...company,
      voucher_type_id: REQUIRED,
      voucher_number: '',
      date: REQUIRED,
      reference_no: '',
      reference_date: '',
      party_ledger_id: null,
      narration: '',
      place_of_supply: '',
      mode: 'Item Invoice',
      is_invoice: 0,
      is_cancelled: 0,
      is_optional: 0,
      is_post_dated: 0,
      is_deleted: 0,
      total_amount: 0,
      version_no: 1,
      created_at: NOW,
      created_by: '',
      altered_at: null,
      altered_by: null,
      entries: () => [],
      inventory: () => [],
      bills: () => [],
    },
    indexes: [
      ['company_id', 'date'],
      ['voucher_type_id'],
      ['entries.ledger_id'],
      ['entries.cost_centre_id'],
      ['inventory.stock_item_id'],
      ['bills.ledger_id'],
      ['party_ledger_id'],
    ],
  },

  // ------------------------------ edit log ---------------------------------
  // `snapshot` and `changes` are stored as real documents/arrays (SQL Server
  // kept them as JSON text).
  edit_log: {
    fields: {
      ...company,
      entity_type: REQUIRED,
      entity_kind: REQUIRED,
      entity_id: REQUIRED,
      entity_name: '',
      entity_label: '',
      action: REQUIRED,
      version_no: 1,
      user_id: null,
      username: '',
      machine: '',
      ip_address: '',
      logged_at: NOW,
      voucher_date: '',
      voucher_type: '',
      voucher_number: '',
      amount: 0,
      snapshot: () => ({}),
      changes: () => [],
    },
    indexes: [
      ['company_id', 'entity_type', 'entity_id'],
      ['company_id', 'logged_at'],
    ],
  },
};

/**
 * Line items embedded in a voucher. `counter` names the id sequence each kind
 * draws from, so line ids stay unique and stable (backups and the ledger
 * statement refer to them).
 */
export const CHILDREN = {
  entries: {
    counter: 'voucher_entries',
    fields: {
      line_no: 0,
      ledger_id: REQUIRED,
      dr_cr: REQUIRED,
      amount: 0,
      cost_centre_id: null,
      narration: '',
    },
  },
  inventory: {
    counter: 'voucher_inventory',
    fields: {
      line_no: 0,
      stock_item_id: REQUIRED,
      godown_id: null,
      batch: '',
      quantity: 0,
      unit_id: null,
      rate: 0,
      discount_pct: 0,
      amount: 0,
      direction: 'In',
    },
  },
  bills: {
    counter: 'bill_allocations',
    fields: {
      entry_id: null,
      ledger_id: REQUIRED,
      bill_name: '',
      bill_type: 'New Ref',
      amount: 0,
      dr_cr: 'Dr',
      due_date: '',
    },
  },
};

/** The table names the embedded lines had in SQL Server (and still have in backups). */
export const CHILD_TABLES = {
  voucher_entries: 'entries',
  voucher_inventory: 'inventory',
  bill_allocations: 'bills',
};

/** Every collection that holds rows belonging to one company. */
export const COMPANY_COLLECTIONS = Object.entries(COLLECTIONS)
  .filter(([, spec]) => 'company_id' in spec.fields)
  .map(([name]) => name);
