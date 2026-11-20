/**
 * One-off migration: copies everything from the old SQL Server database into
 * MongoDB, keeping every id. The SQL Server database is only read, never
 * changed.
 *
 *   npm run migrate-from-sqlserver              # load into empty collections
 *   npm run migrate-from-sqlserver -- --replace # empty the MongoDB collections first
 *
 * Source: SQLSERVER_* in backend/.env. Target: MONGODB_URI / MONGODB_DATABASE.
 */
process.loadEnvFile(new URL('../.env', import.meta.url));
const sql = (await import('mssql')).default;
const { loadTables } = await import('./lib/load-tables.mjs');
const { close, dbLabel } = await import('../src/db/index.js');

const TABLES = [
  'users', 'sessions', 'companies', 'groups', 'currencies', 'cost_categories', 'cost_centres',
  'budgets', 'scenarios', 'voucher_types', 'stock_groups', 'stock_categories', 'units',
  'godowns', 'ledgers', 'stock_items', 'gst_registrations', 'gst_classifications',
  'tds_natures', 'vouchers', 'voucher_entries', 'voucher_inventory', 'bill_allocations',
  'edit_log',
];

const cfg = {
  server: process.env.SQLSERVER_HOST || 'localhost',
  user: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  database: process.env.SQLSERVER_DATABASE || 'LedgerTrail',
  options: {
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    encrypt: process.env.SQLSERVER_ENCRYPT !== 'false',
    trustServerCertificate: process.env.SQLSERVER_TRUST_CERT !== 'false',
    enableArithAbort: true,
  },
  connectionTimeout: 15000,
  requestTimeout: 120000,
};
if (process.env.SQLSERVER_PORT) {
  cfg.port = Number(process.env.SQLSERVER_PORT);
  delete cfg.options.instanceName;
}

const replace = process.argv.includes('--replace');

let pool;
try {
  pool = await new sql.ConnectionPool(cfg).connect();
  const source = `${cfg.server}${cfg.options.instanceName ? `\\${cfg.options.instanceName}` : ''} / ${cfg.database}`;
  console.log(`Reading SQL Server: ${source}`);

  const tables = {};
  for (const table of TABLES) {
    const found = await pool.request().input('t', `dbo.${table}`).query('SELECT OBJECT_ID(@t, \'U\') AS id');
    if (found.recordset[0].id == null) {
      console.log(`  (no ${table} table - skipped)`);
      continue;
    }
    const result = await pool.request().query(`SELECT * FROM dbo.[${table}] ORDER BY 1`);
    tables[table] = result.recordset.map((r) => ({ ...r }));
    console.log(`  read   ${String(tables[table].length).padStart(5)} ${table}`);
  }
  await pool.close();
  pool = null;

  console.log(`\nWriting MongoDB: ${dbLabel()}${replace ? ' (replacing existing data)' : ''}`);
  const loaded = await loadTables(tables, { replace });

  // every row read must have arrived (a skipped collection counts as missing)
  const mismatched = Object.entries(tables)
    .filter(([table, rows]) => rows.length && loaded[table] !== rows.length);
  if (mismatched.length) {
    for (const [table, rows] of mismatched) {
      console.error(`  NOT LOADED ${table}: read ${rows.length}, loaded ${loaded[table] ?? 0}`
        + (loaded[table] === undefined ? ' (collection already had data - rerun with --replace)' : ''));
    }
    process.exitCode = 1;
  } else {
    console.log('\nMigration complete - every row read was loaded.');
  }
} catch (err) {
  console.error('MIGRATION FAILED:', err.message);
  process.exitCode = 1;
} finally {
  if (pool) await pool.close();
  await close();
}
