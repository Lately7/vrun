/**
 * Recursion tree: every call of a traced function as a node `f(args)`,
 * children in call order, the return value once it returned. Calls on the
 * current stack are highlighted; later calls are not drawn yet. Past
 * MAX_NODES calls, the tree keeps the calls around the current step and
 * folds the others into "…" leaves. A long chain of recursive calls (a
 * recursion without a base case, a 1000-deep sum, is_even() and is_odd()
 * taking turns; helper calls aside) keeps its first and last calls and
 * folds the middle into one "… 968 calls" node: drawn in full it made the
 * page 55,000 px tall. With `foldHelpers`, calls of
 * functions that never recurse (N-Queens' safe()) become a "+4 safe()"
 * badge on their caller.
 */
import { s, svgRoot } from '../dom';
import { type Heap, fmtPy } from '../format';
import { type CallNode, type TraceModel } from '../traceModel';
import { callEnd, callLabel } from './callLabels';

const MAX_NODES = 300;
/** Children of a call on the stack kept around the current step. */
const MAX_SIBLINGS = 24;
const DY = 56;
/** A chain of more calls than this folds its middle. */
const CHAIN_MAX = 24;
/** Calls of a folded chain kept at its top (the root among them), at its bottom, and around the current call. */
const CHAIN_HEAD = 4;
const CHAIN_TAIL = 8;
const CHAIN_AROUND = 2;
/** Owner of the helper calls made at module level (they have no caller node). */
export const ROOT_GROUP = -1;

export interface CallTreeOptions {
  /** Fold calls of helper functions (TraceModel.helpers) into a badge on their caller. */
  foldHelpers?: boolean;
  /** Callers (fid, or ROOT_GROUP) whose helper calls are drawn anyway: their badge was clicked. */
  expanded?: ReadonlySet<number>;
  /** A badge was clicked: show or fold again the helper calls of this caller. */
  onToggle?: (owner: number) => void;
}

export interface CallTree {
  svg: SVGSVGElement;
  /** What is not drawn, when something is not: shown under the card header. */
  note?: string;
}

/** Helper calls folded into one caller's badge (or the module-level group). */
interface Folded {
  count: number;
  /** Function names in call order, without repeats. */
  names: string[];
  /** The calls they made in turn (quicksort's partition() calls swap()), folded with them; and their names. */
  inner: number;
  innerNames: string[];
  /** The running call is one of them (or inside one). */
  hot: boolean;
  /** Unfolded: the badge offers to fold them again. */
  open: boolean;
}

interface Laid {
  /** undefined for a fold of `gap` calls that are not drawn. */
  call?: CallNode;
  gap?: number;
  /** A folded middle of a chain: its first and last call. */
  run?: { first: CallNode; last: CallNode };
  /** Module-level helper calls folded into one node. */
  group?: Folded;
  /**
   * A call drawn in a folded chain's column has no room for its helper
   * calls (check(n) before the recursive call): they are a badge that
   * jumps to the first of them.
   */
  side?: { f: Folded; first: CallNode };
  /** Column (a parent sits between its children's), and the columns its subtree spans. */
  x: number;
  lo: number;
  hi: number;
  depth: number;
  kids: Laid[];
}

const badgeText = (f: Folded) => `${f.open ? '−' : '+'}${f.count} ${f.names[0]}()${f.names.length > 1 ? '…' : ''}`;

/**
 * "1 call of partition() and the 4 calls it made (swap())": the badge says
 * "+1 partition()", as many as the caller made, and the title the rest, so
 * the note's count of folded calls adds up.
 */
function foldedText(f: Folded): string {
  const names = (list: string[]) => list.map((n) => `${n}()`).join(', ');
  const inner = f.inner ? ` and the ${f.inner} call${f.inner === 1 ? '' : 's'} ${f.count === 1 ? 'it' : 'they'} made (${names(f.innerNames)})` : '';
  return `${f.count} call${f.count === 1 ? '' : 's'} of ${names(f.names)}${inner}`;
}

function badgeTitle(f: Folded): string {
  const what = `${foldedText(f)}, which ${f.count + f.inner === 1 ? 'does' : 'do'} not recurse`;
  return f.open ? `${what}. Click to fold them again.` : `${what}, folded here ("Recursive calls only"). Click to show them.`;
}

/** Every call under c so far (iterative: the subtree can be a 1000-deep recursion). */
function callsUnder(c: CallNode, kidsOf: (c: CallNode) => CallNode[]): CallNode[] {
  const out: CallNode[] = [];
  for (const todo = kidsOf(c); todo.length;) {
    const x = todo.pop()!;
    out.push(x);
    todo.push(...kidsOf(x));
  }
  return out;
}

/** The calls to draw when there are too many: the stack, its latest children, the latest calls. */
function pick(calls: Map<number, CallNode>, visible: CallNode[], active: number[], k: number, hidden: (id: number) => boolean): Set<number> {
  const keep = new Set<number>();
  const add = (id: number | undefined) => {
    for (let p = id; p !== undefined && !keep.has(p); p = calls.get(p)?.parent) keep.add(p);
  };
  for (const id of active) {
    add(id);
    const kids = (calls.get(id)?.children ?? []).filter((c) => (calls.get(c)?.startStep ?? Infinity) <= k && !hidden(c));
    kids.slice(-MAX_SIBLINGS).forEach(add);
  }
  const latest = [...visible].sort((a, b) => b.startStep - a.startStep);
  for (const c of latest) {
    if (keep.size >= MAX_NODES) break;
    add(c.fid);
  }
  return keep;
}

/**
 * Splits a long chain into the calls to draw and runs to fold: the head
 * (with the root), the tail (where a missing base case ends) and the calls
 * around `at`, the running one.
 */
export function chainPieces<T>(chain: T[], at: number): Array<T | T[]> {
  const n = chain.length;
  const kept = (i: number) => i < CHAIN_HEAD || i >= n - CHAIN_TAIL || (at >= 0 && Math.abs(i - at) <= CHAIN_AROUND);
  const out: Array<T | T[]> = [];
  let run: T[] = [];
  const flush = () => {
    // A fold of one call would take as much room as the call.
    if (run.length === 1) out.push(run[0]);
    else if (run.length) out.push(run);
    run = [];
  };
  chain.forEach((c, i) => {
    if (kept(i)) {
      flush();
      out.push(c);
    } else run.push(c);
  });
  flush();
  return out;
}

/**
 * Draws the calls made up to step k. `onPick(step)` jumps to the start of a
 * clicked call.
 */
export function renderCallTree(model: TraceModel, k: number, heapAt: (k: number) => Heap, onPick: (step: number) => void, opts: CallTreeOptions = {}): CallTree | undefined {
  const calls = model.calls();
  const visible: CallNode[] = [];
  for (const c of calls.values()) if (c.startStep <= k) visible.push(c);
  if (!visible.length) return undefined;
  const stack = model.activeCalls(k);
  const active = new Set(stack);
  const top = stack.at(-1);

  // Helper calls folded into a badge: the caller (or ROOT_GROUP) that owns each one.
  const owner = new Map<number, number>();
  const folded = new Map<number, Folded>();
  /** Helper calls made at module level, folded or not: where the group node goes. */
  const rootHelpers = new Set<number>();
  if (opts.foldHelpers) {
    const helpers = model.helpers();
    for (const c of visible) {
      // Calls are in the order they started: a caller comes before its calls.
      if (!helpers.has(c.fid)) continue;
      const p = c.parent !== undefined && calls.has(c.parent) ? c.parent : undefined;
      const inside = p !== undefined ? owner.get(p) : undefined;
      if (inside !== undefined) {
        owner.set(c.fid, inside); // a call made by a folded helper call
        const f = folded.get(inside)!;
        f.inner++;
        if (!f.innerNames.includes(c.func)) f.innerNames.push(c.func);
        continue;
      }
      if (p !== undefined && helpers.has(p)) continue; // inside a helper call that was unfolded
      const o = p ?? ROOT_GROUP;
      if (o === ROOT_GROUP) rootHelpers.add(c.fid);
      let f = folded.get(o);
      if (!f) folded.set(o, (f = { count: 0, names: [], inner: 0, innerNames: [], hot: false, open: opts.expanded?.has(o) ?? false }));
      f.count++;
      if (!f.names.includes(c.func)) f.names.push(c.func);
      if (!f.open) owner.set(c.fid, o);
    }
  }
  const hidden = (id: number) => owner.has(id);
  const helperSet = model.helpers();
  // Where the running call is drawn: itself, or the caller whose badge holds it.
  let focus = top !== undefined ? owner.get(top) ?? top : undefined;
  if (focus !== undefined && top !== undefined && focus !== top) folded.get(focus)!.hot = true;
  const drawable = visible.filter((c) => !hidden(c.fid));
  const keep = drawable.length > MAX_NODES ? pick(calls, drawable, stack.filter((id) => !hidden(id)), k, hidden) : undefined;
  const kidsOf = (c: CallNode) =>
    c.children.map((id) => calls.get(id)).filter((x): x is CallNode => x !== undefined && x.startStep <= k);
  /** c and every call under it so far: a "…" leaf stands for all of them, not for "1 more call". */
  const sizeOf = (c: CallNode): number => 1 + callsUnder(c, kidsOf).length;

  let nextX = 0;
  let drawn = 0;
  let maxDepth = 0;
  /** Calls in "…" leaves: left out by `pick`, away from the current step. */
  let picked = 0;
  const layAll = (list: CallNode[], depth: number): Laid[] => {
    const out: Laid[] = [];
    let gap = 0;
    let group = false;
    const flush = () => {
      if (!gap) return;
      out.push({ gap, x: nextX, lo: nextX, hi: nextX++, depth, kids: [] });
      maxDepth = Math.max(maxDepth, depth);
      picked += gap;
      gap = 0;
    };
    for (const c of list) {
      if (c.startStep > k) continue;
      // A caller's helper calls are its badge; module-level ones get a node
      // of their own (where the first of them was made), also once unfolded
      // so they can be folded again.
      if (rootHelpers.has(c.fid) && !group) {
        flush();
        group = true;
        out.push({ group: folded.get(ROOT_GROUP), x: nextX, lo: nextX, hi: nextX++, depth, kids: [] });
        maxDepth = Math.max(maxDepth, depth);
      }
      if (hidden(c.fid)) continue;
      if (keep && !keep.has(c.fid)) {
        gap += sizeOf(c);
        continue;
      }
      flush();
      out.push(lay(c, depth));
    }
    flush();
    return out;
  };
  /** Helper calls of c that are drawn (not in a badge): they hang off a chain, they do not end it. */
  const sideKids = (c: CallNode) => kidsOf(c).filter((x) => !hidden(x.fid) && helperSet.has(x.fid));
  /**
   * c and its only drawn callee that recurses, and its only one, … Helper
   * calls aside (down(n) calls check(n), then down(n - 1)), and the
   * functions may take turns (is_even() and is_odd()).
   */
  const chainOf = (c: CallNode): CallNode[] => {
    const chain = [c];
    for (let cur = c; ;) {
      const kids = kidsOf(cur).filter((x) => !hidden(x.fid) && !helperSet.has(x.fid));
      if (kids.length !== 1 || !model.recurses(kids[0]) || (keep && !keep.has(kids[0].fid))) return chain;
      // Helper calls unfolded with a click on the badge: drawn in full, so the chain ends here.
      if (opts.foldHelpers && sideKids(cur).length) return chain;
      cur = kids[0];
      chain.push(cur);
    }
  };
  const layOne = (c: CallNode, depth: number): Laid => {
    drawn++;
    maxDepth = Math.max(maxDepth, depth);
    const lo = nextX;
    const kids = layAll(kidsOf(c), depth + 1);
    // Leaves take the next column; a parent sits over its children.
    const x = kids.length ? (kids[0].x + kids[kids.length - 1].x) / 2 : nextX++;
    return { call: c, x, lo, hi: nextX - 1, depth, kids };
  };
  const lay = (c: CallNode, depth: number): Laid => {
    const chain = chainOf(c);
    if (chain.length <= CHAIN_MAX) return layOne(c, depth);
    // Around the deepest call of the chain on the stack: the running one, or the caller of what runs.
    let at = -1;
    for (let i = chain.length - 1; i >= 0 && at < 0; i--) if (active.has(chain[i].fid)) at = i;
    const pieces = chainPieces(chain, at);
    // Bottom-up: the last call lays out its own subtree, the rest is one column above it.
    let below = layOne(pieces[pieces.length - 1] as CallNode, depth + pieces.length - 1);
    for (let i = pieces.length - 2; i >= 0; i--) {
      const p = pieces[i];
      const col = { x: below.x, lo: below.lo, hi: below.hi, depth: depth + i, kids: [below] };
      if (Array.isArray(p)) {
        below = { run: { first: p[0], last: p[p.length - 1] }, gap: p.length, ...col };
        continue;
      }
      drawn++;
      below = { call: p, ...col };
      const side = sideKids(p);
      if (side.length) {
        const hot = side.some((x) => active.has(x.fid));
        if (hot) focus = p.fid; // the running helper call is in this badge
        const inner = side.flatMap((x) => callsUnder(x, kidsOf));
        below.side = {
          f: { count: side.length, names: [...new Set(side.map((x) => x.func))], inner: inner.length, innerNames: [...new Set(inner.map((x) => x.func))], hot, open: false },
          first: side[0],
        };
      }
    }
    return below;
  };
  const roots = visible.filter((c) => c.parent === undefined || !calls.has(c.parent));
  const laid = layAll(roots, 0);

  // Column width from the longest label, so fib(3) trees stay compact and
  // merge_sort([38, 27, 43]) labels do not overlap.
  const labels = new Map<number, string>();
  const all: Laid[] = [];
  const collect = (l: Laid) => {
    all.push(l);
    if (l.call) labels.set(l.call.fid, callLabel(l.call, heapAt));
    l.kids.forEach(collect);
  };
  laid.forEach(collect);
  const boxW = (label: string, dx: number) => Math.min(dx - 6, Math.max(28, label.length * 6.4 + 10));
  const badgeW = (f: Folded) => badgeText(f).length * 5.8 + 10;
  const longest = Math.max(4, ...[...labels.values()].map((t) => t.length));
  const DX = Math.min(160, Math.max(46, longest * 6.4 + 16));
  const badgeOf = (l: Laid) => (l.call ? folded.get(l.call.fid) ?? l.side?.f : undefined);
  // A badge sits right of its caller's box. Only the gap after the badge's
  // subtree is widened, enough to keep it off the next box: widening every
  // column pushed merge sort's root off the screen.
  const centers: number[] = [10 + DX / 2];
  const at = new Map<Laid, number>();
  const X = (l: Laid): number => {
    let v = at.get(l);
    if (v === undefined) {
      v = l.kids.length ? (X(l.kids[0]) + X(l.kids[l.kids.length - 1])) / 2 : centers[l.x];
      at.set(l, v);
    }
    return v;
  };
  const byLast = new Map<number, Laid[]>();
  for (const l of all) if (badgeOf(l)) byLast.set(l.hi, [...(byLast.get(l.hi) ?? []), l]);
  for (let col = 0; col + 1 < Math.max(1, nextX); col++) {
    // X() of a subtree that ends at `col` needs only the columns up to it.
    let extra = 0;
    for (const l of byLast.get(col) ?? []) {
      const right = X(l) + boxW(labels.get(l.call!.fid) ?? '', DX) / 2 + 4 + badgeW(badgeOf(l)!);
      // The next box at this depth starts at the earliest half a box left of the next column.
      extra = Math.max(extra, right + 4 - (centers[col] + DX / 2 + 3));
    }
    centers.push(centers[col] + DX + extra);
  }
  let width = centers[centers.length - 1] + DX / 2 + 10;
  const height = (maxDepth + 1) * DY + 10;
  const Y = (l: Laid) => 18 + l.depth * DY;
  const keyOf = (l: Laid) => (l.call ? `c:${l.call.fid}` : l.run ? `f:${l.run.first.fid}` : l.group ? 'g:module' : '');
  const edges: SVGElement[] = [];
  const nodes: SVGElement[] = [];
  const pill = (x: number, y: number, f: Folded, title: string, act: () => void) => {
    const w = badgeW(f);
    const g = s('g', { class: `helper-badge ${f.hot ? 'hot' : ''} ${f.open ? 'open' : ''}`, role: 'button', tabindex: 0 },
      s('rect', { x, y: y - 8, width: w, height: 16, rx: 8 }),
      s('text', { x: x + w / 2, y: y + 4, 'text-anchor': 'middle', class: 'badge-text' }, badgeText(f)),
      s('title', {}, title));
    const toggle = (e: Event) => {
      e.stopPropagation(); // not a jump to the caller
      act();
    };
    g.addEventListener('click', toggle);
    g.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') toggle(e);
    });
    return g;
  };
  const walk = (l: Laid) => {
    for (const c of l.kids) {
      const hot = (c.call !== undefined && active.has(c.call.fid)) || (c.run !== undefined && active.has(c.run.first.fid));
      edges.push(s('line', {
        x1: X(l), y1: Y(l) + 10, x2: X(c), y2: Y(c) - 10,
        class: `edge ${hot ? 'hot-call' : ''} ${c.call ? '' : 'fold-edge'}`,
        'data-anim-edge': `${keyOf(l)} ${keyOf(c)}`.trim(),
      }));
      walk(c);
    }
    const c = l.call;
    if (l.run) {
      const { first, last } = l.run;
      const text = `… ${l.gap} calls`;
      const w = boxW(text, DX);
      const range = `${labels.get(first.fid) ?? callLabel(first, heapAt)} … ${labels.get(last.fid) ?? callLabel(last, heapAt)}`;
      const g = s('g', { class: `call fold run ${active.has(first.fid) ? 'active' : ''}`, 'data-anim': keyOf(l) },
        s('rect', { x: X(l) - w / 2, y: Y(l) - 10, width: w, height: 20, rx: 4, 'data-anim-anchor': '' }),
        s('text', { x: X(l), y: Y(l) + 4, 'text-anchor': 'middle', class: 'call-text' }, text),
        s('title', {}, `${l.gap} calls not drawn: ${range} — click to jump to the first of them`));
      // The range reads best beside the fold; only where no other call is drawn.
      const from = X(l) + w / 2 + 6;
      const to = from + range.length * 5.8;
      if (!all.some((o) => o !== l && o.depth === l.depth && o.x > l.x && X(o) - DX / 2 < to)) {
        g.appendChild(s('text', { x: from, y: Y(l) + 4, class: 'muted-text call-range' }, range));
        width = Math.max(width, to + 10);
      }
      g.addEventListener('click', () => onPick(first.startStep));
      nodes.push(g);
      return;
    }
    if (l.group) {
      const f = l.group;
      const w = Math.max(DX - 6, badgeW(f));
      const g = s('g', { class: `call fold group ${focus === ROOT_GROUP ? 'current' : ''}`, 'data-anim': keyOf(l) },
        s('rect', { x: X(l) - w / 2, y: Y(l) - 10, width: w, height: 20, rx: 4, 'data-anim-anchor': '' }),
        s('text', { x: X(l), y: Y(l) + 4, 'text-anchor': 'middle', class: 'call-text' }, badgeText(f)),
        s('title', {}, badgeTitle(f)));
      g.addEventListener('click', () => opts.onToggle?.(ROOT_GROUP));
      nodes.push(g);
      width = Math.max(width, X(l) + w / 2 + 10);
      return;
    }
    if (!c) {
      nodes.push(s('g', { class: 'call fold' },
        s('text', { x: X(l), y: Y(l) + 4, 'text-anchor': 'middle', class: 'call-text' }, '…'),
        s('title', {}, `${l.gap} more call${l.gap === 1 ? '' : 's'} not drawn`)));
      return;
    }
    const done = c.endStep !== undefined && c.endStep <= k;
    const cls = ['call', c.fid === focus ? 'current' : active.has(c.fid) ? 'active' : done ? 'done' : 'open', done && c.raised !== undefined ? 'raised' : ''].join(' ');
    const label = labels.get(c.fid) ?? '';
    const w = boxW(label, DX);
    const end = done ? callEnd(c, heapAt(c.endStep!)) : '';
    const how = !done ? '' : c.raised === 'GeneratorExit' ? ', closed' : c.raised !== undefined ? `, raised ${c.raised}` : `, returned ${fmtPy(c.ret, heapAt(c.endStep!))}`;
    // The box is the anchor: the "→ value" text below it must not make the node slide.
    const g = s('g', { class: cls, 'data-anim': `c:${c.fid}` },
      s('rect', { x: X(l) - w / 2, y: Y(l) - 10, width: w, height: 20, rx: 4, 'data-anim-anchor': '' }),
      s('text', { x: X(l), y: Y(l) + 4, 'text-anchor': 'middle', class: 'call-text' }, label),
      s('title', {}, `${label}  (step ${c.startStep + 1}${how}) — click to jump here`));
    if (end) g.appendChild(s('text', { x: X(l), y: Y(l) + 22, 'text-anchor': 'middle', class: 'call-ret' }, end));
    const f = folded.get(c.fid);
    if (f) g.appendChild(pill(X(l) + w / 2 + 4, Y(l), f, badgeTitle(f), () => opts.onToggle?.(c.fid)));
    else if (l.side) {
      const { f: sf, first } = l.side;
      g.appendChild(pill(X(l) + w / 2 + 4, Y(l), sf, `${foldedText(sf)}, not drawn in the folded chain. Click to jump to the first.`, () => onPick(first.startStep)));
    }
    const bf = f ?? l.side?.f;
    if (bf) width = Math.max(width, X(l) + w / 2 + 4 + badgeW(bf) + 6); // the last column's badge
    g.addEventListener('click', () => onPick(c.startStep));
    nodes.push(g);
  };
  laid.forEach(walk);
  const svg = svgRoot(width, height, `recursion tree with ${drawn} calls`);
  // Shrunk to the card width a wide tree became unreadable: scroll instead.
  svg.classList.add('no-shrink');
  edges.forEach((e) => svg.appendChild(e));
  nodes.forEach((e) => svg.appendChild(e));
  // Said only when something is not drawn ("983 of 983 calls drawn" read as if some were missing).
  // A badge on a call inside a "…" fold is not drawn either: its calls are left out.
  const drawnIds = new Set(all.filter((l) => l.call).map((l) => l.call!.fid));
  const groupDrawn = all.some((l) => l.group);
  let badged = 0;
  for (const o of owner.values()) if (o === ROOT_GROUP ? groupDrawn : drawnIds.has(o)) badged++;
  const left = visible.length - drawn - badged;
  const parts: string[] = [];
  if (left > 0) parts.push(`… = ${left} call${left === 1 ? '' : 's'} left out${picked ? ' (the calls around the current step are drawn)' : ''}`);
  if (badged > 0) parts.push(`+N = ${badged} call${badged === 1 ? '' : 's'} of helpers that do not recurse, folded into their caller (click a badge to show them)`);
  return { svg, note: parts.length ? `${drawn} of ${visible.length} calls drawn · ${parts.join(' · ')}` : undefined };
}
