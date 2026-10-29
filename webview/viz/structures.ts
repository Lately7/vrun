/**
 * Chooses and renders a view for every variable of a snapshot:
 * arrays, number line, function graph, matrix, graph, tree, linked list, heap.
 */
import { button, h } from '../dom';
import { Encoded, Heap, HeapNode, isRef, numeric } from '../format';
import { renderArray } from './arrayView';
import { renderChart } from './chartView';
import { Var, allNumeric, isPointerName, node, shortScalar } from './common';
import { isAdjacency, renderGraph } from './graphView';
import { renderMatrix } from './matrixView';
import { Mark, renderNumberLine } from './numberLine';
import { isListNode, isTreeNode, renderHeapArray, renderLinkedList, renderTree } from './treeView';

export type ArrayMode = 'bars' | 'cells' | 'chart' | 'numberline' | 'heap';

export interface StructureState {
  modes: Map<string, ArrayMode>;
}

const HEAP_NAME = /(^|_)(heap|pq|minheap|maxheap|priority_queue)$/i;
const QUEUE_NAME = /^(q|queue|stack|st|frontier|todo|to_visit|dq|open|open_set)$/i;
const ROOT_NAME = /^(root|tree|head|lst|linked|ll|graph|g|adj)$/i;

function card(title: string, subtitle: string, body: Node, tools?: Node): HTMLElement {
  return h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, title), h('span', { class: 'muted' }, subtitle), tools ?? null), h('div', { class: 'viz-body' }, body));
}

function reachable(ref: number, heap: Heap, out: Set<number>): void {
  const stack = [ref];
  while (stack.length) {
    const r = stack.pop()!;
    if (out.has(r)) continue;
    const n = heap[String(r)];
    if (!n || n.kind !== 'object') continue;
    out.add(r);
    for (const [, v] of n.fields ?? []) {
      if (isRef(v)) {
        const c = heap[String(v.ref)];
        if (c?.kind === 'object') stack.push(v.ref);
        else if (c && c.items) for (const it of c.items) if (isRef(it)) stack.push(it.ref);
      }
    }
  }
}

function pairs(items: Encoded[], heap: Heap): Array<[number, number]> | undefined {
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

function rowsOf(n: HeapNode, heap: Heap): Encoded[][] | undefined {
  if (n.kind === 'ndarray' && n.rows) return n.rows;
  if (!n.items || n.items.length === 0) return undefined;
  const rows: Encoded[][] = [];
  for (const it of n.items) {
    const r = node(heap, it);
    if (!r || !(r.kind === 'list' || r.kind === 'tuple') || !r.items) return undefined;
    rows.push(r.items);
  }
  // A list of short pairs is a point list, not a table.
  return rows;
}

export function renderStructures(vars: Var[], heap: Heap, prevHeap: Heap | undefined, state: StructureState, rerender: () => void): HTMLElement {
  const root = h('div', { class: 'viz-grid' });
  let marks: Mark[] = [];
  const covered = new Set<number>();
  const drawnRefs = new Set<number>();

  // Draw likely "entry" variables (root/head/graph) and outer frames first.
  const ordered = [...vars].sort((a, b) => Number(ROOT_NAME.test(b.name)) - Number(ROOT_NAME.test(a.name)) || a.depth - b.depth);

  for (const v of ordered) {
    const num = numeric(v.value);
    if (num !== undefined && typeof v.value !== 'boolean' && Number.isFinite(num)) {
      if (!marks.some((m) => m.label === v.name)) marks.push({ label: v.name, value: num });
      continue;
    }
    if (!isRef(v.value)) continue;
    const ref = v.value.ref;
    if (drawnRefs.has(ref) || covered.has(ref)) continue;
    const n = heap[String(ref)];
    if (!n) continue;
    const prev = prevHeap?.[String(ref)] ?? undefined;
    const el = renderOne(v, n, prev, heap, vars, state, rerender, covered);
    if (el) {
      drawnRefs.add(ref);
      root.appendChild(el);
    }
  }

  // xs / ys pairs → function graph
  const xsVar = vars.find((v) => /^(xs|x_values|x)$/i.test(v.name) && node(heap, v.value)?.items);
  const ysVar = vars.find((v) => /^(ys|y_values|y)$/i.test(v.name) && node(heap, v.value)?.items);
  if (xsVar && ysVar) {
    const xs = node(heap, xsVar.value)!.items!;
    const ys = node(heap, ysVar.value)!.items!;
    if (xs.length === ys.length && xs.length > 1 && allNumeric(xs) && allNumeric(ys)) {
      const pts = xs.map((x, i) => [numeric(x)!, numeric(ys[i])!] as [number, number]);
      root.prepend(card(`${ysVar.name} vs ${xsVar.name}`, 'function graph', renderChart(pts, `${ysVar.name} vs ${xsVar.name}`)));
    }
  }

  // Index variables already drawn as pointers on an array or as the
  // highlighted cell of a matrix would only repeat themselves here.
  if (root.querySelector('table.matrix, svg[aria-label^="array"]')) {
    marks = marks.filter((m) => !(Number.isInteger(m.value) && isPointerName(m.label)));
  }
  // A lone loop counter on a number line says nothing; two or more values
  // (lo/mid/hi, target/sum) are worth placing on the line.
  if (marks.length >= 2) {
    root.prepend(card('Number line', `${marks.length} numeric variable${marks.length > 1 ? 's' : ''}`, renderNumberLine(marks, [], 'number line of numeric variables')));
  }
  if (!root.childElementCount) root.appendChild(h('p', { class: 'muted' }, 'No variables to draw at this step yet.'));
  return root;
}

function renderOne(
  v: Var,
  n: HeapNode,
  prev: HeapNode | undefined,
  heap: Heap,
  vars: Var[],
  state: StructureState,
  rerender: () => void,
  covered: Set<number>,
): HTMLElement | undefined {
  const ref = (v.value as { ref: number }).ref;
  if (n.kind === 'object') {
    if (isTreeNode(n)) {
      reachable(ref, heap, covered);
      return card(v.name, `tree (${n.type})`, renderTree(ref, heap, vars, `tree ${v.name}`));
    }
    if (isListNode(n)) {
      reachable(ref, heap, covered);
      return card(v.name, `linked list (${n.type})`, renderLinkedList(ref, heap, vars, `linked list ${v.name}`));
    }
    // Course-style wrappers (LinkedList with .head, BST with .root): draw the
    // structure held in the field rather than a one-row field table.
    for (const [field, val] of n.fields ?? []) {
      const inner = node(heap, val);
      if (!isRef(val) || !inner) continue;
      if (isTreeNode(inner)) {
        reachable(val.ref, heap, covered);
        return card(`${v.name}.${field}`, `tree (${inner.type}) in ${n.type}`, renderTree(val.ref, heap, vars, `tree ${v.name}.${field}`));
      }
      if (isListNode(inner)) {
        reachable(val.ref, heap, covered);
        return card(`${v.name}.${field}`, `linked list (${inner.type}) in ${n.type}`, renderLinkedList(val.ref, heap, vars, `linked list ${v.name}.${field}`));
      }
    }
    const rows = (n.fields ?? []).map(([k, val]) => h('tr', {}, h('th', {}, k), h('td', {}, shortScalar(val, heap))));
    return card(v.name, `${n.type} object`, h('table', { class: 'kv' }, ...rows));
  }
  if (n.kind === 'dict') {
    if (isAdjacency(n, heap)) return card(v.name, `graph · ${n.len} vertices`, renderGraph(v.name, n, heap, vars));
    const rows = (n.entries ?? []).map(([k, val]) => h('tr', {}, h('th', {}, shortScalar(k, heap)), h('td', {}, shortScalar(val, heap))));
    return card(v.name, `dict · ${n.len} keys`, h('table', { class: 'kv' }, ...rows));
  }
  if (n.kind === 'ndarray' && n.rows) {
    return card(v.name, `ndarray ${n.shape?.join('×')} ${n.dtype}`, renderMatrix(v.name, n.rows, prev?.rows, vars, heap));
  }
  const items = n.items ?? [];
  const total = n.len ?? items.length;
  // Queues and stacks hold items to process (often (row, col) tuples), and
  // edge lists hold pairs too: neither is y = f(x) data or a table.
  const queueLike = n.kind === 'deque' || QUEUE_NAME.test(v.name);
  const pts = /edge/i.test(v.name) || queueLike ? undefined : pairs(items, heap);
  const heapNamed = HEAP_NAME.test(v.name);
  const rows = !pts && !heapNamed && !queueLike ? rowsOf(n, heap) : undefined;
  if (rows && rows.length && rows.some((r) => r.length > 0)) {
    const prevRows = prev ? rowsOf(prev, heap) : undefined;
    return card(v.name, `${n.kind} ${rows.length}×${Math.max(...rows.map((r) => r.length))}`, renderMatrix(v.name, rows, prevRows, vars, heap));
  }
  const numericItems = allNumeric(items);
  const defaultMode: ArrayMode = pts ? 'chart' : HEAP_NAME.test(v.name) ? 'heap' : n.kind === 'set' && numericItems ? 'numberline' : numericItems ? 'bars' : 'cells';
  const mode = state.modes.get(v.name) ?? defaultMode;
  const modes: ArrayMode[] = pts ? ['chart', 'cells'] : numericItems ? ['bars', 'cells', 'chart', 'numberline', 'heap'] : heapNamed ? ['heap', 'cells'] : ['cells'];
  const tools =
    modes.length > 1
      ? h(
          'span',
          { class: 'seg', role: 'group', 'aria-label': 'view' },
          ...modes.map((m) =>
            button(m === 'numberline' ? 'number line' : m, () => {
              state.modes.set(v.name, m);
              rerender();
            }, { cls: `seg-btn ${m === mode ? 'on' : ''}`, pressed: m === mode }),
          ),
        )
      : undefined;
  let body: Node;
  if (mode === 'chart' && pts) body = renderChart(pts, v.name);
  else if (mode === 'chart' && numericItems) body = renderChart(items.map((x, i) => [i, numeric(x)!]), `${v.name} by index`);
  else if (mode === 'numberline' && numericItems) body = renderNumberLine([], items.map((x) => numeric(x)!), `${v.name} on a number line`);
  else if (mode === 'heap' && items.length) body = h('div', { class: 'stack' }, renderHeapArray(items, `${v.name} as heap`, heap), renderArray({ name: v.name, items, total, prevItems: prev?.items, vars, mode: 'cells', heap }));
  else body = renderArray({ name: v.name, items, total, prevItems: prev?.items, vars, mode: mode === 'bars' ? 'bars' : 'cells', heap });
  return card(v.name, `${n.kind} · len ${total}`, body, tools);
}
