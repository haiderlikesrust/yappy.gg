import { useEffect, useMemo, useState } from 'react';
import { auth } from './lib/api';
import {
  applyUrl,
  bootstrap,
  mutate,
  pruneTyping,
  selectConversation,
  signedOutReset,
  syncUrl,
  useStore,
  type AppView,
} from './state/store';
import { AuthScreen } from './ui/AuthScreen';
import { ChatView } from './ui/ChatView';
import { MobileGate, narrowDismissed, useIsNarrow } from './ui/MobileGate';
import { OnboardingScreen } from './ui/onboarding/OnboardingScreen';
import { Sidebar } from './ui/Sidebar';
import { ExploreScreen } from './ui/explore/ExploreScreen';
import { SettingsScreen } from './ui/settings/SettingsScreen';
import { QuickSwitcher } from './ui/search';
import { TOUR_EVENT, Tour, tourPending } from './ui/tour/Tour';
import { Icon, type IconName } from './ui/icons';

const NAV: Array<{ view: AppView; label: string; icon: IconName }> = [
  { view: 'chats', label: 'Chats', icon: 'chat' },
  { view: 'explore', label: 'Explore', icon: 'compass' },
  { view: 'settings', label: 'You', icon: 'user' },
];

export function App() {
  const { state, version } = useStore();
  const [quickOpen, setQuickOpen] = useState(false);
  const isNarrow = useIsNarrow();
  const [narrowOk, setNarrowOk] = useState(narrowDismissed);
  const [tourOpen, setTourOpen] = useState(false);

  // First signed-in visit gets the tour once the shell is actually on
  // screen; Settings can replay it via the event.
  useEffect(() => {
    if (auth.isSignedIn && tourPending()) {
      const timer = window.setTimeout(() => setTourOpen(true), 900);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, []);
  useEffect(() => {
    const onTour = () => {
      mutate((s) => (s.view = 'chats'));
      syncUrl();
      setTourOpen(true);
    };
    window.addEventListener(TOUR_EVENT, onTour);
    return () => window.removeEventListener(TOUR_EVENT, onTour);
  }, []);

  useEffect(() => {
    auth.handleSignedOut(() => signedOutReset());
    if (auth.isSignedIn) void bootstrap();
    const timer = setInterval(pruneTyping, 2_000);
    const onPop = () => void applyUrl();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen((v) => !v);
      }
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
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

  // A phone-sized viewport gets the apps, not a crushed three-column desktop.
  if (isNarrow && !narrowOk) {
    return <MobileGate onContinue={() => setNarrowOk(true)} />;
  }

  if (!state.me && !auth.isSignedIn) {
    return <AuthScreen onSignedIn={() => void bootstrap()} />;
  }

  // Signed in but not yet a person: an account minted through a social or
  // device-grant flow has no username until it claims one.
  if (state.me && !state.me.username) {
    return <OnboardingScreen onDone={() => void bootstrap()} />;
  }

  const selected = state.selectedId ? state.conversations.get(state.selectedId) : null;
  const messages = state.selectedId ? (state.messages.get(state.selectedId) ?? []) : [];
  const typing = state.selectedId
    ? [...(state.typing.get(state.selectedId)?.keys() ?? [])]
    : [];

  const unreadTotal = conversations.reduce(
    (n, c) => n + (c.self?.isArchived ? 0 : (c.self?.unreadCount ?? 0)),
    0,
  );

  return (
    <div className="shell">
      <nav className="rail">
        <div className="rail-brand brand">y</div>
        {NAV.map((item) => (
          <button
            key={item.view}
            className={`rail-item${state.view === item.view ? ' active' : ''}`}
            title={item.label}
            onClick={() => {
              mutate((s) => (s.view = item.view));
              syncUrl();
            }}
          >
            <Icon name={item.icon} size={22} />
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

      <QuickSwitcher open={quickOpen} onClose={() => setQuickOpen(false)} />
      {tourOpen && <Tour onClose={() => setTourOpen(false)} />}
    </div>
  );
}
