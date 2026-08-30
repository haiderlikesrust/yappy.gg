/**
 * Static emoji sets for the reaction picker. Content, not chrome — the design
 * rule bans emoji as interface iconography, but a reaction picker's whole job
 * is to offer emoji, so these render as themselves.
 */

export const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;

export const EMOJI_GRID: readonly string[] = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘',
  '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑',
  '🤗', '🤭', '🤫', '🤔', '🫡', '🤐', '😐', '😶',
  '😏', '😒', '🙄', '😬', '😌', '😔', '😪', '🤤',
  '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶',
  '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓',
  '🧐', '😕', '🙁', '😮', '😯', '😲', '😳', '🥺',
  '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😞',
  '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬',
  '😈', '💀', '💩', '🤡', '👻', '👽', '🤖', '😺',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔',
  '💯', '✨', '🔥', '🎉', '👍', '👎', '👏', '🙏',
  '💪', '🤝', '👀', '🫶', '🙌', '🤞', '✌️', '🫠',
];
