import express from 'express';
import cors from 'cors';
import { migrate, dbLabel, close } from './db/index.js';
import { seedAdminUser } from './db/seed.js';
import { attachUser } from './lib/auth.js';
import { ApiError, translateDbError } from './lib/http.js';
import { APP_NAME } from './lib/brand.js';

import companies from './routes/companies.js';
import masters from './routes/masters.js';
import vouchers from './routes/vouchers.js';
import reports from './routes/reports.js';
import editlog from './routes/editlog.js';
import auth from './routes/auth.js';
import demo from './routes/demo.js';
import data from './routes/data.js';

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(cors({ origin: true, exposedHeaders: ['x-company-id'] }));
app.use(express.json({ limit: '50mb' }));
app.use(attachUser);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', product: APP_NAME, engine: 'SQL Server', database: dbLabel() });
});

app.use('/api/auth', auth);
app.use('/api/companies', companies);
app.use('/api/masters', masters);
app.use('/api/vouchers', vouchers);
app.use('/api/reports', reports);
app.use('/api/edit-log', editlog);
app.use('/api/data', data);
app.use('/api/demo', demo);

app.use((req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const mapped = err instanceof ApiError ? err : translateDbError(err);
  const status = mapped instanceof ApiError ? mapped.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: mapped.message || 'Internal error',
    details: mapped.details,
  });
});

async function start() {
  try {
    await migrate();
    await seedAdminUser();
  } catch (err) {
    console.error('\nCould not reach SQL Server.');
    console.error(`  ${err.message}`);
    console.error('\nCheck backend/.env, and that the SQL Browser service is running');
    console.error('for a named instance (or set SQLSERVER_PORT).\n');
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`${APP_NAME} API listening on http://localhost:${PORT}`);
    console.log(`Database: ${dbLabel()}`);
  });

  const shutdown = async () => {
    server.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
