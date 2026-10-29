/** Arrays: bars (numeric) or cells, with index pointers and change highlights. */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, numeric } from '../format';
import { POINTER_COLORS, Var, allNumeric, pointersFor, sameEncoded, shortScalar } from './common';

export interface ArrayViewOpts {
  name: string;
  items: Encoded[];
  total: number;
  prevItems?: Encoded[];
  vars: Var[];
  mode: 'bars' | 'cells';
  /** Needed to label cells that hold small tuples, e.g. (dist, node). */
  heap?: Heap;
}

const CELL_W = 38;
const MAX_W = 900;

export function renderArray(o: ArrayViewOpts): SVGSVGElement {
  const n = o.items.length;
  const cellW = Math.max(14, Math.min(CELL_W, Math.floor(MAX_W / Math.max(1, n + 1))));
  const numericItems = allNumeric(o.items);
  const bars = o.mode === 'bars' && numericItems;
  const pointers = pointersFor(o.vars, o.total);
  const barH = bars ? 120 : 0;
  const top = 8;
  const cellTop = top + barH;
  const cellH = 28;
  const ptrRows = assignRows(pointers.map((p) => p.index));
  const ptrRowsCount = ptrRows.length ? Math.max(...ptrRows) + 1 : 0;
  const width = Math.max(120, n * cellW + 40);
  const height = cellTop + cellH + 18 + ptrRowsCount * 16 + 10;
  const svg = svgRoot(width, height, `array ${o.name} of length ${o.total}`);
  const x0 = 20;

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
  const pointed = new Set(pointers.map((p) => p.index));

  for (let i = 0; i < n; i++) {
    const it = o.items[i];
    const changed = o.prevItems !== undefined && (i >= o.prevItems.length || !sameEncoded(o.prevItems[i], it));
    const x = x0 + i * cellW;
    const cls = ['cell', changed ? 'changed' : '', pointed.has(i) ? 'pointed' : ''].join(' ');
    if (bars) {
      const v = numeric(it)!;
      const hgt = Math.max(1, Math.abs(v) * scale);
      const y = v >= 0 ? baseline - hgt : baseline;
      svg.appendChild(s('rect', { x: x + 2, y, width: cellW - 4, height: hgt, rx: 2, class: `bar ${cls}` }, s('title', {}, `${o.name}[${i}] = ${shortScalar(it)}`)));
    }
    svg.appendChild(s('rect', { x, y: cellTop, width: cellW, height: cellH, class: `cellbox ${cls}` }));
    const label = shortScalar(it, o.heap);
    svg.appendChild(
      s('text', { x: x + cellW / 2, y: cellTop + cellH / 2 + 4, 'text-anchor': 'middle', class: `cell-text ${label.length * 6.5 > cellW ? 'small' : ''}` }, label),
    );
    if (n <= 60 || i % Math.ceil(n / 30) === 0) {
      svg.appendChild(s('text', { x: x + cellW / 2, y: cellTop + cellH + 12, 'text-anchor': 'middle', class: 'index-text' }, String(i)));
    }
  }
  if (bars) svg.appendChild(s('line', { x1: x0, x2: x0 + n * cellW, y1: baseline, y2: baseline, class: 'axis' }));
  if (o.total > n) {
    svg.appendChild(s('text', { x: x0 + n * cellW + 4, y: cellTop + cellH / 2 + 4, class: 'muted-text' }, `… +${o.total - n}`));
  }
  pointers.forEach((p, k) => {
    const x = x0 + p.index * cellW + cellW / 2;
    const y = cellTop + cellH + 26 + ptrRows[k] * 16;
    const color = POINTER_COLORS[k % POINTER_COLORS.length];
    svg.appendChild(s('line', { x1: x, x2: x, y1: cellTop + cellH + 15, y2: y - 10, class: `ptr-line ${color}` }));
    svg.appendChild(s('text', { x, y, 'text-anchor': 'middle', class: `ptr-text ${color}` }, `${p.name}=${p.index}`));
  });
  return svg;
}

/** Stack labels of pointers at the same/nearby index onto separate rows. */
function assignRows(indices: number[]): number[] {
  const rows: number[] = [];
  const used: Array<Set<number>> = [];
  indices.forEach((idx) => {
    let r = 0;
    while (used[r] && [...used[r]].some((u) => Math.abs(u - idx) < 2)) r++;
    (used[r] ??= new Set()).add(idx);
    rows.push(r);
  });
  return rows;
}
