/**
 * Graph ("đồ thị") from an adjacency dict ({u: [v, ...]}, {u: {v: w}}), a
 * list of neighbour lists, or an edge list. Vertices in `visited`/`seen`
 * sets are filled, those in `queue`/`stack` outlined; the current vertex
 * (u, node, cur) is filled and the neighbour being looked at (v, nb, nei)
 * ringed, with the edge between them drawn as the current edge.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, isRef } from '../format';
import { Var, node, shortScalar } from './common';
import { GraphLayout, GraphModel, NODE_R, pairId, vertexKey, vertexRx, vertexText } from './graphModel';
import { CURRENT, DIST, FRONTIER, NEIGHBOR, PATH, VISITED } from './names';

export { isAdjacency } from './graphModel';

/** data-anim key of a vertex; edges list their endpoints' keys separated by spaces, so a key has none. */
export const vertexAnimKey = (k: string): string => `n:${k.replace(/\s/g, '␣')}`;

function collectMembers(vars: Var[], heap: Heap, re: RegExp, vertices: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of vars) {
    if (!re.test(v.name)) continue;
    const n = node(heap, v.value);
    if (!n) continue;
    const items: Encoded[] = n.items ?? (n.entries ? n.entries.map((e) => e[0]) : []);
    // visited = [False] * n, indexed by vertex: the vertices whose flag is set.
    if (n.kind === 'list' && items.length && items.every((it) => typeof it === 'boolean')) {
      items.forEach((it, i) => it && out.add(String(i)));
      continue;
    }
    for (const it of items) {
      // A (r, c) cell is a vertex itself; a (dist, node) heap entry names its last item.
      const own = vertexKey(it, heap);
      const inner = node(heap, it);
      const k = own !== undefined && vertices.has(own) ? own : inner?.kind === 'tuple' && inner.items?.length ? vertexKey(inner.items[inner.items.length - 1], heap) : own;
      if (k !== undefined) out.add(k);
    }
  }
  return out;
}

/**
 * Scalar locals naming vertices: the current one(s) and the neighbour(s)
 * being examined. `live` drops names left over from a loop that is over,
 * so the last u and v of a BFS are not drawn as being processed.
 */
export function currentVertices(vars: Var[], heap: Heap, vertices: Set<string>, live: (v: Var) => boolean = () => true): { cur: Set<string>; nb: Set<string> } {
  const cur = new Set<string>();
  const nb = new Set<string>();
  const vs = vars.filter((v) => !isRef(v.value) && vertices.has(vertexKey(v.value, heap) ?? '') && live(v));
  const nbVars = vs.filter((v) => NEIGHBOR.test(v.name));
  // `for v, w in graph[u]`: with a neighbour `v` present, `w` is the weight.
  const hasV = nbVars.some((v) => v.name !== 'w');
  for (const v of vs) if (CURRENT.test(v.name)) cur.add(vertexKey(v.value, heap)!);
  for (const v of nbVars) if (!(hasV && v.name === 'w')) nb.add(vertexKey(v.value, heap)!);
  for (const k of cur) nb.delete(k);
  return { cur, nb };
}

/** Where the line towards (dx, dy) leaves a vertex drawn with half-width rx. */
function rim(rx: number, ux: number, uy: number): number {
  return 1 / Math.sqrt((ux / rx) ** 2 + (uy / NODE_R) ** 2);
}

interface Drawn {
  from: string;
  to: string;
  weight?: string;
  und: boolean;
}

export function renderGraph(name: string, m: GraphModel, layout: GraphLayout, heap: Heap, vars: Var[], live?: (v: Var) => boolean): SVGSVGElement {
  const vertices = new Set(m.nodes);
  const visited = collectMembers(vars, heap, VISITED, vertices);
  const frontier = collectMembers(vars, heap, FRONTIER, vertices);
  const onPath = collectMembers(vars, heap, PATH, vertices);
  const pathPairs = new Set<string>();
  for (const v of vars) {
    if (!PATH.test(v.name)) continue;
    const seq = (node(heap, v.value)?.items ?? []).map((it) => vertexKey(it, heap));
    for (let i = 0; i + 1 < seq.length; i++) pathPairs.add(`${seq[i]}\u0000${seq[i + 1]}`);
  }
  const { cur, nb } = currentVertices(vars, heap, vertices, live);
  // On the loop header `for v in adj[u]` the old v is still bound: a
  // "neighbour" that is not adjacent to the current vertex is not one.
  if (cur.size) {
    const adjacent = new Set(m.edges.flatMap((e) => [`${e.from}\u0000${e.to}`, `${e.to}\u0000${e.from}`]));
    for (const k of [...nb]) if (![...cur].some((c) => adjacent.has(`${c}\u0000${k}`))) nb.delete(k);
  }
  const distVar = vars.find((v) => DIST.test(v.name) && node(heap, v.value)?.kind === 'dict');
  const dist = new Map<string, string>();
  if (distVar) for (const [k, val] of node(heap, distVar.value)!.entries ?? []) dist.set(vertexKey(k, heap) ?? '', shortScalar(val, heap));

  // One line per edge, except that a -> b and b -> a with the same weight
  // are one undirected line. Edges that differ in weight are never merged
  // (Bellman-Ford's 1 -> 2 (6) and 2 -> 1 (1)): they are drawn side by side.
  const weight = new Map<string, string | undefined>();
  for (const e of m.edges) if (!weight.has(`${e.from}\u0000${e.to}`)) weight.set(`${e.from}\u0000${e.to}`, e.weight);
  const drawnIds = new Set<string>();
  const drawn: Drawn[] = [];
  for (const e of m.edges) {
    const back = `${e.to}\u0000${e.from}`;
    const und = !m.directed || (weight.has(back) && weight.get(back) === e.weight);
    const id = `${und ? pairId(e.from, e.to) : `${e.from}\u0000${e.to}`}\u0000${e.weight ?? ''}`;
    if (drawnIds.has(id)) continue;
    drawnIds.add(id);
    drawn.push({ from: e.from, to: e.to, weight: e.weight, und });
  }
  const perPair = new Map<string, number>();
  for (const d of drawn) perPair.set(pairId(d.from, d.to), (perPair.get(pairId(d.from, d.to)) ?? 0) + 1);
  const slot = new Map<string, number>();

  const { pos, width, height } = layout;
  const svg = svgRoot(width, height, `graph ${name} with ${m.nodes.length} nodes`);
  svg.appendChild(
    s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '10', markerHeight: '10', markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow' }))),
  );
  const NR = NODE_R;
  for (const e of drawn) {
    const p1 = pos.get(e.from);
    const p2 = pos.get(e.to);
    if (!p1 || !p2) continue;
    const ends = `${vertexAnimKey(e.from)} ${vertexAnimKey(e.to)}`;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    if (e.from === e.to) {
      svg.appendChild(s('circle', { cx: x1, cy: y1 - NR - 8, r: 9, class: 'edge self', 'data-anim-edge': ends }));
      continue;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [dx / len, dy / len];
    // Side by side: offsets along the normal of the pair's canonical direction.
    const pid = pairId(e.from, e.to);
    const count = perPair.get(pid) ?? 1;
    const k = slot.get(pid) ?? 0;
    slot.set(pid, k + 1);
    const sign = e.from < e.to ? 1 : -1;
    const off = (k - (count - 1) / 2) * 9 * sign;
    const [ox, oy] = [-uy * off, ux * off];
    const r1 = rim(vertexRx(e.from), ux, uy);
    const r2 = rim(vertexRx(e.to), ux, uy) + 2;
    const sx = x1 + ux * r1 + ox;
    const sy = y1 + uy * r1 + oy;
    const ex = x2 - ux * r2 + ox;
    const ey = y2 - uy * r2 + oy;
    const und = e.und;
    const hot = pathPairs.has(`${e.from}\u0000${e.to}`) || (und && pathPairs.has(`${e.to}\u0000${e.from}`));
    const liveEdge = (cur.has(e.from) && nb.has(e.to)) || (und && cur.has(e.to) && nb.has(e.from));
    svg.appendChild(s('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: `edge ${hot ? 'hot' : ''} ${liveEdge ? 'cur-edge' : ''}`, 'marker-end': und ? undefined : 'url(#arrow)', 'data-anim-edge': ends }));
    if (e.weight !== undefined) {
      // Beside the edge, not on it: offset along the normal, to the upper
      // side; side-by-side edges keep their label on their own side.
      let nx = -uy;
      let ny = ux;
      if (count > 1 && off !== 0) [nx, ny] = off > 0 ? [nx, ny] : [-nx, -ny];
      else if (ny > 0 || (ny === 0 && nx < 0)) [nx, ny] = [-nx, -ny];
      svg.appendChild(s('text', { x: (sx + ex) / 2 + nx * 8, y: (sy + ey) / 2 + ny * 8 + 4, 'text-anchor': 'middle', class: `edge-label ${liveEdge ? 'cur-edge' : ''}`, 'data-anim-edge': ends }, e.weight));
    }
  }
  for (const k of m.nodes) {
    const p = pos.get(k);
    if (!p) continue;
    const [x, y] = p;
    const cls = ['gnode', visited.has(k) ? 'visited' : '', frontier.has(k) ? 'frontier' : '', cur.has(k) ? 'current' : '', nb.has(k) ? 'neighbor' : '', onPath.has(k) ? 'onpath' : ''].join(' ');
    const rx = vertexRx(k);
    const g = s('g', { 'data-anim': vertexAnimKey(k) });
    const title = s('title', {}, k);
    g.appendChild(rx > NR ? s('ellipse', { cx: x, cy: y, rx, ry: NR, class: cls }, title) : s('circle', { cx: x, cy: y, r: NR, class: cls }, title));
    g.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'gnode-text' }, vertexText(k)));
    const d = dist.get(k);
    // Layered drawings send edges downwards: the label goes to the right there.
    if (d !== undefined) {
      const label = `${distVar!.name}=${d}`;
      g.appendChild(
        layout.kind === 'circle'
          ? s('text', { x, y: y + NR + 13, 'text-anchor': 'middle', class: 'dist-text' }, label)
          : s('text', { x: x + rx + 3, y: y - 6, class: 'dist-text' }, label),
      );
    }
    svg.appendChild(g);
  }
  return svg;
}
