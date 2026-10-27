/** Execution output: per-run blocks with streams, results, figures and tracebacks. */
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
}

interface Block {
  el: HTMLElement;
  stdout: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  docKey: string;
  done: boolean;
}

const MAX_BLOCKS = 60;
const MAX_STDOUT_CHARS = 400_000;
const BACKGROUND_ID = -1;

export class OutputView {
  readonly el = h('div', { class: 'output' });
  private list = h('div', { class: 'runs', 'aria-live': 'polite' });
  private blocks = new Map<number, Block>();
  private errorCount = 0;
  onError: (count: number) => void = () => undefined;

  constructor(private openDataFrame: (name: string) => void) {
    this.el.append(
      h('div', { class: 'toolbar' }, button('Clear', () => this.clear(), { title: 'Clear output' })),
      this.list,
    );
  }

  clear(): void {
    clear(this.list);
    this.blocks.clear();
    this.errorCount = 0;
    this.onError(0);
  }

  start(execId: number, label: string, mode: string, file = '', docKey = file): void {
    const status = h('span', { class: 'run-status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), mode === 'live' ? 'live…' : 'running…');
    const stdout = h('pre', { class: 'console' });
    const body = h('div', {});
    const el = h('div', { class: `run ${mode}` }, h('div', { class: 'run-head' }, h('span', { class: 'run-label' }, file ? `${file} · ${label}` : label), status), stdout, body);
    this.list.prepend(el);
    this.blocks.set(execId, { el, stdout, status, body, docKey, done: false });
    while (this.list.childElementCount > MAX_BLOCKS) {
      const oldest = this.list.lastElementChild;
      oldest?.remove();
      // Drop the map entry too, or evicted blocks (and their output) leak.
      for (const [id, b] of this.blocks) if (b.el === oldest) this.blocks.delete(id);
    }
    // Old live runs are noise: keep only the latest finished live block of
    // the same file (other files' blocks and runs still in flight stay).
    if (mode === 'live') {
      for (const [id, b] of this.blocks) if (id !== execId && b.done && b.docKey === docKey && b.el.classList.contains('live') && !b.el.classList.contains('error')) {
        b.el.remove();
        this.blocks.delete(id);
      }
    }
  }

  stream(execId: number | null | undefined, name: string, text: string): void {
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
  }

  private backgroundBlock(): Block {
    let b = this.blocks.get(BACKGROUND_ID);
    if (!b) {
      this.start(BACKGROUND_ID, 'Background output (threads started by earlier runs)', 'background');
      b = this.blocks.get(BACKGROUND_ID)!;
      clear(b.status);
      b.status.append(h('span', { class: 'muted' }, 'not tied to a single run'));
    }
    return b;
  }

  end(execId: number, result: ExecResult | undefined, failure?: { code: string; message: string }, cancelled = false, superseded = false): void {
    const b = this.blocks.get(execId);
    if (!b) return;
    b.done = true;
    if (superseded) {
      // A newer live run replaced this one; its result is intentionally dropped.
      b.el.remove();
      this.blocks.delete(execId);
      return;
    }
    clear(b.status);
    if (failure) {
      b.status.append(h('span', { class: 'badge err' }, failure.code));
      b.body.appendChild(h('pre', { class: 'error-text' }, failure.message));
      b.el.classList.add('error');
      return;
    }
    if (!result) return;
    if (cancelled) {
      b.status.append(h('span', { class: 'badge' }, 'not run'));
      return;
    }
    if (result.status === 'blocked') {
      b.status.append(h('span', { class: 'badge warn' }, 'skipped'));
      const f = result.analysis?.findings ?? [];
      b.body.appendChild(h('div', { class: 'warn-text' }, 'Not re-run automatically (heuristic safety check):', h('ul', {}, ...f.slice(0, 5).map((x) => h('li', {}, `line ${x.line}: ${x.message}`)))));
      return;
    }
    const time = result.elapsedMs !== undefined ? `${result.elapsedMs} ms` : '';
    b.status.append(h('span', { class: `badge ${result.status === 'ok' ? 'ok' : 'err'}` }, `[${result.executionCount}] ${result.status === 'ok' ? '✓' : result.interrupted ? 'interrupted' : 'error'}`), h('span', { class: 'muted' }, time));
    if (result.value) {
      const v = result.value;
      const valueBox = h('div', { class: 'result' }, h('div', { class: 'muted' }, v.shape ? `${v.shortType} ${v.shape.join(' × ')}` : v.shortType), h('pre', { class: 'console value' }, v.repr));
      // `dataframe` is false for a Series, which the viewer shows too.
      if (v.dataframe !== undefined) valueBox.appendChild(button(`Open result (_) in the ${v.dataframe ? 'DataFrame' : 'Series'} viewer`, () => this.openDataFrame('_')));
      b.body.appendChild(valueBox);
    }
    for (const f of result.figures ?? []) {
      if (f.png) b.body.appendChild(h('img', { class: 'figure', src: `data:image/png;base64,${f.png}`, alt: 'matplotlib figure' }));
      else if (f.error) b.body.appendChild(h('p', { class: 'warn-text' }, f.error));
    }
    if (result.outputTruncated) b.body.appendChild(h('p', { class: 'warn-text' }, 'Output was truncated (2 MB per run).'));
    if (result.error) {
      b.el.classList.add('error');
      this.errorCount++;
      this.onError(this.errorCount);
      b.body.appendChild(h('div', { class: 'traceback' }, h('div', { class: 'error-title' }, `${result.error.ename}: ${result.error.evalue}`), h('pre', {}, result.error.traceback)));
    }
    const ml = result.analysis?.findings.filter((x) => x.category === 'training' || x.category === 'expensive');
    if (ml?.length) b.body.appendChild(h('p', { class: 'muted' }, `ML safety: ${ml[0].message}. This cell is never re-run by Live Mode.`));
  }
}
