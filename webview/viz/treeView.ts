/**
 * Trees (objects, tries, nested-dict tries, level-order lists, union-find
 * forests), linked lists, and array-backed binary heaps.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, HeapNode, isRef } from '../format';
import { POINTER_COLORS, Var, nodeLabel, refLabels, shortScalar } from './common';
import { keysFor } from './arrayView';
import { TNode, layoutTrees, objectTree } from './treeModel';

export { isListNode, isTreeNode } from './treeModel';

const NR = 17;
const DX = 44;
const DY = 58;

export interface TreeDrawOpts {
  title: string;
  /** Pointer names by node key (n:<ref> / n:<index>). */
  labels: Map<string, string[]>;
  /** Union-find: arrows point from a child up to its parent, roots are marked. */
  toParent?: boolean;
  /** Show the array index under each node (level-order lists). */
  showIndex?: boolean;
}

function short(label: string): { text: string; cls: string } {
  if (label.length <= 3) return { text: label, cls: '' };
  return { text: label.length > 6 ? label.slice(0, 5) + '…' : label, cls: 'tiny' };
}

export function renderTreeModel(roots: TNode[], o: TreeDrawOpts): SVGSVGElement {
  const { placed, cols, depth } = layoutTrees(roots);
  const width = cols * DX + 40;
  const height = (depth + 1) * DY + (o.showIndex ? 48 : 40);
  const svg = svgRoot(width, height, o.title);
  if (!placed.length) return svg;
  if (o.toParent) {
    svg.appendChild(
      s('defs', {}, s('marker', { id: 'tarrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow' }))),
    );
  }
  const X = (x: number) => 20 + x * DX + DX / 2;
  const Y = (d: number) => 26 + d * DY;
  const edges: SVGElement[] = [];
  const nodes: SVGElement[] = [];
  let colorIdx = 0;
  let labelRight = 0;
  for (const p of placed) {
    const x = X(p.x);
    const y = Y(p.depth);
    if (p.parent) {
      const px = X(p.parent.x);
      const py = Y(p.parent.depth);
      const dx = x - px;
      const dy = y - py;
      const len = Math.hypot(dx, dy) || 1;
      const [ax, ay, bx, by] = [px + (dx / len) * NR, py + (dy / len) * NR, x - (dx / len) * NR, y - (dy / len) * NR];
      edges.push(
        o.toParent
          ? s('line', { x1: bx, y1: by, x2: ax, y2: ay, class: 'edge', 'marker-end': 'url(#tarrow)', 'data-anim-edge': true })
          : s('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'edge', 'data-anim-edge': true }),
      );
      if (p.node.edge !== undefined) {
        // The character sits beside the edge's midpoint, on the outer side.
        const side = dx < 0 ? -1 : 1;
        edges.push(s('text', { x: (ax + bx) / 2 + side * 7, y: (ay + by) / 2 + 4, 'text-anchor': side < 0 ? 'end' : 'start', class: 'edge-key', 'data-anim-edge': true }, p.node.edge));
      }
    }
    const names = o.labels.get(p.node.key);
    const root = o.toParent && !p.parent;
    const g = s('g', { 'data-anim': p.node.key });
    g.appendChild(s('circle', { cx: x, cy: y, r: NR, class: `tnode ${names ? 'pointed' : ''} ${root ? 'root' : ''}` }, s('title', {}, p.node.label || (p.node.edge ?? ''))));
    if (p.node.end) g.appendChild(s('circle', { cx: x, cy: y, r: NR - 4, class: 'tnode-end' }));
    if (p.node.label) {
      const t = short(p.node.label);
      g.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: `gnode-text ${t.cls}` }, t.text));
    }
    if (o.showIndex && p.node.index !== undefined) g.appendChild(s('text', { x, y: y + NR + 11, 'text-anchor': 'middle', class: 'index-text' }, String(p.node.index)));
    nodes.push(g);
    if (names) {
      const color = POINTER_COLORS[colorIdx++ % POINTER_COLORS.length];
      const text = names.join(', ');
      nodes.push(s('g', { 'data-anim': `p:${names.join(',')}` }, s('text', { x: x + NR + 2, y: y - NR + 2, class: `ptr-text ${color}` }, text)));
      labelRight = Math.max(labelRight, x + NR + 4 + text.length * 7);
    }
  }
  edges.forEach((e) => svg.appendChild(e));
  nodes.forEach((e) => svg.appendChild(e));
  // Pointer labels of the rightmost nodes would be cut off at the edge.
  if (labelRight > width) {
    const w = Math.ceil(labelRight);
    svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
    svg.setAttribute('width', String(w));
  }
  return svg;
}

/** Variables pointing at tree nodes, keyed like TNode.key. */
export function refKeyLabels(vars: Var[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [ref, names] of refLabels(vars)) out.set(`n:${ref}`, names);
  return out;
}

export function renderTree(rootRef: number, heap: Heap, vars: Var[], title: string): SVGSVGElement {
  const root = objectTree(rootRef, heap);
  return renderTreeModel(root ? [root] : [], { title, labels: refKeyLabels(vars) });
}

function field(n: HeapNode, name: string): Encoded | undefined {
  return n.fields?.find(([k]) => k === name)?.[1];
}

export function renderLinkedList(headRef: number, heap: Heap, vars: Var[], title: string): SVGSVGElement {
  const order: number[] = [];
  const index = new Map<number, number>();
  let cur: number | undefined = headRef;
  let cycleTo: number | undefined;
  while (cur !== undefined && order.length < 60) {
    if (index.has(cur)) {
      cycleTo = cur;
      break;
    }
    const n: HeapNode | null | undefined = heap[String(cur)];
    if (!n || n.kind !== 'object') break;
    index.set(cur, order.length);
    order.push(cur);
    const nx = field(n, 'next');
    cur = isRef(nx) ? nx.ref : undefined;
  }
  const boxW = 54;
  const gap = 34;
  const width = order.length * (boxW + gap) + 60;
  const height = cycleTo !== undefined ? 120 : 92;
  const svg = svgRoot(width, height, title);
  svg.appendChild(
    s('defs', {}, s('marker', { id: 'larrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow' }))),
  );
  const labels = refLabels(vars);
  const y = 40;
  let colorIdx = 0;
  order.forEach((ref, i) => {
    const n = heap[String(ref)]!;
    const x = 10 + i * (boxW + gap);
    const names = labels.get(ref);
    svg.appendChild(
      s('g', { 'data-anim': `n:${ref}` },
        s('rect', { x, y, width: boxW, height: 30, rx: 4, class: `lnode ${names ? 'pointed' : ''}` }),
        s('text', { x: x + (boxW - 14) / 2, y: y + 19, 'text-anchor': 'middle', class: 'gnode-text' }, nodeLabel(n, heap)),
        s('line', { x1: x + boxW - 14, x2: x + boxW - 14, y1: y, y2: y + 30, class: 'divider' })),
    );
    if (names) {
      const color = POINTER_COLORS[colorIdx++ % POINTER_COLORS.length];
      svg.appendChild(
        s('g', { 'data-anim': `p:${names.join(',')}` },
          s('text', { x: x + boxW / 2, y: y - 10, 'text-anchor': 'middle', class: `ptr-text ${color}` }, names.join(', ')),
          s('line', { x1: x + boxW / 2, x2: x + boxW / 2, y1: y - 7, y2: y - 1, class: `ptr-line ${color}` })),
      );
    }
    const next = field(n, 'next');
    const sx = x + boxW - 7;
    if (i + 1 < order.length && isRef(next) && next.ref === order[i + 1]) {
      svg.appendChild(s('line', { x1: sx, y1: y + 15, x2: x + boxW + gap - 2, y2: y + 15, class: 'edge', 'marker-end': 'url(#larrow)', 'data-anim-edge': true }));
    } else if (cycleTo !== undefined && isRef(next) && next.ref === cycleTo) {
      const tx = 10 + index.get(cycleTo)! * (boxW + gap) + boxW / 2;
      svg.appendChild(s('path', { d: `M${sx},${y + 30} V${y + 60} H${tx} V${y + 32}`, class: 'edge hot', fill: 'none', 'marker-end': 'url(#larrow)', 'data-anim-edge': true }));
      svg.appendChild(s('text', { x: (sx + tx) / 2, y: y + 74, 'text-anchor': 'middle', class: 'muted-text', 'data-anim-edge': true }, 'cycle'));
    } else {
      svg.appendChild(s('text', { x: sx + 8, y: y + 19, class: 'muted-text', 'data-anim-edge': true }, next === null || next === undefined ? '∅' : '…'));
    }
  });
  return svg;
}

/** Binary heap drawn as a tree from its array (index i -> children 2i+1, 2i+2). */
export function renderHeapArray(items: Encoded[], title: string, heap?: Heap, id = title): SVGSVGElement {
  const n = Math.min(items.length, 63);
  const depth = Math.floor(Math.log2(Math.max(1, n))) + 1;
  const width = Math.max(200, Math.pow(2, depth - 1) * 46 + 20);
  const height = depth * 56 + 20;
  const svg = svgRoot(width, height, title);
  const keys = keysFor(`${id}\u0000heap`, items.slice(0, n));
  const posOf = (i: number): [number, number] => {
    const d = Math.floor(Math.log2(i + 1));
    const k = i + 1 - Math.pow(2, d);
    const slots = Math.pow(2, d);
    return [((k + 0.5) / slots) * width, 26 + d * 56];
  };
  for (let i = 1; i < n; i++) {
    const [x1, y1] = posOf(Math.floor((i - 1) / 2));
    const [x2, y2] = posOf(i);
    svg.appendChild(s('line', { x1, y1: y1 + NR, x2, y2: y2 - NR, class: 'edge', 'data-anim-edge': true }));
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = posOf(i);
    const label = shortScalar(items[i], heap);
    svg.appendChild(
      s('g', { 'data-anim': keys[i] },
        s('circle', { cx: x, cy: y, r: NR, class: i === 0 ? 'tnode pointed' : 'tnode' }),
        s('text', { x, y: y + 4, 'text-anchor': 'middle', class: `gnode-text ${label.length > 3 ? 'tiny' : ''}` }, label),
        s('text', { x, y: y + NR + 11, 'text-anchor': 'middle', class: 'index-text' }, String(i))),
    );
  }
  return svg;
}
