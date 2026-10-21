export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, msg, details);
export const notFound = (msg = 'Not found') => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);
export const unauthorized = (msg = 'Unauthorised') => new ApiError(401, msg);

/** Wraps an async route handler so rejections reach the error middleware. */
export const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`);
}

export function toNum(v, fallback = 0) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

export function toBool(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  const s = String(v).toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' ? 1 : 0;
}

export function toStr(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

/** Round to 2dp, avoiding float dust. */
export function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Turns a SQL Server constraint failure into something a bookkeeper can act
 * on. Anything unrecognised is passed through untouched.
 */
export function translateDbError(err) {
  const number = err?.number ?? err?.originalError?.info?.number;
  const text = String(err?.message || '');

  switch (number) {
    case 547:
      return /DELETE/i.test(text)
        ? new ApiError(409, 'This record is still referenced elsewhere and cannot be removed.')
        : new ApiError(400, 'That reference does not exist. Pick an existing record from the list.');
    case 2627:
    case 2601:
      return new ApiError(409, 'A record with that name already exists.');
    case 515:
      return new ApiError(400, 'A required field was left empty.');
    case 8152:
    case 2628:
      return new ApiError(400, 'One of the values is longer than the field allows.');
    case 1205:
      return new ApiError(409, 'The database was busy with another change. Please try again.');
    default:
      return err;
  }
}
