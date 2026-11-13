/**
 * Trees as data, from every shape learners build them in: objects with
 * left/right or children (a list, or a dict of char -> node for a trie),
 * nested dicts (trie = {}; node = node.setdefault(ch, {})), level-order
 * lists ([3, 9, 20, None, None, 15, 7]) and union-find parent arrays.
 * The layout puts leaves in successive columns and a parent over its
 * children; binary nodes use in-order columns so a BST reads sorted.
 * DOM-free.
 */
import { Encoded, Heap, HeapNode, isRef } from '../format';
import { shortScalar } from './common';
import { END_FIELD, END_KEY } from './names';
import { truthy } from './shapes';

export interface TNode {
  /** Animation / identity key: n:<heap id> or n:<index>. */
  key: string;
  label: string;
  /** Label on the edge from the parent: the trie character. */
  edge?: string;
  /** End of a word in a trie. */
  end?: boolean;
  /** Heap id of the node object, to match variables that point at it. */
  ref?: number;
  /** Position in the array it came from (level order, union-find). */
  index?: number;
  /** Children are the [left, right] slots, null for a missing child. */
  binary?: boolean;
  children: Array<TNode | null>;
}

const MAX_NODES = 255;
const MAX_DEPTH = 40;
const LABEL_FIELDS = ['val', 'value', 'key', 'data', 'item', 'name', 'v', 'char', 'ch', 'letter'];
const CHILD_FIELDS = ['children', 'kids', 'child', 'links'];

function field(n: HeapNode, name: string): Encoded | undefined {
  return n.fields?.find(([k]) => k === name)?.[1];
}

function hasField(n: HeapNode, name: string): boolean {
  return (n.fields ?? []).some(([k]) => k === name);
}

/** The field holding a node's children, when it is not left/right. */
export function childField(n: HeapNode, heap: Heap): string | undefined {
  for (const f of CHILD_FIELDS) if (hasField(n, f)) return f;
  // A trie written with `self.next = {}` keys its children by character.
  const nx = field(n, 'next');
  if (isRef(nx) && heap[String(nx.ref)]?.kind === 'dict') return 'next';
  return undefined;
}

export function isTreeNode(n: HeapNode | undefined, heap?: Heap): boolean {
  if (!n || n.kind !== 'object') return false;
  if (hasField(n, 'left') || hasField(n, 'right')) return true;
  return heap ? childField(n, heap) !== undefined : CHILD_FIELDS.some((f) => hasField(n, f));
}

export function isListNode(n: HeapNode | undefined, heap?: Heap): boolean {
  if (!n || n.kind !== 'object' || !hasField(n, 'next')) return false;
  return !heap || childField(n, heap) !== 'next';
}

/** The val / key / data field as text; '' for nodes that only hold structure (a trie node). */
export function treeLabel(n: HeapNode, heap: Heap): string {
  const pick = (n.fields ?? []).find(([k]) => LABEL_FIELDS.includes(k));
  if (!pick || isRef(pick[1])) return '';
  return shortScalar(pick[1], heap);
}

function isEnd(n: HeapNode): boolean {
  return (n.fields ?? []).some(([k, v]) => END_FIELD.test(k) && truthy(v));
}

/** A tree of user objects (left/right, children list or dict, trie nodes). */
export function objectTree(rootRef: number, heap: Heap): TNode | undefined {
  const seen = new Set<number>();
  const build = (ref: number, depth: number, edge?: string): TNode | undefined => {
    if (seen.has(ref) || depth > MAX_DEPTH || seen.size >= MAX_NODES) return undefined;
    const n = heap[String(ref)];
    if (!n || n.kind !== 'object') return undefined;
    seen.add(ref);
    const t: TNode = { key: `n:${ref}`, label: treeLabel(n, heap), edge, end: isEnd(n), ref, children: [] };
    if (hasField(n, 'left') || hasField(n, 'right')) {
      t.binary = true;
      for (const side of ['left', 'right']) {
        const c = field(n, side);
        t.children.push(isRef(c) ? build(c.ref, depth + 1) ?? null : null);
      }
      return t;
    }
    const cf = childField(n, heap);
    const holder = cf ? field(n, cf) : undefined;
    const kids = isRef(holder) ? heap[String(holder.ref)] : undefined;
    if (kids?.kind === 'dict') {
      for (const [k, v] of kids.entries ?? []) if (isRef(v)) {
        const c = build(v.ref, depth + 1, shortScalar(k, heap));
        if (c) t.children.push(c);
      }
    } else if (kids?.items) {
      // children = [None] * 26 is a trie over 'a'..'z'.
      const alpha = kids.items.length === 26;
      kids.items.forEach((v, i) => {
        if (!isRef(v)) return;
        const c = build(v.ref, depth + 1, alpha ? String.fromCharCode(97 + i) : undefined);
        if (c) t.children.push(c);
      });
    }
    return t;
  };
  return build(rootRef, 0);
}

/** A nested-dict trie: keys label the edges, an end key ($, #, end) with a true value marks a word. */
export function dictTrie(rootRef: number, heap: Heap): TNode | undefined {
  const seen = new Set<number>();
  const build = (ref: number, depth: number, edge?: string): TNode | undefined => {
    if (seen.has(ref) || depth > MAX_DEPTH || seen.size >= MAX_NODES) return undefined;
    const n = heap[String(ref)];
    if (!n || n.kind !== 'dict') return undefined;
    seen.add(ref);
    const t: TNode = { key: `n:${ref}`, label: '', edge, ref, children: [] };
    for (const [k, v] of n.entries ?? []) {
      if (typeof k === 'string' && END_KEY.test(k) && !isRef(v)) {
        if (truthy(v)) t.end = true;
        continue;
      }
      if (!isRef(v)) continue;
      const c = build(v.ref, depth + 1, shortScalar(k, heap));
      if (c) t.children.push(c);
    }
    return t;
  };
  return build(rootRef, 0);
}

/** Level-order list: children of i at 2i+1 and 2i+2; a None hides its subtree. */
export function levelOrderTree(items: Encoded[], heap?: Heap): TNode | undefined {
  const build = (i: number, depth: number): TNode | null => {
    if (i >= items.length || items[i] === null || depth > MAX_DEPTH) return null;
    return { key: `n:${i}`, label: shortScalar(items[i], heap), index: i, binary: true, children: [build(2 * i + 1, depth + 1), build(2 * i + 2, depth + 1)] };
  };
  return build(0, 0) ?? undefined;
}

/** Union-find parent array as a forest: one tree per root (parent[i] == i). */
export function forestOf(parent: number[]): TNode[] {
  const nodes: TNode[] = parent.map((_, i) => ({ key: `n:${i}`, label: String(i), index: i, children: [] }));
  const roots: TNode[] = [];
  parent.forEach((p, i) => {
    if (p === i || p < 0 || p >= parent.length) roots.push(nodes[i]);
    else nodes[p].children.push(nodes[i]);
  });
  // A cycle without a root (a bug in the learner's code) would otherwise vanish.
  const reached = new Set<TNode>();
  const mark = (t: TNode) => {
    if (reached.has(t)) return;
    reached.add(t);
    for (const c of t.children) if (c) mark(c);
  };
  roots.forEach(mark);
  for (const t of nodes) if (!reached.has(t)) {
    roots.push(t);
    mark(t);
  }
  return roots;
}

export interface Placed {
  node: TNode;
  /** column (may be fractional: a parent centred over its children) */
  x: number;
  depth: number;
  parent?: Placed;
}

/** Layout of one or more trees side by side; x is in columns, depth in rows. */
export function layoutTrees(roots: TNode[]): { placed: Placed[]; cols: number; depth: number } {
  const placed: Placed[] = [];
  let next = 0;
  let maxDepth = 0;
  const seen = new Set<TNode>();
  const lay = (t: TNode, depth: number, parent?: Placed): Placed => {
    seen.add(t);
    maxDepth = Math.max(maxDepth, depth);
    const p: Placed = { node: t, x: 0, depth, parent };
    placed.push(p);
    const kids = t.children.filter((c): c is TNode => c !== null && !seen.has(c));
    if (t.binary) {
      const [l, r] = t.children;
      if (l && !seen.has(l)) lay(l, depth + 1, p);
      p.x = next++;
      if (r && !seen.has(r)) lay(r, depth + 1, p);
    } else if (kids.length) {
      const xs = kids.map((c) => lay(c, depth + 1, p).x);
      p.x = (xs[0] + xs[xs.length - 1]) / 2;
    } else p.x = next++;
    return p;
  };
  for (const r of roots) if (!seen.has(r)) lay(r, 0);
  return { placed, cols: Math.max(1, next), depth: maxDepth };
}
