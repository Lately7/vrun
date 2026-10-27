/**
 * Algorithm visualizer: a step player over a trace (Python-Tutor style)
 * plus snapshot views of single kernel variables.
 */
import { send } from './api';
import { button, clear, h } from './dom';
import { Encoded, Heap, fmtScalar } from './format';
import { Var } from './viz/common';
import { StructureState, renderStructures } from './viz/structures';

interface TraceStep {
  line: number;
  event: 'line' | 'return' | 'exception';
  stack: Array<{ func: string; line: number; locals: Array<[string, Encoded]> }>;
  heap: Heap;
  out: number;
  ret?: Encoded;
  exc?: string;
  truncated?: boolean;
}
interface TraceResult {
  status: 'ok' | 'blocked';
  steps: TraceStep[];
  stopped: string | null;
  error: { ename: string; evalue: string; traceback: string; userFrame: { line: number } | null } | null;
  stdout: string;
  stdoutTruncated?: boolean;
  elapsedMs?: number;
  source?: string;
  analysis?: { findings: Array<{ line: number; message: string }> };
}

export class Visualizer {
  readonly el = h('div', { class: 'visualizer' });
  private trace: TraceResult | undefined;
  private label = '';
  private mode = 'manual';
  private lineOffset = 0;
  private index = 0;
  private playing: ReturnType<typeof setInterval> | undefined;
  private speedMs = 600;
  private state: StructureState = { modes: new Map() };
  private snapshot: { name: string; root: Encoded; heap: Heap } | undefined;
  private busy = '';
  private liveViz = false;
  private latestExecId = 0;

  constructor() {
    this.render();
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.key === 'ArrowRight') this.go(this.index + 1);
      else if (e.key === 'ArrowLeft') this.go(this.index - 1);
      else if (e.key === 'Home') this.go(0);
      else if (e.key === 'End') this.go(Number.MAX_SAFE_INTEGER);
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

  started(execId: number, label: string, mode: string): void {
    this.latestExecId = execId;
    this.busy = mode === 'live' ? `Tracing (live): ${label}…` : `Tracing ${label}…`;
    this.renderStatus();
  }

  /** A live trace was superseded by a newer edit: clear its busy state. */
  superseded(execId: number): void {
    if (execId !== this.latestExecId) return; // a newer trace is still running
    this.busy = '';
    this.renderStatus();
  }

  failed(message: string): void {
    this.stop(); // the playback timer would otherwise keep firing
    this.busy = '';
    this.trace = undefined;
    this.snapshot = undefined;
    this.render(message);
  }

  setTrace(result: TraceResult, label: string, mode: string, lineOffset: number): void {
    this.busy = '';
    this.snapshot = undefined;
    const keep = mode === 'live' && this.trace !== undefined;
    this.trace = result;
    this.label = label;
    this.mode = mode;
    this.lineOffset = lineOffset;
    this.stop();
    // Live edits keep the current step so the picture updates in place.
    this.index = keep ? Math.min(this.index, Math.max(0, result.steps.length - 1)) : 0;
    this.render();
    this.notifyLine();
  }

  showSnapshot(name: string, root: Encoded, heap: Heap): void {
    this.stop();
    this.trace = undefined;
    this.snapshot = { name, root, heap };
    this.render();
  }

  private go(i: number): void {
    if (!this.trace || this.trace.steps.length === 0) return;
    const clamped = Math.max(0, Math.min(this.trace.steps.length - 1, i));
    if (clamped === this.index) {
      if (this.playing && clamped === this.trace.steps.length - 1) this.stop();
      return;
    }
    this.index = clamped;
    this.render();
    this.notifyLine();
  }

  private notifyLine(): void {
    const step = this.trace?.steps[this.index];
    if (step) send({ type: 'traceStep', line: step.line });
  }

  private togglePlay(): void {
    if (this.playing) this.stop();
    else if (this.trace && this.trace.steps.length) {
      if (this.index >= this.trace.steps.length - 1) this.index = 0;
      this.playing = setInterval(() => this.go(this.index + 1), this.speedMs);
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

  private render(message?: string): void {
    clear(this.el);
    this.renderStatus();
    const intro = h(
      'div',
      { class: 'viz-intro' },
      button('▶ Visualize current file / cell', () => send({ type: 'command', command: 'visualize' }), { cls: 'btn primary', title: 'PyLive: Visualize Algorithm (Ctrl+Alt+V)' }),
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
    if (!t) {
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
    const prev = this.index > 0 ? t.steps[this.index - 1] : undefined;

    const slider = h('input', { type: 'range', min: 0, max: Math.max(0, n - 1), value: this.index, 'aria-label': 'step', class: 'step-slider' }) as HTMLInputElement;
    slider.addEventListener('input', () => this.go(Number(slider.value)));
    const speed = h('select', { 'aria-label': 'speed' }) as HTMLSelectElement;
    for (const [label, ms] of [['0.5×', 1200], ['1×', 600], ['2×', 300], ['4×', 120]] as const) {
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
    this.el.appendChild(
      h(
        'div',
        { class: 'player' },
        button('⏮', () => this.go(0), { title: 'First step (Home)' }),
        button('◀', () => this.go(this.index - 1), { title: 'Previous step (←)' }),
        button(this.playing ? '⏸' : '▶', () => this.togglePlay(), { title: 'Play / pause (Space)', cls: 'btn primary' }),
        button('▶|', () => this.go(this.index + 1), { title: 'Next step (→)' }),
        button('⏭', () => this.go(n - 1), { title: 'Last step (End)' }),
        slider,
        h('span', { class: 'step-label' }, n ? `Step ${this.index + 1} / ${n}` : 'No steps'),
        speed,
      ),
    );
    const meta: string[] = [`${this.label}`, `${t.elapsedMs ?? 0} ms`];
    if (this.mode === 'live') meta.push('live');
    this.el.appendChild(h('div', { class: 'muted' }, meta.join(' · ')));
    if (t.stopped) this.el.appendChild(h('p', { class: 'warn-text' }, `Trace stopped early: ${t.stopped}. Steps before that are shown.`));
    if (t.error) this.el.appendChild(h('pre', { class: 'error-text' }, `${t.error.ename}: ${t.error.evalue}${t.error.userFrame ? ` (line ${t.error.userFrame.line + this.lineOffset})` : ''}`));
    if (!step) return;

    const layout = h('div', { class: 'viz-layout' });
    layout.appendChild(this.renderCode(t.source ?? '', step, prev));
    const right = h('div', { class: 'viz-right' });
    const vars = varsOf(step);
    right.appendChild(renderStructures(vars, step.heap, prev?.heap, this.state, () => this.render()));
    right.appendChild(this.renderFrames(step));
    const out = t.stdout.slice(0, step.out);
    right.appendChild(h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, 'Output so far')), h('pre', { class: 'console small' }, out || ' ')));
    layout.appendChild(right);
    this.el.appendChild(layout);
  }

  private renderCode(source: string, step: TraceStep, prev: TraceStep | undefined): HTMLElement {
    const lines = source.split(/\r?\n/);
    const pre = h('ol', { class: 'code', start: 1 + this.lineOffset, 'aria-label': 'source code' });
    lines.forEach((text, i) => {
      const ln = i + 1;
      const cls = ln === step.line ? (step.event === 'exception' ? 'cur exc' : step.event === 'return' ? 'cur ret' : 'cur') : prev && ln === prev.line ? 'prev' : '';
      pre.appendChild(h('li', { class: cls }, text || ' '));
    });
    const evt = step.event === 'return' ? `return ${fmtScalar(step.ret, step.heap)}` : step.event === 'exception' ? `exception ${step.exc ?? ''}` : 'about to run';
    const wrap = h('div', { class: 'viz-code' }, h('div', { class: 'muted' }, `Line ${step.line + this.lineOffset}: ${evt}`), pre);
    queueMicrotask(() => pre.querySelector('li.cur')?.scrollIntoView({ block: 'nearest' }));
    return wrap;
  }

  private renderFrames(step: TraceStep): HTMLElement {
    const sec = h('section', { class: 'viz-card' }, h('header', {}, h('span', { class: 'viz-title' }, 'Call stack'), h('span', { class: 'muted' }, `${step.stack.length} frame(s)`)));
    const body = h('div', { class: 'frames' });
    [...step.stack].reverse().forEach((f, i) => {
      const table = h('table', { class: 'kv' });
      for (const [name, val] of f.locals) table.appendChild(h('tr', {}, h('th', {}, name), h('td', {}, fmtScalar(val, step.heap))));
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
