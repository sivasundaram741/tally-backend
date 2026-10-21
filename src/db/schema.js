/**
 * T-SQL schema for LedgerTrail. Every statement is guarded, so `migrate()` is
 * safe to run on every boot.
 *
 * Dates are kept as `yyyy-mm-dd` strings and timestamps as
 * `yyyy-mm-dd hh:mm:ss` strings: the reports compare and sort them as text,
 * which keeps the query logic identical across engines.
 */

const table = (name, body) => `
IF OBJECT_ID('dbo.${name}', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.${name} (
${body}
  );
END`;

const index = (name, on, cols) => `
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = '${name}' AND object_id = OBJECT_ID('dbo.${on}')
)
  CREATE INDEX ${name} ON dbo.${on} (${cols});`;

const NOW = "CONVERT(varchar(19), GETDATE(), 120)";

export const SCHEMA = [
  // ------------------------------ users ------------------------------------
  table('users', `
    id             INT IDENTITY(1,1) PRIMARY KEY,
    username       NVARCHAR(100) NOT NULL UNIQUE,
    full_name      NVARCHAR(200) NOT NULL DEFAULT '',
    password_hash  NVARCHAR(200) NOT NULL,
    security_level NVARCHAR(50)  NOT NULL DEFAULT 'Owner',
    is_active      INT           NOT NULL DEFAULT 1,
    created_at     NVARCHAR(19)  NOT NULL DEFAULT ${NOW}`),

  table('sessions', `
    token      NVARCHAR(64) NOT NULL PRIMARY KEY,
    user_id    INT          NOT NULL REFERENCES dbo.users(id),
    created_at NVARCHAR(19) NOT NULL DEFAULT ${NOW},
    expires_at NVARCHAR(40) NOT NULL`),

  // ---------------------------- companies ----------------------------------
  table('companies', `
    id                    INT IDENTITY(1,1) PRIMARY KEY,
    name                  NVARCHAR(200) NOT NULL,
    mailing_name          NVARCHAR(200) NOT NULL DEFAULT '',
    address               NVARCHAR(MAX) NOT NULL DEFAULT '',
    state                 NVARCHAR(100) NOT NULL DEFAULT '',
    country               NVARCHAR(100) NOT NULL DEFAULT 'India',
    pincode               NVARCHAR(20)  NOT NULL DEFAULT '',
    phone                 NVARCHAR(50)  NOT NULL DEFAULT '',
    mobile                NVARCHAR(50)  NOT NULL DEFAULT '',
    email                 NVARCHAR(200) NOT NULL DEFAULT '',
    website               NVARCHAR(200) NOT NULL DEFAULT '',
    financial_year_from   NVARCHAR(10)  NOT NULL,
    books_begin_from      NVARCHAR(10)  NOT NULL,
    base_currency         NVARCHAR(20)  NOT NULL DEFAULT 'Rs.',
    currency_name         NVARCHAR(50)  NOT NULL DEFAULT 'INR',
    decimal_places        INT           NOT NULL DEFAULT 2,
    gstin                 NVARCHAR(30)  NOT NULL DEFAULT '',
    gst_registration_type NVARCHAR(50)  NOT NULL DEFAULT 'Regular',
    pan                   NVARCHAR(20)  NOT NULL DEFAULT '',
    cin                   NVARCHAR(40)  NOT NULL DEFAULT '',
    tan                   NVARCHAR(20)  NOT NULL DEFAULT '',
    maintain              NVARCHAR(60)  NOT NULL DEFAULT 'Accounts with Inventory',
    edit_log_enabled      INT           NOT NULL DEFAULT 1,
    gst_enabled           INT           NOT NULL DEFAULT 1,
    tds_enabled           INT           NOT NULL DEFAULT 0,
    is_active             INT           NOT NULL DEFAULT 1,
    created_at            NVARCHAR(19)  NOT NULL DEFAULT ${NOW},
    CONSTRAINT UQ_companies_name UNIQUE (name)`),

  // ------------------------ accounting masters -----------------------------
  table('groups', `
    id                   INT IDENTITY(1,1) PRIMARY KEY,
    company_id           INT NOT NULL REFERENCES dbo.companies(id),
    name                 NVARCHAR(200) NOT NULL,
    alias                NVARCHAR(200) NOT NULL DEFAULT '',
    parent_id            INT NULL REFERENCES dbo.groups(id),
    nature               NVARCHAR(40) NOT NULL DEFAULT 'Assets',
    is_primary           INT NOT NULL DEFAULT 0,
    is_reserved          INT NOT NULL DEFAULT 0,
    affects_gross_profit INT NOT NULL DEFAULT 0,
    is_deemed_positive   INT NOT NULL DEFAULT 1,
    net_debit_credit     INT NOT NULL DEFAULT 0,
    used_for_calculation INT NOT NULL DEFAULT 0,
    sort_position        INT NOT NULL DEFAULT 1000,
    is_inactive          INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_groups_name UNIQUE (company_id, name)`),

  table('currencies', `
    id              INT IDENTITY(1,1) PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES dbo.companies(id),
    symbol          NVARCHAR(40) NOT NULL,
    formal_name     NVARCHAR(100) NOT NULL DEFAULT '',
    decimal_places  INT NOT NULL DEFAULT 2,
    is_base         INT NOT NULL DEFAULT 0,
    suffix_symbol   INT NOT NULL DEFAULT 0,
    space_between   INT NOT NULL DEFAULT 1,
    amount_in_words NVARCHAR(60) NOT NULL DEFAULT 'Rupees',
    decimal_words   NVARCHAR(60) NOT NULL DEFAULT 'paise',
    is_inactive     INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_currencies_symbol UNIQUE (company_id, symbol)`),

  table('cost_categories', `
    id                   INT IDENTITY(1,1) PRIMARY KEY,
    company_id           INT NOT NULL REFERENCES dbo.companies(id),
    name                 NVARCHAR(200) NOT NULL,
    alias                NVARCHAR(200) NOT NULL DEFAULT '',
    allocate_revenue     INT NOT NULL DEFAULT 1,
    allocate_non_revenue INT NOT NULL DEFAULT 0,
    is_inactive          INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_cost_categories_name UNIQUE (company_id, name)`),

  table('cost_centres', `
    id          INT IDENTITY(1,1) PRIMARY KEY,
    company_id  INT NOT NULL REFERENCES dbo.companies(id),
    name        NVARCHAR(200) NOT NULL,
    alias       NVARCHAR(200) NOT NULL DEFAULT '',
    category_id INT NULL REFERENCES dbo.cost_categories(id),
    parent_id   INT NULL REFERENCES dbo.cost_centres(id),
    is_inactive INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_cost_centres_name UNIQUE (company_id, name)`),

  table('budgets', `
    id          INT IDENTITY(1,1) PRIMARY KEY,
    company_id  INT NOT NULL REFERENCES dbo.companies(id),
    name        NVARCHAR(200) NOT NULL,
    parent_id   INT NULL REFERENCES dbo.budgets(id),
    period_from NVARCHAR(10) NOT NULL DEFAULT '',
    period_to   NVARCHAR(10) NOT NULL DEFAULT '',
    is_inactive INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_budgets_name UNIQUE (company_id, name)`),

  table('scenarios', `
    id            INT IDENTITY(1,1) PRIMARY KEY,
    company_id    INT NOT NULL REFERENCES dbo.companies(id),
    name          NVARCHAR(200) NOT NULL,
    include_types NVARCHAR(MAX) NOT NULL DEFAULT '',
    exclude_types NVARCHAR(MAX) NOT NULL DEFAULT '',
    is_inactive   INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_scenarios_name UNIQUE (company_id, name)`),

  table('voucher_types', `
    id                   INT IDENTITY(1,1) PRIMARY KEY,
    company_id           INT NOT NULL REFERENCES dbo.companies(id),
    name                 NVARCHAR(200) NOT NULL,
    alias                NVARCHAR(200) NOT NULL DEFAULT '',
    parent_type          NVARCHAR(60) NOT NULL,
    abbreviation         NVARCHAR(40) NOT NULL DEFAULT '',
    numbering_method     NVARCHAR(50) NOT NULL DEFAULT 'Automatic',
    restart_numbering    NVARCHAR(30) NOT NULL DEFAULT 'Yearly',
    prefix               NVARCHAR(40) NOT NULL DEFAULT '',
    suffix               NVARCHAR(40) NOT NULL DEFAULT '',
    starting_number      INT NOT NULL DEFAULT 1,
    is_reserved          INT NOT NULL DEFAULT 0,
    use_common_narration INT NOT NULL DEFAULT 1,
    narration_per_entry  INT NOT NULL DEFAULT 0,
    print_after_saving   INT NOT NULL DEFAULT 0,
    is_optional_default  INT NOT NULL DEFAULT 0,
    affects_stock        INT NOT NULL DEFAULT 0,
    allow_zero_valued    INT NOT NULL DEFAULT 0,
    sort_position        INT NOT NULL DEFAULT 1000,
    is_inactive          INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_voucher_types_name UNIQUE (company_id, name)`),

  // ------------------------- inventory masters -----------------------------
  table('stock_groups', `
    id               INT IDENTITY(1,1) PRIMARY KEY,
    company_id       INT NOT NULL REFERENCES dbo.companies(id),
    name             NVARCHAR(200) NOT NULL,
    alias            NVARCHAR(200) NOT NULL DEFAULT '',
    parent_id        INT NULL REFERENCES dbo.stock_groups(id),
    is_primary       INT NOT NULL DEFAULT 0,
    quantities_added INT NOT NULL DEFAULT 1,
    hsn_sac          NVARCHAR(40) NOT NULL DEFAULT '',
    tax_rate         FLOAT NOT NULL DEFAULT 0,
    is_inactive      INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_stock_groups_name UNIQUE (company_id, name)`),

  table('stock_categories', `
    id          INT IDENTITY(1,1) PRIMARY KEY,
    company_id  INT NOT NULL REFERENCES dbo.companies(id),
    name        NVARCHAR(200) NOT NULL,
    alias       NVARCHAR(200) NOT NULL DEFAULT '',
    parent_id   INT NULL REFERENCES dbo.stock_categories(id),
    is_inactive INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_stock_categories_name UNIQUE (company_id, name)`),

  table('units', `
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    company_id         INT NOT NULL REFERENCES dbo.companies(id),
    symbol             NVARCHAR(40) NOT NULL,
    formal_name        NVARCHAR(100) NOT NULL DEFAULT '',
    unit_type          NVARCHAR(30) NOT NULL DEFAULT 'Simple',
    decimal_places     INT NOT NULL DEFAULT 0,
    base_unit_id       INT NULL REFERENCES dbo.units(id),
    additional_unit_id INT NULL REFERENCES dbo.units(id),
    conversion         FLOAT NOT NULL DEFAULT 1,
    is_inactive        INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_units_symbol UNIQUE (company_id, symbol)`),

  table('godowns', `
    id            INT IDENTITY(1,1) PRIMARY KEY,
    company_id    INT NOT NULL REFERENCES dbo.companies(id),
    name          NVARCHAR(200) NOT NULL,
    alias         NVARCHAR(200) NOT NULL DEFAULT '',
    parent_id     INT NULL REFERENCES dbo.godowns(id),
    address       NVARCHAR(MAX) NOT NULL DEFAULT '',
    is_primary    INT NOT NULL DEFAULT 0,
    allow_storage INT NOT NULL DEFAULT 1,
    is_inactive   INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_godowns_name UNIQUE (company_id, name)`),

  table('ledgers', `
    id                   INT IDENTITY(1,1) PRIMARY KEY,
    company_id           INT NOT NULL REFERENCES dbo.companies(id),
    name                 NVARCHAR(200) NOT NULL,
    alias                NVARCHAR(200) NOT NULL DEFAULT '',
    group_id             INT NOT NULL REFERENCES dbo.groups(id),
    opening_balance      FLOAT NOT NULL DEFAULT 0,
    opening_balance_type NVARCHAR(4) NOT NULL DEFAULT 'Dr',
    is_reserved          INT NOT NULL DEFAULT 0,
    mailing_name         NVARCHAR(200) NOT NULL DEFAULT '',
    address              NVARCHAR(MAX) NOT NULL DEFAULT '',
    state                NVARCHAR(100) NOT NULL DEFAULT '',
    country              NVARCHAR(100) NOT NULL DEFAULT 'India',
    pincode              NVARCHAR(20) NOT NULL DEFAULT '',
    phone                NVARCHAR(50) NOT NULL DEFAULT '',
    email                NVARCHAR(200) NOT NULL DEFAULT '',
    contact_person       NVARCHAR(200) NOT NULL DEFAULT '',
    pan                  NVARCHAR(20) NOT NULL DEFAULT '',
    gstin                NVARCHAR(30) NOT NULL DEFAULT '',
    registration_type    NVARCHAR(40) NOT NULL DEFAULT 'Unregistered',
    gst_applicable       NVARCHAR(40) NOT NULL DEFAULT 'Not Applicable',
    hsn_sac              NVARCHAR(40) NOT NULL DEFAULT '',
    tax_type             NVARCHAR(30) NOT NULL DEFAULT '',
    tax_rate             FLOAT NOT NULL DEFAULT 0,
    bank_account_no      NVARCHAR(60) NOT NULL DEFAULT '',
    bank_ifsc            NVARCHAR(30) NOT NULL DEFAULT '',
    bank_name            NVARCHAR(150) NOT NULL DEFAULT '',
    bank_branch          NVARCHAR(150) NOT NULL DEFAULT '',
    is_bill_wise         INT NOT NULL DEFAULT 0,
    is_cost_centre       INT NOT NULL DEFAULT 0,
    inventory_affected   INT NOT NULL DEFAULT 0,
    credit_period_days   INT NOT NULL DEFAULT 0,
    credit_limit         FLOAT NOT NULL DEFAULT 0,
    is_inactive          INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_ledgers_name UNIQUE (company_id, name)`),

  table('stock_items', `
    id               INT IDENTITY(1,1) PRIMARY KEY,
    company_id       INT NOT NULL REFERENCES dbo.companies(id),
    name             NVARCHAR(200) NOT NULL,
    alias            NVARCHAR(200) NOT NULL DEFAULT '',
    part_number      NVARCHAR(100) NOT NULL DEFAULT '',
    stock_group_id   INT NULL REFERENCES dbo.stock_groups(id),
    category_id      INT NULL REFERENCES dbo.stock_categories(id),
    unit_id          INT NULL REFERENCES dbo.units(id),
    opening_qty      FLOAT NOT NULL DEFAULT 0,
    opening_rate     FLOAT NOT NULL DEFAULT 0,
    opening_value    FLOAT NOT NULL DEFAULT 0,
    gst_applicable   NVARCHAR(40) NOT NULL DEFAULT 'Applicable',
    hsn_sac          NVARCHAR(40) NOT NULL DEFAULT '',
    taxability       NVARCHAR(40) NOT NULL DEFAULT 'Taxable',
    tax_rate         FLOAT NOT NULL DEFAULT 0,
    cess_rate        FLOAT NOT NULL DEFAULT 0,
    standard_cost    FLOAT NOT NULL DEFAULT 0,
    standard_price   FLOAT NOT NULL DEFAULT 0,
    costing_method   NVARCHAR(40) NOT NULL DEFAULT 'Avg. Cost',
    maintain_batches INT NOT NULL DEFAULT 0,
    reorder_level    FLOAT NOT NULL DEFAULT 0,
    min_order_qty    FLOAT NOT NULL DEFAULT 0,
    is_inactive      INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_stock_items_name UNIQUE (company_id, name)`),

  // ------------------------- statutory masters -----------------------------
  table('gst_registrations', `
    id                INT IDENTITY(1,1) PRIMARY KEY,
    company_id        INT NOT NULL REFERENCES dbo.companies(id),
    name              NVARCHAR(200) NOT NULL,
    state             NVARCHAR(100) NOT NULL DEFAULT '',
    registration_type NVARCHAR(40) NOT NULL DEFAULT 'Regular',
    gstin             NVARCHAR(30) NOT NULL DEFAULT '',
    applicable_from   NVARCHAR(10) NOT NULL DEFAULT '',
    periodicity       NVARCHAR(20) NOT NULL DEFAULT 'Monthly',
    is_default        INT NOT NULL DEFAULT 0,
    is_inactive       INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_gst_registrations_name UNIQUE (company_id, name)`),

  table('gst_classifications', `
    id              INT IDENTITY(1,1) PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES dbo.companies(id),
    name            NVARCHAR(200) NOT NULL,
    hsn_sac         NVARCHAR(40) NOT NULL DEFAULT '',
    description     NVARCHAR(MAX) NOT NULL DEFAULT '',
    taxability      NVARCHAR(40) NOT NULL DEFAULT 'Taxable',
    tax_rate        FLOAT NOT NULL DEFAULT 0,
    cess_rate       FLOAT NOT NULL DEFAULT 0,
    applicable_from NVARCHAR(10) NOT NULL DEFAULT '',
    is_inactive     INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_gst_classifications_name UNIQUE (company_id, name)`),

  table('tds_natures', `
    id              INT IDENTITY(1,1) PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES dbo.companies(id),
    name            NVARCHAR(200) NOT NULL,
    section         NVARCHAR(40) NOT NULL DEFAULT '',
    payment_code    NVARCHAR(40) NOT NULL DEFAULT '',
    rate_individual FLOAT NOT NULL DEFAULT 0,
    rate_company    FLOAT NOT NULL DEFAULT 0,
    rate_no_pan     FLOAT NOT NULL DEFAULT 20,
    threshold       FLOAT NOT NULL DEFAULT 0,
    is_inactive     INT NOT NULL DEFAULT 0,
    CONSTRAINT UQ_tds_natures_name UNIQUE (company_id, name)`),

  // ------------------------------ vouchers ---------------------------------
  table('vouchers', `
    id              INT IDENTITY(1,1) PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES dbo.companies(id),
    voucher_type_id INT NOT NULL REFERENCES dbo.voucher_types(id),
    voucher_number  NVARCHAR(60) NOT NULL DEFAULT '',
    date            NVARCHAR(10) NOT NULL,
    reference_no    NVARCHAR(100) NOT NULL DEFAULT '',
    reference_date  NVARCHAR(10) NOT NULL DEFAULT '',
    party_ledger_id INT NULL REFERENCES dbo.ledgers(id),
    narration       NVARCHAR(MAX) NOT NULL DEFAULT '',
    place_of_supply NVARCHAR(100) NOT NULL DEFAULT '',
    mode            NVARCHAR(40) NOT NULL DEFAULT 'Item Invoice',
    is_invoice      INT NOT NULL DEFAULT 0,
    is_cancelled    INT NOT NULL DEFAULT 0,
    is_optional     INT NOT NULL DEFAULT 0,
    is_post_dated   INT NOT NULL DEFAULT 0,
    is_deleted      INT NOT NULL DEFAULT 0,
    total_amount    FLOAT NOT NULL DEFAULT 0,
    version_no      INT NOT NULL DEFAULT 1,
    created_at      NVARCHAR(19) NOT NULL DEFAULT ${NOW},
    created_by      NVARCHAR(100) NOT NULL DEFAULT '',
    altered_at      NVARCHAR(19) NULL,
    altered_by      NVARCHAR(100) NULL`),

  table('voucher_entries', `
    id             INT IDENTITY(1,1) PRIMARY KEY,
    voucher_id     INT NOT NULL REFERENCES dbo.vouchers(id),
    line_no        INT NOT NULL DEFAULT 0,
    ledger_id      INT NOT NULL REFERENCES dbo.ledgers(id),
    dr_cr          NVARCHAR(4) NOT NULL,
    amount         FLOAT NOT NULL DEFAULT 0,
    cost_centre_id INT NULL REFERENCES dbo.cost_centres(id),
    narration      NVARCHAR(MAX) NOT NULL DEFAULT ''`),

  table('voucher_inventory', `
    id            INT IDENTITY(1,1) PRIMARY KEY,
    voucher_id    INT NOT NULL REFERENCES dbo.vouchers(id),
    line_no       INT NOT NULL DEFAULT 0,
    stock_item_id INT NOT NULL REFERENCES dbo.stock_items(id),
    godown_id     INT NULL REFERENCES dbo.godowns(id),
    batch         NVARCHAR(100) NOT NULL DEFAULT '',
    quantity      FLOAT NOT NULL DEFAULT 0,
    unit_id       INT NULL REFERENCES dbo.units(id),
    rate          FLOAT NOT NULL DEFAULT 0,
    discount_pct  FLOAT NOT NULL DEFAULT 0,
    amount        FLOAT NOT NULL DEFAULT 0,
    direction     NVARCHAR(4) NOT NULL DEFAULT 'In'`),

  table('bill_allocations', `
    id         INT IDENTITY(1,1) PRIMARY KEY,
    entry_id   INT NULL REFERENCES dbo.voucher_entries(id),
    voucher_id INT NOT NULL REFERENCES dbo.vouchers(id),
    ledger_id  INT NOT NULL REFERENCES dbo.ledgers(id),
    bill_name  NVARCHAR(100) NOT NULL DEFAULT '',
    bill_type  NVARCHAR(30) NOT NULL DEFAULT 'New Ref',
    amount     FLOAT NOT NULL DEFAULT 0,
    dr_cr      NVARCHAR(4) NOT NULL DEFAULT 'Dr',
    due_date   NVARCHAR(10) NOT NULL DEFAULT ''`),

  // ------------------------------ edit log ---------------------------------
  table('edit_log', `
    id             INT IDENTITY(1,1) PRIMARY KEY,
    company_id     INT NOT NULL REFERENCES dbo.companies(id),
    entity_type    NVARCHAR(60) NOT NULL,
    entity_kind    NVARCHAR(20) NOT NULL,
    entity_id      INT NOT NULL,
    entity_name    NVARCHAR(300) NOT NULL DEFAULT '',
    entity_label   NVARCHAR(300) NOT NULL DEFAULT '',
    action         NVARCHAR(20) NOT NULL,
    version_no     INT NOT NULL DEFAULT 1,
    user_id        INT NULL,
    username       NVARCHAR(100) NOT NULL DEFAULT '',
    machine        NVARCHAR(100) NOT NULL DEFAULT '',
    ip_address     NVARCHAR(60) NOT NULL DEFAULT '',
    logged_at      NVARCHAR(19) NOT NULL DEFAULT ${NOW},
    voucher_date   NVARCHAR(10) NOT NULL DEFAULT '',
    voucher_type   NVARCHAR(200) NOT NULL DEFAULT '',
    voucher_number NVARCHAR(60) NOT NULL DEFAULT '',
    amount         FLOAT NOT NULL DEFAULT 0,
    snapshot       NVARCHAR(MAX) NOT NULL DEFAULT '{}',
    changes        NVARCHAR(MAX) NOT NULL DEFAULT '[]'`),

  // ------------------------------ indexes ----------------------------------
  index('idx_vouchers_company_date', 'vouchers', 'company_id, date'),
  index('idx_vouchers_type', 'vouchers', 'voucher_type_id'),
  index('idx_entries_voucher', 'voucher_entries', 'voucher_id'),
  index('idx_entries_ledger', 'voucher_entries', 'ledger_id'),
  index('idx_inv_voucher', 'voucher_inventory', 'voucher_id'),
  index('idx_inv_item', 'voucher_inventory', 'stock_item_id'),
  index('idx_bills_ledger', 'bill_allocations', 'ledger_id'),
  index('idx_editlog_entity', 'edit_log', 'company_id, entity_type, entity_id'),
  index('idx_editlog_time', 'edit_log', 'company_id, logged_at'),
];

/**
 * Child tables of a company, in the order they must be emptied so no foreign
 * key is left dangling.
 */
export const COMPANY_CASCADE = [
  'DELETE FROM bill_allocations WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ?)',
  'DELETE FROM voucher_inventory WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ?)',
  'DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ?)',
  'DELETE FROM vouchers WHERE company_id = ?',
  'DELETE FROM edit_log WHERE company_id = ?',
  'DELETE FROM stock_items WHERE company_id = ?',
  'UPDATE units SET base_unit_id = NULL, additional_unit_id = NULL WHERE company_id = ?',
  'DELETE FROM units WHERE company_id = ?',
  'UPDATE godowns SET parent_id = NULL WHERE company_id = ?',
  'DELETE FROM godowns WHERE company_id = ?',
  'UPDATE stock_categories SET parent_id = NULL WHERE company_id = ?',
  'DELETE FROM stock_categories WHERE company_id = ?',
  'UPDATE stock_groups SET parent_id = NULL WHERE company_id = ?',
  'DELETE FROM stock_groups WHERE company_id = ?',
  'DELETE FROM ledgers WHERE company_id = ?',
  'UPDATE cost_centres SET parent_id = NULL WHERE company_id = ?',
  'DELETE FROM cost_centres WHERE company_id = ?',
  'DELETE FROM cost_categories WHERE company_id = ?',
  'UPDATE budgets SET parent_id = NULL WHERE company_id = ?',
  'DELETE FROM budgets WHERE company_id = ?',
  'DELETE FROM scenarios WHERE company_id = ?',
  'DELETE FROM voucher_types WHERE company_id = ?',
  'DELETE FROM currencies WHERE company_id = ?',
  'DELETE FROM gst_registrations WHERE company_id = ?',
  'DELETE FROM gst_classifications WHERE company_id = ?',
  'DELETE FROM tds_natures WHERE company_id = ?',
  'UPDATE groups SET parent_id = NULL WHERE company_id = ?',
  'DELETE FROM groups WHERE company_id = ?',
  'DELETE FROM companies WHERE id = ?',
];
