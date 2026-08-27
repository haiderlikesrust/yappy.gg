import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { mutate, useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { errText, uploadMedia } from '../group/groupKit';
import { CreateChannelModal } from './CreateChannelModal';
import {
  canManageSpace,
  channelsOf,
  loadChannels,
  reorderChannels,
  type SpaceConversation,
} from './lib';
import { SpaceGlyph } from './spaceIcons';
import { joinVoice } from '../voice/voice';
import '../group/group.css';
import './space.css';

/**
 * The space itself, on its own page — Android's SpaceScreen, as a modal.
 *
 * Identity up top (picture, name, description — editable with
 * MANAGE_CONVERSATION), the channel roster below with the full management
 * set: rename, reorder, delete, create. Renames go through the ordinary
 * PATCH /conversations/:id — a channel is a conversation; deletion through
 * the space route so the server can hold the "a space keeps at least one
 * channel" line.
 */
export function SpaceOverview(props: {
  space: Conversation;
  onClose: () => void;
  onSelectChannel: (id: string) => void;
}) {
  const { space, onClose } = props;
  const { state } = useStore();
  const canManage = canManageSpace(space);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(space.title ?? '');
  const [descDraft, setDescDraft] = useState(space.description ?? '');
  const [descDirty, setDescDirty] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadChannels(space.id).catch(() => {});
  }, [space.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const channels = channelsOf(state.conversations, space.id);

  /** PATCH any conversation (the space or one of its channels) into the store. */
  const patchConversation = async (
    id: string,
    body: Record<string, unknown>,
    key: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    setError(null);
    try {
      const res = await api<{ conversation: Conversation }>(`/conversations/${id}`, {
        method: 'PATCH',
        body,
      });
      mutate((s) => {
        const conv = s.conversations.get(id);
        if (conv) Object.assign(conv, res.conversation);
      });
      return true;
    } catch (err) {
      setError(errText(err, 'Could not save'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveTitle = async (): Promise<void> => {
    const name = titleDraft.trim();
    if (!name || name === space.title) {
      setEditingTitle(false);
      return;
    }
    if (await patchConversation(space.id, { title: name }, 'title')) setEditingTitle(false);
  };

  const saveDescription = async (): Promise<void> => {
    const text = descDraft.trim();
    if (await patchConversation(space.id, { description: text || null }, 'description')) {
      setDescDirty(false);
    }
  };

  const pickAvatar = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      setError('The space picture must be an image');
      return;
    }
    setBusy('avatar');
    setError(null);
    try {
      const media = await uploadMedia(file, 'conversation_avatar');
      setBusy(null);
      await patchConversation(space.id, { avatarMediaId: media.id }, 'avatar');
    } catch (err) {
      setError(errText(err, 'Could not upload the picture'));
      setBusy(null);
    }
  };

  const startRename = (ch: SpaceConversation): void => {
    setRenamingId(ch.id);
    setRenameDraft(ch.title ?? '');
    setDeletingId(null);
  };

  const saveRename = async (): Promise<void> => {
    if (!renamingId) return;
    const name = renameDraft.trim();
    const current = channels.find((c) => c.id === renamingId);
    if (!name || name === current?.title) {
      setRenamingId(null);
      return;
    }
    if (await patchConversation(renamingId, { title: name }, `rename:${renamingId}`)) {
      setRenamingId(null);
    }
  };

  const deleteChannel = async (channelId: string): Promise<void> => {
    if (busy) return;
    setBusy(`delete:${channelId}`);
    setError(null);
    try {
      await api(`/conversations/${space.id}/channels/${channelId}`, { method: 'DELETE' });
      mutate((s) => {
        s.conversations.delete(channelId);
        if (s.selectedId === channelId) s.selectedId = null;
      });
      setDeletingId(null);
    } catch (err) {
      setError(errText(err, 'Could not delete the channel'));
    } finally {
      setBusy(null);
    }
  };

  const move = (index: number, delta: number): void => {
    const next = channels.map((c) => c.id);
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    next.splice(to, 0, next.splice(index, 1)[0]!);
    void reorderChannels(space.id, next);
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal sp-ov" role="dialog" aria-label="Space overview">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Space</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {/* ── Identity ─────────────────────────────────────────────────── */}
        <div className="sp-ov-id">
          <button
            className="sp-ov-avatar"
            disabled={!canManage || busy === 'avatar'}
            title={canManage ? 'Change the space picture' : undefined}
            onClick={() => fileRef.current?.click()}
          >
            <Avatar kind="place" name={space.title ?? 'space'} url={space.avatarUrl} size={64} />
            {canManage && (
              <span className="sp-ov-avatar-edit">
                <Icon name="edit" size={12} />
              </span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickAvatar(f);
              e.target.value = '';
            }}
          />
          <div className="sp-ov-id-main">
            {editingTitle ? (
              <input
                className="sp-ov-title-input"
                autoFocus
                value={titleDraft}
                maxLength={100}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveTitle();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                onBlur={() => void saveTitle()}
              />
            ) : (
              <div className="sp-ov-title">
                {space.title ?? 'Unnamed space'}
                {canManage && (
                  <button
                    className="sp-ov-mini"
                    title="Rename the space"
                    aria-label="Rename the space"
                    onClick={() => {
                      setTitleDraft(space.title ?? '');
                      setEditingTitle(true);
                    }}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                )}
              </div>
            )}
            <div className="sp-ov-sub">
              {space.memberCount} {space.memberCount === 1 ? 'member' : 'members'} ·{' '}
              {channels.length} {channels.length === 1 ? 'channel' : 'channels'}
            </div>
          </div>
        </div>

        {canManage ? (
          <div className="sp-ov-desc">
            <textarea
              value={descDraft}
              placeholder="What is this space about?"
              maxLength={1024}
              rows={2}
              onChange={(e) => {
                setDescDraft(e.target.value);
                setDescDirty(true);
              }}
            />
            {descDirty && (
              <button
                className="btn-accent sp-ov-desc-save"
                disabled={busy === 'description'}
                onClick={() => void saveDescription()}
              >
                {busy === 'description' ? 'Saving…' : 'Save description'}
              </button>
            )}
          </div>
        ) : (
          space.description && <div className="sp-ov-desc-read">{space.description}</div>
        )}

        {/* ── Channels ─────────────────────────────────────────────────── */}
        <div className="sp-ov-heading">Channels</div>
        <div className="sp-ov-channels">
          {channels.map((ch, index) => (
            <div key={ch.id} className="sp-ov-chan">
              <span className="sp-chan-glyph">
                {ch.isVoice ? (
                  <Icon name="volume" size={15} />
                ) : ch.isAnnouncement ? (
                  <Icon name="megaphone" size={15} />
                ) : (
                  <SpaceGlyph name="hash" size={15} />
                )}
              </span>

              {renamingId === ch.id ? (
                <input
                  className="sp-ov-rename"
                  autoFocus
                  value={renameDraft}
                  maxLength={100}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRename();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => void saveRename()}
                />
              ) : (
                <button
                  className="sp-ov-chan-title"
                  title={ch.isVoice ? 'Join voice' : 'Open channel'}
                  onClick={() => {
                    if (ch.isVoice) {
                      void joinVoice(ch.id);
                      props.onClose();
                    } else {
                      props.onSelectChannel(ch.id);
                    }
                  }}
                >
                  {ch.title ?? 'channel'}
                </button>
              )}

              {canManage && renamingId !== ch.id && deletingId !== ch.id && (
                <div className="sp-ov-chan-tools">
                  <button
                    className="sp-ov-mini"
                    title="Rename"
                    aria-label={`Rename ${ch.title ?? 'channel'}`}
                    onClick={() => startRename(ch)}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                  <button
                    className="sp-ov-mini"
                    title="Move up"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <Icon name="chevron-right" size={13} style={{ transform: 'rotate(-90deg)' }} />
                  </button>
                  <button
                    className="sp-ov-mini"
                    title="Move down"
                    aria-label="Move down"
                    disabled={index === channels.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <Icon name="chevron-right" size={13} style={{ transform: 'rotate(90deg)' }} />
                  </button>
                  <button
                    className="sp-ov-mini danger"
                    title="Delete"
                    aria-label={`Delete ${ch.title ?? 'channel'}`}
                    disabled={channels.length <= 1}
                    onClick={() => setDeletingId(ch.id)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              )}

              {deletingId === ch.id && (
                <div className="sp-ov-chan-tools">
                  <span className="sp-ov-confirm">Delete #{ch.title ?? 'channel'}?</span>
                  <button
                    className="sp-ov-mini danger"
                    disabled={busy === `delete:${ch.id}`}
                    onClick={() => void deleteChannel(ch.id)}
                  >
                    <Icon name="check" size={13} />
                  </button>
                  <button className="sp-ov-mini" onClick={() => setDeletingId(null)}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}

          {canManage && (
            <button className="sp-tool" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={14} />
              New channel
            </button>
          )}
        </div>

        {createOpen && (
          <CreateChannelModal
            space={space}
            onClose={() => setCreateOpen(false)}
            onCreated={(id) => {
              setCreateOpen(false);
              props.onSelectChannel(id);
            }}
          />
        )}
      </div>
    </div>
  );
}
