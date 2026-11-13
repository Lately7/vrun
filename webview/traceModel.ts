/**
 * DOM-free model of a trace: full heaps rebuilt from per-step deltas, the
 * call tree, and step navigation (over / out / to a line).
 */
import type { Encoded, Heap, HeapNode } from './format';

export interface TraceFrame {
  func: string;
  line: number;
  locals: Array<[string, Encoded]>;
  fid?: number;
  params?: string[];
}

export interface TraceStepData {
  line: number;
  event: 'line' | 'return' | 'exception';
  stack: TraceFrame[];
  heap: Heap;
  gone?: string[];
  out: number;
  ret?: Encoded;
  exc?: string;
  truncated?: boolean;
}

export interface CallNode {
  fid: number;
  func: string;
  parent: number | undefined;
  children: number[];
  /** Arguments as seen on the first step of the call. */
  args: Array<[string, Encoded]>;
  startStep: number;
  /** Step of the return event, when the call returned. */
  endStep?: number;
  ret?: Encoded;
}

/** Full heaps are kept every CHECKPOINT steps; others are rebuilt from the nearest one. */
const CHECKPOINT = 64;

export class TraceModel {
  readonly steps: TraceStepData[];
  private readonly delta: boolean;
  private readonly checkpoints: Heap[] = [];
  private last: { k: number; heap: Heap } | undefined;
  private callsBuilt: Map<number, CallNode> | undefined;
  private recursive: boolean | undefined;

  constructor(steps: TraceStepData[], heapDelta: boolean) {
    this.steps = steps;
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
    this.steps.forEach((s, k) => {
      let parent: number | undefined;
      for (const f of s.stack) {
        if (f.fid === undefined) continue;
        if (f.func === '<module>') {
          parent = undefined;
          continue;
        }
        let c = calls.get(f.fid);
        if (!c) {
          const params = f.params ?? [];
          const locals = new Map(f.locals);
          c = {
            fid: f.fid,
            func: f.func,
            parent,
            children: [],
            args: params.filter((p) => locals.has(p)).map((p) => [p, locals.get(p)!] as [string, Encoded]),
            startStep: k,
          };
          calls.set(f.fid, c);
          if (parent !== undefined) calls.get(parent)?.children.push(f.fid);
        }
        parent = f.fid;
      }
      const top = s.stack[s.stack.length - 1];
      if (s.event === 'return' && top?.fid !== undefined) {
        const c = calls.get(top.fid);
        if (c && c.endStep === undefined) {
          c.endStep = k;
          c.ret = s.ret;
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
        if (calls.get(p)?.func === c.func) {
          this.recursive = true;
          return true;
        }
      }
    }
    return false;
  }

  /** Call ids on the stack at step k, outermost first. */
  activeCalls(k: number): number[] {
    return (this.steps[k]?.stack ?? []).map((f) => f.fid).filter((f): f is number => f !== undefined);
  }
}

function apply(heap: Heap, step: TraceStepData): void {
  for (const key in step.heap) heap[key] = step.heap[key] as HeapNode;
  for (const key of step.gone ?? []) delete heap[key];
}
