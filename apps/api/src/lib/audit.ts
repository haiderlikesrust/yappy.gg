import { conversationAuditLog } from '@yappy/db';
import { newId } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * One admin action, written down.
 *
 * The account-security `audit_log` cannot carry these: it is shaped around a
 * user and an IP, with no conversation to hang an entry on. This stream is the
 * other kind of accountability — who changed what *in a group* — and it exists
 * because the moment two admins disagree, "who hid that channel" needs an
 * answer better than memory.
 */
export interface AuditEntry {
  /**
   * The container the entry belongs to — always the space or group, never a
   * channel. Channel-scoped actions (an overwrite, a deletion) log against the
   * space with the channel in `targetId`, so a space has one stream rather
   * than one per room, which is how anyone would actually read it.
   */
  conversationId: string;
  actorId: string;
  /** Dotted, stable, lowercase: `role.create`, `member.kicked`, … */
  action: string;
  /** The person acted on, when the action is about a person. */
  targetUserId?: string | null;
  /** The object acted on — a role id, a channel id, an invite code. */
  targetId?: string | null;
  /**
   * Denormalised labels, snapshotted at write time — the role's name, the
   * channel's title. Deliberately copied rather than joined at read time: an
   * audit entry is about what happened *then*, and the role it names may be
   * renamed or gone by the time anyone reads it.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Write an entry, and never let it take the action down with it.
 *
 * The mutation this records has already succeeded; failing the request now
 * would undo nothing and punish the user for our bookkeeping. But a silent
 * miss would quietly rot the log's one promise, so the failure is logged at
 * error level where an operator will meet it.
 */
export async function logAudit(app: FastifyInstance, entry: AuditEntry): Promise<void> {
  try {
    await app.db.insert(conversationAuditLog).values({
      id: newId(),
      conversationId: entry.conversationId,
      actorId: entry.actorId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    app.log.error({ err, entry }, 'audit write failed');
  }
}
