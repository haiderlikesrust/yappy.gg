import { useEffect, useMemo } from 'react';
import { auth } from './lib/api';
import {
  bootstrap,
  pruneTyping,
  selectConversation,
  signedOutReset,
  useStore,
} from './state/store';
import { AuthScreen } from './ui/AuthScreen';
import { ChatView } from './ui/ChatView';
import { Sidebar } from './ui/Sidebar';

export function App() {
  const { state, version } = useStore();

  useEffect(() => {
    auth.handleSignedOut(() => signedOutReset());
    if (auth.isSignedIn) void bootstrap();
    const timer = setInterval(pruneTyping, 2_000);
    return () => clearInterval(timer);
  }, []);

  const conversations = useMemo(
    () =>
      [...state.conversations.values()].sort((a, b) => {
        const pinDiff = Number(b.self?.isPinned ?? false) - Number(a.self?.isPinned ?? false);
        if (pinDiff !== 0) return pinDiff;
        return Date.parse(b.lastMessageAt ?? '1970') - Date.parse(a.lastMessageAt ?? '1970');
      }),
    // The store mutates the map in place; the change counter is the honest
    // dependency.
    [state.conversations, version],
  );

  if (!state.me && !auth.isSignedIn) {
    return <AuthScreen onSignedIn={() => void bootstrap()} />;
  }

  const selected = state.selectedId ? state.conversations.get(state.selectedId) : null;
  const messages = state.selectedId ? (state.messages.get(state.selectedId) ?? []) : [];
  const typing = state.selectedId
    ? [...(state.typing.get(state.selectedId)?.keys() ?? [])]
    : [];

  return (
    <div className="shell">
      <Sidebar
        me={state.me}
        status={state.status}
        conversations={conversations}
        selectedId={state.selectedId}
        onSelect={(id) => void selectConversation(id)}
      />
      {selected && state.me ? (
        <ChatView
          me={state.me}
          conversation={selected}
          messages={messages}
          typingUserIds={typing}
          hasMore={state.hasMoreHistory.get(selected.id) ?? false}
        />
      ) : (
        <div className="chat-empty">Pick a place. Or a person.</div>
      )}
    </div>
  );
}
