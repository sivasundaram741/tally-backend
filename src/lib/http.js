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
 * Turns a MongoDB failure into something a bookkeeper can act on. Anything
 * unrecognised is passed through untouched.
 */
export function translateDbError(err) {
  switch (err?.code) {
    case 11000: // duplicate key on a unique index
      return new ApiError(409, 'A record with that name already exists.');
    case 112: // write conflict between two transactions
      return new ApiError(409, 'The database was busy with another change. Please try again.');
    default:
      return err;
  }
}
