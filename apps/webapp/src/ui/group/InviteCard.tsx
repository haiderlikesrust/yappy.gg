import { useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, EmbedInvite } from '../../lib/types';
import { gateway, getState, mutate, selectConversation } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import './group.css';

/**
 * A group invite unfurled inside a message (`embed.invite`), rendered as a
 * joinable card — squircle avatar, title, member count, badge, Join.
 *
 * Joining is POST /v1/conversations/invites/:code/join, which answers
 * { conversation, alreadyMember } — the full conversation view either way, so
 * the card can insert it into the store and open it. Exported for the chat
 * surface to render wherever an embed carries an invite.
 */
export function InviteCard(props: { invite: EmbedInvite }) {
  const { invite } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyIn = getState().conversations.size > 0 && isMemberOfInvite(invite);

  const join = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ conversation: Conversation; alreadyMember: boolean }>(
        `/conversations/invites/${invite.code}/join`,
        { method: 'POST' },
      );
      mutate((s) => {
        const existing = s.conversations.get(res.conversation.id);
        s.conversations.set(
          res.conversation.id,
          existing ? { ...existing, ...res.conversation } : res.conversation,
        );
      });
      gateway.subscribe(res.conversation.id);
      await selectConversation(res.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This invite is no longer valid');
      setBusy(false);
    }
  };

  return (
    <div className="invite-card">
      <Avatar kind="place" name={invite.title} url={invite.avatarUrl} size={48} />
      <div className="invite-card-main">
        <div className="invite-card-kicker">Group invite</div>
        <div className="invite-card-title">
          <span>{invite.title ?? 'A group on yappy'}</span>
          {invite.badge && (
            <span className="invite-badge">
              <Icon name="shield" size={10} /> {invite.badge}
            </span>
          )}
        </div>
        <div className="invite-card-sub">
          {invite.memberCount != null
            ? `${invite.memberCount} member${invite.memberCount === 1 ? '' : 's'}`
            : invite.description ?? 'Tap join to walk in'}
        </div>
        {error && <div className="grp-error" style={{ padding: '4px 0 0' }}>{error}</div>}
      </div>
      <button
        className={`invite-join ${alreadyIn ? 'joined' : ''}`}
        disabled={busy}
        onClick={() => void join()}
      >
        {busy ? 'Joining…' : alreadyIn ? 'Open' : 'Join'}
      </button>
    </div>
  );
}

/**
 * Best-effort "already a member" hint: the embed carries no conversation id,
 * so match on title among the groups already in the store. Join is idempotent
 * server-side (alreadyMember: true), so a false negative only costs a click
 * that still lands in the right room.
 */
function isMemberOfInvite(invite: EmbedInvite): boolean {
  if (!invite.title) return false;
  for (const conv of getState().conversations.values()) {
    if (conv.type !== 'dm' && conv.title === invite.title) return true;
  }
  return false;
}
