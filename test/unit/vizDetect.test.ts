/**
 * Detection rules of the DSA drawings that the review of the visualizer
 * found wrong: tuple layouts of edge lists, directed edge lists, grid-graph
 * adjacency, dicts of lists that are not graphs, int-pair lists, list-of-
 * lists adjacency, string grids, negative-size union-find, computed index
 * pointers, bound pairs, the enumerate index, the current matrix cell and
 * names left over from a finished loop.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Encoded, Heap, HeapNode } from '../../webview/format';
import { KeyMemo, itemKeys } from '../../webview/viz/common';
import { adjacencyModel, edgeListModel, layoutGraph, listAdjacencyModel, looksLikeGraph, vertexText } from '../../webview/viz/graphModel';
import { GRAPH_NAME } from '../../webview/viz/names';
import { FrameLike, boundRanges, evalIndex, matrixPointers, sequencePointers } from '../../webview/viz/pointers';
import {
  edgeLayout,
  edgeListOf,
  isCharGrid,
  isDirectedEdgeList,
  isListAdjacency,
  isPointList,
  isTableShaped,
  isUnionFindArray,
  rowsOf,
} from '../../webview/viz/shapes';
import { isLive, parseSource } from '../../webview/viz/sourceHints';
import { forestOf, linkedOrder, objectTree, treeRefs } from '../../webview/viz/treeModel';

const ref = (id: number) => ({ ref: id });
function heapOf(nodes: Record<number, HeapNode>): Heap {
  const h: Heap = {};
  for (const [k, v] of Object.entries(nodes)) h[k] = v;
  return h;
}
const list = (items: Encoded[]): HeapNode => ({ kind: 'list', items, len: items.length });
const tuple = (items: Encoded[]): HeapNode => ({ kind: 'tuple', items, len: items.length });
const dict = (entries: [Encoded, Encoded][]): HeapNode => ({ kind: 'dict', entries, len: entries.length });
const frame = (func: string, locals: Record<string, Encoded>, line?: number): FrameLike => ({ func, line, locals: Object.entries(locals) });
const names = (ps: Array<{ name: string; index: number }>) => ps.map((p) => `${p.name}=${p.index}`).sort();

/** A heap holding one list of tuples at id 1 (tuples from id 10 on). */
function tuplesHeap(rows: Encoded[][], kind: 'tuple' | 'list' = 'tuple'): Heap {
  const nodes: Record<number, HeapNode> = { 1: list(rows.map((_, i) => ref(10 + i))) };
  rows.forEach((r, i) => (nodes[10 + i] = kind === 'tuple' ? tuple(r) : list(r)));
  return heapOf(nodes);
}

describe('edge lists', () => {
  const KRUSKAL = 'edges = [(7, 0, 1), (5, 0, 2), (1, 1, 2)]\nedges.sort()\nmst = []\nfor w, u, v in edges:\n    mst.append((w, u, v))\n';

  it('(w, u, v) tuples: the weight position comes from the names the source unpacks and builds them with', () => {
    const hints = parseSource(KRUSKAL);
    const heap = tuplesHeap([[7, 0, 1], [5, 0, 2], [1, 1, 2]]);
    const lay = edgeLayout(hints, ['edges']);
    assert.deepEqual([lay.u, lay.v, lay.w], [1, 2, 0]);
    assert.deepEqual(edgeListOf(heap[1]!.items!, heap, lay), [{ u: '0', v: '1', w: '7' }, { u: '0', v: '2', w: '5' }, { u: '1', v: '2', w: '1' }]);
    const mstLay = edgeLayout(hints, ['mst']);
    assert.equal(mstLay.w, 0);
    // Without any hint the usual (u, v, w).
    const plain = edgeLayout(parseSource('edges = []\n'), ['edges']);
    assert.deepEqual([plain.u, plain.v, plain.w], [0, 1, 2]);
  });

  it('the sort key gives the weight position too', () => {
    const lay = edgeLayout(parseSource('edges.sort(key=lambda e: e[2])\n'), ['edges']);
    assert.equal(lay.w, 2);
    const first = edgeLayout(parseSource('edges = sorted(roads, key=lambda t: t[0])\n'), ['edges']);
    assert.equal(first.w, 0);
  });

  it('directed: relaxed along (Bellman-Ford), or u->v and v->u with different weights', () => {
    const bf = parseSource('for u, v, w in edges:\n    if dist[u] + w < dist[v]:\n        dist[v] = dist[u] + w\n');
    const heap = tuplesHeap([[0, 1, 4], [1, 2, 6], [0, 2, 9]]);
    const lay = edgeLayout(bf, ['edges']);
    const list3 = edgeListOf(heap[1]!.items!, heap, lay)!;
    assert.equal(isDirectedEdgeList(list3, bf, lay.names, lay), true);
    const kr = parseSource('for u, v, w in edges:\n    if find(u) != find(v):\n        union(u, v)\n');
    assert.equal(isDirectedEdgeList(list3, kr, edgeLayout(kr, ['edges']).names, lay), false);
    const anti = [{ u: '1', v: '2', w: '6' }, { u: '2', v: '1', w: '1' }];
    assert.equal(isDirectedEdgeList(anti, undefined, undefined, lay), true);
    assert.equal(isDirectedEdgeList([{ u: '1', v: '2', w: '3' }, { u: '2', v: '1', w: '3' }], undefined, undefined, lay), false);
    assert.equal(edgeListModel(anti, true).directed, true);
  });
});

describe('adjacency dicts', () => {
  it('a grid graph {(r, c): [(nr, nc)]} has tuple vertices, not (neighbour, weight) pairs', () => {
    const heap = heapOf({
      1: dict([[ref(2), ref(5)], [ref(3), ref(6)], [ref(4), ref(7)]]),
      2: tuple([0, 0]),
      3: tuple([0, 1]),
      4: tuple([1, 0]),
      5: list([ref(8), ref(9)]),
      6: list([ref(10)]),
      7: list([ref(11)]),
      8: tuple([0, 1]),
      9: tuple([1, 0]),
      10: tuple([0, 0]),
      11: tuple([0, 0]),
    });
    const m = adjacencyModel(heap[1]!, heap);
    assert.deepEqual(m.nodes, ['(0,0)', '(0,1)', '(1,0)']);
    assert.ok(m.edges.every((e) => e.weight === undefined));
    assert.equal(m.directed, false);
  });

  it('(neighbour, weight) pairs, and ((r, c), w) with a tuple neighbour', () => {
    const w = heapOf({ 1: dict([['A', ref(2)], ['B', ref(4)]]), 2: list([ref(3)]), 3: tuple(['B', 4]), 4: list([]) });
    assert.deepEqual(adjacencyModel(w[1]!, w).edges, [{ from: 'A', to: 'B', weight: '4' }]);
    const ints = heapOf({ 1: dict([[0, ref(2)], [1, ref(4)]]), 2: list([ref(3)]), 3: tuple([1, 5]), 4: list([]) });
    assert.deepEqual(adjacencyModel(ints[1]!, ints).edges, [{ from: '0', to: '1', weight: '5' }]);
    const cell = heapOf({ 1: dict([[ref(2), ref(3)]]), 2: tuple([0, 0]), 3: list([ref(4)]), 4: tuple([ref(5), 3]), 5: tuple([0, 1]) });
    assert.deepEqual(adjacencyModel(cell[1]!, cell).edges, [{ from: '(0,0)', to: '(0,1)', weight: '3' }]);
  });

  it('a dict of plain lists is a table unless it is named like a graph or its items are keys', () => {
    const positions = heapOf({ 1: dict([[3, ref(2)], [1, ref(3)], [2, ref(4)]]), 2: list([0, 2, 5]), 3: list([1, 4]), 4: list([3]) });
    assert.equal(looksLikeGraph('positions', positions[1]!, positions, GRAPH_NAME), false);
    assert.equal(looksLikeGraph('graph', positions[1]!, positions, GRAPH_NAME), true);
    const groups = heapOf({ 1: dict([['dgo', ref(2)], ['act', ref(3)]]), 2: list(['dog', 'god']), 3: list(['cat', 'act']) });
    assert.equal(looksLikeGraph('groups', groups[1]!, groups, GRAPH_NAME), false);
    const deps = heapOf({ 1: dict([['a', ref(2)], ['b', ref(3)], ['c', ref(4)]]), 2: list(['b', 'c']), 3: list(['c']), 4: list([]) });
    assert.equal(looksLikeGraph('requires', deps[1]!, deps, GRAPH_NAME), true);
  });

  it('long vertex labels keep their distinguishing tail', () => {
    assert.equal(vertexText('math1'), 'math1');
    const cut = ['prerequisite_1', 'prerequisite_2'].map(vertexText);
    assert.notEqual(cut[0], cut[1]);
    const h = heapOf({ 1: dict([['course_alpha', ref(2)], ['course_beta', ref(3)], ['course_gamma', ref(4)]]), 2: list(['course_beta', 'course_gamma']), 3: list([]), 4: list([]) });
    const lay = layoutGraph(adjacencyModel(h[1]!, h));
    const [b, g] = [lay.pos.get('course_beta')!, lay.pos.get('course_gamma')!];
    assert.ok(Math.abs(b[0] - g[0]) > 2 * 45, 'wide labels get wider spacing');
  });
});

describe('lists of rows', () => {
  it('lists of int pairs are tables; tuples of pairs are values; point names plot', () => {
    const lists = tuplesHeap([[1, 4], [2, 5]], 'list');
    assert.equal(isTableShaped(lists[1]!, lists, 'intervals', undefined), true);
    const tuples = tuplesHeap([[0, 2], [1, 1]]);
    assert.equal(isTableShaped(tuples[1]!, tuples, 'queries', undefined), false);
    // Indexed two deep (dp[i][0]): a table whatever the rows are.
    assert.equal(isTableShaped(tuples[1]!, tuples, 'dp', parseSource('x = dp[i][0]\n')), true);
    assert.equal(isPointList('points', undefined), true);
    assert.equal(isPointList('pairs', parseSource('for x, y in pairs:\n    pass\n')), true);
    assert.equal(isPointList('pairs', parseSource('for a, b in pairs:\n    pass\n')), false);
  });

  it('a list of neighbour lists is a graph when the code says so', () => {
    const heap: Heap = {};
    const rows: Encoded[][] = [[1, 2], [0], [0, 3], [2]];
    assert.equal(isListAdjacency('adj', rows, heap, undefined), true);
    const walked = parseSource('for v in nbrs_of[u]:\n    if not visited[v]:\n        stack.append(v)\n');
    assert.equal(isListAdjacency('nbrs_of', rows, heap, walked), true);
    // Same values, but a DP table: nothing walks it as a graph.
    assert.equal(isListAdjacency('dp', rows, heap, parseSource('dp[i][j] = dp[i - 1][j]\n')), false);
    assert.equal(isListAdjacency('adj', [[1, 4], [0]], heap, undefined), false); // 4 is no row
    // [[1, 0], [2, 0], ...] unpacked as `for a, b in prerequisites`: pairs, not neighbour lists.
    const pairs = parseSource('for a, b in prerequisites:\n    graph[b].append(a)\n');
    assert.equal(isListAdjacency('prerequisites', [[1, 0], [2, 0], [3, 1], [3, 2]], heap, pairs), false);
    assert.equal(isListAdjacency('prerequisites', [[1, 0], [2, 0], [3, 1], [3, 2]], heap, undefined), false);
    const m = listAdjacencyModel(rows, heap);
    assert.deepEqual(m.nodes, ['0', '1', '2', '3']);
    assert.equal(m.directed, false);
  });

  it('a list of strings is a grid of characters when it is indexed two deep or named like one', () => {
    const maze: HeapNode = list(['..#', '.#.']);
    assert.deepEqual(rowsOf(maze, {}, true), [['.', '.', '#'], ['.', '#', '.']]);
    assert.equal(rowsOf(maze, {}, false), undefined);
    assert.equal(isCharGrid('grid', undefined), true);
    assert.equal(isCharGrid('m', parseSource('if m[r][c] == "#":\n    pass\n')), true);
    assert.equal(isCharGrid('words', parseSource('for w in words:\n    pass\n')), false);
    // A string the kernel cut short is not a whole row.
    assert.equal(rowsOf(list([{ $t: 'str', v: '....', len: 200 }]), {}, true), undefined);
  });

  it('union-find with negative sizes at the roots', () => {
    assert.ok(isUnionFindArray([-4, 0, 0, 2, -1], 5));
    assert.deepEqual(forestOf([-4, 0, 0, 2, -1]).map((r) => r.label), ['0', '4']);
  });
});

describe('index pointers', () => {
  it('s[i - 1] points at i - 1, not at i', () => {
    const hints = parseSource('for i in range(1, m + 1):\n    for j in range(1, n + 1):\n        if s[i - 1] == t[j - 1]:\n            dp[i][j] = dp[i - 1][j - 1] + 1\n');
    const r = sequencePointers('abcab', 0, 5, [frame('<module>', { s: 'abcab', t: 'cab', i: 1, j: 3, m: 5, n: 3 })], hints);
    assert.deepEqual(names(r.pointers), ['i-1=0']);
    const t = sequencePointers('cab', 0, 3, [frame('<module>', { s: 'abcab', t: 'cab', i: 1, j: 3 })], hints);
    assert.deepEqual(names(t.pointers), ['j-1=2']);
  });

  it('dp[a - c] next to dp[a]: a, and the computed a-c; dp[i - 1] next to dp[i] adds nothing', () => {
    const coins = parseSource('for a in range(1, amount + 1):\n    for c in coins:\n        if c <= a:\n            dp[a] = min(dp[a], dp[a - c] + 1)\n');
    const dp = ref(1);
    assert.deepEqual(names(sequencePointers(dp, 0, 8, [frame('<module>', { dp, a: 6, c: 2 })], coins).pointers), ['a-c=4', 'a=6']);
    const fib = parseSource('for i in range(2, n + 1):\n    dp[i] = dp[i - 1] + dp[i - 2]\n');
    assert.deepEqual(names(sequencePointers(dp, 0, 8, [frame('<module>', { dp, i: 5 })], fib).pointers), ['i=5']);
    // nums[start:end + 1] is the inclusive range start..end, not a pointer at end + 1.
    const kad = parseSource('for i in range(len(nums)):\n    if cur > best:\n        start, end = s, i\nprint(nums[start:end + 1])\n');
    const r = sequencePointers(dp, 0, 9, [frame('<module>', { nums: dp, start: 1, end: 3, i: 5 })], kad);
    assert.deepEqual(names(r.pointers), ['end=3', 'start=1']);
    // a[n - 1] with n = len(a) is just the last element.
    const last = parseSource('n = len(a)\nx = a[n - 1]\n');
    assert.deepEqual(sequencePointers(dp, 0, 5, [frame('<module>', { a: dp, n: 5 })], last).pointers, []);
  });

  it('evaluates int index arithmetic as Python does', () => {
    const ints = new Map([['lo', 3], ['hi', 8], ['i', -7]]);
    assert.equal(evalIndex('(lo+hi)//2', ints), 5);
    assert.equal(evalIndex('i//2', ints), -4);
    assert.equal(evalIndex('i%3', ints), 2);
    assert.equal(evalIndex('-1+lo', ints), 2);
    assert.equal(evalIndex('lo+x', ints), undefined);
    assert.equal(evalIndex('lo//0', ints), undefined);
  });

  it("a bound pair indexing another sequence is no bound of this one (segment tree's l, r, mid)", () => {
    const src = 'def build(node, l, r):\n    if l == r:\n        seg[node] = arr[l]\n        return\n    mid = (l + r) // 2\n    build(2 * node, l, mid)\n    seg[node] = seg[2 * node] + seg[2 * node + 1]\n';
    const hints = parseSource(src);
    const seg = ref(1);
    const arr = ref(2);
    const frames = [frame('<module>', { seg, arr }), frame('build', { node: 2, l: 0, r: 1, mid: 0 })];
    assert.deepEqual(names(sequencePointers(seg, 0, 16, frames, hints).pointers), ['node=2']);
    assert.deepEqual(names(sequencePointers(arr, 0, 4, frames, hints).pointers), ['l=0', 'mid=0', 'r=1']);
  });

  it('sizes and upper-case names are not bounds; l..r is shaded only when used as a range', () => {
    const grid = parseSource('R, C = len(grid), len(grid[0])\nfor r in range(R):\n    x = grid[r]\n');
    const g = ref(1);
    assert.deepEqual(names(sequencePointers(g, 0, 3, [frame('<module>', { grid: g, R: 3, C: 10, r: 1 })], grid).pointers), ['r=1']);
    const heapify = parseSource('l = 2 * i + 1\nr = 2 * i + 2\nif l < n and a[l] > a[big]:\n    big = l\nif r < n and a[r] > a[big]:\n    big = r\n');
    const lr = [{ name: 'l', index: 1 }, { name: 'r', index: 2 }];
    assert.deepEqual(boundRanges(lr, 7, heapify), []);
    const bs = parseSource('while l <= r:\n    m = (l + r) // 2\n');
    assert.deepEqual(boundRanges(lr, 7, bs), [{ from: 1, to: 2, names: ['l', 'r'] }]);
    // A segment's l..r: compared for equality and split at the midpoint.
    const seg = parseSource('def build(node, l, r):\n    if l == r:\n        return\n    mid = (l + r) // 2\n');
    assert.deepEqual(boundRanges(lr, 7, seg), [{ from: 1, to: 2, names: ['l', 'r'] }]);
    // `for start, end in intervals`: start is an item's value, not a bound.
    const iv = parseSource('for start, end in intervals:\n    merged.append([start, end])\n');
    assert.deepEqual(sequencePointers(g, 0, 5, [frame('<module>', { intervals: g, start: 2, end: 6 })], iv).pointers, []);
    // The recursive form tests the pair the other way round.
    const rec = parseSource('def search(a, t, lo, hi):\n    if lo > hi:\n        return -1\n');
    assert.deepEqual(boundRanges([{ name: 'lo', index: 0 }, { name: 'hi', index: 9 }], 10, rec), [{ from: 0, to: 9, names: ['lo', 'hi'] }]);
  });

  it('the enumerate index points into the sequence (not with a start)', () => {
    const nums = ref(1);
    const hints = parseSource('for i, x in enumerate(nums):\n    best = max(best, x)\n');
    assert.deepEqual(names(sequencePointers(nums, 0, 4, [frame('<module>', { nums, i: 1, x: 8 })], hints).pointers), ['i=1']);
    const from1 = parseSource('for i, x in enumerate(nums, 1):\n    best = max(best, x)\n');
    assert.deepEqual(sequencePointers(nums, 0, 4, [frame('<module>', { nums, i: 1, x: 8 })], from1).pointers, []);
  });

  it('a container in a field (self.heap) takes its pointers from the method holding the object', () => {
    const hints = parseSource('class MinHeap:\n    def push(self, x):\n        self.heap.append(x)\n        i = len(self.heap) - 1\n        while i > 0:\n            p = (i - 1) // 2\n            if self.heap[p] <= self.heap[i]:\n                break\n');
    const h = ref(1);
    const arr = ref(2);
    const frames = [frame('<module>', { h }), frame('push', { self: h, x: 1, i: 3, p: 1 })];
    const r = sequencePointers(arr, 0, 4, frames, hints, { owner: h, field: 'heap' });
    assert.equal(r.at.frame, 1);
    assert.deepEqual(names(r.pointers), ['i=3', 'p=1']);
  });
});

describe('the line about to run', () => {
  const SPIRAL = 'grid = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]\nn = 3\ntop = 0\nbottom = 2\nout = []\nfor i in range(n):\n    out.append(grid[top][i])\nfor i in range(n):\n    out.append(grid[bottom][i])\nprint(out)\n';

  it('the solid matrix cell is the subscript on the current line', () => {
    const hints = parseSource(SPIRAL);
    const grid = ref(1);
    const at = (line: number, i: number) => matrixPointers(grid, 0, 3, 3, [frame('<module>', { grid, n: 3, top: 0, bottom: 2, i }, line)], hints);
    const m9 = at(9, 0);
    assert.deepEqual([m9.row?.name, m9.row?.index, m9.col?.index], ['bottom', 2, 0]);
    const m7 = at(7, 1);
    assert.deepEqual([m7.row?.name, m7.col?.index], ['top', 1]);
    // After both loops i is a leftover: no current cell.
    const end = at(10, 2);
    assert.equal(end.col, undefined);
  });

  it('names the code never uses as one subscript make no cell (only the row stays)', () => {
    const hints = parseSource('while top <= bottom:\n    for i in range(left, right + 1):\n        out.append(m[top][i])\n    top += 1\n    for i in range(top, bottom + 1):\n        out.append(m[i][right])\n    right -= 1\n');
    const m = ref(1);
    const mk = matrixPointers(m, 0, 3, 4, [frame('<module>', { m, top: 1, bottom: 2, left: 0, right: 2, i: 2 }, 7)], hints);
    assert.deepEqual([mk.row?.name, mk.col], ['top', undefined]);
  });

  it('a transpose: a[r][c] is the cell, a[c][r] the probe', () => {
    const hints = parseSource('for r in range(n):\n    for c in range(r + 1, n):\n        a[r][c], a[c][r] = a[c][r], a[r][c]\n');
    const a = ref(1);
    const m = matrixPointers(a, 0, 3, 3, [frame('<module>', { a, n: 3, r: 0, c: 2 }, 3)], hints);
    assert.deepEqual([m.row?.index, m.col?.index], [0, 2]);
    assert.deepEqual(m.probes, [{ r: 2, c: 0, names: ['c', 'r'] }]);
  });

  it('names bound only in a finished loop are not live; parameters and top-level names are', () => {
    const src = 'def bfs(start):\n    seen = {start}\n    q = [start]\n    while q:\n        u = q.pop(0)\n        for v in graph[u]:\n            q.append(v)\n    return seen\nfor a, b in pairs:\n    adj[a].append(b)\nprint(adj)\n';
    const h = parseSource(src);
    assert.equal(isLive(h, 'u', 7), true);
    assert.equal(isLive(h, 'v', 7), true);
    assert.equal(isLive(h, 'v', 5), false); // the inner loop has not started for this u
    assert.equal(isLive(h, 'u', 8), false);
    assert.equal(isLive(h, 'start', 8), true);
    assert.equal(isLive(h, 'seen', 8), true);
    assert.equal(isLive(h, 'a', 10), true);
    assert.equal(isLive(h, 'a', 11), false);
    assert.equal(isLive(h, 'anything', undefined), true);
  });
});

describe('trees and lists', () => {
  it('a degenerate chain deeper than 40 is drawn whole', () => {
    const nodes: Record<number, HeapNode> = {};
    for (let i = 1; i <= 46; i++) nodes[i] = { kind: 'object', type: 'Node', fields: [['val', i - 1], ['left', null], ['right', i < 46 ? ref(i + 1) : null]] };
    const heap = heapOf(nodes);
    assert.equal(treeRefs(objectTree(1, heap)).size, 46);
  });

  it('linked lists stop at a cycle', () => {
    const heap = heapOf({
      1: { kind: 'object', type: 'L', fields: [['val', 1], ['next', ref(2)]] },
      2: { kind: 'object', type: 'L', fields: [['val', 2], ['next', ref(1)]] },
    });
    assert.deepEqual(linkedOrder(1, heap), { order: [1, 2], cycleTo: 1 });
  });
});

describe('animation keys after one push or pop', () => {
  const run = (steps: Encoded[][]) => {
    let memo: KeyMemo | undefined;
    return steps.map((items) => (memo = itemKeys(items, memo)).keys);
  };

  it('heappush (append and sift up in one step): surviving values keep their keys', () => {
    const [k0, k1] = run([[3, 5, 8], [1, 3, 8, 5]]);
    assert.deepEqual([k1[1], k1[2], k1[3]], [k0[0], k0[2], k0[1]]);
    assert.ok(!k0.includes(k1[0]));
  });

  it('heappop: the last value keeps its key at the root; equal values keep their own index', () => {
    const [k0, k1] = run([[1, 3, 2, 5, 9, 8], [8, 3, 2, 5, 9]]);
    assert.equal(k1[0], k0[5]);
    assert.deepEqual(k1.slice(1), k0.slice(1, 5));
    const [d0, d1] = run([[2, 2, 2], [2, 2, 2, 2]]);
    assert.deepEqual(d1.slice(0, 3), d0);
  });
});
