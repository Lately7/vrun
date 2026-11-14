/** Trace model (heap deltas, call tree, navigation) and line watches. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Encoded, type Heap, fmtPy, pyStr } from '../../webview/format';
import { boundOnLine, subscriptsOf, watchesFor } from '../../webview/lineWatch';
import { TraceModel, type TraceStepData } from '../../webview/traceModel';
import { callEnd, callLabel } from '../../webview/viz/callLabels';

type Frame = TraceStepData['stack'][number];
const mod = (locals: Array<[string, Encoded]> = []): Frame => ({ func: '<module>', line: 1, locals, fid: 1 });
const step = (line: number, stack: Frame[], heap: Heap = {}, extra: Partial<TraceStepData> = {}): TraceStepData => ({
  line, event: 'line', stack, heap, out: 0, ...extra,
});

describe('trace model heaps', () => {
  it('rebuilds full heaps from deltas, also far from the start', () => {
    const steps: TraceStepData[] = [];
    for (let k = 0; k < 300; k++) {
      // node 1 changes every step, node 2 only once at step 0
      const heap: Heap = { '1': { kind: 'list', items: [k], len: 1 } };
      if (k === 0) heap['2'] = { kind: 'list', items: ['x'], len: 1 };
      steps.push(step(2, [mod([['a', { ref: 1 }], ['b', { ref: 2 }]])], heap));
    }
    const m = new TraceModel(steps, true);
    assert.deepEqual(m.heapAt(250)['1']?.items, [250]);
    assert.deepEqual(m.heapAt(250)['2']?.items, ['x']);
    assert.deepEqual(m.heapAt(3)['1']?.items, [3]); // backwards
    assert.deepEqual(m.heapAt(4)['1']?.items, [4]); // forwards from the cache
    assert.deepEqual(m.heapAt(299)['1']?.items, [299]);
  });

  it('drops nodes listed as gone', () => {
    const m = new TraceModel([
      step(1, [mod()], { '5': { kind: 'list', items: [1], len: 1 } }),
      step(2, [mod()], {}, { gone: ['5'] }),
    ], true);
    assert.ok(m.heapAt(0)['5']);
    assert.equal(m.heapAt(1)['5'], undefined);
  });

  it('uses each step heap as is without deltas', () => {
    const m = new TraceModel([step(1, [mod()], { '1': { kind: 'set', items: [], len: 0 } }), step(2, [mod()], {})], false);
    assert.equal(m.heapAt(1)['1'], undefined);
  });
});

describe('trace model calls and navigation', () => {
  // fib(2) -> fib(1), fib(0)
  const f = (fid: number, n: number, first = false): Frame => ({ func: 'fib', line: 3, locals: [['n', n]], fid, ...(first ? { params: ['n'] } : {}) });
  const steps: TraceStepData[] = [
    step(5, [mod()]), // 0
    step(2, [mod(), f(2, 2, true)]), // 1
    step(3, [mod(), f(2, 2)]), // 2
    step(2, [mod(), f(2, 2), f(3, 1, true)]), // 3
    step(2, [mod(), f(2, 2), f(3, 1)], {}, { event: 'return', ret: 1 }), // 4
    step(2, [mod(), f(2, 2), f(4, 0, true)]), // 5
    step(2, [mod(), f(2, 2), f(4, 0)], {}, { event: 'return', ret: 0 }), // 6
    step(3, [mod(), f(2, 2)], {}, { event: 'return', ret: 1 }), // 7
    step(6, [mod()]), // 8
  ];
  const m = new TraceModel(steps, true);

  it('builds the call tree with arguments and return values', () => {
    const calls = m.calls();
    assert.equal(calls.size, 3);
    assert.deepEqual(calls.get(2)?.children, [3, 4]);
    assert.deepEqual(calls.get(3)?.args, [['n', 1]]);
    assert.equal(calls.get(4)?.ret, 0);
    assert.equal(calls.get(2)?.endStep, 7);
    assert.equal(calls.get(2)?.parent, undefined);
    assert.ok(m.isRecursive());
  });

  it('steps over, out and to a line', () => {
    assert.equal(m.nextOver(2), 7); // skips fib(1) and fib(0)
    assert.equal(m.nextOut(3), 4); // the return of fib(1)
    assert.equal(m.nextOut(4), 5); // then on into fib(0)
    assert.equal(m.prevOver(7), 2);
    assert.equal(m.nextAtLine(0, 3), 2);
    assert.equal(m.nextAtLine(2, 3), 2); // wraps around to the only one
    assert.equal(m.nextAtLine(0, 99), undefined);
    assert.equal(m.hitCounts(3).get(2), 2);
  });

  it('__init__ of another class and class bodies are not recursion', () => {
    const g = (fid: number, func: string, extra: Partial<Frame> = {}): Frame => ({ func, line: 1, locals: [], fid, params: [], ...extra });
    const m2 = new TraceModel([
      step(1, [mod(), g(2, 'TrieNode', { body: true })]),
      step(2, [mod(), g(3, '__init__', { qual: 'Trie.__init__' })]),
      step(3, [mod(), g(3, '__init__'), g(4, '__init__', { qual: 'TrieNode.__init__' })]),
    ], true);
    assert.equal(m2.isRecursive(), false);
    assert.deepEqual([...m2.calls().keys()], [3, 4]); // no call for the class body
    assert.equal(m2.calls().get(4)?.parent, 3);
  });

  it('a function calling another is not recursion', () => {
    const g = (fid: number, func: string): Frame => ({ func, line: 1, locals: [], fid, params: [] });
    const flat = new TraceModel([step(1, [mod(), g(2, 'a')]), step(1, [mod(), g(2, 'a'), g(3, 'b')])], true);
    assert.equal(flat.isRecursive(), false);
  });
});

describe('line watches', () => {
  const heap: Heap = {
    '1': { kind: 'list', items: [5, 1, 4, 2], len: 4 },
    '2': { kind: 'list', items: [{ ref: 3 }, { ref: 4 }], len: 2 },
    '3': { kind: 'list', items: [0, 1], len: 2 },
    '4': { kind: 'list', items: [2, 3], len: 2 },
    '5': { kind: 'dict', entries: [['a', 0], ['b', 7]], len: 2 },
  };
  const vars = new Map<string, Encoded>([['arr', { ref: 1 }], ['dp', { ref: 2 }], ['seen', { ref: 5 }], ['j', 1], ['i', 1], ['ch', 'b'], ['s', 'racecar']]);

  it('evaluates simple subscripts from the step', () => {
    const w = watchesFor('if arr[j] > arr[j + 1]:', vars, heap);
    assert.deepEqual(w.map((x) => [x.text, x.value]), [['arr[j]', 1], ['arr[j + 1]', 4]]);
    assert.deepEqual(watchesFor('dp[i][j] = dp[i - 1][j - 1] + 1', vars, heap).map((x) => x.value), [3, 0]);
    assert.deepEqual(watchesFor('if seen[ch] >= left:', vars, heap).map((x) => x.value), [7]);
    assert.deepEqual(watchesFor('while s[i] == s[-1 - i]:', vars, heap).map((x) => x.value), ['a', 'a']);
    assert.deepEqual(watchesFor('x = arr[len(arr) - 1]', vars, heap).map((x) => x.value), [2]);
  });

  it('skips slices, attributes, strings, unknown names and bad indexes', () => {
    assert.deepEqual(watchesFor('left = a[:mid]', vars, heap), []);
    assert.deepEqual(watchesFor('self.items[i]', vars, heap), []);
    assert.deepEqual(watchesFor('print("arr[j]")  # arr[j]', vars, heap), []);
    // arr[9]: past the end, but the line ran on without an error, so never read (p1Player.test.ts: shown when read).
    assert.deepEqual(watchesFor('arr[k] + arr[9]', vars, heap, { func: 'f', firstOnLine: true, outcome: 'ran' }), []);
    assert.deepEqual(subscriptsOf('graph[u][v]').map((s) => s.indexes), [['u', 'v']]);
  });
});

describe('trace model: stack runs, generators, raised calls', () => {
  const g = (fid: number, func: string, n: number, extra: Partial<Frame> = {}): Frame => ({ func, line: 2, locals: [['n', n]], fid, ...extra });

  it('expands runs of unchanged frames from the previous step', () => {
    const a = g(2, 'dive', 0, { params: ['n'], code: 2 });
    const b = g(3, 'dive', 1, { params: ['n'], code: 2 });
    const wire = [
      { line: 1, event: 'line' as const, stack: [mod()], heap: {}, out: 0 },
      { line: 2, event: 'line' as const, stack: [1, a], heap: {}, out: 0 },
      { line: 2, event: 'line' as const, stack: [2, b], heap: {}, out: 0 },
      { line: 2, event: 'line' as const, stack: [1, g(2, 'dive', 5), 1], heap: {}, out: 0 }, // a middle frame changed
    ];
    const m = new TraceModel(wire, true);
    assert.deepEqual(m.steps[2].stack.map((f) => f.fid), [1, 2, 3]);
    assert.equal(m.steps[2].stack[1], a); // shared, not copied
    assert.deepEqual(m.steps[3].stack.map((f) => Object.fromEntries(f.locals).n), [undefined, 5, 1]);
    assert.equal(m.depth(3), 3);
  });

  it('a generator call ends at its last return, not at its first yield', () => {
    const m = new TraceModel([
      step(4, [mod()]),
      step(2, [mod(), g(2, 'evens', 4, { params: ['n'] })]),
      step(3, [mod(), g(2, 'evens', 4)], {}, { event: 'return', ret: 0, yield: true }),
      step(3, [mod(), g(2, 'evens', 4)], {}, { event: 'return', ret: 2, yield: true }),
      step(2, [mod(), g(2, 'evens', 4)], {}, { event: 'return', ret: null }),
    ], true);
    const c = m.calls().get(2)!;
    assert.equal(c.endStep, 4);
    assert.equal(c.ret, null);
  });

  it('a call that raised keeps the exception instead of a return value', () => {
    const m = new TraceModel([
      step(4, [mod()]),
      step(2, [mod(), g(2, 'f', 1, { params: ['n'] })]),
      step(2, [mod(), g(2, 'f', 1)], {}, { event: 'exception', exc: 'IndexError' }),
      step(2, [mod(), g(2, 'f', 1)], {}, { event: 'return', raised: 'IndexError' }),
    ], true);
    const c = m.calls().get(2)!;
    assert.equal(c.raised, 'IndexError');
    assert.equal(c.ret, undefined);
    assert.equal(callEnd(c, {}), '✗ IndexError');
    assert.equal(callEnd({ ...c, raised: 'GeneratorExit' }, {}), 'closed');
    assert.equal(callEnd({ ...c, raised: undefined, ret: null }, {}), ''); // no "→ None"
  });

  it('two different lambdas are not recursion, a lambda calling itself is', () => {
    const lam = (fid: number, code: number): Frame => ({ func: '<lambda>', line: 1, locals: [], fid, params: ['x'], code });
    const two = new TraceModel([step(1, [mod(), lam(2, 2)]), step(1, [mod(), lam(2, 2), lam(3, 3)])], true);
    assert.equal(two.isRecursive(), false);
    const self = new TraceModel([step(1, [mod(), lam(2, 2)]), step(1, [mod(), lam(2, 2), lam(3, 2)])], true);
    assert.equal(self.isRecursive(), true);
  });

  it('labels object arguments by their value and closures by what they build', () => {
    const heap: Heap = {
      '7': { kind: 'object', type: 'TreeNode', fields: [['val', 8], ['left', null]] },
      '9': { kind: 'list', items: [1, 2], len: 2 },
    };
    const m = new TraceModel([
      step(1, [mod()], heap),
      step(2, [mod(), { func: 'insert', line: 2, locals: [['node', { ref: 7 }], ['v', 'x']], fid: 2, params: ['node', 'v'] }]),
      step(3, [mod(), { func: 'backtrack', line: 3, locals: [['nums', { ref: 9 }], ['path', { ref: 9 }]], fid: 3, params: [] }]),
    ], true);
    assert.equal(callLabel(m.calls().get(2)!, () => heap), "insert(8, 'x')");
    assert.equal(callLabel(m.calls().get(3)!, () => heap), 'backtrack() [1,2]');
    const init = new TraceModel([
      step(1, [mod()], heap),
      step(2, [mod(), { func: '__init__', line: 2, locals: [['self', { ref: 7 }], ['val', 3]], fid: 2, params: ['self', 'val'], qual: 'Node.__init__' }]),
    ], true);
    assert.equal(callLabel(init.calls().get(2)!, () => heap), 'Node(3)');
  });
});

describe('line watches: what Python would read', () => {
  const heap: Heap = {
    '1': { kind: 'list', items: [5, 1, 4], len: 3 },
    '2': { kind: 'ndarray', items: Array.from({ length: 64 }, (_, i) => i), shape: [100], dtype: 'int64' },
    '3': { kind: 'ndarray', rows: [Array.from({ length: 64 }, (_, i) => i)], shape: [1, 100], dtype: 'int64' },
  };

  it('a computed negative index is not read from the end, a written one is', () => {
    const vars = new Map<string, Encoded>([['a', { ref: 1 }], ['j', -1], ['key', 0]]);
    assert.deepEqual(watchesFor('while j >= 0 and a[j] > key:', vars, heap), []);
    assert.deepEqual(watchesFor('x = a[-1]', vars, heap).map((w) => w.value), [4]);
  });

  it('long NumPy arrays: no value past the items sent, len from the shape', () => {
    const vars = new Map<string, Encoded>([['a', { ref: 2 }], ['g', { ref: 3 }], ['i', 0]]);
    // Item 99 was not sent: "(not shown)", neither a wrong value nor nothing.
    assert.deepEqual(watchesFor('x = a[-1]', vars, heap).map((w) => [w.value, w.notShown]), [[null, true]]);
    assert.deepEqual(watchesFor('x = a[len(a) - 37]', vars, heap).map((w) => w.value), [63]);
    assert.deepEqual(watchesFor('x = g[i][-1]', vars, heap).map((w) => w.notShown), [true]);
    assert.deepEqual(watchesFor('x = g[i][5]', vars, heap).map((w) => w.value), [5]);
  });

  it('strings index by code point', () => {
    const vars = new Map<string, Encoded>([['w', 'a\u{1F600}b'], ['i', 1]]);
    assert.deepEqual(watchesFor('c = w[-2]', vars, {}).map((w) => w.value), ['\u{1F600}']);
    assert.deepEqual(watchesFor('c = w[len(w) - 1]', vars, {}).map((w) => w.value), ['b']);
  });

  it('names the line binds itself are not read from the frame', () => {
    const vars = new Map<string, Encoded>([['arr', { ref: 1 }], ['j', 2]]);
    const line = 'best = [arr[j] for j in range(2)]';
    assert.deepEqual(watchesFor(line, vars, heap, { func: '<module>', firstOnLine: false }), []);
    assert.deepEqual(watchesFor(line, vars, heap, { func: 'f', firstOnLine: true }), []);
    assert.deepEqual(watchesFor(line, vars, heap, { func: 'f', firstOnLine: false }).map((w) => w.value), [4]);
    const lam = 'order = sorted(range(3), key=lambda j: -arr[j])';
    assert.deepEqual(watchesFor(lam, vars, heap, { func: '<module>', firstOnLine: true }), []);
    assert.deepEqual(watchesFor(lam, vars, heap, { func: '<lambda>', firstOnLine: true }).map((w) => w.value), [4]);
    assert.deepEqual(watchesFor('t = sum(arr[j] for j in range(2))', vars, heap, { func: 'f', firstOnLine: false }), []);
    assert.deepEqual(boundOnLine('x = {k: v for k, v in d.items()}').comp, new Set(['k', 'v']));
  });

  it('strings read as Python writes them', () => {
    assert.equal(pyStr('0'), "'0'");
    assert.equal(pyStr("it's"), `"it's"`);
    assert.equal(pyStr('a\nb\\'), "'a\\nb\\\\'");
    assert.equal(fmtPy('('), "'('");
    assert.equal(fmtPy(3), '3');
  });
});
