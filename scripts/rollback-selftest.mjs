/**
 * Self-test for transaction(): on a standalone MongoDB server (no real
 * transactions) a failure part-way through must undo every write already
 * made. Uses a throwaway database that is dropped afterwards.
 *
 *   node scripts/rollback-selftest.mjs
 */
process.loadEnvFile(new URL('../.env', import.meta.url));
process.env.MONGODB_DATABASE = `rollback_selftest_${Date.now()}`;

const {
  connect, close, migrate, insert, update, updateWhere, remove, transaction, findOne, count,
  supportsTransactions,
} = await import('../src/db/index.js');

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures += 1; console.log('FAIL:', msg); } else console.log('ok  :', msg); };

const db = await connect();
try {
  await migrate();
  console.log(`(server ${supportsTransactions() ? 'supports' : 'does not support'} transactions)`);

  const companyId = await insert('companies', {
    name: 'Before', financial_year_from: '2026-04-01', books_begin_from: '2026-04-01',
  });
  const keepId = await insert('groups', { company_id: companyId, name: 'Keep Me' });
  const changeId = await insert('groups', { company_id: companyId, name: 'Change Me', nature: 'Assets' });

  let thrown = null;
  try {
    await transaction(async () => {
      await insert('groups', { company_id: companyId, name: 'Added' });
      await update('companies', companyId, { name: 'After' });
      await updateWhere('groups', { id: changeId }, { nature: 'Liabilities' });
      await remove('groups', { id: keepId });
      await transaction(async () => {   // nested calls join the outer one
        await insert('ledgers', { company_id: companyId, name: 'Nested', group_id: changeId });
      });
      throw new Error('boom');
    });
  } catch (err) {
    thrown = err;
  }

  check(thrown?.message === 'boom', 'the original error reaches the caller');
  check((await findOne('companies', { id: companyId }))?.name === 'Before', 'update rolled back');
  check(!(await findOne('groups', { name: 'Added' })), 'insert rolled back');
  check((await findOne('groups', { id: changeId }))?.nature === 'Assets', 'updateWhere rolled back');
  check(Boolean(await findOne('groups', { id: keepId })), 'delete rolled back');
  check((await count('ledgers')) === 0, 'nested insert rolled back');

  // a successful transaction keeps its writes
  await transaction(async () => {
    await update('companies', companyId, { name: 'Committed' });
  });
  check((await findOne('companies', { id: companyId }))?.name === 'Committed', 'successful transaction kept');

  // duplicate names still clash case-insensitively
  let dup = null;
  try { await insert('groups', { company_id: companyId, name: 'keep me' }); } catch (err) { dup = err; }
  check(dup?.code === 11000, 'unique index is case-insensitive');
} finally {
  await db.dropDatabase();
  await close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall rollback checks passed');
process.exitCode = failures ? 1 : 0;
