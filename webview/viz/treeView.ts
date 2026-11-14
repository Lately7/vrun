/**
 * Trees (objects, tries, nested-dict tries, level-order lists, union-find
 * forests), linked lists, and array-backed binary heaps.
 */
import { s, svgRoot } from '../dom';
import { Encoded, Heap, HeapNode, isRef } from '../format';
import { POINTER_COLORS, Var, cellText, nodeLabel, pyText, refLabels } from './common';
import { keysFor } from './arrayView';
import { TNode, layoutTrees, linkedOrder, objectTree } from './treeModel';

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
  /** Keys of nodes waiting in a stack / queue: outlined like graph frontier vertices. */
  frontier?: Set<string>;
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
      const ends = `${p.parent.node.key} ${p.node.key}`;
      edges.push(
        o.toParent
          ? s('line', { x1: bx, y1: by, x2: ax, y2: ay, class: 'edge', 'marker-end': 'url(#tarrow)', 'data-anim-edge': ends })
          : s('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'edge', 'data-anim-edge': ends }),
      );
      if (p.node.edge !== undefined) {
        // The character sits beside the edge's midpoint, on the outer side.
        const side = dx < 0 ? -1 : 1;
        edges.push(s('text', { x: (ax + bx) / 2 + side * 7, y: (ay + by) / 2 + 4, 'text-anchor': side < 0 ? 'end' : 'start', class: 'edge-key', 'data-anim-edge': ends }, p.node.edge));
      }
    }
    const names = o.labels.get(p.node.key);
    const root = o.toParent && !p.parent;
    const g = s('g', { 'data-anim': p.node.key });
    const waiting = o.frontier?.has(p.node.key) ? 'frontier' : '';
    g.appendChild(s('circle', { cx: x, cy: y, r: NR, class: `tnode ${names ? 'pointed' : ''} ${root ? 'root' : ''} ${waiting}` }, s('title', {}, p.node.label || (p.node.edge ?? ''))));
    if (p.node.end) g.appendChild(s('circle', { cx: x, cy: y, r: NR - 4, class: 'tnode-end' }));
    if (p.node.label) {
      const t = short(p.node.label);
      g.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: `gnode-text ${t.cls}` }, t.text));
    }
    if (o.showIndex && p.node.index !== undefined) g.appendChild(s('text', { x, y: y + NR + 11, 'text-anchor': 'middle', class: 'index-text' }, String(p.node.index)));
    // Children past the trace's object cap exist: the node is not a leaf.
    if (p.node.cut) {
      const why = `${p.node.cut} child node${p.node.cut > 1 ? 's' : ''} not shown: too many objects in this step`;
      // Below the index of a level-order node, not on top of it.
      const below = o.showIndex && p.node.index !== undefined ? 22 : 11;
      g.appendChild(s('text', { x, y: y + NR + below, 'text-anchor': 'middle', class: 'muted-text cut-mark' }, '…', s('title', {}, why)));
    }
    nodes.push(g);
    // One label per name, so `cur` slides on its own when it moves to the
    // next node while `prev` stays (one joined label could only fade).
    let lx = x + NR + 2;
    for (const [k, n] of (names ?? []).entries()) {
      // bst.root / self.root mark the structure, like dll.head: one plain colour.
      const color = n.includes('.') ? 'field-label' : POINTER_COLORS[colorIdx++ % POINTER_COLORS.length];
      const text = k < names!.length - 1 ? `${n},` : n;
      nodes.push(s('g', { 'data-anim': `p:${n}` }, s('text', { x: lx, y: y - NR + 2, class: `ptr-text ${color}` }, text)));
      lx += text.length * 7 + 4;
    }
    if (names) labelRight = Math.max(labelRight, lx);
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

/** Field names of the back link of a doubly linked list node. */
const PREV_FIELDS = ['prev', 'previous', 'back', 'prv'];

export interface LinkedListOpts {
  /** Pointer labels by heap id: variables, then a wrapper's fields (dll.head, self.tail). */
  labels?: Map<number, string[]>;
  /** Keys (n:<ref>) of nodes waiting in a stack / queue / heap (merge k lists): outlined. */
  frontier?: Set<string>;
  /** The drawing starts at the real head (a wrapper's head field), whose prev must be None. */
  fromHead?: boolean;
  /**
   * Nodes an earlier card already drew (and judged): a removed node's own
   * card (2 -> 3 -> 4, while 3.prev is 1 again) must not paint the healthy
   * list's links red.
   */
  drawnElsewhere?: Set<number>;
  /**
   * The structure's own method that is running (push_front): it relinks one
   * field per line, so a mismatched link is drawn as work in progress, not
   * as a red broken link that would push a learner to "fix" correct code.
   */
  pending?: string;
}

/**
 * Where a node's prev link goes and whether it is broken: in a doubly linked
 * list node i's prev must be node i-1 (n.next.prev is n), the head's prev
 * None. A remove() that forgets node.next.prev = node.prev leaves 3.prev on
 * the removed 2: that link is 'hot'.
 */
export interface PrevLink {
  from: number;
  /** Index in the drawn order, or undefined when prev is None / outside the drawing. */
  to?: number;
  /** prev is None while the node is not the head. */
  none?: boolean;
  /** Heap id of a prev node that is not in the drawing (a removed node). */
  outside?: number;
  hot: boolean;
  why: string;
}

export function prevLinks(order: number[], heap: Heap, cycleTo: number | undefined, fromHead: boolean, label: (ref: number) => string, drawnElsewhere?: Set<number>): PrevLink[] {
  const fieldOf = (r: number) => heap[String(r)]?.fields?.find(([k]) => PREV_FIELDS.includes(k));
  // A node class with a prev field no node uses yet is drawn as a singly
  // linked list, not as a row of red "prev is None" marks.
  if (!order.some((r) => isRef(fieldOf(r)?.[1]))) return [];
  const index = new Map(order.map((r, i) => [r, i]));
  const circular = cycleTo !== undefined && cycleTo === order[0];
  const out: PrevLink[] = [];
  order.forEach((r, i) => {
    const f = fieldOf(r);
    if (!f) return;
    const pv = f[1];
    const me = label(r);
    const judged = !drawnElsewhere?.has(r);
    // The node before this one in the drawing, or (head of a circular list) the last.
    const want = i > 0 ? order[i - 1] : circular ? order[order.length - 1] : undefined;
    const wantText = want !== undefined ? label(want) : 'None';
    if (isRef(pv) && index.has(pv.ref)) {
      const hot = judged && pv.ref !== want;
      out.push({ from: i, to: index.get(pv.ref), hot, why: hot ? `${me}.${f[0]} is ${label(pv.ref)}, but it should be ${wantText}` : `${me}.${f[0]} is ${label(pv.ref)}` });
    } else if (isRef(pv)) {
      // Drawn from a node in the middle (a variable), the list goes on to the left.
      const hot = judged && (i > 0 || fromHead || circular);
      out.push({ from: i, outside: pv.ref, hot, why: hot ? `${me}.${f[0]} is ${label(pv.ref)}, a node not in this list; it should be ${wantText}` : `${me}.${f[0]} is ${label(pv.ref)}` });
    } else if (pv === null && want !== undefined) {
      out.push({ from: i, none: true, hot: judged, why: `${me}.${f[0]} is None, but ${wantText}.next is ${me}` });
    }
  });
  return out;
}

/**
 * The broken prev links of the list drawn from `headRef`, in words. A red
 * arc's tooltip is easy to miss; the sentence under the drawing names the
 * fix the exercise is about ('3.prev is 2, ...; it should be 1').
 */
export function brokenLinks(headRef: number, heap: Heap, opts: LinkedListOpts = {}): string[] {
  const { order, cycleTo } = linkedOrder(headRef, heap);
  const label = (r: number) => {
    const n = heap[String(r)];
    return n ? nodeLabel(n, heap) : '…';
  };
  return prevLinks(order, heap, cycleTo, opts.fromHead === true, label, opts.drawnElsewhere).filter((b) => b.hot).map((b) => b.why);
}

export function renderLinkedList(headRef: number, heap: Heap, vars: Var[], title: string, opts: LinkedListOpts = {}): SVGSVGElement {
  const { order, cycleTo } = linkedOrder(headRef, heap);
  const index = new Map(order.map((r, i) => [r, i]));
  const labels = opts.labels ?? refLabels(vars);
  const nodeText = (r: number) => {
    const n = heap[String(r)];
    return n ? nodeLabel(n, heap) : '…';
  };
  const backs = prevLinks(order, heap, cycleTo, opts.fromHead === true, nodeText, opts.drawnElsewhere);
  // Names sharing a node are stacked above it, one label each. Room for two
  // is kept even when no node has two, so the boxes do not jump up and down
  // as `cur` and `nxt` meet and part.
  const stack = Math.max(2, ...order.map((r) => labels.get(r)?.length ?? 0));
  const boxW = 54;
  const gap = 34;
  const y = 28 + 12 * stack;
  // A pointer label wider than its box (dll.tail, self.head) widens the drawing.
  const lastLabel = Math.max(0, ...(labels.get(order[order.length - 1]) ?? []).map((t) => t.length * 7));
  // Room on the left for the head's prev link when it leaves the drawing.
  const left = backs.some((b) => b.from === 0 && b.to === undefined) ? 30 : 10;
  const width = left + order.length * (boxW + gap) + 50 + Math.max(0, lastLabel / 2 - boxW / 2);
  const height = y + (cycleTo !== undefined ? 80 : backs.length ? 66 : 52);
  const svg = svgRoot(width, height, title);
  svg.appendChild(
    s('defs', {},
      s('marker', { id: 'larrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow' })),
      backs.some((b) => b.hot) && !opts.pending ? s('marker', { id: 'larrow-hot', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'edge-arrow hot-arrow' })) : null),
  );
  let colorIdx = 0;
  order.forEach((ref, i) => {
    const n = heap[String(ref)]!;
    const x = left + i * (boxW + gap);
    const names = labels.get(ref);
    svg.appendChild(
      s('g', { 'data-anim': `n:${ref}` },
        s('rect', { x, y, width: boxW, height: 30, rx: 4, class: `lnode ${names ? 'pointed' : ''} ${opts.frontier?.has(`n:${ref}`) ? 'frontier' : ''}` }),
        s('text', { x: x + (boxW - 14) / 2, y: y + 19, 'text-anchor': 'middle', class: 'gnode-text' }, nodeLabel(n, heap)),
        s('line', { x1: x + boxW - 14, x2: x + boxW - 14, y1: y, y2: y + 30, class: 'divider' })),
    );
    // One group per name, so each pointer slides on its own as it moves along.
    (names ?? []).forEach((name, k) => {
      // dll.head / self.tail mark the structure, they do not walk it: one
      // plain colour, so a red pointer colour is not read as a broken link.
      const color = name.includes('.') ? 'field-label' : POINTER_COLORS[colorIdx++ % POINTER_COLORS.length];
      const ty = y - 10 - 12 * k;
      svg.appendChild(
        s('g', { 'data-anim': `p:${name}` },
          s('text', { x: x + boxW / 2, y: ty, 'text-anchor': 'middle', class: `ptr-text ${color}` }, name),
          k === 0 ? s('line', { x1: x + boxW / 2, x2: x + boxW / 2, y1: y - 7, y2: y - 1, class: `ptr-line ${color}` }) : null),
      );
    });
    const next = field(n, 'next');
    const sx = x + boxW - 7;
    if (i + 1 < order.length && isRef(next) && next.ref === order[i + 1]) {
      svg.appendChild(s('line', { x1: sx, y1: y + 15, x2: x + boxW + gap - 2, y2: y + 15, class: 'edge', 'marker-end': 'url(#larrow)', 'data-anim-edge': `n:${ref} n:${order[i + 1]}` }));
    } else if (cycleTo !== undefined && isRef(next) && next.ref === cycleTo) {
      // Under the box's left edge when prev arcs end under its middle.
      const tx = left + index.get(cycleTo)! * (boxW + gap) + (backs.length ? 8 : boxW / 2);
      const ends = `n:${ref} n:${cycleTo}`;
      svg.appendChild(s('path', { d: `M${sx},${y + 30} V${y + 60} H${tx} V${y + 32}`, class: 'edge hot', fill: 'none', 'marker-end': 'url(#larrow)', 'data-anim-edge': ends }));
      svg.appendChild(s('text', { x: (sx + tx) / 2, y: y + 74, 'text-anchor': 'middle', class: 'muted-text', 'data-anim-edge': ends }, 'cycle'));
    } else {
      const cutOff = next !== null && next !== undefined;
      svg.appendChild(
        s('text', { x: sx + 8, y: y + 19, class: 'muted-text', 'data-anim-edge': `n:${ref}` }, cutOff ? '…' : '∅',
          cutOff ? s('title', {}, 'more nodes, not shown') : null),
      );
    }
  });
  // prev links run under the boxes, right to left: a lower return arc.
  const xOf = (i: number) => left + i * (boxW + gap);
  for (const b of backs) {
    const sx = xOf(b.from) + 12;
    const hot = b.hot && !opts.pending;
    const settling = b.hot && !!opts.pending;
    const cls = `edge prev ${hot ? 'hot' : ''} ${settling ? 'pending' : ''}`;
    const arrow = hot ? 'url(#larrow-hot)' : 'url(#larrow)';
    const why = settling ? `${b.why} (${opts.pending} is still running)` : b.why;
    const r = order[b.from];
    // A circular list's head points back at the last node, which the
    // "cycle" path already joins: a second arc there only crowds it.
    if (b.to !== undefined && b.from === 0 && b.to === order.length - 1 && cycleTo === order[0] && !b.hot) continue;
    if (b.to !== undefined) {
      const ex = xOf(b.to) + boxW - 24;
      const depth = 16 + 7 * Math.min(4, Math.abs(b.from - b.to));
      svg.appendChild(
        s('path', { d: `M${sx},${y + 30} C${sx},${y + 30 + depth} ${ex},${y + 30 + depth} ${ex},${y + 33}`, class: cls, fill: 'none', 'marker-end': arrow, 'data-anim-edge': `n:${r} n:${order[b.to]}` },
          s('title', {}, why)),
      );
    } else {
      // prev is None, or a node outside this drawing: a short link down-left with its target.
      const text = b.none ? '∅' : nodeText(b.outside!);
      svg.appendChild(
        s('g', { 'data-anim-edge': `n:${r}` },
          s('path', { d: `M${sx},${y + 30} L${sx - 20},${y + 47}`, class: cls, fill: 'none', 'marker-end': arrow }),
          s('text', { x: sx - 24, y: y + 60, 'text-anchor': 'middle', class: hot ? 'hot-text' : settling ? 'pending-text' : 'muted-text' }, text),
          s('title', {}, why)),
      );
    }
  }
  return svg;
}

/** Binary heap drawn as a tree from its array (index i -> children 2i+1, 2i+2). */
export function renderHeapArray(items: Encoded[], title: string, heap?: Heap, id = title): SVGSVGElement {
  const n = Math.min(items.length, 63);
  const depth = Math.floor(Math.log2(Math.max(1, n))) + 1;
  // A heap of (dist, node) or (val, i, node) tuples: the node grows into an
  // ellipse that holds '(1,0,7)' instead of the word 'tuple'.
  const texts = items.slice(0, n).map((x) => cellText(x, heap));
  const rxOf = (t: string) => (t.length > 3 ? Math.max(NR, Math.ceil(t.length * 2.9) + 6) : NR);
  const slot = Math.max(46, ...texts.map((t) => 2 * rxOf(t) + 8));
  const width = Math.max(200, Math.pow(2, depth - 1) * slot + 20);
  const height = depth * 56 + 20;
  const svg = svgRoot(width, height, title);
  // Prefixed: the cells drawn under the tree share the card's animation scope.
  const keys = keysFor(`${id}\u0000heap`, items.slice(0, n)).map((k) => `h/${k}`);
  const posOf = (i: number): [number, number] => {
    const d = Math.floor(Math.log2(i + 1));
    const k = i + 1 - Math.pow(2, d);
    const slots = Math.pow(2, d);
    return [((k + 0.5) / slots) * width, 26 + d * 56];
  };
  for (let i = 1; i < n; i++) {
    const [x1, y1] = posOf(Math.floor((i - 1) / 2));
    const [x2, y2] = posOf(i);
    svg.appendChild(s('line', { x1, y1: y1 + NR, x2, y2: y2 - NR, class: 'edge', 'data-anim-edge': `${keys[Math.floor((i - 1) / 2)]} ${keys[i]}` }));
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = posOf(i);
    const label = texts[i];
    const rx = rxOf(label);
    const cls = i === 0 ? 'tnode pointed' : 'tnode';
    const tip = s('title', {}, `[${i}] = ${pyText(items[i], heap)}`);
    svg.appendChild(
      s('g', { 'data-anim': keys[i] },
        rx > NR ? s('ellipse', { cx: x, cy: y, rx, ry: NR, class: cls }, tip) : s('circle', { cx: x, cy: y, r: NR, class: cls }, tip),
        s('text', { x, y: y + 4, 'text-anchor': 'middle', class: `gnode-text ${label.length > 3 ? 'tiny' : ''}` }, label),
        s('text', { x, y: y + NR + 11, 'text-anchor': 'middle', class: 'index-text' }, String(i))),
    );
  }
  return svg;
}
