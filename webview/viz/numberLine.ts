/** Number line ("trục số") of numeric scalar variables and/or a set of values. */
import { s, svgRoot } from '../dom';
import { fmtNumber } from '../format';
import { POINTER_COLORS, niceTicks } from './common';

export interface Mark {
  label: string;
  value: number;
}

export function renderNumberLine(marks: Mark[], points: number[] = [], title = 'number line'): SVGSVGElement {
  const all = [...marks.map((m) => m.value), ...points].filter(Number.isFinite);
  const width = 640;
  let lo = Math.min(...all, 0);
  let hi = Math.max(...all, 0);
  if (lo === hi) {
    lo -= 5;
    hi += 5;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const ticks = niceTicks(lo, hi, 10);
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const x0 = 24;
  const x1 = width - 24;
  const X = (v: number) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);

  // Place labels on alternating rows when they would overlap.
  const sorted = marks
    .map((m, k) => ({ ...m, k }))
    .filter((m) => Number.isFinite(m.value))
    .sort((a, b) => a.value - b.value);
  const rowEnds: number[] = [];
  const placed = sorted.map((m) => {
    const text = `${m.label}=${fmtNumber(m.value)}`;
    const w = text.length * 6.5 + 6;
    const cx = X(m.value);
    // Labels of values near either end stay inside the drawing.
    const lx = Math.min(Math.max(cx, w / 2 + 2), width - w / 2 - 2);
    let row = 0;
    while (rowEnds[row] !== undefined && rowEnds[row] > lx - w / 2) row++;
    rowEnds[row] = lx + w / 2;
    return { ...m, text, cx, lx, row };
  });
  const rows = Math.max(1, rowEnds.length);
  const axisY = 20 + rows * 16 + 8;
  const height = axisY + 34;
  const svg = svgRoot(width, height, title);
  svg.appendChild(s('line', { x1: x0 - 8, x2: x1 + 8, y1: axisY, y2: axisY, class: 'axis', 'marker-end': '' }));
  svg.appendChild(s('path', { d: `M${x1 + 8},${axisY} l-7,-4 v8 z`, class: 'axis-arrow' }));
  for (const t of ticks) {
    const x = X(t);
    if (x < x0 - 1 || x > x1 + 1) continue;
    svg.appendChild(s('line', { x1: x, x2: x, y1: axisY - 4, y2: axisY + 4, class: t === 0 ? 'axis zero' : 'axis' }));
    svg.appendChild(s('text', { x, y: axisY + 18, 'text-anchor': 'middle', class: 'tick-text' }, fmtNumber(t)));
  }
  for (const p of points) {
    if (!Number.isFinite(p)) continue;
    svg.appendChild(s('circle', { cx: X(p), cy: axisY, r: 4, class: 'nl-point' }, s('title', {}, fmtNumber(p))));
  }
  for (const m of placed) {
    const color = POINTER_COLORS[m.k % POINTER_COLORS.length];
    const ly = 16 + m.row * 16;
    svg.appendChild(
      s('g', { 'data-anim': `p:${m.label}` },
        s('line', { x1: m.cx, x2: m.cx, y1: ly + 3, y2: axisY - 5, class: `ptr-line ${color}` }),
        s('circle', { cx: m.cx, cy: axisY, r: 5, class: `nl-mark ${color}` }),
        s('text', { x: m.lx, y: ly, 'text-anchor': 'middle', class: `ptr-text ${color}` }, m.text)),
    );
  }
  return svg;
}
