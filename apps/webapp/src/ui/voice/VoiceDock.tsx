import { Icon } from '../icons';
import { leaveVoice, toggleVoiceMute, voiceSession } from './voice';
import './voice.css';

/**
 * The connected-to-voice bar at the foot of the sidebar — Discord's little
 * green truth. Renders nothing while not in a channel; the store pokes a
 * re-render on every session change.
 */
export function VoiceDock() {
  const s = voiceSession();
  if (!s) return null;
  return (
    <div className={`voice-dock${s.connecting ? ' connecting' : ''}`}>
      <span className="voice-dock-glyph">
        <Icon name="volume" size={15} />
      </span>
      <div className="voice-dock-main">
        <div className="voice-dock-state">{s.connecting ? 'Connecting…' : 'Voice connected'}</div>
        <div className="voice-dock-channel">{s.title}</div>
      </div>
      <button
        className={`voice-dock-btn${s.muted ? ' muted' : ''}`}
        title={s.muted ? 'Unmute' : 'Mute'}
        aria-label={s.muted ? 'Unmute microphone' : 'Mute microphone'}
        onClick={() => void toggleVoiceMute()}
      >
        <Icon name={s.muted ? 'mic-off' : 'mic'} size={15} />
      </button>
      <button
        className="voice-dock-btn leave"
        title="Disconnect"
        aria-label="Disconnect from voice"
        onClick={() => void leaveVoice()}
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
