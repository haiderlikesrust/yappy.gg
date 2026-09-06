import { createHash, randomBytes } from 'node:crypto';
import { AppError, ErrorCode, conflict } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { readAppealContext } from '../lib/support.js';

const categories = { bug: 'Report a bug', account: 'Account help', appeal: 'Suspension appeal', other: 'Something else' } as const;
const intake = z.object({
  requestId: z.string().uuid(),
  category: z.enum(['bug', 'account', 'appeal', 'other']),
  email: z.string().trim().email().max(254).transform(s => s.toLowerCase()),
  account: z.string().trim().max(80).default(''),
  message: z.string().trim().min(20, 'Please add a little more detail (at least 20 characters).').max(6000),
  client: z.string().trim().max(160).default(''),
  appealToken: z.string().max(2000).optional(),
}).strict();
const contextBody = z.object({ appealToken: z.string().min(1).max(2000) }).strict();
const mailbox = () => z.string().email().safeParse(env.SUPPORT_EMAIL).success ? env.SUPPORT_EMAIL : null;

export async function supportRoutes(app: FastifyInstance) {
  app.get('/config', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { available: mailbox() !== null, email: mailbox() };
  });

  // This capability reads only the case's reference and account handle. It
  // never creates devices, changes moderation, or authenticates the requester.
  app.post('/appeal-context', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    await app.limiter.consume(`ip:${req.ip}`, 'support.context');
    const { appealToken } = contextBody.parse(req.body);
    const context = await readAppealContext(app, appealToken);
    return { caseReference: context.reportId.slice(0, 8), account: context.username ?? '' };
  });

  app.post('/tickets', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = intake.parse(req.body);
    const recipient = mailbox();
    if (!recipient) throw new AppError(503, ErrorCode.Internal, 'The support form is temporarily unavailable. Please try again later.');
    await app.limiter.consume(`ip:${req.ip}`, 'support.submit');
    await app.limiter.consume(`support:${createHash('sha256').update(body.email).digest('hex')}`, 'support.submit');
    const context = body.appealToken ? await readAppealContext(app, body.appealToken) : null;
    if (context && body.category !== 'appeal') throw conflict('Use the suspension appeal topic with this link.');
    const values = {
      category: body.category, email: body.email, account: body.account, message: body.message,
      client: body.client, userId: context?.userId ?? null, reportId: context?.reportId ?? null,
    };
    const payloadHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');

    const ticket = await app.sql.begin(async tx => {
      const reference = `SUP-${randomBytes(6).toString('hex').toUpperCase()}`;
      const inserted = await tx`insert into support_tickets
        (id, reference, request_id, payload_hash, category, contact_email, account_hint, message, verified_user_id, report_id, client)
        values (gen_random_uuid(), ${reference}, ${body.requestId}, ${payloadHash}, ${body.category}, ${body.email},
          ${body.account || null}, ${body.message}, ${context?.userId ?? null}, ${context?.reportId ?? null}, ${body.client || null})
        on conflict (request_id) do nothing returning reference`;
      if (!inserted.length) {
        const [existing] = await tx`select reference, payload_hash from support_tickets where request_id = ${body.requestId}`;
        if (!existing || existing.payload_hash !== payloadHash) throw conflict('This submission was already used. Please start a new request.');
        return { reference: existing.reference as string };
      }

      // Save the ticket and queue delivery in the SAME transaction. A queue
      // failure rolls back intake; a retry cannot silently lose or duplicate it.
      const queued = await app.boss.send('email.send', {
        to: recipient, replyTo: body.email,
        subject: `[${reference}] ${categories[body.category]}`,
        text: [
          `${reference} — ${categories[body.category]}`,
          `Reply address: ${body.email} (provided by requester)`,
          `Account supplied: ${body.account || 'Not supplied'}`,
          ...(context ? [`Linked appeal account: ${context.username ?? context.userId}`, `Moderation report: ${context.reportId}`] : []),
          'The reply address is supplied by the requester, not verified. Verify account ownership before disclosing private details or changing access.',
          `App details: ${body.client || 'Not supplied'}`, '', body.message, '',
          'Reply to this email to answer the requester. Keep the ticket reference in the subject.',
        ].join('\n'),
      }, {
        retryLimit: 10, retryBackoff: true, expireInSeconds: 3600,
        db: { executeSql: async (text, parameters) => ({ rows: await tx.unsafe(text,
          // pg-boss normally uses node-postgres, which serializes JSON objects.
          // Its transactional postgres.js adapter must do that explicitly.
          parameters?.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value),
        ) }) },
      });
      if (!queued) throw new Error('Support email was not queued');
      return { reference };
    });
    return reply.status(201).send({ ticket, replyBy: 'email' });
  });
}
