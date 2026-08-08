import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';
import { env } from './env.js';

const app = await buildApp();

/**
 * Graceful shutdown matters more here than in a typical HTTP service: the
 * gateway processes hold LISTEN connections to the same database, and an
 * abrupt exit leaves presence rows claiming users are online. 10s is enough to
 * drain in-flight requests without holding up a rolling deploy.
 */
closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  if (err) app.log.error({ err }, 'shutting down after error');
  else app.log.info({ signal }, 'shutting down');
  await app.close();
});

try {
  await app.listen({ port: env.API_PORT, host: env.HOST });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
