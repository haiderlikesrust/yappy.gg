/**
 * Circles are people, squircles are places — the one rule of yappy iconography.
 */
export function Avatar(props: {
  kind: 'person' | 'place';
  name: string | null | undefined;
  url?: string | null;
  size?: number;
}) {
  const size = props.size ?? 36;
  const initial = (props.name?.trim()?.[0] ?? '?').toUpperCase();
  return (
    <div
      className={`avatar ${props.kind}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {props.url ? <img src={props.url} alt="" /> : initial}
    </div>
  );
}
