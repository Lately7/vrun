/** Shared helpers for the SVG data-structure views. */
import { Encoded, Heap, HeapNode, isRef, numeric } from '../format';

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
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  const raw = span / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 0.5; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

/** Display label for a tree/list node: its val/value/key/data field. */
export function nodeLabel(n: HeapNode, heap: Heap): string {
  const fields = n.fields ?? [];
  const pick = fields.find(([k]) => ['val', 'value', 'key', 'data', 'item', 'name', 'v'].includes(k));
  if (!pick) return n.type ?? '?';
  const v = pick[1];
  if (isRef(v)) return n.type ?? '?';
  return shortScalar(v, heap);
}

export function shortScalar(v: Encoded, heap?: Heap): string {
  if (typeof v === 'string') return v.length > 8 ? v.slice(0, 7) + '…' : v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)));
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (isRef(v)) {
    const n = heap?.[String(v.ref)];
    if (!n) return '…';
    // Small tuples are values to a learner, e.g. (dist, node) in a priority
    // queue or (row, col) in a BFS queue: show their contents.
    if (n.kind === 'tuple' && n.items && n.items.length <= 3 && n.items.every((x) => !isRef(x))) {
      return '(' + n.items.map((x) => shortScalar(x)).join(',') + ')';
    }
    return n.kind === 'object' ? n.type ?? 'obj' : `${n.kind}`;
  }
  if (v.$t === 'inf') return '∞';
  if (v.$t === '-inf') return '-∞';
  if (v.$t === 'nan') return 'NaN';
  return v.v ? v.v.slice(0, 8) : v.$t;
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

export function textWidth(t: string, px = 7): number {
  return t.length * px;
}
