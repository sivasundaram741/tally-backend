process.loadEnvFile(new URL('../.env', import.meta.url));
const { migrate, close, dbLabel } = await import('../src/db/index.js');
try {
  await migrate();
  console.log('schema applied to', dbLabel());
} catch (err) {
  console.error('MIGRATE FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await close();
}
