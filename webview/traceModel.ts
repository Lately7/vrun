/**
 * DOM-free model of a trace: full heaps rebuilt from per-step deltas, the
 * call tree, and step navigation (over / out / to a line).
 */
import { type Encoded, type Heap, type HeapNode, fmtPy } from './format';

export interface TraceFrame {
  func: string;
  line: number;
  locals: Array<[string, Encoded]>;
  fid?: number;
  params?: string[];
  qual?: string;
  body?: boolean;
  code?: number;
}

export interface TraceStepData {
  line: number;
  event: 'line' | 'return' | 'exception';
  stack: TraceFrame[];
  heap: Heap;
  gone?: string[];
  out: number;
  ret?: Encoded;
  /** A generator suspended at a yield (ret is the yielded value). */
  yield?: boolean;
  /** The call ended by this exception instead of returning. */
  raised?: string;
  exc?: string;
  truncated?: boolean;
}

/** As sent: a number n in a stack stands for n frames unchanged since the previous step. */
export type TraceStepWire = Omit<TraceStepData, 'stack'> & { stack: Array<TraceFrame | number> };

export interface CallNode {
  fid: number;
  func: string;
  /** Qualified name: recursion is a call of the same function, not of any `__init__`. */
  qual: string;
  parent: number | undefined;
  children: number[];
  /** Arguments as seen on the first step of the call. */
  args: Array<[string, Encoded]>;
  /** A call without parameters: the first container it sees (a closure's `path`). */
  seen?: Encoded;
  /** Code object id: two lambdas share a qualified name, not a code. */
  code: number | undefined;
  startStep: number;
  /** Step of the event that ended the call (not a generator's yields). */
  endStep?: number;
  ret?: Encoded;
  /** The call ended by this exception (GeneratorExit: a generator was closed). */
  raised?: string;
}

const PARTIAL = /^(path|cur|curr|current|comb|combo|chosen|picked|perm|subset|sol|solution|stack|board|queens|cols)$/i;

/**
 * Frames of comprehensions and generator expressions: Python runs them as
 * hidden functions, but the learner never wrote or called one. As call nodes
 * they doubled the depth of `min(best(r - c) for c in coins)`. Lambdas are
 * kept: the learner wrote those.
 */
const COMPREHENSION = /^<(genexpr|listcomp|setcomp|dictcomp)>$/;

export const isComprehension = (func: string) => COMPREHENSION.test(func);

/** A box of the call stack card: a frame, and the comprehension frames running inside it (outermost first). */
export interface ShownFrame {
  f: TraceFrame;
  inner: TraceFrame[];
}

/**
 * The call stack as the card lists it, innermost first. A generator
 * expression's frame goes into the box of the frame below it, the one
 * iterating it (best() in `min(best(r - c) for c in coins)`): listed on its
 * own, <genexpr> sat between every two best() frames and doubled the stack.
 */
export function stackShown(stack: readonly TraceFrame[]): ShownFrame[] {
  const out: ShownFrame[] = [];
  let pending: TraceFrame[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    // The outermost frame (the module) has nothing below it to go into.
    if (i > 0 && COMPREHENSION.test(f.func)) {
      pending.unshift(f);
      continue;
    }
    out.push({ f, inner: pending });
    pending = [];
  }
  return out;
}

/**
 * A trace that stopped at a limit after a program state repeated (C5): steps
 * `first` and `repeat` (indexes) are the same state at `line`, with these
 * variables.
 */
export interface TraceLoop {
  first: number;
  repeat: number;
  line: number;
  values: Array<[string, Encoded]>;
  /** Only the same output was printed between the two steps. */
  prints?: boolean;
}

/**
 * The name of a NameError ("name 'hanoi' is not defined") when the traced
 * source never binds it (not a use before the assignment in this code).
 * Whether it is a typo or a value of the cells above is missingName's call.
 * A rough textual check: it errs towards "binds it", which only hides the
 * advice.
 */
export function undefinedName(evalue: string, source: string): string | undefined {
  const n = /name '([A-Za-z_]\w*)' is not defined/.exec(evalue)?.[1];
  return n && !bindsName(source, n) ? n : undefined;
}

/** `source` binds the name n somewhere: def, class, import, for, with … as, :=, or an assignment. */
function bindsName(source: string, n: string): boolean {
  // \w-only names: nothing to escape in the patterns.
  const binds = [
    new RegExp(`\\b(?:def|class)\\s+${n}\\b`),
    new RegExp(`\\bimport\\b[^\\n#]*\\b${n}\\b`), // import n, from m import n, import m as n
    new RegExp(`\\bfor\\b[^\\n#]*\\b${n}\\b[^\\n#]*\\bin\\b`),
    new RegExp(`\\b(?:as|global|nonlocal)\\s+${n}\\b`),
    new RegExp(`\\b${n}\\s*:=`),
  ];
  if (binds.some((re) => re.test(source))) return true;
  return source.split('\n').some((line) => assignedNames(line).includes(n));
}

/**
 * A NameError in part of a file that the rest of the file explains:
 * `above` when the trace's notes (C3, the cells above) name a statement
 * that sets it and was not run, failed or ran out of time; `maybe` when
 * the notes say statements were left out without naming them all, or a
 * selection was traced on its own, and Python suggests no other name.
 * A typo ("Did you mean: 'print'?") is neither: the advice to visualize the
 * whole file would send the learner the wrong way.
 */
export function missingName(
  evalue: string, source: string, notes: readonly string[], scope: 'cell' | 'selection',
): { name: string; from: 'above' | 'maybe' } | undefined {
  const name = undefinedName(evalue, source);
  if (!name) return undefined;
  let weak = scope === 'selection'; // the lines around it were not run at all
  for (const note of notes) {
    // "not run from the cells above: line 2 `nums = …`: it calls .read(), so nums, data and 2 more are not defined here"
    const listed = /\bso ([A-Za-z_]\w*(?:, [A-Za-z_]\w*)*)( and \d+ more)? (?:is|are) not defined here$/.exec(note);
    if (listed?.[1].split(', ').includes(name)) return { name, from: 'above' };
    if (listed?.[2]) weak = true;
    // "line 4 `nums = load()` failed: …", "… so Visualize stopped line 3 `model = train()`"
    for (const m of note.matchAll(/`([^`]*)`/g)) if (bindsName(m[1], name)) return { name, from: 'above' };
    // Statements or a whole cell left out, unnamed: "3 more statement(s)", "the cell at line 9 above has a syntax error".
    if (/more statement|syntax error|could not be used|took more than/.test(note)) weak = true;
  }
  return weak && !/\. Did you (?:mean|forget)\b/.test(evalue) ? { name, from: 'maybe' } : undefined;
}

/**
 * Names a line binds with `=`: `a, b = …`, `x: int = …`, `a = b = …`,
 * `n += 1`; not `nums[j] = …` or `obj.n = …` (the bubble sort's swap
 * line does not define nums), and not keyword arguments.
 */
function assignedNames(line: string): string[] {
  const targets: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') break;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === '=' && depth === 0) {
      if (line[i + 1] === '=') {
        i++; // ==
        continue;
      }
      const prev = line[i - 1] ?? '';
      // <=, >=, != compare; <<= and >>= assign.
      if ('!='.includes(prev) || (('<>'.includes(prev)) && line[i - 2] !== prev)) continue;
      let end = i;
      while (end > start && '+-*/%&|^@<>'.includes(line[end - 1])) end--; // augmented assignment
      targets.push(line.slice(start, end));
      start = i + 1;
    }
  }
  // Brackets out: a subscript target `nums[j]` becomes `nums j`, which is no name.
  return targets.flatMap((t) => t.replace(/[()[\]]/g, ' ').split(','))
    .map((p) => p.trim().replace(/^\*/, '').split(':')[0].trim())
    .filter((p) => /^[A-Za-z_]\w*$/.test(p));
}

/**
 * Why a RecursionError: the functions that recurse on the deepest stack,
 * how deep they were nested, and how their moving argument went ("n went
 * 3, 2, 1, 0, -1, … -980"), so a missing base case shows without scrolling
 * through 984 calls. The functions are those with more than one frame on
 * that stack: the innermost call may be a helper (check(n) before the
 * recursive call), and is_even() / is_odd() recurse together.
 */
export function recursionText(model: TraceModel): string | undefined {
  let deepest = 0;
  for (let k = 1; k < model.length; k++) if (model.depth(k) > model.depth(deepest)) deepest = k;
  const calls = model.calls();
  const stack = model.activeCalls(deepest).map((id) => calls.get(id)!);
  const count = new Map<string, number>();
  for (const c of stack) count.set(codeKey(c), (count.get(codeKey(c)) ?? 0) + 1);
  const rec = stack.filter((c) => count.get(codeKey(c))! > 1);
  if (rec.length < 20) return undefined;
  // Most frames first: the function the learner is looking for.
  const funcs = [...new Map(rec.map((c) => [codeKey(c), c.func])).entries()]
    .sort((a, b) => count.get(b[0])! - count.get(a[0])!).map(([, f]) => `${f}()`);
  const who = funcs.length === 1 ? `${funcs[0]} was` : `${funcs.slice(0, -1).join(', ')} and ${funcs.at(-1)} (calling each other) were`;
  // The argument that moves (i in total(nums, i)), as plain values, across all of them.
  const scalar = (v: Encoded | undefined) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
  let went = '';
  for (const [param] of rec[0].args) {
    const values = rec.map((c) => c.args.find(([p]) => p === param)?.[1]);
    if (!values.every(scalar) || values.every((v) => v === values[0])) continue;
    went = ` ${param} went ${values.slice(0, 5).map((v) => fmtPy(v)).join(', ')}, … ${fmtPy(values.at(-1))}.`;
    break;
  }
  // No "about 1000": sys.setrecursionlimit changes the limit.
  return `${who} ${rec.length} calls deep when Python stopped the recursion at its limit.${went} ` +
    'Either the calls never reach a base case that returns without calling again, or the input is too deep for recursion: ' +
    'use a loop, or raise the limit with sys.setrecursionlimit.';
}

/**
 * "Recursive calls only" without the user's choice: on when helper calls
 * would bury the recursion (N-Queens: several safe() checks per solve()), or
 * outnumber the recursive calls (quicksort's partition() with its swap()s).
 * Off for merge sort's one merge() per call: its returned list is the
 * point of the tree, and a badge would hide it.
 */
export function foldHelpersByDefault(model: TraceModel): boolean {
  const helpers = model.helpers();
  if (helpers.size <= 3) return false;
  const calls = model.calls();
  const perCaller = new Map<number, number>();
  let recursive = 0;
  for (const c of calls.values()) {
    if (model.recurses(c)) recursive++;
    if (!helpers.has(c.fid)) continue;
    const p = c.parent !== undefined && calls.has(c.parent) ? c.parent : -1;
    if (p !== -1 && helpers.has(p)) continue; // a helper's own calls: folded with it
    const n = (perCaller.get(p) ?? 0) + 1;
    if (n >= 2) return true;
    perCaller.set(p, n);
  }
  return helpers.size > recursive;
}

/**
 * How a line ended in its frame, for the values row (lineWatch):
 * `{ raised }` the line raised it itself; 'ran' it ran on without an error
 * of its own (or the frame returned or yielded on it); 'ended' the trace
 * stops right on it, before it ran (a limit); 'unknown' an error came out
 * of a call the line made, the trace stopped inside such a call, or the
 * line's end is too far ahead to look for.
 */
export type LineOutcome = 'ran' | 'ended' | 'unknown' | { raised: string };

/** How far lineOutcome looks for the end of a line's calls (a recursive call can be long). */
export const LINE_LOOKAHEAD = 4000;

/**
 * The outcome of the line of step k: a line step, or one of the line's own
 * exception / end steps (they answer for the line step they belong to);
 * undefined for other steps, or when the line step is not found.
 *
 * An error that comes out of a call is not the line's own: in
 * `r = fib(n - 1) + memo[n - 2]` with an empty memo, fib(2)'s `memo[0]`
 * raised KeyError, and the callers' memo[n - 2] were never read (fib(n - 1)
 * raised first). Read as their own error, the callers' keys showed in red.
 */
export function lineOutcome(steps: readonly TraceStepData[], k: number, limit = LINE_LOOKAHEAD): LineOutcome | undefined {
  const step = steps[k];
  const top = step?.stack.at(-1);
  if (!step || !top) return undefined;
  const d = step.stack.length;
  const here = (s: TraceStepData) => s.line === step.line && s.stack.length === d && s.stack[d - 1].fid === top.fid;
  // The line's exception event at e: its own error, unless the step before
  // is a call it made that ended by the same exception (it passed through;
  // a generator closed on the line ends by GeneratorExit, which is not it).
  const ownError = (e: number): LineOutcome => {
    const exc = steps[e].exc ?? steps[e].raised ?? '';
    const before = steps[e - 1];
    return before && before.stack.length > d && before.raised === exc ? 'unknown' : { raised: exc };
  };
  if (step.event === 'line') {
    const end = Math.min(steps.length, k + 1 + limit);
    let called = false;
    for (let j = k + 1; j < end; j++) {
      const s = steps[j];
      if (s.stack.length > d) {
        called = true; // a call the line makes: its steps come first
        continue;
      }
      return s.event === 'exception' && here(s) ? ownError(j) : 'ran';
    }
    // Stopped inside a call the line made: a subscript before the call did
    // not fail (the call ran), one after it was not reached.
    return end < steps.length || called ? 'unknown' : 'ended';
  }
  if (step.event !== 'exception' && step.raised === undefined) return undefined;
  // Back to the line step: over the line's own exception / end steps and
  // the calls it made. The exception event is the latest of the own steps.
  let e = -1;
  let j = k;
  for (; j >= 0; j--) {
    const s = steps[j];
    if (s.stack.length > d) continue;
    if (!here(s)) return undefined;
    if (s.event === 'line') break;
    if (e < 0 && s.event === 'exception') e = j;
  }
  return j < 0 ? undefined : ownError(e < 0 ? k : e);
}

/** Same function: the code object when known (two lambdas share a name), else the qualified name. */
export function sameCode(a: CallNode, b: CallNode): boolean {
  return a.code !== undefined && b.code !== undefined ? a.code === b.code : a.qual === b.qual;
}

const codeKey = (c: CallNode) => (c.code !== undefined ? `#${c.code}` : `q:${c.qual}`);

/** Full heaps are kept every CHECKPOINT steps; others are rebuilt from the nearest one. */
const CHECKPOINT = 64;

export class TraceModel {
  readonly steps: TraceStepData[];
  private readonly delta: boolean;
  private readonly checkpoints: Heap[] = [];
  private last: { k: number; heap: Heap } | undefined;
  private callsBuilt: Map<number, CallNode> | undefined;
  private recursive: boolean | undefined;
  private helpersBuilt: Set<number> | undefined;
  /** Code keys of the functions that recurse, found by helpers(). */
  private recursiveCodes: Set<string> | undefined;

  /** Expands the stacks of `steps` in place (frames are shared between steps). */
  constructor(steps: Array<TraceStepData | TraceStepWire>, heapDelta: boolean) {
    expandStacks(steps);
    this.steps = steps as TraceStepData[];
    this.delta = heapDelta;
  }

  get length(): number {
    return this.steps.length;
  }

  /** The complete heap at step k. */
  heapAt(k: number): Heap {
    const step = this.steps[k];
    if (!step) return {};
    if (!this.delta) return step.heap;
    if (this.last?.k === k) return this.last.heap;
    let heap: Heap;
    let from: number;
    if (this.last && this.last.k < k && k - this.last.k <= CHECKPOINT) {
      heap = { ...this.last.heap }; // sequential stepping: apply a few deltas
      from = this.last.k + 1;
    } else {
      const c = Math.floor(k / CHECKPOINT);
      heap = { ...this.checkpoint(c) };
      from = c * CHECKPOINT + 1;
    }
    for (let i = from; i <= k; i++) apply(heap, this.steps[i]);
    this.last = { k, heap };
    return heap;
  }

  private checkpoint(c: number): Heap {
    // checkpoints[c] is the heap after step c * CHECKPOINT.
    while (this.checkpoints.length <= c) {
      const m = this.checkpoints.length;
      const heap: Heap = m === 0 ? {} : { ...this.checkpoints[m - 1] };
      const start = m === 0 ? 0 : (m - 1) * CHECKPOINT + 1;
      const end = Math.min(m * CHECKPOINT, this.steps.length - 1);
      for (let i = start; i <= end; i++) apply(heap, this.steps[i]);
      this.checkpoints.push(heap);
    }
    return this.checkpoints[c];
  }

  depth(k: number): number {
    return this.steps[k]?.stack.length ?? 0;
  }

  /** Next step at the same or an outer depth: "step over" a call. */
  nextOver(k: number): number {
    const d = this.depth(k);
    for (let j = k + 1; j < this.steps.length; j++) if (this.depth(j) <= d) return j;
    return this.steps.length - 1;
  }

  prevOver(k: number): number {
    const d = this.depth(k);
    for (let j = k - 1; j >= 0; j--) if (this.depth(j) <= d) return j;
    return 0;
  }

  /**
   * The return step of the current call (it shows the returned value); from
   * that step, the next one. A whole call can sit on one line of its caller
   * (`fib(n - 1) + fib(n - 2)`), so "the next step at a smaller depth" would
   * skip the sibling call.
   */
  nextOut(k: number): number {
    const top = this.steps[k]?.stack.at(-1)?.fid;
    if (this.steps[k]?.event === 'return') return Math.min(k + 1, this.steps.length - 1);
    for (let j = k + 1; j < this.steps.length; j++) {
      const s = this.steps[j];
      if (s.event === 'return' && s.stack.at(-1)?.fid === top) return j;
    }
    return this.steps.length - 1;
  }

  /** Next step that is about to run `line`, wrapping around to the start. */
  nextAtLine(k: number, line: number, backwards = false): number | undefined {
    const n = this.steps.length;
    for (let o = 1; o <= n; o++) {
      const j = backwards ? (k - o + n * 2) % n : (k + o) % n;
      const s = this.steps[j];
      if (s.line === line && s.event === 'line' && s.stack.length > 0) return j;
    }
    return undefined;
  }

  /** How often each line was about to run in steps 0..k. */
  hitCounts(k: number): Map<number, number> {
    const m = new Map<number, number>();
    for (let i = 0; i <= k && i < this.steps.length; i++) {
      const s = this.steps[i];
      if (s.event === 'line') m.set(s.line, (m.get(s.line) ?? 0) + 1);
    }
    return m;
  }

  /** Calls of traced functions (the module frame is not a call). */
  calls(): Map<number, CallNode> {
    if (this.callsBuilt) return this.callsBuilt;
    const calls = new Map<number, CallNode>();
    const bodies = new Set<number>();
    this.steps.forEach((s, k) => {
      let parent: number | undefined;
      for (const f of s.stack) {
        if (f.fid === undefined) continue;
        if (f.body) bodies.add(f.fid);
        if (f.func === '<module>') {
          parent = undefined;
          continue;
        }
        if (bodies.has(f.fid)) continue; // a class body: its methods hang off the caller
        // Not a call, and not a parent: best() inside the genexpr hangs off best().
        if (COMPREHENSION.test(f.func)) continue;
        let c = calls.get(f.fid);
        if (!c) {
          const params = f.params ?? [];
          const locals = new Map(f.locals);
          c = {
            fid: f.fid,
            func: f.func,
            qual: f.qual ?? f.func,
            code: f.code,
            parent,
            children: [],
            args: params.filter((p) => locals.has(p)).map((p) => [p, locals.get(p)!] as [string, Encoded]),
            startStep: k,
          };
          if (!params.length) {
            // The partial solution of a backtracking closure, else any container.
            const refs = f.locals.filter(([, v]) => typeof v === 'object' && v !== null && 'ref' in v);
            c.seen = (refs.find(([n]) => PARTIAL.test(n)) ?? refs[0])?.[1];
          }
          calls.set(f.fid, c);
          if (parent !== undefined) calls.get(parent)?.children.push(f.fid);
        }
        parent = f.fid;
      }
      const top = s.stack[s.stack.length - 1];
      if (s.event === 'return' && !s.yield && top?.fid !== undefined) {
        const c = calls.get(top.fid);
        if (c && c.endStep === undefined) {
          c.endStep = k;
          if (s.raised !== undefined) c.raised = s.raised;
          else c.ret = s.ret;
        }
      }
    });
    this.callsBuilt = calls;
    return calls;
  }

  /** A function called (directly or not) from itself somewhere in the trace. */
  isRecursive(): boolean {
    if (this.recursive !== undefined) return this.recursive;
    const calls = this.calls();
    this.recursive = false;
    for (const c of calls.values()) {
      for (let p = c.parent; p !== undefined; p = calls.get(p)?.parent) {
        const q = calls.get(p);
        if (q && sameCode(q, c)) {
          this.recursive = true;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Calls of helper functions: the function never calls itself (directly or
   * not) anywhere in the trace, and nothing it calls does. In N-Queens these
   * are the safe() checks that buried the solve() skeleton; the recursion
   * tree can fold them into a badge on their caller.
   */
  helpers(): Set<number> {
    if (this.helpersBuilt) return this.helpersBuilt;
    const calls = this.calls();
    // Functions that recurse: a call with the same code on its own path.
    // One walk from the roots with the codes on the path (deep recursion
    // made the per-call ancestor walk quadratic).
    const recursive = (this.recursiveCodes = new Set<string>());
    const onPath = new Map<string, number>();
    const order: CallNode[] = []; // pre-order: a parent before its children
    const roots = [...calls.values()].filter((c) => c.parent === undefined || !calls.has(c.parent));
    // Iterative: a 3000-deep recursion is deeper than the JS stack likes.
    const todo: Array<{ c: CallNode; leave: boolean }> = roots.reverse().map((c) => ({ c, leave: false }));
    while (todo.length) {
      const { c, leave } = todo.pop()!;
      const key = codeKey(c);
      if (leave) {
        const n = (onPath.get(key) ?? 1) - 1;
        if (n) onPath.set(key, n);
        else onPath.delete(key);
        continue;
      }
      order.push(c);
      if (onPath.has(key)) recursive.add(key);
      onPath.set(key, (onPath.get(key) ?? 0) + 1);
      todo.push({ c, leave: true });
      for (let i = c.children.length - 1; i >= 0; i--) {
        const kid = calls.get(c.children[i]);
        if (kid) todo.push({ c: kid, leave: false });
      }
    }
    // Bottom-up: a call whose subtree reaches a recursive function is part of the skeleton.
    const reaches = new Set<number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const c = order[i];
      if (recursive.has(codeKey(c)) || c.children.some((id) => reaches.has(id))) reaches.add(c.fid);
    }
    this.helpersBuilt = new Set(order.filter((c) => !reaches.has(c.fid)).map((c) => c.fid));
    return this.helpersBuilt;
  }

  /** c is a call of a function that calls itself (directly or not) somewhere in the trace. */
  recurses(c: CallNode): boolean {
    this.helpers();
    return this.recursiveCodes!.has(codeKey(c));
  }

  /** Ids of the calls on the stack at step k, outermost first (not the module or a genexpr). */
  activeCalls(k: number): number[] {
    const calls = this.calls();
    return (this.steps[k]?.stack ?? []).map((f) => f.fid).filter((f): f is number => f !== undefined && calls.has(f));
  }
}

function expandStacks(steps: Array<TraceStepData | TraceStepWire>): void {
  let prev: TraceFrame[] = [];
  for (const s of steps) {
    if (!s.stack.some((f) => typeof f === 'number')) {
      prev = s.stack as TraceFrame[];
      continue;
    }
    const full: TraceFrame[] = [];
    for (const f of s.stack) {
      if (typeof f === 'number') full.push(...prev.slice(full.length, full.length + f));
      else full.push(f);
    }
    s.stack = full;
    prev = full;
  }
}

function apply(heap: Heap, step: TraceStepData): void {
  for (const key in step.heap) heap[key] = step.heap[key] as HeapNode;
  for (const key of step.gone ?? []) delete heap[key];
}
