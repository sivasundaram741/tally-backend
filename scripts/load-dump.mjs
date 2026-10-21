/**
 * Loads a JSON table dump (see data/migration/) into SQL Server.
 *
 * Identity values are preserved, so every foreign key in the source data stays
 * valid without remapping. Intended for a one-off migration into an empty
 * database: `npm run load-dump -- data/migration/sqlite-dump.json`
 */
process.loadEnvFile(new URL('../.env', import.meta.url));
import fs from 'node:fs';
import path from 'node:path';

const { connect, all, run, get, close, dbLabel, sql } = await import('../src/db/index.js');

const file = process.argv[2] || 'data/migration/sqlite-dump.json';
const dump = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

/** Parents before children, so foreign keys are always satisfied. */
const ORDER = [
  'users', 'companies', 'groups', 'currencies', 'cost_categories', 'cost_centres',
  'budgets', 'scenarios', 'voucher_types', 'stock_groups', 'stock_categories',
  'units', 'godowns', 'ledgers', 'stock_items', 'gst_registrations',
  'gst_classifications', 'tds_natures', 'vouchers', 'voucher_entries',
  'voucher_inventory', 'bill_allocations', 'edit_log', 'sessions',
];

await connect();
const pool = await connect();

async function columnsOf(table) {
  const rows = await all(
    'SELECT name, is_identity FROM sys.columns WHERE object_id = OBJECT_ID(?)',
    [`dbo.${table}`],
  );
  return rows;
}

let totalRows = 0;
try {
  for (const table of ORDER) {
    const rows = dump[table];
    if (!rows?.length) continue;

    const cols = await columnsOf(table);
    if (!cols.length) {
      console.log(`  skipped ${table} (no such table)`);
      continue;
    }
    const known = new Set(cols.map((c) => c.name));
    const hasIdentity = cols.some((c) => c.is_identity);

    const existing = await get(`SELECT COUNT(*) AS c FROM ${table}`);
    if (existing.c > 0) {
      console.log(`  skipped ${table} (already holds ${existing.c} rows)`);
      continue;
    }

    // one request for the whole table so IDENTITY_INSERT stays in scope
    const request = pool.request();
    const useCols = Object.keys(rows[0]).filter((c) => known.has(c));
    const list = useCols.map((c) => `[${c}]`).join(', ');

    let statements = hasIdentity ? [`SET IDENTITY_INSERT dbo.${table} ON`] : [];
    rows.forEach((row, i) => {
      const params = useCols.map((c, j) => {
        const name = `p${i}_${j}`;
        let v = row[c];
        if (v === undefined) v = null;
        if (typeof v === 'bigint') v = Number(v);
        if (v === null) request.input(name, sql.NVarChar, null);
        else request.input(name, v);
        return `@${name}`;
      });
      statements.push(`INSERT INTO dbo.${table} (${list}) VALUES (${params.join(', ')})`);
    });
    if (hasIdentity) statements.push(`SET IDENTITY_INSERT dbo.${table} OFF`);

    await request.batch(statements.join(';\n'));
    totalRows += rows.length;
    console.log(`  loaded ${String(rows.length).padStart(5)} rows into ${table}`);
  }

  // realign each identity sequence with the highest id just inserted
  for (const table of ORDER) {
    if (!dump[table]?.length) continue;
    const cols = await columnsOf(table);
    if (!cols.some((c) => c.is_identity)) continue;
    await run(`DBCC CHECKIDENT ('dbo.${table}', RESEED) WITH NO_INFOMSGS`);
  }

  console.log(`\n${totalRows} rows loaded into ${dbLabel()}`);
} catch (err) {
  console.error('LOAD FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await close();
}
