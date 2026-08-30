/**
 * Inline charts for embeds — the whole family, drawn by hand as SVG.
 *
 * A port of the Android `ChartView.kt`: one series, no pan/zoom/tooltips,
 * axis chrome kept to a whisper (min/max, first/last label) because in a chat
 * bubble the *shape* is the message. Critical detail carried over: a bar
 * chart's floor is `min(min(values), 0)` — bars measure "how much" from zero,
 * and scaling from the series minimum would collapse the smallest bar to a
 * sliver. Lines and areas stretch over the data's own range instead.
 */

import { useId } from 'react';
import type { ChartEmbed } from '../../lib/types';

const SERIES = [
  '#8b7cff', // violet
  '#00cec9', // teal
  '#ff9f43', // orange
  '#ff6b81', // pink
  '#fcce09', // yellow
  '#6bcb77', // green
  '#4fc3f7', // sky
  '#b39ddb', // lavender
];

const W = 420;
const H = 200;
const TOP = 20;
const BOTTOM = 24;
const INNER_H = H - TOP - BOTTOM;

/** 118000 -> 118k; keeps axis labels the size of a word. */
function compactNumber(v: number): string {
  const a = Math.abs(v);
  const trim = (x: number) => (x % 1 === 0 ? String(Math.trunc(x)) : x.toFixed(1));
  if (a >= 1_000_000) return `${trim(v / 1_000_000)}m`;
  if (a >= 1_000) return `${trim(v / 1_000)}k`;
  return v % 1 === 0 ? String(Math.trunc(v)) : v.toFixed(1);
}

export function ChartSvg(props: { chart: ChartEmbed }) {
  const { chart } = props;
  if (chart.kind === 'pie' || chart.kind === 'donut') {
    return <PieChart chart={chart} donut={chart.kind === 'donut'} />;
  }
  return <CartesianChart chart={chart} />;
}

function CartesianChart(props: { chart: ChartEmbed }) {
  const { chart } = props;
  const gradientId = useId();
  const points = chart.points.filter((p) => Number.isFinite(p.value));
  if (points.length < 2) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Bars measure from zero; lines show shape over the data's own range.
  const floor = chart.kind === 'bar' ? Math.min(min, 0) : min;
  const span = max - floor || 1;
  // 0.92/0.04: breathing room top and bottom so a flat series still draws
  // mid-height instead of on the floor.
  const yFor = (v: number) => TOP + INNER_H * (1 - ((v - floor) / span) * 0.92 - 0.04);

  const gridColor = 'rgba(121, 115, 143, 0.25)'; // --text-3 at 25%
  const labelStyle = { fill: 'var(--text-3)', fontSize: 10 } as const;

  const first = points[0]!;
  const last = points[points.length - 1]!;

  let marks: JSX.Element;
  if (chart.kind === 'bar') {
    const slot = W / points.length;
    const bar = slot * 0.62;
    const zero = yFor(Math.min(Math.max(min, 0), max));
    marks = (
      <>
        {points.map((p, i) => {
          const top = yFor(p.value);
          const left = slot * i + (slot - bar) / 2;
          const y0 = Math.min(top, zero);
          const height = Math.max(Math.abs(top - zero), 2);
          return (
            <rect
              key={i}
              x={left}
              y={y0}
              width={bar}
              height={height}
              rx={Math.min(bar * 0.25, 6)}
              fill={SERIES[i % SERIES.length]}
            />
          );
        })}
      </>
    );
  } else if (chart.kind === 'scatter') {
    marks = (
      <>
        {points.map((p, i) => (
          <circle
            key={i}
            cx={(W * i) / (points.length - 1)}
            cy={yFor(p.value)}
            r={4.5}
            fill={SERIES[0]}
            opacity={0.9}
          />
        ))}
      </>
    );
  } else {
    // line and area share the path
    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${((W * i) / (points.length - 1)).toFixed(1)} ${yFor(p.value).toFixed(1)}`)
      .join(' ');
    const lastY = yFor(last.value);
    marks = (
      <>
        {chart.kind === 'area' && (
          <>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <path d={`${path} L${W} ${TOP + INNER_H} L0 ${TOP + INNER_H} Z`} fill={`url(#${gradientId})`} />
          </>
        )}
        <path d={path} fill="none" stroke={SERIES[0]} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {/* The "you are here" dot on the last point. */}
        <circle cx={W} cy={lastY} r={4.5} fill={SERIES[0]} />
        <circle cx={W} cy={lastY} r={2} fill="var(--card)" />
      </>
    );
  }

  return (
    <div className="msg-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${chart.kind} chart`}>
        <text x={0} y={12} {...labelStyle}>
          {compactNumber(max)}
        </text>
        {/* Whisper gridlines: top and bottom of the data range. */}
        {[0.04, 0.96].map((frac) => (
          <line
            key={frac}
            x1={0}
            x2={W}
            y1={TOP + INNER_H * frac}
            y2={TOP + INNER_H * frac}
            stroke={gridColor}
            strokeWidth={1}
            strokeDasharray="4 6"
          />
        ))}
        {marks}
        <text x={0} y={H - 6} {...labelStyle}>
          {first.label.trim() || compactNumber(min)}
        </text>
        <text x={W} y={H - 6} textAnchor="end" {...labelStyle}>
          {last.label.trim() || compactNumber(last.value)}
        </text>
      </svg>
    </div>
  );
}

function PieChart(props: { chart: ChartEmbed; donut: boolean }) {
  const { chart, donut } = props;
  // Max 8 slices, positives only — same rule as the phones.
  const points = chart.points.filter((p) => Number.isFinite(p.value) && p.value > 0).slice(0, 8);
  if (points.length < 2) return null;
  const total = points.reduce((sum, p) => sum + p.value, 0);
  if (total <= 0) return null;

  const size = 110;
  const c = size / 2;
  const stroke = size * 0.16;
  const radius = donut ? c - stroke / 2 - 2 : c - 2;

  const polar = (deg: number): [number, number] => {
    const rad = (deg * Math.PI) / 180;
    return [c + radius * Math.cos(rad), c + radius * Math.sin(rad)];
  };

  let start = -90;
  const slices = points.map((p, i) => {
    const sweep = (p.value / total) * 360;
    // A hair of separation, so slices read as slices.
    const drawn = Math.max(sweep - 2, 1);
    const [x0, y0] = polar(start);
    const [x1, y1] = polar(start + drawn);
    const large = drawn > 180 ? 1 : 0;
    start += sweep;
    const color = SERIES[i % SERIES.length]!;
    return donut ? (
      <path
        key={i}
        d={`M${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
      />
    ) : (
      <path
        key={i}
        d={`M${c} ${c} L${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`}
        fill={color}
      />
    );
  });

  return (
    <div className="chart-pie-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${chart.kind} chart`}>
        {slices}
      </svg>
      <div className="chart-legend">
        {points.map((p, i) => (
          <div className="chart-legend-row" key={i}>
            <span className="chart-legend-dot" style={{ background: SERIES[i % SERIES.length] }} />
            <span className="chart-legend-label">{p.label.trim() || `#${i + 1}`}</span>
            <span className="chart-legend-pct">{Math.trunc((p.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
