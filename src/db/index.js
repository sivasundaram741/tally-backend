import sql from 'mssql';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SCHEMA } from './schema.js';
import { APP_NAME } from '../lib/brand.js';

/**
 * SQL Server data layer.
 *
 * The helpers keep the shape the services already use - `get`, `all`, `run`,
 * `insert`, `update`, `transaction` - but every one is async. Queries are
 * written with `?` placeholders and a light translator turns them into the
 * named parameters and T-SQL paging that SQL Server expects.
 */

const txStore = new AsyncLocalStorage();
let pool = null;

function baseConfig(database) {
  const cfg = {
    server: process.env.SQLSERVER_HOST || 'localhost',
    user: process.env.SQLSERVER_USER,
    password: process.env.SQLSERVER_PASSWORD,
    database,
    options: {
      instanceName: process.env.SQLSERVER_INSTANCE || undefined,
      encrypt: process.env.SQLSERVER_ENCRYPT !== 'false',
      trustServerCertificate: process.env.SQLSERVER_TRUST_CERT !== 'false',
      enableArithAbort: true,
      appName: APP_NAME,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 120000,
  };
  if (process.env.SQLSERVER_PORT) {
    cfg.port = Number(process.env.SQLSERVER_PORT);
    delete cfg.options.instanceName;
  }
  return cfg;
}

export const databaseName = () => process.env.SQLSERVER_DATABASE || 'LedgerTrail';

export function dbLabel() {
  const host = process.env.SQLSERVER_HOST || 'localhost';
  const inst = process.env.SQLSERVER_INSTANCE ? `\\${process.env.SQLSERVER_INSTANCE}` : '';
  return `${host}${inst} / ${databaseName()}`;
}

/** Creates the application database if this is a first run. */
async function ensureDatabase() {
  const name = databaseName();
  const admin = await new sql.ConnectionPool(baseConfig('master')).connect();
  try {
    const found = await admin.request().input('n', name).query('SELECT DB_ID(@n) AS id');
    if (found.recordset[0].id == null) {
      await admin.request().query(`CREATE DATABASE [${name.replace(/]/g, ']]')}]`);
      console.log(`Created database [${name}]`);
    }
  } finally {
    await admin.close();
  }
}

export async function connect() {
  if (pool) return pool;
  await ensureDatabase();
  pool = await new sql.ConnectionPool(baseConfig(databaseName())).connect();
  return pool;
}

export async function close() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

/** Runs every DDL statement, each guarded so re-running is harmless. */
export async function migrate() {
  await connect();
  for (const statement of SCHEMA) {
    await pool.request().query(statement);
  }
}

function currentRequest() {
  const tx = txStore.getStore();
  return tx ? new sql.Request(tx) : pool.request();
}

/**
 * Translates SQLite-flavoured SQL into T-SQL:
 *  - `?` placeholders become @p0, @p1, ...
 *  - `COLLATE NOCASE` is dropped (the server collation is already case
 *    insensitive)
 *  - a trailing `LIMIT n` becomes OFFSET/FETCH when the query is ordered, or
 *    `SELECT TOP (n)` when it is not
 */
export function translate(text) {
  let out = text.replace(/\s+COLLATE\s+NOCASE/gi, '');

  const limit = out.match(/\s+LIMIT\s+(\?|\d+)\s*$/i);
  if (limit) {
    const amount = limit[1];
    out = out.slice(0, limit.index);
    if (/\bORDER\s+BY\b/i.test(out)) {
      out += ` OFFSET 0 ROWS FETCH NEXT ${amount} ROWS ONLY`;
    } else {
      out = out.replace(/^(\s*SELECT)(\s+DISTINCT)?/i, (m) => `${m} TOP (${amount})`);
    }
  }

  let i = 0;
  return out.replace(/\?/g, () => `@p${i++}`);
}

function bind(request, params) {
  params.forEach((value, i) => request.input(`p${i}`, normalise(value)));
}

export async function all(text, params = []) {
  const request = currentRequest();
  bind(request, params);
  const result = await request.query(translate(text));
  return result.recordset ? result.recordset.map((r) => ({ ...r })) : [];
}

export async function get(text, params = []) {
  const rows = await all(text, params);
  return rows[0];
}

export async function run(text, params = []) {
  const request = currentRequest();
  bind(request, params);
  const result = await request.query(translate(text));
  return { changes: result.rowsAffected?.[0] ?? 0 };
}

/** Inserts a row from an object and returns the new identity value. */
export async function insert(table, data) {
  const keys = Object.keys(data);
  if (!keys.length) throw new Error(`insert(${table}) called with no columns`);
  const text = `INSERT INTO ${table} (${keys.map(quote).join(', ')}) `
    + `OUTPUT INSERTED.id VALUES (${keys.map(() => '?').join(', ')})`;
  const request = currentRequest();
  bind(request, keys.map((k) => data[k]));
  const result = await request.query(translate(text));
  return Number(result.recordset[0].id);
}

export async function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return 0;
  const text = `UPDATE ${table} SET ${keys.map((k) => `${quote(k)} = ?`).join(', ')} WHERE id = ?`;
  const request = currentRequest();
  bind(request, [...keys.map((k) => data[k]), id]);
  const result = await request.query(translate(text));
  return result.rowsAffected?.[0] ?? 0;
}

const quote = (col) => `[${col}]`;

/** Only null, numbers, strings and buffers reach the driver. */
export function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/**
 * Runs `fn` inside a transaction. Nested calls join the transaction already in
 * progress rather than starting a second one.
 */
export async function transaction(fn) {
  const existing = txStore.getStore();
  if (existing) return fn();

  const tx = new sql.Transaction(pool);
  await tx.begin();
  let done = false;
  try {
    const result = await txStore.run(tx, fn);
    done = true;
    await tx.commit();
    return result;
  } catch (err) {
    if (!done) {
      try {
        await tx.rollback();
      } catch {
        /* the server may have rolled back already */
      }
    }
    throw err;
  }
}

export { sql };
