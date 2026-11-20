/**
 * Loads a JSON table dump (`{ tableName: rows[] }`, see data/migration/) into
 * MongoDB. Ids are preserved, so every reference in the source data stays
 * valid without remapping. Collections that already hold data are skipped.
 *
 *   npm run load-dump -- data/migration/sqlite-dump.json
 */
process.loadEnvFile(new URL('../.env', import.meta.url));
import fs from 'node:fs';
import path from 'node:path';

const { loadTables } = await import('./lib/load-tables.mjs');
const { close, dbLabel } = await import('../src/db/index.js');

const file = process.argv[2] || 'data/migration/sqlite-dump.json';
const dump = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

try {
  console.log(`Loading ${file} into ${dbLabel()}`);
  const loaded = await loadTables(dump);
  const total = Object.values(loaded).reduce((n, v) => n + v, 0);
  console.log(`\n${total} rows loaded`);
} catch (err) {
  console.error('LOAD FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await close();
}
