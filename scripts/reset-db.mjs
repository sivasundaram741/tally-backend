// Drops every LedgerTrail table. The schema is recreated on the next boot.
process.loadEnvFile(new URL('../.env', import.meta.url));
const { connect, all, run, close, dbLabel } = await import('../src/db/index.js');

await connect();
try {
  // drop foreign keys first so table order does not matter
  const fks = await all(`
    SELECT 'ALTER TABLE [' + s.name + '].[' + t.name + '] DROP CONSTRAINT [' + f.name + ']' AS cmd
      FROM sys.foreign_keys f
      JOIN sys.tables t ON t.object_id = f.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id`);
  for (const r of fks) await run(r.cmd);

  const tables = await all(
    "SELECT '[' + s.name + '].[' + t.name + ']' AS n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id");
  for (const r of tables) await run(`DROP TABLE ${r.n}`);

  console.log(`dropped ${tables.length} tables from ${dbLabel()}`);
} finally {
  await close();
}
