import { Gateway } from './server.js';

const gateway = new Gateway();
await gateway.start();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`gateway shutting down (${signal})`);
  await gateway.stop().catch((err) => console.error(err));
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A rejected promise that reaches here means a bug, not a transient failure.
// Log it loudly rather than letting Node's default kill the process silently.
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection', err);
});
