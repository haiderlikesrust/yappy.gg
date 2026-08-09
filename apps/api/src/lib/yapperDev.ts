import { and, applications, eq, isNull, users } from '@yappy/db';
import {
  DOCS_INDEX,
  ERROR_HELP,
  ErrorCode,
  Permission,
  newId,
  permissionNames,
  type DocsEntry,
  type EmbedInput,
  type MessageComponentRow,
  type PermissionName,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * yapper as the developer-support desk.
 *
 * The bot is already where a developer goes to sign in to the portal, which
 * makes it the obvious place to answer the questions they have immediately
 * afterwards: what does this error code mean, which bit is KICK_MEMBERS, why
 * is my webhook silent. Every one of those has an answer already written down
 * in `docs/`, and the distance between "written down" and "found" is the whole
 * problem — a developer with a failing request does not read a documentation
 * site, they search it, badly, in another tab.
 *
 * Nothing here is a second source of truth. The docs index and the error
 * glossary are generated from `docs/` by `web/tools/build-docs.mjs`; the
 * permission bits come from `@yappy/shared`, the same constant the server
 * authorises with. A wrong answer from this file would have to be a wrong
 * answer from the platform too.
 */

const VIOLET = '#8b7cff';
const AMBER = '#f5a524';
const RED = '#ff6369';

export interface DevReply {
  content: string | null;
  embeds?: EmbedInput[];
  components?: MessageComponentRow[];
}

// ─── /docs ───────────────────────────────────────────────────────────────────

/**
 * Score one index entry against a query.
 *
 * A deliberately small ranking function, not a search engine: the corpus is
 * about sixty headings, and the queries are one or two words a developer has
 * just read in an error message. Exact-ish title matches beat prefix matches
 * beat word matches, and an entry has to match *every* term to appear at all —
 * with a corpus this size, an OR search returns the whole thing.
 */
function score(entry: DocsEntry, terms: string[]): number {
  const title = entry.title.toLowerCase();
  const haystack = `${title} ${entry.page.toLowerCase()} ${entry.blurb?.toLowerCase() ?? ''}`;

  let total = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) return 0;
    if (title === term) total += 100;
    else if (title.startsWith(term)) total += 50;
    else if (new RegExp(`\\b${term.replace(/[^a-z0-9]/g, '')}`).test(title)) total += 30;
    else if (title.includes(term)) total += 20;
    else total += 5;
  }
  // A page-level entry is a better answer than one of its own subheadings when
  // both match, because it is where someone should start reading.
  return entry.blurb ? total + 3 : total;
}

export function docsCard(query: string): DevReply {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: 'Search the developer docs',
          description: 'Try `/docs webhooks`, `/docs permissions`, or `/docs rate limits`.',
          color: VIOLET,
          fields: [],
          footer: { text: 'Everything is also at docs.yappy.gg.' },
        },
      ],
    };
  }

  const hits = DOCS_INDEX.map((entry) => ({ entry, points: score(entry, terms) }))
    .filter((h) => h.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 5);

  if (hits.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: `Nothing for "${query.slice(0, 60)}"`,
          description: 'The whole set is at docs.yappy.gg — try a broader word.',
          color: AMBER,
          fields: [],
        },
      ],
    };
  }

  return {
    content: null,
    embeds: [
      {
        title: hits.length === 1 ? 'One match' : `${hits.length} matches`,
        color: VIOLET,
        fields: hits.map((h) => ({
          name: h.entry.title,
          value: `${h.entry.blurb ?? h.entry.page}\n${h.entry.url}`,
          inline: false,
        })),
        footer: { text: 'Titles link through to the section.' },
      },
    ],
  };
}

// ─── /error ──────────────────────────────────────────────────────────────────

const ALL_CODES = Object.values(ErrorCode) as string[];

export function errorCard(rawCode: string): DevReply {
  const code = rawCode.trim().toLowerCase().replace(/^`|`$/g, '');

  if (!code) {
    return {
      content: null,
      embeds: [
        {
          title: 'Look up an error code',
          description: 'Send `/error rate_limited`, or any code from an `error.code` field.',
          color: VIOLET,
          fields: [],
          footer: { text: `${ALL_CODES.length} codes. The full table is at docs.yappy.gg/errors/.` },
        },
      ],
    };
  }

  const known = ALL_CODES.includes(code);
  const help = ERROR_HELP[code];

  if (!known) {
    // Near misses rather than a flat no: the codes are snake_case and long
    // enough to typo, and "did you mean" costs one pass over twenty-six
    // strings.
    const close = ALL_CODES.filter((c) => c.includes(code) || code.includes(c)).slice(0, 3);
    return {
      content: null,
      embeds: [
        {
          title: `No such code: ${code.slice(0, 40)}`,
          description: close.length ? `Did you mean ${close.map((c) => `\`${c}\``).join(', ')}?` : null,
          color: AMBER,
          fields: [],
          footer: { text: 'Codes come from the `error.code` field, not the message.' },
        },
      ],
    };
  }

  return {
    content: null,
    embeds: [
      {
        title: code,
        // A code the server can emit but the docs do not describe is a real
        // gap, and saying so plainly is more useful than inventing a gloss.
        description: help ?? 'This code is not described in the published docs yet.',
        color: VIOLET,
        fields: [
          { name: 'Where', value: '`error.code` in the response body', inline: false },
          ...(code === 'rate_limited' || code === 'slow_mode'
            ? [{ name: 'Retry', value: 'Wait `error.retryAfter` seconds. Do not retry sooner.', inline: false }]
            : []),
        ],
        footer: { text: 'docs.yappy.gg/errors/' },
      },
    ],
  };
}

// ─── /perms ──────────────────────────────────────────────────────────────────

/**
 * Decode a bitfield, or build one from names.
 *
 * Both directions, because both are things people get wrong: reading the
 * decimal string out of `GET /conversations/:id/members/:id/permissions` and
 * wanting to know what it contains, and wanting the number to put in a
 * button's `requiredPermissions` without doing 64-bit arithmetic by hand in a
 * language whose numbers stop being exact at 2^53.
 */
export function permsCard(args: string[]): DevReply {
  const input = args.filter(Boolean);

  if (input.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: 'Permission bitfields',
          description:
            'Send `/perms 4398046511111` to decode one, or `/perms KICK_MEMBERS BAN_MEMBERS` to build one.',
          color: VIOLET,
          fields: [
            { name: 'Bits', value: `${Object.keys(Permission).length} named permissions`, inline: true },
            { name: 'On the wire', value: 'A decimal string, not a number', inline: true },
          ],
          footer: { text: 'docs.yappy.gg/permissions/' },
        },
      ],
    };
  }

  // Decode: one all-digits argument.
  if (input.length === 1 && /^\d+$/.test(input[0]!)) {
    let bits: bigint;
    try {
      bits = BigInt(input[0]!);
    } catch {
      return { content: 'That is not a number I can parse.' };
    }

    const names = permissionNames(bits);
    const admin = (bits & Permission.ADMINISTRATOR) !== 0n;

    return {
      content: null,
      embeds: [
        {
          title: `${names.length} permission${names.length === 1 ? '' : 's'}`,
          description: admin
            ? 'Includes ADMINISTRATOR, which implies every permission at check time.'
            : names.length
              ? null
              : 'No bits set — this member can do nothing here.',
          color: VIOLET,
          fields: [
            { name: 'Decimal', value: bits.toString(10), inline: false },
            ...(names.length
              ? [{ name: 'Contains', value: names.join(', ').slice(0, 1_024), inline: false }]
              : []),
          ],
          footer: { text: 'Checked against the person who invoked the action, never the bot.' },
        },
      ],
    };
  }

  // Build: one or more names.
  const wanted = input.map((n) => n.toUpperCase().replace(/[^A-Z_]/g, ''));
  const unknown = wanted.filter((n) => !(n in Permission));
  if (unknown.length) {
    return {
      content: null,
      embeds: [
        {
          title: 'I do not know those',
          description: unknown.map((n) => `\`${n}\``).join(', '),
          color: AMBER,
          fields: [
            {
              name: 'Valid names',
              value: Object.keys(Permission).join(', ').slice(0, 1_024),
              inline: false,
            },
          ],
        },
      ],
    };
  }

  const bits = wanted.reduce((acc, n) => acc | Permission[n as PermissionName], 0n);

  return {
    content: null,
    embeds: [
      {
        title: 'Bitfield',
        description: 'Send this as a string. JavaScript numbers lose precision past 2^53.',
        color: VIOLET,
        fields: [
          { name: 'Decimal', value: bits.toString(10), inline: false },
          { name: 'From', value: wanted.join(', ').slice(0, 1_024), inline: false },
        ],
        footer: { text: 'Use it as a button\'s requiredPermissions, or a command\'s.' },
      },
    ],
  };
}

// ─── /webhook ────────────────────────────────────────────────────────────────

/**
 * The bots this person owns that have a webhook set, as a card with a test
 * button each.
 *
 * The test itself runs in the worker and answers as a follow-up message; see
 * `deliverWebhookTest`. The press only enqueues, so nothing here holds a
 * connection open to somebody else's server from the process serving requests.
 */
export async function webhookCard(app: FastifyInstance, ownerId: string): Promise<DevReply> {
  const owned = await app.db
    .select({
      id: applications.id,
      name: applications.name,
      webhookUrl: applications.webhookUrl,
      failures: applications.webhookFailureCount,
      lastSuccessAt: applications.webhookLastSuccessAt,
      botUsername: users.username,
    })
    .from(applications)
    .leftJoin(users, eq(users.id, applications.botUserId))
    .where(and(eq(applications.ownerId, ownerId), isNull(applications.revokedAt)))
    .limit(10);

  if (owned.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: 'You have not built a bot yet',
          description: 'Sign in to the developer portal with /login and you can create one there.',
          color: VIOLET,
          fields: [],
        },
      ],
    };
  }

  const withHook = owned.filter((a) => a.webhookUrl);
  if (withHook.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: 'No webhooks set',
          description:
            'A bot without a webhook can still post — it just never hears about anything it did not cause.',
          color: VIOLET,
          fields: owned.map((a) => ({
            name: a.name,
            value: `@${a.botUsername ?? 'unknown'} · no webhook`,
            inline: false,
          })),
          footer: { text: 'Set one from the portal, or PUT /v1/apps/:id/webhook.' },
        },
      ],
    };
  }

  return {
    content: null,
    embeds: [
      {
        title: withHook.length === 1 ? 'Your webhook' : `Your ${withHook.length} webhooks`,
        color: withHook.some((a) => a.failures >= 5) ? RED : VIOLET,
        // Never the URL: it is not a secret in the way the token is, but it is
        // an endpoint anyone reading over a shoulder could then shout into,
        // and the owner already knows what they set.
        fields: withHook.map((a) => ({
          name: a.name,
          value:
            a.failures >= 5
              ? `@${a.botUsername ?? 'unknown'} · **${a.failures} failures in a row**`
              : `@${a.botUsername ?? 'unknown'} · ${
                  a.lastSuccessAt ? 'delivering' : 'no delivery recorded yet'
                }`,
          inline: false,
        })),
        footer: { text: 'A test sends a signed webhook.test event. I will tell you what came back.' },
      },
    ],
    components: [
      {
        type: 'row',
        components: withHook.slice(0, 5).map((a) => ({
          type: 'button' as const,
          customId: `webhook:test:${a.id}`,
          label: withHook.length === 1 ? 'Send a test' : `Test ${a.name}`.slice(0, 80),
          style: 'primary' as const,
          disabled: false,
          onlyUserId: ownerId,
        })),
      },
    ],
  };
}

/**
 * A press on one of those test buttons.
 *
 * Ownership is re-checked here and again in the worker. The `customId` is
 * client-supplied and names an application id, so it selects *which* of the
 * presser's own bots to test and nothing more — without this check it would
 * name anybody's.
 */
export async function requestWebhookTest(
  app: FastifyInstance,
  actorId: string,
  applicationId: string,
): Promise<DevReply> {
  const [owned] = await app.db
    .select({ id: applications.id, name: applications.name, webhookUrl: applications.webhookUrl })
    .from(applications)
    .where(
      and(
        eq(applications.id, applicationId),
        eq(applications.ownerId, actorId),
        isNull(applications.revokedAt),
      ),
    )
    .limit(1);

  if (!owned || !owned.webhookUrl) {
    return {
      content: null,
      embeds: [
        {
          title: 'Nothing to test',
          description: 'That bot has no webhook set, or is not yours.',
          color: AMBER,
          fields: [],
        },
      ],
      components: [],
    };
  }

  // No retries: a test reports what happened on the attempt that was asked
  // for. Retrying with backoff would answer a question about four minutes from
  // now, which is not the question.
  await app.boss.send(
    'bot.webhook_test',
    { applicationId: owned.id, requestedByUserId: actorId, dedupe: newId() },
    { retryLimit: 0, expireInSeconds: 120 },
  );

  return {
    content: null,
    embeds: [
      {
        title: 'Test sent',
        description: `A signed \`webhook.test\` event is on its way to ${owned.name}. I will tell you what came back.`,
        color: VIOLET,
        fields: [],
        footer: { text: 'Verify X-Yappy-Signature before trusting the body — including this one.' },
      },
    ],
    components: [],
  };
}
