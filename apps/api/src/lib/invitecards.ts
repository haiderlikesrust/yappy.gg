import {
  and,
  conversations,
  eq,
  inArray,
  invites,
  isNull,
  media,
  type Database,
} from '@yappy/db';

/**
 * An invite link, rendered as the group it points at.
 *
 * A yappy invite pasted into a yappy chat used to unfurl through the generic
 * link path: fetch the URL, read its `<meta>` tags, show the title. Which is an
 * absurd way for the app to learn about its own group — it goes out to the
 * public internet to read a page it serves, and gets back whatever that page
 * says to strangers, because to an unauthenticated fetcher that is all an
 * invite is. The answer is one row away in the database.
 *
 * This runs at hydration rather than at unfurl time on purpose. Previews are
 * cached per URL and shared by everyone who ever pasted it, so a member count
 * baked in there would be however many people were in the group the first time
 * anybody sent the link. Resolved per read, the card is right every time it is
 * drawn, and a group that has since been deleted stops claiming to exist.
 */
export interface InviteCard {
  code: string;
  type: string;
  title: string | null;
  description: string | null;
  badge: string | null;
  memberCount: number;
  avatarUrl: string | null;
}

/**
 * The code out of a yappy invite URL, or null.
 *
 * Deliberately strict about the host. Any site can put `/join/<something>` in a
 * path, and treating those as invites would let an unrelated link render as a
 * group somebody is invited to — which is a phishing card the app drew itself.
 */
export function inviteCodeFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  if (!INVITE_HOSTS.has(host)) return null;

  const [first, second, ...rest] = url.pathname.split('/').filter(Boolean);
  if (first !== 'join' || !second || rest.length > 0) return null;

  return /^[a-zA-Z0-9]{4,32}$/.test(second) ? second : null;
}

/** The domains yappy serves invites from, including the backup. */
const INVITE_HOSTS = new Set(['yappy.gg', 'tenku.xyz', 'localhost']);

/**
 * Resolve many codes at once.
 *
 * One query for the whole page of messages rather than one per link: a
 * conversation where somebody has pasted the same invite forty times is a
 * conversation, not an attack, and it should not cost forty round trips.
 *
 * Applies exactly the liveness rules `/invites/:code/preview` applies —
 * revoked, expired, used up and never-existed all resolve to nothing — so a
 * dead invite falls back to the ordinary link preview instead of rendering a
 * join button that cannot work.
 */
export async function resolveInviteCards(
  db: Database,
  codes: string[],
): Promise<Map<string, InviteCard>> {
  const out = new Map<string, InviteCard>();
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) return out;

  const rows = await db
    .select({
      code: invites.code,
      type: conversations.type,
      title: conversations.title,
      description: conversations.description,
      badge: conversations.badge,
      memberCount: conversations.memberCount,
      avatarKey: media.objectKey,
      expiresAt: invites.expiresAt,
      maxUses: invites.maxUses,
      uses: invites.uses,
    })
    .from(invites)
    .innerJoin(conversations, eq(conversations.id, invites.conversationId))
    .leftJoin(media, eq(media.id, conversations.avatarMediaId))
    .where(
      and(
        inArray(invites.code, wanted),
        isNull(invites.revokedAt),
        isNull(conversations.deletedAt),
      ),
    );

  const now = new Date();
  for (const row of rows) {
    if (row.expiresAt && row.expiresAt < now) continue;
    if (row.maxUses > 0 && row.uses >= row.maxUses) continue;

    out.set(row.code, {
      code: row.code,
      type: row.type,
      title: row.title,
      description: row.description,
      badge: row.badge,
      memberCount: row.memberCount,
      avatarUrl: row.avatarKey ? `${process.env.S3_PUBLIC_BASE_URL}/${row.avatarKey}` : null,
    });
  }

  return out;
}
