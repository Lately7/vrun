/**
 * Chooses and renders a view for every variable of a snapshot: arrays and
 * strings, number line, function graph, matrix, graph, tree, trie, linked
 * list, heap, union-find forest.
 */
import { button, h } from '../dom';
import { Encoded, Heap, HeapNode, isRef, numeric } from '../format';
import { renderArray } from './arrayView';
import { renderChart } from './chartView';
import { Var, allNumeric, isPointerName, node, shortScalar } from './common';
import { GraphModel, adjacencyModel, edgeListModel, isAdjacency, stableLayout } from './graphModel';
import { renderGraph } from './graphView';
import { renderMatrix } from './matrixView';
import { EDGE_LIST_NAME, END_KEY, FRONTIER, HEAP_NAME, LEVEL_ORDER_NAME, PATH, QUEUE_NAME, ROOT_NAME, UNION_FIND_NAME, VISITED } from './names';
import { Mark, renderNumberLine } from './numberLine';
import {
  FrameLike,
  Pointer,
  PointerFrame,
  boundRanges,
  framesFromVars,
  legacyMatrixPointers,
  legacyPointers,
  matrixPointers,
  sequencePointers,
} from './pointers';
import { cellMarks, charsOf, edgeListOf, isDictTrie, isLevelOrder, isUnionFindArray, stringAxes } from './shapes';
import { SourceHints, isScanned, sourceHints } from './sourceHints';
import { TNode, dictTrie, forestOf, isListNode, isTreeNode, levelOrderTree, objectTree } from './treeModel';
import { refKeyLabels, renderHeapArray, renderLinkedList, renderTreeModel } from './treeView';

export type ArrayMode = 'bars' | 'cells' | 'chart' | 'numberline' | 'heap' | 'forest' | 'tree' | 'graph';

export interface StructureState {
  modes: Map<string, ArrayMode>;
}

export interface StructureContext {
  /** Traced source; line numbers are 1-based like TraceStep.line. */
  source?: string;
  /** Every frame of the current step, outermost first, with all of its locals (not de-duplicated). Var.depth indexes this. */
  frames?: Array<{ func: string; locals: Array<[string, Encoded]> }>;
  /** Variables and heap at the last step of the trace, for layouts that should not move while stepping. */
  final?: { vars: Var[]; heap: Heap };
}

interface Env {
  vars: Var[];
  heap: Heap;
  prevHeap?: Heap;
  state: StructureState;
  rerender: () => void;
  ctx?: StructureContext;
  hints?: SourceHints;
  frames: FrameLike[];
  finalVars: Map<string, Var>;
  /** Heap ids already drawn as part of a tree / list / trie. */
  covered: Set<number>;
}

const MODE_LABEL: Partial<Record<ArrayMode, string>> = { numberline: 'number line' };

function card(scope: string, title: string, subtitle: string, body: Node, tools?: Node): HTMLElement {
  return h(
    'section',
    { class: 'viz-card', 'data-anim-scope': scope },
    h('header', {}, h('span', { class: 'viz-title' }, title), h('span', { class: 'muted' }, subtitle), tools ?? null),
    h('div', { class: 'viz-body' }, body),
  );
}

/** "in merge_sort" for a function's variable; "a in partition" when another frame's alias drives the pointers. */
function where(v: Var, env: Env, at?: PointerFrame): string {
  const parts: string[] = [];
  const func = (d: number) => {
    const f = env.ctx?.frames?.[d]?.func;
    return f && f !== '<module>' ? f : undefined;
  };
  // A closure's free variables show up in the inner frame's locals too:
  // name the function that binds the variable (permute, not backtrack).
  let owner = v.depth;
  while (owner > 0 && env.hints) {
    const info = env.hints.funcs.get(env.ctx?.frames?.[owner]?.func ?? '');
    if (!info || info.locals.has(v.name)) break;
    owner--;
  }
  const own = owner > 0 ? func(owner) : undefined;
  if (own) parts.push(`in ${own}`);
  if (at && at.frame !== v.depth && at.frame !== owner) {
    const other = func(at.frame);
    if (other) parts.push(at.local && at.local !== v.name ? `${at.local} in ${other}` : `used in ${other}`);
  }
  return parts.length ? ' · ' + parts.join(' · ') : '';
}

/** Objects and dicts reachable from `start` (tree nodes, trie dicts), bounded so a huge heap stays fast. */
function reachable(start: number, heap: Heap, out: Set<number>, limit = 4000): void {
  const stack = [start];
  const seen = new Set<number>();
  while (stack.length && seen.size < limit) {
    const r = stack.pop()!;
    if (seen.has(r)) continue;
    seen.add(r);
    const n = heap[String(r)];
    if (!n) continue;
    if (n.kind === 'object' || n.kind === 'dict') out.add(r);
    const kids: Encoded[] = n.kind === 'object' ? (n.fields ?? []).map((f) => f[1]) : n.kind === 'dict' ? (n.entries ?? []).map((e) => e[1]) : n.items ?? [];
    for (const c of kids) if (isRef(c)) stack.push(c.ref);
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
  // A set has no row order; a deque is a queue of work items.
  if (!(n.kind === 'list' || n.kind === 'tuple') || !n.items || n.items.length === 0) return undefined;
  const rows: Encoded[][] = [];
  for (const it of n.items) {
    const r = node(heap, it);
    if (!r || !(r.kind === 'list' || r.kind === 'tuple') || !r.items) return undefined;
    rows.push(r.items);
  }
  return rows;
}

/** Interior pointers (a `node` inside the trie, `cur` inside a list) are drawn after their whole structure. */
function interiorRefs(vars: Var[], heap: Heap): Set<number> {
  const cands = vars.filter((v) => isRef(v.value) && ['object', 'dict'].includes(heap[String(v.value.ref)]?.kind ?? ''));
  if (cands.length < 2 || cands.length > 40) return new Set();
  const reach = new Map<number, Set<number>>();
  for (const v of cands) {
    const r = (v.value as { ref: number }).ref;
    if (reach.has(r)) continue;
    const s = new Set<number>();
    reachable(r, heap, s, 1500);
    reach.set(r, s);
  }
  const out = new Set<number>();
  for (const [a, ra] of reach) for (const [b, rb] of reach) {
    if (a !== b && ra.has(b) && !rb.has(a)) out.add(b);
  }
  return out;
}

export function renderStructures(vars: Var[], heap: Heap, prevHeap: Heap | undefined, state: StructureState, rerender: () => void, ctx?: StructureContext): HTMLElement {
  const env: Env = {
    vars,
    heap,
    prevHeap,
    state,
    rerender,
    ctx,
    hints: ctx?.source ? sourceHints(ctx.source) : undefined,
    frames: ctx?.frames ?? framesFromVars(vars),
    finalVars: new Map(),
    covered: new Set(),
  };
  for (const v of ctx?.final?.vars ?? []) if (!env.finalVars.has(v.name)) env.finalVars.set(v.name, v);
  const root = h('div', { class: 'viz-grid' });
  let marks: Mark[] = [];
  const drawnRefs = new Set<number>();

  // Draw likely "entry" variables (root/head/graph) and outer frames first,
  // whole structures before variables pointing into them.
  const inner = interiorRefs(vars, heap);
  const rank = (v: Var) => (isRef(v.value) && inner.has(v.value.ref) ? 1 : 0);
  const ordered = [...vars].sort((a, b) => rank(a) - rank(b) || Number(ROOT_NAME.test(b.name)) - Number(ROOT_NAME.test(a.name)) || a.depth - b.depth);

  for (const v of ordered) {
    const num = numeric(v.value);
    if (num !== undefined && typeof v.value !== 'boolean' && Number.isFinite(num)) {
      if (!marks.some((m) => m.label === v.name)) marks.push({ label: v.name, value: num });
      continue;
    }
    const chars = charsOf(v.value);
    if (chars !== undefined) {
      const el = renderString(v, chars, env);
      if (el) root.appendChild(el);
      continue;
    }
    if (!isRef(v.value)) continue;
    const ref = v.value.ref;
    if (drawnRefs.has(ref) || env.covered.has(ref)) continue;
    const n = heap[String(ref)];
    if (!n) continue;
    const el = renderOne(v, n, prevHeap?.[String(ref)] ?? undefined, env);
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
      root.prepend(card(`${ysVar.name} vs ${xsVar.name}`, `${ysVar.name} vs ${xsVar.name}`, 'function graph', renderChart(pts, `${ysVar.name} vs ${xsVar.name}`)));
    }
  }

  // Next to a drawing, counters and sizes (count=1, rows=4) are noise and
  // index variables are already pointers; the line earns its place only for
  // a real-valued quantity (a guess, an error, a probability).
  if (root.childElementCount) {
    marks = marks.some((m) => !Number.isInteger(m.value)) ? marks.filter((m) => !(Number.isInteger(m.value) && isPointerName(m.label))) : [];
  }
  // A lone loop counter on a number line says nothing; two or more values
  // (lo/mid/hi, target/sum) are worth placing on the line.
  if (marks.length >= 2) {
    root.prepend(card('number line', 'Number line', `${marks.length} numeric variable${marks.length > 1 ? 's' : ''}`, renderNumberLine(marks, [], 'number line of numeric variables')));
  }
  if (!root.childElementCount) root.appendChild(h('p', { class: 'muted' }, 'No variables to draw at this step yet.'));
  return root;
}

function seqPointers(v: Var, len: number, env: Env): { pointers: Pointer[]; at?: PointerFrame } {
  if (env.hints) return sequencePointers(v.value, v.depth, len, env.frames, env.hints);
  return { pointers: legacyPointers(env.vars, len) };
}

function renderString(v: Var, chars: string, env: Env): HTMLElement | undefined {
  // Only strings the code walks through: indexed (s[i]) or scanned (for ch in s).
  if (!env.hints || chars.length < 2) return undefined;
  const total = typeof v.value === 'string' ? chars.length : ((v.value as { len?: number }).len ?? chars.length);
  // The variable itself must be walked: `w` passed to insert(word) is drawn once, as `word`.
  if (!isScanned(env.hints, [v.name])) return undefined;
  const { pointers, at } = sequencePointers(v.value, v.depth, total, env.frames, env.hints);
  const items = [...chars];
  const body = renderArray({ name: v.name, items, total, pointers, ranges: boundRanges(pointers, items.length), mode: 'cells', chars: true });
  return card(v.name, v.name, `str · len ${total}${where(v, env, at)}`, body);
}

function finalNode(v: Var, env: Env): { n: HeapNode; heap: Heap } | undefined {
  const f = env.finalVars.get(v.name);
  const fh = env.ctx?.final?.heap;
  if (!f || !fh || !isRef(f.value)) return undefined;
  const n = fh[String(f.value.ref)];
  return n ? { n, heap: fh } : undefined;
}

function treeCard(v: Var, title: string, kind: string, root: TNode | undefined, env: Env): HTMLElement {
  const trie = !!root && hasEdgeLabels(root);
  const body = renderTreeModel(root ? [root] : [], { title: `tree ${title}`, labels: refKeyLabels(env.vars) });
  return card(v.name, title, `${trie ? 'trie' : 'tree'}${kind ? ` (${kind})` : ''}${where(v, env)}`, body);
}

function hasEdgeLabels(t: TNode, depth = 0): boolean {
  if (depth > 3) return false;
  return t.children.some((c) => c !== null && (c.edge !== undefined || hasEdgeLabels(c, depth + 1)));
}

function renderObject(v: Var, ref: number, n: HeapNode, env: Env): HTMLElement {
  const { heap } = env;
  if (isTreeNode(n, heap)) {
    reachable(ref, heap, env.covered);
    return treeCard(v, v.name, n.type ?? '', objectTree(ref, heap), env);
  }
  if (isListNode(n, heap)) {
    reachable(ref, heap, env.covered);
    return card(v.name, v.name, `linked list (${n.type})${where(v, env)}`, renderLinkedList(ref, heap, env.vars, `linked list ${v.name}`));
  }
  // Course-style wrappers (LinkedList with .head, BST / Trie with .root):
  // draw the structure held in the field rather than a one-row field table.
  for (const [field, val] of n.fields ?? []) {
    const inner = node(heap, val);
    if (!isRef(val) || !inner) continue;
    if (isTreeNode(inner, heap)) {
      reachable(val.ref, heap, env.covered);
      return treeCard(v, `${v.name}.${field}`, `${inner.type} in ${n.type}`, objectTree(val.ref, heap), env);
    }
    if (isListNode(inner, heap)) {
      reachable(val.ref, heap, env.covered);
      return card(v.name, `${v.name}.${field}`, `linked list (${inner.type}) in ${n.type}${where(v, env)}`, renderLinkedList(val.ref, heap, env.vars, `linked list ${v.name}.${field}`));
    }
  }
  const rows = (n.fields ?? []).map(([k, val]) => h('tr', {}, h('th', {}, k), h('td', {}, shortScalar(val, heap))));
  return card(v.name, v.name, `${n.type} object${where(v, env)}`, h('table', { class: 'kv' }, ...rows));
}

/** Every value a dict or an end marker: a trie under construction (its first word has no depth-2 dict yet). */
function trieShaped(n: HeapNode, heap: Heap): boolean {
  return (n.entries ?? []).every(([k, val]) => node(heap, val)?.kind === 'dict' || (typeof k === 'string' && END_KEY.test(k) && !isRef(val)));
}

function renderDict(v: Var, ref: number, n: HeapNode, env: Env): HTMLElement {
  const { heap } = env;
  const fin = finalNode(v, env);
  // The final value decides, so a trie is a trie from its first insert on
  // instead of a one-vertex graph that later turns into a tree.
  const trie = trieShaped(n, heap) && (isDictTrie(n, heap) || (fin !== undefined && isDictTrie(fin.n, fin.heap)));
  if (trie) {
    reachable(ref, heap, env.covered);
    return treeCard(v, v.name, 'nested dict', dictTrie(ref, heap), env);
  }
  if (isAdjacency(n, heap)) {
    const m = adjacencyModel(n, heap);
    const layout = stableLayout(m, fin && { key: fin.n, model: () => (isAdjacency(fin.n, fin.heap) ? adjacencyModel(fin.n, fin.heap) : undefined) });
    return card(v.name, v.name, `graph · ${m.nodes.length} vertices${where(v, env)}`, renderGraph(v.name, m, layout, heap, env.vars));
  }
  const rows = (n.entries ?? []).map(([k, val]) => h('tr', {}, h('th', {}, shortScalar(k, heap)), h('td', {}, shortScalar(val, heap))));
  return card(v.name, v.name, `dict · ${n.len} keys${where(v, env)}`, h('table', { class: 'kv' }, ...rows));
}

function matrixCard(v: Var, rows: Encoded[][], prevRows: Encoded[][] | undefined, kind: string, env: Env): HTMLElement {
  const nrows = rows.length;
  const ncols = Math.max(0, ...rows.map((r) => r.length));
  const marks = env.hints ? matrixPointers(v.value, v.depth, nrows, ncols, env.frames, env.hints) : legacyMatrixPointers(env.vars);
  const axes = env.hints ? stringAxes(env.vars, env.hints, nrows, ncols, marks.rowNames, marks.colNames) : {};
  const body = renderMatrix({ name: v.name, rows, prev: prevRows, heap: env.heap, marks, cells: cellMarks(env.vars, env.heap, nrows, ncols), ...axes });
  return card(v.name, v.name, `${kind} ${nrows}×${ncols}${where(v, env, marks.at)}`, body);
}

function renderOne(v: Var, n: HeapNode, prev: HeapNode | undefined, env: Env): HTMLElement | undefined {
  const { heap, state } = env;
  const ref = (v.value as { ref: number }).ref;
  if (n.kind === 'object') return renderObject(v, ref, n, env);
  if (n.kind === 'dict') return renderDict(v, ref, n, env);
  if (n.kind === 'ndarray' && n.rows) return matrixCard(v, n.rows, prev?.rows, `ndarray ${n.dtype ?? ''}`.trim(), env);

  const items = n.items ?? [];
  const total = n.len ?? items.length;
  const ordered = n.kind === 'list' || n.kind === 'tuple' || n.kind === 'ndarray';
  // Queues and stacks hold items to process (often (row, col) tuples):
  // neither y = f(x) data, a table, nor something indices point into.
  const queueLike = n.kind === 'deque' || QUEUE_NAME.test(v.name);
  const edgeList = EDGE_LIST_NAME.test(v.name) ? edgeListOf(items, heap) : undefined;
  const unionFind = ordered && UNION_FIND_NAME.test(v.name) && isUnionFindArray(items, total);
  const levelOrder = ordered && !unionFind && LEVEL_ORDER_NAME.test(v.name) && isLevelOrder(items);
  const pts = edgeList || queueLike || /edge/i.test(v.name) ? undefined : pairs(items, heap);
  const heapNamed = HEAP_NAME.test(v.name);
  const rows = !pts && !edgeList && !heapNamed && !queueLike ? rowsOf(n, heap) : undefined;
  if (rows && rows.length && rows.some((r) => r.length > 0)) {
    return matrixCard(v, rows, prev ? rowsOf(prev, heap) : undefined, n.kind, env);
  }
  const numericItems = allNumeric(items);
  // Visited cells, a queue or a path of (r, c) pairs are coordinates, not
  // y = f(x); a set is never a function graph by default.
  const cellish = n.kind === 'set' || VISITED.test(v.name) || FRONTIER.test(v.name) || PATH.test(v.name);
  let modes: ArrayMode[];
  if (edgeList) modes = ['graph', 'cells'];
  else if (unionFind) modes = ['forest', 'cells', 'bars'];
  else if (levelOrder) modes = ['tree', 'cells'];
  else if (pts) modes = cellish ? ['cells', 'chart'] : ['chart', 'cells'];
  else if (numericItems) {
    modes = ['bars', 'cells', 'chart', 'numberline', 'heap'];
    if (heapNamed) modes = ['heap', ...modes.filter((m) => m !== 'heap')];
    else if (n.kind === 'set') modes = ['numberline', ...modes.filter((m) => m !== 'numberline')];
  } else modes = heapNamed ? ['heap', 'cells'] : ['cells'];
  const saved = state.modes.get(v.name);
  const mode = saved && modes.includes(saved) ? saved : modes[0];
  const tools =
    modes.length > 1
      ? h(
          'span',
          { class: 'seg', role: 'group', 'aria-label': 'view' },
          ...modes.map((m) =>
            button(MODE_LABEL[m] ?? m, () => {
              state.modes.set(v.name, m);
              env.rerender();
            }, { cls: `seg-btn ${m === mode ? 'on' : ''}`, pressed: m === mode }),
          ),
        )
      : undefined;

  // Pointers make sense only on ordered sequences one indexes into.
  const pointable = ordered && !queueLike && !edgeList && items.length > 0;
  const { pointers, at } = pointable ? seqPointers(v, total, env) : { pointers: [] as Pointer[], at: undefined };
  const ranges = boundRanges(pointers, items.length);
  const byIndex = () => {
    const m = new Map<string, string[]>();
    for (const p of pointers) m.set(`n:${p.index}`, [...(m.get(`n:${p.index}`) ?? []), p.name]);
    return m;
  };
  const cells = (cellMode: 'cells' | 'bars') =>
    renderArray({ name: v.name, items, total, prevItems: prev?.items, pointers, ranges, mode: cellMode, heap });

  let body: Node;
  if (mode === 'graph' && edgeList) {
    const m = edgeListModel(edgeList);
    const fin = finalNode(v, env);
    const finalModel = (): GraphModel | undefined => {
      const list = fin?.n.items ? edgeListOf(fin.n.items, fin.heap) : undefined;
      return list ? edgeListModel(list) : undefined;
    };
    body = renderGraph(v.name, m, stableLayout(m, fin && { key: fin.n, model: finalModel }), heap, env.vars);
  } else if (mode === 'forest' && unionFind) {
    body = renderTreeModel(forestOf(items as number[]), { title: `union-find forest ${v.name}`, labels: byIndex(), toParent: true });
  } else if (mode === 'tree' && levelOrder) {
    const t = levelOrderTree(items, heap);
    body = renderTreeModel(t ? [t] : [], { title: `level-order tree ${v.name}`, labels: byIndex(), showIndex: true });
  } else if (mode === 'chart' && pts) body = renderChart(pts, v.name);
  else if (mode === 'chart' && numericItems) body = renderChart(items.map((x, i) => [i, numeric(x)!]), `${v.name} by index`);
  else if (mode === 'numberline' && numericItems) body = renderNumberLine([], items.map((x) => numeric(x)!), `${v.name} on a number line`);
  else if (mode === 'heap' && items.length) body = h('div', { class: 'stack' }, renderHeapArray(items, `${v.name} as heap`, heap, v.name), cells('cells'));
  else body = cells(mode === 'bars' ? 'bars' : 'cells');
  const kind = edgeList && mode === 'graph' ? `edge list · ${edgeList.length} edges` : unionFind && mode === 'forest' ? `union-find · ${total} elements` : `${n.kind} · len ${total}`;
  return card(v.name, v.name, `${kind}${where(v, env, at)}`, body, tools);
}
