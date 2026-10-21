import { all } from '../db/index.js';
import { hydrate, compareVersions, historyFor } from '../lib/editlog.js';
import { toNum } from '../lib/http.js';
import { MASTERS } from './masters.js';

/** Flat Edit Log listing with the filters the report offers. */
export async function listLog(companyId, q = {}) {
  const where = ['company_id = ?'];
  const params = [companyId];
  if (q.from) { where.push('LEFT(logged_at, 10) >= ?'); params.push(q.from); }
  if (q.to) { where.push('LEFT(logged_at, 10) <= ?'); params.push(q.to); }
  if (q.action) { where.push('action = ?'); params.push(q.action); }
  if (q.kind) { where.push('entity_kind = ?'); params.push(q.kind); }
  if (q.entityType) { where.push('entity_type = ?'); params.push(q.entityType); }
  if (q.entityId) { where.push('entity_id = ?'); params.push(toNum(q.entityId)); }
  if (q.user) { where.push('username = ?'); params.push(q.user); }
  if (q.voucherType) { where.push('voucher_type = ?'); params.push(q.voucherType); }
  if (q.search) {
    where.push('(entity_name LIKE ? OR entity_label LIKE ? OR voucher_number LIKE ? OR username LIKE ?)');
    const s = `%${q.search}%`;
    params.push(s, s, s, s);
  }
  const limit = toNum(q.limit, 500);
  // The list view only needs a summary; full snapshots are fetched per entity.
  const rows = await all(
    `SELECT id, entity_type, entity_kind, entity_id, entity_name, entity_label,
            action, version_no, username, machine, ip_address, logged_at,
            voucher_date, voucher_type, voucher_number, amount, changes
       FROM edit_log WHERE ${where.join(' AND ')}
      ORDER BY logged_at DESC, id DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map((r) => {
    const changes = safeParse(r.changes, []);
    const { changes: _drop, ...rest } = r;
    return {
      ...rest,
      changeCount: changes.length,
      changedFields: changes.slice(0, 4).map((c) => c.field),
    };
  });
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/**
 * Edit Log Summary - one row per voucher type / master type with the number of
 * entities created, altered, deleted and the total version count.
 */
export async function summary(companyId, q = {}) {
  const where = ['company_id = ?'];
  const params = [companyId];
  if (q.from) { where.push('LEFT(logged_at, 10) >= ?'); params.push(q.from); }
  if (q.to) { where.push('LEFT(logged_at, 10) <= ?'); params.push(q.to); }

  const rows = await all(
    `SELECT entity_kind, entity_type,
            CASE WHEN entity_kind = 'Voucher' THEN voucher_type ELSE entity_type END AS bucket,
            action, COUNT(*) AS events, COUNT(DISTINCT entity_id) AS entities
       FROM edit_log WHERE ${where.join(' AND ')}
      GROUP BY entity_kind, entity_type,
               CASE WHEN entity_kind = 'Voucher' THEN voucher_type ELSE entity_type END,
               action`,
    params,
  );

  const map = new Map();
  for (const r of rows) {
    const label = r.entity_kind === 'Voucher'
      ? (r.bucket || 'Voucher')
      : (MASTERS[r.entity_type]?.label || titleise(r.entity_type));
    const key = `${r.entity_kind}::${label}`;
    const cur = map.get(key) || {
      kind: r.entity_kind,
      entityType: r.entity_type,
      name: label,
      created: 0,
      altered: 0,
      deleted: 0,
      cancelled: 0,
      restored: 0,
      totalEvents: 0,
      entities: 0,
    };
    const bucketKey = r.action.toLowerCase();
    if (bucketKey in cur) cur[bucketKey] += r.events;
    cur.totalEvents += r.events;
    cur.entities = Math.max(cur.entities, r.entities);
    map.set(key, cur);
  }

  const list = [...map.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  return {
    rows: list,
    totals: list.reduce(
      (acc, r) => ({
        created: acc.created + r.created,
        altered: acc.altered + r.altered,
        deleted: acc.deleted + r.deleted,
        cancelled: acc.cancelled + r.cancelled,
        totalEvents: acc.totalEvents + r.totalEvents,
      }),
      { created: 0, altered: 0, deleted: 0, cancelled: 0, totalEvents: 0 },
    ),
  };
}

/**
 * One row per entity that has been touched, with its version count - the
 * drill-down target of the Edit Log Summary.
 */
export async function entities(companyId, q = {}) {
  const where = ['company_id = ?'];
  const params = [companyId];
  if (q.kind) { where.push('entity_kind = ?'); params.push(q.kind); }
  if (q.entityType) { where.push('entity_type = ?'); params.push(q.entityType); }
  if (q.voucherType) { where.push('voucher_type = ?'); params.push(q.voucherType); }
  if (q.from) { where.push('LEFT(logged_at, 10) >= ?'); params.push(q.from); }
  if (q.to) { where.push('LEFT(logged_at, 10) <= ?'); params.push(q.to); }
  if (q.onlyAltered) where.push("entity_id IN (SELECT entity_id FROM edit_log WHERE action = 'Altered')");

  const rows = await all(
    `SELECT entity_kind, entity_type, entity_id,
            MAX(entity_label) AS entity_label,
            MAX(entity_name) AS entity_name,
            MAX(voucher_type) AS voucher_type,
            MAX(voucher_number) AS voucher_number,
            MAX(voucher_date) AS voucher_date,
            MAX(amount) AS amount,
            COUNT(*) AS versions,
            MIN(logged_at) AS first_at,
            MAX(logged_at) AS last_at,
            SUM(CASE WHEN action = 'Altered' THEN 1 ELSE 0 END) AS alterations,
            SUM(CASE WHEN action = 'Deleted' THEN 1 ELSE 0 END) AS deletions,
            SUM(CASE WHEN action = 'Cancelled' THEN 1 ELSE 0 END) AS cancellations
       FROM edit_log WHERE ${where.join(' AND ')}
      GROUP BY entity_kind, entity_type, entity_id
      ORDER BY MAX(logged_at) DESC
      LIMIT ?`,
    [...params, toNum(q.limit, 400)],
  );

  // the latest action for every entity in a single pass
  const latest = await all(
    `SELECT e.entity_type, e.entity_id, e.action, e.username
       FROM edit_log e
       JOIN (
         SELECT entity_type, entity_id, MAX(id) AS mx
           FROM edit_log WHERE company_id = ?
          GROUP BY entity_type, entity_id
       ) m ON m.entity_type = e.entity_type AND m.entity_id = e.entity_id AND m.mx = e.id`,
    [companyId],
  );
  const lastByEntity = new Map(
    latest.map((r) => [`${r.entity_type}:${r.entity_id}`, { action: r.action, username: r.username }]),
  );

  return rows.map((r) => ({
    ...r,
    lastAction: lastByEntity.get(`${r.entity_type}:${r.entity_id}`) || null,
  }));
}

/** Full version history plus a diff against the previous version. */
export async function entityHistory(companyId, entityType, entityId) {
  const rows = await historyFor(companyId, entityType, entityId);
  return rows.map((r, i) => ({
    ...r,
    previousVersion: i > 0 ? rows[i - 1].version_no : null,
  }));
}

export function compare(companyId, entityType, entityId, a, b) {
  return compareVersions(companyId, entityType, entityId, a, b);
}

/** Distinct users that appear in the log, for the filter bar. */
export async function logUsers(companyId) {
  return all(
    'SELECT username, COUNT(*) AS events FROM edit_log WHERE company_id = ? GROUP BY username ORDER BY username',
    [companyId],
  );
}

function titleise(s) {
  return String(s).split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
