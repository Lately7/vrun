/**
 * Recognising what a container holds, from its contents and the learner's
 * naming habits: union-find parent arrays, edge lists, level-order trees,
 * nested-dict tries, (row, col) cells of a grid, and the strings a DP table
 * is built over. DOM-free.
 */
import { Encoded, Heap, HeapNode, isRef, numeric } from '../format';
import { Var, node, shortScalar } from './common';
import { END_KEY, FRONTIER, PATH, VISITED } from './names';
import { SourceHints } from './sourceHints';

function isScalar(v: Encoded): boolean {
  return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || (!isRef(v) && v.$t !== 'obj');
}

/** parent[i] in [0, len) for every i: a union-find forest (roots have parent[i] == i). */
export function isUnionFindArray(items: Encoded[], total: number): boolean {
  return items.length > 0 && items.length === total && items.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < items.length);
}

export interface EdgeItem {
  u: string;
  v: string;
  w?: string;
}

/** (u, v) or (u, v, w) tuples of scalars, else undefined. */
export function edgeListOf(items: Encoded[], heap: Heap): EdgeItem[] | undefined {
  if (!items.length) return undefined;
  const out: EdgeItem[] = [];
  for (const it of items) {
    const t = node(heap, it);
    if (!t || !(t.kind === 'tuple' || t.kind === 'list') || !t.items || (t.items.length !== 2 && t.items.length !== 3)) return undefined;
    const [u, v, w] = t.items;
    if (isRef(u) || isRef(v) || u === null || v === null) return undefined;
    if (w !== undefined && numeric(w) === undefined) return undefined;
    out.push({ u: shortScalar(u, heap), v: shortScalar(v, heap), w: w === undefined ? undefined : shortScalar(w, heap) });
  }
  return out;
}

/** LeetCode-style [3, 9, 20, None, None, 15, 7]: scalars with at least one None, root present. */
export function isLevelOrder(items: Encoded[]): boolean {
  return items.length >= 2 && items[0] !== null && items.some((x) => x === null) && items.every((x) => !isRef(x) && isScalar(x));
}

/** Truthiness as Python sees it, for flags such as node.end / node.is_word. */
export function truthy(v: Encoded | undefined): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  return true;
}

/**
 * trie = {} with node = node.setdefault(ch, {}): every value is a dict, some
 * grandchild is a dict too, and the only scalars sit under end keys ($, #,
 * end). A weighted adjacency {u: {v: w}} has scalar grandchildren instead.
 */
export function isDictTrie(n: HeapNode, heap: Heap): boolean {
  if (n.kind !== 'dict' || !n.entries?.length) return false;
  let deep = false;
  for (const [k, v] of n.entries) {
    const c = node(heap, v);
    if (c?.kind === 'dict') {
      for (const [k2, v2] of c.entries ?? []) {
        const g = node(heap, v2);
        if (g?.kind === 'dict') deep = true;
        else if (typeof k2 === 'string' && END_KEY.test(k2) && !isRef(v2)) deep = true;
        else return false;
      }
    } else if (!(typeof k === 'string' && END_KEY.test(k) && !isRef(v))) return false;
  }
  return deep;
}

/** A grid cell from (r, c), (dist, r, c) or (dist, (r, c)). */
export function cellOf(v: Encoded, heap: Heap): [number, number] | undefined {
  const t = node(heap, v);
  if (!t || !(t.kind === 'tuple' || t.kind === 'list') || !t.items) return undefined;
  const it = t.items;
  const int = (x: Encoded | undefined) => (typeof x === 'number' && Number.isInteger(x) ? x : undefined);
  if (it.length === 2 && int(it[0]) !== undefined && int(it[1]) !== undefined) return [it[0] as number, it[1] as number];
  if (it.length === 3 && int(it[1]) !== undefined && int(it[2]) !== undefined) return [it[1] as number, it[2] as number];
  if (it.length === 2 && isRef(it[1])) return cellOf(it[1], heap);
  return undefined;
}

export type CellClass = 'visited' | 'frontier' | 'onpath';

export interface CellMarks {
  /** "r,c" -> classes */
  cells: Map<string, Set<CellClass>>;
  /** Which variable gave each class, for the caption. */
  legend: Array<{ cls: CellClass; name: string }>;
}

/** Cells of a rows x cols grid held by visited / queue / path collections of (r, c) pairs. */
export function cellMarks(vars: Var[], heap: Heap, rows: number, cols: number): CellMarks {
  const cells = new Map<string, Set<CellClass>>();
  const legend: CellMarks['legend'] = [];
  for (const v of vars) {
    const cls: CellClass | undefined = VISITED.test(v.name) ? 'visited' : FRONTIER.test(v.name) ? 'frontier' : PATH.test(v.name) ? 'onpath' : undefined;
    if (!cls) continue;
    const n = node(heap, v.value);
    if (!n) continue;
    const members: Encoded[] = n.kind === 'dict' ? (n.entries ?? []).map((e) => e[0]) : ['set', 'list', 'tuple', 'deque'].includes(n.kind) ? n.items ?? [] : [];
    let hit = false;
    for (const m of members) {
      const rc = cellOf(m, heap);
      if (!rc || rc[0] < 0 || rc[0] >= rows || rc[1] < 0 || rc[1] >= cols) continue;
      const key = `${rc[0]},${rc[1]}`;
      let set = cells.get(key);
      if (!set) cells.set(key, (set = new Set()));
      set.add(cls);
      hit = true;
    }
    if (hit && !legend.some((l) => l.cls === cls)) legend.push({ cls, name: v.name });
  }
  return { cells, legend };
}

/** The characters of a string value (long strings arrive as a tagged prefix). */
export function charsOf(v: Encoded): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !isRef(v) && v.$t === 'str' && v.v !== undefined) return v.v;
  return undefined;
}

/**
 * Header characters for a DP table over strings (LCS, edit distance): a
 * string the source indexes with the table's row (column) index names,
 * whose length or length + 1 matches the row (column) count. With length
 * + 1 the first header is empty (the empty prefix).
 */
export function stringAxes(
  vars: Var[],
  hints: SourceHints,
  rows: number,
  cols: number,
  rowNames: Set<string>,
  colNames: Set<string>,
): { rowLabels?: string[]; colLabels?: string[] } {
  const fit = (s: string, dim: number): string[] | undefined =>
    s.length === dim ? [...s] : s.length + 1 === dim ? ['', ...s] : undefined;
  const strings = vars.filter((v) => charsOf(v.value) !== undefined && hints.idents.has(v.name) && (charsOf(v.value) ?? '').length >= 1);
  const indexedBy = (v: Var, names: Set<string>) => [...(hints.index.get(v.name)?.dims[0] ?? [])].some((n) => names.has(n));
  const pick = (dim: number, names: Set<string>) => {
    for (const v of strings) {
      const s = charsOf(v.value)!;
      const f = fit(s, dim);
      if (f && indexedBy(v, names)) return f;
    }
    return undefined;
  };
  return { rowLabels: pick(rows, rowNames), colLabels: pick(cols, colNames) };
}

