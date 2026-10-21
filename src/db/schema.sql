-- ---------------------------------------------------------------------------
-- TallyPrime (Edit Log) style web application - relational schema
-- Engine: SQLite (node:sqlite)
-- ---------------------------------------------------------------------------

-- ------------------------------ Users --------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL DEFAULT '',
  password_hash   TEXT NOT NULL,
  security_level  TEXT NOT NULL DEFAULT 'Owner',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- ----------------------------- Companies -----------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  mailing_name        TEXT NOT NULL DEFAULT '',
  address             TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT '',
  country             TEXT NOT NULL DEFAULT 'India',
  pincode             TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  mobile              TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  website             TEXT NOT NULL DEFAULT '',
  financial_year_from TEXT NOT NULL,
  books_begin_from    TEXT NOT NULL,
  base_currency       TEXT NOT NULL DEFAULT 'Rs.',
  currency_name       TEXT NOT NULL DEFAULT 'INR',
  decimal_places      INTEGER NOT NULL DEFAULT 2,
  gstin               TEXT NOT NULL DEFAULT '',
  gst_registration_type TEXT NOT NULL DEFAULT 'Regular',
  pan                 TEXT NOT NULL DEFAULT '',
  cin                 TEXT NOT NULL DEFAULT '',
  tan                 TEXT NOT NULL DEFAULT '',
  maintain            TEXT NOT NULL DEFAULT 'Accounts with Inventory',
  edit_log_enabled    INTEGER NOT NULL DEFAULT 1,
  gst_enabled         INTEGER NOT NULL DEFAULT 1,
  tds_enabled         INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------- Accounting masters -------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  alias                TEXT NOT NULL DEFAULT '',
  parent_id            INTEGER REFERENCES groups(id),
  nature               TEXT NOT NULL DEFAULT 'Assets',
  is_primary           INTEGER NOT NULL DEFAULT 0,
  is_reserved          INTEGER NOT NULL DEFAULT 0,
  affects_gross_profit INTEGER NOT NULL DEFAULT 0,
  is_deemed_positive   INTEGER NOT NULL DEFAULT 1,
  net_debit_credit     INTEGER NOT NULL DEFAULT 0,
  used_for_calculation INTEGER NOT NULL DEFAULT 0,
  sort_position        INTEGER NOT NULL DEFAULT 1000,
  is_inactive          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS ledgers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  alias                TEXT NOT NULL DEFAULT '',
  group_id             INTEGER NOT NULL REFERENCES groups(id),
  opening_balance      REAL NOT NULL DEFAULT 0,
  opening_balance_type TEXT NOT NULL DEFAULT 'Dr',
  is_reserved          INTEGER NOT NULL DEFAULT 0,
  mailing_name         TEXT NOT NULL DEFAULT '',
  address              TEXT NOT NULL DEFAULT '',
  state                TEXT NOT NULL DEFAULT '',
  country              TEXT NOT NULL DEFAULT 'India',
  pincode              TEXT NOT NULL DEFAULT '',
  phone                TEXT NOT NULL DEFAULT '',
  email                TEXT NOT NULL DEFAULT '',
  contact_person       TEXT NOT NULL DEFAULT '',
  pan                  TEXT NOT NULL DEFAULT '',
  gstin                TEXT NOT NULL DEFAULT '',
  registration_type    TEXT NOT NULL DEFAULT 'Unregistered',
  gst_applicable       TEXT NOT NULL DEFAULT 'Not Applicable',
  hsn_sac              TEXT NOT NULL DEFAULT '',
  tax_type             TEXT NOT NULL DEFAULT '',
  tax_rate             REAL NOT NULL DEFAULT 0,
  bank_account_no      TEXT NOT NULL DEFAULT '',
  bank_ifsc            TEXT NOT NULL DEFAULT '',
  bank_name            TEXT NOT NULL DEFAULT '',
  bank_branch          TEXT NOT NULL DEFAULT '',
  is_bill_wise         INTEGER NOT NULL DEFAULT 0,
  is_cost_centre       INTEGER NOT NULL DEFAULT 0,
  inventory_affected   INTEGER NOT NULL DEFAULT 0,
  credit_period_days   INTEGER NOT NULL DEFAULT 0,
  credit_limit         REAL NOT NULL DEFAULT 0,
  is_inactive          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS currencies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
  formal_name     TEXT NOT NULL DEFAULT '',
  decimal_places  INTEGER NOT NULL DEFAULT 2,
  is_base         INTEGER NOT NULL DEFAULT 0,
  suffix_symbol   INTEGER NOT NULL DEFAULT 0,
  space_between   INTEGER NOT NULL DEFAULT 1,
  amount_in_words TEXT NOT NULL DEFAULT 'Rupees',
  decimal_words   TEXT NOT NULL DEFAULT 'paise',
  is_inactive     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, symbol)
);

CREATE TABLE IF NOT EXISTS cost_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  alias       TEXT NOT NULL DEFAULT '',
  allocate_revenue INTEGER NOT NULL DEFAULT 1,
  allocate_non_revenue INTEGER NOT NULL DEFAULT 0,
  is_inactive INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS cost_centres (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  alias       TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES cost_categories(id),
  parent_id   INTEGER REFERENCES cost_centres(id),
  is_inactive INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS budgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES budgets(id),
  period_from TEXT NOT NULL DEFAULT '',
  period_to   TEXT NOT NULL DEFAULT '',
  is_inactive INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS scenarios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  include_types TEXT NOT NULL DEFAULT '',
  exclude_types TEXT NOT NULL DEFAULT '',
  is_inactive   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS voucher_types (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  alias               TEXT NOT NULL DEFAULT '',
  parent_type         TEXT NOT NULL,
  abbreviation        TEXT NOT NULL DEFAULT '',
  numbering_method    TEXT NOT NULL DEFAULT 'Automatic',
  restart_numbering   TEXT NOT NULL DEFAULT 'Yearly',
  prefix              TEXT NOT NULL DEFAULT '',
  suffix              TEXT NOT NULL DEFAULT '',
  starting_number     INTEGER NOT NULL DEFAULT 1,
  is_reserved         INTEGER NOT NULL DEFAULT 0,
  use_common_narration INTEGER NOT NULL DEFAULT 1,
  narration_per_entry INTEGER NOT NULL DEFAULT 0,
  print_after_saving  INTEGER NOT NULL DEFAULT 0,
  is_optional_default INTEGER NOT NULL DEFAULT 0,
  affects_stock       INTEGER NOT NULL DEFAULT 0,
  allow_zero_valued   INTEGER NOT NULL DEFAULT 0,
  sort_position       INTEGER NOT NULL DEFAULT 1000,
  is_inactive         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

-- ------------------------- Inventory masters --------------------------------
CREATE TABLE IF NOT EXISTS stock_groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  alias         TEXT NOT NULL DEFAULT '',
  parent_id     INTEGER REFERENCES stock_groups(id),
  is_primary    INTEGER NOT NULL DEFAULT 0,
  quantities_added INTEGER NOT NULL DEFAULT 1,
  hsn_sac       TEXT NOT NULL DEFAULT '',
  tax_rate      REAL NOT NULL DEFAULT 0,
  is_inactive   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS stock_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  alias       TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES stock_categories(id),
  is_inactive INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS units (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
  formal_name     TEXT NOT NULL DEFAULT '',
  unit_type       TEXT NOT NULL DEFAULT 'Simple',
  decimal_places  INTEGER NOT NULL DEFAULT 0,
  base_unit_id    INTEGER REFERENCES units(id),
  additional_unit_id INTEGER REFERENCES units(id),
  conversion      REAL NOT NULL DEFAULT 1,
  is_inactive     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, symbol)
);

CREATE TABLE IF NOT EXISTS godowns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  alias       TEXT NOT NULL DEFAULT '',
  parent_id   INTEGER REFERENCES godowns(id),
  address     TEXT NOT NULL DEFAULT '',
  is_primary  INTEGER NOT NULL DEFAULT 0,
  allow_storage INTEGER NOT NULL DEFAULT 1,
  is_inactive INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS stock_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  alias            TEXT NOT NULL DEFAULT '',
  part_number      TEXT NOT NULL DEFAULT '',
  stock_group_id   INTEGER REFERENCES stock_groups(id),
  category_id      INTEGER REFERENCES stock_categories(id),
  unit_id          INTEGER REFERENCES units(id),
  opening_qty      REAL NOT NULL DEFAULT 0,
  opening_rate     REAL NOT NULL DEFAULT 0,
  opening_value    REAL NOT NULL DEFAULT 0,
  gst_applicable   TEXT NOT NULL DEFAULT 'Applicable',
  hsn_sac          TEXT NOT NULL DEFAULT '',
  taxability       TEXT NOT NULL DEFAULT 'Taxable',
  tax_rate         REAL NOT NULL DEFAULT 0,
  cess_rate        REAL NOT NULL DEFAULT 0,
  standard_cost    REAL NOT NULL DEFAULT 0,
  standard_price   REAL NOT NULL DEFAULT 0,
  costing_method   TEXT NOT NULL DEFAULT 'Avg. Cost',
  maintain_batches INTEGER NOT NULL DEFAULT 0,
  reorder_level    REAL NOT NULL DEFAULT 0,
  min_order_qty    REAL NOT NULL DEFAULT 0,
  is_inactive      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

-- ------------------------- Statutory masters --------------------------------
CREATE TABLE IF NOT EXISTS gst_registrations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT '',
  registration_type TEXT NOT NULL DEFAULT 'Regular',
  gstin             TEXT NOT NULL DEFAULT '',
  applicable_from   TEXT NOT NULL DEFAULT '',
  periodicity       TEXT NOT NULL DEFAULT 'Monthly',
  is_default        INTEGER NOT NULL DEFAULT 0,
  is_inactive       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS gst_classifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  hsn_sac         TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  taxability      TEXT NOT NULL DEFAULT 'Taxable',
  tax_rate        REAL NOT NULL DEFAULT 0,
  cess_rate       REAL NOT NULL DEFAULT 0,
  applicable_from TEXT NOT NULL DEFAULT '',
  is_inactive     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS tds_natures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  section         TEXT NOT NULL DEFAULT '',
  payment_code    TEXT NOT NULL DEFAULT '',
  rate_individual REAL NOT NULL DEFAULT 0,
  rate_company    REAL NOT NULL DEFAULT 0,
  rate_no_pan     REAL NOT NULL DEFAULT 20,
  threshold       REAL NOT NULL DEFAULT 0,
  is_inactive     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

-- ------------------------------ Vouchers ------------------------------------
CREATE TABLE IF NOT EXISTS vouchers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_type_id  INTEGER NOT NULL REFERENCES voucher_types(id),
  voucher_number   TEXT NOT NULL DEFAULT '',
  date             TEXT NOT NULL,
  reference_no     TEXT NOT NULL DEFAULT '',
  reference_date   TEXT NOT NULL DEFAULT '',
  party_ledger_id  INTEGER REFERENCES ledgers(id),
  narration        TEXT NOT NULL DEFAULT '',
  place_of_supply  TEXT NOT NULL DEFAULT '',
  mode             TEXT NOT NULL DEFAULT 'Item Invoice',
  is_invoice       INTEGER NOT NULL DEFAULT 0,
  is_cancelled     INTEGER NOT NULL DEFAULT 0,
  is_optional      INTEGER NOT NULL DEFAULT 0,
  is_post_dated    INTEGER NOT NULL DEFAULT 0,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  total_amount     REAL NOT NULL DEFAULT 0,
  version_no       INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_by       TEXT NOT NULL DEFAULT '',
  altered_at       TEXT,
  altered_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_date ON vouchers (company_id, date);
CREATE INDEX IF NOT EXISTS idx_vouchers_type ON vouchers (voucher_type_id);

CREATE TABLE IF NOT EXISTS voucher_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id     INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 0,
  ledger_id      INTEGER NOT NULL REFERENCES ledgers(id),
  dr_cr          TEXT NOT NULL,
  amount         REAL NOT NULL DEFAULT 0,
  cost_centre_id INTEGER REFERENCES cost_centres(id),
  narration      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_entries_voucher ON voucher_entries (voucher_id);
CREATE INDEX IF NOT EXISTS idx_entries_ledger ON voucher_entries (ledger_id);

CREATE TABLE IF NOT EXISTS voucher_inventory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id     INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 0,
  stock_item_id  INTEGER NOT NULL REFERENCES stock_items(id),
  godown_id      INTEGER REFERENCES godowns(id),
  batch          TEXT NOT NULL DEFAULT '',
  quantity       REAL NOT NULL DEFAULT 0,
  unit_id        INTEGER REFERENCES units(id),
  rate           REAL NOT NULL DEFAULT 0,
  discount_pct   REAL NOT NULL DEFAULT 0,
  amount         REAL NOT NULL DEFAULT 0,
  direction      TEXT NOT NULL DEFAULT 'In'
);
CREATE INDEX IF NOT EXISTS idx_inv_voucher ON voucher_inventory (voucher_id);
CREATE INDEX IF NOT EXISTS idx_inv_item ON voucher_inventory (stock_item_id);

CREATE TABLE IF NOT EXISTS bill_allocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER REFERENCES voucher_entries(id) ON DELETE CASCADE,
  voucher_id  INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id),
  bill_name   TEXT NOT NULL DEFAULT '',
  bill_type   TEXT NOT NULL DEFAULT 'New Ref',
  amount      REAL NOT NULL DEFAULT 0,
  dr_cr       TEXT NOT NULL DEFAULT 'Dr',
  due_date    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bills_ledger ON bill_allocations (ledger_id);

-- ------------------------------ Edit Log ------------------------------------
-- Every create / alter / delete / cancel of a master or voucher is recorded
-- here with a complete snapshot, exactly like the TallyPrime Edit Log feature.
CREATE TABLE IF NOT EXISTS edit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,
  entity_id      INTEGER NOT NULL,
  entity_name    TEXT NOT NULL DEFAULT '',
  entity_label   TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL,
  version_no     INTEGER NOT NULL DEFAULT 1,
  user_id        INTEGER,
  username       TEXT NOT NULL DEFAULT '',
  machine        TEXT NOT NULL DEFAULT '',
  ip_address     TEXT NOT NULL DEFAULT '',
  logged_at      TEXT NOT NULL DEFAULT (datetime('now')),
  voucher_date   TEXT NOT NULL DEFAULT '',
  voucher_type   TEXT NOT NULL DEFAULT '',
  voucher_number TEXT NOT NULL DEFAULT '',
  amount         REAL NOT NULL DEFAULT 0,
  snapshot       TEXT NOT NULL DEFAULT '{}',
  changes        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_editlog_entity ON edit_log (company_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_editlog_time ON edit_log (company_id, logged_at);
