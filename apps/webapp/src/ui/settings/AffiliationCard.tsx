import { useState } from 'react';
import { api } from '../../lib/api';
import type { Self } from '../../lib/types';
import { mutate, useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { BadgeMark } from '../badges';

/**
 * Which badged group's mark rides beside your name — the member's half of an
 * affiliation. Only rendered when a badged group has actually affiliated you,
 * so for almost everyone this card does not exist; an empty "Affiliation"
 * section would only raise a question nobody needed answered.
 */
export function AffiliationCard() {
  const { state } = useStore();
  const me = state.me;
  const [busy, setBusy] = useState(false);

  const eligible = [...state.conversations.values()].filter(
    (c) => c.badge && c.self?.isAffiliate,
  );
  if (!me || eligible.length === 0) return null;

  const current = me.affiliation?.id ?? null;

  const pick = async (conversationId: string | null): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api<{ user: Self }>('/users/me', {
        method: 'PATCH',
        body: { affiliationConversationId: conversationId },
      });
      mutate((s) => {
        s.me = res.user;
      });
    } catch {
      /* the row keeps its old state; the next click retries */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Affiliation</div>
      <div className="stg-hint" style={{ marginBottom: 8 }}>
        A group that vouched for you. Its logo rides beside your name everywhere.
      </div>
      {eligible.map((group) => {
        const selected = current === group.id;
        return (
          <button
            key={group.id}
            className={`stg-nav-row aff-row${selected ? ' on' : ''}`}
            disabled={busy}
            onClick={() => void pick(selected ? null : group.id)}
          >
            <Avatar kind="place" name={group.title ?? 'group'} url={group.avatarUrl} size={28} />
            <span className="aff-row-title">{group.title ?? 'Unnamed group'}</span>
            {group.badge && <BadgeMark badge={group.badge} size={14} />}
            <span className="aff-row-state">{selected ? 'Shown' : 'Show'}</span>
          </button>
        );
      })}
      {current && (
        <button className="stg-nav-row aff-none" disabled={busy} onClick={() => void pick(null)}>
          Show none
        </button>
      )}
    </div>
  );
}
