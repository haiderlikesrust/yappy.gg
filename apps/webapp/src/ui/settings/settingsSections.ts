import type { IconName } from '../icons';

export const SETTINGS_SECTIONS: Array<{
  id: string;
  title: string;
  icon: IconName;
  description: string;
  keywords: string;
}> = [
  {
    id: 'account',
    title: 'Account',
    icon: 'user',
    description: 'Your profile, presence, and sign-in details.',
    keywords:
      'name username avatar banner flair bio status password email verification affiliation',
  },
  {
    id: 'privacy',
    title: 'Privacy',
    icon: 'shield',
    description: 'Choose who can reach you and keep your chats private.',
    keywords: 'people contacts blocked block hidden chats passcode app lock',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: 'bell',
    description: 'Make room for the notifications you care about.',
    keywords:
      'sounds calls reactions previews announcements banners quiet hours muted mentions groups',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    icon: 'sparkle',
    description: 'Make yappy feel at home on this browser.',
    keywords: 'theme light dark system color colour enter send keyboard composer chat',
  },
  {
    id: 'devices',
    title: 'Devices',
    icon: 'lock',
    description: 'Review where you’re signed in.',
    keywords: 'sessions browser revoke security login sign out',
  },
  {
    id: 'about',
    title: 'About',
    icon: 'paw',
    description: 'A little more human.',
    keywords: 'version updates what new release tour support help terms policy legal',
  },
  {
    id: 'developer',
    title: 'Developer',
    icon: 'settings',
    description: 'Tools for building with yappy.',
    keywords: 'bots debug developer console api',
  },
];
export function searchSettings(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  return SETTINGS_SECTIONS.filter((section) =>
    terms.every((term) =>
      `${section.title} ${section.description} ${section.keywords}`
        .toLocaleLowerCase()
        .includes(term),
    ),
  );
}
