/**
 * Recursion tree: every call of a traced function as a node `f(args)`,
 * children in call order, the return value once it returned. Calls on the
 * current stack are highlighted; later calls are not drawn yet.
 */
import { s, svgRoot } from '../dom';
import { type Encoded, type Heap, fmtScalar, isRef } from '../format';
import type { CallNode, TraceModel } from '../traceModel';

const MAX_NODES = 300;
const DY = 56;

interface Laid {
  call: CallNode;
  x: number;
  depth: number;
  kids: Laid[];
}

function short(v: Encoded | undefined, heap: Heap): string {
  if (v === undefined) return '';
  if (isRef(v)) {
    const n = heap[String(v.ref)];
    if (!n) return '…';
    if (n.kind === 'object') return n.type ?? 'obj';
    const len = n.len ?? n.items?.length ?? n.entries?.length;
    // Sequences read as their first values: merge_sort([38,27,43…]).
    if (n.items && (n.kind === 'list' || n.kind === 'tuple') && n.items.every((x) => !isRef(x))) {
      const shown = n.items.slice(0, 3).map((x) => fmtScalar(x)).join(',');
      const total = n.len ?? n.items.length;
      return n.kind === 'list' ? `[${shown}${total > 3 ? '…' : ''}]` : `(${shown}${total > 3 ? '…' : ''})`;
    }
    return `${n.kind}[${len ?? '?'}]`;
  }
  const t = fmtScalar(v, heap);
  return t.length > 10 ? t.slice(0, 9) + '…' : t;
}

export function callLabel(c: CallNode, heapAt: (k: number) => Heap): string {
  const heap = heapAt(c.startStep);
  const args = c.args.map(([, v]) => short(v, heap)).join(', ');
  const text = `${c.func}(${args})`;
  return text.length > 24 ? text.slice(0, 23) + '…)' : text;
}

/**
 * Draws the calls made up to step k. `onPick(step)` jumps to the start of a
 * clicked call.
 */
export function renderCallTree(model: TraceModel, k: number, heapAt: (k: number) => Heap, onPick: (step: number) => void): SVGSVGElement | undefined {
  const calls = model.calls();
  const roots: CallNode[] = [];
  let count = 0;
  for (const c of calls.values()) {
    if (c.startStep > k) continue;
    count++;
    if (c.parent === undefined || !calls.has(c.parent)) roots.push(c);
  }
  if (!count) return undefined;
  const active = new Set(model.activeCalls(k));
  const top = model.activeCalls(k).at(-1);

  let nextX = 0;
  let drawn = 0;
  let maxDepth = 0;
  const lay = (c: CallNode, depth: number): Laid | undefined => {
    if (drawn >= MAX_NODES || c.startStep > k) return undefined;
    drawn++;
    maxDepth = Math.max(maxDepth, depth);
    const kids: Laid[] = [];
    for (const id of c.children) {
      const child = calls.get(id);
      const l = child ? lay(child, depth + 1) : undefined;
      if (l) kids.push(l);
    }
    // Leaves take the next column; a parent sits over its children.
    const x = kids.length ? (kids[0].x + kids[kids.length - 1].x) / 2 : nextX++;
    return { call: c, x, depth, kids };
  };
  const laid = roots.map((r) => lay(r, 0)).filter((l): l is Laid => l !== undefined);
  // Column width from the longest label, so fib(3) trees stay compact and
  // merge_sort([38, 27, 43]) labels do not overlap.
  const labels = new Map<number, string>();
  const collect = (l: Laid) => {
    labels.set(l.call.fid, callLabel(l.call, heapAt));
    l.kids.forEach(collect);
  };
  laid.forEach(collect);
  const longest = Math.max(4, ...[...labels.values()].map((t) => t.length));
  const DX = Math.min(160, Math.max(46, longest * 6.4 + 16));
  const width = Math.max(1, nextX) * DX + 20;
  const height = (maxDepth + 1) * DY + 30;
  const svg = svgRoot(width, height, `recursion tree with ${drawn} calls`);
  // Shrunk to the card width a wide tree became unreadable: scroll instead.
  svg.classList.add('no-shrink');
  const X = (l: Laid) => 10 + l.x * DX + DX / 2;
  const Y = (l: Laid) => 18 + l.depth * DY;
  const edges: SVGElement[] = [];
  const nodes: SVGElement[] = [];
  const walk = (l: Laid) => {
    for (const c of l.kids) {
      edges.push(s('line', { x1: X(l), y1: Y(l) + 10, x2: X(c), y2: Y(c) - 10, class: `edge ${active.has(c.call.fid) ? 'hot-call' : ''}`, 'data-anim-edge': '' }));
      walk(c);
    }
    const c = l.call;
    const done = c.endStep !== undefined && c.endStep <= k;
    const cls = ['call', c.fid === top ? 'current' : active.has(c.fid) ? 'active' : done ? 'done' : 'open'].join(' ');
    const label = labels.get(c.fid) ?? '';
    const w = Math.min(DX - 6, Math.max(28, label.length * 6.4 + 10));
    const g = s('g', { class: cls, 'data-anim': `c:${c.fid}` },
      s('rect', { x: X(l) - w / 2, y: Y(l) - 10, width: w, height: 20, rx: 4 }),
      s('text', { x: X(l), y: Y(l) + 4, 'text-anchor': 'middle', class: 'call-text' }, label),
      s('title', {}, `${label}  (step ${c.startStep + 1}${done ? `, returned ${fmtScalar(c.ret, heapAt(c.endStep!))}` : ''}) — click to jump here`));
    if (done) {
      const ret = short(c.ret, heapAt(c.endStep!));
      g.appendChild(s('text', { x: X(l), y: Y(l) + 22, 'text-anchor': 'middle', class: 'call-ret' }, `→ ${ret}`));
    }
    g.addEventListener('click', () => onPick(c.startStep));
    nodes.push(g);
  };
  laid.forEach(walk);
  edges.forEach((e) => svg.appendChild(e));
  nodes.forEach((e) => svg.appendChild(e));
  if (drawn >= MAX_NODES) {
    svg.appendChild(s('text', { x: 10, y: height - 6, class: 'muted-text' }, `first ${MAX_NODES} calls shown`));
  }
  return svg;
}
