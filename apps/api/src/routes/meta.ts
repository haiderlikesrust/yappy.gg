import {
  API_VERSION,
  CLIENT_PLATFORMS,
  CLIENT_RELEASES,
  latestReleaseNote,
  releaseNotesSince,
  type ClientPlatform,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Build metadata and release notes.
 *
 * Deliberately unauthenticated. A client needs the version floor *before* it
 * can sign in — an app too old to speak the current auth flow has to be able
 * to find that out and say so, rather than failing at the login screen with
 * something unhelpful. Nothing here is user-specific, so there is nothing to
 * leak; it is the same answer for everyone.
 */
export async function metaRoutes(app: FastifyInstance) {
  const parsePlatform = (value: unknown): ClientPlatform | undefined =>
    CLIENT_PLATFORMS.includes(value as ClientPlatform) ? (value as ClientPlatform) : undefined;

  /**
   * What the server is, and what the client should be.
   *
   * `updateRequired` is the interesting field: the client compares nothing
   * itself, because version comparison done in four clients is version
   * comparison done wrong in at least two of them.
   */
  app.get('/version', async (req, reply) => {
    const query = req.query as { platform?: string; version?: string };
    const platform = parsePlatform(query.platform);
    const release = platform ? CLIENT_RELEASES[platform] : null;

    return reply.send({
      api: API_VERSION,
      time: new Date().toISOString(),
      clients: CLIENT_RELEASES,
      ...(release
        ? {
            platform,
            latest: release.latest,
            minimum: release.minimum,
            // Absent `version` means "just tell me the numbers" — answering
            // `true` there would nag a caller that never claimed to be a
            // client at all.
            updateAvailable: query.version ? compare(query.version, release.latest) < 0 : false,
            updateRequired: query.version ? compare(query.version, release.minimum) < 0 : false,
          }
        : {}),
    });
  });

  /**
   * The What's New feed.
   *
   * `since` is the last note id the caller already showed. Omitting it returns
   * everything, which is what a Settings screen wants; passing it returns only
   * what is genuinely new, which is what a launch check wants.
   */
  app.get('/changelog', async (req, reply) => {
    const query = req.query as { since?: string; platform?: string; limit?: string };
    const platform = parsePlatform(query.platform);
    const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 25);

    const notes = releaseNotesSince(query.since, platform).slice(0, limit);
    return reply.send({
      notes,
      /** So a first-run client can record where it came in without showing anything. */
      latestId: latestReleaseNote(platform)?.id ?? null,
    });
  });
}

/**
 * Compare dotted numeric versions. Negative when `a` is older.
 *
 * Not semver: yappy's versions are plain `major.minor.patch`, and pulling in a
 * parser to handle pre-release tags the project does not issue would be more
 * code than the thing it guards. Non-numeric segments sort as 0, so a stray
 * suffix degrades to "same as the release it is built on" rather than throwing.
 */
function compare(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = Number.parseInt(left[i] ?? '0', 10) || 0;
    const y = Number.parseInt(right[i] ?? '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
