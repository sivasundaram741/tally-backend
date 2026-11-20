import { find, aggregate, contains } from '../db/index.js';
import { hydrate, parseStored, compareVersions, historyFor } from '../lib/editlog.js';
import { toNum } from '../lib/http.js';
import { MASTERS } from './masters.js';

/** A query-string value as a plain string (never an object/operator). */
const str = (v) => (v == null || typeof v === 'object' ? '' : String(v));

/**
 * `logged_at` is `yyyy-mm-dd hh:mm:ss`; filtering on its date part is a range
 * on the full text. The upper bound sorts after any time on the `to` day.
 */
function loggedRange(q) {
  const from = str(q.from);
  const to = str(q.to);
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = `${to} 99:99:99`;
  return { logged_at: range };
}

/** Flat Edit Log listing with the filters the report offers. */
export async function listLog(companyId, q = {}) {
  const filter = { company_id: companyId, ...loggedRange(q) };
  if (str(q.action)) filter.action = str(q.action);
  if (str(q.kind)) filter.entity_kind = str(q.kind);
  if (str(q.entityType)) filter.entity_type = str(q.entityType);
  if (str(q.entityId)) filter.entity_id = toNum(q.entityId);
  if (str(q.user)) filter.username = str(q.user);
  if (str(q.voucherType)) filter.voucher_type = str(q.voucherType);
  if (str(q.search)) {
    const s = contains(str(q.search));
    filter.$or = [{ entity_name: s }, { entity_label: s }, { voucher_number: s }, { username: s }];
  }
  // The list view only needs a summary; full snapshots are fetched per entity.
  const rows = await find('edit_log', filter, {
    sort: { logged_at: -1, id: -1 },
    limit: toNum(q.limit, 500),
    project: {
      id: 1, entity_type: 1, entity_kind: 1, entity_id: 1, entity_name: 1, entity_label: 1,
      action: 1, version_no: 1, username: 1, machine: 1, ip_address: 1, logged_at: 1,
      voucher_date: 1, voucher_type: 1, voucher_number: 1, amount: 1, changes: 1,
    },
  });
  return rows.map((r) => {
    const changes = parseStored(r.changes, []);
    const { changes: _drop, ...rest } = r;
    return {
      ...rest,
      changeCount: changes.length,
      changedFields: changes.slice(0, 4).map((c) => c.field),
    };
  });
}

/**
 * Edit Log Summary - one row per voucher type / master type with the number of
 * entities created, altered, deleted and the total version count.
 */
export async function summary(companyId, q = {}) {
  const groups = await aggregate('edit_log', [
    { $match: { company_id: companyId, ...loggedRange(q) } },
    {
      $group: {
        _id: {
          entity_kind: '$entity_kind',
          entity_type: '$entity_type',
          bucket: { $cond: [{ $eq: ['$entity_kind', 'Voucher'] }, '$voucher_type', '$entity_type'] },
          action: '$action',
        },
        events: { $sum: 1 },
        ids: { $addToSet: '$entity_id' },
      },
    },
  ]);
  const rows = groups.map((g) => ({ ...g._id, events: g.events, entities: g.ids.length }));

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
  const match = { company_id: companyId, ...loggedRange(q) };
  if (str(q.kind)) match.entity_kind = str(q.kind);
  if (str(q.entityType)) match.entity_type = str(q.entityType);
  if (str(q.voucherType)) match.voucher_type = str(q.voucherType);

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { entity_kind: '$entity_kind', entity_type: '$entity_type', entity_id: '$entity_id' },
        entity_label: { $max: '$entity_label' },
        entity_name: { $max: '$entity_name' },
        voucher_type: { $max: '$voucher_type' },
        voucher_number: { $max: '$voucher_number' },
        voucher_date: { $max: '$voucher_date' },
        amount: { $max: '$amount' },
        versions: { $sum: 1 },
        first_at: { $min: '$logged_at' },
        last_at: { $max: '$logged_at' },
        alterations: { $sum: { $cond: [{ $eq: ['$action', 'Altered'] }, 1, 0] } },
        deletions: { $sum: { $cond: [{ $eq: ['$action', 'Deleted'] }, 1, 0] } },
        cancellations: { $sum: { $cond: [{ $eq: ['$action', 'Cancelled'] }, 1, 0] } },
        last_log_id: { $max: '$id' },
      },
    },
    // timestamps have one-second resolution; the latest log entry breaks ties
    { $sort: { last_at: -1, last_log_id: -1 } },
  ];
  let rows = (await aggregate('edit_log', pipeline))
    .map(({ _id, last_log_id: _tie, ...r }) => ({ ..._id, ...r }));

  // the latest action for every entity, and which entities were ever altered
  const latest = await aggregate('edit_log', [
    { $match: { company_id: companyId } },
    { $sort: { id: -1 } },
    {
      $group: {
        _id: { entity_type: '$entity_type', entity_id: '$entity_id' },
        action: { $first: '$action' },
        username: { $first: '$username' },
        altered: { $max: { $cond: [{ $eq: ['$action', 'Altered'] }, 1, 0] } },
      },
    },
  ]);
  const byEntity = new Map(latest.map((r) => [`${r._id.entity_type}:${r._id.entity_id}`, r]));

  if (str(q.onlyAltered)) {
    rows = rows.filter((r) => byEntity.get(`${r.entity_type}:${r.entity_id}`)?.altered);
  }

  return rows.slice(0, toNum(q.limit, 400)).map((r) => {
    const last = byEntity.get(`${r.entity_type}:${r.entity_id}`);
    return { ...r, lastAction: last ? { action: last.action, username: last.username } : null };
  });
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
  const rows = await aggregate('edit_log', [
    { $match: { company_id: companyId } },
    { $group: { _id: '$username', events: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ username: r._id, events: r.events }));
}

function titleise(s) {
  return String(s).split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
