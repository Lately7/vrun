/**
 * Arrays and strings: bars (numeric) or cells, with index pointers, the
 * range between bound pointers shaded, and change highlights.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, numeric } from '../format';
import { KeyMemo, POINTER_COLORS, allNumeric, itemKeys, sameEncoded, shortScalar } from './common';
import { Pointer, Range } from './pointers';

export interface ArrayViewOpts {
  name: string;
  items: Encoded[];
  total: number;
  prevItems?: Encoded[];
  pointers: Pointer[];
  ranges?: Range[];
  mode: 'bars' | 'cells';
  /** Needed to label cells that hold small tuples, e.g. (dist, node). */
  heap?: Heap;
  /** Characters of a string rather than list items. */
  chars?: boolean;
}

const CELL_W = 38;
const MAX_W = 900;
const PTR_PX = 6.8; // ~width of a pointer label character at 11px
const X0 = 20;

/** Last keys per array, so values keep their animation keys between steps. */
const memo = new Map<string, KeyMemo>();

export function keysFor(id: string, items: Encoded[]): string[] {
  const m = itemKeys(items, memo.get(id));
  memo.set(id, m);
  return m.keys;
}

export function renderArray(o: ArrayViewOpts): SVGSVGElement {
  const n = o.items.length;
  const cellW = Math.max(14, Math.min(CELL_W, Math.floor(MAX_W / Math.max(1, n + 1))));
  const bars = o.mode === 'bars' && allNumeric(o.items);
  const barH = bars ? 120 : 0;
  const top = 8;
  const cellTop = top + barH;
  const cellH = 28;
  const ptrTop = cellTop + cellH + 15;

  // Pointer labels: centred on their cell, pushed right of the left edge,
  // stacked on rows so neighbours do not overlap; the width grows to fit.
  const labels = o.pointers.map((p) => {
    const text = `${p.name}=${p.index}`;
    const w = text.length * PTR_PX + 4;
    const cx = X0 + p.index * cellW + cellW / 2;
    return { p, text, w, cx, lx: Math.max(cx, w / 2 + 2), row: 0 };
  });
  const rowEnds: number[] = [];
  for (const l of [...labels].sort((a, b) => a.lx - b.lx)) {
    let r = 0;
    while (rowEnds[r] !== undefined && rowEnds[r] > l.lx - l.w / 2) r++;
    rowEnds[r] = l.lx + l.w / 2 + 3;
    l.row = r;
  }
  const more = o.total > n ? `… +${o.total - n}` : '';
  const right = Math.max(X0 + n * cellW + 20 + more.length * 6.5, ...labels.map((l) => l.lx + l.w / 2 + 4));
  const width = Math.max(120, Math.ceil(right));
  const height = cellTop + cellH + 18 + rowEnds.length * 16 + 10;
  const svg = svgRoot(width, height, `${o.chars ? 'string' : 'array'} ${o.name} of length ${o.total}`);

  let maxAbs = 1;
  let hasNeg = false;
  if (bars) {
    for (const it of o.items) {
      const v = numeric(it)!;
      maxAbs = Math.max(maxAbs, Math.abs(v));
      if (v < 0) hasNeg = true;
    }
  }
  const baseline = bars ? (hasNeg ? top + barH / 2 : top + barH - 4) : 0;
  const scale = bars ? (hasNeg ? barH / 2 - 6 : barH - 10) / maxAbs : 0;
  const pointed = new Set(o.pointers.map((p) => p.index));
  const keys = keysFor(`${o.name}\u0000${o.chars ? 's' : 'a'}`, o.items);

  for (let i = 0; i < n; i++) {
    const it = o.items[i];
    const changed = o.prevItems !== undefined && (i >= o.prevItems.length || !sameEncoded(o.prevItems[i], it));
    const x = X0 + i * cellW;
    const cls = ['cell', changed ? 'changed' : '', pointed.has(i) ? 'pointed' : ''].join(' ');
    const g = s('g', { 'data-anim': keys[i] });
    if (bars) {
      const v = numeric(it)!;
      const hgt = Math.max(1, Math.abs(v) * scale);
      const y = v >= 0 ? baseline - hgt : baseline;
      g.appendChild(s('rect', { x: x + 2, y, width: cellW - 4, height: hgt, rx: 2, class: `bar ${cls}` }, s('title', {}, `${o.name}[${i}] = ${shortScalar(it)}`)));
    }
    g.appendChild(s('rect', { x, y: cellTop, width: cellW, height: cellH, class: `cellbox ${cls}` }));
    const label = o.chars && it === ' ' ? '␣' : shortScalar(it, o.heap);
    g.appendChild(s('text', { x: x + cellW / 2, y: cellTop + cellH / 2 + 4, 'text-anchor': 'middle', class: `cell-text ${label.length * 6.5 > cellW ? 'small' : ''}` }, label));
    if (n <= 60 || i % Math.ceil(n / 30) === 0) {
      g.appendChild(s('text', { x: x + cellW / 2, y: cellTop + cellH + 12, 'text-anchor': 'middle', class: 'index-text' }, String(i)));
    }
    svg.appendChild(g);
  }
  if (!n) svg.appendChild(s('text', { x: X0, y: cellTop + cellH / 2 + 4, class: 'muted-text' }, 'empty'));
  if (bars) svg.appendChild(s('line', { x1: X0, x2: X0 + n * cellW, y1: baseline, y2: baseline, class: 'axis' }));
  if (more) svg.appendChild(s('text', { x: X0 + n * cellW + 4, y: cellTop + cellH / 2 + 4, class: 'muted-text' }, more));
  (o.ranges ?? []).forEach((r, k) => {
    // Drawn over the cells, faintly: cell boxes are opaque.
    const y = (bars ? top : cellTop) - 3;
    svg.appendChild(
      s('rect', {
        x: X0 + r.from * cellW + 1,
        y,
        width: (r.to - r.from + 1) * cellW - 2,
        height: cellTop + cellH + 3 - y,
        rx: 3,
        class: 'range-shade',
        'data-anim': k === 0 ? 'range' : `range:${r.names.join('-')}`,
        'data-anim-size': true,
      }, s('title', {}, `${r.names[0]}..${r.names[1]}`)),
    );
  });
  labels.forEach((l, k) => {
    const y = ptrTop + 11 + l.row * 16;
    const color = POINTER_COLORS[k % POINTER_COLORS.length];
    svg.appendChild(
      s('g', { 'data-anim': `p:${l.p.name}` },
        s('line', { x1: l.cx, x2: l.cx, y1: ptrTop, y2: y - 10, class: `ptr-line ${color}` }),
        s('text', { x: l.lx, y, 'text-anchor': 'middle', class: `ptr-text ${color}` }, l.text)),
    );
  });
  return svg;
}
