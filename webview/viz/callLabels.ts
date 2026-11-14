/**
 * Text of recursion-tree nodes (DOM-free, so unit tests can import it):
 * `insert(8, 3)`, `Node(3)`, `backtrack() [1,2]`, and how a call ended.
 */
import { type Encoded, type Heap, fmtPy, isRef } from '../format';
import type { CallNode } from '../traceModel';
import { nodeLabel } from './common';

export function short(v: Encoded | undefined, heap: Heap): string {
  if (v === undefined) return '';
  if (isRef(v)) {
    const n = heap[String(v.ref)];
    if (!n) return '…';
    // insert(8, 3) reads better than insert(TreeNode, 3).
    if (n.kind === 'object') return nodeLabel(n, heap);
    const len = n.len ?? n.items?.length ?? n.entries?.length;
    // Sequences read as their first values: merge_sort([38,27,43…]).
    if (n.items && (n.kind === 'list' || n.kind === 'tuple') && n.items.every((x) => !isRef(x))) {
      const shown = n.items.slice(0, 3).map((x) => fmtPy(x)).join(',');
      const total = n.len ?? n.items.length;
      return n.kind === 'list' ? `[${shown}${total > 3 ? '…' : ''}]` : `(${shown}${total > 3 ? '…' : ''})`;
    }
    return `${n.kind}[${len ?? '?'}]`;
  }
  const t = fmtPy(v, heap);
  return t.length > 10 ? t.slice(0, 9) + '…' : t;
}

export function callLabel(c: CallNode, heapAt: (k: number) => Heap): string {
  const heap = heapAt(c.startStep);
  // A method's self is the same object in every call: Node(3), not
  // __init__(Node, 3); _insert(3, 5), not _insert(BST, 3, 5).
  const method = c.args.length > 0 && (c.args[0][0] === 'self' || c.args[0][0] === 'cls');
  const args = method ? c.args.slice(1) : c.args;
  const cls = c.qual.split('.').slice(-2)[0];
  const name = method && c.func === '__init__' && cls && cls !== '__init__' ? cls : c.func;
  let text = `${name}(${args.map(([, v]) => short(v, heap)).join(', ')})`;
  // A closure without parameters (backtrack()) differs by what it sees:
  // show the first list or set it reads, as it was when the call started.
  if (!args.length && !method && c.seen) text += ` ${short(c.seen, heap)}`;
  return text.length > 24 ? text.slice(0, 23) + '…' : text;
}

/** How a finished call ended, for its node: "→ 5", "✗ IndexError", nothing for None. */
export function callEnd(c: CallNode, heap: Heap): string {
  if (c.raised === 'GeneratorExit') return 'closed';
  if (c.raised !== undefined) return `✗ ${c.raised}`;
  return c.ret === null || c.ret === undefined ? '' : `→ ${short(c.ret, heap)}`;
}
