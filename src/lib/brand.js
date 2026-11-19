/**
 * Product name used in messages and the health check. Set APP_NAME in
 * backend/.env. Display only: the database name, the backup format tag and
 * stored data keep their original `ledgertrail` identifiers.
 */
export const APP_NAME = process.env.APP_NAME?.trim() || 'Catchu Ledger Trail';
