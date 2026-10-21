// Ad-hoc query runner: node scripts/sqlcmd.mjs "SELECT ..."
process.loadEnvFile(new URL('../.env', import.meta.url));
const { connect, all, close } = await import('../src/db/index.js');
await connect();
try {
  const rows = await all(process.argv[2]);
  console.table(rows);
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  await close();
}
