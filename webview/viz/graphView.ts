/**
 * Graph ("đồ thị") from an adjacency dict ({u: [v, ...]}, {u: {v: w}}) or
 * an edge list. Vertices in `visited`/`seen` sets are filled, those in
 * `queue`/`stack` outlined; the current vertex (u, node, cur) is filled
 * and the neighbour being looked at (v, nb, nei) ringed, with the edge
 * between them drawn as the current edge.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, isRef } from '../format';
import { Var, node, shortScalar } from './common';
import { GraphLayout, GraphModel, NODE_R, pairId, vertexKey } from './graphModel';
import { CURRENT, DIST, FRONTIER, NEIGHBOR, PATH, VISITED } from './names';

export { isAdjacency } from './graphModel';

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
      const k = inner?.kind === 'tuple' && inner.items?.length ? vertexKey(inner.items[inner.items.length - 1], heap) : vertexKey(it, heap);
      if (k !== undefined) out.add(k);
    }
  }
  return out;
}

/** Scalar locals naming vertices: the current one(s) and the neighbour(s) being examined. */
export function currentVertices(vars: Var[], heap: Heap, vertices: Set<string>): { cur: Set<string>; nb: Set<string> } {
  const cur = new Set<string>();
  const nb = new Set<string>();
  const nbVars = vars.filter((v) => NEIGHBOR.test(v.name) && !isRef(v.value) && vertices.has(shortScalar(v.value, heap)));
  // `for v, w in graph[u]`: with a neighbour `v` present, `w` is the weight.
  const hasV = nbVars.some((v) => v.name !== 'w');
  for (const v of vars) {
    if (isRef(v.value)) continue;
    const k = shortScalar(v.value, heap);
    if (!vertices.has(k)) continue;
    if (CURRENT.test(v.name)) cur.add(k);
  }
  for (const v of nbVars) if (!(hasV && v.name === 'w')) nb.add(shortScalar(v.value, heap));
  for (const k of cur) nb.delete(k);
  return { cur, nb };
}

export function renderGraph(name: string, m: GraphModel, layout: GraphLayout, heap: Heap, vars: Var[]): SVGSVGElement {
  const visited = collectMembers(vars, heap, VISITED);
  const frontier = collectMembers(vars, heap, FRONTIER);
  const onPath = collectMembers(vars, heap, PATH);
  const pathPairs = new Set<string>();
  for (const v of vars) {
    if (!PATH.test(v.name)) continue;
    const seq = (node(heap, v.value)?.items ?? []).map((it) => vertexKey(it, heap));
    for (let i = 0; i + 1 < seq.length; i++) pathPairs.add(`${seq[i]}\u0000${seq[i + 1]}`);
  }
  const { cur, nb } = currentVertices(vars, heap, new Set(m.nodes));
  const distVar = vars.find((v) => DIST.test(v.name) && node(heap, v.value)?.kind === 'dict');
  const dist = new Map<string, string>();
  if (distVar) for (const [k, val] of node(heap, distVar.value)!.entries ?? []) dist.set(vertexKey(k, heap) ?? '', shortScalar(val, heap));

  const has = new Set(m.edges.map((e) => `${e.from}\u0000${e.to}`));
  const isUndirected = (a: string, b: string) => !m.directed || (has.has(`${a}\u0000${b}`) && has.has(`${b}\u0000${a}`));

  const { pos, width, height } = layout;
  const svg = svgRoot(width, height, `graph ${name} with ${m.nodes.length} nodes`);
  svg.appendChild(
    s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '10', markerHeight: '10', markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow' }))),
  );
  const drawn = new Set<string>();
  const NR = NODE_R;
  for (const e of m.edges) {
    const und = isUndirected(e.from, e.to);
    const id = und ? pairId(e.from, e.to) : `${e.from}\u0000${e.to}`;
    if (drawn.has(id)) continue;
    drawn.add(id);
    const p1 = pos.get(e.from);
    const p2 = pos.get(e.to);
    if (!p1 || !p2) continue;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    if (e.from === e.to) {
      svg.appendChild(s('circle', { cx: x1, cy: y1 - NR - 8, r: 9, class: 'edge self', 'data-anim-edge': true }));
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
    const live = (cur.has(e.from) && nb.has(e.to)) || (und && cur.has(e.to) && nb.has(e.from));
    svg.appendChild(s('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: `edge ${hot ? 'hot' : ''} ${live ? 'cur-edge' : ''}`, 'marker-end': und ? undefined : 'url(#arrow)', 'data-anim-edge': true }));
    if (e.weight !== undefined) {
      // Beside the edge, not on it: offset along the normal, to the upper side.
      let nx = -dy / len;
      let ny = dx / len;
      if (ny > 0 || (ny === 0 && nx < 0)) [nx, ny] = [-nx, -ny];
      svg.appendChild(s('text', { x: (sx + ex) / 2 + nx * 8, y: (sy + ey) / 2 + ny * 8 + 4, 'text-anchor': 'middle', class: 'edge-label', 'data-anim-edge': true }, e.weight));
    }
  }
  for (const k of m.nodes) {
    const p = pos.get(k);
    if (!p) continue;
    const [x, y] = p;
    const cls = ['gnode', visited.has(k) ? 'visited' : '', frontier.has(k) ? 'frontier' : '', cur.has(k) ? 'current' : '', nb.has(k) ? 'neighbor' : '', onPath.has(k) ? 'onpath' : ''].join(' ');
    const g = s('g', { 'data-anim': `n:${k}` });
    g.appendChild(s('circle', { cx: x, cy: y, r: NR, class: cls }, s('title', {}, k)));
    g.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'gnode-text' }, k.length > 4 ? k.slice(0, 4) + '…' : k));
    const d = dist.get(k);
    // Layered drawings send edges downwards: the label goes to the right there.
    if (d !== undefined) {
      const label = `${distVar!.name}=${d}`;
      g.appendChild(
        layout.kind === 'circle'
          ? s('text', { x, y: y + NR + 13, 'text-anchor': 'middle', class: 'dist-text' }, label)
          : s('text', { x: x + NR + 3, y: y - 6, class: 'dist-text' }, label),
      );
    }
    svg.appendChild(g);
  }
  return svg;
}
