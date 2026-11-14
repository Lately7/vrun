/**
 * The step player for beginners' P1 problems: generator-expression frames
 * are not calls, helper calls fold into a badge, a deep recursion folds its
 * middle instead of making a 100,000 px page, an index past the end is
 * shown (not dropped), and a NameError in a cell names the missing value.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Encoded, Heap } from '../../webview/format';
import { type WatchContext, mayBeSkipped, outOfRangeText, watchesFor } from '../../webview/lineWatch';
import {
  TraceModel, type TraceStepData, foldHelpersByDefault, lineOutcome, missingName, recursionText, stackShown, undefinedName,
} from '../../webview/traceModel';

interface CallTreeModule {
  ROOT_GROUP: number;
  chainPieces<T>(chain: T[], at: number): Array<T | T[]>;
  renderCallTree(
    model: TraceModel, k: number, heapAt: (k: number) => Heap, onPick: (step: number) => void,
    opts?: { foldHelpers?: boolean; expanded?: ReadonlySet<number>; onToggle?: (owner: number) => void },
  ): { svg: unknown; note?: string } | undefined;
}
// callTree.ts draws with DOM types, which this (node) project does not
// include: load it untyped (esbuild bundles it) and draw into the fake
// document at the end of this file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ROOT_GROUP, chainPieces, renderCallTree } = require('../../webview/viz/callTree') as CallTreeModule;

type Frame = TraceStepData['stack'][number];
const mod = (): Frame => ({ func: '<module>', line: 1, locals: [], fid: 1, params: [], code: 1 });
const step = (line: number, stack: Frame[], extra: Partial<TraceStepData> = {}): TraceStepData => ({ line, event: 'line', stack, heap: {}, out: 0, ...extra });
/** A frame of `func` (code id `code`), with its params on every step (harmless: only the first one is read). */
const fr = (fid: number, func: string, code: number, locals: Array<[string, Encoded]> = []): Frame => ({
  func, line: 2, locals, fid, code, params: locals.map(([n]) => n),
});

describe('calls: comprehension frames are not calls', () => {
  // best(3) -> <genexpr> -> best(2) -> <genexpr> -> best(1), as min(best(r - c) for c in coins) runs.
  const b3 = fr(2, 'best', 2, [['rem', 3]]);
  const g1 = fr(3, '<genexpr>', 3);
  const b2 = fr(4, 'best', 2, [['rem', 2]]);
  const g2 = fr(5, '<genexpr>', 3);
  const b1 = fr(6, 'best', 2, [['rem', 1]]);
  const lam = fr(7, '<lambda>', 4, [['x', 1]]);
  const m = new TraceModel([
    step(9, [mod()]),
    step(2, [mod(), b3]),
    step(5, [mod(), b3, g1]),
    step(2, [mod(), b3, g1, b2]),
    step(5, [mod(), b3, g1, b2, g2]),
    step(2, [mod(), b3, g1, b2, g2, b1]),
    step(2, [mod(), b3, g1, b2, g2, b1], { event: 'return', ret: 1 }),
    step(4, [mod(), b3, lam]),
  ], true);

  it('a genexpr is neither a call nor a parent: best() calls best()', () => {
    const calls = m.calls();
    assert.deepEqual([...calls.keys()], [2, 4, 6, 7]);
    assert.equal(calls.get(4)?.parent, 2);
    assert.equal(calls.get(6)?.parent, 4);
    assert.deepEqual(calls.get(2)?.children, [4, 7]); // the lambda stays a call
    assert.equal(calls.get(6)?.ret, 1);
    assert.ok(m.isRecursive());
  });

  it('the active calls skip the module and genexpr frames', () => {
    assert.deepEqual(m.activeCalls(5), [2, 4, 6]);
    assert.deepEqual(m.activeCalls(4), [2, 4]); // the running genexpr belongs to best(2)
  });

  it('the call stack card lists a genexpr inside the frame iterating it, not as a frame of its own', () => {
    const shown = (k: number) => stackShown(m.steps[k].stack).map(({ f, inner }) => [f.fid, inner.map((g) => g.fid)]);
    // best(1) <- genexpr <- best(2) <- genexpr <- best(3) <- module: 4 boxes, not 6.
    assert.deepEqual(shown(5), [[6, []], [4, [5]], [2, [3]], [1, []]]);
    assert.deepEqual(shown(4), [[4, [5]], [2, [3]], [1, []]]); // the running genexpr is in best(2)'s box
    assert.deepEqual(shown(7), [[7, []], [2, []], [1, []]]); // a lambda stays a frame
    // A genexpr at module level goes into the module's box; nothing goes below the outermost frame.
    assert.deepEqual(stackShown([mod(), fr(9, '<genexpr>', 9)]).map(({ f, inner }) => [f.fid, inner.length]), [[1, 1]]);
    assert.deepEqual(stackShown([fr(9, '<genexpr>', 9)]).map(({ f }) => f.fid), [9]);
  });
});

describe('helper calls', () => {
  // is_ok() at module level; main() -> solve(0) -> safe, safe, solve(1) -> safe -> check (a helper of a helper).
  const main = fr(2, 'main', 2);
  const s0 = fr(3, 'solve', 3, [['r', 0]]);
  const s1 = fr(6, 'solve', 3, [['r', 1]]);
  const steps: TraceStepData[] = [
    step(1, [mod(), fr(10, 'is_ok', 5)]),
    step(1, [mod(), fr(10, 'is_ok', 5)], { event: 'return', ret: true }),
    step(1, [mod(), main]),
    step(2, [mod(), main, s0]),
    step(3, [mod(), main, s0, fr(4, 'safe', 4)]),
    step(3, [mod(), main, s0, fr(4, 'safe', 4)], { event: 'return', ret: true }),
    step(3, [mod(), main, s0, fr(5, 'safe', 4)]),
    step(3, [mod(), main, s0, fr(5, 'safe', 4)], { event: 'return', ret: true }),
    step(2, [mod(), main, s0, s1]),
    step(3, [mod(), main, s0, s1, fr(7, 'safe', 4)]),
    step(3, [mod(), main, s0, s1, fr(7, 'safe', 4), fr(8, 'check', 6)]),
    step(3, [mod(), main, s0, s1, fr(7, 'safe', 4), fr(8, 'check', 6)], { event: 'return', ret: true }),
  ];
  const m = new TraceModel(steps, true);
  const k = steps.length - 1;
  const dom = installFakeDom();
  before(dom.install);
  after(dom.remove);

  it('are calls of functions that never recurse and reach no recursion', () => {
    assert.deepEqual([...m.helpers()].sort((a, b) => a - b), [4, 5, 7, 8, 10]);
    // main() is not recursive, but solve() runs under it: part of the skeleton.
    assert.ok(!m.helpers().has(2));
  });

  it('fold into a badge on their caller, and a node at module level', () => {
    const tree = renderCallTree(m, k, () => ({}), () => {}, { foldHelpers: true })!;
    const texts = textsOf(tree.svg);
    assert.ok(texts.includes('+2 safe()'), texts.join(' | ')); // on solve(0)
    assert.ok(texts.includes('+1 safe()')); // on solve(1): check() inside safe() is not counted again
    assert.ok(texts.includes('+1 is_ok()')); // the module-level group
    assert.ok(!texts.some((t) => t.startsWith('safe(')));
    assert.match(tree.note ?? '', /^3 of 8 calls drawn · \+N = 5 calls of helpers/);
    // The badge's title counts what its safe() call folds with it: the note's 5 = 2 + (1 + 1) + 1.
    const titles = findAll(tree.svg, (e) => e.tag === 'title').map((e) => e.kids.map((x) => ('text' in x ? x.text : '')).join(''));
    assert.ok(titles.includes('1 call of safe() and the 1 call it made (check()), which do not recurse, folded here ("Recursive calls only"). Click to show them.'), titles.join(' | '));
    assert.ok(titles.includes('2 calls of safe(), which do not recurse, folded here ("Recursive calls only"). Click to show them.'));
    // check() inside safe() of solve(1) is running: that badge is hot, solve(1) is the current call.
    assert.equal(findAll(tree.svg, (e) => /helper-badge hot/.test(e.attrs.get('class') ?? '')).length, 1);
    assert.match(findAll(tree.svg, (e) => e.attrs.get('data-anim') === 'c:6')[0].attrs.get('class') ?? '', /current/);
  });

  it('a clicked badge unfolds its calls, and folds them again', () => {
    const toggled: number[] = [];
    const tree = renderCallTree(m, k, () => ({}), () => {}, { foldHelpers: true, expanded: new Set([3, ROOT_GROUP]), onToggle: (o) => toggled.push(o) })!;
    const texts = textsOf(tree.svg);
    assert.ok(texts.includes('−2 safe()'), texts.join(' | '));
    assert.ok(texts.includes('−1 is_ok()'));
    assert.ok(texts.includes('safe()') && texts.includes('is_ok()'));
    const badge = findAll(tree.svg, (e) => (e.attrs.get('class') ?? '').startsWith('helper-badge') && textsOf(e)[0] === '−2 safe()')[0];
    badge.listeners.get('click')!({ stopPropagation() {} });
    assert.deepEqual(toggled, [3]);
    // Without folding every call is drawn, and nothing is said about it.
    assert.equal(renderCallTree(m, k, () => ({}), () => {})!.note, undefined);
  });

  it('"Recursive calls only" starts on when a caller makes several helper calls', () => {
    assert.ok(foldHelpersByDefault(m)); // solve(0) checks safe() twice
  });
});

describe('helper calls: merge sort keeps its merge() calls drawn', () => {
  /** merge_sort over 8 items: 15 calls, each of the 7 inner ones calls merge() once, which calls swap() `swaps` times. */
  const mergeSort = (swaps: number): TraceStepData[] => {
    const steps: TraceStepData[] = [step(9, [mod()])];
    let fid = 2;
    const go = (stack: Frame[], depth: number) => {
      const me = fr(fid, 'merge_sort', 2, [['lo', fid++]]);
      const s = [...stack, me];
      steps.push(step(2, s));
      if (depth < 3) {
        go(s, depth + 1);
        go(s, depth + 1);
        const mg = fr(fid++, 'merge', 3);
        steps.push(step(5, [...s, mg]));
        for (let i = 0; i < swaps; i++) {
          const sw = fr(fid++, 'swap', 4);
          steps.push(step(7, [...s, mg, sw]), step(7, [...s, mg, sw], { event: 'return', ret: null }));
        }
        steps.push(step(5, [...s, mg], { event: 'return', ret: 0 }));
      }
      steps.push(step(2, s, { event: 'return', ret: 0 }));
    };
    go([mod()], 0);
    return steps;
  };
  const dom = installFakeDom();
  before(dom.install);
  after(dom.remove);

  it('is off for one merge() per call, on when helper calls outnumber the recursive ones', () => {
    assert.ok(!foldHelpersByDefault(new TraceModel(mergeSort(0), true))); // 7 merge() calls, 15 merge_sort() calls
    assert.ok(foldHelpersByDefault(new TraceModel(mergeSort(2), true))); // 21 helper calls (with swap())
  });

  it('a badge widens only the gap after its own subtree, and never overlaps the next box', () => {
    const steps = mergeSort(0);
    const tree = renderCallTree(new TraceModel(steps, true), steps.length - 1, () => ({}), () => {}, { foldHelpers: true })!;
    const svg = tree.svg as unknown as FakeNode;
    // Every column widened to fit a badge was 8 x 173 px.
    assert.ok(Number(svg.attrs.get('width')) < 8 * 140, svg.attrs.get('width'));
    const rectOf = (g: FakeNode) => g.kids.find((x): x is FakeNode => 'tag' in x && x.tag === 'rect')!;
    const box = (r: FakeNode, dy: number) => ({ l: Number(r.attrs.get('x')), r: Number(r.attrs.get('x')) + Number(r.attrs.get('width')), y: Number(r.attrs.get('y')) + dy });
    const calls = findAll(svg, (e) => e.tag === 'g' && /^call /.test(e.attrs.get('class') ?? '')).map((g) => box(rectOf(g), 10));
    const badges = findAll(svg, (e) => e.tag === 'g' && /^helper-badge/.test(e.attrs.get('class') ?? '')).map((g) => box(rectOf(g), 8));
    assert.equal(badges.length, 7);
    for (const b of badges) {
      for (const c of calls) assert.ok(Math.abs(c.y - b.y) > 1 || c.r <= b.l || c.l >= b.r, `badge ${JSON.stringify(b)} overlaps ${JSON.stringify(c)}`);
    }
  });
});

describe('a deep recursion folds the middle of its chain', () => {
  const N = 300;
  const frames: Frame[] = [];
  const steps: TraceStepData[] = [step(9, [mod()])];
  for (let i = 0; i < N; i++) {
    frames.push(fr(i + 2, 'countdown', 2, [['n', 3 - i]]));
    steps.push(step(3, [mod(), ...frames]));
  }
  // Unwinding: the deepest 150 calls end.
  for (let i = N - 1; i >= N - 150; i--) steps.push(step(3, [mod(), ...frames.slice(0, i + 1)], { event: 'return', ret: 0 }));
  const m = new TraceModel(steps, true);
  const dom = installFakeDom();
  before(dom.install);
  after(dom.remove);

  it('keeps the root, the first and the last calls, and says what is left out', () => {
    const tree = renderCallTree(m, N, () => ({}), () => {})!;
    const texts = textsOf(tree.svg);
    const boxes = texts.filter((t) => t.startsWith('countdown('));
    assert.equal(boxes.length, 12 + 1); // and the fold's range "countdown(-1) … countdown(-288)"
    assert.ok(boxes.includes('countdown(3)')); // the root
    assert.ok(boxes.includes('countdown(-296)')); // the deepest, running call
    assert.ok(texts.includes('… 288 calls'), texts.join(' | '));
    assert.ok(texts.includes('countdown(-1) … countdown(-288)'));
    assert.equal(tree.note, '12 of 300 calls drawn · … = 288 calls left out');
    // 12 calls and one fold: 13 rows, not 300.
    assert.ok(Number((tree.svg as unknown as FakeNode).attrs.get('height')) < 14 * 56 + 20);
  });

  it('keeps the running call in the middle of the chain drawn', () => {
    const tree = renderCallTree(m, steps.length - 1, () => ({}), () => {})!; // depth 151 is returning
    const current = findAll(tree.svg, (e) => / current/.test(e.attrs.get('class') ?? ''));
    assert.equal(current.length, 1);
    assert.equal(textsOf(current[0])[0], 'countdown(-147)');
    assert.equal(textsOf(tree.svg).filter((t) => t.startsWith('… ')).length, 2); // folds above and below it
  });

  it('a RecursionError names the function, its depth and how its argument went', () => {
    assert.match(recursionText(m) ?? '', /^countdown\(\) was 300 calls deep when Python stopped the recursion at its limit\. n went 3, 2, 1, 0, -1, … -296\. Either/);
    assert.equal(recursionText(new TraceModel(steps.slice(0, 10), true)), undefined); // 9 calls: not a runaway recursion
  });

  it('a short chain is drawn in full, with no note', () => {
    const tree = renderCallTree(m, 20, () => ({}), () => {})!;
    assert.equal(tree.note, undefined);
    assert.equal(textsOf(tree.svg).filter((t) => t.startsWith('countdown(')).length, 20);
  });

  it('chainPieces: head, tail and the calls around the current one', () => {
    const chain = Array.from({ length: 40 }, (_, i) => i);
    const flat = (p: Array<number | number[]>) => p.map((x) => (Array.isArray(x) ? `[${x[0]}..${x[x.length - 1]}]` : String(x))).join(' ');
    assert.equal(flat(chainPieces(chain, -1)), '0 1 2 3 [4..31] 32 33 34 35 36 37 38 39');
    assert.equal(flat(chainPieces(chain, 20)), '0 1 2 3 [4..17] 18 19 20 21 22 [23..31] 32 33 34 35 36 37 38 39');
    assert.equal(flat(chainPieces(chain, 6)), '0 1 2 3 4 5 6 7 8 [9..31] 32 33 34 35 36 37 38 39');
    // A fold of a single call is that call.
    assert.equal(flat(chainPieces(Array.from({ length: 13 }, (_, i) => i), -1)), '0 1 2 3 4 5 6 7 8 9 10 11 12');
  });
});

describe('past 300 calls, a "…" leaf stands for its whole subtree', () => {
  // total(nums, 0) .. total(nums, 10) returned (dsa-recursion_deep.py's first print), then a 300-deep countdown().
  const steps: TraceStepData[] = [step(9, [mod()])];
  const small: Frame[] = [];
  for (let i = 0; i <= 10; i++) {
    small.push(fr(1000 + i, 'total', 3, [['i', i]]));
    steps.push(step(3, [mod(), ...small]));
  }
  for (let i = 10; i >= 0; i--) steps.push(step(3, [mod(), ...small.slice(0, i + 1)], { event: 'return', ret: 0 }));
  const big: Frame[] = [];
  for (let i = 0; i < 300; i++) {
    big.push(fr(i + 2, 'countdown', 2, [['n', 3 - i]]));
    steps.push(step(3, [mod(), ...big]));
  }
  const m = new TraceModel(steps, true);
  const dom = installFakeDom();
  before(dom.install);
  after(dom.remove);

  it('the left-out first call counts the 10 calls under it', () => {
    const tree = renderCallTree(m, steps.length - 1, () => ({}), () => {})!;
    const titles = findAll(tree.svg, (e) => e.tag === 'title').map((e) => e.kids.map((x) => ('text' in x ? x.text : '')).join(''));
    assert.ok(titles.includes('11 more calls not drawn'), titles.join(' | ')); // was "1 more call"
    assert.equal(tree.note, '12 of 311 calls drawn · … = 299 calls left out (the calls around the current step are drawn)');
  });
});

describe('a deep recursion with a helper call, or two functions taking turns', () => {
  const D = 30;
  // down(n): down(n - 1) first, then check(n) on the way back (the deepest one checks and returns).
  const downs: Frame[] = [];
  const steps: TraceStepData[] = [step(9, [mod()])];
  for (let i = 0; i < D; i++) {
    downs.push(fr(i + 2, 'down', 2, [['n', D - i]]));
    steps.push(step(6, [mod(), ...downs]));
  }
  const checkAt = new Map<number, number>(); // down index -> step where its check() starts
  for (let i = D - 1; i >= 0; i--) {
    const chk = fr(100 + i, 'check', 3, [['n', D - i]]);
    checkAt.set(i, steps.length);
    steps.push(step(2, [mod(), ...downs.slice(0, i + 1), chk]), step(2, [mod(), ...downs.slice(0, i + 1), chk], { event: 'return', ret: 0 }));
    steps.push(step(7, [mod(), ...downs.slice(0, i + 1)], { event: 'return', ret: 0 }));
  }
  const m = new TraceModel(steps, true);
  // is_even(n) -> is_odd(n - 1) -> is_even(n - 2) …, never returning.
  const turns: Frame[] = [];
  const mutual: TraceStepData[] = [step(9, [mod()])];
  for (let i = 0; i < D; i++) {
    turns.push(fr(i + 2, i % 2 ? 'is_odd' : 'is_even', i % 2 ? 3 : 2, [['n', D - i]]));
    mutual.push(step(2, [mod(), ...turns]));
  }
  const mm = new TraceModel(mutual, true);
  const dom = installFakeDom();
  before(dom.install);
  after(dom.remove);

  it('the RecursionError line names the recursive function, not the helper running at the deepest step', () => {
    // The deepest step is inside check() of the deepest down().
    assert.match(recursionText(m) ?? '', /^down\(\) was 30 calls deep when Python stopped the recursion at its limit\. n went 30, 29, 28, 27, 26, … 1\. Either/);
    assert.match(recursionText(mm) ?? '', /^is_even\(\) and is_odd\(\) \(calling each other\) were 30 calls deep .* n went 30, 29, 28, 27, 26, … 1\./);
  });

  it('helper calls do not end a chain: the middle folds, the kept calls show them as a badge', () => {
    const picked: number[] = [];
    const k = checkAt.get(15)!; // check() of down(15) is running, the calls below it returned
    const tree = renderCallTree(m, k, () => ({}), (s) => picked.push(s))!;
    const texts = textsOf(tree.svg);
    assert.ok(texts.includes('… 9 calls') && texts.includes('… 4 calls'), texts.join(' | '));
    const current = findAll(tree.svg, (e) => / current/.test(e.attrs.get('class') ?? ''));
    assert.deepEqual(current.map((e) => textsOf(e)[0]), ['down(15)']); // it holds the running check()
    const hot = findAll(tree.svg, (e) => /helper-badge hot/.test(e.attrs.get('class') ?? ''));
    assert.equal(hot.length, 1);
    hot[0].listeners.get('click')!({ stopPropagation() {} });
    assert.deepEqual(picked, [k]); // a jump to that check(), not a toggle
    assert.equal(tree.note, '18 of 45 calls drawn · … = 27 calls left out');
  });

  it('with folding on, a badge inside a fold is left out, not counted as drawn', () => {
    const tree = renderCallTree(m, checkAt.get(15)!, () => ({}), () => {}, { foldHelpers: true })!;
    // Of the 15 check() calls so far, those of the 11 drawn down() calls are badges.
    assert.equal(tree.note, '17 of 45 calls drawn · … = 17 calls left out · +N = 11 calls of helpers that do not recurse, folded into their caller (click a badge to show them)');
  });

  it('two functions taking turns fold like one', () => {
    const tree = renderCallTree(mm, mutual.length - 1, () => ({}), () => {})!;
    const texts = textsOf(tree.svg);
    assert.ok(texts.includes('… 18 calls'), texts.join(' | '));
    assert.ok(texts.includes('is_even(26) … is_odd(9)'));
    assert.equal(tree.note, '12 of 30 calls drawn · … = 18 calls left out');
  });
});

describe('line watches: an index past the end', () => {
  const heap: Heap = {
    '1': { kind: 'list', items: [2, 4, 1, 7], len: 4 },
    '2': { kind: 'list', items: Array.from({ length: 64 }, (_, i) => i), len: 200 },
    '3': { kind: 'dict', entries: [['a', 1]], len: 1 },
    '4': { kind: 'list', items: [], len: 0 },
  };
  const vars = new Map<string, Encoded>([['nums', { ref: 1 }], ['big', { ref: 2 }], ['seen', { ref: 3 }], ['empty', { ref: 4 }], ['j', 3], ['n', 4], ['i', 100], ['ch', 'z']]);
  /** The line raised `raises` itself; '' it ran on; undefined the trace ends on it. */
  const ctx = (raises?: string): WatchContext => ({
    func: '<module>', firstOnLine: true, outcome: raises === undefined ? 'ended' : raises === '' ? 'ran' : { raised: raises },
  });

  it('is shown, in red, where Python reads it (bubble sort with range(n - i))', () => {
    const w = watchesFor('if nums[j] > nums[j + 1]:', vars, heap, ctx('IndexError'));
    assert.deepEqual(w.map((x) => [x.text, x.value, x.outOfRange && outOfRangeText(x.outOfRange)]), [
      ['nums[j]', 7, undefined],
      ['nums[j + 1]', null, 'index 4, len 4 (0..3)'],
    ]);
    // The trace ended on this line: nothing on it can skip the subscript.
    assert.ok(watchesFor('x = nums[j + 1]', vars, heap, ctx(undefined))[0].outOfRange);
    assert.equal(outOfRangeText({ index: -5, len: 4 }), 'index -5, len 4 (-4..3)');
    assert.equal(outOfRangeText(watchesFor('x = empty[-1]', vars, heap, ctx('IndexError'))[0].outOfRange!), 'index -1, len 0 (empty)');
  });

  it('is not shown where a guard skips it, or where the line ran without an error', () => {
    assert.deepEqual(watchesFor('if j + 1 < n and nums[j + 1] > 0:', vars, heap, ctx('')), []);
    assert.deepEqual(watchesFor('while j < n and nums[j + 1] > 0:', vars, heap, ctx(undefined)), []);
    assert.deepEqual(watchesFor('x = nums[j + 1] if j + 1 < n else 0', vars, heap, ctx(undefined)), []);
    assert.deepEqual(watchesFor('for v in nums[j + 1]:', vars, heap, ctx(undefined)), []);
    assert.deepEqual(watchesFor('x = nums[j + 1]', vars, heap, ctx('ZeroDivisionError')), []);
    assert.ok(mayBeSkipped('if a and b[i]:', 9));
    assert.ok(!mayBeSkipped('if b[i] and a:', 3));
    // A one-line body after the colon may not run; a dict's or a slice's colon is no body.
    assert.deepEqual(watchesFor('if j + 1 < n: x = nums[j + 1]', vars, heap, ctx(undefined)), []);
    assert.ok(mayBeSkipped('while i < n: i += a[i]', 18));
    assert.ok(!mayBeSkipped('x = {k: a[i]}', 8));
    assert.ok(!mayBeSkipped('if (m := a[i]) > 0:', 9));
  });

  it('an item of a cut list is "(not shown)", not out of range and not dropped', () => {
    const w = watchesFor('x = big[i]', vars, heap, ctx(''));
    assert.deepEqual(w.map((x) => [x.text, x.notShown, x.outOfRange]), [['big[i]', true, undefined]]);
    assert.ok(watchesFor('x = big[200]', vars, heap, ctx('IndexError'))[0].outOfRange);
  });

  it('a missing dict key is shown only when the line raised KeyError', () => {
    assert.deepEqual(watchesFor('if ch in seen and seen[ch] > 0:', vars, heap, ctx('')), []);
    const w = watchesFor('seen[ch] += 1', vars, heap, ctx('KeyError'));
    assert.equal(outOfRangeText(w[0].outOfRange!), "key 'z' is not in the dict");
  });

  it('a key of a cut dict that was not sent is "(not shown)" only where Python read it without an error', () => {
    const cut: Heap = { '5': { kind: 'dict', len: 100, entries: [[0, 0], [1, 1]] } };
    const memo = new Map<string, Encoded>([['memo', { ref: 5 }], ['n', 77]]);
    const notShown = (line: string, raises?: string) => watchesFor(line, memo, cut, ctx(raises)).map((x) => [x.text, x.notShown ?? false, !!x.outOfRange]);
    // Every memo miss of a big DP: the key may well be absent, and the `in` check guards it.
    for (const raises of [undefined, '']) assert.deepEqual(notShown('    if n in memo: return memo[n]', raises), []);
    const w = watchesFor('x = memo[n]', memo, cut, ctx('KeyError'));
    assert.equal(outOfRangeText(w[0].outOfRange!), 'key 77 is probably not in the dict (not among the 2 of 100 entries sent)');
    assert.deepEqual(watchesFor('x = memo[1]', memo, cut, ctx('')).map((x) => x.value), [1]);
    // Read, and the line ran on: the key exists.
    // A keyword argument (`end=`) is no assignment to memo[n].
    for (const line of ['x = memo[n]', '    return memo[n] + 1', 'memo[n] += 1', 'if memo[n] > 0:', 'print(memo[n], end=" ")', 'foo(memo[n], k=1)', 'y = [memo[n], 0]']) {
      assert.deepEqual(notShown(line, ''), [['memo[n]', true, false]], line);
    }
    // Assigned, guarded, in a lambda, or the trace ended on the line: maybe absent, say nothing.
    for (const line of ['memo[n] = 5', 'x = memo[n] = 0', 'memo[n], y = 1, 2', 'if n > 3 and memo[n]:', 'f = lambda: memo[n]', 'while n > 0: n -= memo[n]']) {
      assert.deepEqual(notShown(line, ''), [], line);
    }
    assert.deepEqual(notShown('x = memo[n]', undefined), []);
    assert.deepEqual(notShown('y = 1; memo[n] = 2', ''), []);
    assert.deepEqual(notShown('memo[0] = 2; y = memo[n]', ''), [['memo[0]', false, false], ['memo[n]', true, false]]);
  });

  it('string-literal keys are read, so their KeyError shows', () => {
    assert.equal(outOfRangeText(watchesFor('y = seen["b"]', vars, heap, ctx('KeyError'))[0].outOfRange!), "key 'b' is not in the dict");
    assert.deepEqual(watchesFor("y = seen['a'] + seen[\"a\\n\"]", vars, heap, ctx('KeyError')).map((x) => [x.text, x.value, x.outOfRange && outOfRangeText(x.outOfRange)]), [
      ["seen['a']", 1, undefined],
      ['seen["a\\n"]', null, "key 'a\\n' is not in the dict"],
    ]);
    assert.deepEqual(watchesFor('y = seen["a:b"]', vars, heap, ctx('')), []); // a colon in a string is no slice, and the key is absent
    assert.deepEqual(watchesFor('y = seen[f"{ch}"]', vars, heap, ctx('KeyError')), []); // an f-string is not evaluated
  });

  it('a computed index below -len is shown when the line raised IndexError', () => {
    const neg = new Map<string, Encoded>([['nums', { ref: 1 }], ['i', -5], ['j', -1]]);
    assert.equal(outOfRangeText(watchesFor('x = nums[i]', neg, heap, ctx('IndexError'))[0].outOfRange!), 'index -5, len 4 (-4..3)');
    assert.deepEqual(watchesFor('x = nums[i]', neg, heap, ctx(undefined)), []); // usually guarded: say nothing
    assert.deepEqual(watchesFor('x = nums[j]', neg, heap, ctx('IndexError')), []); // -1 is a valid index
  });

  it('where the trace ends on the line, a call before the subscript may have changed the list', () => {
    assert.deepEqual(watchesFor('nums.append(5); y = nums[4]', vars, heap, ctx(undefined)), []);
    assert.deepEqual(watchesFor('grow(nums); y = nums[4]', vars, heap, ctx(undefined)), []);
    assert.ok(watchesFor('print(len(nums), nums[4])', vars, heap, ctx(undefined))[0].outOfRange);
    assert.ok(watchesFor('if (nums[4] > 0):', vars, heap, ctx(undefined))[0].outOfRange);
  });

  it('says nothing about a miss when the error came out of a call on the line, or the outcome is unknown', () => {
    const unknown: WatchContext = { func: 'fib', firstOnLine: true, outcome: 'unknown' };
    // r2_fibkey.py: fib(n - 1) raised KeyError first; the caller's seen[ch] was never read.
    assert.deepEqual(watchesFor('r = fib(n - 1) + seen[ch]', vars, heap, unknown), []);
    assert.deepEqual(watchesFor('x = get(nums, 5) + nums[j] + nums[j + 1]', vars, heap, unknown).map((x) => [x.text, x.value]), [['nums[j]', 7]]);
    // r2_cap2.py: the end of the line is past the look-ahead: a key not sent is not claimed to exist.
    const cut: Heap = { '5': { kind: 'dict', len: 700, entries: [[0, 0], [1, 1]] } };
    assert.deepEqual(watchesFor('x = slow() + memo[n]', new Map<string, Encoded>([['memo', { ref: 5 }], ['n', 9999]]), cut, { ...unknown, func: '<module>' }), []);
  });

  it('where the line raised it, a miss nothing can skip is the one, not one behind a guard', () => {
    // nums[j + 1] fails first: Python never gets to nums[j + 2].
    assert.deepEqual(watchesFor('if nums[j + 1] > 0 and nums[j + 2] > 0:', vars, heap, ctx('IndexError')).map((x) => x.text), ['nums[j + 1]']);
    // Only guarded misses: the guard is the bug, they stay; a conditional expression cannot tell which side ran.
    assert.deepEqual(watchesFor('while j <= n and nums[j + 1] > 0:', vars, heap, ctx('IndexError')).map((x) => x.text), ['nums[j + 1]']);
    assert.deepEqual(watchesFor('x = nums[j + 1] if j < n else nums[j + 2]', vars, heap, ctx('IndexError')).map((x) => x.text), ['nums[j + 1]', 'nums[j + 2]']);
  });
});

describe('lineOutcome: did the line fail by itself, or in a call it made', () => {
  const m = mod();
  const fib = (fid: number) => fr(fid, 'fib', 2, [['n', fid]]);
  // r2_fibkey.py, `r = fib(n - 1) + memo[n - 2]` on line 7 with an empty memo: fib(2)
  // (fid 3) raises KeyError at memo[0] after fib(1) returned; fib(3) (fid 2) and the module pass it on.
  const steps: TraceStepData[] = [
    step(12, [m]), // 0: print(fib(3))
    step(7, [m, fib(2)]), // 1: fib(3)
    step(7, [m, fib(2), fib(3)]), // 2: fib(2)
    step(5, [m, fib(2), fib(3), fib(4)]), // 3: fib(1)
    step(6, [m, fib(2), fib(3), fib(4)], { event: 'return', ret: 1 }), // 4
    step(7, [m, fib(2), fib(3)], { event: 'exception', exc: 'KeyError' }), // 5: its own memo[0]
    step(7, [m, fib(2), fib(3)], { event: 'return', raised: 'KeyError' }), // 6
    step(7, [m, fib(2)], { event: 'exception', exc: 'KeyError' }), // 7: passed on
    step(7, [m, fib(2)], { event: 'return', raised: 'KeyError' }), // 8
    step(12, [m], { event: 'exception', exc: 'KeyError' }), // 9
    step(12, [m], { event: 'return', raised: 'KeyError' }), // 10: "KeyError raised (program stopped)"
  ];

  it('an error that comes out of a call is not the line\'s own', () => {
    assert.deepEqual([2, 5, 6].map((k) => lineOutcome(steps, k)), Array(3).fill({ raised: 'KeyError' }));
    assert.deepEqual([0, 1, 7, 8, 9, 10].map((k) => lineOutcome(steps, k)), Array(6).fill('unknown'));
    assert.equal(lineOutcome(steps, 3), 'ran'); // fib(1) returned on line 6
    assert.equal(lineOutcome(steps, 4), undefined); // a plain return step has no line to watch
  });

  it('past the look-ahead the outcome is unknown, not "ran"', () => {
    assert.equal(lineOutcome(steps, 1, 3), 'unknown');
    assert.deepEqual(lineOutcome(steps, 2, 3), { raised: 'KeyError' }); // its exception is 3 steps ahead
  });

  it('the trace ends on the line, or inside a call the line made', () => {
    assert.equal(lineOutcome([step(1, [m]), step(2, [m])], 1), 'ended');
    assert.equal(lineOutcome([step(5, [m]), step(2, [m, fr(2, 'slow', 2)])], 0), 'unknown');
  });

  it('the line raised after its calls returned (r2_prop.py), or after a generator it read was closed', () => {
    const get = fr(2, 'get', 2);
    const prop: TraceStepData[] = [
      step(6, [m]),
      step(2, [m, get]),
      step(2, [m, get], { event: 'return', ret: 3 }),
      step(6, [m], { event: 'exception', exc: 'IndexError' }),
      step(6, [m], { event: 'return', raised: 'IndexError' }),
    ];
    assert.deepEqual([0, 3, 4].map((k) => lineOutcome(prop, k)), Array(3).fill({ raised: 'IndexError' }));
    // `x = any(a[i] > 0 for i in r) + a[9]`: any() closed the genexpr (GeneratorExit); a[9] raised.
    const ge = fr(3, '<genexpr>', 3);
    const closed: TraceStepData[] = [
      step(4, [m]),
      step(4, [m, ge]),
      step(4, [m, ge], { event: 'return', raised: 'GeneratorExit' }),
      step(4, [m], { event: 'exception', exc: 'IndexError' }),
    ];
    assert.deepEqual(lineOutcome(closed, 0), { raised: 'IndexError' });
  });

  it('a generator yields on the line; try / except catches the line\'s own error', () => {
    const g = fr(2, 'gen', 2);
    assert.equal(lineOutcome([step(3, [m, g]), step(3, [m, g], { event: 'return', yield: true, ret: 1 }), step(4, [m])], 0), 'ran');
    const caught: TraceStepData[] = [step(8, [m]), step(8, [m], { event: 'exception', exc: 'KeyError' }), step(9, [m])];
    assert.deepEqual([0, 1].map((k) => lineOutcome(caught, k)), Array(2).fill({ raised: 'KeyError' }));
    // An exception step without its line step (a statement over two lines): nothing to watch.
    assert.equal(lineOutcome([step(8, [m]), step(9, [m], { event: 'exception', exc: 'KeyError' })], 1), undefined);
  });
});

describe('a NameError in a cell', () => {
  it('names the value an earlier cell defines', () => {
    assert.equal(undefinedName("name 'hanoi' is not defined", 'print(hanoi(3, "A", "C", "B"))'), 'hanoi');
    assert.equal(undefinedName("name 'graph' is not defined. Did you mean: 'Graph'?", 'bfs(graph, 0)\n'), 'graph');
    // Assigning items or keyword arguments does not define the name.
    const swap = 'for i in range(len(nums)):\n    if nums[j] > nums[j + 1]:\n        nums[j], nums[j + 1] = nums[j + 1], nums[j]\nprint(sorted(nums, key=abs))';
    assert.equal(undefinedName("name 'nums' is not defined", swap), 'nums');
    assert.equal(undefinedName("name 'd' is not defined", 'd.x = 1\nd[k] += 1\nif d <= 3: pass'), 'd');
  });

  it('says nothing when the traced code binds the name itself (a typo, a use before the assignment)', () => {
    const binds: Array<[string, string]> = [
      ['print(x)\nx = 3', 'x'], ['def hanoi(n):\n  pass', 'hanoi'], ['import heapq', 'heapq'], ['from collections import deque', 'deque'],
      ['for i in range(3):\n  pass', 'i'], ['a, b = 1, 2', 'b'], ['n += 1', 'n'], ['with open(f) as fh:\n  pass', 'fh'],
      ['x: int = 5', 'x'], ['if (m := 3):\n  pass', 'm'], ['a = b = 0', 'b'], ['bits <<= 1', 'bits'], ['(lo, hi) = 0, 9', 'hi'], ['first, *rest = xs', 'rest'],
    ];
    for (const [src, name] of binds) assert.equal(undefinedName(`name '${name}' is not defined`, src), undefined, src);
    assert.equal(undefinedName('something else', 'x'), undefined);
  });

  const cell = 'total = 0\nfor x in nums:\n    total += x\nprnt(total)';
  const skipped = 'not run from the cells above: line 2 `nums = list(map(int, open("in.txt").read().split()))`: it calls .read(), so nums is not defined here';

  it('offers the whole file only when the notes say the name was set above and not brought in', () => {
    assert.deepEqual(missingName("name 'nums' is not defined", cell, [skipped], 'cell'), { name: 'nums', from: 'above' });
    assert.deepEqual(missingName("name 'data' is not defined", 'print(data)', ['not run from the cells above: line 3 `a, data = load()`: it calls load(), so a, data are not defined here'], 'cell')?.from, 'above');
    assert.deepEqual(missingName("name 'model' is not defined", 'model.fit(X)', ['line 4 `model = build()` failed: ValueError: bad'], 'cell')?.from, 'above');
    assert.deepEqual(missingName("name 'w' is not defined", 'print(w)', ['the cells above took more than 2.0 s, so Visualize stopped line 5 `w = train()`'], 'cell')?.from, 'above');
    // Statements left out without their names: maybe, unless Python suggests another name.
    const more = ['not run from the cells above: 2 more statement(s)'];
    assert.deepEqual(missingName("name 'nums' is not defined", cell, more, 'cell'), { name: 'nums', from: 'maybe' });
    assert.equal(missingName("name 'nums' is not defined. Did you mean: 'num'?", cell, more, 'cell'), undefined);
  });

  it('a typo in a cell keeps the plain error, even with notes about other names', () => {
    // rv_typo_cells.py: cell 2 uses nums from cell 1 (brought in) and calls prnt().
    assert.equal(missingName("name 'prnt' is not defined. Did you mean: 'print'?", cell, ['using from the cells above: nums'], 'cell'), undefined);
    assert.equal(missingName("name 'prnt' is not defined", cell, [skipped], 'cell'), undefined); // the note is about nums
    assert.equal(missingName("name 'totl' is not defined. Did you mean: 'total'?", cell, [], 'cell'), undefined);
    assert.equal(missingName("name 'foo' is not defined", cell, [], 'cell'), undefined); // no notes: nothing above explains it
  });

  it('a selection is traced on its own: a name it never binds is maybe set by the other lines', () => {
    assert.deepEqual(missingName("name 'nums' is not defined", 'print(nums[0])', [], 'selection'), { name: 'nums', from: 'maybe' });
    assert.equal(missingName("name 'prnt' is not defined. Did you mean: 'print'?", 'prnt(1)', [], 'selection'), undefined);
    assert.equal(missingName("name 'math' is not defined. Did you forget to import 'math'?", 'math.sqrt(2)', [], 'selection'), undefined);
  });
});

// ---------------------------------------------------------------- fake DOM

interface FakeNode {
  tag: string;
  attrs: Map<string, string>;
  kids: Array<FakeNode | { text: string }>;
  listeners: Map<string, (e: unknown) => void>;
}

/** Enough of `document` for webview/dom.ts: elements with attributes, children and listeners. */
function installFakeDom(): { install: () => void; remove: () => void } {
  const g = globalThis as unknown as { document?: unknown };
  let saved: unknown;
  const make = (tag: string): FakeNode => {
    const el = {
      tag,
      attrs: new Map<string, string>(),
      kids: [] as Array<FakeNode | { text: string }>,
      listeners: new Map<string, (e: unknown) => void>(),
      setAttribute(k: string, v: string) { el.attrs.set(k, String(v)); },
      getAttribute(k: string) { return el.attrs.get(k) ?? null; },
      appendChild(c: FakeNode) { el.kids.push(c); return c; },
      addEventListener(t: string, f: (e: unknown) => void) { el.listeners.set(t, f); },
      classList: { add(c: string) { el.attrs.set('class', `${el.attrs.get('class') ?? ''} ${c}`.trim()); } },
    };
    return el;
  };
  return {
    install: () => {
      saved = g.document;
      g.document = { createElementNS: (_ns: string, tag: string) => make(tag), createElement: make, createTextNode: (text: string) => ({ text }) };
    },
    remove: () => {
      g.document = saved;
    },
  };
}

function findAll(root: unknown, pred: (e: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (n: FakeNode | { text: string }) => {
    if (!('attrs' in n)) return;
    if (pred(n)) out.push(n);
    n.kids.forEach(walk);
  };
  walk(root as FakeNode);
  return out;
}

/** Text of every <text> element (drawn text, not <title> tooltips), in document order. */
function textsOf(root: unknown): string[] {
  return findAll(root, (e) => e.tag === 'text').map((e) => e.kids.map((k) => ('text' in k ? k.text : '')).join(''));
}
