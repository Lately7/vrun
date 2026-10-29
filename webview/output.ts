/**
 * Execution output: only the latest run is shown (each run replaces the
 * previous one), as a muted meta line plus its output. Errors get a thin red
 * rule instead of a coloured card. Background-thread output has its own
 * small block.
 */
import { send } from './api';
import { button, clear, h } from './dom';

interface ExecResult {
  status: 'ok' | 'error' | 'blocked' | 'needs_confirmation';
  executionCount: number;
  elapsedMs?: number;
  value?: { type: string; shortType: string; repr: string; shape?: number[]; dataframe?: boolean };
  error?: { ename: string; evalue: string; traceback: string };
  figures?: Array<{ png?: string; error?: string }>;
  analysis?: { findings: Array<{ line: number; category: string; message: string }> };
  interrupted?: string;
  outputTruncated?: boolean;
  skippedLoads?: Array<{ line: number; code: string }>;
  loadedNow?: Array<{ line: number; code: string }>;
}

interface Block {
  el: HTMLElement;
  stdout: HTMLElement;
  meta: HTMLElement;
  body: HTMLElement;
  docKey: string;
  done: boolean;
  ticker?: ReturnType<typeof setInterval>;
}

const MAX_BLOCKS = 60;
const MAX_STDOUT_CHARS = 400_000;
const BACKGROUND_ID = -1;

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1) return '<1 ms';
  return ms < 1000 ? `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export class OutputView {
  readonly el = h('div', { class: 'output' });
  private list = h('div', { class: 'log', 'aria-live': 'polite' });
  private empty = h('p', { class: 'muted empty-hint' }, 'Run a cell (Ctrl+Alt+C) and its output appears here.');
  private blocks = new Map<number, Block>();
  private superseded = new Set<number>();
  private errorCount = 0;
  onError: (count: number) => void = () => undefined;

  constructor(
    private openDataFrame: (name: string) => void,
    private dataframeEnabled: () => boolean,
  ) {
    const clearBtn = button('Clear', () => this.clear(), { cls: 'link-btn', title: 'Clear output' });
    this.el.append(h('div', { class: 'log-tools' }, clearBtn), this.empty, this.list);
  }

  clear(): void {
    for (const b of this.blocks.values()) this.stopTicker(b);
    clear(this.list);
    this.blocks.clear();
    this.errorCount = 0;
    this.onError(0);
    this.empty.hidden = false;
  }

  /** Keep following new output only if the user has not scrolled up to read. */
  private atBottom(): boolean {
    const s = document.scrollingElement ?? document.documentElement;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
  }

  private follow(wasAtBottom: boolean): void {
    if (wasAtBottom) {
      const s = document.scrollingElement ?? document.documentElement;
      s.scrollTop = s.scrollHeight;
    }
  }

  start(execId: number, label: string, mode: string, file = '', docKey = file): void {
    const bottom = this.atBottom();
    this.empty.hidden = true;
    // One result on screen: a new run replaces the previous one (late output
    // of the replaced run is dropped like a superseded live run).
    if (execId !== BACKGROUND_ID) {
      for (const [id, b] of this.blocks) {
        if (id === BACKGROUND_ID) continue;
        this.stopTicker(b);
        b.el.remove();
        this.blocks.delete(id);
        this.forget(id);
      }
      this.errorCount = 0;
      this.onError(0);
    }
    const meta = h('div', { class: 'run-meta' }, h('span', { class: 'dot-busy', 'aria-hidden': 'true' }), [file, label].filter(Boolean).join('  ·  '));
    const stdout = h('pre', { class: 'console' });
    const body = h('div', {});
    const el = h('div', { class: `run ${mode}` }, meta, stdout, body);
    this.list.append(el);
    const block: Block = { el, stdout, meta, body, docKey, done: false };
    this.blocks.set(execId, block);
    if (execId !== BACKGROUND_ID) {
      // Long runs (a first Excel read, a slow cell) show elapsed time so it
      // is clear the code is working, not stuck.
      const started = Date.now();
      const elapsed = h('span', { class: 'meta-note' });
      block.ticker = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        if (s < 2) return;
        if (!elapsed.isConnected) meta.append(elapsed);
        elapsed.textContent = `running ${s} s`;
      }, 1000);
    }
    while (this.list.childElementCount > MAX_BLOCKS) {
      const oldest = this.list.firstElementChild;
      oldest?.remove();
      // Drop the map entry too, or evicted blocks (and their output) leak.
      for (const [id, b] of this.blocks) if (b.el === oldest) this.blocks.delete(id);
    }
    this.follow(bottom);
  }

  stream(execId: number | null | undefined, name: string, text: string): void {
    if (execId !== null && execId !== undefined && this.superseded.has(execId)) return;
    const bottom = this.atBottom();
    // Output the kernel could not attribute (background threads, evicted
    // runs) gets its own block instead of being mixed into the latest run.
    const target = (execId !== null && execId !== undefined ? this.blocks.get(execId) : undefined) ?? this.backgroundBlock();
    const span = h('span', { class: name === 'stderr' ? 'stderr' : '' }, text);
    target.stdout.appendChild(span);
    const size = target.stdout.textContent?.length ?? 0;
    if (size > MAX_STDOUT_CHARS) {
      // Keep the newest text: drop whole old spans, then trim the oldest
      // remaining one character-wise (a single huge span must survive).
      let excess = size - MAX_STDOUT_CHARS;
      while (excess > 0 && target.stdout.firstChild) {
        const first = target.stdout.firstChild as HTMLElement;
        const len = first.textContent?.length ?? 0;
        if (len <= excess && first !== target.stdout.lastChild) {
          first.remove();
          excess -= len;
        } else {
          first.textContent = '[… earlier output trimmed]\n' + (first.textContent ?? '').slice(excess);
          excess = 0;
        }
      }
    }
    this.follow(bottom);
  }

  private stopTicker(b: Block): void {
    if (b.ticker !== undefined) clearInterval(b.ticker);
    b.ticker = undefined;
    b.meta.querySelector('.meta-note')?.remove();
  }

  /** Drop any late output still tagged with a run that is no longer shown. */
  private forget(execId: number): void {
    this.superseded.add(execId);
    if (this.superseded.size > 500) this.superseded.delete(this.superseded.values().next().value!);
  }

  private backgroundBlock(): Block {
    let b = this.blocks.get(BACKGROUND_ID);
    if (!b) {
      this.start(BACKGROUND_ID, 'background threads', 'background');
      b = this.blocks.get(BACKGROUND_ID)!;
      b.meta.querySelector('.dot-busy')?.remove();
    }
    return b;
  }

  end(execId: number, result: ExecResult | undefined, failure?: { code: string; message: string }, cancelled = false, superseded = false): void {
    const b = this.blocks.get(execId);
    if (!b) return;
    b.done = true;
    this.stopTicker(b);
    if (superseded) {
      // A newer live run replaced this one; its result is intentionally
      // dropped, and so is any late output still tagged with its id.
      b.el.remove();
      this.blocks.delete(execId);
      this.forget(execId);
      return;
    }
    const bottom = this.atBottom();
    b.meta.querySelector('.dot-busy')?.remove();
    const note = (text: string) => b.meta.append(h('span', { class: 'meta-note' }, text));
    if (failure) {
      note(failure.code);
      b.body.appendChild(h('pre', { class: 'error-text' }, failure.message));
      b.el.classList.add('error');
      this.follow(bottom);
      return;
    }
    if (!result) return;
    if (cancelled) {
      note('not run');
      return;
    }
    if (result.status === 'blocked') {
      note('skipped by Live Mode');
      const f = result.analysis?.findings[0];
      if (f) b.body.appendChild(h('div', { class: 'muted small' }, `line ${f.line}: ${f.message}`));
      this.follow(bottom);
      return;
    }
    note(formatMs(result.elapsedMs));
    if (result.value) {
      const v = result.value;
      const shape = v.shape ? `${v.shortType} ${v.shape.join(' × ')}` : '';
      b.body.appendChild(h('pre', { class: 'console value' }, v.repr));
      if (shape) {
        const line = h('div', { class: 'muted small' }, shape);
        // `dataframe` is false for a Series, which the viewer shows too.
        if (v.dataframe !== undefined && this.dataframeEnabled()) {
          line.append('  ', button('open', () => this.openDataFrame('_'), { cls: 'link-btn', title: 'Open the result (_) in the DataFrame tab' }));
        }
        b.body.appendChild(line);
      }
    }
    for (const f of result.figures ?? []) {
      if (f.png) b.body.appendChild(h('img', { class: 'figure', src: `data:image/png;base64,${f.png}`, alt: 'matplotlib figure' }));
      else if (f.error) b.body.appendChild(h('p', { class: 'muted small' }, f.error));
    }
    if (result.outputTruncated) b.body.appendChild(h('p', { class: 'muted small' }, 'Output was truncated (2 MB per run).'));
    if (result.interrupted) {
      b.body.appendChild(h('p', { class: 'muted small' }, result.interrupted === 'timeout'
        ? 'Stopped: this live run took longer than the live time budget (pylive.live.timeoutMs). Use Run Cell for slow code.'
        : 'Stopped by you. Variables keep the values they had at that moment.'));
    } else if (result.error) {
      b.el.classList.add('error');
      this.errorCount++;
      this.onError(this.errorCount);
      const details = h('details', { class: 'traceback' }, h('summary', {}, `${result.error.ename}: ${result.error.evalue}`), h('pre', {}, result.error.traceback));
      b.body.appendChild(details);
      // input() without a .in file: offer to create it right here.
      if (result.error.ename === 'EOFError' && result.error.evalue.includes('.in')) {
        b.body.appendChild(button('Create the .in input file', () => send({ type: 'command', command: 'editInput' }), { cls: 'link-btn' }));
      }
    }
    const ml = result.analysis?.findings.filter((x) => x.category === 'training' || x.category === 'expensive');
    if (ml?.length) b.body.appendChild(h('p', { class: 'muted small' }, 'Model training: never re-run by Live Mode.'));
    // "Load once": say quietly which data was reused instead of re-read.
    const reused = result.skippedLoads ?? [];
    if (reused.length) {
      for (const s of reused) {
        b.body.appendChild(h('p', { class: 'muted small reuse' }, `Reused data, not re-read: line ${s.line}  `, h('code', {}, s.code)));
      }
    }
    this.follow(bottom);
  }
}
