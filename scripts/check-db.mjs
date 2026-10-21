// Connectivity probe: confirms the instance is reachable and reports whether
// the target database exists. Prints no credentials.
process.loadEnvFile(new URL('../.env', import.meta.url));
const sql = (await import('mssql')).default;

const cfg = {
  server: process.env.SQLSERVER_HOST,
  user: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  database: 'master',
  options: {
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    encrypt: process.env.SQLSERVER_ENCRYPT !== 'false',
    trustServerCertificate: process.env.SQLSERVER_TRUST_CERT !== 'false',
    enableArithAbort: true,
  },
  pool: { max: 4, min: 0, idleTimeoutMillis: 10000 },
  connectionTimeout: 12000,
  requestTimeout: 30000,
};
if (process.env.SQLSERVER_PORT) {
  cfg.port = Number(process.env.SQLSERVER_PORT);
  delete cfg.options.instanceName;
}

try {
  const pool = await new sql.ConnectionPool(cfg).connect();
  const v = await pool.request().query(
    "SELECT @@VERSION AS version, SERVERPROPERTY('ProductVersion') AS product, DB_NAME() AS db",
  );
  console.log('connected OK');
  console.log('  server :', String(v.recordset[0].version).split('\n')[0].trim());
  console.log('  product:', v.recordset[0].product);
  console.log('  context:', v.recordset[0].db);

  const target = process.env.SQLSERVER_DATABASE;
  const exists = await pool
    .request()
    .input('n', target)
    .query('SELECT DB_ID(@n) AS id');
  console.log(`  database "${target}" exists:`, exists.recordset[0].id != null);

  const perm = await pool.request().query("SELECT IS_SRVROLEMEMBER('sysadmin') AS sysadmin");
  console.log('  sysadmin:', perm.recordset[0].sysadmin === 1);

  await pool.close();
} catch (err) {
  console.error('connection FAILED');
  console.error('  code   :', err.code || '(none)');
  console.error('  message:', String(err.message).replace(/password[^;]*/gi, 'password=***'));
  process.exitCode = 1;
}
