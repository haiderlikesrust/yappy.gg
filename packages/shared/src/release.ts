/**
 * Release metadata and the What's New feed.
 *
 * Held in code rather than a table on purpose. Release notes describe a build,
 * so they ship *with* that build — a row in Postgres could advertise a feature
 * the deployed API does not have yet, and there is no editor to keep it honest.
 * Same reasoning as `docsIndex.ts`, which is likewise content compiled in.
 *
 * The clients decide what to show from `CHANGELOG` alone, so adding a release
 * here is the whole job: no migration, no admin screen, no client release.
 */

export const CLIENT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/** The API's own version, reported by `/health` and `/v1/meta/version`. */
export const API_VERSION = '1.2.0';

/**
 * What each client should be on, and what it must be on.
 *
 * `latest` drives the "you're up to date" line in Settings. `minimum` is the
 * force-upgrade floor — clients below it are expected to refuse to run, so
 * raising it strands anyone who cannot update. Raise it only when an older
 * build is actively broken or unsafe, never merely to encourage upgrades.
 */
export const CLIENT_RELEASES: Record<ClientPlatform, { latest: string; minimum: string }> = {
  ios: { latest: '1.2.0', minimum: '1.0.0' },
  android: { latest: '1.0.0', minimum: '1.0.0' },
  web: { latest: '1.1.0', minimum: '1.0.0' },
};

/** One bullet: a bold lead-in and a sentence, optionally linking somewhere. */
export interface ReleaseNoteItem {
  title: string;
  body: string;
  url?: string;
}

export interface ReleaseNoteSection {
  heading: string;
  /**
   * An SF Symbol name. Android maps it through its own table rather than
   * shipping a second field — the set is small and deliberately generic.
   */
  icon?: string;
  items: ReleaseNoteItem[];
}

export interface ReleaseNote {
  /** Stable and unique. The client stores the last one it showed. */
  id: string;
  version: string;
  /** `YYYY-MM-DD`. Rendered as the sheet's subtitle. */
  date: string;
  title: string;
  /** A sentence or two above the first section. */
  intro?: string;
  /**
   * Absolute URL of the hero image. Omitted means the client draws its own
   * gradient header, which is the honest default — a broken image at the top
   * of a What's New sheet looks worse than no image.
   */
  heroUrl?: string;
  /** Absent means every platform. */
  platforms?: ClientPlatform[];
  sections: ReleaseNoteSection[];
}

/**
 * Newest first. Order is the contract: `sinceId` is resolved by position, so
 * no semver parsing is needed and a hotfix slotted in the middle still works.
 */
export const CHANGELOG: ReleaseNote[] = [
  {
    id: '1.2.0',
    version: '1.2.0',
    date: '2026-08-10',
    title: "What's New",
    intro:
      'Calls that actually connect, a chat screen that keeps up with you, and profiles with some wall space.',
    sections: [
      {
        heading: 'Calls, for real this time',
        icon: 'phone.fill',
        items: [
          {
            title: 'You can hear each other now',
            body: 'Calls were connecting without carrying any audio. That is fixed, properly, on the server.',
          },
          {
            title: 'Hanging up works',
            body: 'Leaving a call used to leave a ghost of you behind, and the next call would not ring. Calls end when you end them.',
          },
          {
            title: 'Call back immediately',
            body: 'Redialling right after hanging up used to break the audio engine. Dial as fast as you like.',
          },
        ],
      },
      {
        heading: 'The chat keeps up',
        icon: 'bubble.left.and.bubble.right.fill',
        items: [
          {
            title: 'Jump back down',
            body: 'Scroll up into history and a button appears with a count of what has landed since. One tap puts you back at the newest message — sending does too.',
          },
          {
            title: 'The three dots',
            body: 'When someone is typing, the bubble with the dots sits at the bottom of the chat, where you were already staring.',
          },
          {
            title: 'Reactions bounce',
            body: 'Tapping a reaction pops it with a little spring and a tick you can feel. They used to just silently change, which felt like nothing.',
          },
        ],
      },
      {
        heading: 'People are links',
        icon: 'at',
        items: [
          {
            title: 'Tap a mention',
            body: 'Any @name in a message opens their profile now — even someone who is not in the chat.',
          },
          {
            title: 'Forwarded says so',
            body: 'A forwarded message is labelled with who actually said it, instead of arriving dressed as your own words.',
          },
          {
            title: 'Profile banners',
            body: 'Profiles have a banner across the top. Set yours in Settings — tap the strip above your avatar.',
          },
        ],
      },
      {
        heading: 'Housekeeping',
        icon: 'wrench.and.screwdriver',
        items: [
          {
            title: 'Sticker making unstuck',
            body: '@yapper used to demand the image and the emoji in one message and reject both halves forever. Send them together or one after the other; both work now.',
          },
          {
            title: 'A calmer home screen',
            body: 'No more "Connecting…" flashing on every open, no more list jolting down when Active Now loads, and a dead network says so instead of pretending you have no chats.',
          },
        ],
      },
    ],
  },
  {
    id: '1.1.0',
    version: '1.1.0',
    date: '2026-08-10',
    title: "What's New",
    intro:
      'Voice and video notes, stickers you make yourself, and a pile of settings that were hiding on the server the whole time.',
    sections: [
      {
        heading: 'Say it out loud',
        icon: 'waveform',
        items: [
          {
            title: 'Voice notes',
            body: 'Hold the mic in the composer to record. The bubble draws the actual waveform, so you can see the shape of what you are about to hear.',
          },
          {
            title: 'Calls ring like calls',
            body: 'An incoming call now rings your iPhone even with yappy closed — lock screen, system UI, the real thing. Answer, decline and mute from anywhere.',
          },
          {
            title: 'Video notes',
            body: 'Tap through to the camera for a round video message. The circle now shows the first frame instead of a black disc, so you know what you are opening.',
          },
        ],
      },
      {
        heading: 'Faster hands',
        icon: 'hand.draw',
        items: [
          {
            title: 'Swipe to reply',
            body: 'Drag any message to the side to quote it, the way you already expect to.',
          },
          {
            title: 'Double-tap to react',
            body: 'Two taps on a message drops a heart on it. No menu, no long-press.',
          },
          {
            title: 'Swipe out to the channels',
            body: 'Inside a channel, swipe right to left to pop back to the space and its channel list. There is a # button in the header too.',
          },
        ],
      },
      {
        heading: 'Make it yours',
        icon: 'face.smiling',
        items: [
          {
            title: 'Custom sticker packs',
            body: 'DM @yapper and send /stickerpack. It walks you through making a pack, and stickers send without a chat bubble around them.',
          },
          {
            title: 'Quiet hours',
            body: 'Settings now has a window where nothing makes a sound. Notifications still arrive, they just wait their turn.',
          },
          {
            title: 'Who can reach you',
            body: 'Choose who may DM you, add you to groups, and see when you were last online.',
          },
        ],
      },
      {
        heading: 'Housekeeping',
        icon: 'wrench.and.screwdriver',
        items: [
          {
            title: 'Settings stopped lying',
            body: 'Toggles used to flash the wrong state for a moment when the screen opened. They now open on the real value.',
          },
          {
            title: 'Chats stay put',
            body: 'Reopening a conversation no longer replays your last message as if it were sending again.',
          },
          {
            title: 'Spaces stopped crashing',
            body: 'Opening a space could take the app down with it. Fixed.',
          },
        ],
      },
    ],
  },
  {
    id: '1.0.9',
    version: '1.0.9',
    date: '2026-07-28',
    title: "What's New",
    intro: 'A quieter release, mostly about the parts that were getting in your way.',
    sections: [
      {
        heading: 'Fixes',
        icon: 'checkmark.seal',
        items: [
          {
            title: 'The timeline loads first time',
            body: 'Opening a chat used to show nothing until you sent a message. It shows your history immediately now.',
          },
          {
            title: 'Slash commands behave',
            body: 'Typing / no longer wipes the conversation behind the command list, and @yapper answers again.',
          },
          {
            title: 'Silent notifications',
            body: 'Turning the sound off keeps the notification — it just arrives quietly.',
          },
        ],
      },
    ],
  },
];

/** Newest note a platform should be offered, or `null` if there are none. */
export function latestReleaseNote(platform?: ClientPlatform): ReleaseNote | null {
  const visible = CHANGELOG.filter((n) => !n.platforms || !platform || n.platforms.includes(platform));
  return visible[0] ?? null;
}

/**
 * Notes newer than `sinceId`, newest first.
 *
 * An unknown `sinceId` — a client that saw a note we have since renamed, or one
 * restored from an old backup — returns everything rather than nothing. Showing
 * a note twice is a smaller failure than silently never showing it again.
 */
export function releaseNotesSince(sinceId: string | null | undefined, platform?: ClientPlatform): ReleaseNote[] {
  const visible = CHANGELOG.filter((n) => !n.platforms || !platform || n.platforms.includes(platform));
  if (!sinceId) return visible;

  const index = visible.findIndex((n) => n.id === sinceId);
  return index === -1 ? visible : visible.slice(0, index);
}
