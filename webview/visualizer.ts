/**
 * Algorithm visualizer: a step player over a trace (Python-Tutor style)
 * plus snapshot views of single kernel variables.
 */
import { send } from './api';
import { button, clear, h } from './dom';
import { Encoded, Heap, fmtScalar } from './format';
import { watchesFor } from './lineWatch';
import { TraceModel, type TraceStepData } from './traceModel';
import { animateFrom, reducedMotion, snapshot } from './viz/animate';
import { renderCallTree } from './viz/callTree';
import { Var } from './viz/common';
import { type StructureContext, StructureState, renderStructures } from './viz/structures';

type TraceStep = TraceStepData;
interface TraceResult {
  status: 'ok' | 'blocked';
  steps: TraceStep[];
  heapDelta?: boolean;
  stopped: string | null;
  error: { ename: string; evalue: string; traceback: string; userFrame: { line: number } | null } | null;
  stdout: string;
  stdoutTruncated?: boolean;
  skippedSteps?: number;
  elapsedMs?: number;
  source?: string;
  analysis?: { findings: Array<{ line: number; message: string }> };
}

/** How the step changed: animate a step or a jump made with the step buttons, not a slider drag. */
type Move = 'step' | 'jump' | 'none';

const ANIM_MS = 260;

export class Visualizer {
  readonly el = h('div', { class: 'visualizer' });
  private trace: TraceResult | undefined;
  private model: TraceModel | undefined;
  private label = '';
  private lineOffset = 0;
  private index = 0;
  private playing: ReturnType<typeof setInterval> | undefined;
  private speedMs = 600;
  private state: StructureState = { modes: new Map() };
  private snapshot: { name: string; root: Encoded; heap: Heap } | undefined;
  private busy = '';
  private liveViz = false;
  private latestExecId = 0;
  /** execId of the trace on screen; step highlights are resolved against it. */
  private traceExecId = 0;
  private animate = !reducedMotion();
  private showCalls = true;
  /** Variables and heap of the trace's last step (stable layouts), built once per trace. */
  private finalState: StructureContext['final'] | undefined;

  constructor() {
    this.render();
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.key === 'ArrowRight') this.go(this.index + 1);
      else if (e.key === 'ArrowLeft' && e.shiftKey) this.go(this.model?.prevOver(this.index) ?? 0, 'jump');
      else if (e.key === 'ArrowLeft') this.go(this.index - 1);
      else if (e.key === 'ArrowDown') this.go(this.model?.nextOver(this.index) ?? 0, 'jump');
      else if (e.key === 'ArrowUp') this.go(this.model?.nextOut(this.index) ?? 0, 'jump');
      else if (e.key === 'Home') this.go(0, 'none');
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

  setTrace(execId: number, result: TraceResult, label: string, mode: string, lineOffset: number): void {
    if (execId < this.latestExecId) return; // an older trace finished after a newer one started
    this.traceExecId = execId;
    this.busy = '';
    this.snapshot = undefined;
    const keep = mode === 'live' && this.trace !== undefined;
    this.trace = result;
    this.model = new TraceModel(result.steps ?? [], !!result.heapDelta);
    this.finalState = undefined;
    this.label = label;
    this.lineOffset = lineOffset;
    this.stop();
    // Live edits keep the current step so the picture updates in place.
    this.index = keep ? Math.min(this.index, Math.max(0, (result.steps ?? []).length - 1)) : 0;
    this.render(undefined, keep ? 'step' : 'none');
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
    const clamped = Math.max(0, Math.min(this.trace.steps.length - 1, i));
    if (clamped === this.index) {
      if (this.playing && clamped === this.trace.steps.length - 1) this.stop();
      return;
    }
    const how: Move = move ?? (Math.abs(clamped - this.index) === 1 ? 'step' : 'none');
    this.index = clamped;
    this.render(undefined, how);
    this.notifyLine();
  }

  private notifyLine(): void {
    const step = this.trace?.steps[this.index];
    if (step) send({ type: 'traceStep', execId: this.traceExecId, line: step.line });
  }

  private togglePlay(): void {
    if (this.playing) this.stop();
    else if (this.trace && this.trace.steps.length) {
      if (this.index >= this.trace.steps.length - 1) this.index = 0;
      this.playing = setInterval(() => this.go(this.index + 1, 'step'), this.speedMs);
      this.render();
    }
  }

  private stop(): void {
    if (this.playing) clearInterval(this.playing);
    this.playing = undefined;
  }

  private statusEl = h('div', { class: 'viz-status', role: 'status' });

  private renderStatus(): void {
    clear(this.statusEl);
    if (this.busy) this.statusEl.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), this.busy);
  }

  private animMs(move: Move): number {
    if (!this.animate || move === 'none' || reducedMotion()) return 0;
    // While playing, finish before the next step arrives.
    return this.playing ? Math.min(ANIM_MS, Math.round(this.speedMs * 0.7)) : ANIM_MS;
  }

  private render(message?: string, move: Move = 'none'): void {
    const ms = this.animMs(move);
    const before = ms > 0 ? snapshot(this.el) : undefined;
    const scrollTop = this.el.scrollTop;
    this.build(message);
    this.el.classList.toggle('no-anim', !this.animate);
    if (before) animateFrom(before, this.el, ms);
    this.el.scrollTop = scrollTop;
  }

  private build(message?: string): void {
    clear(this.el);
    this.renderStatus();
    const intro = h(
      'div',
      { class: 'viz-intro' },
      button('▶ Visualize current file / cell', () => send({ type: 'command', command: 'visualize' }), { cls: 'btn primary', title: 'vrun: Visualize Algorithm (Ctrl+Alt+V)' }),
      button(this.liveViz ? '● Live visualize: ON' : '○ Live visualize: OFF', () => send({ type: 'command', command: 'toggleLiveVisualize' }), {
        cls: `btn ${this.liveViz ? 'on' : ''}`,
        pressed: this.liveViz,
        title: 'Re-trace automatically while you type',
      }),
      this.statusEl,
    );
    this.el.appendChild(intro);
    if (message) this.el.appendChild(h('p', { class: 'error-text' }, message));

    if (this.snapshot) {
      const vars: Var[] = [{ name: this.snapshot.name, value: this.snapshot.root, depth: 0 }];
      this.el.appendChild(h('h3', {}, `Variable ${this.snapshot.name} (kernel snapshot)`));
      this.el.appendChild(renderStructures(vars, this.snapshot.heap, undefined, this.state, () => this.render()));
      return;
    }
    const t = this.trace;
    const model = this.model;
    if (!t || !model) {
      this.el.appendChild(
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
      this.el.appendChild(h('p', { class: 'warn-text' }, `Live visualize skipped: ${f ? `line ${f.line + this.lineOffset}: ${f.message}` : 'unsafe code'}. Run "Visualize" manually if you really want this.`));
      return;
    }
    const n = t.steps.length;
    const step = t.steps[this.index];
    this.el.appendChild(this.renderPlayer(n));
    this.el.appendChild(h('div', { class: 'run-meta' }, this.label, h('span', { class: 'meta-note' }, `${t.elapsedMs ?? 0} ms`)));
    if (t.stopped) {
      const hint = /step limit/.test(t.stopped) ? ' Raise "vrun.trace.maxSteps" in Settings, or trace a smaller input.' : '';
      this.el.appendChild(h('p', { class: 'warn-text' }, `Trace stopped early: ${t.stopped}. Steps before that are shown.${hint}`));
    }
    if (t.skippedSteps) this.el.appendChild(h('p', { class: 'muted small' }, `${t.skippedSteps} step(s) close to the recursion limit could not be drawn.`));
    if (t.error) this.el.appendChild(h('pre', { class: 'error-text' }, `${t.error.ename}: ${t.error.evalue}${t.error.userFrame ? ` (line ${t.error.userFrame.line + this.lineOffset})` : ''}`));
    // input() without a .in file: offer to create it right where the error is.
    if (t.error?.ename === 'EOFError' && t.error.evalue.includes('.in')) {
      this.el.appendChild(button('Create the .in input file', () => send({ type: 'command', command: 'editInput' }), { cls: 'link-btn' }));
    }
    if (!step) return;

    const heap = model.heapAt(this.index);
    const prevHeap = this.index > 0 ? model.heapAt(this.index - 1) : undefined;
    const prev = this.index > 0 ? t.steps[this.index - 1] : undefined;
    const vars = varsOf(step);
    const layout = h('div', { class: 'viz-layout' });
    layout.appendChild(this.renderCode(t.source ?? '', step, prev, vars, heap));
    const right = h('div', { class: 'viz-right' });
    if (this.showCalls && model.isRecursive()) {
      const tree = renderCallTree(model, this.index, (k) => model.heapAt(k), (k) => this.go(k, 'jump'));
      if (tree) {
        const calls = [...model.calls().values()].filter((c) => c.startStep <= this.index).length;
        right.appendChild(
          h('section', { class: 'viz-card', 'data-anim-scope': '§calls' },
            h('header', {}, h('span', { class: 'viz-title' }, 'Recursion tree'), h('span', { class: 'muted' }, `${calls} call${calls === 1 ? '' : 's'} so far · click a call to jump to it`)),
            h('div', { class: 'viz-body' }, tree)),
        );
      }
    }
    const ctx: StructureContext = { source: t.source ?? '', frames: step.stack, final: this.final() };
    right.appendChild(renderStructures(vars, heap, prevHeap, this.state, () => this.render(), ctx));
    right.appendChild(this.renderFrames(step, prev, heap));
    const out = t.stdout.slice(0, step.out);
    right.appendChild(h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, 'Output so far')), h('pre', { class: 'console small' }, out || ' ')));
    layout.appendChild(right);
    this.el.appendChild(layout);
  }

  private final(): StructureContext['final'] {
    if (!this.finalState && this.model && this.model.length) {
      const k = this.model.length - 1;
      this.finalState = { vars: varsOf(this.model.steps[k]), heap: this.model.heapAt(k) };
    }
    return this.finalState;
  }

  private renderPlayer(n: number): HTMLElement {
    const model = this.model!;
    const slider = h('input', { type: 'range', min: 0, max: Math.max(0, n - 1), value: this.index, 'aria-label': 'step', class: 'step-slider' }) as HTMLInputElement;
    slider.addEventListener('input', () => this.go(Number(slider.value), 'none'));
    const speed = h('select', { 'aria-label': 'speed' }) as HTMLSelectElement;
    for (const [label, ms] of [['0.5×', 1200], ['1×', 600], ['2×', 300], ['4×', 150], ['8×', 75]] as const) {
      const o = h('option', { value: ms }, label);
      if (ms === this.speedMs) o.selected = true;
      speed.appendChild(o);
    }
    speed.addEventListener('change', () => {
      this.speedMs = Number(speed.value);
      if (this.playing) {
        this.stop();
        this.togglePlay();
      }
    });
    const inCall = model.depth(this.index) > 1;
    return h(
      'div',
      { class: 'player' },
      button('⏮', () => this.go(0, 'none'), { title: 'First step (Home)' }),
      button('◀', () => this.go(this.index - 1), { title: 'Previous step (←)' }),
      button(this.playing ? '⏸' : '▶', () => this.togglePlay(), { title: 'Play / pause (Space)', cls: 'btn primary' }),
      button('▶|', () => this.go(this.index + 1), { title: 'Next step (→)' }),
      button('⤼', () => this.go(model.nextOver(this.index), 'jump'), { title: 'Step over: next line in this function, without entering calls (↓; Shift+← goes back)' }),
      button('⤴', () => this.go(model.nextOut(this.index), 'jump'), { title: 'Step out: run until this function returns (↑)', disabled: !inCall }),
      button('⏭', () => this.go(n - 1, 'none'), { title: 'Last step (End)' }),
      slider,
      h('span', { class: 'step-label' }, n ? `Step ${this.index + 1} / ${n}` : 'No steps'),
      speed,
      button(this.animate ? '✦ Animate' : '✧ Animate', () => {
        this.animate = !this.animate;
        this.render();
      }, { cls: `btn small ${this.animate ? 'on' : ''}`, pressed: this.animate, title: 'Animate changes between steps (swaps slide, pointers move)' }),
      model.isRecursive()
        ? button('Calls', () => {
            this.showCalls = !this.showCalls;
            this.render();
          }, { cls: `btn small ${this.showCalls ? 'on' : ''}`, pressed: this.showCalls, title: 'Show the recursion tree' })
        : null,
    );
  }

  private renderCode(source: string, step: TraceStep, prev: TraceStep | undefined, vars: Var[], heap: Heap): HTMLElement {
    const lines = source.split(/\r?\n/);
    const hits = this.model?.hitCounts(this.index) ?? new Map<number, number>();
    const pre = h('ol', { class: 'code', start: 1 + this.lineOffset, 'aria-label': 'source code' });
    lines.forEach((text, i) => {
      const ln = i + 1;
      const cls = ln === step.line ? (step.event === 'exception' ? 'cur exc' : step.event === 'return' ? 'cur ret' : 'cur') : prev && ln === prev.line ? 'prev' : '';
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
    const evt = step.event === 'return' ? `return ${fmtScalar(step.ret, heap)}` : step.event === 'exception' ? `exception ${step.exc ?? ''}` : 'about to run';
    const header = h('div', { class: 'muted' }, `Line ${step.line + this.lineOffset}: ${evt}`);
    const watches = step.event === 'line' ? watchesFor(lines[step.line - 1] ?? '', new Map(vars.map((v) => [v.name, v.value])), heap) : [];
    const watchEl = watches.length
      ? h('div', { class: 'line-watch', 'aria-label': 'values on this line' }, ...watches.map((w) => h('span', { class: 'watch' }, h('code', {}, w.text), ' = ', h('b', {}, fmtScalar(w.value, heap)))))
      : null;
    const wrap = h('div', { class: 'viz-code' }, header, watchEl, pre);
    queueMicrotask(() => pre.querySelector('li.cur')?.scrollIntoView({ block: 'nearest' }));
    return wrap;
  }

  private renderFrames(step: TraceStep, prev: TraceStep | undefined, heap: Heap): HTMLElement {
    const sec = h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, 'Call stack'), h('span', { class: 'muted' }, `${step.stack.length} frame(s)`)));
    const body = h('div', { class: 'frames' });
    // A local changed since the previous step when the same call had a different value.
    const before = new Map<string, string>();
    for (const f of prev?.stack ?? []) for (const [name, val] of f.locals) before.set(`${f.fid ?? f.func}\u0000${name}`, JSON.stringify(val));
    [...step.stack].reverse().forEach((f, i) => {
      const table = h('table', { class: 'kv' });
      for (const [name, val] of f.locals) {
        // Class and function definitions are not state: keep the stack about data.
        if (typeof val === 'object' && val !== null && '$t' in val && (val.$t === 'cls' || val.$t === 'fn')) continue;
        const old = before.get(`${f.fid ?? f.func}\u0000${name}`);
        const changed = prev !== undefined && old !== JSON.stringify(val) && (old !== undefined || prev.stack.some((p) => p.fid === f.fid));
        table.appendChild(h('tr', { class: changed ? 'changed' : '' }, h('th', {}, name), h('td', {}, fmtScalar(val, heap))));
      }
      body.appendChild(h('div', { class: `frame ${i === 0 ? 'top' : ''}` }, h('div', { class: 'frame-name' }, `${f.func}  (line ${f.line + this.lineOffset})`), table));
    });
    sec.appendChild(body);
    return sec;
  }
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
