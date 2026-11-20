// Connectivity probe: confirms MongoDB is reachable and reports what it finds.
// Prints no credentials.
process.loadEnvFile(new URL('../.env', import.meta.url));
const { connect, close, dbLabel, supportsTransactions, runCommand, col } = await import('../src/db/index.js');

try {
  const db = await connect();
  const info = await runCommand({ buildInfo: 1 });
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  console.log('connected OK');
  console.log('  server      :', `MongoDB ${info.version}`);
  console.log('  database    :', dbLabel());
  console.log('  collections :', collections.length);
  console.log('  transactions:', supportsTransactions()
    ? 'yes (replica set)'
    : 'no (standalone server - multi-step writes roll back on error instead)');
  if (collections.some((c) => c.name === 'companies')) {
    console.log('  companies   :', await col('companies').countDocuments());
  }
} catch (err) {
  console.error('connection FAILED');
  console.error('  message:', String(err.message).replace(/\/\/[^@/]*@/g, '//***@'));
  process.exitCode = 1;
} finally {
  await close();
}
