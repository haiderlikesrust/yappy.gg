import { useEffect, useMemo } from 'react';
import { auth } from './lib/api';
import {
  bootstrap,
  mutate,
  pruneTyping,
  selectConversation,
  signedOutReset,
  useStore,
  type AppView,
} from './state/store';
import { AuthScreen } from './ui/AuthScreen';
import { ChatView } from './ui/ChatView';
import { Sidebar } from './ui/Sidebar';
import { ExploreScreen } from './ui/explore/ExploreScreen';
import { SettingsScreen } from './ui/settings/SettingsScreen';

const NAV: Array<{ view: AppView; label: string; glyph: string }> = [
  { view: 'chats', label: 'Chats', glyph: '💬' },
  { view: 'explore', label: 'Explore', glyph: '🧭' },
  { view: 'settings', label: 'You', glyph: '👤' },
];

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

  const unreadTotal = conversations.reduce((n, c) => n + (c.self?.unreadCount ?? 0), 0);

  return (
    <div className="shell">
      <nav className="rail">
        <div className="rail-brand brand">y</div>
        {NAV.map((item) => (
          <button
            key={item.view}
            className={`rail-item${state.view === item.view ? ' active' : ''}`}
            title={item.label}
            onClick={() => mutate((s) => (s.view = item.view))}
          >
            <span aria-hidden>{item.glyph}</span>
            {item.view === 'chats' && unreadTotal > 0 && (
              <span className="rail-badge">{unreadTotal > 99 ? '99+' : unreadTotal}</span>
            )}
          </button>
        ))}
      </nav>

      {state.view === 'chats' && (
        <>
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
        </>
      )}

      {state.view === 'explore' && (
        <div className="fullpane">
          <ExploreScreen />
        </div>
      )}

      {state.view === 'settings' && (
        <div className="fullpane">
          <SettingsScreen />
        </div>
      )}
    </div>
  );
}
