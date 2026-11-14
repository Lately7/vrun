/**
 * Chooses and renders a view for every variable of a snapshot: arrays and
 * strings, number line, function graph, matrix, graph, tree, trie, linked
 * list, heap, union-find forest.
 */
import { button, h } from '../dom';
import { Encoded, Heap, HeapNode, isRef, numeric } from '../format';
import { renderArray } from './arrayView';
import { renderChart } from './chartView';
import { Var, allNumeric, cellText, isPointerName, itemType, memberRefs, node, pyText, refLabels, sameEncoded, shortScalar } from './common';
import { GraphModel, adjacencyModel, edgeListModel, isAdjacency, listAdjacencyModel, looksLikeGraph, stableLayout, vertexKey } from './graphModel';
import { renderGraph } from './graphView';
import { renderMatrix } from './matrixView';
import { DIST, EDGE_LIST_NAME, END_KEY, FRONTIER, GRAPH_NAME, HEAP_NAME, LEVEL_ORDER_NAME, ORDER_NAME, PATH, QUEUE_NAME, ROOT_NAME, UNION_FIND_NAME, VISITED, WAITING_NAME } from './names';
import { Mark, renderNumberLine } from './numberLine';
import {
  FieldOf,
  FrameLike,
  Pointer,
  PointerFrame,
  boundRanges,
  framesFromVars,
  legacyMatrixPointers,
  legacyPointers,
  matrixPointers,
  sameTarget,
  sequencePointers,
} from './pointers';
import {
  cellMarks,
  charsOf,
  edgeLayout,
  edgeListOf,
  isCharGrid,
  isDictTrie,
  isDirectedEdgeList,
  isLevelOrder,
  isListAdjacency,
  isPointList,
  isTableShaped,
  isUnionFindArray,
  pairsOf,
  rowsOf,
  stringAxes,
} from './shapes';
import { SourceHints, isLive, isScanned, sourceHints } from './sourceHints';
import { MAX_LIST_NODES, TNode, dictTrie, forestOf, isListNode, isTreeNode, levelOrderTree, linkedOrder, objectTree, treeRefs } from './treeModel';
import { brokenLinks, renderHeapArray, renderLinkedList, renderTreeModel } from './treeView';

export type ArrayMode = 'bars' | 'cells' | 'chart' | 'numberline' | 'heap' | 'forest' | 'tree' | 'graph' | 'matrix' | 'table';

export interface StructureState {
  modes: Map<string, ArrayMode>;
}

export interface StructureContext {
  /** Traced source; line numbers are 1-based like TraceStep.line. */
  source?: string;
  /** Every frame of the current step, outermost first, with all of its locals (not de-duplicated). Var.depth indexes this. */
  frames?: Array<{ func: string; line?: number; locals: Array<[string, Encoded]> }>;
  /** Variables and heap at the last step of the trace, for layouts that should not move while stepping. */
  final?: { vars: Var[]; heap: Heap };
  /** The step's event: on 'return' the innermost frame has finished, what it left broken stays broken. */
  event?: 'line' | 'return' | 'exception';
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
  /** Heap ids drawn as a card of their own. */
  drawnRefs: Set<number>;
  /** Vertices of the graphs drawn so far: a list of them is a visiting order, not bar heights. */
  graphVertices: Set<string>;
}

/**
 * What one card draws: a variable, or a container held in an object's field
 * (h.heap). `v.name` is the name the shape rules read (`heap`, `parent`);
 * `title` names the card, its animation scope and its saved view mode.
 */
interface Subject {
  v: Var;
  title: string;
  via?: FieldOf;
  final?: () => { n: HeapNode; heap: Heap } | undefined;
}

// Object structures (trees, linked lists) share one scope: a node keeps its
// key n:<id> when it moves from one list to another (reversal), and a card
// is not renamed away when the variable that reaches the structure changes.
const OBJECT_SCOPE = '§objects';

const MODE_LABEL: Partial<Record<ArrayMode, string>> = { numberline: 'number line' };
const CONTAINERS = ['list', 'tuple', 'deque', 'set', 'frozenset', 'dict', 'ndarray'];

function card(scope: string, title: string, subtitle: string, body: Node, tools?: Node): HTMLElement {
  return h(
    'section',
    // Shared by several cards: measured across them, so a node moving from
    // one list's card to the other's slides there.
    { class: 'viz-card', 'data-anim-scope': scope, 'data-anim-shared': scope === OBJECT_SCOPE ? '' : undefined },
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

/**
 * Marks what a tree drawing shows as covered: its nodes and the children
 * containers of those nodes. Only placed nodes: a variable pointing past a
 * cut (the node cap) still gets drawn.
 */
function coverTree(t: TNode | undefined, heap: Heap, covered: Set<number>): void {
  for (const r of treeRefs(t)) {
    covered.add(r);
    const n = heap[String(r)];
    if (n?.kind !== 'object') continue;
    for (const [, val] of n.fields ?? []) {
      const c = node(heap, val);
      if (isRef(val) && c && c.kind !== 'object') covered.add(val.ref);
    }
  }
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

/**
 * A parameter that shadows an outer structure (search(root, key) on the
 * module's root, insert(root.left, v)) would leave only the subtree on
 * screen. The outer binding is drawn whole under its own name, and the
 * inner one becomes a label on it: 'root (search)'. Only when the inner
 * value lies inside the outer structure, or is None (insert reached a
 * leaf), so a function's unrelated local of the same name is left alone.
 */
function unshadow(vars: Var[], heap: Heap, frames: FrameLike[]): Var[] {
  const out = [...vars];
  for (let i = 0; i < vars.length; i++) {
    const inner = vars[i];
    if (inner.depth === 0 || !(inner.value === null || isRef(inner.value))) continue;
    let outer: Var | undefined;
    for (let d = 0; d < inner.depth && !outer; d++) {
      const hit = frames[d]?.locals.find(([n]) => n === inner.name);
      if (hit && isRef(hit[1]) && !sameTarget(hit[1], inner.value)) outer = { name: inner.name, value: hit[1], depth: d };
    }
    if (!outer || !isRef(outer.value)) continue;
    const kind = heap[String(outer.value.ref)]?.kind;
    if (kind !== 'object' && kind !== 'dict') continue;
    if (isRef(inner.value)) {
      const reach = new Set<number>();
      reachable(outer.value.ref, heap, reach, 1500);
      if (!reach.has(inner.value.ref)) continue;
    }
    const func = frames[inner.depth]?.func ?? '';
    out[i] = { ...inner, name: `${inner.name} (${func})` };
    out.push(outer);
  }
  return out;
}

export function renderStructures(vars: Var[], heap: Heap, prevHeap: Heap | undefined, state: StructureState, rerender: () => void, ctx?: StructureContext): HTMLElement {
  const frames = ctx?.frames ?? framesFromVars(vars);
  if (ctx?.frames) vars = unshadow(vars, heap, frames);
  const env: Env = {
    vars,
    heap,
    prevHeap,
    state,
    rerender,
    ctx,
    hints: ctx?.source ? sourceHints(ctx.source) : undefined,
    frames,
    finalVars: new Map(),
    covered: new Set(),
    drawnRefs: new Set(),
    graphVertices: new Set(),
  };
  for (const v of ctx?.final?.vars ?? []) if (!env.finalVars.has(v.name)) env.finalVars.set(v.name, v);
  const root = h('div', { class: 'viz-grid' });
  let marks: Mark[] = [];
  const { drawnRefs } = env;
  // Variables whose object came after the trace's object cap: said, not dropped.
  const notSent: string[] = [];

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
    if (!n) {
      if (!notSent.includes(v.name)) notSent.push(v.name);
      continue;
    }
    // u = (0, 1) on a grid graph is a vertex, already marked on the graph.
    if (n.kind === 'tuple' && env.graphVertices.has(vertexKey(v.value, heap) ?? '\u0000')) continue;
    drawnRefs.add(ref);
    const els = n.kind === 'object' ? renderObject(v, ref, n, env) : [renderOne({ v, title: v.name }, n, prevHeap?.[String(ref)] ?? undefined, env)];
    for (const el of els) if (el) root.appendChild(el);
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
  if (notSent.length) {
    root.appendChild(
      card('§not-sent', notSent.join(', '), 'not shown: too many objects',
        h('p', { class: 'muted small' }, `The trace keeps a limited number of objects per step, and ${notSent.length === 1 ? 'this variable' : 'these variables'} came after the limit. A smaller input shows ${notSent.length === 1 ? 'it' : 'them'}.`)),
    );
  }
  if (!root.childElementCount) root.appendChild(h('p', { class: 'muted' }, 'No variables to draw at this step yet.'));
  return root;
}

/** 'len 700 (first 512 shown)': the cut is said where it is read first, not only at the end of a long row. */
function lenText(total: number, sent: number): string {
  return total > sent ? `len ${total} (first ${sent} shown)` : `len ${total}`;
}

/** '600 keys (first 512 shown)'. */
function keysText(n: HeapNode): string {
  const sent = n.entries?.length ?? 0;
  const total = n.len ?? sent;
  return total > sent ? `${total} keys (first ${sent} shown)` : `${total} keys`;
}

/** Rows a dict table draws before it keeps only some: a memo of 600 keys would be a 10,000 px table. */
const DICT_ROWS = 40;

/**
 * The rows of a dict table: all of them, or for a long dict the first and
 * last keys and those the step added or changed (memo[n] = ...), with a
 * '… 120 keys …' row where rows are left out.
 */
function dictRows(n: HeapNode, prev: HeapNode | undefined, row: (k: Encoded, val: Encoded) => HTMLElement): HTMLElement[] {
  const entries = n.entries ?? [];
  if (entries.length <= DICT_ROWS) return entries.map(([k, val]) => row(k, val));
  const keep = new Set<number>();
  for (let i = 0; i < 12; i++) keep.add(i);
  for (let i = entries.length - 4; i < entries.length; i++) keep.add(i);
  if (prev?.kind === 'dict') {
    const before = new Map((prev.entries ?? []).map(([k, val]) => [JSON.stringify(k), val]));
    let changed = 0;
    entries.forEach(([k, val], i) => {
      const key = JSON.stringify(k);
      if (changed < 12 && !keep.has(i) && (!before.has(key) || !sameEncoded(before.get(key), val))) {
        keep.add(i);
        changed++;
      }
    });
  }
  const out: HTMLElement[] = [];
  let skipped = 0;
  const gap = () => {
    if (skipped) out.push(h('tr', { class: 'cut-row', title: 'Rows not drawn: a long dict shows its first and last keys and the ones that changed at this step' }, h('td', { colspan: 2, class: 'muted' }, `… ${skipped} keys …`)));
    skipped = 0;
  };
  entries.forEach(([k, val], i) => {
    if (!keep.has(i)) {
      skipped++;
      return;
    }
    gap();
    out.push(row(k, val));
  });
  gap();
  return out;
}

function prevOf(ref: number, env: Env): HeapNode | undefined {
  return env.prevHeap?.[String(ref)] ?? undefined;
}

/** "… 214 more keys not shown" as the last row of a dict table, when the kernel sent only part of it. */
function cutRow(n: HeapNode, what: string): HTMLElement | null {
  const sent = n.entries?.length ?? n.items?.length ?? 0;
  const total = n.len ?? sent;
  return total > sent ? h('tr', { class: 'cut-row' }, h('td', { colspan: 2, class: 'muted' }, `… ${total - sent} more ${what} not shown`)) : null;
}

/**
 * ' · visited: 64 of 278 shown' for the visited / frontier / path / dist
 * collections a graph or grid colours, when they were cut: the uncoloured
 * vertices are not unvisited.
 */
function cutNotes(env: Env): string {
  const parts: string[] = [];
  for (const v of env.vars) {
    if (!(VISITED.test(v.name) || FRONTIER.test(v.name) || PATH.test(v.name) || DIST.test(v.name))) continue;
    const n = node(env.heap, v.value);
    const sent = n?.entries?.length ?? n?.items?.length;
    if (n && sent !== undefined && n.len !== undefined && n.len > sent) parts.push(`${v.name}: ${sent} of ${n.len} shown`);
  }
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

/**
 * A wrapper's node-valued fields as pointer labels by heap id: dll.head,
 * dll.tail at module level, self.head, self.tail inside a method (the name
 * the innermost frame gives the object, as the code there reads).
 */
function fieldLabels(v: Var, n: HeapNode, env: Env): Map<number, string[]> {
  let owner = v.name;
  for (let d = env.frames.length - 1; d >= 0; d--) {
    const hit = env.frames[d].locals.find(([, val]) => sameTarget(val, v.value));
    if (hit) {
      owner = hit[0];
      break;
    }
  }
  const out = new Map<number, string[]>();
  for (const [f, val] of n.fields ?? []) {
    if (!isRef(val) || env.heap[String(val.ref)]?.kind !== 'object') continue;
    out.set(val.ref, [...(out.get(val.ref) ?? []), `${owner}.${f}`]);
  }
  return out;
}

/** Variable names, then field labels, per heap id. */
function mergeLabels(a: Map<number, string[]>, b?: Map<number, string[]>): Map<number, string[]> {
  const out = new Map([...a].map(([k, v]) => [k, [...v]]));
  for (const [k, names] of b ?? []) for (const name of names) {
    const list = out.get(k) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(k, list);
  }
  return out;
}

/** Scalar fields of a wrapper (size=3, count=5), which the drawing of its structure would otherwise hide. */
function scalarFields(n: HeapNode): string {
  const parts = (n.fields ?? []).filter(([, val]) => !isRef(val) && val !== null && typeof val !== 'object').map(([k, val]) => `${k}=${shortScalar(val)}`);
  return parts.length ? ` · ${parts.slice(0, 4).join(', ')}` : '';
}

/** Nodes waiting in a stack / queue / heap (also inside (val, i, node) tuples), and the containers' names for the legend. */
function waiting(env: Env, refs: Set<number>): { keys: Set<string>; legend: string } {
  const members = memberRefs(env.vars, env.heap, WAITING_NAME);
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const [r, name] of members) if (refs.has(r)) {
    keys.add(`n:${r}`);
    names.add(name);
  }
  return { keys, legend: names.size ? ` · outlined: in ${[...names].join(', ')}` : '' };
}

function seqPointers(sub: Subject, len: number, env: Env): { pointers: Pointer[]; at?: PointerFrame } {
  if (env.hints) return sequencePointers(sub.v.value, sub.v.depth, len, env.frames, env.hints, sub.via, env.heap);
  return { pointers: legacyPointers(env.vars, len) };
}

function renderString(v: Var, chars: string, env: Env): HTMLElement | undefined {
  // Only strings the code walks through: indexed (s[i]) or scanned (for ch in s).
  if (!env.hints || chars.length < 2) return undefined;
  const total = typeof v.value === 'string' ? chars.length : ((v.value as { len?: number }).len ?? chars.length);
  // The variable itself must be walked: `w` passed to insert(word) is drawn once, as `word`.
  if (!isScanned(env.hints, [v.name])) return undefined;
  const { pointers, at } = sequencePointers(v.value, v.depth, total, env.frames, env.hints, undefined, env.heap);
  const items = [...chars];
  const body = renderArray({ name: v.name, items, total, pointers, ranges: boundRanges(pointers, items.length, env.hints), mode: 'cells', chars: true });
  return card(v.name, v.name, `str · ${lenText(total, items.length)}${where(v, env, pointers.length ? at : undefined)}`, body);
}

function finalNode(sub: Subject, env: Env): { n: HeapNode; heap: Heap } | undefined {
  if (sub.final) return sub.final();
  const f = env.finalVars.get(sub.v.name);
  const fh = env.ctx?.final?.heap;
  if (!f || !fh || !isRef(f.value)) return undefined;
  const n = fh[String(f.value.ref)];
  return n ? { n, heap: fh } : undefined;
}

/** The value of `owner.field` at the last step. */
function finalField(owner: Var, field: string, env: Env): { n: HeapNode; heap: Heap } | undefined {
  const o = finalNode({ v: owner, title: owner.name }, env);
  const val = o?.n.fields?.find(([k]) => k === field)?.[1];
  const n = o ? node(o.heap, val) : undefined;
  return n && o ? { n, heap: o.heap } : undefined;
}

/** Every name the frames give the object, plus the subject's own: for reading the source's tuple shapes. */
function aliasesOf(sub: Subject, env: Env): string[] {
  const out = new Set<string>([sub.v.name]);
  for (const f of env.frames) for (const [n, val] of f.locals) if (sameTarget(val, sub.v.value)) out.add(n);
  return [...out];
}

/** Whether a name still means something on its frame's line: the u / v of a finished loop do not. */
function liveVar(env: Env): (v: Var) => boolean {
  const hints = env.hints;
  if (!hints) return () => true;
  return (v) => isLive(hints, v.name, env.frames[v.depth]?.line);
}

function modeTools(sub: Subject, modes: ArrayMode[], mode: ArrayMode, env: Env): Node | undefined {
  if (modes.length < 2) return undefined;
  return h(
    'span',
    { class: 'seg', role: 'group', 'aria-label': 'view' },
    ...modes.map((m) =>
      button(MODE_LABEL[m] ?? m, () => {
        env.state.modes.set(sub.title, m);
        env.rerender();
      }, { cls: `seg-btn ${m === mode ? 'on' : ''}`, pressed: m === mode }),
    ),
  );
}

function pickMode(sub: Subject, modes: ArrayMode[], env: Env): ArrayMode {
  const saved = env.state.modes.get(sub.title);
  return saved && modes.includes(saved) ? saved : modes[0];
}

function treeCard(v: Var, title: string, kind: string, root: TNode | undefined, env: Env, fields?: Map<number, string[]>, extra = ''): HTMLElement {
  const trie = !!root && hasEdgeLabels(root);
  coverTree(root, env.heap, env.covered);
  const labels = new Map([...mergeLabels(refLabels(env.vars), fields)].map(([r, names]) => [`n:${r}`, names]));
  // The nodes waiting in a stack / queue are what iterative traversals are about.
  const wait = waiting(env, treeRefs(root));
  const body = renderTreeModel(root ? [root] : [], { title: `tree ${title}`, labels, frontier: wait.keys });
  const cut = hasCut(root) ? ' · some nodes not shown (too many objects; … marks where)' : '';
  return card(OBJECT_SCOPE, title, `${trie ? 'trie' : 'tree'}${kind ? ` (${kind})` : ''}${extra}${cut}${wait.legend}${where(v, env)}`, body);
}

function hasCut(t: TNode | undefined): boolean {
  const stack = t ? [t] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.cut) return true;
    for (const c of n.children) if (c) stack.push(c);
  }
  return false;
}

/** A wrapper's fields that hold the end of its list. */
const TAIL_FIELD = /^(tail|last|rear|end|back)$/i;
const HEAD_FIELD = /^(head|first|front|root|start|begin)$/i;

function endRank(field: string): number {
  return HEAD_FIELD.test(field) ? 0 : TAIL_FIELD.test(field) ? 2 : 1;
}

/** Its next or prev field points at a node of `order`: it was part of that list. */
function linksInto(n: HeapNode | null | undefined, order: number[]): boolean {
  return (n?.fields ?? []).some(([k, val]) => (k === 'next' || k === 'prev') && isRef(val) && order.includes(val.ref));
}

/**
 * The structure's own method that is running: a frame whose `self` is one
 * of the list's nodes or a wrapper holding one in a field (dll.head), the
 * outermost such frame (the call the learner made, not its helper). Not on
 * that frame's return step. A main() that merely holds the list is no such
 * method: a link it leaves broken is a bug.
 */
function runningMethod(nodes: Set<number>, heap: Heap, frames: FrameLike[] | undefined, event?: string): string | undefined {
  if (!frames) return undefined;
  const last = event === 'return' ? frames.length - 2 : frames.length - 1;
  for (let d = 0; d <= last; d++) {
    const f = frames[d];
    if (f.func === '<module>') continue;
    const self = f.locals.find(([n]) => n === 'self')?.[1];
    if (self === undefined || !isRef(self)) continue;
    if (nodes.has(self.ref) || (heap[String(self.ref)]?.fields ?? []).some(([, val]) => isRef(val) && nodes.has(val.ref))) return f.func;
  }
  return undefined;
}

function listCard(v: Var, title: string, ref: number, subtitle: string, env: Env, fields?: Map<number, string[]>): HTMLElement {
  const { order } = linkedOrder(ref, env.heap);
  const drawnElsewhere = new Set(order.filter((r) => env.covered.has(r)));
  for (const r of order) env.covered.add(r);
  const wait = waiting(env, new Set(order));
  const pending = runningMethod(new Set(order), env.heap, env.ctx?.frames, env.ctx?.event);
  const drawOpts = { labels: mergeLabels(refLabels(env.vars), fields), frontier: wait.keys, fromHead: fields !== undefined, drawnElsewhere, pending };
  const svg = renderLinkedList(ref, env.heap, env.vars, `linked list ${title}`, drawOpts);
  // In words too: inside push_front / remove() for a step or two (correct
  // code: said calmly), or for good when the learner forgot
  // node.next.prev = node.prev (red once the method has returned).
  const note = (text: string) =>
    pending
      ? h('p', { class: 'pending-note small', title: `${pending} is still running: it changes one link per line, so for a step or two the links disagree. If this is still here after ${pending} returns, it is a bug.` }, `not linked yet (inside ${pending}): ${text}`)
      : h('p', { class: 'hot-note small' }, text);
  const broken = brokenLinks(ref, env.heap, drawOpts).map((why) => note(pending ? why : `broken link: ${why}`));
  // dll.tail left on a node that remove() unlinked has no box to label: say
  // where it points. Not for a second list the wrapper holds (Merger.l2).
  const last = env.heap[String(order[order.length - 1])];
  const whole = order.length < MAX_LIST_NODES && last?.fields?.find(([k]) => k === 'next')?.[1] === null;
  const strayEnd = (r: number, names: string[]) => names.some((name) => TAIL_FIELD.test(name.slice(name.lastIndexOf('.') + 1))) || linksInto(env.heap[String(r)], order);
  const stray = whole ? [...(fields ?? [])].filter(([r, names]) => !order.includes(r) && isListNode(env.heap[String(r)] ?? undefined, env.heap) && strayEnd(r, names)) : [];
  const notes = stray.map(([r, names]) => {
    const n = env.heap[String(r)];
    return note(`${names.join(', ')} → the node ${n ? shortScalar({ ref: r }, env.heap) : '…'}, which is not in this list`);
  });
  notes.unshift(...broken);
  return card(OBJECT_SCOPE, title, `${subtitle}${wait.legend}`, notes.length ? h('div', {}, svg, ...notes) : svg);
}

function hasEdgeLabels(t: TNode, depth = 0): boolean {
  if (depth > 3) return false;
  return t.children.some((c) => c !== null && (c.edge !== undefined || hasEdgeLabels(c, depth + 1)));
}

function renderObject(v: Var, ref: number, n: HeapNode, env: Env): Array<HTMLElement | undefined> {
  const { heap } = env;
  if (isTreeNode(n, heap)) return [treeCard(v, v.name, n.type ?? '', objectTree(ref, heap), env)];
  if (isListNode(n, heap)) return [listCard(v, v.name, ref, `linked list (${n.type})${where(v, env)}`, env)];
  // Course-style wrappers (LinkedList with .head, BST / Trie with .root):
  // draw the structure held in the field rather than a one-row field table.
  // Its node fields (head, tail) label the nodes, its counters (size) go
  // into the subtitle.
  // The head first, so the list is drawn from where it starts; a second
  // list of its own (Merger.l1, Merger.l2) gets its own card, a tail does not.
  const lists: HTMLElement[] = [];
  for (const [field, val] of [...(n.fields ?? [])].sort(([a], [b]) => endRank(a) - endRank(b))) {
    const inner = node(heap, val);
    if (!isRef(val) || !inner) continue;
    if (!lists.length && isTreeNode(inner, heap)) return [treeCard(v, `${v.name}.${field}`, `${inner.type} in ${n.type}`, objectTree(val.ref, heap), env, fieldLabels(v, n, env), scalarFields(n))];
    if (!isListNode(inner, heap)) continue;
    if (lists.length && (TAIL_FIELD.test(field) || env.covered.has(val.ref))) continue;
    const extra = lists.length ? '' : scalarFields(n);
    lists.push(listCard(v, `${v.name}.${field}`, val.ref, `linked list (${inner.type}) in ${n.type}${extra}${where(v, env)}`, env, fieldLabels(v, n, env)));
  }
  if (lists.length) return lists;
  // MinHeap.heap, UnionFind.parent, Graph.adj, an LRU's dict: each container
  // field is drawn like a variable of that name, so `heap` is a heap and
  // `parent` a forest, and the method's i / p point into it.
  const out: Array<HTMLElement | undefined> = [];
  const rest: Array<[string, Encoded]> = [];
  for (const [field, val] of n.fields ?? []) {
    const inner = node(heap, val);
    if (!isRef(val) || !inner || !CONTAINERS.includes(inner.kind)) {
      rest.push([field, val]);
      continue;
    }
    if (env.drawnRefs.has(val.ref) || env.covered.has(val.ref)) continue;
    env.drawnRefs.add(val.ref);
    const sub: Subject = { v: { name: field, value: val, depth: v.depth }, title: `${v.name}.${field}`, via: { owner: v.value, field }, final: () => finalField(v, field, env) };
    out.push(renderOne(sub, inner, env.prevHeap?.[String(val.ref)] ?? undefined, env));
  }
  if (!out.length || rest.some(([, val]) => val !== null && !isRef(val))) {
    const rows = (out.length ? rest : n.fields ?? []).map(([k, val]) => h('tr', {}, h('th', {}, k), h('td', {}, cellText(val, heap))));
    out.unshift(card(v.name, v.name, `${n.type} object${where(v, env)}`, h('table', { class: 'kv' }, ...rows)));
  }
  return out;
}

/** Every value a dict or an end marker: a trie under construction (its first word has no depth-2 dict yet). */
function trieShaped(n: HeapNode, heap: Heap): boolean {
  return (n.entries ?? []).every(([k, val]) => node(heap, val)?.kind === 'dict' || (typeof k === 'string' && END_KEY.test(k) && !isRef(val)));
}

/** key -> its list as a row of cells: a value -> positions map, grouped anagrams. */
function listTable(n: HeapNode, heap: Heap, prev?: HeapNode): HTMLElement {
  const rows = dictRows(n, prev, (k, val) => {
    const c = node(heap, val);
    const texts: string[] = c?.kind === 'dict' ? (c.entries ?? []).map(([a, b]) => `${cellText(a, heap)}: ${cellText(b, heap)}`) : (c?.items ?? []).map((x) => cellText(x, heap));
    // A row of 512 chips would wrap into a wall; the count says the rest.
    const items = texts.slice(0, 32);
    const more = (c?.len ?? texts.length) - items.length;
    return h('tr', {}, h('th', {}, cellText(k, heap)), h('td', {}, ...items.map((t) => h('span', { class: 'chip' }, t)), more > 0 ? h('span', { class: 'muted' }, ` … ${more} more not shown`) : null, items.length ? null : h('span', { class: 'muted' }, 'empty')));
  });
  return h('table', { class: 'kv list-table' }, ...rows, cutRow(n, 'keys'));
}

function renderDict(sub: Subject, ref: number, n: HeapNode, env: Env): HTMLElement {
  const { heap } = env;
  const v = sub.v;
  const fin = finalNode(sub, env);
  // The final value decides, so a trie is a trie from its first insert on
  // instead of a one-vertex graph that later turns into a tree.
  const trie = trieShaped(n, heap) && (isDictTrie(n, heap) || (fin !== undefined && isDictTrie(fin.n, fin.heap)));
  if (trie) {
    const t = dictTrie(ref, heap);
    return treeCard(v, sub.title, 'nested dict', t, env);
  }
  if (isAdjacency(n, heap)) {
    // A graph by name, or when nearly every neighbour is a key, judged on
    // the final dict: a graph being built has neighbours not yet added.
    const graphy = fin && isAdjacency(fin.n, fin.heap) ? looksLikeGraph(v.name, fin.n, fin.heap, GRAPH_NAME) : looksLikeGraph(v.name, n, heap, GRAPH_NAME);
    const modes: ArrayMode[] = graphy ? ['graph', 'table'] : ['table', 'graph'];
    const mode = pickMode(sub, modes, env);
    const tools = modeTools(sub, modes, mode, env);
    if (mode === 'graph') {
      const m = adjacencyModel(n, heap);
      for (const k of m.nodes) env.graphVertices.add(k);
      const layout = stableLayout(m, fin && { key: fin.n, model: () => (isAdjacency(fin.n, fin.heap) ? adjacencyModel(fin.n, fin.heap) : undefined) });
      const cut = (n.len ?? 0) > (n.entries?.length ?? 0) ? ` · ${n.len! - n.entries!.length} more keys not shown` : '';
      return card(sub.title, sub.title, `graph · ${m.nodes.length} vertices${cut}${cutNotes(env)}${where(v, env)}`, renderGraph(sub.title, m, layout, heap, env.vars, liveVar(env)), tools);
    }
    return card(sub.title, sub.title, `dict · ${keysText(n)}${where(v, env)}`, listTable(n, heap, prevOf(ref, env)), tools);
  }
  // The cell is short ('2222322…' for memo[299]); the tooltip has the whole value.
  const rows = dictRows(n, prevOf(ref, env), (k, val) => h('tr', {}, h('th', {}, cellText(k, heap)), h('td', { title: pyText(val, heap) }, cellText(val, heap))));
  return card(sub.title, sub.title, `dict · ${keysText(n)}${where(v, env)}`, h('table', { class: 'kv' }, ...rows, cutRow(n, 'keys')));
}

function matrixCard(sub: Subject, rows: Encoded[][], prevRows: Encoded[][] | undefined, kind: string, env: Env, tools?: Node): HTMLElement {
  const v = sub.v;
  const nrows = rows.length;
  const ncols = Math.max(0, ...rows.map((r) => r.length));
  const marks = env.hints ? matrixPointers(v.value, v.depth, nrows, ncols, env.frames, env.hints, sub.via) : legacyMatrixPointers(env.vars);
  const axes = env.hints ? stringAxes(env.vars, env.hints, nrows, ncols, marks.rowNames, marks.colNames) : {};
  const body = renderMatrix({ name: sub.title, rows, prev: prevRows, heap: env.heap, marks, cells: cellMarks(env.vars, env.heap, nrows, ncols), ...axes });
  // A 100 x 100 grid arrives as its first 64 rows and columns: say so.
  const [R, C] = trueDims(node(env.heap, v.value), env.heap, nrows, ncols);
  const size = R > nrows || C > ncols ? `${R}×${C} (first ${nrows}×${ncols} shown)` : `${nrows}×${ncols}`;
  return card(sub.title, sub.title, `${kind} ${size}${where(v, env, marks.row || marks.col ? marks.at : undefined)}`, body, tools);
}

/** Rows and columns of a table before the kernel's item cap. */
function trueDims(n: HeapNode | undefined, heap: Heap, rows: number, cols: number): [number, number] {
  if (!n) return [rows, cols];
  if (n.kind === 'ndarray' && n.shape?.length === 2) return [n.shape[0], n.shape[1]];
  let c = cols;
  for (const it of n.items ?? []) {
    const r = node(heap, it);
    // A row of a char grid may be a str the kernel cut ({$t: 'str', len}).
    const len = r ? r.len : it !== null && typeof it === 'object' && !isRef(it) ? it.len : undefined;
    if (typeof len === 'number') c = Math.max(c, len);
  }
  return [Math.max(rows, n.len ?? rows), c];
}

/** Views a list of rows offers, best first, decided on the final value so the card does not switch view as the list grows. */
function rowModes(sub: Subject, n: HeapNode, heap: Heap, rows: Encoded[][], chars: boolean, env: Env): ArrayMode[] {
  const name = sub.v.name;
  const fin = finalNode(sub, env);
  const shape = fin && fin.n.kind === n.kind && rowsOf(fin.n, fin.heap, chars) ? fin : { n, heap };
  const shapeRows = rowsOf(shape.n, shape.heap, chars) ?? rows;
  if (!chars && isListAdjacency(name, shapeRows, shape.heap, env.hints) && isListAdjacency(name, rows, heap, env.hints)) return ['graph', 'matrix'];
  const pairs = pairsOf(shape.n.items ?? [], shape.heap) !== undefined || pairsOf(n.items ?? [], heap) !== undefined;
  if (!pairs) return ['matrix'];
  if (isPointList(name, env.hints)) return ['chart', 'matrix'];
  // Lists the code fills in (intervals, a 2-column DP table) are tables;
  // tuples of two numbers read best as cells, (1, 3).
  if (chars || isTableShaped(shape.n, shape.heap, name, env.hints)) return ['matrix', 'chart'];
  return ['cells', 'chart', 'matrix'];
}

function renderOne(sub: Subject, n: HeapNode, prev: HeapNode | undefined, env: Env): HTMLElement | undefined {
  const { heap } = env;
  const v = sub.v;
  const name = v.name;
  const ref = (v.value as { ref: number }).ref;
  if (n.kind === 'object') return undefined;
  if (n.kind === 'dict') return renderDict(sub, ref, n, env);
  if (n.kind === 'ndarray' && n.rows) return matrixCard(sub, n.rows, prev?.rows, `ndarray ${n.dtype ?? ''}`.trim(), env);

  const items = n.items ?? [];
  const total = n.len ?? items.length;
  const ordered = n.kind === 'list' || n.kind === 'tuple' || n.kind === 'ndarray';
  // Queues and stacks hold items to process (often (row, col) tuples):
  // neither y = f(x) data, a table, nor something indices point into.
  const queueLike = n.kind === 'deque' || QUEUE_NAME.test(name);
  const layout = EDGE_LIST_NAME.test(name) ? edgeLayout(env.hints, aliasesOf(sub, env)) : undefined;
  const edgeList = layout ? edgeListOf(items, heap, layout) : undefined;
  const unionFind = ordered && UNION_FIND_NAME.test(name) && isUnionFindArray(items, total);
  const levelOrder = ordered && !unionFind && LEVEL_ORDER_NAME.test(name) && isLevelOrder(items);
  const heapNamed = HEAP_NAME.test(name);
  const chars = isCharGrid(name, env.hints);
  const rows = !edgeList && !queueLike && !heapNamed && !unionFind && !levelOrder ? rowsOf(n, heap, chars) : undefined;
  const pts = edgeList || queueLike || /edge/i.test(name) ? undefined : pairsOf(items, heap);
  const numericItems = allNumeric(items);
  // Visited cells, a queue or a path of (r, c) pairs are coordinates, not
  // y = f(x); a set is never a function graph by default.
  const cellish = n.kind === 'set' || VISITED.test(name) || FRONTIER.test(name) || PATH.test(name);
  // seen = {0, 1, 3}, order = [0, 1, 3]: vertex ids, which bars and a
  // number line would turn into quantities.
  // Distinct ones: rank = [1, 0, 0, 1] holds small ints too, but repeats them.
  const keys = items.map((x) => vertexKey(x, heap) ?? '\u0000');
  const vertexIds =
    VISITED.test(name) || PATH.test(name) || ORDER_NAME.test(name) || (!DIST.test(name) && keys.length >= 2 && new Set(keys).size === keys.length && keys.every((k) => env.graphVertices.has(k)));
  let modes: ArrayMode[];
  if (edgeList) modes = ['graph', 'cells'];
  else if (unionFind) modes = ['forest', 'cells', 'bars'];
  else if (levelOrder) modes = ['tree', 'cells'];
  // adj = [[] for _ in range(n)] is a graph of n vertices before its first edge.
  else if (rows && (rows.some((r) => r.length > 0) || isListAdjacency(name, rows, heap, env.hints))) modes = rowModes(sub, n, heap, rows, items.some((x) => charsOf(x) !== undefined), env);
  else if (pts) modes = cellish ? ['cells', 'chart'] : ['chart', 'cells'];
  else if (numericItems) {
    modes = ['bars', 'cells', 'chart', 'numberline', 'heap'];
    if (heapNamed) modes = ['heap', ...modes.filter((m) => m !== 'heap')];
    // A stack or queue holds work items (vertex ids, indices), not heights.
    else if (vertexIds || queueLike) modes = ['cells', ...modes.filter((m) => m !== 'cells')];
    else if (n.kind === 'set') modes = ['numberline', ...modes.filter((m) => m !== 'numberline')];
  } else modes = heapNamed ? ['heap', 'cells'] : ['cells'];
  // Views that need what the current value does not have yet (a chart of
  // one pair) drop out until it does.
  modes = modes.filter((m) => (m === 'chart' ? !!pts || numericItems : m === 'matrix' || m === 'graph' ? !!rows || !!edgeList : true));
  if (!modes.length) modes = ['cells'];
  const mode = pickMode(sub, modes, env);
  const tools = modeTools(sub, modes, mode, env);

  if (rows && mode === 'matrix') {
    const prevRows = prev ? rowsOf(prev, env.prevHeap ?? heap, chars) : undefined;
    return matrixCard(sub, rows, prevRows, n.kind, env, tools);
  }
  if (rows && mode === 'graph' && !edgeList) {
    const m = listAdjacencyModel(rows, heap);
    for (const k of m.nodes) env.graphVertices.add(k);
    const fin = finalNode(sub, env);
    const finalModel = (): GraphModel | undefined => {
      const r = fin ? rowsOf(fin.n, fin.heap) : undefined;
      return r ? listAdjacencyModel(r, fin!.heap) : undefined;
    };
    const body = renderGraph(sub.title, m, stableLayout(m, fin && { key: fin.n, model: finalModel }), heap, env.vars, liveVar(env));
    // adj of 700 lists arrives as its first 512: the rest are vertices too, and a cut visited set leaves some uncoloured.
    const cut = total > items.length ? ` · ${total - items.length} more not shown` : '';
    return card(sub.title, sub.title, `graph · ${m.nodes.length} vertices (list of lists)${cut}${cutNotes(env)}${where(v, env)}`, body, tools);
  }

  // Pointers make sense only on ordered sequences one indexes into.
  const pointable = ordered && !queueLike && !edgeList && items.length > 0;
  const { pointers, at } = pointable ? seqPointers(sub, total, env) : { pointers: [] as Pointer[], at: undefined };
  const ranges = boundRanges(pointers, items.length, env.hints);
  const byIndex = () => {
    const m = new Map<string, string[]>();
    for (const p of pointers) m.set(`n:${p.index}`, [...(m.get(`n:${p.index}`) ?? []), p.name]);
    return m;
  };
  const cells = (cellMode: 'cells' | 'bars') =>
    renderArray({ name: sub.title, items, total, prevItems: prev?.items, pointers, ranges, mode: cellMode, heap });

  let body: Node;
  // 'list of str': ['10', '2'] from input().split() is not a list of ints;
  // 'deque of TreeNode': its cells show the nodes' values.
  const of = itemType(items, heap);
  let kind = `${n.kind}${of ? ` of ${of}` : ''} · ${lenText(total, items.length)}`;
  if (mode === 'graph' && edgeList && layout) {
    const directed = isDirectedEdgeList(edgeList, env.hints, layout.names, layout);
    const m = edgeListModel(edgeList, directed);
    for (const k of m.nodes) env.graphVertices.add(k);
    const fin = finalNode(sub, env);
    const finalModel = (): GraphModel | undefined => {
      const list = fin?.n.items ? edgeListOf(fin.n.items, fin.heap, layout) : undefined;
      return list ? edgeListModel(list, directed) : undefined;
    };
    body = renderGraph(sub.title, m, stableLayout(m, fin && { key: fin.n, model: finalModel }), heap, env.vars, liveVar(env));
    const cut = total > items.length ? ` (first ${items.length} of ${total} shown)` : '';
    kind = `edge list · ${edgeList.length} edges${cut}${directed ? ', directed' : ''}${cutNotes(env)}`;
  } else if (mode === 'forest' && unionFind) {
    body = renderTreeModel(forestOf(items as number[]), { title: `union-find forest ${sub.title}`, labels: byIndex(), toParent: true });
    kind = `union-find · ${total} elements`;
  } else if (mode === 'tree' && levelOrder) {
    const t = levelOrderTree(items, heap);
    body = renderTreeModel(t ? [t] : [], { title: `level-order tree ${sub.title}`, labels: byIndex(), showIndex: true });
  } else if (mode === 'chart' && pts) body = renderChart(pts, sub.title);
  else if (mode === 'chart' && numericItems) body = renderChart(items.map((x, i) => [i, numeric(x)!]), `${sub.title} by index`);
  else if (mode === 'numberline' && numericItems) body = renderNumberLine([], items.map((x) => numeric(x)!), `${sub.title} on a number line`);
  else if (mode === 'heap' && items.length) body = h('div', { class: 'stack' }, renderHeapArray(items, `${sub.title} as heap`, heap, sub.title), cells('cells'));
  else body = cells(mode === 'bars' ? 'bars' : 'cells');
  return card(sub.title, sub.title, `${kind}${where(v, env, pointers.length ? at : undefined)}`, body, tools);
}
