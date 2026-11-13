/** Trace model (heap deltas, call tree, navigation) and line watches. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Encoded, Heap } from '../../webview/format';
import { subscriptsOf, watchesFor } from '../../webview/lineWatch';
import { TraceModel, type TraceStepData } from '../../webview/traceModel';

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
    assert.deepEqual(watchesFor('arr[k] + arr[9]', vars, heap), []);
    assert.deepEqual(subscriptsOf('graph[u][v]').map((s) => s.indexes), [['u', 'v']]);
  });
});
