import { MongoClient } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';
import { COLLECTIONS, CHILDREN, COLLATION, REQUIRED } from './schema.js';
import { APP_NAME } from '../lib/brand.js';
import { badRequest } from '../lib/http.js';

/**
 * MongoDB data layer.
 *
 * Rows are documents with a numeric `id` (drawn from the `counters`
 * collection); MongoDB's `_id` never leaves this module. Every write goes
 * through the schema in schema.js, which supplies defaults and rejects missing
 * or unknown fields the way SQL Server's table definitions used to.
 *
 * `transaction(fn)` keeps multi-step changes all-or-nothing. On a replica set
 * it uses a real MongoDB transaction. A standalone server has no transactions,
 * so instead every write inside `fn` records how to undo itself, and the undo
 * steps run in reverse if `fn` fails. (That restores the data but does not
 * hide half-finished work from concurrent readers.)
 */

const txStore = new AsyncLocalStorage();
let client = null;
let db = null;
let connecting = null;
let transactionsSupported = false;

export const databaseName = () => process.env.MONGODB_DATABASE || 'LedgerTrail';
const mongoUri = () => process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';

/** The connection string with any password hidden, for logs and /api/health. */
export function dbLabel() {
  const safe = mongoUri().replace(/\/\/([^@/]*)@/, (_m, cred) => `//${cred.split(':')[0]}:***@`);
  return `${safe} / ${databaseName()}`;
}

export async function connect() {
  if (db) return db;
  connecting ||= (async () => {
    const c = new MongoClient(mongoUri(), {
      appName: APP_NAME,
      serverSelectionTimeoutMS: 15000,
    });
    await c.connect();
    const hello = await c.db('admin').command({ hello: 1 });
    transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
    client = c;
    db = c.db(databaseName());
    return db;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export const supportsTransactions = () => transactionsSupported;

/**
 * Creates any missing collection (with the case-insensitive collation) and its
 * indexes. Safe to run on every boot.
 */
export async function migrate() {
  await connect();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (!existing.has(name)) await db.createCollection(name, { collation: COLLATION });
    const indexes = [];
    if (!spec.noId) indexes.push({ key: { id: 1 }, name: 'id_unique', unique: true });
    for (const cols of spec.unique || []) {
      indexes.push({ key: keyOf(cols), name: `uq_${cols.join('_')}`, unique: true });
    }
    for (const cols of spec.indexes || []) {
      indexes.push({ key: keyOf(cols), name: `ix_${cols.join('_')}` });
    }
    await db.collection(name).createIndexes(indexes);
  }
  if (!existing.has('counters')) await db.createCollection('counters');
}

const keyOf = (cols) => Object.fromEntries(cols.map((c) => [c, 1]));

/**
 * Moves every id counter up to at least the highest id in use, so rows loaded
 * with their ids preserved (a migration, a manual import) can never collide
 * with new ones. Counters only ever move forward.
 */
export async function syncCounters() {
  await connect();
  const highest = {};
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (spec.noId) continue;
    const top = await db.collection(name).find({}, { projection: { id: 1 } }).sort({ id: -1 }).limit(1).toArray();
    highest[name] = top[0]?.id ?? 0;
  }
  for (const [kind, spec] of Object.entries(CHILDREN)) {
    const [row] = await db.collection('vouchers').aggregate([
      { $unwind: `$${kind}` },
      { $group: { _id: null, max: { $max: `$${kind}.id` } } },
    ]).toArray();
    highest[spec.counter] = row?.max ?? 0;
  }
  for (const [sequence, max] of Object.entries(highest)) {
    await db.collection('counters').updateOne({ _id: sequence }, { $max: { seq: max } }, { upsert: true });
  }
  return highest;
}

/** Runs a database command (e.g. `{ validate: 'vouchers' }`). */
export function runCommand(command) {
  if (!db) throw new Error('Database not connected');
  return db.command(command);
}

/** Raw collection access, for the rare query the helpers below do not cover. */
export function col(name) {
  if (!db) throw new Error('Database not connected');
  return db.collection(name);
}

// ------------------------------------------------------------------ helpers

const ctx = () => txStore.getStore();
const withSession = (options = {}) => {
  const session = ctx()?.session;
  return session ? { ...options, session } : options;
};
const recordUndo = (step) => ctx()?.undo?.push(step);

const HIDE_ID = { _id: 0 };

/** Documents matching `filter`, without MongoDB's `_id`. */
export function find(name, filter = {}, { sort, limit, project } = {}) {
  let cursor = col(name).find(filter, withSession({ projection: { ...HIDE_ID, ...project } }));
  if (sort) cursor = cursor.sort(sort);
  if (limit) cursor = cursor.limit(Number(limit));
  return cursor.toArray();
}

export function findOne(name, filter = {}, { sort, project } = {}) {
  return col(name).findOne(filter, withSession({ projection: { ...HIDE_ID, ...project }, sort }));
}

export async function exists(name, filter) {
  return Boolean(await col(name).findOne(filter, withSession({ projection: { _id: 1 } })));
}

export function count(name, filter = {}) {
  return col(name).countDocuments(filter, withSession());
}

export function aggregate(name, pipeline) {
  return col(name).aggregate(pipeline, withSession()).toArray();
}

/**
 * `id -> field` for the given ids in one query - the stand-in for a JOIN that
 * only wants a display name.
 */
export async function namesById(name, ids, field = 'name') {
  const wanted = [...new Set(ids.filter((v) => v != null).map(Number))];
  const map = new Map();
  if (!wanted.length) return map;
  const rows = await find(name, { id: { $in: wanted } }, { project: { id: 1, [field]: 1 } });
  for (const r of rows) map.set(r.id, r[field]);
  return map;
}

/** Values of `field` for the documents matching `filter`. */
export function distinct(name, field, filter = {}) {
  return col(name).distinct(field, filter, withSession());
}

/**
 * Reserves `n` consecutive ids for a collection and returns the first. Ids are
 * never handed out twice, even if the write that wanted them is rolled back -
 * the same as an IDENTITY column.
 */
export async function nextIds(sequence, n = 1) {
  const doc = await col('counters').findOneAndUpdate(
    { _id: sequence },
    { $inc: { seq: n } },
    { upsert: true, returnDocument: 'after' },
  );
  return doc.seq - n + 1;
}

/** Inserts one row and returns its new id. */
export async function insert(name, data) {
  const spec = specOf(name);
  const id = spec.noId ? null : await nextIds(name);
  const doc = build(name, spec.fields, data, id);
  await col(name).insertOne(doc, withSession());
  recordUndo(() => col(name).deleteOne({ _id: doc._id }));
  return id;
}

/** Inserts many rows of one collection; returns their ids in order. */
export async function insertMany(name, rows) {
  if (!rows.length) return [];
  const spec = specOf(name);
  const first = spec.noId ? null : await nextIds(name, rows.length);
  const docs = rows.map((row, i) => build(name, spec.fields, row, spec.noId ? null : first + i));
  await col(name).insertMany(docs, withSession({ ordered: true }));
  recordUndo(() => col(name).deleteMany({ _id: { $in: docs.map((d) => d._id) } }));
  return docs.map((d) => d.id ?? null);
}

/**
 * Inserts rows that already carry their ids (migrations and dump loads). The
 * schema still applies; call syncCounters() afterwards.
 */
export async function importRows(name, rows) {
  if (!rows.length) return 0;
  const spec = specOf(name);
  const docs = rows.map((row) => build(name, spec.fields, row, spec.noId ? null : row.id));
  await col(name).insertMany(docs, { ordered: true });
  return docs.length;
}

/** Sets fields on the row with this id; returns 1 if it exists, else 0. */
export async function update(name, id, data) {
  return updateWhere(name, { id }, data, { one: true });
}

/** Sets fields on every row matching `filter`; returns how many matched. */
export async function updateWhere(name, filter, data, { one = false } = {}) {
  const set = checkUpdate(name, data);
  if (!Object.keys(set).length) return 0;
  const target = col(name);
  if (ctx()?.undo) {
    const before = await target.find(filter, withSession()).limit(one ? 1 : 0).toArray();
    if (!before.length) return 0;
    await target.updateMany({ _id: { $in: before.map((d) => d._id) } }, { $set: set }, withSession());
    recordUndo(() => restoreDocs(target, before));
    return before.length;
  }
  const res = one
    ? await target.updateOne(filter, { $set: set }, withSession())
    : await target.updateMany(filter, { $set: set }, withSession());
  return res.matchedCount;
}

/** Deletes every row matching `filter`; returns how many were removed. */
export async function remove(name, filter) {
  const target = col(name);
  if (ctx()?.undo) {
    const before = await target.find(filter, withSession()).toArray();
    if (!before.length) return 0;
    await target.deleteMany({ _id: { $in: before.map((d) => d._id) } }, withSession());
    recordUndo(() => target.insertMany(before));
    return before.length;
  }
  const res = await target.deleteMany(filter, withSession());
  return res.deletedCount;
}

async function restoreDocs(target, docs) {
  if (!docs.length) return;
  await target.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d } })));
}

/**
 * Builds embedded voucher lines (`entries`, `inventory`, `bills`) with
 * defaults applied and fresh ids. Rows that already carry an `id` keep it.
 */
export async function buildChildren(kind, rows) {
  const spec = CHILDREN[kind];
  if (!spec) throw new Error(`Unknown voucher line kind "${kind}"`);
  const fresh = rows.filter((r) => r.id == null).length;
  let next = fresh ? await nextIds(spec.counter, fresh) : 0;
  return rows.map((row) => {
    const { id, ...rest } = row;
    return build(`voucher ${kind}`, spec.fields, rest, id ?? next++);
  });
}

/**
 * Runs `fn` so that its writes either all happen or none do. Nested calls
 * join the transaction already in progress.
 */
export async function transaction(fn) {
  if (ctx()) return fn();

  if (transactionsSupported) {
    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await txStore.run({ session }, fn);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  const state = { undo: [] };
  try {
    return await txStore.run(state, fn);
  } catch (err) {
    for (const step of state.undo.reverse()) {
      try {
        await step();
      } catch (undoErr) {
        console.error('Rollback step failed:', undoErr);
      }
    }
    throw err;
  }
}

/** A case-insensitive "contains" match, like SQL's LIKE '%text%'. */
export function contains(text) {
  return { $regex: String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

// ------------------------------------------------------------------- schema

function specOf(name) {
  const spec = COLLECTIONS[name];
  if (!spec) throw new Error(`Unknown collection "${name}"`);
  return spec;
}

/** A new document in schema field order, defaults filled in, rules checked. */
function build(name, fields, data, id) {
  for (const key of Object.keys(data)) {
    if (key !== 'id' && !(key in fields)) throw new Error(`Unknown field "${key}" for ${name}`);
  }
  const doc = id == null ? {} : { id };
  for (const [key, def] of Object.entries(fields)) {
    let value = data[key];
    if (value === undefined) {
      if (def === REQUIRED) throw badRequest('A required field was left empty.', { field: key, collection: name });
      value = typeof def === 'function' ? def() : def;
    }
    if (value === null && def !== null) {
      throw badRequest('A required field was left empty.', { field: key, collection: name });
    }
    doc[key] = value;
  }
  return doc;
}

function checkUpdate(name, data) {
  const { fields } = specOf(name);
  const set = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!(key in fields)) throw new Error(`Unknown field "${key}" for ${name}`);
    if (value === null && fields[key] !== null) {
      throw badRequest('A required field was left empty.', { field: key, collection: name });
    }
    set[key] = value;
  }
  return set;
}
