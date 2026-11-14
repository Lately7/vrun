/**
 * DOM-free logic behind the DSA drawings (webview/viz): which names index
 * which sequences in the source, which frame's ints are pointers, shape
 * detection (union-find, edge lists, level-order trees, tries, grid cells),
 * graph and tree layouts, and animation keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Encoded, Heap, HeapNode } from '../../webview/format';
import { KeyMemo, itemKeys } from '../../webview/viz/common';
import { adjacencyModel, edgeListModel, layoutGraph, stableLayout } from '../../webview/viz/graphModel';
import { FrameLike, boundRanges, legacyPointers, matrixPointers, pointerFrame, sequencePointers } from '../../webview/viz/pointers';
import { cellMarks, edgeListOf, isDictTrie, isLevelOrder, isUnionFindArray, stringAxes } from '../../webview/viz/shapes';
import { blankStrings, parseSource } from '../../webview/viz/sourceHints';
import { dictTrie, forestOf, layoutTrees, levelOrderTree, objectTree } from '../../webview/viz/treeModel';

const ref = (id: number) => ({ ref: id });

/** A heap from id -> node shorthand. */
function heapOf(nodes: Record<number, HeapNode>): Heap {
  const h: Heap = {};
  for (const [k, v] of Object.entries(nodes)) h[k] = v;
  return h;
}
const list = (items: Encoded[]): HeapNode => ({ kind: 'list', items, len: items.length });
const tuple = (items: Encoded[]): HeapNode => ({ kind: 'tuple', items, len: items.length });
const dict = (entries: [Encoded, Encoded][]): HeapNode => ({ kind: 'dict', entries, len: entries.length });
const frame = (func: string, locals: Record<string, Encoded>): FrameLike => ({ func, locals: Object.entries(locals) });
const names = (ps: Array<{ name: string; index: number }>) => ps.map((p) => `${p.name}=${p.index}`).sort();

const MERGE_SORT = `
def merge_sort(a):
    if len(a) <= 1:
        return a
    mid = len(a) // 2
    left = merge_sort(a[:mid])
    right = merge_sort(a[mid:])
    out = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            out.append(left[i]); i += 1
        else:
            out.append(right[j]); j += 1
    out.extend(left[i:]); out.extend(right[j:])
    return out
print(merge_sort([38, 27, 43, 3, 9, 82, 10]))
`;

const QUICK_SORT = `
def partition(a, lo, hi):
    pivot = a[hi]
    i = lo - 1
    for j in range(lo, hi):
        if a[j] <= pivot:
            i += 1
            a[i], a[j] = a[j], a[i]
    a[i + 1], a[hi] = a[hi], a[i + 1]
    return i + 1

def quick_sort(a, lo, hi):
    if lo < hi:
        p = partition(a, lo, hi)
        quick_sort(a, lo, p - 1)
        quick_sort(a, p + 1, hi)

nums = [10, 7, 8, 9, 1, 5, 3, 12, 6, 2]
quick_sort(nums, 0, len(nums) - 1)
`;

const PERMUTE = `
def permute(nums):
    res = []
    path = []
    used = [False] * len(nums)
    def backtrack():
        if len(path) == len(nums):
            res.append(path[:])
            return
        for i in range(len(nums)):
            if used[i]:
                continue
            used[i] = True
            path.append(nums[i])
            backtrack()
            path.pop()
            used[i] = False
    backtrack()
    return res
`;

describe('source hints', () => {
  it('records the names used inside subscripts, per position', () => {
    const h = parseSource('x = a[j] + a[i + 1]\ny = nums[mid]\nz = a[:mid]\nw = dp[i - 1][j]\nv = grid[r][c] + m[p, q]\n');
    assert.deepEqual([...h.index.get('a')!.dims[0]].sort(), ['i', 'j', 'mid']);
    assert.deepEqual([...h.index.get('nums')!.dims[0]], ['mid']);
    assert.deepEqual([...h.index.get('dp')!.dims[0]], ['i']);
    assert.deepEqual([...h.index.get('dp')!.dims[1]], ['j']);
    assert.deepEqual(h.index.get('grid')!.pairs, [[['r'], ['c']]]);
    assert.deepEqual([...h.index.get('m')!.dims[1]], ['q']);
    assert.deepEqual([...h.indexes.get('mid')!].sort(), ['a', 'nums']);
  });

  it('ignores list literals, called names, attributes, strings and comments', () => {
    const h = parseSource('if x in [1, 2]:\n    return [y]\nb = a[len(a) - 1]\nc = self.items[k]\nd = "s[i]"  # t[j]\n');
    assert.equal(h.index.has('in'), false);
    assert.equal(h.index.has('return'), false);
    assert.deepEqual([...h.index.get('a')!.dims[0]], ['a']); // len( is a call, not an index
    assert.deepEqual([...h.index.get('items')!.dims[0]], ['k']);
    assert.deepEqual([...h.index.get('self.items')!.dims[0]], ['k']);
    assert.equal(h.index.has('s'), false);
    assert.equal(h.index.has('t'), false);
    assert.equal(blankStrings('a = "x[i]" # y[j]\nb').split('\n').length, 2);
  });

  it('knows which sequences are scanned', () => {
    const h = parseSource('for right, ch in enumerate(s):\n    pass\nfor x in xs:\n    pass\nn = len(arr)\nfor p, q in zip(us, vs):\n    pass\nys = [e for e in edges if e]\n');
    for (const n of ['s', 'xs', 'arr', 'us', 'vs', 'edges']) assert.ok(h.scanned.has(n), n);
    assert.equal(h.scanned.has('range'), false);
    assert.ok(h.sizes.has('n'));
  });

  it('separates local names from closure / global ones per function', () => {
    const ms = parseSource(MERGE_SORT).funcs.get('merge_sort')!;
    for (const n of ['a', 'mid', 'left', 'right', 'out', 'i', 'j']) assert.ok(ms.locals.has(n), n);
    const pm = parseSource(PERMUTE);
    const bt = pm.funcs.get('backtrack')!;
    assert.ok(bt.mentions.has('nums') && !bt.locals.has('nums'));
    assert.ok(bt.locals.has('i'));
    assert.ok(pm.funcs.get('permute')!.locals.has('backtrack'));
    const g = parseSource('count = 0\ndef inc(k):\n    global count\n    count += k\n    total, rest = 1, 2\n').funcs.get('inc')!;
    assert.equal(g.locals.has('count'), false);
    assert.ok(g.locals.has('k') && g.locals.has('total') && g.locals.has('rest'));
  });

  it('finds size names from plain len() assignments only', () => {
    const h = parseSource('m, n = len(a), len(b)\ni, j = 0, len(s) - 1\nrows, cols = len(grid), len(grid[0])\n');
    assert.deepEqual([...h.sizes].sort(), ['cols', 'm', 'n', 'rows']);
  });
});

describe('pointers come from the right frame', () => {
  it("merge sort: the outer frame's mid does not land on the inner frame's a", () => {
    const hints = parseSource(MERGE_SORT);
    const outerA = ref(1);
    const innerA = ref(2);
    const frames = [frame('<module>', {}), frame('merge_sort', { a: outerA, mid: 3 }), frame('merge_sort', { a: innerA })];
    assert.deepEqual(sequencePointers(innerA, 2, 3, frames, hints).pointers, []);
    assert.deepEqual(names(sequencePointers(outerA, 1, 6, frames, hints).pointers), ['mid=3']);
  });

  it('merge sort: mid indexes a, so it is no bound of left', () => {
    const hints = parseSource(MERGE_SORT);
    const left = ref(3);
    const frames = [frame('<module>', {}), frame('merge_sort', { a: ref(1), mid: 3, left, i: 1 })];
    assert.deepEqual(names(sequencePointers(left, 1, 3, frames, hints).pointers), ['i=1']);
  });

  it('quick sort: pointers from partition, the innermost frame holding the list; pivot is a value', () => {
    const hints = parseSource(QUICK_SORT);
    const nums = ref(1);
    const frames = [
      frame('<module>', { nums }),
      frame('quick_sort', { a: nums, lo: 0, hi: 9 }),
      frame('partition', { a: nums, lo: 0, hi: 9, pivot: 2, i: 1, j: 4 }),
    ];
    const r = sequencePointers(nums, 0, 10, frames, hints);
    assert.equal(r.at.frame, 2);
    assert.equal(r.at.local, 'a');
    assert.deepEqual(names(r.pointers), ['hi=9', 'i=1', 'j=4', 'lo=0']);
    assert.deepEqual(boundRanges(r.pointers, 10), [{ from: 0, to: 9, names: ['lo', 'hi'] }]);
  });

  it('permutations: i points into nums (used in the closure), never into res', () => {
    const hints = parseSource(PERMUTE);
    const nums = ref(1);
    const res = ref(2);
    const used = ref(3);
    const frames = [
      frame('<module>', {}),
      frame('permute', { nums, res, used }),
      frame('backtrack', { nums, res, used, i: 0 }),
      frame('backtrack', { nums, res, used, i: 2 }),
    ];
    assert.deepEqual(names(sequencePointers(nums, 1, 3, frames, hints).pointers), ['i=2']);
    assert.deepEqual(sequencePointers(res, 1, 4, frames, hints).pointers, []);
  });

  it('a module-level list used inside a function takes that function\'s index', () => {
    const src = 'root = [3, 9, 20, None, None, 15, 7]\ndef max_depth(i):\n    if i >= len(root) or root[i] is None:\n        return 0\n    return 1 + max(max_depth(2 * i + 1), max_depth(2 * i + 2))\n';
    const hints = parseSource(src);
    const root = ref(1);
    const frames = [frame('<module>', { root }), frame('max_depth', { i: 0 }), frame('max_depth', { i: 2 })];
    const r = sequencePointers(root, 0, 7, frames, hints);
    assert.equal(r.at.frame, 2);
    assert.deepEqual(names(r.pointers), ['i=2']);
  });

  it('a helper that does not touch the list does not steal its pointers', () => {
    const src = 'def f(x):\n    return x * 2\narr = [1, 2, 3]\nfor i in range(len(arr)):\n    arr[i] = f(arr[i])\n';
    const hints = parseSource(src);
    const arr = ref(1);
    const frames = [frame('<module>', { arr, i: 1 }), frame('f', { x: 2 })];
    assert.equal(pointerFrame(arr, 0, frames, hints).frame, 0);
    assert.deepEqual(names(sequencePointers(arr, 0, 3, frames, hints).pointers), ['i=1']);
  });

  it('strings: two pointers and a sliding window over s', () => {
    const pal = parseSource('s = "racecar"\ni, j = 0, len(s) - 1\nwhile i < j:\n    if s[i] != s[j]:\n        break\n    i += 1\n    j -= 1\n');
    assert.deepEqual(names(sequencePointers('racecar', 0, 7, [frame('<module>', { s: 'racecar', i: 1, j: 5 })], pal).pointers), ['i=1', 'j=5']);
    const win = parseSource('s = "abcabcbb"\nleft = 0\nfor right, ch in enumerate(s):\n    left = max(left, 1)\n');
    const r = sequencePointers('abcabcbb', 0, 8, [frame('<module>', { s: 'abcabcbb', left: 2, right: 4, best: 3 })], win);
    assert.deepEqual(names(r.pointers), ['left=2', 'right=4']);
    assert.deepEqual(boundRanges(r.pointers, 8), [{ from: 2, to: 4, names: ['left', 'right'] }]);
  });

  it('nothing points into an empty sequence; the legacy rule still works without source', () => {
    const hints = parseSource('q = []\nwhile q:\n    x = q[0]\n');
    assert.deepEqual(sequencePointers(ref(1), 0, 0, [frame('<module>', { q: ref(1), i: 0 })], hints).pointers, []);
    const vars = [{ name: 'i', value: 2, depth: 0 }, { name: 'count', value: 1, depth: 0 }, { name: 'mid', value: 9, depth: 0 }];
    assert.deepEqual(names(legacyPointers(vars, 5)), ['i=2']);
    assert.deepEqual(legacyPointers(vars, 0), []);
  });

  it('ranges need lo <= hi and are clamped to the sequence', () => {
    assert.deepEqual(boundRanges([{ name: 'lo', index: 5 }, { name: 'hi', index: 4 }], 10), []);
    assert.deepEqual(boundRanges([{ name: 'start', index: 2 }, { name: 'end', index: 6 }], 6), [{ from: 2, to: 5, names: ['start', 'end'] }]);
  });
});

describe('matrix highlights', () => {
  it('dp[i][j]: row i, column j; dp[m][n] (sizes) is not a probe', () => {
    const src = 'm, n = len(a), len(b)\ndp = [[0] * (n + 1) for _ in range(m + 1)]\nfor i in range(1, m + 1):\n    for j in range(1, n + 1):\n        dp[i][j] = dp[i - 1][j - 1] + 1\nprint(dp[m][n])\n';
    const hints = parseSource(src);
    const dp = ref(1);
    const mk = matrixPointers(dp, 0, 8, 7, [frame('<module>', { dp, m: 7, n: 6, i: 3, j: 2 })], hints);
    assert.deepEqual([mk.row, mk.col], [{ name: 'i', index: 3 }, { name: 'j', index: 2 }]);
    assert.deepEqual(mk.probes, []);
  });

  it('grid[r][c] with a neighbour grid[nr][nc] probed; unrelated ints are ignored', () => {
    const src = 'for r in range(rows):\n    for c in range(cols):\n        if grid[r][c] == "1":\n            nr, nc = r + 1, c\n            if grid[nr][nc] == "1":\n                count += 1\n';
    const hints = parseSource(src);
    const grid = ref(1);
    const mk = matrixPointers(grid, 0, 4, 5, [frame('<module>', { grid, rows: 4, cols: 5, count: 1, r: 2, c: 2, nr: 3, nc: 2 })], hints);
    assert.deepEqual([mk.row?.name, mk.col?.name], ['r', 'c']);
    assert.deepEqual(mk.probes, [{ r: 3, c: 2, names: ['nr', 'nc'] }]);
  });

  it('cells held by visited / queue / path collections of (r, c) pairs', () => {
    const heap = heapOf({ 1: { kind: 'set', items: [ref(2), ref(3)], len: 2 }, 2: tuple([0, 0]), 3: tuple([0, 1]), 4: { kind: 'deque', items: [ref(5)], len: 1 }, 5: tuple([1, 1]), 6: tuple([9, 9]) });
    const vars = [{ name: 'visited', value: ref(1), depth: 0 }, { name: 'q', value: ref(4), depth: 0 }];
    const m = cellMarks(vars, heap, 4, 5);
    assert.deepEqual([...m.cells.get('0,1')!], ['visited']);
    assert.deepEqual([...m.cells.get('1,1')!], ['frontier']);
    assert.deepEqual(m.legend.map((l) => l.name), ['visited', 'q']);
  });

  it('a DP over two strings gets their characters as headers', () => {
    const hints = parseSource('a, b = "ABC", "XY"\nfor i in range(1, 4):\n    for j in range(1, 3):\n        if a[i - 1] == b[j - 1]:\n            dp[i][j] = 1\n');
    const vars = [{ name: 'a', value: 'ABC', depth: 0 }, { name: 'b', value: 'XY', depth: 0 }];
    const ax = stringAxes(vars, hints, 4, 3, new Set(['i']), new Set(['j']));
    assert.deepEqual(ax.rowLabels, ['', 'A', 'B', 'C']);
    assert.deepEqual(ax.colLabels, ['', 'X', 'Y']);
    assert.deepEqual(stringAxes(vars, hints, 5, 3, new Set(['i']), new Set(['k'])), { rowLabels: undefined, colLabels: undefined });
  });
});

describe('shapes', () => {
  it('union-find parent arrays', () => {
    assert.ok(isUnionFindArray([0, 0, 1, 3, 3, 5], 6));
    assert.equal(isUnionFindArray([0, 6, 1], 3), false);
    assert.equal(isUnionFindArray([0, 1.5], 2), false);
    assert.equal(isUnionFindArray([], 0), false);
    const roots = forestOf([0, 0, 1, 3, 3, 5]);
    assert.deepEqual(roots.map((r) => r.label), ['0', '3', '5']);
    assert.deepEqual(roots[0].children.map((c) => c!.label), ['1']);
    // A cycle without a root is still drawn.
    assert.equal(forestOf([1, 0]).length, 1);
  });

  it('edge lists of 2- and 3-tuples', () => {
    const heap = heapOf({ 2: tuple([0, 1]), 3: tuple([1, 2, 5]), 4: tuple([ref(2), 1]) });
    assert.deepEqual(edgeListOf([ref(2), ref(3)], heap), [{ u: '0', v: '1', w: undefined }, { u: '1', v: '2', w: '5' }]);
    assert.equal(edgeListOf([ref(4)], heap), undefined);
    const m = edgeListModel(edgeListOf([ref(3), ref(2)], heap)!);
    assert.deepEqual(m.nodes, ['0', '1', '2']);
    assert.equal(m.directed, false);
  });

  it('level-order lists: a None hides its subtree', () => {
    assert.ok(isLevelOrder([3, 9, 20, null, null, 15, 7]));
    assert.equal(isLevelOrder([1, 2, 3]), false);
    const t = levelOrderTree([3, 9, 20, null, null, 15, 7])!;
    assert.equal(t.label, '3');
    assert.equal(t.children[0]!.children.every((c) => c === null), true);
    assert.deepEqual(t.children[1]!.children.map((c) => c!.label), ['15', '7']);
  });

  it('nested-dict tries versus weighted adjacency', () => {
    const trie = heapOf({ 1: dict([['t', ref(2)]]), 2: dict([['o', ref(3)], ['e', ref(4)]]), 3: dict([['$', true]]), 4: dict([]) });
    assert.ok(isDictTrie(trie[1]!, trie));
    const t = dictTrie(1, trie)!;
    assert.deepEqual(t.children.map((c) => c!.edge), ['t']);
    assert.equal(t.children[0]!.children[0]!.end, true);
    const weighted = heapOf({ 1: dict([['A', ref(2)]]), 2: dict([['B', 4]]) });
    assert.equal(isDictTrie(weighted[1]!, weighted), false);
  });

  it('object tries follow children dicts with the key on the edge, and mark word ends', () => {
    const heap = heapOf({
      1: { kind: 'object', type: 'TrieNode', fields: [['children', ref(2)], ['end', false]] },
      2: dict([['c', ref(3)]]),
      3: { kind: 'object', type: 'TrieNode', fields: [['children', ref(4)], ['end', true]] },
      4: dict([]),
    });
    const t = objectTree(1, heap)!;
    assert.equal(t.label, ''); // no val field: no "TrieNode" label overflowing the circle
    assert.equal(t.children[0]!.edge, 'c');
    assert.equal(t.children[0]!.end, true);
  });
});

describe('layouts', () => {
  it('BSTs use in-order columns', () => {
    const heap = heapOf({
      1: { kind: 'object', type: 'N', fields: [['val', 8], ['left', ref(2)], ['right', ref(3)]] },
      2: { kind: 'object', type: 'N', fields: [['val', 3], ['left', null], ['right', null]] },
      3: { kind: 'object', type: 'N', fields: [['val', 10], ['left', null], ['right', null]] },
    });
    const { placed, cols, depth } = layoutTrees([objectTree(1, heap)!]);
    const x = new Map(placed.map((p) => [p.node.label, p.x]));
    assert.ok(x.get('3')! < x.get('8')! && x.get('8')! < x.get('10')!);
    assert.equal(cols, 3);
    assert.equal(depth, 1);
  });

  it('trees and DAGs reachable from the first vertex are layered; cycles go on a circle', () => {
    const tree = heapOf({ 1: dict([[0, ref(2)], [1, ref(3)], [2, ref(4)]]), 2: list([1, 2]), 3: list([]), 4: list([]) });
    const lt = layoutGraph(adjacencyModel(tree[1]!, tree));
    assert.equal(lt.kind, 'tree');
    assert.ok(lt.pos.get('0')![1] < lt.pos.get('1')![1]);
    assert.equal(lt.pos.get('1')![1], lt.pos.get('2')![1]);
    const dag = heapOf({ 1: dict([['A', ref(2)], ['B', ref(3)], ['C', ref(4)]]), 2: list(['B', 'C']), 3: list(['C']), 4: list([]) });
    assert.equal(layoutGraph(adjacencyModel(dag[1]!, dag)).kind, 'layered');
    const cyc = heapOf({ 1: dict([[0, ref(2)], [1, ref(3)], [2, ref(4)]]), 2: list([1]), 3: list([2]), 4: list([0]) });
    assert.equal(layoutGraph(adjacencyModel(cyc[1]!, cyc)).kind, 'circle');
    // An undirected tree (every edge both ways) is a tree too.
    const und = heapOf({ 1: dict([[1, ref(2)], [2, ref(3)], [3, ref(4)]]), 2: list([2, 3]), 3: list([1]), 4: list([1]) });
    const m = adjacencyModel(und[1]!, und);
    assert.equal(m.directed, false);
    assert.equal(layoutGraph(m).kind, 'tree');
  });

  it('positions come from the final graph and do not move between steps', () => {
    const final = heapOf({ 1: dict([[0, ref(2)], [1, ref(3)], [2, ref(4)]]), 2: list([1, 2]), 3: list([]), 4: list([]) });
    const finalNode = final[1]!;
    const fin = { key: finalNode, model: () => adjacencyModel(finalNode, final) };
    const early = heapOf({ 1: dict([[0, ref(2)]]), 2: list([1]) });
    const later = heapOf({ 1: dict([[0, ref(2)], [1, ref(3)], [9, ref(4)]]), 2: list([1]), 3: list([]), 4: list([]) });
    const a = stableLayout(adjacencyModel(early[1]!, early), fin);
    const b = stableLayout(adjacencyModel(later[1]!, later), fin);
    assert.deepEqual(a.pos.get('0'), b.pos.get('0'));
    assert.deepEqual(a.pos.get('1'), b.pos.get('1'));
    // A vertex the final graph does not have gets a spot below the layout.
    assert.ok(b.pos.get('9')![1] > a.height);
  });
});

describe('animation keys', () => {
  const run = (steps: Encoded[][]) => {
    let memo: KeyMemo | undefined;
    return steps.map((items) => (memo = itemKeys(items, memo)).keys);
  };

  it('a swap carries keys with the values; an in-place change keeps positions', () => {
    const [k0, k1, k2] = run([[5, 3, 8], [3, 5, 8], [3, 5, 9]]);
    assert.deepEqual(k0, ['i:0', 'i:1', 'i:2']);
    assert.deepEqual(k1, ['i:1', 'i:0', 'i:2']);
    assert.deepEqual(k2, k1);
  });

  it('a step that changes nothing keeps every key (no re-fade), duplicates keep their order', () => {
    const ks = run([[2, 1, 2], [2, 2, 2], [2, 2, 2], [1, 2, 2]]);
    assert.deepEqual(ks[1], ks[0]);
    assert.deepEqual(ks[2], ks[1]);
    assert.deepEqual(new Set(ks[3]).size, 3);
  });

  it('appends get fresh keys that never collide', () => {
    const ks = run([[1, 2, 3], [3, 2, 1], [3, 2], [3, 2, 7]]);
    assert.equal(new Set(ks[3]).size, 3);
    assert.deepEqual(ks[3].slice(0, 2), ks[2]);
  });
});
