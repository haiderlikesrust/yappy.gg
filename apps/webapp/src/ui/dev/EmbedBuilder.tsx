import { useMemo, useState } from 'react';
import { Icon } from '../icons';

/**
 * The embed builder: compose a rich card and its button rows visually, watch
 * it render through the SAME classes the chat draws embeds with, and copy the
 * exact JSON a bot sends. No approximation — if it looks right here, it looks
 * right in the room.
 */

interface FieldDraft {
  name: string;
  value: string;
  inline: boolean;
}

interface ButtonDraft {
  label: string;
  customId: string;
  style: 'primary' | 'secondary' | 'danger' | 'success';
  url: string;
}

const PALETTE = ['#8b7cff', '#3dd68c', '#ffb224', '#ff6369', '#4fc3f7', '#f5a524'];

export function EmbedBuilder(props: { onClose: () => void }) {
  const [title, setTitle] = useState('Build succeeded');
  const [description, setDescription] = useState('All 214 tests passed in 41s.');
  const [color, setColor] = useState('#8b7cff');
  const [footer, setFooter] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>([]);
  const [buttons, setButtons] = useState<ButtonDraft[]>([]);
  const [copied, setCopied] = useState(false);

  const json = useMemo(() => {
    const embed: Record<string, unknown> = {
      title: title.trim() || undefined,
      description: description.trim() || undefined,
      color,
      fields: fields
        .filter((f) => f.name.trim() && f.value.trim())
        .map((f) => ({ name: f.name.trim(), value: f.value.trim(), inline: f.inline })),
      ...(footer.trim() ? { footer: { text: footer.trim() } } : {}),
    };
    const rows = buttons.filter((b) => b.label.trim() && (b.customId.trim() || b.url.trim()));
    const body: Record<string, unknown> = {
      content: null,
      embeds: [embed],
      ...(rows.length > 0
        ? {
            components: [
              {
                type: 'row',
                components: rows.map((b) => ({
                  type: 'button',
                  label: b.label.trim(),
                  style: b.style,
                  disabled: false,
                  ...(b.url.trim() ? { url: b.url.trim() } : { customId: b.customId.trim() }),
                })),
              },
            ],
          }
        : {}),
    };
    return JSON.stringify(body, null, 2);
  }, [title, description, color, footer, fields, buttons]);

  const setField = (i: number, patch: Partial<FieldDraft>) =>
    setFields((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setButton = (i: number, patch: Partial<ButtonDraft>) =>
    setButtons((prev) => prev.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <div className="dev-embed-overlay" onClick={props.onClose}>
      <div className="dev-embed" onClick={(e) => e.stopPropagation()}>
        <div className="dev-embed-head">
          <span className="brand">Embed builder</span>
          <button className="dev-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="dev-embed-panes">
          {/* ── Form ── */}
          <div className="dev-form dev-embed-form">
            <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            <textarea
              placeholder="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={2000}
            />
            <div className="dev-embed-colors">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`dev-embed-swatch${color === c ? ' selected' : ''}`}
                  style={{ background: c }}
                  aria-label={c}
                  onClick={() => setColor(c)}
                />
              ))}
              <input
                className="dev-embed-hex"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                maxLength={7}
              />
            </div>
            <input placeholder="Footer (optional)" value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={200} />

            <div className="dev-hint">Fields</div>
            {fields.map((f, i) => (
              <div className="dev-embed-field" key={i}>
                <input placeholder="Name" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
                <input placeholder="Value" value={f.value} onChange={(e) => setField(i, { value: e.target.value })} />
                <label className="dev-check">
                  <input type="checkbox" checked={f.inline} onChange={(e) => setField(i, { inline: e.target.checked })} />
                  inline
                </label>
                <button className="dev-btn danger" onClick={() => setFields((p) => p.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            {fields.length < 12 && (
              <button className="dev-btn" onClick={() => setFields((p) => [...p, { name: '', value: '', inline: false }])}>
                <Icon name="plus" size={13} /> Add field
              </button>
            )}

            <div className="dev-hint">Buttons</div>
            {buttons.map((b, i) => (
              <div className="dev-embed-btnrow" key={i}>
                <input placeholder="Label" value={b.label} onChange={(e) => setButton(i, { label: e.target.value })} />
                <input placeholder="customId" value={b.customId} onChange={(e) => setButton(i, { customId: e.target.value })} />
                <input placeholder="or URL" value={b.url} onChange={(e) => setButton(i, { url: e.target.value })} />
                <select value={b.style} onChange={(e) => setButton(i, { style: e.target.value as ButtonDraft['style'] })}>
                  <option value="primary">primary</option>
                  <option value="secondary">secondary</option>
                  <option value="success">success</option>
                  <option value="danger">danger</option>
                </select>
                <button className="dev-btn danger" onClick={() => setButtons((p) => p.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            {buttons.length < 5 && (
              <button
                className="dev-btn"
                onClick={() => setButtons((p) => [...p, { label: '', customId: '', style: 'primary', url: '' }])}
              >
                <Icon name="plus" size={13} /> Add button
              </button>
            )}
          </div>

          {/* ── Live preview, drawn with the chat's own classes ── */}
          <div className="dev-embed-preview">
            <div className="dev-hint">Exactly how it renders in a room:</div>
            <div className="msg-embed" style={{ borderLeftColor: color }}>
              {title.trim() && <div className="msg-embed-title">{title}</div>}
              {description.trim() && <div className="msg-embed-desc">{description}</div>}
              {fields
                .filter((f) => f.name.trim() && f.value.trim())
                .map((f, i) => (
                  <div key={i} style={{ marginTop: 6 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{f.name}</div>
                    <div style={{ color: 'var(--text-2)', fontSize: 13 }}>{f.value}</div>
                  </div>
                ))}
              {footer.trim() && (
                <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 6 }}>{footer}</div>
              )}
            </div>
            {buttons.some((b) => b.label.trim()) && (
              <div className="msg-btn-rows">
                <div className="msg-btn-row">
                  {buttons
                    .filter((b) => b.label.trim())
                    .map((b, i) => (
                      <span key={i} className={`msg-btn${b.style === 'secondary' ? ' secondary' : ''}`}>
                        {b.label}
                      </span>
                    ))}
                </div>
              </div>
            )}

            <div className="dev-hint" style={{ marginTop: 12 }}>
              The send body (bot SDK / POST messages):
            </div>
            <pre className="dev-embed-json">{json}</pre>
            <button
              className="dev-btn accent"
              onClick={() => {
                void navigator.clipboard?.writeText(json);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              <Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy JSON'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
