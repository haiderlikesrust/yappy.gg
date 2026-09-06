import assert from 'node:assert/strict';
import type { Conversation } from '../src/lib/types';
import {
  CHAT_FILTERS,
  conversationUnread,
  filterConversations,
} from '../src/ui/conversationFilters';
import { clampSidebarWidth } from '../src/lib/appearance';
import { searchSettings } from '../src/ui/settings/settingsSections';

const c = (id: string, type: string, extra = {}) =>
  ({ id, type, title: id, self: { unreadCount: 0 }, ...extra }) as Conversation;
const list = [
  c('a', 'dm', { otherUser: { username: 'sam', displayName: 'Sam Rivera' } }),
  c('b', 'group', { self: { unreadCount: 2 } }),
  c('space', 'space', { self: { unreadCount: 4 } }),
  c('design', 'channel', { parentId: 'space', self: { unreadCount: 4 } }),
  c('hidden', 'group', { self: { isHidden: true, unreadCount: 9 } }),
  c('archived', 'group', { self: { isArchived: true, unreadCount: 9 } }),
];
assert.deepEqual(
  CHAT_FILTERS.map((filter) => filterConversations(list, filter, '').map((c) => c.id)),
  [['a', 'b', 'space'], ['b', 'space'], ['a'], ['b', 'space']],
);
assert.deepEqual(
  filterConversations(list, 'Unread', ' sAm ').map((c) => c.id),
  ['a'],
);
assert.deepEqual(
  filterConversations(list, 'All', 'design').map((c) => c.id),
  ['space'],
);
assert.deepEqual(filterConversations(list, 'All', 'hidden'), []);
assert.equal(
  conversationUnread(list[2]!, [list[3]!]),
  4,
  'A space roll-up must not count its children twice.',
);
assert.equal(
  filterConversations([c('space', 'space'), list[3]!], 'Unread', '').length,
  1,
  'Child unread survives a stale parent summary.',
);
assert.equal(
  filterConversations(
    [
      c('space', 'space'),
      c('secret', 'channel', {
        parentId: 'space',
        self: { isHidden: true, unreadCount: 5 },
      }),
    ],
    'Unread',
    '',
  ).length,
  0,
);
assert.deepEqual([250, 500, 348, NaN, Infinity].map(clampSidebarWidth), [280, 480, 348, 348, 348]);
assert.deepEqual(
  searchSettings('quiet hours').map((s) => s.id),
  ['notifications'],
);
assert.deepEqual(
  searchSettings(' DARK ').map((s) => s.id),
  ['appearance'],
);
assert.deepEqual(searchSettings('unfindable setting'), []);
console.log(
  'Web refresh checks passed: filters, space unread counts, search, resize bounds, settings search.',
);
