import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Cell, cellAt, dedent, hasCellMarkers, splitCells } from './exec/cells';
import { LiveScheduler } from './exec/liveScheduler';
import { KernelClient } from './kernel/kernelClient';
import {
  ExecuteResult,
  KernelRequestError,
  KernelStatus,
  RequestType,
  TraceResult,
  VariablesList,
} from './kernel/protocol';
import { resolvePython } from './kernel/pythonResolver';
import { EditorDecorations } from './ui/editorDecorations';
import { InspectorPanel, PanelTab } from './ui/panel';
import { WebviewMessage } from './ui/validate';

type Mode = 'manual' | 'live';

interface TraceContext {
  uri: vscode.Uri;
  lineOffset: number;
}

const cfg = () => vscode.workspace.getConfiguration('pylive');

/**
 * Exactly the selected text (selecting `a()` in `a(); b()` must not run b),
 * except that a start inside the leading indentation snaps to column 0 so
 * multi-line selections keep consistent indentation for dedent().
 */
function selectionRange(doc: vscode.TextDocument, sel: vscode.Selection): vscode.Range {
  const first = doc.lineAt(sel.start.line);
  const startChar = sel.start.character <= first.firstNonWhitespaceCharacterIndex ? 0 : sel.start.character;
  return new vscode.Range(sel.start.line, startChar, sel.end.line, sel.end.character);
}

export class PyLiveController implements vscode.Disposable {
  readonly kernel = new KernelClient();
  private readonly output = vscode.window.createOutputChannel('PyLive Inspector');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly decorations = new EditorDecorations();
  private readonly panel: InspectorPanel;
  private readonly scheduler = new LiveScheduler(() => cfg().get<number>('live.debounceMs', 800));
  private readonly liveDocs = new Set<string>();
  private readonly liveVizDocs = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private execCounter = 0;
  private starting: Promise<void> | undefined;
  private lastVariables: VariablesList | undefined;
  private varsRefreshing = false;
  private varsDirty = false;
  private traceContext: TraceContext | undefined;
  private manualRunning = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = new InspectorPanel(
      context.extensionUri,
      (m) => void this.onWebviewMessage(m),
      (t) => this.output.append(t),
    );
    this.kernel.onLog.on((t) => this.output.append(t));
    this.kernel.onStatus.on((s) => this.onKernelStatus(s));
    this.kernel.onStream.on((e) => this.panel.post({ type: 'stream', name: e.name, text: e.text, execId: e.execId }));
    this.kernel.onSession.on((ready) => {
      this.lastVariables = undefined;
      this.panel.post({ type: 'session', session: ready.session, python: ready.python, cwd: ready.cwd, pid: ready.pid });
    });
    this.kernel.onInterruptStuck.on(() => void this.offerRestartAfterStuckInterrupt());
    this.status.command = 'pylive.openVariables';
    this.onKernelStatus('stopped');
    this.status.show();

    this.disposables.push(
      this.output,
      this.status,
      this.decorations,
      this.panel,
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((ed) => this.decorations.refreshEditor(ed))),
      // The Live buttons show the state of the *active* document.
      vscode.window.onDidChangeActiveTextEditor(() => this.postLiveState()),
      vscode.workspace.onDidCloseTextDocument((d) => this.disableLive(d.uri.toString())),
    );
  }

  // ---------------------------------------------------------------- kernel

  private onKernelStatus(s: KernelStatus): void {
    const icons: Record<KernelStatus, string> = {
      stopped: '$(circle-outline)',
      starting: '$(loading~spin)',
      idle: '$(pass-filled)',
      busy: '$(loading~spin)',
      interrupting: '$(debug-pause)',
      restarting: '$(sync~spin)',
      crashed: '$(error)',
    };
    this.status.text = `${icons[s]} PyLive: ${s}`;
    this.status.tooltip = this.kernel.info
      ? `Python ${this.kernel.info.python.version} (pid ${this.kernel.info.pid})\nClick to open the inspector`
      : 'PyLive Inspector kernel';
    this.status.backgroundColor = s === 'crashed' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    void vscode.commands.executeCommand('setContext', 'pylive.kernelStatus', s);
    this.panel.post({ type: 'status', status: s, workload: this.kernel.workload });
    if (s === 'crashed') {
      this.panel.post({ type: 'session', session: null });
      void vscode.window
        .showErrorMessage('PyLive kernel stopped unexpectedly. All variables were lost.', 'Restart Kernel', 'Show Log')
        .then((pick) => {
          if (pick === 'Restart Kernel') void this.restartKernel();
          if (pick === 'Show Log') this.output.show();
        });
    }
  }

  private async launchOptions() {
    const doc = vscode.window.activeTextEditor?.document;
    const resource = doc?.uri;
    const pythonPath = await resolvePython(resource, (t) => this.output.append(t));
    let cwd = os.homedir();
    if (doc && doc.uri.scheme === 'file') cwd = path.dirname(doc.uri.fsPath);
    else if (vscode.workspace.workspaceFolders?.length) cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
    this.output.appendLine(`[pylive] starting kernel: ${pythonPath} (cwd ${cwd})`);
    return {
      pythonPath,
      launcherPath: this.context.asAbsolutePath(path.join('python', 'launcher.py')),
      cwd,
    };
  }

  async ensureKernel(): Promise<void> {
    if (this.kernel.isRunning && this.kernel.session) return;
    if (!this.starting) {
      this.starting = (async () => {
        try {
          const ready = await this.kernel.start(await this.launchOptions());
          this.output.appendLine(`[pylive] kernel ready: Python ${ready.python.version} pid ${ready.pid}`);
        } finally {
          this.starting = undefined;
        }
      })();
    }
    try {
      await this.starting;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window
        .showErrorMessage(`PyLive: could not start the Python kernel. ${msg}`, 'Show Log', 'Choose Interpreter')
        .then((pick) => {
          if (pick === 'Show Log') this.output.show();
          if (pick === 'Choose Interpreter') void vscode.commands.executeCommand('python.setInterpreter');
        });
      throw err;
    }
  }

  async startKernel(): Promise<void> {
    this.panel.reveal();
    await this.ensureKernel().catch(() => undefined);
  }

  async restartKernel(): Promise<void> {
    this.scheduler.cancelAll();
    this.panel.post({ type: 'session', session: null, restarting: true });
    try {
      const ready = await this.kernel.restart(await this.launchOptions());
      this.output.appendLine(`[pylive] kernel restarted: pid ${ready.pid}`);
      void vscode.window.setStatusBarMessage('PyLive: kernel restarted — all previous variables are gone', 4000);
      await this.refreshVariables();
    } catch (err) {
      void vscode.window.showErrorMessage(`PyLive: restart failed. ${err instanceof Error ? err.message : err}`);
    }
  }

  async stopKernel(): Promise<void> {
    this.scheduler.cancelAll();
    await this.kernel.stop();
    this.panel.post({ type: 'session', session: null });
  }

  async interrupt(): Promise<void> {
    if (!this.kernel.isRunning || this.kernel.workload === 0) {
      void vscode.window.setStatusBarMessage('PyLive: nothing is running', 2000);
      return;
    }
    await this.kernel.interrupt(undefined, cfg().get<number>('interrupt.graceMs', 3000));
  }

  private async offerRestartAfterStuckInterrupt(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      'PyLive: the kernel did not respond to the interrupt (it is probably inside native code, or the code catches KeyboardInterrupt). ' +
        'Restarting kills the process and ALL variables are lost.',
      'Restart Kernel',
      'Keep Waiting',
    );
    if (pick === 'Restart Kernel') await this.restartKernel();
  }

  // ------------------------------------------------------------- execution

  private fileLabel(doc: vscode.TextDocument): string {
    return doc.uri.scheme === 'file' ? doc.uri.fsPath : `<${path.basename(doc.uri.path) || 'untitled'}>`;
  }

  async runSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const sel = editor.selection;
    let text: string;
    let startLine: number;
    if (sel.isEmpty) {
      startLine = sel.active.line;
      text = doc.lineAt(startLine).text;
    } else {
      startLine = sel.start.line;
      text = doc.getText(selectionRange(doc, sel));
    }
    await this.runCode(doc, dedent(text), startLine, 'manual', `selection (line ${startLine + 1})`, startLine + text.split('\n').length - 1);
  }

  async runCell(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const cell = cellAt(doc.getText(), editor.selection.active.line);
    if (!cell) return;
    const label = hasCellMarkers(doc.getText()) ? `cell at line ${cell.startLine + 1}` : 'file (no # %% cells)';
    await this.runCode(doc, cell.text, cell.startLine, 'manual', label, cell.endLine);
  }

  async runFile(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    await this.runCode(doc, doc.getText(), 0, 'manual', path.basename(doc.fileName), doc.lineCount - 1);
  }

  /** Execute code in the persistent namespace and update every view. */
  private async runCode(
    doc: vscode.TextDocument,
    code: string,
    lineOffset: number,
    mode: Mode,
    label: string,
    resultLine: number,
    liveCheck?: () => boolean,
  ): Promise<ExecuteResult | undefined> {
    if (!code.trim()) return undefined;
    try {
      await this.ensureKernel();
    } catch {
      return undefined;
    }
    if (mode === 'manual') this.panel.reveal(undefined, true);
    const execId = ++this.execCounter;
    this.panel.post({ type: 'execStart', execId, label, mode, file: path.basename(doc.fileName) });
    const params: Record<string, unknown> = {
      code,
      file: this.fileLabel(doc),
      lineOffset,
      mode,
      execId,
    };
    if (mode === 'live') params.timeoutMs = cfg().get<number>('live.timeoutMs', 5000);
    if (mode === 'manual') this.manualRunning++;
    let result: ExecuteResult;
    try {
      result = await this.kernel.request<ExecuteResult>('execute', params);
      if (result.status === 'needs_confirmation') {
        const ok = !cfg().get<boolean>('safeMl.confirmRepeatTraining', true) || (await this.confirmRetrain(result));
        if (!ok) {
          this.panel.post({ type: 'execEnd', execId, result: { ...result, status: 'blocked' }, cancelled: true });
          return result;
        }
        result = await this.kernel.request<ExecuteResult>('execute', { ...params, force: true });
      }
    } catch (err) {
      const e = err instanceof KernelRequestError ? err : new KernelRequestError('error', String(err));
      this.panel.post({ type: 'execEnd', execId, failure: { code: e.code, message: e.message } });
      return undefined;
    } finally {
      if (mode === 'manual') this.manualRunning--;
    }

    const stale = liveCheck !== undefined && !liveCheck();
    if (!stale) {
      this.panel.post({ type: 'execEnd', execId, result });
      this.applyResultToEditor(doc, result, resultLine);
    } else {
      // Still close the block in the UI, or it would say "live…" forever.
      this.panel.post({ type: 'execEnd', execId, superseded: true });
    }
    void this.refreshVariables();
    return result;
  }

  private async confirmRetrain(result: ExecuteResult): Promise<boolean> {
    const what = result.analysis?.findings.find((f) => f.category === 'training' || f.category === 'expensive');
    const pick = await vscode.window.showWarningMessage(
      `This code trains a model and already ran in this kernel session (${what?.message ?? 'training detected'}). Run it again?`,
      { modal: true, detail: 'PyLive asks to avoid accidental repeated training. Disable with "pylive.safeMl.confirmRepeatTraining".' },
      'Run Again',
    );
    return pick === 'Run Again';
  }

  private applyResultToEditor(doc: vscode.TextDocument, result: ExecuteResult, line: number): void {
    if (result.status === 'error' && result.error) {
      this.decorations.showError(doc, result.error);
      this.decorations.setInline(doc, line, `${result.error.ename}: ${result.error.evalue}`);
    } else if (result.status === 'blocked') {
      const f = result.analysis?.findings[0];
      this.decorations.setInline(doc, line, `live run skipped — ${f ? `line ${f.line}: ${f.message}` : 'unsafe code'}`);
    } else {
      this.decorations.clearErrors(doc);
      if (result.value) this.decorations.setInline(doc, line, result.value.repr);
      else this.decorations.setInline(doc, line, `✓ [${result.executionCount}] ${result.elapsedMs ?? 0} ms`);
    }
  }

  // ------------------------------------------------------------ live mode

  toggleLiveMode(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'python') {
      void vscode.window.showInformationMessage('PyLive: open a Python file to use Live Mode.');
      return;
    }
    const key = doc.uri.toString();
    if (this.liveDocs.delete(key)) {
      this.scheduler.cancel(`exec:${key}`);
      void vscode.window.setStatusBarMessage('PyLive: Live Mode OFF', 2500);
    } else {
      this.liveDocs.add(key);
      const hasLive = splitCells(doc.getText()).some((c) => c.live);
      void vscode.window.showInformationMessage(
        hasLive
          ? 'PyLive Live Mode ON: cells marked "# %% [live]" re-run after you stop typing.'
          : 'PyLive Live Mode ON: the cell under the cursor re-runs after you stop typing. Model training, file/network I/O and endless loops are never re-run automatically.',
      );
    }
    this.panel.post({ type: 'liveState', live: this.liveDocs.has(key), liveViz: this.liveVizDocs.has(key) });
  }

  toggleLiveVisualize(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'python') return;
    const key = doc.uri.toString();
    if (this.liveVizDocs.delete(key)) {
      this.scheduler.cancel(`trace:${key}`);
      void vscode.window.setStatusBarMessage('PyLive: Live Visualize OFF', 2500);
    } else {
      this.liveVizDocs.add(key);
      void this.visualize();
      void vscode.window.setStatusBarMessage('PyLive: Live Visualize ON — the visualizer follows your edits', 3500);
    }
    this.panel.post({ type: 'liveState', live: this.liveDocs.has(key), liveViz: this.liveVizDocs.has(key) });
  }

  private postLiveState(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'python') return; // keep the last Python file's state while the panel has focus
    const key = doc.uri.toString();
    this.panel.post({ type: 'liveState', live: this.liveDocs.has(key), liveViz: this.liveVizDocs.has(key) });
  }

  private disableLive(key: string): void {
    this.liveDocs.delete(key);
    this.liveVizDocs.delete(key);
    this.scheduler.cancel(`exec:${key}`);
    this.scheduler.cancel(`trace:${key}`);
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const doc = e.document;
    const key = doc.uri.toString();
    if (this.liveDocs.has(key)) {
      const sk = `exec:${key}`;
      this.scheduler.schedule(sk, (gen) => this.runLive(doc, sk, gen));
    }
    if (this.liveVizDocs.has(key)) {
      const sk = `trace:${key}`;
      this.scheduler.schedule(sk, (gen) => this.traceDocument(doc, 'live', () => this.scheduler.isCurrent(sk, gen)));
    }
  }

  private liveTargets(doc: vscode.TextDocument): Cell[] {
    const cells = splitCells(doc.getText());
    const live = cells.filter((c) => c.live);
    if (live.length) return live.filter((c) => !c.manual);
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
    const line = editor?.selection.active.line ?? 0;
    const cell = cells.find((c) => line >= c.startLine && line <= c.endLine);
    return cell && !cell.manual ? [cell] : [];
  }

  private async runLive(doc: vscode.TextDocument, key: string, gen: number): Promise<void> {
    // Never compete with a manual run: try again after another debounce
    // period instead of dropping the edit.
    if (this.manualRunning > 0) {
      if (this.scheduler.isCurrent(key, gen)) this.scheduler.schedule(key, (g) => this.runLive(doc, key, g));
      return;
    }
    for (const cell of this.liveTargets(doc)) {
      if (!this.scheduler.isCurrent(key, gen)) return;
      const r = await this.runCode(doc, cell.text, cell.startLine, 'live', `live: line ${cell.startLine + 1}`, cell.endLine, () =>
        this.scheduler.isCurrent(key, gen),
      );
      if (!r || r.status !== 'ok') return;
    }
  }

  // ------------------------------------------------------------ visualizer

  async visualize(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    this.panel.reveal('visualizer', true);
    await this.traceDocument(doc, 'manual', undefined);
  }

  private traceScope(doc: vscode.TextDocument): { code: string; lineOffset: number; label: string } {
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
    const sel = editor?.selection;
    if (sel && !sel.isEmpty) {
      return { code: dedent(doc.getText(selectionRange(doc, sel))), lineOffset: sel.start.line, label: `selection (line ${sel.start.line + 1})` };
    }
    const text = doc.getText();
    if (hasCellMarkers(text) && editor) {
      const cell = cellAt(text, editor.selection.active.line);
      if (cell) return { code: cell.text, lineOffset: cell.startLine, label: `cell at line ${cell.startLine + 1}` };
    }
    return { code: text, lineOffset: 0, label: path.basename(doc.fileName) };
  }

  private async traceDocument(doc: vscode.TextDocument, mode: Mode, isCurrent: (() => boolean) | undefined): Promise<void> {
    const scope = this.traceScope(doc);
    if (!scope.code.trim()) return;
    try {
      await this.ensureKernel();
    } catch {
      return;
    }
    const execId = ++this.execCounter;
    this.panel.post({ type: 'traceStart', execId, label: scope.label, mode });
    try {
      const result = await this.kernel.request<TraceResult>('trace', {
        code: scope.code,
        mode,
        execId,
        maxSteps: cfg().get<number>('trace.maxSteps', 1000),
        timeoutMs: cfg().get<number>('trace.timeoutMs', 15000),
      });
      if (isCurrent && !isCurrent()) {
        // A newer edit superseded this trace; let the UI drop its "Tracing…" state.
        this.panel.post({ type: 'traceSuperseded', execId });
        return;
      }
      this.traceContext = { uri: doc.uri, lineOffset: scope.lineOffset };
      this.panel.post({ type: 'trace', execId, label: scope.label, mode, lineOffset: scope.lineOffset, result });
      if (result.error?.userFrame && result.error.userFrame.line > 0) {
        this.decorations.highlightTraceLine(doc.uri, result.error.userFrame.line - 1 + scope.lineOffset);
      }
    } catch (err) {
      const e = err instanceof KernelRequestError ? err : new KernelRequestError('error', String(err));
      this.panel.post({ type: 'traceFailed', execId, code: e.code, message: e.message });
    }
  }

  // ------------------------------------------------------------- variables

  async refreshVariables(): Promise<void> {
    if (!this.kernel.isRunning || !this.kernel.session) return;
    if (this.varsRefreshing) {
      this.varsDirty = true;
      return;
    }
    this.varsRefreshing = true;
    try {
      do {
        this.varsDirty = false;
        try {
          const list = await this.kernel.request<VariablesList>('variables.list');
          this.lastVariables = list;
          this.panel.post({ type: 'variables', list });
        } catch (err) {
          if (err instanceof KernelRequestError && err.code !== 'kernel_exited') {
            this.panel.post({ type: 'variablesError', message: err.message });
          }
        }
      } while (this.varsDirty);
    } finally {
      this.varsRefreshing = false;
    }
  }

  openVariables(): void {
    this.panel.reveal('variables', false);
    void this.refreshVariables();
  }

  async openDataFrame(name?: string): Promise<void> {
    if (!name) {
      if (!this.kernel.isRunning) {
        void vscode.window.showInformationMessage('PyLive: start the kernel and create a DataFrame first.');
        return;
      }
      await this.refreshVariables();
      const frames = (this.lastVariables?.variables ?? []).filter((v) => v.kind === 'dataframe' || v.kind === 'series');
      if (frames.length === 0) {
        void vscode.window.showInformationMessage('PyLive: no pandas DataFrame or Series variables in the kernel.');
        return;
      }
      const pick =
        frames.length === 1
          ? { label: frames[0].name }
          : await vscode.window.showQuickPick(
              frames.map((f) => ({ label: f.name, description: `${f.kind} ${f.shape?.join(' × ') ?? ''}` })),
              { placeHolder: 'DataFrame to open' },
            );
      if (!pick) return;
      name = pick.label;
    }
    this.panel.reveal('dataframe', false);
    this.panel.post({ type: 'openDataFrame', name });
  }

  // ------------------------------------------------------- webview requests

  private async onWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.panel.post({ type: 'status', status: this.kernel.status, workload: this.kernel.workload });
        if (this.kernel.info) {
          const i = this.kernel.info;
          this.panel.post({ type: 'session', session: i.session, python: i.python, cwd: i.cwd, pid: i.pid });
        }
        if (this.lastVariables) this.panel.post({ type: 'variables', list: this.lastVariables });
        this.postLiveState();
        return;
      case 'command':
        await vscode.commands.executeCommand(`pylive.${msg.command === 'start' ? 'startKernel' : msg.command === 'restart' ? 'restartKernel' : msg.command === 'stop' ? 'stopKernel' : msg.command}`);
        return;
      case 'refreshVariables':
        await this.refreshVariables();
        return;
      case 'openDataFrame':
        await this.openDataFrame(msg.name);
        return;
      case 'inspectVariable':
        return this.forward(msg.requestId, 'variables.inspect', { name: msg.name, maxNodes: 200, maxItems: 100 });
      case 'dfMetadata':
        return this.forward(msg.requestId, 'dataframe.metadata', { name: msg.name });
      case 'dfPage':
        return this.forward(msg.requestId, 'dataframe.page', {
          name: msg.name,
          revision: msg.revision,
          offset: msg.offset,
          limit: msg.limit,
          colOffset: msg.colOffset,
          colLimit: msg.colLimit,
          sort: msg.sort ?? null,
          filter: msg.filter ?? null,
          timeoutMs: cfg().get<number>('inspect.timeoutMs', 20000),
        });
      case 'dfSummary':
        return this.forward(msg.requestId, 'dataframe.summary', {
          name: msg.name,
          revision: msg.revision,
          timeoutMs: cfg().get<number>('inspect.timeoutMs', 20000),
        });
      case 'dfColumn':
        return this.forward(msg.requestId, 'dataframe.column', {
          name: msg.name,
          revision: msg.revision,
          column: msg.column,
          timeoutMs: cfg().get<number>('inspect.timeoutMs', 20000),
        });
      case 'traceStep':
        if (this.traceContext) this.decorations.highlightTraceLine(this.traceContext.uri, msg.line - 1 + this.traceContext.lineOffset);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage('PyLive: copied', 1500);
        return;
    }
  }

  /** Forward a validated inspection request; attaches the current session handle. */
  private async forward(requestId: number, type: RequestType, params: Record<string, unknown>): Promise<void> {
    const session = this.kernel.session;
    if (!session) {
      this.panel.post({ type: 'response', requestId, ok: false, error: { code: 'not_running', message: 'Kernel is not running' } });
      return;
    }
    try {
      const result = await this.kernel.request(type, { ...params, session });
      this.panel.post({ type: 'response', requestId, ok: true, result });
    } catch (err) {
      const e = err instanceof KernelRequestError ? err : new KernelRequestError('error', String(err));
      this.panel.post({ type: 'response', requestId, ok: false, error: { code: e.code, message: e.message } });
    }
  }

  showLog(): void {
    this.output.show();
  }

  dispose(): void {
    this.scheduler.cancelAll();
    this.kernel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
