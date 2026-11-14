/**
 * Arrays and strings: bars (numeric) or cells, with index pointers, the
 * range between bound pointers shaded, and change highlights. Past 64
 * items cells are drawn in pages around the pointers and bars are squeezed,
 * so a long row is never shrunk to unreadable text.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, numeric, pyStr } from '../format';
import { KeyMemo, POINTER_COLORS, allNumeric, ambiguousStr, cellText, itemKeys, pyText, sameEncoded, shortScalar, strValue } from './common';
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
const MAX_CELL_W = 120;
const MAX_W = 900;
const PTR_PX = 6.8; // ~width of a pointer label character at 11px
const TEXT_PX = 6.6; // ~width of a cell-text character at 11px
const SMALL_PX = 5; // ~width of a cell-text.small character at 9px
const X0 = 20;

/** Cell labels; when any str would read as another type ('10', '', 'None'), every str of the array is quoted. */
export function cellLabels(items: Encoded[], heap?: Heap, chars = false): string[] {
  const quote = !chars && items.some((x) => {
    const t = strValue(x);
    return t !== undefined && ambiguousStr(t);
  });
  return items.map((it) => {
    if (chars && it === ' ') return '␣';
    // The '\n' readline() keeps would be an empty-looking cell.
    if (chars && typeof it === 'string' && /^[\n\r\t]$/.test(it)) return pyStr(it).slice(1, -1);
    const t = quote ? strValue(it) : undefined;
    if (t !== undefined) return pyStr(t.length > 8 ? t.slice(0, 7) + '…' : t);
    return chars ? shortScalar(it, heap) : cellText(it, heap);
  });
}

/**
 * Where a pointer sits: on a drawn cell, past the end of a whole array (a
 * dashed ghost cell: that index does not exist), or beyond the part of a
 * cut array the kernel sent (next to "… N more not shown").
 */
export function pointerText(p: Pointer, shown: number, total: number): string {
  if (p.index < shown) return `${p.name}=${p.index}`;
  // An IndexError first: "beyond the 512 shown" would read as "it exists, just not sent".
  if (p.outOfRange) return total > shown ? `${p.name}=${p.index} (out of range: len ${total})` : `${p.name}=${p.index} (out of range)`;
  if (total > shown) return `${p.name}=${p.index} (beyond the ${shown} shown)`;
  return `${p.name}=${p.index}`;
}

/** Last keys per array, so values keep their animation keys between steps. */
const memo = new Map<string, KeyMemo>();

export function keysFor(id: string, items: Encoded[]): string[] {
  const m = itemKeys(items, memo.get(id));
  memo.set(id, m);
  return m.keys;
}

/** Most cells a row draws in full; a longer array is drawn around its pointers (cells) or squeezed (bars). */
export const MAX_CELLS = 64;
/** Cells of the window a long array's row draws. */
const WINDOW = 40;

/**
 * Index spans [from, to) of a long array to draw as cells: pages around the
 * pointers (and then the cells that changed), with at least a quarter of a
 * window of context on each side of a pointer. Pages, not a window centred
 * on j: the row stays put while j walks through it and moves by half a
 * window when j leaves, instead of sliding every cell on every step. A
 * whole row of 512 cells shrunk to the card would be 1 px text.
 */
export function visibleSpans(n: number, pointers: number[], changed: number[] = [], max = WINDOW): Array<[number, number]> {
  if (n <= max) return [[0, n]];
  const inRange = (xs: number[]) => [...new Set(xs.filter((i) => i >= 0 && i < n))];
  const firm = inRange(pointers);
  const all = inRange([...firm, ...changed]);
  if (!all.length) return [[0, max]];
  for (let P = Math.floor(max / 2); P >= 1; P = Math.floor(P / 2)) {
    for (const pts of firm.length && firm.length < all.length ? [all, firm] : [all]) {
      const pages = pagesFor(pts, P, Math.ceil(n / P));
      if (pages.size * P <= max) return spansOf(pages, P, n);
    }
  }
  return firm.length ? spansOf(new Set(firm.slice(0, max)), 1, n) : [[0, max]];
}

/** Pages of size P that give each cluster of points (j, j + 1) its page and the neighbour page on its nearer side. */
function pagesFor(pts: number[], P: number, count: number): Set<number> {
  const out = new Set<number>();
  const sorted = [...pts].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length;) {
    let e = k;
    while (e + 1 < sorted.length && sorted[e + 1] - sorted[k] < P) e++;
    const c = (sorted[k] + sorted[e]) / 2;
    const pg = Math.floor(c / P);
    const near = c - pg * P < P / 2 ? pg - 1 : pg + 1;
    out.add(pg);
    out.add(near >= 0 && near < count ? near : near < 0 ? pg + 1 : pg - 1);
    out.add(Math.floor(sorted[k] / P));
    out.add(Math.floor(sorted[e] / P));
    k = e + 1;
  }
  return new Set([...out].filter((p) => p >= 0 && p < count));
}

function spansOf(pages: Set<number>, P: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const pg of [...pages].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === pg * P) last[1] = Math.min(n, (pg + 1) * P);
    else out.push([pg * P, Math.min(n, (pg + 1) * P)]);
  }
  return out;
}

/** Index labels every `step` cells, the smallest round step whose labels keep `space` px apart. */
function indexStep(cellW: number, maxIndex: number, space: number): number {
  const w = String(maxIndex).length * 6 + space;
  return [1, 2, 5, 10, 20, 50, 100, 200, 500].find((k) => k * cellW >= w) ?? 1000;
}

export function renderArray(o: ArrayViewOpts): SVGSVGElement {
  const n = o.items.length;
  const bars = o.mode === 'bars' && allNumeric(o.items);
  // The kernel sends the first items of a long list: the rest is said,
  // never drawn as if the array ended there.
  const cut = o.total > n;
  const ghostWanted = !cut && n > 0 && o.pointers.some((p) => p.index >= n);
  const changedAt = (i: number) => o.prevItems !== undefined && (i >= o.prevItems.length || !sameEncoded(o.prevItems[i], o.items[i]));
  // A long row is never shrunk below a readable scale: bars are squeezed
  // into the usual width (the shape of the data is what they show), cells
  // are drawn in pages around the pointers.
  const squeezed = bars && n > MAX_CELLS;
  const texts = cellLabels(o.items, o.heap, o.chars);
  let spans: Array<[number, number]> = [[0, n]];
  if (!bars && n > MAX_CELLS) {
    const changed: number[] = [];
    let widestAll = 0;
    for (let i = 0; i < n; i++) {
      if (changedAt(i)) changed.push(i);
      widestAll = Math.max(widestAll, texts[i].length);
    }
    // Fewer, wider cells for wider labels, so they still show in the small font.
    const need = Math.max(20, widestAll * SMALL_PX + 4);
    const cells = Math.max(10, Math.min(WINDOW, Math.floor((MAX_W - 100) / need)));
    // A pointer past the end (the ghost cell) or past the sent part (the
    // "… more not shown" note) is drawn next to the last cells, not after
    // the first page with every sent cell between them skipped.
    const pastEnd = ghostWanted || (cut && o.pointers.some((p) => p.index >= n));
    spans = visibleSpans(n, [...o.pointers.map((p) => p.index), ...(pastEnd ? [n - 1] : [])], changed, cells);
  }
  const drawnTo = spans.length ? spans[spans.length - 1][1] : 0;
  // Gaps between the drawn spans: '… 37 …'.
  const gapText = (from: number, to: number) => `… ${to - from} …`;
  const GAP_PX = 6.2;
  const gaps: Array<{ from: number; to: number; text: string; w: number; x: number }> = [];
  let prevEnd = 0;
  for (const [a, b] of spans) {
    if (a > prevEnd) {
      const text = gapText(prevEnd, a);
      gaps.push({ from: prevEnd, to: a, text, w: Math.ceil(text.length * GAP_PX + 10), x: 0 });
    }
    prevEnd = b;
  }
  const gapsW = gaps.reduce((t, g) => t + g.w, 0);
  const more = drawnTo < n ? `… ${o.total - drawnTo} more${cut ? ` (${o.total - n} not shown)` : ''}` : cut ? `… ${o.total - n} more not shown` : '';
  const moreW = more ? more.length * 6 + 8 : 0;
  const drawn = spans.reduce((t, [a, b]) => t + b - a, 0);
  const base = squeezed
    ? Math.max(1, (MAX_W - X0 - 20 - moreW) / n)
    : Math.max(14, Math.min(CELL_W, Math.floor((MAX_W - gapsW) / Math.max(1, drawn + 1))));
  // Cells grow to fit a tuple or node label ((1,0,5), ((2,3),4)) while the
  // row stays within MAX_W; past that the tooltip carries the text.
  let widest = 0;
  for (const [a, b] of spans) for (let i = a; i < b; i++) widest = Math.max(widest, texts[i].length);
  const cellW = bars ? base : Math.max(base, Math.min(MAX_CELL_W, Math.ceil(widest * TEXT_PX + 10), Math.floor((MAX_W - gapsW) / Math.max(1, drawn + 1))));
  const barH = bars ? 120 : 0;
  const top = 8;
  const cellTop = top + barH;
  // Squeezed cells hold no text: a thin strip that carries the tooltips and the change colour.
  const cellH = squeezed ? 12 : 28;
  const ptrTop = cellTop + cellH + 15;

  // x of every drawn index, gaps between the spans.
  const xs = new Map<number, number>();
  let x = X0;
  let gi = 0;
  for (const [a, b] of spans) {
    if (gi < gaps.length && gaps[gi].to === a) {
      gaps[gi].x = x;
      x += gaps[gi++].w;
    }
    for (let i = a; i < b; i++) {
      xs.set(i, x);
      x += cellW;
    }
  }
  const rowEnd = x;
  const moreX = rowEnd + 4;
  const ghost = ghostWanted && drawnTo === n;
  const ghostHot = ghost && o.pointers.some((p) => p.index >= n && p.outOfRange);
  /** Where index i is drawn: its cell, the gap holding it, or the ghost / end note. */
  const slot = (i: number): { x: number; w: number } => {
    const cx = xs.get(i);
    if (cx !== undefined) return { x: cx, w: cellW };
    const g = gaps.find((q) => i >= q.from && i < q.to);
    if (g) return { x: g.x, w: g.w };
    return i >= n && ghost ? { x: rowEnd, w: cellW } : { x: moreX, w: 12 };
  };

  // Pointer labels: centred on their cell, kept inside the row's width
  // (a long 'j=650 (beyond the 512 shown)' at the right end would widen the
  // drawing, and the card would shrink all of it), stacked on rows so
  // neighbours do not overlap.
  const rowRight = rowEnd + (ghost ? cellW : 0) + 20 + more.length * 6;
  const limit = Math.max(MAX_W, rowRight);
  const labels = o.pointers.map((p) => {
    const text = pointerText(p, n, o.total);
    const w = text.length * PTR_PX + 4;
    const at = slot(p.index);
    const cx = at.x + at.w / 2;
    return { p, text, w, cx, lx: Math.max(w / 2 + 2, Math.min(cx, limit - w / 2 - 4)), row: 0 };
  });
  const rowEnds: number[] = [];
  for (const l of [...labels].sort((a, b) => a.lx - b.lx)) {
    let r = 0;
    while (rowEnds[r] !== undefined && rowEnds[r] > l.lx - l.w / 2) r++;
    rowEnds[r] = l.lx + l.w / 2 + 3;
    l.row = r;
  }
  const right = Math.max(rowRight, ...labels.map((l) => l.lx + l.w / 2 + 4));
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

  const step = indexStep(cellW, Math.max(0, n - 1), squeezed ? 14 : 2);
  let lastIndexX = -Infinity;
  for (const [a, b] of spans) for (let i = a; i < b; i++) {
    const it = o.items[i];
    const changed = changedAt(i);
    const x = xs.get(i)!;
    const cls = ['cell', changed ? 'changed' : '', pointed.has(i) ? 'pointed' : '', squeezed ? 'thin' : ''].join(' ');
    const g = s('g', { 'data-anim': keys[i] });
    if (bars) {
      const v = numeric(it)!;
      const hgt = Math.max(1, Math.abs(v) * scale);
      const y = v >= 0 ? baseline - hgt : baseline;
      // Squeezed bars (200 numbers) keep a hairline gap, not a fixed 2 px one.
      const pad = cellW >= 8 ? 2 : cellW * 0.12;
      g.appendChild(s('rect', { x: x + pad, y, width: cellW - 2 * pad, height: hgt, rx: Math.min(2, cellW / 4), class: `bar ${cls}` }, s('title', {}, `${o.name}[${i}] = ${shortScalar(it)}`)));
    }
    const label = texts[i];
    // The animator measures this box, not the group: a bar that grows with
    // its value must not make the cell look as if it moved.
    const tip = o.chars ? label : pyText(it, o.heap);
    g.appendChild(s('rect', { x, y: cellTop, width: cellW, height: cellH, class: `cellbox ${cls}`, 'data-anim-anchor': true }, s('title', {}, `${o.name}[${i}] = ${tip}`)));
    // Text that does not fit even in the small font would run into the
    // neighbours' (64 cells of 3-digit values): the bar and the tooltip carry it.
    if (label.length * SMALL_PX <= cellW - 2) {
      g.appendChild(s('text', { x: x + cellW / 2, y: cellTop + cellH / 2 + 4, 'text-anchor': 'middle', class: `cell-text ${label.length * TEXT_PX > cellW - 2 ? 'small' : ''}` }, label));
    }
    // Round indices, and the first of each span (after a gap the reader
    // must see where the row picks up), where they do not overlap.
    const ix = String(i);
    const cx = x + cellW / 2;
    if ((i % step === 0 || i === a) && cx - lastIndexX >= ix.length * 6 + 2) {
      g.appendChild(s('text', { x: cx, y: cellTop + cellH + 12, 'text-anchor': 'middle', class: 'index-text' }, ix));
      lastIndexX = cx;
    }
    svg.appendChild(g);
  }
  const what = o.chars ? 'characters' : 'items';
  for (const q of gaps) {
    svg.appendChild(
      s('text', { x: q.x + q.w / 2, y: cellTop + cellH / 2 + 4, 'text-anchor': 'middle', class: 'muted-text gap-note' }, q.text,
        s('title', {}, `${o.name}[${q.from}] … ${o.name}[${q.to - 1}]: ${q.to - q.from} ${what} not drawn here. A long row is drawn around its pointers and the cells that changed.`)),
    );
  }
  if (!n) svg.appendChild(s('text', { x: X0, y: cellTop + cellH / 2 + 4, class: 'muted-text' }, 'empty'));
  if (bars) svg.appendChild(s('line', { x1: X0, x2: rowEnd, y1: baseline, y2: baseline, class: 'axis' }));
  if (more) {
    const notDrawn = drawnTo < n ? `${o.name}[${drawnTo}] onwards are not drawn here. ` : '';
    const notSent = cut ? `${o.name} has ${o.total} ${what}; the trace kept only the first ${n}.` : '';
    svg.appendChild(s('text', { x: moreX, y: cellTop + cellH / 2 + 4, class: 'muted-text cut-note' }, more, s('title', {}, notDrawn + notSent)));
  }
  if (ghost) {
    // j + 1 == len(nums): the slot the pointer names does not exist.
    const x = rowEnd;
    const why = `index ${n} does not exist: len(${o.name}) is ${n}, valid indices are 0..${n - 1}`;
    svg.appendChild(
      s('g', { class: `ghost ${ghostHot ? 'hot' : ''}` },
        s('rect', { x: x + 1, y: cellTop + 1, width: cellW - 2, height: cellH - 2, rx: 2, class: 'ghost-cell' }, s('title', {}, why)),
        s('text', { x: x + cellW / 2, y: cellTop + cellH + 12, 'text-anchor': 'middle', class: 'index-text ghost-index' }, String(n))),
    );
  }
  (o.ranges ?? []).forEach((r, k) => {
    // Drawn over the cells, faintly: cell boxes are opaque.
    const y = (bars ? top : cellTop) - 3;
    const from = slot(r.from);
    const to = slot(r.to);
    const width = to.x + to.w - from.x - 2;
    if (width <= 0) return;
    svg.appendChild(
      s('rect', {
        x: from.x + 1,
        y,
        width,
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
        s('text', { x: l.lx, y, 'text-anchor': 'middle', class: `ptr-text ${color} ${l.p.outOfRange && l.p.index >= n ? 'out-of-range' : ''}` }, l.text)),
    );
  });
  return svg;
}
