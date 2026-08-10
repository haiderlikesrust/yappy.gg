import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { API_VERSION } from '@yappy/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { corsOrigins, env, isProd } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { corePlugin } from './plugins/core.js';
import { errorsPlugin } from './plugins/errors.js';
import { servicesPlugin } from './plugins/services.js';
import { yapperJobsPlugin } from './plugins/yapperJobs.js';
import { authRoutes } from './routes/auth.js';
import { callRoutes } from './routes/calls.js';
import { conversationRoutes } from './routes/conversations.js';
import { deviceRoutes } from './routes/devices.js';
import { gifRoutes } from './routes/gifs.js';
import { keyRoutes } from './routes/keys.js';
import { botRoutes } from './routes/bots.js';
import { mediaRoutes } from './routes/media.js';
import { messageRoutes } from './routes/messages.js';
import { metaRoutes } from './routes/meta.js';
import { moderationRoutes } from './routes/moderation.js';
import { roleRoutes } from './routes/roles.js';
import { portalRoutes } from './routes/portal.js';
import { emojiRoutes } from './routes/emojis.js';
import { syncYapperCommands } from './lib/yapper.js';
import { spaceRoutes } from './routes/spaces.js';
import { searchRoutes } from './routes/search.js';
import { socialRoutes } from './routes/social.js';
import { stickerRoutes } from './routes/stickers.js';
import { syncRoutes } from './routes/sync.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(isProd
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
      redact: {
        // These end up in logs by accident more often than anyone expects.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.token',
          'req.body.idToken',
          'req.body.refreshToken',
          'req.body.code',
          'req.body.phone',
          // A password reaching the log is a password sitting in plaintext in
          // whatever aggregates them, for as long as retention keeps it. The
          // hashing in lib/passwords.ts is pointless without this line.
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
        ],
        censor: '[redacted]',
      },
    },
    // Behind a load balancer, otherwise every client shares the proxy's IP and
    // IP-scoped rate limits become useless.
    trustProxy: true,
    bodyLimit: 1_048_576, // 1 MB — uploads go direct to S3, never through here
    requestTimeout: 30_000,
    disableRequestLogging: isProd,
    genReqId: () => crypto.randomUUID(),
  });

  /**
   * Treat an empty body as `{}` rather than a 400.
   *
   * Plenty of HTTP clients — including OkHttp/Retrofit on Android and URLSession
   * on iOS — set `Content-Type: application/json` on every request, body or
   * not. Fastify's default parser rejects that with "Body cannot be empty",
   * which turns every bodyless POST (`/auth/gateway-ticket`, `/social/follow/:id`,
   * `/conversations/:id/pins/:messageId`) into a client-side puzzle.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string, done) => {
      if (body === '' || body === undefined) return done(null, {});
      /**
       * Inbound webhooks are signed over the bytes as sent, and those bytes do
       * not survive a parse/re-serialise round trip — key order and unicode
       * escaping are both free to change. This is the only place the raw string
       * still exists, so the signed routes get a reference to it.
       *
       * Scoped by prefix rather than kept for everything: holding a second copy
       * of every request body for the life of the request costs real memory at
       * a 1 MB limit, and exactly one route needs it.
       */
      if (req.url.startsWith('/v1/webhooks/')) req.rawBody = body;
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    maxAge: 86_400,
  });

  await app.register(errorsPlugin);
  await app.register(corePlugin);
  await app.register(authPlugin);
  await app.register(servicesPlugin);
  // Registered after services because its handlers post through app.messages.
  await app.register(yapperJobsPlugin);

  app.get('/health', async () => ({
    ok: true,
    service: 'api',
    version: API_VERSION,
    time: new Date().toISOString(),
  }));

  // Readiness is distinct from liveness: a pod that cannot reach Postgres must
  // leave the load balancer rotation but must not be restarted.
  app.get('/ready', async (_req, reply) => {
    try {
      await app.sql`select 1`;
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(userRoutes, { prefix: '/users' });
      await v1.register(socialRoutes, { prefix: '/social' });
      await v1.register(conversationRoutes, { prefix: '/conversations' });
      await v1.register(messageRoutes, { prefix: '/conversations' });
      await v1.register(roleRoutes, { prefix: '/conversations' });
      await v1.register(spaceRoutes, { prefix: '/conversations' });
      await v1.register(emojiRoutes, { prefix: '/conversations' });
      await v1.register(mediaRoutes, { prefix: '/media' });
      await v1.register(stickerRoutes, { prefix: '/stickers' });
      await v1.register(gifRoutes, { prefix: '/gifs' });
      await v1.register(callRoutes, { prefix: '/calls' });
      await v1.register(syncRoutes, { prefix: '/sync' });
      await v1.register(searchRoutes, { prefix: '/search' });
      await v1.register(deviceRoutes, { prefix: '/devices' });
      await v1.register(moderationRoutes, { prefix: '/moderation' });
      await v1.register(keyRoutes, { prefix: '/keys' });
      // Unauthenticated: a client needs the version floor before it can sign in.
      await v1.register(metaRoutes, { prefix: '/meta' });
      await v1.register(botRoutes, { prefix: '/apps' });
      await v1.register(portalRoutes, { prefix: '/portal' });
      // Unauthenticated by design — signature-verified instead. The prefix is
      // load-bearing: the JSON parser keys raw-body capture off it.
      await v1.register(webhookRoutes, { prefix: '/webhooks' });
    },
    { prefix: '/v1' },
  );

  // yapper's command list is declared next to the code that implements it, and
  // published here so the composer can read it like any other bot's. Failing
  // to publish must not stop the API booting: the commands are a convenience,
  // and typing them by hand still works.
  app.ready(() => {
    void syncYapperCommands(app).catch((err) =>
      app.log.warn({ err }, 'could not publish yapper commands'),
    );
  });

  return app;
}
