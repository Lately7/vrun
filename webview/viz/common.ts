/** Shared helpers for the SVG data-structure views. */
import { Encoded, Heap, HeapNode, fmtPy, fmtScalar, isRef, numeric, pyStr } from '../format';

/** Locals that look like index pointers into arrays. */
const POINTER_NAME =
  /^(i|j|k|l|r|lo|hi|low|high|mid|m|left|right|start|end|begin|p|q|idx|index|pos|ptr|slow|fast|cur|curr|top|front|rear|head|tail|pivot|pi|min_idx|max_idx|min_index|max_index|best|row|col|r|c|x|y|nr|nc|dr|dc|ni|nj|nx|ny|dx|dy)$|(_idx|_index|_i|_ptr)$/i;

export interface Var {
  name: string;
  value: Encoded;
  /** frame depth (0 = module) */
  depth: number;
}

export interface VizContext {
  heap: Heap;
  prevHeap?: Heap;
  vars: Var[];
}

export function node(heap: Heap, v: Encoded | undefined): HeapNode | undefined {
  if (!isRef(v)) return undefined;
  return heap[String(v.ref)] ?? undefined;
}

export function isPointerName(name: string): boolean {
  return POINTER_NAME.test(name);
}

/** Integer locals whose value is a valid index (0..len) of an array of length `len`. */
export function pointersFor(vars: Var[], len: number): Array<{ name: string; index: number }> {
  const out: Array<{ name: string; index: number }> = [];
  for (const v of vars) {
    if (typeof v.value !== 'number' || !Number.isInteger(v.value)) continue;
    if (!isPointerName(v.name)) continue;
    if (v.value >= 0 && v.value <= len) out.push({ name: v.name, index: v.value });
  }
  return out;
}

export const POINTER_COLORS = ['ptr-0', 'ptr-1', 'ptr-2', 'ptr-3', 'ptr-4', 'ptr-5'];

export function allNumeric(items: Encoded[]): boolean {
  return items.length > 0 && items.every((x) => numeric(x) !== undefined && Number.isFinite(numeric(x)!));
}

/** "Nice" tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, maxTicks = 10): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  // Values that differ only by rounding (0.3 vs 0.1 + 0.2) count as equal:
  // a step below the float resolution never advanced and looped forever.
  const scale = Math.max(Math.abs(lo), Math.abs(hi));
  if (hi - lo <= scale * 1e-9) {
    const pad = scale === 0 ? 1 : scale * 0.1;
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  const raw = span / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  // start + k * step (not t += step) cannot get stuck; the cap is a backstop.
  // The last tick is the first one at or above hi: charts take their range
  // from the ticks, and stopping below hi cut off the highest points.
  for (let k = 0; k <= 4 * maxTicks + 4; k++) {
    const t = start + k * step;
    ticks.push(Number(t.toPrecision(12)));
    if (t >= hi - step * 1e-9) break;
  }
  return ticks;
}

const LABEL_FIELDS = ['val', 'value', 'key', 'data', 'item', 'name', 'v'];

/** Display label for a tree/list node: its val/value/key/data field. */
export function nodeLabel(n: HeapNode, heap: Heap): string {
  const fields = n.fields ?? [];
  const pick = fields.find(([k]) => LABEL_FIELDS.includes(k));
  if (!pick) return n.type ?? '?';
  const v = pick[1];
  if (isRef(v)) return n.type ?? '?';
  return shortScalar(v, heap);
}

/** The text of a str value (long strings arrive as a tagged prefix). */
export function strValue(v: Encoded | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !isRef(v) && v.$t === 'str' && v.v !== undefined) return v.v;
  return undefined;
}

const NUMBERISH = /^[-+]?(\d[\d_]*\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * A str that, drawn bare, reads as another type or as nothing: '10' (input()
 * not converted to int), '', ' ', 'None', 'abba\n'. Such cells are quoted.
 */
export function ambiguousStr(s: string): boolean {
  return s.trim() === '' || s !== s.trim() || /[\n\r\t]/.test(s) || NUMBERISH.test(s) || /^(None|True|False|inf|-inf|nan)$/.test(s);
}

/**
 * A value as a short cell label. Containers of work items are read by what
 * they hold: a stack of TreeNodes shows the nodes' values, a heap of
 * (dist, i, node) shows '(3,0,7)', a BFS queue '((2,3),4)', a hash bucket
 * '[1,10]'. Tuples and lists of up to 3 items are drawn recursively, two
 * levels deep; a node inside one shows its label. `depth` is the nesting
 * level of `v` itself.
 */
export function shortScalar(v: Encoded, heap?: Heap, depth = 0): string {
  if (typeof v === 'string') {
    const t = v.length > 8 ? v.slice(0, 7) + '…' : v;
    // Inside a tuple, (1, '1') must not read as (1, 1).
    return depth > 0 && ambiguousStr(v) ? pyStr(t) : t;
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)));
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (isRef(v)) {
    const n = heap?.[String(v.ref)];
    if (!n) return '…';
    if (n.kind === 'object') return nodeLabel(n, heap!);
    const whole = n.items !== undefined && (n.len ?? n.items.length) === n.items.length;
    if ((n.kind === 'tuple' || n.kind === 'list') && whole && depth < 2 && n.items!.length <= 3) {
      const inner = n.items!.map((x) => shortScalar(x, heap, depth + 1));
      return n.kind === 'tuple' ? `(${inner.join(',')}${inner.length === 1 ? ',' : ''})` : `[${inner.join(',')}]`;
    }
    return n.len !== undefined && n.kind !== 'ndarray' ? `${n.kind}[${n.len}]` : n.kind;
  }
  if (v.$t === 'inf') return '∞';
  if (v.$t === '-inf') return '-∞';
  if (v.$t === 'nan') return 'NaN';
  // A 63-digit int cut to 8 characters must not read as a smaller number.
  if (v.v) return v.v.length > 8 ? v.v.slice(0, 7) + '…' : v.v;
  return v.$t;
}

/** shortScalar, with a str that would read as another type quoted: '10', '', 'None'. */
export function cellText(v: Encoded, heap?: Heap): string {
  const t = strValue(v);
  return t !== undefined && ambiguousStr(t) ? pyStr(t.length > 8 ? t.slice(0, 7) + '…' : t) : shortScalar(v, heap);
}

/**
 * A value as Python would print it, for tooltips: the whole tuple, a node as
 * TreeNode(val=5), strings quoted.
 */
export function pyText(v: Encoded, heap?: Heap, depth = 0): string {
  if (!isRef(v)) return fmtPy(v, heap);
  const n = heap?.[String(v.ref)];
  if (!n) return '… (not shown: too many objects)';
  if (n.kind === 'object') {
    const pick = (n.fields ?? []).find(([k]) => LABEL_FIELDS.includes(k));
    return pick && !isRef(pick[1]) ? `${n.type ?? 'object'}(${pick[0]}=${fmtPy(pick[1])})` : `<${n.type ?? 'object'} object>`;
  }
  if ((n.kind === 'tuple' || n.kind === 'list') && n.items && depth < 3) {
    const shown = n.items.slice(0, 6).map((x) => pyText(x, heap, depth + 1));
    const cut = (n.len ?? n.items.length) > shown.length;
    if (n.kind === 'list') return `[${shown.join(', ')}${cut ? ', …' : ''}]`;
    return `(${shown.join(', ')}${cut ? ', …' : shown.length === 1 ? ',' : ''})`;
  }
  return fmtScalar(v, heap);
}

/**
 * What every item of a container is, when they agree: 'str' ('10' is not
 * 10), or one class (a stack of TreeNode, whose cells show values).
 */
export function itemType(items: Encoded[], heap: Heap): string | undefined {
  if (!items.length) return undefined;
  if (items.every((x) => strValue(x) !== undefined)) return 'str';
  const types = new Set(items.map((x) => {
    const n = isRef(x) ? heap[String(x.ref)] : undefined;
    return n?.kind === 'object' ? n.type ?? '' : '';
  }));
  const [t] = types;
  return types.size === 1 && t ? t : undefined;
}

/**
 * Heap ids of the objects held by the work containers among `vars`
 * (stack, queue, frontier, heap, pq ...), also inside small tuples such as
 * (dist, i, node): the nodes still waiting to be processed, each with the
 * name of the container holding it.
 */
export function memberRefs(vars: Var[], heap: Heap, re: RegExp): Map<number, string> {
  const out = new Map<number, string>();
  const add = (v: Encoded, depth: number, name: string) => {
    if (!isRef(v)) return;
    const n = heap[String(v.ref)];
    if (n?.kind === 'object') {
      if (!out.has(v.ref)) out.set(v.ref, name);
    } else if (depth < 2 && (n?.kind === 'tuple' || n?.kind === 'list') && n.items && n.items.length <= 4) for (const x of n.items) add(x, depth + 1, name);
  };
  const scan = (name: string, value: Encoded, label = name) => {
    if (!re.test(name)) return;
    const n = node(heap, value);
    if (!n || n.kind === 'object' || n.kind === 'dict') return;
    for (const it of n.items ?? []) add(it, 1, label);
  };
  for (const v of vars) {
    scan(v.name, v.value);
    // BSTIterator keeps its stack in self.stack.
    const o = node(heap, v.value);
    if (o?.kind === 'object') for (const [f, val] of o.fields ?? []) scan(f, val, `${v.name}.${f}`);
  }
  return out;
}

/** Like shortScalar, but a string is kept whole: an identity (a graph vertex), not a cell label. */
export function idScalar(v: Encoded, heap?: Heap): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !isRef(v) && v.$t === 'str' && v.v !== undefined) return v.v;
  return shortScalar(v, heap);
}

/** Refs (by heap id) held by variables, used to label tree / list nodes. */
export function refLabels(vars: Var[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const v of vars) {
    if (isRef(v.value)) {
      const arr = m.get(v.value.ref) ?? [];
      if (!arr.includes(v.name)) arr.push(v.name);
      m.set(v.value.ref, arr);
    }
  }
  return m;
}

export function sameEncoded(a: Encoded | undefined, b: Encoded | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What itemKeys remembers of the last drawing of an array. */
export interface KeyMemo {
  sig: string[];
  keys: string[];
}

/**
 * Animation keys (data-anim) for the items of an array, relative to the
 * last drawing of the same array. When the step only moved values around
 * (a swap, a sort pass: the same multiset) each value keeps its key and
 * the animator slides it to its new place; after a single push or pop the
 * surviving values keep theirs too; otherwise keys stay with their
 * positions, so an in-place change flashes. Carrying keys over (instead of
 * switching between value keys and index keys) keeps a no-op step after
 * an in-place change from re-fading the whole array.
 */
export function itemKeys(items: Encoded[], last: KeyMemo | undefined): KeyMemo {
  const sig = items.map((x) => JSON.stringify(x));
  const keys: string[] = [];
  const used = new Set<string>();
  const fresh = (i: number) => {
    let k = `i:${i}`;
    for (let n = 1; used.has(k); n++) k = `i:${i}.${n}`;
    return k;
  };
  if (last && last.sig.length === sig.length && sameMultiset(last.sig, sig)) {
    const pool = new Map<string, string[]>();
    last.sig.forEach((x, i) => {
      const list = pool.get(x);
      if (list) list.push(last.keys[i]);
      else pool.set(x, [last.keys[i]]);
    });
    for (const x of sig) {
      const k = pool.get(x)!.shift()!;
      keys.push(k);
      used.add(k);
    }
    return { sig, keys };
  }
  if (last && Math.abs(last.sig.length - sig.length) === 1) {
    // One push or pop (heappush appends and sifts in one step): values that
    // survive keep their key and slide; an equal value prefers its own index.
    const out: Array<string | undefined> = sig.map((x, i) => (last.sig[i] === x ? last.keys[i] : undefined));
    const taken = new Set(out.filter((k): k is string => k !== undefined));
    sig.forEach((x, i) => {
      if (out[i] !== undefined) return;
      let best = -1;
      last.sig.forEach((y, j) => {
        if (y === x && !taken.has(last.keys[j]) && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) best = j;
      });
      if (best >= 0) {
        out[i] = last.keys[best];
        taken.add(last.keys[best]);
      }
    });
    for (const k of taken) used.add(k);
    out.forEach((k, i) => {
      const key = k ?? fresh(i);
      keys.push(key);
      used.add(key);
    });
    return { sig, keys };
  }
  sig.forEach((_, i) => {
    const old = last?.keys[i];
    const k = old !== undefined && !used.has(old) ? old : fresh(i);
    keys.push(k);
    used.add(k);
  });
  return { sig, keys };
}

function sameMultiset(a: string[], b: string[]): boolean {
  const count = new Map<string, number>();
  for (const k of a) count.set(k, (count.get(k) ?? 0) + 1);
  for (const k of b) {
    const c = count.get(k);
    if (!c) return false;
    count.set(k, c - 1);
  }
  return true;
}

export function textWidth(t: string, px = 7): number {
  return t.length * px;
}
