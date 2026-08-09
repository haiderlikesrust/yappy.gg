import type { EmbedInput } from '@yappy/shared';

/**
 * GitHub's webhook events, as cards for the staff #gitlog channel.
 *
 * Pure translation — no database, no network, no clock. Everything here takes
 * the JSON GitHub posted and returns the card yapper should say, or `null` for
 * "this is not worth a message". That makes the whole surface testable by
 * handing it a saved payload, which matters because the payloads are the one
 * part of this we do not control.
 *
 * The payloads are treated as untrusted and untyped on purpose. They arrive
 * signature-verified, so we know GitHub sent them, but "GitHub sent it" is not
 * "GitHub sends the shape I remember" — fields get added, `null`s appear where
 * an object used to be, and a webhook that throws is a webhook GitHub marks
 * failed and stops trusting. Every read goes through the coercers below, so
 * the worst a surprising payload can do is produce a dull card.
 *
 * What is deliberately *not* here: every event GitHub offers. A gitlog channel
 * that reports each label change and each successful CI run is a channel the
 * team mutes in a week, and a muted channel is worse than no channel — it
 * looks like coverage while delivering none. The rule applied throughout is
 * that a card must correspond to something a person would mention out loud.
 */

const VIOLET = '#8b7cff';
const GREEN = '#3dd68c';
const AMBER = '#f5a524';
const RED = '#ff6369';
const GREY = '#726c8c';

export interface GitlogCard {
  content: string | null;
  embeds: EmbedInput[];
}

// ─── Reading someone else's JSON ─────────────────────────────────────────────

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const str = (v: unknown, max = 256): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * A link we are willing to put in a card.
 *
 * https and github.com only. The embed carries a tappable title, and the value
 * behind it comes from a request body — a signature proves the sender, not the
 * contents, and a compromised or merely creative repository name should not be
 * able to turn a staff notification into a link to somewhere else.
 */
const link = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v : '';
  if (s.length === 0 || s.length > 2_048) return null;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.github.com')) return null;
    return s;
  } catch {
    return null;
  }
};

/** Same rules, for the avatar GitHub serves off its own CDN. */
const avatar = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v : '';
  if (s.length === 0 || s.length > 2_048) return null;
  try {
    const parsed = new URL(s);
    const host = parsed.hostname;
    const ok =
      parsed.protocol === 'https:' &&
      (host === 'avatars.githubusercontent.com' || host.endsWith('.githubusercontent.com'));
    return ok ? s : null;
  } catch {
    return null;
  }
};

/** The person who caused the event, as an embed author line. */
function sender(p: Json): EmbedInput['author'] {
  const s = obj(p.sender);
  const name = str(s.login, 64);
  if (!name) return null;
  return { name, url: link(s.html_url), iconUrl: avatar(s.avatar_url) };
}

/** "yappy.gg" — the repository, short, for a field. */
const repoName = (p: Json): string => str(obj(p.repository).full_name, 128) || 'unknown repository';

/** First line only. Commit bodies are for `git log`, not for a chat card. */
const subject = (message: unknown, max = 100): string => str(str(message, 4_000).split('\n')[0], max);

// ─── The events ──────────────────────────────────────────────────────────────

/**
 * Translate one delivery.
 *
 * Returning `null` is the normal outcome for most of what GitHub sends and is
 * not an error — the route answers 2xx either way, because a webhook that
 * returns a failure for "I chose not to post this" is a webhook that shows up
 * red in GitHub's delivery list forever.
 */
export function renderGitHubEvent(event: string, payload: unknown): GitlogCard | null {
  const p = obj(payload);
  switch (event) {
    case 'push':
      return pushCard(p);
    case 'pull_request':
      return pullRequestCard(p);
    case 'release':
      return releaseCard(p);
    case 'workflow_run':
      return workflowCard(p);
    case 'issues':
      return issueCard(p);
    default:
      return null;
  }
}

/**
 * Commits landing on a branch — the event this channel exists for.
 *
 * Bots are dropped: a repository with Dependabot or a release automation on it
 * produces a steady trickle of pushes that nobody reads, and they crowd out the
 * human ones. `sender.type === 'Bot'` is GitHub's own marking, so this costs
 * nothing to maintain.
 */
function pushCard(p: Json): GitlogCard | null {
  if (str(obj(p.sender).type, 16) === 'Bot') return null;

  const ref = str(p.ref, 256);
  const isTag = ref.startsWith('refs/tags/');
  const name = ref.replace(/^refs\/(heads|tags)\//, '') || 'unknown';
  const commits = arr(p.commits);
  const who = sender(p);
  const repo = repoName(p);

  if (p.deleted === true) {
    return {
      content: null,
      embeds: [
        {
          title: `Deleted ${isTag ? 'tag' : 'branch'} ${name}`,
          color: GREY,
          author: who,
          fields: [{ name: 'Repository', value: repo, inline: true }],
        },
      ],
    };
  }

  if (isTag) {
    // A tag on its own. When it belongs to a release the `release` event says
    // more, but plenty of tags never become releases.
    return {
      content: null,
      embeds: [
        {
          title: `Tagged ${name}`,
          url: link(obj(p.head_commit).url) ?? link(obj(p.repository).html_url),
          color: VIOLET,
          author: who,
          fields: [{ name: 'Repository', value: repo, inline: true }],
        },
      ],
    };
  }

  if (commits.length === 0) {
    // A new branch with nothing on it yet is worth one line; a force-push that
    // moved a pointer without adding commits is not.
    if (p.created !== true) return null;
    return {
      content: null,
      embeds: [
        {
          title: `Created branch ${name}`,
          color: VIOLET,
          author: who,
          fields: [{ name: 'Repository', value: repo, inline: true }],
        },
      ],
    };
  }

  /**
   * Ten lines, then a count.
   *
   * A merge or a rebase can carry hundreds of commits, and the useful part of
   * a card that long is the first screen. The embed's character budget would
   * force a cut somewhere regardless; better to cut deliberately and say how
   * much was cut than to be truncated mid-sha by the schema.
   */
  const shown = commits.slice(0, 10);
  const lines = shown.map((entry) => {
    const c = obj(entry);
    const sha = str(c.id, 40).slice(0, 7) || '???????';
    const author = str(obj(c.author).username || obj(c.author).name, 40);
    return `${sha}  ${subject(c.message)}${author ? ` — ${author}` : ''}`;
  });
  if (commits.length > shown.length) {
    lines.push(`…and ${commits.length - shown.length} more`);
  }

  const count = `${commits.length} commit${commits.length === 1 ? '' : 's'}`;

  return {
    content: null,
    embeds: [
      {
        title: `${count} to ${name}${p.forced === true ? ' (force-pushed)' : ''}`,
        url: link(p.compare),
        description: lines.join('\n'),
        color: p.forced === true ? AMBER : VIOLET,
        author: who,
        fields: [{ name: 'Repository', value: repo, inline: true }],
      },
    ],
  };
}

/**
 * Pull requests, at the four moments that change what someone should do about
 * them: opened, merged, closed unmerged, reopened.
 *
 * Not `synchronize` — a push to a PR branch fires it every time, which would
 * make every review round trip three cards.
 */
function pullRequestCard(p: Json): GitlogCard | null {
  const action = str(p.action, 32);
  const pr = obj(p.pull_request);
  const number = num(pr.number);
  const merged = pr.merged === true;
  const draft = pr.draft === true;

  let title: string;
  let color: string;

  switch (action) {
    case 'opened':
      if (draft) return null; // A draft is a work in progress announcing itself.
      title = `Opened #${number}`;
      color = VIOLET;
      break;
    case 'ready_for_review':
      title = `Ready for review #${number}`;
      color = VIOLET;
      break;
    case 'reopened':
      title = `Reopened #${number}`;
      color = AMBER;
      break;
    case 'closed':
      title = merged ? `Merged #${number}` : `Closed #${number}`;
      color = merged ? GREEN : GREY;
      break;
    default:
      return null;
  }

  const base = str(pr.base && obj(pr.base).ref, 128);
  const head = str(pr.head && obj(pr.head).ref, 128);
  const changed = num(pr.changed_files);

  const fields: NonNullable<EmbedInput['fields']> = [
    { name: 'Repository', value: repoName(p), inline: true },
  ];
  if (head && base) fields.push({ name: 'Branch', value: `${head} → ${base}`, inline: true });
  if (merged && changed > 0) {
    fields.push({
      name: 'Changes',
      value: `${changed} file${changed === 1 ? '' : 's'} · +${num(pr.additions)} −${num(pr.deletions)}`,
      inline: true,
    });
  }

  return {
    content: null,
    embeds: [
      {
        title: `${title} · ${subject(pr.title, 120)}`,
        url: link(pr.html_url),
        color,
        author: sender(p),
        fields,
      },
    ],
  };
}

/** A release going out. The one git event with an audience beyond the team. */
function releaseCard(p: Json): GitlogCard | null {
  if (str(p.action, 32) !== 'published') return null;

  const release = obj(p.release);
  const tag = str(release.tag_name, 128) || 'untagged';
  const pre = release.prerelease === true;

  return {
    content: `${pre ? 'Pre-release' : 'Release'} ${tag} is out.`,
    embeds: [
      {
        title: str(release.name, 200) || tag,
        url: link(release.html_url),
        description: str(release.body, 1_500) || null,
        color: pre ? AMBER : GREEN,
        author: sender(p),
        fields: [
          { name: 'Repository', value: repoName(p), inline: true },
          { name: 'Tag', value: tag, inline: true },
        ],
      },
    ],
  };
}

/**
 * CI, on failure only.
 *
 * Successful runs are the overwhelming majority and carry no information — the
 * absence of a failure card is the pass. Reporting both is how a channel earns
 * a mute, and this is the one card here worth a push notification, so it must
 * not be the one that cries wolf.
 */
function workflowCard(p: Json): GitlogCard | null {
  if (str(p.action, 32) !== 'completed') return null;

  const run = obj(p.workflow_run);
  const conclusion = str(run.conclusion, 32);
  if (conclusion !== 'failure' && conclusion !== 'timed_out') return null;

  const name = str(run.name, 128) || 'A workflow';
  const branch = str(run.head_branch, 128) || 'unknown branch';

  return {
    content: `${name} failed on ${branch}.`,
    embeds: [
      {
        title: `${name} ${conclusion === 'timed_out' ? 'timed out' : 'failed'}`,
        url: link(run.html_url),
        color: RED,
        author: sender(p),
        fields: [
          { name: 'Repository', value: repoName(p), inline: true },
          { name: 'Branch', value: branch, inline: true },
          { name: 'Commit', value: str(run.head_sha, 40).slice(0, 7) || 'unknown', inline: true },
        ],
      },
    ],
  };
}

/** Issues opened and closed. Comments and labels deliberately left out. */
function issueCard(p: Json): GitlogCard | null {
  const action = str(p.action, 32);
  if (action !== 'opened' && action !== 'closed' && action !== 'reopened') return null;

  const issue = obj(p.issue);
  const number = num(issue.number);
  const verb = action === 'opened' ? 'Opened' : action === 'closed' ? 'Closed' : 'Reopened';

  return {
    content: null,
    embeds: [
      {
        title: `${verb} issue #${number} · ${subject(issue.title, 120)}`,
        url: link(issue.html_url),
        description: action === 'opened' ? str(issue.body, 500) || null : null,
        color: action === 'closed' ? GREY : AMBER,
        author: sender(p),
        fields: [{ name: 'Repository', value: repoName(p), inline: true }],
      },
    ],
  };
}
