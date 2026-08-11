import { readFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, conversations, eq, invites, isNull, media } from '@yappy/db';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { mediaUrl } from '../lib/serialize.js';

/**
 * The invite landing page, rendered by the server.
 *
 * It used to be a static file that fetched the group with JavaScript. That
 * works for a person, and not at all for the thing that matters most: link
 * unfurlers do not run JavaScript. WhatsApp, iMessage, Discord and every other
 * place an invite actually gets pasted read the raw HTML — so every invite ever
 * shared unfurled as "You have been invited to a group on yappy", with no name
 * and no picture, no matter which group it was for.
 *
 * For a group-first app the invite link *is* the growth mechanism, and it was
 * arriving anonymous.
 *
 * The page itself is unchanged and still lives in `web/`. This reads that file
 * and injects the tags, rather than keeping a second copy of the markup here to
 * drift out of step with the first.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `web/join/index.html`, from wherever this happens to be running.
 *
 * Two layouts to satisfy: the container, where this is `/app/apps/api/dist/
 * routes` and the page is `/app/web/join`, and a dev checkout, where it is
 * `src/routes` and the page is at the repository root. Both are four levels up,
 * but the candidates are tried in order rather than assumed so that a wrong
 * guess is a clear failure at boot instead of a 500 on the first invite.
 */
const CANDIDATES = [
  joinPath(here, '../../../../web/join/index.html'),
  joinPath(here, '../../../../../web/join/index.html'),
  joinPath(process.cwd(), 'web/join/index.html'),
];

let cached: string | null = null;

async function pageTemplate(app: FastifyInstance): Promise<string | null> {
  if (cached) return cached;
  for (const path of CANDIDATES) {
    try {
      cached = await readFile(path, 'utf8');
      return cached;
    } catch {
      /* try the next */
    }
  }
  app.log.error({ tried: CANDIDATES }, 'join page template not found');
  return null;
}

/** Escape for an HTML attribute. Group titles are user input. */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function joinRoutes(app: FastifyInstance) {
  app.get('/join/:code', async (req, reply) => {
    const { code } = req.params as { code: string };

    const template = await pageTemplate(app);
    // Better to serve nothing than a page with no code in it; Caddy's own error
    // is more honest than a landing page that cannot work.
    if (!template) return reply.status(500).send('Unavailable');

    const [row] = await app.db
      .select({
        type: conversations.type,
        title: conversations.title,
        memberCount: conversations.memberCount,
        avatarKey: media.objectKey,
        expiresAt: invites.expiresAt,
        maxUses: invites.maxUses,
        uses: invites.uses,
      })
      .from(invites)
      .innerJoin(conversations, eq(conversations.id, invites.conversationId))
      .leftJoin(media, eq(media.id, conversations.avatarMediaId))
      .where(and(eq(invites.code, code), isNull(invites.revokedAt), isNull(conversations.deletedAt)))
      .limit(1);

    const dead =
      !row ||
      (row.expiresAt && row.expiresAt < new Date()) ||
      (row.maxUses > 0 && row.uses >= row.maxUses);

    /**
     * What a dead invite unfurls as.
     *
     * Deliberately the same for never-existed, revoked, expired and used-up —
     * the page has always refused to distinguish those four, and putting the
     * difference in a preview would hand it to somebody feeding codes in bulk
     * exactly what the page withholds.
     */
    const title = dead ? 'Join a group on yappy' : (row.title ?? 'A group on yappy');
    const kind = row?.type === 'space' ? 'space' : row?.type === 'channel' ? 'channel' : 'group';

    /**
     * The description says what it is, not who is in it.
     *
     * A member count is good social proof and it is also a fact about a private
     * group, published to whoever can see the message the link was pasted into.
     * The name and the picture are what somebody needs to recognise an invite
     * from a friend; the rest waits until they have opened it.
     */
    const description = dead
      ? 'This invite is no longer valid.'
      : `You have been invited to join this ${kind} on yappy.`;

    /**
     * The site's own origin, not the request's.
     *
     * Behind a proxy `req.hostname` is whatever Host header arrived, which for
     * an absolute URL that strangers' servers will fetch is not something to
     * take on trust — and in development it resolved to `127.0.0.1`, an image
     * nobody outside this machine can load.
     */
    const image = row?.avatarKey ? mediaUrl(row.avatarKey) : `${env.PUBLIC_WEB_URL}/icon.png`;

    const tags = [
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="yappy">`,
      `<meta property="og:title" content="${attr(title)}">`,
      `<meta property="og:description" content="${attr(description)}">`,
      `<meta property="og:image" content="${attr(image)}">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${attr(title)}">`,
      `<meta name="twitter:description" content="${attr(description)}">`,
      `<meta name="twitter:image" content="${attr(image)}">`,
    ].join('\n');

    // The file already carries a generic `description`; replacing it keeps a
    // preview from showing the placeholder underneath the real one.
    const body = template
      .replace(
        /<meta name="description" content="[^"]*">/,
        `<meta name="description" content="${attr(description)}">`,
      )
      .replace('</head>', `${tags}\n</head>`);

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      // Short, and private to nobody: an unfurler may cache this, and a group
      // that renames itself should not be misrepresented for a day.
      .header('cache-control', 'public, max-age=300')
      .send(body);
  });
}
