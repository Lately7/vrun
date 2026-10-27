/**
 * Graph ("đồ thị") from an adjacency dict: {u: [v, ...]} or {u: {v: w}}.
 * Nodes found in `visited`/`seen` sets are filled; nodes in `queue`/`stack`
 * are outlined; a scalar local such as `node`/`u`/`cur` marks the current one.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, HeapNode, isRef } from '../format';
import { Var, node, shortScalar } from './common';

const VISITED = /^(visited|seen|done|closed|explored|marked)$/i;
const FRONTIER = /^(queue|q|stack|st|frontier|open|open_set|heap|pq|dq|to_visit|todo)$/i;
// Only consecutive-vertex sequences: a BFS `order` is not a path.
const PATH = /^(path|best_path|shortest_path|cycle)$/i;
const CURRENT = /^(node|u|v|cur|curr|current|vertex|n|nxt|next_node|neighbor|nei|w)$/i;
const DIST = /^(dist|distance|distances|d|cost|costs|level|depth|parent|prev)$/i;

interface Edge {
  from: string;
  to: string;
  weight?: string;
}

function key(v: Encoded, heap: Heap): string | undefined {
  if (isRef(v)) {
    const n = heap[String(v.ref)];
    if (n?.kind === 'tuple' && n.items) return '(' + n.items.map((x) => shortScalar(x, heap)).join(',') + ')';
    return undefined;
  }
  return shortScalar(v, heap);
}

/** Returns true when a dict looks like an adjacency structure. */
export function isAdjacency(n: HeapNode, heap: Heap): boolean {
  if (n.kind !== 'dict' || !n.entries || n.entries.length === 0) return false;
  return n.entries.every(([, v]) => {
    const c = node(heap, v);
    return c !== undefined && ['list', 'set', 'tuple', 'deque', 'dict'].includes(c.kind);
  });
}

function collectMembers(vars: Var[], heap: Heap, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const v of vars) {
    if (!re.test(v.name)) continue;
    const n = node(heap, v.value);
    if (!n) continue;
    const items: Encoded[] = n.items ?? (n.entries ? n.entries.map((e) => e[0]) : []);
    for (const it of items) {
      // heap entries like (dist, node) tuples: use the last element.
      const inner = node(heap, it);
      if (inner?.kind === 'tuple' && inner.items?.length) {
        const k = key(inner.items[inner.items.length - 1], heap);
        if (k !== undefined) out.add(k);
      } else {
        const k = key(it, heap);
        if (k !== undefined) out.add(k);
      }
    }
  }
  return out;
}

export function renderGraph(name: string, g: HeapNode, heap: Heap, vars: Var[]): SVGSVGElement {
  const nodes: string[] = [];
  const add = (k: string | undefined) => {
    if (k !== undefined && !nodes.includes(k)) nodes.push(k);
  };
  const edges: Edge[] = [];
  for (const [kEnc, vEnc] of g.entries ?? []) {
    const from = key(kEnc, heap);
    add(from);
    const nb = node(heap, vEnc);
    if (!nb || from === undefined) continue;
    if (nb.kind === 'dict') {
      for (const [tk, w] of nb.entries ?? []) {
        const to = key(tk, heap);
        add(to);
        if (to !== undefined) edges.push({ from, to, weight: shortScalar(w, heap) });
      }
    } else {
      for (const it of nb.items ?? []) {
        // (neighbor, weight) tuples are common for weighted graphs.
        const t = node(heap, it);
        if (t?.kind === 'tuple' && t.items && t.items.length === 2 && !isRef(t.items[0])) {
          const to = key(t.items[0], heap);
          add(to);
          if (to !== undefined) edges.push({ from, to, weight: shortScalar(t.items[1], heap) });
        } else {
          const to = key(it, heap);
          add(to);
          if (to !== undefined) edges.push({ from, to });
        }
      }
    }
  }
  const visited = collectMembers(vars, heap, VISITED);
  const frontier = collectMembers(vars, heap, FRONTIER);
  const onPath = collectMembers(vars, heap, PATH);
  const pathPairs = new Set<string>();
  for (const v of vars) {
    if (!PATH.test(v.name)) continue;
    const seq = (node(heap, v.value)?.items ?? []).map((it) => key(it, heap));
    for (let i = 0; i + 1 < seq.length; i++) pathPairs.add(`${seq[i]}\u0000${seq[i + 1]}`);
  }
  const current = new Set<string>();
  for (const v of vars) if (CURRENT.test(v.name) && !isRef(v.value)) current.add(shortScalar(v.value, heap));
  const distVar = vars.find((v) => DIST.test(v.name) && node(heap, v.value)?.kind === 'dict');
  const dist = new Map<string, string>();
  if (distVar) for (const [k, val] of node(heap, distVar.value)!.entries ?? []) dist.set(key(k, heap) ?? '', shortScalar(val, heap));

  const undirected = new Set<string>();
  const edgeSet = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
  for (const e of edges) if (edgeSet.has(`${e.to}\u0000${e.from}`)) undirected.add([e.from, e.to].sort().join('\u0000'));

  const n = nodes.length;
  const R = n <= 1 ? 0 : Math.max(70, Math.min(220, n * 18));
  const width = 2 * R + 120;
  const height = 2 * R + 90;
  const cx = width / 2;
  const cy = height / 2;
  const pos = new Map<string, [number, number]>();
  nodes.forEach((k, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    pos.set(k, [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  });
  const svg = svgRoot(width, height, `graph ${name} with ${n} nodes`);
  svg.appendChild(
    s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow' }))),
  );
  const drawn = new Set<string>();
  const NR = 16;
  for (const e of edges) {
    const und = undirected.has([e.from, e.to].sort().join('\u0000'));
    const id = und ? [e.from, e.to].sort().join('\u0000') : `${e.from}\u0000${e.to}`;
    if (drawn.has(id)) continue;
    drawn.add(id);
    const [x1, y1] = pos.get(e.from)!;
    const [x2, y2] = pos.get(e.to)!;
    if (e.from === e.to) {
      svg.appendChild(s('circle', { cx: x1, cy: y1 - NR - 8, r: 9, class: 'edge self' }));
      continue;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const sx = x1 + (dx / len) * NR;
    const sy = y1 + (dy / len) * NR;
    const ex = x2 - (dx / len) * (NR + 2);
    const ey = y2 - (dy / len) * (NR + 2);
    const hot = pathPairs.has(`${e.from}\u0000${e.to}`) || (und && pathPairs.has(`${e.to}\u0000${e.from}`));
    svg.appendChild(s('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: `edge ${hot ? 'hot' : ''}`, 'marker-end': und ? undefined : 'url(#arrow)' }));
    if (e.weight !== undefined) {
      svg.appendChild(s('text', { x: (sx + ex) / 2, y: (sy + ey) / 2 - 4, 'text-anchor': 'middle', class: 'edge-label' }, e.weight));
    }
  }
  for (const k of nodes) {
    const [x, y] = pos.get(k)!;
    const cls = ['gnode', visited.has(k) ? 'visited' : '', frontier.has(k) ? 'frontier' : '', current.has(k) ? 'current' : '', onPath.has(k) ? 'onpath' : ''].join(' ');
    svg.appendChild(s('circle', { cx: x, cy: y, r: NR, class: cls }, s('title', {}, k)));
    svg.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'gnode-text' }, k.length > 4 ? k.slice(0, 4) + '…' : k));
    const d = dist.get(k);
    if (d !== undefined) svg.appendChild(s('text', { x, y: y + NR + 13, 'text-anchor': 'middle', class: 'dist-text' }, `${distVar!.name}=${d}`));
  }
  return svg;
}
