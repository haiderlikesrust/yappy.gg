import { and, bugReports, desc, devices, eq, inArray, isNull, media, users } from '@yappy/db';
import { newId, type EmbedInput, type MessageComponentRow } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { getSystemConversationId } from './staffspace.js';
import { Storage } from './storage.js';
import { getYapperUserId } from './yapper.js';

const VIOLET = '#8b7cff';
const GREEN = '#3dd68c';
const AMBER = '#f5a524';
const GREY = '#8b90a0';

/**
 * What staff can say about a bug, and what the reporter is told.
 *
 * Four outcomes rather than open/closed, because "we know" and "that is not a
 * bug" are different answers and a reporter can tell the difference. The one
 * thing none of them is, is silence — a report that vanishes teaches the person
 * who filed it not to file another, which is the only failure mode of a bug
 * tracker that actually matters at this size.
 */
export const BUG_STATUSES = ['open', 'fixed', 'known', 'need_more', 'invalid'] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

export const BUG_STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Open',
  fixed: 'Fixed',
  known: 'Already known',
  need_more: 'Needs more detail',
  invalid: 'Not a bug',
};

/** What the reporter is told, in the second person. */
const BUG_STATUS_MESSAGE: Record<Exclude<BugStatus, 'open'>, string> = {
  fixed: 'Fixed. It will be in the next build — thank you, this one was worth reporting.',
  known: 'Already on the list. Reporting it again was not wasted: it tells us how often it bites.',
  need_more:
    'We need a bit more to go on before we can chase this. Reply here and it reaches the same place.',
  invalid: 'Turns out this one is working as intended. Still worth asking — keep them coming.',
};

/** Which outcomes count as "this person found us a real bug". */
const ACCEPTED: BugStatus[] = ['fixed', 'known'];

/**
 * Unambiguous alphabet: no O/0, no I/1. A reference exists to be read off a
 * screen and typed somewhere else, and those four characters are where that
 * goes wrong.
 */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newBugReference(): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += REFERENCE_ALPHABET[Math.floor(Math.random() * REFERENCE_ALPHABET.length)];
  }
  return `BUG-${out}`;
}

/**
 * The build the reporter is actually running.
 *
 * Taken from their most recently active device rather than asked, because the
 * people who file bugs are exactly the people who do not know their build
 * number, and "what version are you on?" is a round trip on every single
 * report. Their newest device is the right guess: someone with a phone and a
 * tablet reported from whichever they just had in their hand.
 */
async function environmentFor(
  app: FastifyInstance,
  userId: string,
): Promise<{ platform: string | null; appVersion: string | null; osVersion: string | null }> {
  const [device] = await app.db
    .select({
      platform: devices.platform,
      appVersion: devices.appVersion,
      osVersion: devices.osVersion,
    })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
    .orderBy(desc(devices.lastActiveAt))
    .limit(1);

  return {
    platform: device?.platform ?? null,
    appVersion: device?.appVersion ?? null,
    osVersion: device?.osVersion ?? null,
  };
}

/** "iOS · 1.3.0 · iOS 18.2", or what is known of it. */
function environmentLabel(env: {
  platform: string | null;
  appVersion: string | null;
  osVersion: string | null;
}): string {
  const parts = [env.platform, env.appVersion, env.osVersion].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Unknown';
}

/**
 * Copy the reporter's proof into media yapper owns.
 *
 * A message may only carry attachments its sender owns — the check that stops
 * anyone attaching someone else's private media by guessing an id. yapper posts
 * the card, so without this the screenshot somebody took is exactly the thing
 * that cannot be shown to the people who need it.
 *
 * Copied, not re-pointed: the two rows then have independent lifecycles, so the
 * reporter deleting their copy does not pull the evidence out of the staff
 * channel. Same reasoning, and the same `copyObject`, as promoting an image
 * into a sticker.
 *
 * Stays in the private bucket. Proof of a bug is a screenshot of somebody's
 * actual app, and there is no version of this where it belongs on a public URL.
 */
async function adoptProof(
  app: FastifyInstance,
  ownerId: string,
  reporterId: string,
  mediaIds: string[],
): Promise<string[]> {
  if (mediaIds.length === 0) return [];

  const sources = await app.db
    .select()
    .from(media)
    .where(and(inArray(media.id, mediaIds), eq(media.ownerId, reporterId), isNull(media.deletedAt)));

  const adopted: string[] = [];
  for (const source of sources) {
    if (!source.confirmedAt || source.status === 'failed' || source.status === 'quarantined') continue;

    const ext = source.objectKey.split('.').pop() ?? 'bin';
    const destBucket = Storage.bucketFor('attachment');
    const destKey = Storage.buildKey('attachment', ownerId, ext);

    try {
      await app.storage.copyObject({
        fromBucket: source.bucket,
        fromKey: source.objectKey,
        toBucket: destBucket,
        toKey: destKey,
        mimeType: source.mimeType,
      });
    } catch (err) {
      // One unreadable attachment must not lose the report. The rest still go.
      app.log.error({ err, media: source.id }, 'bug proof copy failed');
      continue;
    }

    const [copy] = await app.db
      .insert(media)
      .values({
        id: newId(),
        ownerId,
        purpose: 'attachment',
        status: 'ready',
        bucket: destBucket,
        objectKey: destKey,
        mimeType: source.mimeType,
        size: source.size,
        width: source.width,
        height: source.height,
        durationMs: source.durationMs,
        blurhash: source.blurhash,
        confirmedAt: new Date(),
      })
      .returning({ id: media.id });

    if (copy) adopted.push(copy.id);
  }

  return adopted;
}

export interface FileBugInput {
  reporterId: string;
  title: string;
  description: string;
  /** Confirmed media ids. Whatever they attached, all of it. */
  mediaIds?: string[];
}

/**
 * File a bug and put it in front of staff.
 *
 * The row is written first and the card posted after, in that order and
 * deliberately: the card is the part that can fail — the channel may not exist
 * on a fresh install — and somebody's report must not be lost because the
 * place to show it was missing.
 */
export async function fileBugReport(
  app: FastifyInstance,
  input: FileBugInput,
): Promise<{ id: string; reference: string }> {
  const env = await environmentFor(app, input.reporterId);
  const id = newId();

  // Adopted before the row is written, so `mediaIds` holds the copies staff can
  // actually open rather than ids that will 404 for everyone but the reporter.
  const botId = await getYapperUserId(app);
  const mediaIds = botId ? await adoptProof(app, botId, input.reporterId, input.mediaIds ?? []) : [];

  // Four characters is 32^4, which collides often enough at scale to be worth
  // a retry and rarely enough that the retry almost never runs.
  let reference = newBugReference();
  for (let attempt = 0; attempt < 5; attempt++) {
    const [clash] = await app.db
      .select({ id: bugReports.id })
      .from(bugReports)
      .where(eq(bugReports.reference, reference))
      .limit(1);
    if (!clash) break;
    reference = newBugReference();
  }

  await app.db.insert(bugReports).values({
    id,
    reporterId: input.reporterId,
    title: input.title,
    description: input.description,
    reference,
    platform: env.platform,
    appVersion: env.appVersion,
    osVersion: env.osVersion,
    mediaIds,
  });

  await postBugCard(app, id).catch((err) => {
    app.log.error({ err, bug: id }, 'bug card failed to post');
  });

  return { id, reference };
}

/**
 * Post the card into the staff #bug channel.
 *
 * The proof rides as *real attachments* rather than an embed image. An embed
 * holds one picture by URL; a message holds all of them, and every client
 * already draws that properly — the grid, the lightbox, video playback. It also
 * settles who may look: the media is authorised by membership of this channel,
 * so staff can open it and nobody else can.
 */
export async function postBugCard(app: FastifyInstance, bugId: string): Promise<void> {
  const channelId = await getSystemConversationId(app, 'staff_bugs');
  const botId = await getYapperUserId(app);
  if (!channelId || !botId) return;

  const [bug] = await app.db
    .select({
      bug: bugReports,
      reporterName: users.displayName,
      reporterHandle: users.username,
    })
    .from(bugReports)
    .leftJoin(users, eq(users.id, bugReports.reporterId))
    .where(eq(bugReports.id, bugId))
    .limit(1);
  if (!bug) return;

  const b = bug.bug;
  const reporter = bug.reporterName ?? bug.reporterHandle ?? 'Someone';

  const embeds: EmbedInput[] = [
    {
      title: `${b.reference} · ${b.title}`,
      description: b.description,
      color: b.status === 'open' ? AMBER : b.status === 'fixed' ? GREEN : GREY,
      fields: [
        { name: 'From', value: reporter, inline: true },
        {
          name: 'Build',
          value: environmentLabel({
            platform: b.platform,
            appVersion: b.appVersion,
            osVersion: b.osVersion,
          }),
          inline: true,
        },
        { name: 'Status', value: BUG_STATUS_LABEL[b.status as BugStatus] ?? b.status, inline: true },
      ],
      footer: {
        text:
          b.mediaIds.length > 0
            ? 'Proof attached below. Pressing any button tells the reporter.'
            : 'No proof attached. Pressing any button tells the reporter.',
      },
      timestamp: b.createdAt.toISOString(),
    },
  ];

  const components: MessageComponentRow[] =
    b.status === 'open'
      ? [
          {
            type: 'row',
            components: [
              {
                type: 'button',
                customId: `bug:fixed:${b.id}`,
                label: 'Fixed',
                style: 'success',
                disabled: false,
                staffOnly: true,
              },
              {
                type: 'button',
                customId: `bug:known:${b.id}`,
                label: 'Known',
                style: 'secondary',
                disabled: false,
                staffOnly: true,
              },
              {
                type: 'button',
                customId: `bug:need_more:${b.id}`,
                label: 'Need more',
                style: 'secondary',
                disabled: false,
                staffOnly: true,
              },
              {
                type: 'button',
                customId: `bug:invalid:${b.id}`,
                label: 'Not a bug',
                style: 'danger',
                disabled: false,
                staffOnly: true,
              },
            ],
          },
        ]
      : [];

  const result = await app.messages.send(botId, channelId, {
    // Keyed on the bug, so a retried post lands on the same message rather
    // than a second card for one report.
    nonce: `bug_${b.id}`,
    type: b.mediaIds.length > 0 ? 'image' : 'text',
    content: null,
    attachmentIds: b.mediaIds.length > 0 ? b.mediaIds : undefined,
    embeds,
    components,
    silent: false,
  } as never);

  await app.db
    .update(bugReports)
    .set({ staffMessageId: (result.message as { id: string }).id, updatedAt: new Date() })
    .where(eq(bugReports.id, b.id));
}

/**
 * Staff answered. Record it, and tell the person who reported it.
 *
 * The DM is the whole point of the feature — see `BUG_STATUSES`. It goes
 * through the ordinary yapper queue, so it is deduped by (kind, bug, status)
 * and a double press cannot produce two messages.
 */
export async function resolveBug(
  app: FastifyInstance,
  staffId: string,
  bugId: string,
  status: Exclude<BugStatus, 'open'>,
): Promise<{ reference: string } | null> {
  const [updated] = await app.db
    .update(bugReports)
    .set({
      status,
      resolvedById: staffId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bugReports.id, bugId))
    .returning({ reference: bugReports.reference, reporterId: bugReports.reporterId });

  if (!updated) return null;

  if (updated.reporterId) {
    await app.enqueue('yapper.dm', {
      userId: updated.reporterId,
      kind: 'bug_update',
      dedupe: `${bugId}:${status}`,
      payload: {
        reference: updated.reference,
        status,
        message: BUG_STATUS_MESSAGE[status],
      },
    });
  }

  return { reference: updated.reference };
}

/**
 * How many real bugs this person has found us.
 *
 * The early-tester reward counts this, and it is the one measure on that list
 * nobody can farm: a human decides whether it counted. Three good reports are
 * worth more to us than two thousand messages, and this is what says so.
 */
export async function acceptedBugCount(app: FastifyInstance, userId: string): Promise<number> {
  const rows = await app.db
    .select({ id: bugReports.id })
    .from(bugReports)
    .where(and(eq(bugReports.reporterId, userId), inArray(bugReports.status, ACCEPTED)));
  return rows.length;
}
