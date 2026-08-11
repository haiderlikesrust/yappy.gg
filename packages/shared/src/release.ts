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
export const API_VERSION = '1.3.0';

/**
 * What each client should be on, and what it must be on.
 *
 * `latest` drives the "you're up to date" line in Settings. `minimum` is the
 * force-upgrade floor — clients below it are expected to refuse to run, so
 * raising it strands anyone who cannot update. Raise it only when an older
 * build is actively broken or unsafe, never merely to encourage upgrades.
 */
export const CLIENT_RELEASES: Record<ClientPlatform, { latest: string; minimum: string }> = {
  ios: { latest: '1.3.0', minimum: '1.0.0' },
  android: { latest: '1.3.0', minimum: '1.0.0' },
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
  /**
   * Absent means every platform. A release usually lands everywhere at once,
   * but not always — Android caught up on swipe-to-reply in 1.3, and telling
   * an iPhone about that reads as a feature it already had going missing.
   */
  platforms?: ClientPlatform[];
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
    id: '1.3.0',
    version: '1.3.0',
    date: '2026-08-11',
    title: "What's New",
    intro:
      'Share where you are, find out when somebody screenshots a chat, and see badges next to the people who have them. Bots can now run on a laptop.',
    sections: [
      {
        heading: 'Where you are',
        icon: 'location.fill',
        items: [
          {
            title: 'Send a location',
            body: 'The + menu has Location in it. Send where you are, and it opens in Maps for whoever you sent it to.',
          },
          {
            title: 'Or share it live',
            body: 'For fifteen minutes, an hour, or eight. Everyone in the chat watches you move until it ends, and you can stop at any moment. It ends on its own even if your phone does not — the server holds the clock, not the app.',
          },
        ],
      },
      {
        heading: 'Who saw what',
        icon: 'camera.fill',
        items: [
          {
            title: 'Screenshots are announced',
            body: 'Take a screenshot of a chat and the room is told, the way it works elsewhere. A courtesy rather than a lock: a second phone pointed at the screen sees everything and says nothing, and older Android needs to be asked for permission first.',
          },
        ],
      },
      {
        heading: 'Names carry more',
        icon: 'checkmark.seal.fill',
        items: [
          {
            title: 'Badges, and more than one',
            body: 'OG yapper, beta tester and bot developer join verified, partner and staff — and somebody can hold several at once. The profile says what each one means.',
          },
          {
            title: 'Bots say they are bots',
            body: 'The BOT tag only ever appeared inside a chat bubble. It now sits next to the name everywhere one is drawn: the chat list, member lists, and the bot’s own profile.',
          },
          {
            title: 'Profiles have a top',
            body: 'A banner behind the avatar, filled with your own colour when you have not set a picture. Every profile has a header now instead of an avatar in empty space.',
          },
        ],
      },
      {
        heading: 'Sending things',
        icon: 'photo.fill',
        items: [
          {
            title: 'A picked photo is not a sent photo',
            body: 'Choosing an image used to post it immediately. There is a preview now, with room for a caption, and a send button you have to mean.',
          },
          {
            title: 'Pictures lose the bubble',
            body: 'A photo, video or GIF with nothing written around it draws on its own, the way stickers already did. Add a caption and the bubble comes back to hold it.',
          },
          {
            title: 'Video, on Android',
            body: 'The picker there had only ever offered photos, so a video could not be sent at all. It takes both now.',
          },
        ],
      },
      {
        heading: 'Faster hands',
        icon: 'hand.draw',
        platforms: ['android'],
        items: [
          {
            title: 'Swipe to reply',
            body: 'Drag a message to the right to quote it, instead of long-pressing and picking Reply out of a sheet. iPhone has had this since 1.1.',
          },
        ],
      },
      {
        heading: 'Fixed',
        icon: 'wrench.and.screwdriver.fill',
        items: [
          {
            title: 'Reinstalling no longer erases you',
            body: 'Deleting the app and installing it again left it signed in but unsure whose account it was holding — so every message you had ever sent rendered as somebody else’s, grey and on the left. It knows again, and fixes itself on first launch.',
          },
          {
            title: 'Added someone, and the count',
            body: 'Adding a person to a group changed nothing on screen until you left the chat and came back. The line arrives as it happens, with their name on it rather than “someone”, and the member count moves.',
          },
          {
            title: 'Announcements reach everybody',
            body: 'Every announcement ever sent arrived for exactly one account and reported success. It goes to everyone now, and staff are told how many people and how long it will take.',
          },
          {
            title: 'Buttons stop erroring',
            body: 'Pressing a button on a bot’s card showed an error even when the press had worked. It answers properly now.',
          },
          {
            title: 'Banners stay set',
            body: 'Uploading a banner appeared to work and then flashed back to the plain default everywhere. The picture had been saved somewhere nobody could read it from.',
          },
          {
            title: 'A sent message stops coming back',
            body: 'Send, leave yappy, return — and the text you had just sent was sitting in the box again, waiting to be sent twice.',
          },
        ],
      },
      {
        heading: 'For people building bots',
        icon: 'hammer.fill',
        items: [
          {
            title: 'A bot can dial out',
            body: 'Bots had to be reachable at a public web address, which meant hosting one before writing a line. A bot now opens a connection to yappy instead, so it runs on a laptop with a token and nothing else.',
          },
        ],
      },
    ],
  },
  {
    id: '1.2.1',
    version: '1.2.1',
    date: '2026-08-11',
    title: "What's New",
    intro:
      'Answering from the lock screen carries sound again, stickers arrive as pictures rather than empty squares, and a pasted link stops eating what you wrote.',
    sections: [
      {
        heading: 'Answering works',
        icon: 'phone.fill',
        items: [
          {
            title: 'Audio survives the answer',
            body: 'Picking up from the lock screen connected the call and then carried silence, in both directions. The app and the system were fighting over the same audio session; they now hand it over properly.',
          },
        ],
      },
      {
        heading: 'Messages behave',
        icon: 'bubble.left.and.bubble.right.fill',
        items: [
          {
            title: 'Stickers are pictures again',
            body: 'A sticker only drew if you already had its pack — so one someone had just made arrived as a blank square. Every sticker now carries its own image.',
          },
          {
            title: 'Links stop eating your text',
            body: 'Pasting a link wiped the message you wrote around it until you left the chat and came back. Your words stay put.',
          },
          {
            title: 'Delete for me actually deletes',
            body: 'It has been quietly writing a note nobody read, so the message came straight back on the next load. It is gone now, and only for you.',
          },
          {
            title: 'Channels stay in their space',
            body: 'The first message in a channel used to plant a second copy of it on your home list, beside the space that already holds it.',
          },
        ],
      },
      {
        heading: 'Some new things',
        icon: 'sparkles',
        items: [
          {
            title: 'Add a bot',
            body: 'Group settings has a Bots section and a directory to pick from. The warning above the button is worth reading: a bot in a group receives every message in it.',
          },
          {
            title: 'Say what you are up to',
            body: 'Set a custom status in Settings. It shows on your profile and expires on its own if you give it a deadline.',
          },
          {
            title: 'See who is here',
            body: 'A chat shows who else is looking at it right now. Turn it off in Privacy and you stop appearing — and stop seeing.',
          },
          {
            title: 'Campfires',
            body: 'A group with an end date. It counts down in the header, warns once, and then takes itself and everything in it away.',
          },
          {
            title: 'You know people here',
            body: "A badged group shows who it has vouched for, and how many people in it you already follow.",
          },
        ],
      },
      {
        heading: 'Housekeeping',
        icon: 'wrench.and.screwdriver',
        items: [
          {
            title: 'Nothing spins forever',
            body: 'A profile, thread or group that failed to load says so and offers Retry, instead of a spinner with no end. And a screen you have already seen redraws from what it had rather than starting blank.',
          },
          {
            title: 'Bot buttons say the whole thing',
            body: 'Long labels were squeezed until they read as a different answer — "Only people I follow" arrived as "Only people I". They stack full width now.',
          },
          {
            title: 'Dark mode buttons are visible',
            body: 'Secondary buttons on bot cards filled with the shadow colour, which on a near-black screen is nothing at all. They were labels floating with no button around them.',
          },
        ],
      },
    ],
  },
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

/**
 * Notes this platform should see, with sections it should not see removed.
 *
 * A note whose every section is filtered away is dropped entirely rather than
 * offered as a heading with nothing under it.
 */
function visibleTo(platform?: ClientPlatform): ReleaseNote[] {
  return CHANGELOG.filter((n) => !n.platforms || !platform || n.platforms.includes(platform))
    .map((n) => ({
      ...n,
      sections: n.sections
        .filter((s) => !s.platforms || !platform || s.platforms.includes(platform))
        // `platforms` is an authoring detail. The caller has already been given
        // the sections that apply to it, so shipping the field would only invite
        // a client to filter a second time on a rule it does not own.
        .map(({ platforms: _platforms, ...section }) => section),
    }))
    .filter((n) => n.sections.length > 0);
}

/** Newest note a platform should be offered, or `null` if there are none. */
export function latestReleaseNote(platform?: ClientPlatform): ReleaseNote | null {
  return visibleTo(platform)[0] ?? null;
}

/**
 * Notes newer than `sinceId`, newest first.
 *
 * An unknown `sinceId` — a client that saw a note we have since renamed, or one
 * restored from an old backup — returns everything rather than nothing. Showing
 * a note twice is a smaller failure than silently never showing it again.
 */
export function releaseNotesSince(sinceId: string | null | undefined, platform?: ClientPlatform): ReleaseNote[] {
  const visible = visibleTo(platform);
  if (!sinceId) return visible;

  const index = visible.findIndex((n) => n.id === sinceId);
  return index === -1 ? visible : visible.slice(0, index);
}
