/**
 * Trees and linked lists built from user objects (fields left/right,
 * children, next), plus array-backed binary heaps.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, HeapNode, isRef } from '../format';
import { POINTER_COLORS, Var, nodeLabel, refLabels, shortScalar } from './common';

const NR = 17;

function field(n: HeapNode, name: string): Encoded | undefined {
  return n.fields?.find(([k]) => k === name)?.[1];
}

export function isTreeNode(n: HeapNode | undefined): boolean {
  if (!n || n.kind !== 'object') return false;
  const names = new Set((n.fields ?? []).map(([k]) => k));
  return names.has('left') || names.has('right') || names.has('children');
}

export function isListNode(n: HeapNode | undefined): boolean {
  if (!n || n.kind !== 'object') return false;
  return (n.fields ?? []).some(([k]) => k === 'next');
}

interface Laid {
  id: number;
  label: string;
  x: number;
  depth: number;
  children: Laid[];
}

function childRefs(n: HeapNode, heap: Heap): Array<Encoded | null> {
  if ((n.fields ?? []).some(([k]) => k === 'left' || k === 'right')) {
    return [field(n, 'left') ?? null, field(n, 'right') ?? null];
  }
  const ch = field(n, 'children');
  const list = isRef(ch) ? heap[String(ch.ref)] : undefined;
  return list?.items ?? [];
}

export function renderTree(rootRef: number, heap: Heap, vars: Var[], title: string): SVGSVGElement {
  let nextX = 0;
  const seen = new Set<number>();
  let maxDepth = 0;
  const binary = new Map<number, boolean>();
  function lay(ref: number, depth: number): Laid | undefined {
    if (seen.has(ref) || depth > 40) return undefined;
    const n = heap[String(ref)];
    if (!n || n.kind !== 'object') return undefined;
    seen.add(ref);
    maxDepth = Math.max(maxDepth, depth);
    const kids = childRefs(n, heap);
    const isBinary = (n.fields ?? []).some(([k]) => k === 'left' || k === 'right');
    binary.set(ref, isBinary);
    const laid: Laid = { id: ref, label: nodeLabel(n, heap), x: 0, depth, children: [] };
    if (isBinary) {
      const [l, r] = kids;
      const L = isRef(l) ? lay(l.ref, depth + 1) : undefined;
      laid.x = L ? nextX++ : nextX++;
      const Rn = isRef(r) ? lay(r.ref, depth + 1) : undefined;
      // In-order x keeps BST order left-to-right.
      if (L) laid.children.push(L);
      if (Rn) laid.children.push(Rn);
    } else {
      for (const c of kids) if (isRef(c)) {
        const C = lay(c.ref, depth + 1);
        if (C) laid.children.push(C);
      }
      laid.x = laid.children.length ? (laid.children[0].x + laid.children[laid.children.length - 1].x) / 2 : nextX++;
    }
    return laid;
  }
  const root = lay(rootRef, 0);
  const cols = Math.max(1, nextX);
  const dx = 44;
  const dy = 58;
  const width = cols * dx + 40;
  const height = (maxDepth + 1) * dy + 40;
  const svg = svgRoot(width, height, title);
  if (!root) return svg;
  const labels = refLabels(vars);
  const X = (l: Laid) => 20 + l.x * dx + dx / 2;
  const Y = (l: Laid) => 26 + l.depth * dy;
  const edges: SVGElement[] = [];
  const nodes: SVGElement[] = [];
  let colorIdx = 0;
  const walk = (l: Laid) => {
    for (const c of l.children) {
      edges.push(s('line', { x1: X(l), y1: Y(l) + NR, x2: X(c), y2: Y(c) - NR, class: 'edge' }));
      walk(c);
    }
    const names = labels.get(l.id);
    nodes.push(s('circle', { cx: X(l), cy: Y(l), r: NR, class: `tnode ${names ? 'pointed' : ''}` }));
    nodes.push(s('text', { x: X(l), y: Y(l) + 4, 'text-anchor': 'middle', class: 'gnode-text' }, l.label));
    if (names) {
      const color = POINTER_COLORS[colorIdx++ % POINTER_COLORS.length];
      nodes.push(s('text', { x: X(l) + NR + 2, y: Y(l) - NR + 2, class: `ptr-text ${color}` }, names.join(', ')));
    }
  };
  walk(root);
  edges.forEach((e) => svg.appendChild(e));
  nodes.forEach((e) => svg.appendChild(e));
  return svg;
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
    svg.appendChild(s('rect', { x, y, width: boxW, height: 30, rx: 4, class: `lnode ${names ? 'pointed' : ''}` }));
    svg.appendChild(s('text', { x: x + (boxW - 14) / 2, y: y + 19, 'text-anchor': 'middle', class: 'gnode-text' }, nodeLabel(n, heap)));
    svg.appendChild(s('line', { x1: x + boxW - 14, x2: x + boxW - 14, y1: y, y2: y + 30, class: 'divider' }));
    if (names) {
      const color = POINTER_COLORS[colorIdx++ % POINTER_COLORS.length];
      svg.appendChild(s('text', { x: x + boxW / 2, y: y - 10, 'text-anchor': 'middle', class: `ptr-text ${color}` }, names.join(', ')));
      svg.appendChild(s('line', { x1: x + boxW / 2, x2: x + boxW / 2, y1: y - 7, y2: y - 1, class: `ptr-line ${color}` }));
    }
    const next = field(n, 'next');
    const sx = x + boxW - 7;
    if (i + 1 < order.length && isRef(next) && next.ref === order[i + 1]) {
      svg.appendChild(s('line', { x1: sx, y1: y + 15, x2: x + boxW + gap - 2, y2: y + 15, class: 'edge', 'marker-end': 'url(#larrow)' }));
    } else if (cycleTo !== undefined && isRef(next) && next.ref === cycleTo) {
      const tx = 10 + index.get(cycleTo)! * (boxW + gap) + boxW / 2;
      svg.appendChild(s('path', { d: `M${sx},${y + 30} V${y + 60} H${tx} V${y + 32}`, class: 'edge hot', fill: 'none', 'marker-end': 'url(#larrow)' }));
      svg.appendChild(s('text', { x: (sx + tx) / 2, y: y + 74, 'text-anchor': 'middle', class: 'muted-text' }, 'cycle'));
    } else {
      svg.appendChild(s('text', { x: sx + 8, y: y + 19, class: 'muted-text' }, next === null || next === undefined ? '∅' : '…'));
    }
  });
  return svg;
}

/** Binary heap drawn as a tree from its array (index i -> children 2i+1, 2i+2). */
export function renderHeapArray(items: Encoded[], title: string): SVGSVGElement {
  const n = Math.min(items.length, 63);
  const depth = Math.floor(Math.log2(Math.max(1, n))) + 1;
  const width = Math.max(200, Math.pow(2, depth - 1) * 46 + 20);
  const height = depth * 56 + 20;
  const svg = svgRoot(width, height, title);
  const posOf = (i: number): [number, number] => {
    const d = Math.floor(Math.log2(i + 1));
    const k = i + 1 - Math.pow(2, d);
    const slots = Math.pow(2, d);
    return [((k + 0.5) / slots) * width, 26 + d * 56];
  };
  for (let i = 1; i < n; i++) {
    const [x1, y1] = posOf(Math.floor((i - 1) / 2));
    const [x2, y2] = posOf(i);
    svg.appendChild(s('line', { x1, y1: y1 + NR, x2, y2: y2 - NR, class: 'edge' }));
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = posOf(i);
    svg.appendChild(s('circle', { cx: x, cy: y, r: NR, class: i === 0 ? 'tnode pointed' : 'tnode' }));
    svg.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'gnode-text' }, shortScalar(items[i])));
    svg.appendChild(s('text', { x, y: y + NR + 11, 'text-anchor': 'middle', class: 'index-text' }, String(i)));
  }
  return svg;
}
