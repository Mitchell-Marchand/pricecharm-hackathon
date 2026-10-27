import 'dotenv/config';
import { createApp } from './app.js';
import { closeDatabase } from './db.js';
import { flushErrorReports, startErrorReporting } from './error-reporting.js';

startErrorReporting('api');

const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || '127.0.0.1';
const server = createApp().listen(port, host, () => {
  console.info(`PriceCharm API listening on http://${host}:${port}`);
});
server.requestTimeout = 90_000;
server.headersTimeout = 65_000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    void closeDatabase().finally(() => process.exit(1));
  }, 35_000);
  deadline.unref();
  server.close(async () => {
    clearTimeout(deadline);
    await closeDatabase();
    await flushErrorReports();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
