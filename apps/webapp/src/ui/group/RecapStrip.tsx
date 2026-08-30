import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/**
 * The last month of this place, in numbers worth repeating.
 *
 * A group-first app has no follower counts; this is the social proof it has
 * instead. Rendered as one quiet strip, not a dashboard — the numbers are the
 * brag, and a brag works best short.
 */

interface Recap {
  days: number;
  messages: number;
  activeMembers: number;
  newMembers: number;
  topEmoji: { emoji: string; count: number } | null;
}

export function RecapStrip(props: { conversationId: string }) {
  const [recap, setRecap] = useState<Recap | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Recap>(`/conversations/${props.conversationId}/recap`)
      .then((res) => {
        if (!cancelled) setRecap(res);
      })
      .catch(() => {
        /* a DM, or a fetch that failed — the strip simply does not render */
      });
    return () => {
      cancelled = true;
    };
  }, [props.conversationId]);

  // A dead-quiet group gets no strip: "0 messages this month" is not social
  // proof, it is an accusation.
  if (!recap || recap.messages === 0) return null;

  return (
    <div className="gp-recap" title={`The last ${recap.days} days`}>
      this month · <b>{recap.messages.toLocaleString()}</b> messages ·{' '}
      <b>{recap.activeMembers}</b> talking
      {recap.newMembers > 0 && (
        <>
          {' '}
          · <b>{recap.newMembers}</b> joined
        </>
      )}
      {recap.topEmoji && <> · {recap.topEmoji.emoji}</>}
    </div>
  );
}
