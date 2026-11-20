// Drops every collection this application owns. They are recreated, empty, on
// the next boot. Other databases on the same server are not touched.
process.loadEnvFile(new URL('../.env', import.meta.url));
const { connect, close, dbLabel } = await import('../src/db/index.js');
const { COLLECTIONS } = await import('../src/db/schema.js');

const db = await connect();
try {
  const owned = new Set([...Object.keys(COLLECTIONS), 'counters']);
  const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  let dropped = 0;
  for (const name of present) {
    if (!owned.has(name)) continue;
    await db.collection(name).drop();
    dropped += 1;
  }
  console.log(`dropped ${dropped} collections from ${dbLabel()}`);
} finally {
  await close();
}
