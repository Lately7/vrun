/**
 * Graphs as data: vertices and edges from an adjacency dict or an edge
 * list, and where to draw them. Trees and DAGs reachable from the first
 * vertex are drawn in BFS layers (the shape a learner sketches); anything
 * else on a circle. DOM-free so the layouts can be unit tested.
 */
import { Encoded, Heap, HeapNode, isRef } from '../format';
import { idScalar, node, shortScalar } from './common';
import { EdgeItem } from './shapes';

export interface GEdge {
  from: string;
  to: string;
  weight?: string;
}

export interface GraphModel {
  nodes: string[];
  edges: GEdge[];
  /** True unless every edge has its reverse (adjacency) or the source is an edge list. */
  directed: boolean;
}

export type Pos = [number, number];

export interface GraphLayout {
  pos: Map<string, Pos>;
  width: number;
  height: number;
  kind: 'tree' | 'layered' | 'circle';
}

export const NODE_R = 16;
// Room between neighbours for a weight and a `dist=..` label.
const DX = 78;
const DY = 82;
const PAD = 30;

/**
 * Identity of a vertex: scalars as text, small tuples as (r,c); other refs
 * are not vertices. Strings are kept whole, so math1 and math2 (or
 * prerequisite_1 and prerequisite_2) stay two vertices.
 */
export function vertexKey(v: Encoded, heap: Heap): string | undefined {
  if (isRef(v)) {
    const n = heap[String(v.ref)];
    if (n?.kind === 'tuple' && n.items) return '(' + n.items.map((x) => idScalar(x, heap)).join(',') + ')';
    return undefined;
  }
  return idScalar(v, heap);
}

/** Returns true when a dict looks like an adjacency structure: every value a collection. */
export function isAdjacency(n: HeapNode, heap: Heap): boolean {
  if (n.kind !== 'dict' || !n.entries || n.entries.length === 0) return false;
  return n.entries.every(([, v]) => {
    const c = node(heap, v);
    return c !== undefined && ['list', 'set', 'tuple', 'deque', 'dict'].includes(c.kind);
  });
}

export const pairId = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

function tupleOf(heap: Heap, v: Encoded): Encoded[] | undefined {
  const t = node(heap, v);
  return t?.kind === 'tuple' && t.items ? t.items : undefined;
}

/** True when every edge has its reverse with the same weight. */
function isSymmetric(edges: GEdge[]): boolean {
  const w = new Map(edges.map((e) => [`${e.from}\u0000${e.to}`, e.weight]));
  return edges.every((e) => {
    const k = `${e.to}\u0000${e.from}`;
    return w.has(k) && w.get(k) === e.weight;
  });
}

/**
 * Vertices and edges of {u: [v, ...]}, {u: [(v, w), ...]}, {u: {v: w}}.
 * A 2-tuple in a neighbour list is a vertex when the dict is keyed by such
 * tuples (a grid graph {(r, c): [(nr, nc), ...]}), else (neighbour, weight);
 * ((r, c), w) is a tuple vertex with a weight.
 */
export function adjacencyModel(g: HeapNode, heap: Heap): GraphModel {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const add = (k: string | undefined) => {
    if (k !== undefined && !seen.has(k)) {
      seen.add(k);
      nodes.push(k);
    }
  };
  const keys = new Set<string>();
  let tupleKeys = (g.entries ?? []).length > 0;
  for (const [k] of g.entries ?? []) {
    const key = vertexKey(k, heap);
    if (key !== undefined) keys.add(key);
    if (tupleOf(heap, k)?.length !== 2) tupleKeys = false;
  }
  const edges: GEdge[] = [];
  for (const [kEnc, vEnc] of g.entries ?? []) {
    const from = vertexKey(kEnc, heap);
    add(from);
    const nb = node(heap, vEnc);
    if (!nb || from === undefined) continue;
    if (nb.kind === 'dict') {
      for (const [tk, w] of nb.entries ?? []) {
        const to = vertexKey(tk, heap);
        add(to);
        if (to !== undefined) edges.push({ from, to, weight: shortScalar(w, heap) });
      }
      continue;
    }
    for (const it of nb.items ?? []) {
      const t = tupleOf(heap, it);
      const asVertex = vertexKey(it, heap);
      const pairVertex = t?.length === 2 && !isRef(t[0]) && !isRef(t[1]) && (tupleKeys || (asVertex !== undefined && keys.has(asVertex)));
      if (t && t.length === 2 && !pairVertex && (!isRef(t[0]) || tupleOf(heap, t[0]) !== undefined) && !isRef(t[1])) {
        const to = vertexKey(t[0], heap);
        add(to);
        if (to !== undefined) edges.push({ from, to, weight: shortScalar(t[1], heap) });
      } else {
        add(asVertex);
        if (asVertex !== undefined) edges.push({ from, to: asVertex });
      }
    }
  }
  return { nodes, edges, directed: !isSymmetric(edges) };
}

/**
 * adj = [[1, 2], [0], [0]] (or [(v, w), ...] rows): vertex i is row i.
 */
export function listAdjacencyModel(rows: Encoded[][], heap: Heap): GraphModel {
  const nodes = rows.map((_, i) => String(i));
  const edges: GEdge[] = [];
  rows.forEach((r, i) => {
    for (const it of r) {
      const t = tupleOf(heap, it);
      if (t && t.length === 2) edges.push({ from: String(i), to: shortScalar(t[0], heap), weight: shortScalar(t[1], heap) });
      else edges.push({ from: String(i), to: shortScalar(it, heap) });
    }
  });
  return { nodes, edges, directed: !isSymmetric(edges) };
}

/**
 * A dict of collections is a graph when its name says so or when nearly
 * every neighbour is itself a key. {3: [0, 2, 5]} (value -> positions) and
 * {'act': ['cat', 'act']} (groups) are tables, not graphs.
 */
export function looksLikeGraph(name: string, n: HeapNode, heap: Heap, graphName: RegExp): boolean {
  if (graphName.test(name)) return true;
  const m = adjacencyModel(n, heap);
  if (!m.edges.length) return false;
  const keys = new Set((n.entries ?? []).map(([k]) => vertexKey(k, heap)));
  const hits = m.edges.filter((e) => keys.has(e.to)).length;
  return hits >= 0.8 * m.edges.length;
}

/** Vertices in order of first appearance (sorted when all numeric); undirected unless `directed`. */
export function edgeListModel(list: EdgeItem[], directed = false): GraphModel {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const edges: GEdge[] = [];
  for (const e of list) {
    for (const k of [e.u, e.v]) if (!seen.has(k)) {
      seen.add(k);
      nodes.push(k);
    }
    edges.push({ from: e.u, to: e.v, weight: e.w });
  }
  if (nodes.every((k) => /^-?\d+$/.test(k))) nodes.sort((a, b) => Number(a) - Number(b));
  return { nodes, edges, directed };
}

/** Text drawn inside a vertex: up to 12 characters, the tail kept so math1 and math2 stay apart. */
export function vertexText(k: string): string {
  return k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-5)}`;
}

/** Horizontal radius of a vertex: a circle for short labels, wider for long ones. */
export function vertexRx(k: string): number {
  const t = vertexText(k);
  return t.length <= 3 ? NODE_R : Math.max(NODE_R, Math.ceil(t.length * 3.7 + 7));
}

function neighbours(m: GraphModel): Map<string, string[]> {
  const out = new Map<string, string[]>(m.nodes.map((k) => [k, []]));
  for (const e of m.edges) {
    if (e.from === e.to) continue;
    const a = out.get(e.from);
    if (a && !a.includes(e.to)) a.push(e.to);
    if (!m.directed) {
      const b = out.get(e.to);
      if (b && !b.includes(e.from)) b.push(e.from);
    }
  }
  return out;
}

function isAcyclic(m: GraphModel, adj: Map<string, string[]>): boolean {
  const state = new Map<string, number>(); // 1 = on the DFS stack, 2 = done
  for (const start of m.nodes) {
    if (state.has(start)) continue;
    // Iterative DFS: recursion would overflow on long chains.
    const stack: Array<[string, number]> = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = (adj.get(top[0]) ?? [])[top[1]++];
      if (next === undefined) {
        state.set(top[0], 2);
        stack.pop();
      } else if (state.get(next) === 1) return false;
      else if (!state.has(next)) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
  return true;
}

/** Distance between neighbouring vertices: room for the widest label, a weight and a `dist=..` label. */
function spacing(nodes: string[]): number {
  return Math.max(DX, 2 * Math.max(NODE_R, ...nodes.map(vertexRx)) + 30);
}

function circle(nodes: string[]): GraphLayout {
  const n = nodes.length;
  const dx = spacing(nodes);
  // Neighbours on the circle stay `dx` apart, as in the layered layouts.
  const R = n <= 1 ? 0 : Math.max(70, Math.min(220 * (dx / DX), n * 18 * (dx / DX)));
  const width = 2 * R + 120 + (dx - DX);
  const height = 2 * R + 90;
  const pos = new Map<string, Pos>();
  nodes.forEach((k, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    pos.set(k, [width / 2 + R * Math.cos(a), height / 2 + R * Math.sin(a)]);
  });
  return { pos, width, height, kind: 'circle' };
}

export function layoutGraph(m: GraphModel): GraphLayout {
  const n = m.nodes.length;
  if (n === 0) return { pos: new Map(), width: 120, height: 60, kind: 'circle' };
  const dx = spacing(m.nodes);
  const adj = neighbours(m);
  const root = m.nodes[0];
  // BFS from the first vertex: levels and the BFS tree.
  const level = new Map<string, number>([[root, 0]]);
  const kids = new Map<string, string[]>(m.nodes.map((k) => [k, []]));
  const order = [root];
  for (let qi = 0; qi < order.length; qi++) {
    const u = order[qi];
    for (const v of adj.get(u) ?? []) {
      if (level.has(v)) continue;
      level.set(v, level.get(u)! + 1);
      kids.get(u)!.push(v);
      order.push(v);
    }
  }
  if (order.length < n) return circle(m.nodes);
  const selfLoop = m.edges.some((e) => e.from === e.to);
  let tree: boolean;
  if (m.directed) {
    if (selfLoop || !isAcyclic(m, adj)) return circle(m.nodes);
    const indeg = new Map<string, number>(m.nodes.map((k) => [k, 0]));
    for (const [, vs] of adj) for (const v of vs) indeg.set(v, indeg.get(v)! + 1);
    tree = m.nodes.every((k) => indeg.get(k) === (k === root ? 0 : 1));
  } else {
    const pairs = new Set(m.edges.filter((e) => e.from !== e.to).map((e) => pairId(e.from, e.to)));
    if (selfLoop || pairs.size !== n - 1) return circle(m.nodes);
    tree = true;
  }
  const pos = new Map<string, Pos>();
  let cols = 0;
  let depth = 0;
  if (tree) {
    // Leaves take successive columns, a parent sits over its children.
    let next = 0;
    const xOf = new Map<string, number>();
    const place = (u: string): number => {
      const ch = kids.get(u)!;
      let x: number;
      if (ch.length) {
        const xs = ch.map(place);
        x = (xs[0] + xs[xs.length - 1]) / 2;
      } else x = next++;
      xOf.set(u, x);
      return x;
    };
    place(root);
    cols = next;
    for (const k of m.nodes) {
      depth = Math.max(depth, level.get(k)!);
      pos.set(k, [PAD + xOf.get(k)! * dx + dx / 2, PAD + level.get(k)! * DY]);
    }
  } else {
    const rows: string[][] = [];
    for (const k of order) (rows[level.get(k)!] ??= []).push(k);
    const xOf = new Map<string, number>();
    cols = Math.max(...rows.map((r) => r.length));
    rows.forEach((row, d) => {
      // Order each layer by where its parents are, to keep edges short.
      if (d > 0) {
        const bary = (k: string) => {
          const ps = m.edges.filter((e) => (e.to === k && level.get(e.from)! < d) || (!m.directed && e.from === k && level.get(e.to)! < d));
          const xs = ps.map((e) => xOf.get(e.to === k ? e.from : e.to)!).filter((x) => x !== undefined);
          return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
        };
        const b = new Map(row.map((k) => [k, bary(k)]));
        row.sort((a, c) => b.get(a)! - b.get(c)!);
      }
      const off = (cols - row.length) / 2;
      row.forEach((k, i) => xOf.set(k, off + i));
    });
    depth = rows.length - 1;
    for (const k of m.nodes) pos.set(k, [PAD + xOf.get(k)! * dx + dx / 2, PAD + level.get(k)! * DY]);
  }
  return { pos, width: Math.max(120, 2 * PAD + cols * dx), height: 2 * PAD + depth * DY + 24, kind: tree ? 'tree' : 'layered' };
}

/** `base` positions for the vertices it knows; the rest go on an extra row below. */
export function withFallback(base: GraphLayout, nodes: string[]): GraphLayout {
  const missing = nodes.filter((k) => !base.pos.has(k));
  if (!missing.length) return base;
  const dx = spacing(missing);
  const pos = new Map(base.pos);
  const y = base.height + 10;
  missing.forEach((k, i) => pos.set(k, [PAD + i * dx + dx / 2, y]));
  return { pos, width: Math.max(base.width, 2 * PAD + missing.length * dx), height: y + NODE_R + 24, kind: base.kind };
}

const finalLayouts = new WeakMap<HeapNode, GraphLayout>();

/**
 * Positions that stay put while stepping: laid out once from the graph as
 * it is at the end of the trace, reused for every step.
 */
export function stableLayout(current: GraphModel, final?: { key: HeapNode; model: () => GraphModel | undefined }): GraphLayout {
  if (final) {
    let base = finalLayouts.get(final.key);
    if (!base) {
      const fm = final.model();
      if (fm && fm.nodes.length) {
        base = layoutGraph(fm);
        finalLayouts.set(final.key, base);
      }
    }
    // Vertices the final graph no longer has (it shrank) get a spot below.
    if (base) return withFallback(base, current.nodes);
  }
  return layoutGraph(current);
}
