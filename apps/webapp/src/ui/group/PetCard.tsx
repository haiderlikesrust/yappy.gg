import { useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, GroupPet } from '../../lib/types';
import { mutate } from '../../state/store';
import { Icon } from '../icons';
import { PixelPet, petSpecies } from './PixelPet';
import './group.css';

/**
 * The pet card, styled like the phones' group page: the creature, its name,
 * how it is doing, and — for owners/admins — the naming affordance.
 *
 * Renaming goes through PATCH /v1/conversations/:id/pet with
 * `{ name: string | null }` (null un-names it, back to being just "the pet").
 */

const DEFAULT_PET: GroupPet = { name: null, stage: 'egg', mood: 'happy' };

function moodLine(pet: GroupPet, species: string): string {
  const creature = pet.stage === 'egg' ? 'egg' : species;
  switch (pet.mood) {
    case 'gone':
      return `The ${creature} has wandered off. Keep talking and it may come back.`;
    case 'hungry':
      return `The ${creature} is hungry — it feeds on conversation.`;
    case 'sad':
      return `The ${creature} is feeling lonely. It has been quiet in here.`;
    default:
      return pet.stage === 'egg'
        ? 'Something is stirring inside. Keep the chat warm.'
        : `The ${creature} is thriving.`;
  }
}

export function PetCard(props: {
  conversation: Conversation;
  /** Owner/admin — shows the rename affordance. */
  canName?: boolean;
}) {
  const { conversation } = props;
  const pet = conversation.pet ?? DEFAULT_PET;
  const species = petSpecies(conversation.id);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = (): void => {
    setDraft(pet.name ?? '');
    setError(null);
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    const name = draft.trim().slice(0, 32) || null;
    setSaving(true);
    setError(null);
    try {
      await api<{ ok: boolean; name: string | null }>(`/conversations/${conversation.id}/pet`, {
        method: 'PATCH',
        body: { name },
      });
      mutate((s) => {
        const conv = s.conversations.get(conversation.id);
        if (conv) conv.pet = { ...(conv.pet ?? DEFAULT_PET), name };
      });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the pet');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pet-card">
      <PixelPet conversationId={conversation.id} pet={pet} size={88} />
      <div className="pet-card-main">
        {editing ? (
          <div className="gp-inline-edit">
            <input
              autoFocus
              value={draft}
              maxLength={32}
              placeholder="Name the pet"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <button className="gp-inline-save" disabled={saving} onClick={() => void save()}>
              Save
            </button>
          </div>
        ) : (
          <div className="pet-name">
            <Icon name="paw" size={15} />
            <span>{pet.name ?? `the group ${pet.stage === 'egg' ? 'egg' : species}`}</span>
            {props.canName && (
              <button className="gp-rename" title="Name the pet" onClick={startEdit}>
                <Icon name="edit" size={14} />
              </button>
            )}
          </div>
        )}
        {error && <div className="grp-error" style={{ padding: '4px 0 0' }}>{error}</div>}
        <div className="pet-mood">{moodLine(pet, species)}</div>
        {(pet.streak ?? 0) > 0 && (
          <div className="pet-streak">
            {pet.streak} day streak
            {pet.fedToday ? ' — fed today' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
