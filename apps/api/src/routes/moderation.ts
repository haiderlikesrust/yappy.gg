import { and, conversations, eq, messages, reports, users } from '@yappy/db';
import { newId, notFound, reportBody } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

export async function moderationRoutes(app: FastifyInstance) {
  /**
   * Report content.
   *
   * The evidence snapshot is the important part: a report whose subject has
   * already deleted the message is unactionable, and deleting the evidence is
   * the first thing a bad actor does. We freeze a copy at report time.
   */
  app.post('/reports', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = reportBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'report.create');

    let evidence: Record<string, unknown> = {};

    if (body.targetType === 'message') {
      const [row] = await app.db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          senderId: messages.senderId,
          type: messages.type,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.id, body.targetId))
        .limit(1);
      if (!row) throw notFound('Message');
      evidence = { message: { ...row, createdAt: row.createdAt.toISOString() } };

      // A handful of surrounding messages so a moderator can judge context —
      // a single line out of an argument reads very differently on its own.
      const context = await app.db
        .select({ id: messages.id, senderId: messages.senderId, content: messages.content, seq: messages.seq })
        .from(messages)
        .where(eq(messages.conversationId, row.conversationId))
        .limit(20);
      evidence.context = context;
    } else if (body.targetType === 'user') {
      const [row] = await app.db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          bio: users.bio,
        })
        .from(users)
        .where(eq(users.id, body.targetId))
        .limit(1);
      if (!row) throw notFound('User');
      evidence = { user: row };
    } else if (body.targetType === 'conversation') {
      const [row] = await app.db
        .select({
          id: conversations.id,
          title: conversations.title,
          description: conversations.description,
          memberCount: conversations.memberCount,
        })
        .from(conversations)
        .where(eq(conversations.id, body.targetId))
        .limit(1);
      if (!row) throw notFound('Conversation');
      evidence = { conversation: row };
    }

    // CSAM and credible self-harm jump the queue unconditionally.
    const priority = body.reason === 'csam' ? 100 : body.reason === 'self_harm' ? 80 : 0;

    const [report] = await app.db
      .insert(reports)
      .values({
        id: newId(),
        reporterId: req.user.id,
        targetType: body.targetType,
        targetId: body.targetId,
        reason: body.reason,
        detail: body.detail ?? null,
        evidence,
        priority,
      })
      .returning();

    await app.enqueue('moderation.triage', { reportId: report!.id, reason: body.reason });

    return reply.status(201).send({
      reportId: report!.id,
      // Deliberately vague: telling a reporter what happened to the reported
      // account tells a harasser whether their target reported them.
      message: 'Thanks — our team will review this.',
    });
  });

  app.get('/reports/mine', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = await app.db
      .select({
        id: reports.id,
        targetType: reports.targetType,
        reason: reports.reason,
        status: reports.status,
        createdAt: reports.createdAt,
      })
      .from(reports)
      .where(eq(reports.reporterId, req.user.id))
      .limit(50);

    return reply.send({
      reports: rows.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        reason: r.reason,
        // Collapse internal states — reporters see resolved or not.
        status: r.status === 'open' || r.status === 'reviewing' ? 'reviewing' : 'resolved',
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });
}
