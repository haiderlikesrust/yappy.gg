import { useRef, useState } from 'react';
import { ChannelWebhooks } from './ChannelWebhooks';
import { ChannelAccess } from './ChannelAccess';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { mutate } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { Glyph, errText, uploadMedia } from './groupKit';
import './group.css';

/**
 * Deep group settings, for holders of MANAGE_CONVERSATION.
 *
 * Everything here is PATCH /v1/conversations/:id (updateConversationBody,
 * packages/shared/src/schemas.ts:284):
 *   description        ≤1024 chars, nullable
 *   avatarMediaId      a confirmed media id uploaded with purpose
 *                      'conversation_avatar' (public bucket) — see uploadMedia
 *   slowModeSeconds    any int 0..21600; we offer off/5s/30s/1m/5m
 *   disappearingSeconds must be one of DISAPPEARING_PRESETS
 *   historyVisibility  'since_join' | 'full' (applies to future joiners only)
 *   appearance         { gradient?: [hex,hex], accent?, emoji?, effect } — the
 *                      flair the discover cards render; null clears all flair
 * The response is the full serialized view; we fold it into the store.
 */

interface Appearance {
  accent?: string | null;
  gradient?: [string, string] | null;
  effect?: string;
  emoji?: string | null;
}

const SLOW_MODES: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: 'Off' },
  { seconds: 5, label: '5s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 300, label: '5m' },
];

const DISAPPEARING: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: 'Off' },
  { seconds: 3_600, label: '1 hour' },
  { seconds: 86_400, label: '24 hours' },
  { seconds: 604_800, label: '1 week' },
  { seconds: 2_592_000, label: '30 days' },
  { seconds: 7_776_000, label: '90 days' },
];

const GRADIENTS: Array<{ name: string; stops: [string, string] }> = [
  { name: 'Orchid', stops: ['#8b7cff', '#ff8bd2'] },
  { name: 'Lagoon', stops: ['#6c5ce7', '#00cec9'] },
  { name: 'Ember', stops: ['#ff7b54', '#ffd84a'] },
  { name: 'Aurora', stops: ['#3dd68c', '#8b7cff'] },
  { name: 'Dusk', stops: ['#ff6369', '#8b7cff'] },
];

export function GroupSettingsPanel(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const appearance = (conversation as { appearance?: Appearance | null }).appearance ?? null;
  const historyVisibility =
    (conversation as { historyVisibility?: string }).historyVisibility ?? 'since_join';

  const [descDraft, setDescDraft] = useState(conversation.description ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** One PATCH, folded back into the store. `key` labels the busy spinner. */
  const patch = async (key: string, body: Record<string, unknown>): Promise<void> => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await api<{ conversation: Conversation }>(`/conversations/${conversation.id}`, {
        method: 'PATCH',
        body,
      });
      mutate((st) => {
        const conv = st.conversations.get(conversation.id);
        if (conv) Object.assign(conv, res.conversation);
      });
    } catch (err) {
      setError(errText(err, 'Could not save'));
    } finally {
      setBusy(null);
    }
  };

  const pickAvatar = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      setError('The group picture must be an image');
      return;
    }
    if (file.size > 25_000_000) {
      setError('That image is too large (25 MB max)');
      return;
    }
    setBusy('avatar');
    setError(null);
    try {
      const media = await uploadMedia(file, 'conversation_avatar');
      setBusy(null);
      await patch('avatar', { avatarMediaId: media.id });
    } catch (err) {
      setError(errText(err, 'Could not upload the picture'));
      setBusy(null);
    }
  };

  const setGradient = (stops: [string, string] | null): void => {
    if (stops === null && !appearance) return; // nothing to clear
    void patch(
      'appearance',
      stops === null
        ? { appearance: null }
        : { appearance: { ...(appearance ?? {}), gradient: stops } },
    );
  };

  const activeGradient = appearance?.gradient ?? null;
  const slowMode = conversation.slowModeSeconds ?? 0;
  const disappearing = conversation.disappearingSeconds ?? 0;

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal gs-modal" role="dialog" aria-label="Group settings">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Group settings</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        <div className="gs-body">
          {/* Picture */}
          <div className="gs-row gs-avatar-row">
            <Avatar kind="place" name={conversation.title} url={conversation.avatarUrl} size={56} />
            <div className="gs-row-main">
              <div className="gs-label">Group picture</div>
              <div className="gs-sub">Shown everywhere this place appears.</div>
            </div>
            <button
              className="inv-btn"
              disabled={busy === 'avatar'}
              onClick={() => fileRef.current?.click()}
            >
              <Glyph name="upload" size={14} /> {busy === 'avatar' ? 'Uploading…' : 'Change'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void pickAvatar(file);
              }}
            />
          </div>

          {/* Description */}
          <div className="gs-row gs-col">
            <div className="gs-label">Description</div>
            <textarea
              className="gs-textarea"
              rows={3}
              maxLength={1024}
              placeholder="What is this place about?"
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
            />
            {descDraft !== (conversation.description ?? '') && (
              <button
                className="gp-inline-save"
                disabled={busy === 'description'}
                onClick={() => void patch('description', { description: descDraft.trim() || null })}
              >
                Save description
              </button>
            )}
          </div>

          {/* Slow mode */}
          <div className="gs-row gs-col">
            <div className="gs-label">
              <Glyph name="clock" size={14} /> Slow mode
            </div>
            <div className="gs-sub">How long members wait between messages.</div>
            <div className="gs-choices">
              {SLOW_MODES.map((opt) => (
                <button
                  key={opt.seconds}
                  className={`gs-choice ${slowMode === opt.seconds ? 'active' : ''}`}
                  disabled={busy === 'slow'}
                  onClick={() => void patch('slow', { slowModeSeconds: opt.seconds })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Disappearing messages */}
          <div className="gs-row gs-col">
            <div className="gs-label">
              <Glyph name="hourglass" size={14} /> Disappearing messages
            </div>
            <div className="gs-sub">New messages vanish for everyone after this long.</div>
            <div className="gs-choices">
              {DISAPPEARING.map((opt) => (
                <button
                  key={opt.seconds}
                  className={`gs-choice ${disappearing === opt.seconds ? 'active' : ''}`}
                  disabled={busy === 'disappearing'}
                  onClick={() => void patch('disappearing', { disappearingSeconds: opt.seconds })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/*
            Only on a channel, because only a channel sits inside a space with
            roles to gate on. A top-level group has nothing above it to be
            private *from*.
          */}
          {conversation.parentId && (
            <ChannelAccess
              conversationId={conversation.id}
              spaceId={conversation.parentId}
              basePermissions={
                (conversation as { basePermissions?: string | null }).basePermissions ?? null
              }
              onSetBase={(base) => patch('access', { basePermissions: base })}
            />
          )}

          {/* Webhooks are channel plumbing, so they live beside access. */}
          {conversation.parentId && <ChannelWebhooks conversationId={conversation.id} />}

          {/* History visibility */}
          <div className="gs-row gs-col">
            <div className="gs-label">
              <Glyph name="eye" size={14} /> History for new members
            </div>
            <div className="gs-sub">Applies to people who join from now on.</div>
            <div className="gs-choices">
              <button
                className={`gs-choice ${historyVisibility === 'since_join' ? 'active' : ''}`}
                disabled={busy === 'history'}
                onClick={() => void patch('history', { historyVisibility: 'since_join' })}
              >
                From their join
              </button>
              <button
                className={`gs-choice ${historyVisibility === 'full' ? 'active' : ''}`}
                disabled={busy === 'history'}
                onClick={() => void patch('history', { historyVisibility: 'full' })}
              >
                Everything
              </button>
            </div>
          </div>

          {/* Flair */}
          <div className="gs-row gs-col">
            <div className="gs-label">
              <Glyph name="palette" size={14} /> Flair
            </div>
            <div className="gs-sub">A gradient the group wears on cards and its chat.</div>
            <div className="gs-choices">
              <button
                className={`gs-choice ${!activeGradient ? 'active' : ''}`}
                disabled={busy === 'appearance'}
                onClick={() => setGradient(null)}
              >
                None
              </button>
              {GRADIENTS.map((g) => {
                const active =
                  !!activeGradient &&
                  activeGradient[0]?.toLowerCase() === g.stops[0] &&
                  activeGradient[1]?.toLowerCase() === g.stops[1];
                return (
                  <button
                    key={g.name}
                    className={`gs-swatch ${active ? 'active' : ''}`}
                    title={g.name}
                    disabled={busy === 'appearance'}
                    style={{ background: `linear-gradient(135deg, ${g.stops[0]}, ${g.stops[1]})` }}
                    onClick={() => setGradient(g.stops)}
                    aria-label={`${g.name} gradient`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
