/**
 * Slash-command autocomplete above the composer.
 *
 * Commands are fetched once per conversation (cached by the parent's ref) and
 * filtered client-side by the typed prefix — the server serves each bot's
 * declared list precisely so this stays instant on the first keystroke.
 */

import type { SlashCommand } from './actions';

export function CommandPicker(props: {
  commands: SlashCommand[];
  prefix: string;
  onPick: (command: SlashCommand) => void;
}) {
  const prefix = props.prefix.toLowerCase();
  const matched = props.commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
  if (matched.length === 0) return null;

  return (
    <div className="command-pop">
      {matched.slice(0, 12).map((cmd) => (
        <button
          key={`${cmd.botId}:${cmd.name}`}
          className="cmd-row"
          onClick={() => props.onPick(cmd)}
        >
          <span className="cmd-name">/{cmd.name}</span>
          <span className="cmd-desc">{cmd.description || cmd.usage}</span>
          <span className="cmd-bot">
            {cmd.botAvatarUrl && <img src={cmd.botAvatarUrl} alt="" />}
            {cmd.botUsername ?? 'bot'}
          </span>
        </button>
      ))}
    </div>
  );
}
