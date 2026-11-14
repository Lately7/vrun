/**
 * Recognising what a container holds, from its contents and the learner's
 * naming habits: union-find parent arrays, edge lists, level-order trees,
 * nested-dict tries, (row, col) cells of a grid, and the strings a DP table
 * is built over. DOM-free.
 */
import { Encoded, Heap, HeapNode, isRef, numeric } from '../format';
import { Var, idScalar, node, shortScalar } from './common';
import { ADJ_LIST_NAME, END_KEY, FRONTIER, GRID_NAME, PATH, POINT_NAME, VISITED } from './names';
import { SourceHints } from './sourceHints';

function isScalar(v: Encoded): boolean {
  return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || (!isRef(v) && v.$t !== 'obj');
}

/**
 * parent[i] in [0, len) for every i: a union-find forest (roots have
 * parent[i] == i). A negative entry is a root too: union by size keeps
 * parent[root] = -size, and a BFS parent array uses -1 for the start.
 */
export function isUnionFindArray(items: Encoded[], total: number): boolean {
  return items.length > 0 && items.length === total && items.every((x) => typeof x === 'number' && Number.isInteger(x) && x < items.length);
}

export interface EdgeItem {
  u: string;
  v: string;
  w?: string;
}

/** Tuple positions of the two endpoints and the weight of an edge. */
export interface EdgeLayout {
  u: number;
  v: number;
  w: number;
}

const WEIGHT_NAME = /^(w|wt|weight|cost|dist|d|length|distance|price|time|cap|capacity)$/i;

/**
 * Where the weight sits in a 3-tuple edge: Kruskal code often keeps
 * (w, u, v) so that edges.sort() orders by weight. Read from the names the
 * source unpacks or builds the tuples with (for w, u, v in edges;
 * mst.append((w, u, v))), else from the sort key, else (u, v, w).
 */
export function edgeLayout(hints: SourceHints | undefined, aliases: Iterable<string>): EdgeLayout & { names?: string[] } {
  const names = [...aliases];
  const from = (w: number, tuple?: string[]) => {
    const [u, v] = [0, 1, 2].filter((k) => k !== w);
    return { u, v, w, names: tuple };
  };
  for (const a of names) {
    for (const t of hints?.unpack.get(a) ?? []) {
      if (t.length !== 3) continue;
      const w = t.findIndex((n) => WEIGHT_NAME.test(n));
      if (w >= 0) return from(w, t);
    }
  }
  for (const a of names) {
    const k = hints?.sortKey.get(a);
    if (k !== undefined && k >= 0 && k <= 2) return from(k, hints?.unpack.get(a)?.find((t) => t.length === 3));
  }
  return { u: 0, v: 1, w: 2, names: names.map((a) => hints?.unpack.get(a)?.find((t) => t.length === 3)).find((t) => t) };
}

/** (u, v) or (u, v, w) tuples of scalars (positions from `layout`), else undefined. */
export function edgeListOf(items: Encoded[], heap: Heap, layout: EdgeLayout = { u: 0, v: 1, w: 2 }): EdgeItem[] | undefined {
  if (!items.length) return undefined;
  const out: EdgeItem[] = [];
  for (const it of items) {
    const t = node(heap, it);
    if (!t || !(t.kind === 'tuple' || t.kind === 'list') || !t.items || (t.items.length !== 2 && t.items.length !== 3)) return undefined;
    const three = t.items.length === 3;
    const u = t.items[three ? layout.u : 0];
    const v = t.items[three ? layout.v : 1];
    const w = three ? t.items[layout.w] : undefined;
    if (isRef(u) || isRef(v) || u === null || v === null) return undefined;
    if (w !== undefined && numeric(w) === undefined) return undefined;
    out.push({ u: idScalar(u, heap), v: idScalar(v, heap), w: w === undefined ? undefined : shortScalar(w, heap) });
  }
  return out;
}

/**
 * A directed edge list: the code relaxes along it (dist[v] = dist[u] + w
 * with the names it unpacks the edges into), or it holds u->v and v->u with
 * different weights, which an undirected graph cannot.
 */
export function isDirectedEdgeList(list: EdgeItem[], hints: SourceHints | undefined, names: string[] | undefined, layout: EdgeLayout): boolean {
  const w = new Map<string, string | undefined>();
  for (const e of list) w.set(`${e.u}\u0000${e.v}`, e.w);
  for (const e of list) {
    const back = `${e.v}\u0000${e.u}`;
    if (e.u !== e.v && w.has(back) && w.get(back) !== e.w) return true;
  }
  if (!hints || !names || names.length !== 3) return false;
  const [u, v, wt] = [names[layout.u], names[layout.v], names[layout.w]];
  return hints.relax.some((r) => r.from === u && r.to === v && r.w === wt);
}

/** Two numbers per item (lists or tuples), at least two items: candidate points or intervals. */
export function pairsOf(items: Encoded[], heap: Heap): Array<[number, number]> | undefined {
  if (items.length < 2) return undefined;
  const out: Array<[number, number]> = [];
  for (const it of items) {
    const n = node(heap, it);
    if (!n || !n.items || n.items.length !== 2) return undefined;
    const x = numeric(n.items[0]);
    const y = numeric(n.items[1]);
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    out.push([x, y]);
  }
  return out;
}

const MAX_CHAR_COLS = 80;

/**
 * Rows of a 2-D table: an ndarray, or a list / tuple of lists / tuples.
 * With `chars`, string rows are split into characters (a maze of '#' and
 * '.'); a string the kernel cut short is not a whole row, so it is refused.
 */
export function rowsOf(n: HeapNode, heap: Heap, chars = false): Encoded[][] | undefined {
  if (n.kind === 'ndarray' && n.rows) return n.rows;
  // A set has no row order; a deque is a queue of work items.
  if (!(n.kind === 'list' || n.kind === 'tuple') || !n.items || n.items.length === 0) return undefined;
  const rows: Encoded[][] = [];
  let strings = 0;
  for (const it of n.items) {
    const r = node(heap, it);
    if (r && (r.kind === 'list' || r.kind === 'tuple') && r.items) {
      rows.push(r.items);
      continue;
    }
    const s = chars ? charsOf(it) : undefined;
    const whole = s !== undefined && (typeof it === 'string' || (it as { len?: number }).len === undefined || (it as { len?: number }).len === s.length);
    if (s === undefined || !whole || s.length > MAX_CHAR_COLS) return undefined;
    rows.push([...s]);
    strings++;
  }
  return strings === 0 || strings === rows.length ? rows : undefined;
}

/** A list of strings the code treats as a grid: indexed two deep (grid[r][c]) or named like one. */
export function isCharGrid(name: string, hints: SourceHints | undefined): boolean {
  return GRID_NAME.test(name) || (hints?.index.get(name)?.dims.length ?? 0) >= 2;
}

/**
 * Rows that are a table to read (DP rows, intervals, a grid): lists, which
 * the code mutates, or anything the source indexes two deep (dp[i][0]).
 * Tuples of two numbers are values, (1, 3), and read fine as cells.
 */
export function isTableShaped(n: HeapNode, heap: Heap, name: string, hints: SourceHints | undefined): boolean {
  if (n.kind === 'ndarray') return true;
  if ((hints?.index.get(name)?.dims.length ?? 0) >= 2) return true;
  return (n.items ?? []).some((it) => node(heap, it)?.kind === 'list');
}

/** Pairs to plot: point-like names, or `for x, y in pts`. */
export function isPointList(name: string, hints: SourceHints | undefined): boolean {
  return POINT_NAME.test(name) || (hints?.unpack.get(name) ?? []).some((t) => t.length === 2 && /^x/i.test(t[0]) && /^y/i.test(t[1]));
}

/**
 * adj = [[] for _ in range(n)]: every int (or the first item of a (v, w)
 * pair) is a valid row index, and the code says it is a graph, by name or
 * by `for v in adj[u]` with v then used as an index. Value range alone
 * would also accept DP tables and triangles.
 */
export function isListAdjacency(name: string, rows: Encoded[][], heap: Heap, hints: SourceHints | undefined): boolean {
  if (!rows.length) return false;
  for (const r of rows) {
    for (const it of r) {
      const t = node(heap, it);
      const v = t?.kind === 'tuple' && t.items?.length === 2 ? t.items[0] : it;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= rows.length) return false;
    }
  }
  // `for a, b in prerequisites`: rows unpacked as records are an edge list.
  if (hints?.unpack.has(name)) return false;
  if (ADJ_LIST_NAME.test(name)) return true;
  return (hints?.iterSub.get(name) ?? []).some((s) => s.targets.some((t) => hints?.indexes.has(t)));
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
  /** Which variable gave each class, for the caption; shown / total when the kernel sent only part of it. */
  legend: Array<{ cls: CellClass; name: string; shown?: number; total?: number }>;
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
    if (hit && !legend.some((l) => l.cls === cls)) legend.push(n.len !== undefined && n.len > members.length ? { cls, name: v.name, shown: members.length, total: n.len } : { cls, name: v.name });
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

