/**
 * Algorithm visualizer: a step player over a trace (Python-Tutor style)
 * plus snapshot views of single kernel variables.
 */
import { send } from './api';
import { button, clear, h } from './dom';
import { Encoded, Heap, fmtPy, isRef } from './format';
import { type Watch, outOfRangeText, watchesFor } from './lineWatch';
import {
  type ShownFrame, TraceModel, type TraceLoop, type TraceStepData, type TraceStepWire, foldHelpersByDefault, lineOutcome, missingName, recursionText,
  stackShown,
} from './traceModel';
import { animateFrom, reducedMotion, snapshot } from './viz/animate';
import { callLabel } from './viz/callLabels';
import { renderCallTree } from './viz/callTree';
import { Var } from './viz/common';
import { type StructureContext, StructureState, renderStructures } from './viz/structures';

type TraceStep = TraceStepData;
interface TraceResult {
  status: 'ok' | 'blocked';
  steps: TraceStep[];
  heapDelta?: boolean;
  stopped: string | null;
  error: { ename: string; evalue: string; traceback: string; userFrame: { line: number } | null; hint?: string } | null;
  stdout: string;
  stdoutTruncated?: boolean;
  skippedSteps?: number;
  elapsedMs?: number;
  source?: string;
  analysis?: { findings: Array<{ line: number; message: string }> };
  /** What the kernel did around the trace (definitions taken from the cells above, the working folder). */
  notes?: string[];
  /** The trace stopped at a limit and a program state had repeated: a likely endless loop. */
  loop?: TraceLoop;
}

/** Call stack card: frames listed before and after the fold of a deep stack. */
const FRAMES_TOP = 10;
const FRAMES_BOTTOM = 2;
/** As it arrives: stacks may hold runs of unchanged frames, a blocked result has no steps. */
type TraceResultWire = Omit<TraceResult, 'steps'> & { steps?: TraceStepWire[] };

/** How the step changed: animate a step or a jump made with the step buttons, not a slider drag. */
type Move = 'step' | 'jump' | 'none';

const ANIM_MS = 260;
const CALLS_BODY = '[data-anim-scope="§calls"] .viz-body';

/**
 * The step controls. Built once and updated in place: re-rendering the
 * slider while it is dragged ends the drag, and a re-rendered button loses
 * the keyboard focus.
 */
class PlayerBar {
  readonly el = h('div', { class: 'player' });
  readonly slider = h('input', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'step', class: 'step-slider' }) as HTMLInputElement;
  readonly label = h('span', { class: 'step-label' });
  readonly play: HTMLButtonElement;
  readonly out: HTMLButtonElement;
  readonly anim: HTMLButtonElement;
  readonly calls: HTMLButtonElement;
  readonly helpers: HTMLButtonElement;
  readonly speed = h('select', { 'aria-label': 'speed' }) as HTMLSelectElement;

  constructor(v: {
    go: (i: number | ((k: number) => number), move?: Move) => void;
    togglePlay: () => void;
    setSpeed: (ms: number) => void;
    toggleAnim: () => void;
    toggleCalls: () => void;
    toggleHelpers: () => void;
    speedMs: number;
    model: () => TraceModel | undefined;
  }) {
    const m = () => v.model();
    this.slider.addEventListener('input', () => v.go(Number(this.slider.value), 'none'));
    for (const [label, ms] of [['0.5×', 1200], ['1×', 600], ['2×', 300], ['4×', 150], ['8×', 75]] as const) {
      const o = h('option', { value: ms }, label);
      if (ms === v.speedMs) o.selected = true;
      this.speed.appendChild(o);
    }
    this.speed.addEventListener('change', () => v.setSpeed(Number(this.speed.value)));
    this.play = button('▶', () => v.togglePlay(), { title: 'Play / pause (Space)', cls: 'btn primary' });
    this.out = button('⤴', () => v.go((k) => m()?.nextOut(k) ?? k, 'jump'), { title: 'Step out: run until this function returns (↑)' });
    this.anim = button('✦ Animate', () => v.toggleAnim(), { cls: 'btn small', title: 'Animate changes between steps (swaps slide, pointers move)' });
    this.calls = button('Calls', () => v.toggleCalls(), { cls: 'btn small', title: 'Show the recursion tree' });
    this.helpers = button('Recursive calls only', () => v.toggleHelpers(), {
      cls: 'btn small',
      title: 'Fold the calls of helper functions that do not recurse (like safe() in N-Queens) into a "+4 safe()" badge on their caller',
    });
    this.el.append(
      button('⏮', () => v.go(0, 'none'), { title: 'First step (Home)' }),
      button('◀', () => v.go((k) => k - 1), { title: 'Previous step (←)' }),
      this.play,
      button('▶|', () => v.go((k) => k + 1), { title: 'Next step (→)' }),
      button('⤼', () => v.go((k) => m()?.nextOver(k) ?? k, 'jump'), { title: 'Step over: next line in this function, without entering calls (↓; Shift+← goes back)' }),
      this.out,
      button('⏭', () => v.go(Number.MAX_SAFE_INTEGER, 'none'), { title: 'Last step (End)' }),
      this.slider,
      this.label,
      this.speed,
      this.anim,
      this.calls,
      this.helpers,
    );
  }

  sync(s: { index: number; n: number; playing: boolean; inCall: boolean; animate: boolean; recursive: boolean; showCalls: boolean; helpers: boolean; foldHelpers: boolean }): void {
    this.slider.max = String(Math.max(0, s.n - 1));
    if (this.slider.value !== String(s.index)) this.slider.value = String(s.index);
    this.label.textContent = s.n ? `Step ${s.index + 1} / ${s.n}` : 'No steps';
    this.play.textContent = s.playing ? '⏸' : '▶';
    this.out.disabled = !s.inCall;
    this.anim.textContent = s.animate ? '✦ Animate' : '✧ Animate';
    this.anim.classList.toggle('on', s.animate);
    this.anim.setAttribute('aria-pressed', String(s.animate));
    this.calls.hidden = !s.recursive;
    this.calls.classList.toggle('on', s.showCalls);
    this.calls.setAttribute('aria-pressed', String(s.showCalls));
    // Only with the tree shown and helper calls to fold.
    this.helpers.hidden = !(s.recursive && s.showCalls && s.helpers);
    this.helpers.classList.toggle('on', s.foldHelpers);
    this.helpers.setAttribute('aria-pressed', String(s.foldHelpers));
  }
}

export class Visualizer {
  readonly el = h('div', { class: 'visualizer' });
  private readonly introEl = h('div', { class: 'viz-intro' });
  private readonly messageEl = h('div', {});
  private readonly contentEl = h('div', { class: 'viz-content' });
  private readonly player: PlayerBar;
  private trace: TraceResult | undefined;
  private model: TraceModel | undefined;
  private label = '';
  private lineOffset = 0;
  private index = 0;
  /**
   * The step the user chose. A live re-trace that fails or has no steps
   * (a half-typed line) must not lose it for the next good one.
   */
  private wantedIndex: number | undefined;
  private playing: ReturnType<typeof setInterval> | undefined;
  private speedMs = 600;
  private state: StructureState = { modes: new Map() };
  private snapshot: { name: string; root: Encoded; heap: Heap } | undefined;
  private busy = '';
  private liveViz = false;
  private latestExecId = 0;
  /** execId of the trace on screen; step highlights are resolved against it. */
  private traceExecId = 0;
  /** Off by default with the OS "reduce motion" setting; the button still turns it on. */
  private animate = !reducedMotion();
  private showCalls = true;
  /** "Recursive calls only" as the user set it; until then each trace picks (see foldHelpers). */
  private foldHelpersChoice: boolean | undefined;
  /** The trace's own pick (foldHelpersByDefault), worked out once per trace. */
  private foldHelpersDefault = false;
  /** Callers whose folded helper calls were unfolded with a click on their badge (this trace). */
  private expandedHelpers = new Set<number>();
  /** The middle of a deep call stack was unfolded (this trace). */
  private framesOpen = false;
  /** Variables and heap of the trace's last step (stable layouts), built once per trace. */
  private finalState: StructureContext['final'] | undefined;

  constructor() {
    this.player = new PlayerBar({
      go: (i, move) => this.go(typeof i === 'function' ? i(this.index) : i, move),
      togglePlay: () => this.togglePlay(),
      setSpeed: (ms) => {
        this.speedMs = ms;
        if (this.playing) {
          this.stop();
          this.togglePlay();
        }
      },
      toggleAnim: () => {
        this.animate = !this.animate;
        this.render();
      },
      toggleCalls: () => {
        this.showCalls = !this.showCalls;
        this.render();
      },
      toggleHelpers: () => {
        this.foldHelpersChoice = !this.foldHelpers();
        this.render();
      },
      speedMs: this.speedMs,
      model: () => this.model,
    });
    this.el.append(this.introEl, this.messageEl, this.player.el, this.contentEl);
    this.render();
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if ((e.target as HTMLElement).tagName === 'SELECT') return;
      const m = this.model;
      if (e.key === 'ArrowRight') this.go(this.index + 1);
      else if (e.key === 'ArrowLeft' && e.shiftKey) this.go(m?.prevOver(this.index) ?? 0, 'jump');
      else if (e.key === 'ArrowLeft') this.go(this.index - 1);
      else if (e.key === 'ArrowDown') this.go(m?.nextOver(this.index) ?? 0, 'jump');
      else if (e.key === 'ArrowUp') {
        // Like the disabled button: at module level there is nothing to step out of.
        if (m && m.depth(this.index) > 1) this.go(m.nextOut(this.index), 'jump');
      } else if (e.key === 'Home') this.go(0, 'none');
      else if (e.key === 'End') this.go(Number.MAX_SAFE_INTEGER, 'none');
      else if (e.key === ' ') this.togglePlay();
      else return;
      e.preventDefault();
    });
    this.el.tabIndex = 0;
  }

  setLiveViz(on: boolean): void {
    this.liveViz = on;
    this.render();
  }

  started(execId: number, label: string): void {
    this.latestExecId = execId;
    this.busy = `Tracing ${label}…`;
    this.renderStatus();
  }

  /** A live trace was superseded by a newer edit: clear its busy state. */
  superseded(execId: number): void {
    if (execId !== this.latestExecId) return; // a newer trace is still running
    this.busy = '';
    this.renderStatus();
  }

  failed(execId: number, message: string): void {
    if (execId < this.latestExecId) return; // a newer trace is in charge
    this.stop(); // the playback timer would otherwise keep firing
    this.busy = '';
    this.trace = undefined;
    this.model = undefined;
    this.snapshot = undefined;
    this.render(message);
  }

  setTrace(execId: number, wire: TraceResultWire, label: string, mode: string, lineOffset: number): void {
    if (execId < this.latestExecId) return; // an older trace finished after a newer one started
    this.traceExecId = execId;
    this.busy = '';
    this.snapshot = undefined;
    // A blocked live trace has no steps: every step lookup must still work.
    const steps = wire.steps ?? [];
    this.model = new TraceModel(steps, !!wire.heapDelta);
    this.foldHelpersDefault = foldHelpersByDefault(this.model);
    const result: TraceResult = { ...wire, steps: this.model.steps };
    this.trace = result;
    this.finalState = undefined;
    this.label = label;
    this.lineOffset = lineOffset;
    this.stop();
    const n = result.steps.length;
    const live = mode === 'live' && this.wantedIndex !== undefined;
    if (!live) {
      this.wantedIndex = 0;
      // Call ids of another program: unfolded badges and frames start folded
      // again. A live edit keeps them, like the step.
      this.expandedHelpers = new Set();
      this.framesOpen = false;
    }
    // Live edits keep the chosen step so the picture updates in place.
    this.index = n ? Math.min(this.wantedIndex ?? 0, n - 1) : 0;
    this.render(undefined, live ? 'step' : 'none');
    this.notifyLine();
  }

  showSnapshot(name: string, root: Encoded, heap: Heap): void {
    this.stop();
    this.trace = undefined;
    this.model = undefined;
    this.snapshot = { name, root, heap };
    this.render();
  }

  private go(i: number, move?: Move): void {
    if (!this.trace || this.trace.steps.length === 0) return;
    const last = this.trace.steps.length - 1;
    const clamped = Math.max(0, Math.min(last, i));
    if (clamped === this.index) {
      if (this.playing && clamped === last) {
        this.stop();
        this.render();
      }
      return;
    }
    const how: Move = move ?? (Math.abs(clamped - this.index) === 1 ? 'step' : 'none');
    this.index = clamped;
    this.wantedIndex = clamped;
    // Reaching the end stops playback, so the button shows ▶ on the last step.
    if (this.playing && clamped === last) this.stop();
    this.render(undefined, how);
    this.notifyLine();
  }

  private notifyLine(): void {
    const step = this.trace?.steps[this.index];
    if (step) send({ type: 'traceStep', execId: this.traceExecId, line: step.line });
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stop();
      this.render();
    } else if (this.trace && this.trace.steps.length) {
      if (this.index >= this.trace.steps.length - 1) this.index = 0;
      this.playing = setInterval(() => this.go(this.index + 1, 'step'), this.speedMs);
      this.render();
    }
  }

  private stop(): void {
    if (this.playing) clearInterval(this.playing);
    this.playing = undefined;
  }

  /** "Recursive calls only": the user's choice, else the trace's (on for N-Queens, off for merge sort). */
  private foldHelpers(): boolean {
    return this.foldHelpersChoice ?? this.foldHelpersDefault;
  }

  private statusEl = h('div', { class: 'viz-status', role: 'status' });

  private renderStatus(): void {
    clear(this.statusEl);
    if (this.busy) this.statusEl.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), this.busy);
  }

  private animMs(move: Move): number {
    if (!this.animate || move === 'none') return 0;
    // While playing, finish before the next step arrives.
    return this.playing ? Math.min(ANIM_MS, Math.round(this.speedMs * 0.7)) : ANIM_MS;
  }

  private render(message?: string, move: Move = 'none'): void {
    const ms = this.animMs(move);
    const before = ms > 0 ? snapshot(this.el) : undefined;
    const scrollTop = this.el.scrollTop;
    const hadFocus = this.el.contains(document.activeElement);
    // The views are rebuilt: carry over where the code and the recursion
    // tree were scrolled, or each step would jump back to the start.
    const codeTop = this.el.querySelector('ol.code')?.scrollTop ?? 0;
    const callsBody = this.el.querySelector(CALLS_BODY);
    const callsAt = { left: callsBody?.scrollLeft ?? 0, top: callsBody?.scrollTop ?? 0 };
    const framesTop = this.el.querySelector('.frames')?.scrollTop ?? 0;
    this.build(message);
    this.el.classList.toggle('no-anim', !this.animate);
    this.el.scrollTop = scrollTop;
    const frames = this.el.querySelector('.frames');
    if (frames) frames.scrollTop = framesTop;
    // Before the animation: no transforms yet, so the boxes are where they end.
    this.keepInView(codeTop, callsAt);
    if (before) animateFrom(before, this.el, ms);
    // A clicked code line or call node was replaced: keep the arrow keys working.
    if (hadFocus && !this.el.contains(document.activeElement)) this.el.focus({ preventScroll: true });
  }

  private keepInView(codeTop: number, callsAt: { left: number; top: number }): void {
    const ol = this.el.querySelector<HTMLElement>('ol.code');
    if (ol) {
      ol.scrollTop = codeTop;
      const li = ol.querySelector<HTMLElement>('li.cur');
      if (li) {
        // Scroll the code list only (scrollIntoView also scrolled the page).
        const pos = li.getBoundingClientRect().top - ol.getBoundingClientRect().top + ol.scrollTop;
        const lh = li.offsetHeight || 16;
        if (pos < ol.scrollTop || pos > ol.scrollTop + ol.clientHeight - lh) ol.scrollTop = pos - ol.clientHeight / 2;
      }
    }
    const body = this.el.querySelector<HTMLElement>(CALLS_BODY);
    if (body) {
      body.scrollLeft = callsAt.left;
      body.scrollTop = callsAt.top;
      // A wide recursion tree scrolls sideways, a deep one (its height is
      // capped) up and down: keep the running call in view.
      const call = body.querySelector('.call.current');
      if (call) {
        const b = body.getBoundingClientRect();
        const c = call.getBoundingClientRect();
        if (c.left < b.left || c.right > b.right) body.scrollLeft += c.left - b.left - (b.width - c.width) / 2;
        if (c.top < b.top || c.bottom > b.bottom) body.scrollTop += c.top - b.top - (b.height - c.height) / 2;
      }
    }
  }

  private renderIntro(): void {
    clear(this.introEl);
    this.introEl.append(
      button('▶ Visualize current file / cell', () => send({ type: 'command', command: 'visualize' }), { cls: 'btn primary', title: 'vrun: Visualize Algorithm (Ctrl+Alt+V)' }),
      button(this.liveViz ? '● Live visualize: ON' : '○ Live visualize: OFF', () => send({ type: 'command', command: 'toggleLiveVisualize' }), {
        cls: `btn ${this.liveViz ? 'on' : ''}`,
        pressed: this.liveViz,
        title: 'Re-trace automatically while you type',
      }),
      this.statusEl,
    );
  }

  private build(message?: string): void {
    this.renderStatus();
    this.renderIntro();
    clear(this.messageEl);
    clear(this.contentEl);
    if (message) this.messageEl.appendChild(h('p', { class: 'error-text' }, message));
    const c = this.contentEl;
    this.player.el.hidden = true;

    if (this.snapshot) {
      const vars: Var[] = [{ name: this.snapshot.name, value: this.snapshot.root, depth: 0 }];
      c.appendChild(h('h3', {}, `Variable ${this.snapshot.name} (kernel snapshot)`));
      c.appendChild(renderStructures(vars, this.snapshot.heap, undefined, this.state, () => this.render()));
      return;
    }
    const t = this.trace;
    const model = this.model;
    if (!t || !model) {
      c.appendChild(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'Write an algorithm (sorting, searching, recursion, BFS/DFS, linked lists, trees, DP…) and press Visualize.'),
          h('p', { class: 'muted' }, 'The code runs in a separate, fresh namespace: your kernel variables are not changed. Use arrow keys to step.'),
        ),
      );
      return;
    }
    if (t.status === 'blocked') {
      const f = t.analysis?.findings[0];
      c.appendChild(h('p', { class: 'warn-text' }, `Live visualize skipped: ${f ? `line ${f.line + this.lineOffset}: ${f.message}` : 'unsafe code'}. Run "Visualize" manually if you really want this.`));
      return;
    }
    const n = t.steps.length;
    const step = t.steps[this.index];
    this.player.el.hidden = false;
    this.player.sync({
      index: this.index,
      n,
      playing: !!this.playing,
      inCall: model.depth(this.index) > 1,
      animate: this.animate,
      recursive: model.isRecursive(),
      showCalls: this.showCalls,
      helpers: model.helpers().size > 0,
      foldHelpers: this.foldHelpers(),
    });
    c.appendChild(h('div', { class: 'run-meta' }, this.label, h('span', { class: 'meta-note' }, `${t.elapsedMs ?? 0} ms`)));
    // "using from the cells above: hanoi, build", "working folder: …": part of the run's header.
    const notes = (t.notes ?? []).filter((x) => typeof x === 'string' && x);
    if (notes.length) c.appendChild(h('div', { class: 'viz-notes' }, ...notes.map((x) => h('div', {}, x))));
    if (t.loop) c.appendChild(this.renderLoop(t, t.loop));
    else if (t.stopped) {
      // Only a plain step limit: for an endless loop (above) more steps cannot help.
      const hint = /step limit/.test(t.stopped) ? ' Raise "vrun.trace.maxSteps" in Settings, or trace a smaller input.' : '';
      c.appendChild(h('p', { class: 'warn-text' }, `Trace stopped early: ${t.stopped}. Steps before that are shown.${hint}`));
      // A function from the cells above ran out of time: its steps are only visible when the whole file is traced.
      if (/from the cells above/.test(t.stopped)) {
        c.appendChild(button('▶ Visualize whole file', () => send({ type: 'command', command: 'visualizeFile' }), {
          cls: 'btn small',
          title: 'vrun: Visualize File — trace the whole file from the top, so the steps inside that function are shown',
        }));
      }
    }
    if (t.skippedSteps) c.appendChild(h('p', { class: 'muted small' }, `${t.skippedSteps} step(s) close to the recursion limit could not be drawn.`));
    if (t.error) c.appendChild(h('pre', { class: 'error-text' }, `${t.error.ename}: ${t.error.evalue}${t.error.userFrame ? ` (line ${t.error.userFrame.line + this.lineOffset})` : ''}`));
    const missing = this.missingName(t);
    if (missing) c.appendChild(missing);
    // The kernel's advice for the error (an index past the end); for a deep recursion, ours.
    if (t.error?.hint) c.appendChild(h('p', { class: 'muted small viz-hint' }, t.error.hint));
    else if (t.error?.ename === 'RecursionError') {
      const why = recursionText(model);
      if (why) c.appendChild(h('p', { class: 'muted small viz-hint' }, why));
    }
    // input() without a .in file: offer to create it right where the error is.
    if (t.error?.ename === 'EOFError' && t.error.evalue.includes('.in')) {
      c.appendChild(button('Create the .in input file', () => send({ type: 'command', command: 'editInput' }), { cls: 'link-btn' }));
    }
    if (!step) return;

    const heap = model.heapAt(this.index);
    const prevHeap = this.index > 0 ? model.heapAt(this.index - 1) : undefined;
    const prev = this.index > 0 ? t.steps[this.index - 1] : undefined;
    const vars = varsOf(step);
    const layout = h('div', { class: 'viz-layout' });
    layout.appendChild(this.renderCode(t.source ?? '', step, prev, heap));
    const right = h('div', { class: 'viz-right' });
    if (this.showCalls && model.isRecursive()) {
      const tree = renderCallTree(model, this.index, (k) => model.heapAt(k), (k) => this.go(k, 'jump'), {
        foldHelpers: this.foldHelpers(),
        expanded: this.expandedHelpers,
        onToggle: (owner) => {
          if (!this.expandedHelpers.delete(owner)) this.expandedHelpers.add(owner);
          this.render();
        },
      });
      if (tree) {
        const calls = [...model.calls().values()].filter((x) => x.startStep <= this.index).length;
        right.appendChild(
          h('section', { class: 'viz-card', 'data-anim-scope': '§calls' },
            h('header', {}, h('span', { class: 'viz-title' }, 'Recursion tree'), h('span', { class: 'muted' }, `${calls} call${calls === 1 ? '' : 's'} so far · click a call to jump to it`)),
            tree.note ? h('div', { class: 'muted small calls-note' }, tree.note) : null,
            h('div', { class: 'viz-body calls-body' }, tree.svg)),
        );
      }
    }
    // event: on its own return step a list method no longer counts as "still relinking".
    const ctx: StructureContext = { source: t.source ?? '', frames: step.stack, final: this.final(), event: step.event };
    right.appendChild(renderStructures(vars, heap, prevHeap, this.state, () => this.render(), ctx));
    right.appendChild(this.renderFrames(step, prev, heap));
    const out = t.stdout.slice(0, step.out);
    right.appendChild(h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, 'Output so far')), h('pre', { class: 'console small' }, out || ' ')));
    layout.appendChild(right);
    c.appendChild(layout);
  }

  private final(): StructureContext['final'] {
    if (!this.finalState && this.model && this.model.length) {
      const k = this.model.length - 1;
      this.finalState = { vars: varsOf(this.model.steps[k]), heap: this.model.heapAt(k) };
    }
    return this.finalState;
  }

  private renderCode(source: string, step: TraceStep, prev: TraceStep | undefined, heap: Heap): HTMLElement {
    const lines = source.split(/\r?\n/);
    const hits = this.model?.hitCounts(this.index) ?? new Map<number, number>();
    const pre = h('ol', { class: 'code', start: 1 + this.lineOffset, 'aria-label': 'source code' });
    const raised = step.event === 'exception' || step.raised !== undefined;
    lines.forEach((text, i) => {
      const ln = i + 1;
      const cls = ln === step.line ? (raised ? 'cur exc' : step.event === 'return' ? 'cur ret' : 'cur') : prev && ln === prev.line ? 'prev' : '';
      const count = hits.get(ln);
      // The count sits in its own column before the code: floated after a
      // long line it dropped onto the next line.
      const li = h('li', { class: `${cls} runnable`, title: 'Click: run to the next time this line runs (Shift+click: the previous time)' },
        h('span', { class: 'hits', title: count ? `ran ${count} time${count === 1 ? '' : 's'} so far` : 'not run yet' }, count ? `×${count}` : ''), text || ' ');
      li.addEventListener('click', (e) => {
        const k = this.model?.nextAtLine(this.index, ln, e.shiftKey);
        if (k !== undefined) this.go(k, 'jump');
      });
      pre.appendChild(li);
    });
    const header = h('div', { class: 'muted' }, `Line ${step.line + this.lineOffset}: ${eventText(step, heap)}`);
    const watches = this.watches(lines[step.line - 1] ?? '', step, prev, heap);
    const watchEl = watches.length
      ? h('div', { class: 'line-watch', 'aria-label': 'values on this line' }, ...watches.map((w) => watchView(w, heap)))
      : null;
    return h('div', { class: 'viz-code' }, header, watchEl, pre);
  }

  /**
   * The values of the subscripts on the line about to run, as the running
   * frame sees them; on the steps where that line failed (IndexError,
   * KeyError), the subscript that failed and why.
   */
  private watches(line: string, step: TraceStep, prev: TraceStep | undefined, heap: Heap): Watch[] {
    const top = step.stack[step.stack.length - 1];
    // A line step, or the line's own exception / end steps: whether the line
    // failed by itself, not in a call it made (traceModel.lineOutcome).
    const outcome = this.model ? lineOutcome(this.model.steps, this.index) : undefined;
    if (!top || !outcome) return [];
    // A function sees its own locals (closures: their free variables too)
    // and the globals, not its callers' locals.
    const module = step.stack[0]?.func === '<module>' ? step.stack[0] : undefined;
    const names = new Map<string, Encoded>([...(module && module !== top ? module.locals : []), ...top.locals]);
    const prevTop = prev?.stack[prev.stack.length - 1];
    const firstOnLine = step.event === 'line' && (!prev || prev.line !== step.line || prevTop?.fid !== top.fid);
    return watchesFor(line, names, heap, { func: top.func, firstOnLine, outcome });
  }

  /** An endless loop (C5): the two steps with the same state, and buttons to compare them. */
  private renderLoop(t: TraceResult, loop: TraceLoop): HTMLElement {
    const last = Math.max(0, t.steps.length - 1);
    const clamp = (k: number) => Math.max(0, Math.min(last, Math.floor(Number(k) || 0)));
    const a = clamp(loop.first);
    const b = clamp(loop.repeat);
    const heap = this.model?.heapAt(b) ?? {};
    const values = (Array.isArray(loop.values) ? loop.values : []).filter((v) => Array.isArray(v) && typeof v[0] === 'string');
    // lo = 4, hi = 5, mid = 4 tell the story; "nums = list[7]" does not.
    const plain = values.filter(([, v]) => !isRef(v));
    const state = (plain.length ? plain : values).map(([name, v]) => `${name} = ${fmtPy(v, heap)}`).join(', ');
    // Own wording, not t.stopped: the steps and values below would repeat it.
    return h('div', { class: 'loop-box', role: 'note' },
      // The trace ran to its limit; the repeat is what the trace can see, not proof.
      h('p', { class: 'warn-text' }, 'The trace reached its limit while repeating the same state: this looks like an endless loop.'),
      h('p', {},
        `Step ${b + 1} is exactly the same as step ${a + 1}: line ${loop.line + this.lineOffset}${state ? `, ${state}` : ''}. `,
        loop.prints ? 'Only the same output was printed in between, ' : 'Nothing changed in between, ',
        'so it repeats forever unless something outside the trace changes. More steps (vrun.trace.maxSteps) will not help: ',
        'check that each pass changes a variable of the loop condition.'),
      h('div', { class: 'loop-jumps' },
        button(`Show step ${a + 1}`, () => this.go(a, 'jump'), { cls: 'btn small', title: 'The first time the program was in this state' }),
        button(`Show step ${b + 1}`, () => this.go(b, 'jump'), { cls: 'btn small', title: 'The same state again' })));
  }

  /**
   * A NameError for a value of the rest of the file: Visualize ran the cell
   * (or the selection) on its own, so a value an earlier cell computed is
   * missing (the error alone read like a bug in the learner's code). Only
   * with evidence (missingName): a typo must keep the plain error.
   */
  private missingName(t: TraceResult): HTMLElement | undefined {
    if (t.error?.ename !== 'NameError') return undefined;
    // The host's labels for part of a file (controller.ts); a whole file is named after itself, even cell.py.
    const scope = /^selection \(line \d+\)$/.test(this.label) ? 'selection' : /^cell at line \d+$/.test(this.label) ? 'cell' : undefined;
    if (!scope) return undefined;
    const notes = (t.notes ?? []).filter((x): x is string => typeof x === 'string');
    const m = missingName(t.error.evalue, t.source ?? '', notes, scope);
    if (!m) return undefined;
    const name = h('code', {}, m.name);
    const text = scope === 'selection'
      ? [name, ' is not defined in the selection. Visualize traces only the selected lines, in a fresh namespace, so what the other lines set is missing.']
      : m.from === 'above'
        ? [name, ' is set in the cells above, but Visualize could not bring it in (see the note above): it traces this cell on its own, ',
          'and from the cells above it runs only definitions, imports of modules already imported, simple values and calls of your own helpers that only compute; ',
          'never files, input, data loading, training or the first import of a module.']
        : [name, ' is not defined in this cell, and some of the cells above were not used (see the notes above). ',
          'If an earlier cell sets it: Visualize traces this cell on its own.'];
    return h('div', { class: 'viz-missing', role: 'note' },
      h('p', {}, ...text, ' Visualize whole file runs the file from the top.'),
      button('▶ Visualize whole file', () => send({ type: 'command', command: 'visualizeFile' }), {
        cls: 'btn small',
        title: 'vrun: Visualize File — trace the whole file from the top, ignoring cells',
      }));
  }

  private renderFrames(step: TraceStep, prev: TraceStep | undefined, heap: Heap): HTMLElement {
    // Innermost first, a generator expression inside the frame iterating it
    // ("I never wrote a function called genexpr", and best() <genexpr> best()
    // doubled the stack of a top-down DP).
    const frames = stackShown(step.stack);
    const sec = h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, 'Call stack'), h('span', { class: 'muted' }, `${frames.length} frame(s)`)));
    const body = h('div', { class: 'frames' });
    // A local changed since the previous step when the same call had a different value.
    const before = new Map<string, string>();
    for (const f of prev?.stack ?? []) for (const [name, val] of f.locals) before.set(`${f.fid ?? f.func}\u0000${name}`, JSON.stringify(val));
    const rows = (table: HTMLElement, f: TraceStep['stack'][number], shown: Map<string, string>) => {
      for (const [name, val] of f.locals) {
        // Class and function definitions are not state: keep the stack about data.
        if (typeof val === 'object' && val !== null && '$t' in val && (val.$t === 'cls' || val.$t === 'fn')) continue;
        if (name.startsWith('.')) continue; // a generator expression's hidden ".0" iterator
        // The running genexpr also lists rem of best() (a shared cell, so the
        // same value): once is enough. A loop variable `x` shadowing the
        // function's `x` has its own value and stays.
        const json = JSON.stringify(val);
        if (shown.get(name) === json) continue;
        shown.set(name, json);
        const old = before.get(`${f.fid ?? f.func}\u0000${name}`);
        const changed = prev !== undefined && old !== json && (old !== undefined || prev.stack.some((p) => p.fid === f.fid));
        table.appendChild(h('tr', { class: changed ? 'changed' : '' }, h('th', {}, name), h('td', {}, fmtPy(val, heap))));
      }
    };
    const frame = ({ f, inner }: ShownFrame, i: number) => {
      const table = h('table', { class: 'kv' });
      const shown = new Map<string, string>();
      rows(table, f, shown);
      for (const g of inner) {
        // Its loop variable (c of `for c in coins`) is the coin being tried: keep it, under its own heading.
        const what = g.func === '<genexpr>' ? 'generator expression' : 'comprehension';
        const head = h('tr', { class: 'comp-head' }, h('td', { colspan: 2 }, `in the ${what} (line ${g.line + this.lineOffset})`));
        table.appendChild(head);
        const n = table.childElementCount;
        rows(table, g, shown);
        if (table.childElementCount === n) head.remove(); // nothing of its own to show
      }
      return h('div', { class: `frame ${i === 0 ? 'top' : ''}` }, h('div', { class: 'frame-name' }, `${f.func}  (line ${f.line + this.lineOffset})`), table);
    };
    // A deep recursion listed 984 frames (45,000 px): the innermost ones and
    // the outermost two, the middle folded like Python's "[Previous line
    // repeated 986 more times]".
    const foldable = frames.length > FRAMES_TOP + FRAMES_BOTTOM + 3;
    if (!foldable || this.framesOpen) {
      frames.forEach((f, i) => {
        // Where "… N more frames" was: the list scrolls, its end may be far.
        if (foldable && i === FRAMES_TOP) body.appendChild(button('▾ Fold the middle frames again', () => this.setFramesOpen(false), { cls: 'link-btn more-frames' }));
        body.appendChild(frame(f, i));
      });
    } else {
      frames.slice(0, FRAMES_TOP).forEach((f, i) => body.appendChild(frame(f, i)));
      const middle = frames.slice(FRAMES_TOP, frames.length - FRAMES_BOTTOM);
      body.appendChild(button(`… ${middle.length} more frames${this.framesSummary(middle)}`, () => this.setFramesOpen(true), {
        cls: 'link-btn more-frames',
        title: 'Show every frame',
      }));
      frames.slice(-FRAMES_BOTTOM).forEach((f, i) => body.appendChild(frame(f, frames.length - FRAMES_BOTTOM + i)));
    }
    sec.appendChild(body);
    return sec;
  }

  private setFramesOpen(open: boolean): void {
    this.framesOpen = open;
    this.render();
  }

  /** ": countdown(-2) … countdown(-969)" for folded frames of one function, else their function names. */
  private framesSummary(shown: ShownFrame[]): string {
    const frames = shown.map((x) => x.f);
    const calls = this.model?.calls();
    const funcs = [...new Set(frames.map((f) => f.func))];
    const first = frames[0]?.fid !== undefined ? calls?.get(frames[0].fid) : undefined;
    const last = frames.at(-1)?.fid !== undefined ? calls?.get(frames.at(-1)!.fid!) : undefined;
    if (funcs.length === 1 && first && last && this.model) {
      const heapAt = (k: number) => this.model!.heapAt(k);
      return `: ${callLabel(first, heapAt)} … ${callLabel(last, heapAt)}`;
    }
    return ` (${funcs.slice(0, 3).join(', ')}${funcs.length > 3 ? ', …' : ''})`;
  }
}

/** One value of the line: `nums[j] = 7`, a red `nums[j + 1]: index 4, len 4 (0..3)`, or `(not shown)`. */
function watchView(w: Watch, heap: Heap): HTMLElement {
  if (w.outOfRange) {
    const m = w.outOfRange;
    const why = !('key' in m) ? 'Python raises IndexError here: the index is outside the list'
      : m.sent !== undefined ? 'The line raised KeyError. The dict is too long to send every entry, and this key is not among those sent'
        : 'Python raises KeyError here';
    return h('span', { class: 'watch out-of-range', title: why }, h('code', {}, w.text), ': ', h('b', {}, outOfRangeText(w.outOfRange)));
  }
  if (w.notShown) {
    return h('span', { class: 'watch not-shown', title: 'This item exists, but it was not sent: a long list or dict is cut (its card says how much is shown)' }, h('code', {}, w.text), ' = ', h('i', {}, '(not shown)'));
  }
  return h('span', { class: 'watch' }, h('code', {}, w.text), ' = ', h('b', {}, fmtPy(w.value, heap)));
}

/** What the step is about to do or just did, for the code header. */
function eventText(step: TraceStep, heap: Heap): string {
  // Code at module level has no function to leave: the error ends the program.
  const module = step.stack.at(-1)?.func === '<module>';
  if (step.event === 'exception') return `exception ${step.exc ?? ''}`;
  if (step.event !== 'return') return 'about to run';
  if (step.raised === 'GeneratorExit') return 'generator closed';
  if (step.raised !== undefined) return module ? `${step.raised} raised (program stopped)` : `${step.raised} raised, leaving the function`;
  if (module) return 'end of the program';
  return `${step.yield ? 'yield' : 'return'} ${fmtPy(step.ret, heap)}`;
}

/** Variables visible at a step: innermost frame first, then outer frames (unshadowed). */
function varsOf(step: TraceStep): Var[] {
  const out: Var[] = [];
  const seen = new Set<string>();
  for (let d = step.stack.length - 1; d >= 0; d--) {
    for (const [name, value] of step.stack[d].locals) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, value, depth: d });
    }
  }
  return out;
}
