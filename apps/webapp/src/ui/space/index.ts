/** Spaces — container conversations with channels. One import for the shell. */
export { ChannelList } from './ChannelList';
export { CreateChannelModal } from './CreateChannelModal';
export { SpaceOverview } from './SpaceOverview';
export { UpgradeToSpace } from './UpgradeToSpace';
export { SpaceGlyph } from './spaceIcons';
export {
  canManageSpace,
  channelsOf,
  isSpace,
  loadChannels,
  loadChannelsForSpaces,
  reorderChannels,
} from './lib';
export type { SpaceConversation } from './lib';
