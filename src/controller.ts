import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Cell, cellAt, dedent, hasCellMarkers, splitCells } from './exec/cells';
import { LiveScheduler } from './exec/liveScheduler';
import { MAX_PROGRAM_INPUT_CHARS, inputPathFor, isInputOf, samePath } from './exec/programInput';
import { KernelClient } from './kernel/kernelClient';
import {
  ExecuteParams,
  ExecuteResult,
  KernelRequestError,
  KernelStatus,
  RequestType,
  TraceParams,
  TraceResult,
  VariablesList,
} from './kernel/protocol';
import { resolvePython } from './kernel/pythonResolver';
import { cellsAbove, lensLine, nextCellLine, preludeFor } from './ui/cellLensModel';
import { EditorDecorations } from './ui/editorDecorations';
import { InspectorPanel, PanelTab } from './ui/panel';
import { statementAt } from './ui/statements';
import { WEBVIEW_COMMAND_IDS, WebviewMessage } from './ui/validate';

type Mode = 'manual' | 'live';
type Feature = 'visualizer' | 'dataframe';

interface TraceContext {
  uri: vscode.Uri;
  lineOffset: number;
}

/** What a trace covers: the selection or cursor cell, a given cell, or the whole file. */
type TraceWant = { kind: 'auto' } | { kind: 'cell'; line: number } | { kind: 'file' };

interface TraceScope {
  code: string;
  lineOffset: number;
  label: string;
  prelude?: string;
}

/** The document (and cell line) a cell command acts on. */
interface CommandTarget {
  doc: vscode.TextDocument;
  editor: vscode.TextEditor | undefined;
  line: number;
  /** The line came from the command's arguments (a CodeLens), not the cursor. */
  explicitLine: boolean;
}

const cfg = () => vscode.workspace.getConfiguration('vrun');

/**
 * One-line form of a result for the editor. A DataFrame/Series repr squeezed
 * onto one line is unreadable, so tables show their shape (the full table is
 * in the Output tab); other values show their repr.
 */
export function inlineText(value: NonNullable<ExecuteResult['value']>): string {
  if (value.shape && value.dataframe !== undefined) {
    return value.dataframe ? `DataFrame ${value.shape.join(' × ')}` : `Series (${value.shape[0]} values)`;
  }
  return value.repr;
}

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

export class VrunController implements vscode.Disposable {
  readonly kernel = new KernelClient();
  private readonly output = vscode.window.createOutputChannel('vrun');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly decorations = new EditorDecorations();
  private readonly panel: InspectorPanel;
  private readonly scheduler = new LiveScheduler(() => cfg().get<number>('live.debounceMs', 800));
  private readonly liveDocs = new Set<string>();
  private readonly liveVizDocs = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private execCounter = 0;
  /** Interactive figure files per run; the webview only sends (execId, index). */
  private figureFiles = new Map<number, string[]>();
  private starting: Promise<void> | undefined;
  private lastVariables: VariablesList | undefined;
  private varsRefreshing = false;
  private varsDirty = false;
  private readonly traceContexts = new Map<number, TraceContext>();
  private manualRunning = 0;
  private lastPythonEditor: vscode.TextEditor | undefined;
  /** Most recent trace shown in the visualizer (read by integration tests). */
  lastTrace: { uri: vscode.Uri; result: TraceResult } | undefined;
  /** Live runs postponed while a manual run was in flight (scheduler key -> doc). */
  private readonly deferredLive = new Map<string, vscode.TextDocument>();

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
    const active = vscode.window.activeTextEditor;
    if (active?.document.languageId === 'python') this.lastPythonEditor = active;
    this.status.command = 'vrun.openVariables';
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
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed?.document.languageId === 'python') this.lastPythonEditor = ed;
        this.postLiveState();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.disableLive(d.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vrun.features') || e.affectsConfiguration('vrun.dataframe.pageSize')) this.postFeatures();
        if (e.affectsConfiguration('vrun.inlineResults') && cfg().get<string>('inlineResults') === 'off') this.clearInlineResults();
      }),
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
    this.status.text = `${icons[s]} vrun: ${s}`;
    this.status.tooltip = this.kernel.info
      ? `Python ${this.kernel.info.python.version} (pid ${this.kernel.info.pid})\nClick to open the inspector`
      : 'vrun kernel';
    this.status.backgroundColor = s === 'crashed' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    void vscode.commands.executeCommand('setContext', 'vrun.kernelStatus', s);
    this.panel.post({ type: 'status', status: s, workload: this.kernel.workload });
    if (s === 'crashed') {
      this.turnLiveOff();
      this.panel.post({ type: 'session', session: null });
      void vscode.window
        .showErrorMessage('vrun kernel stopped unexpectedly. All variables were lost.', 'Restart Kernel', 'Show Log')
        .then((pick) => {
          if (pick === 'Restart Kernel') void this.restartKernel();
          if (pick === 'Show Log') this.output.show();
        });
    }
  }

  /**
   * The editor a command acts on. Clicking a button in the inspector moves
   * focus to the webview, which leaves `activeTextEditor` undefined, so fall
   * back to the last Python editor the user worked in (if still open).
   */
  private targetEditor(): vscode.TextEditor | undefined {
    // The text tab shown in the active editor group is what the user sees as
    // "the current file". activeTextEditor follows keyboard focus instead and
    // can lag behind (e.g. when the window itself does not have OS focus).
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputText) {
      const uri = tab.input.uri.toString();
      const shown = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === uri);
      if (shown) return shown;
    }
    const active = vscode.window.activeTextEditor;
    if (active) return active;
    const last = this.lastPythonEditor;
    if (!last || last.document.isClosed) return undefined;
    // Prefer the live editor object for that document (its selection is current).
    return vscode.window.visibleTextEditors.find((ed) => ed.document === last.document) ?? last;
  }

  private async launchOptions() {
    const doc = this.targetEditor()?.document;
    const resource = doc?.uri;
    const pythonPath = await resolvePython(resource, (t) => this.output.append(t));
    let cwd = os.homedir();
    if (doc && doc.uri.scheme === 'file') cwd = displayFolder(path.dirname(doc.uri.fsPath));
    else if (vscode.workspace.workspaceFolders?.length) cwd = displayFolder(vscode.workspace.workspaceFolders[0].uri.fsPath);
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
        .showErrorMessage(`vrun: could not start the Python kernel. ${msg}`, 'Show Log', 'Choose Interpreter')
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
    this.cancelLiveWork();
    this.panel.post({ type: 'session', session: null, restarting: true });
    try {
      const ready = await this.kernel.restart(await this.launchOptions());
      this.output.appendLine(`[pylive] kernel restarted: pid ${ready.pid}`);
      void vscode.window.setStatusBarMessage('vrun: kernel restarted — all previous variables are gone', 4000);
      await this.refreshVariables();
    } catch (err) {
      void vscode.window.showErrorMessage(`vrun: restart failed. ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Drop scheduled and deferred live work (stop, restart, dispose). */
  private cancelLiveWork(): void {
    this.scheduler.cancelAll();
    this.deferredLive.clear();
  }

  async stopKernel(): Promise<void> {
    this.turnLiveOff();
    await this.kernel.stop();
    this.panel.post({ type: 'session', session: null });
  }

  /**
   * Live edits never start a kernel, so after Stop or a crash Live would sit
   * "on" doing nothing: switch it off visibly instead (turning it on again
   * starts the kernel).
   */
  private turnLiveOff(): void {
    const wasOn = this.liveDocs.size + this.liveVizDocs.size > 0;
    this.cancelLiveWork();
    this.liveDocs.clear();
    this.liveVizDocs.clear();
    this.panel.post({ type: 'liveState', live: false, liveViz: false });
    if (wasOn) void vscode.window.setStatusBarMessage('vrun: Live turned off (kernel stopped)', 4000);
  }

  async interrupt(): Promise<void> {
    if (!this.kernel.isRunning || this.kernel.workload === 0) {
      void vscode.window.setStatusBarMessage('vrun: nothing is running', 2000);
      return;
    }
    await this.kernel.interrupt(undefined, cfg().get<number>('interrupt.graceMs', 3000));
  }

  private async offerRestartAfterStuckInterrupt(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      'vrun: the kernel did not respond to the interrupt (it is probably inside native code, or the code catches KeyboardInterrupt). ' +
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

  /**
   * Folder of a saved file, sent with every run and trace so that
   * `open("data.csv")` finds the file next to the script even when the
   * kernel was started from another folder. Untitled buffers have none.
   */
  private docFolder(doc: vscode.TextDocument): string | undefined {
    return doc.uri.scheme === 'file' ? displayFolder(path.dirname(doc.uri.fsPath)) : undefined;
  }

  /**
   * What a cell command acts on. A CodeLens passes (uri, line, marker text)
   * of its cell and the editor title / context menus pass the editor's uri;
   * keybindings, the palette and the inspector's buttons pass nothing and
   * use the cursor of the current editor.
   */
  private commandTarget(args: readonly unknown[]): CommandTarget | undefined {
    const [uri, line, marker] = args;
    if (uri instanceof vscode.Uri) {
      const key = uri.toString();
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (!doc || doc.isClosed) return undefined;
      const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
      if (typeof line === 'number' && Number.isInteger(line) && line >= 0 && line < doc.lineCount) {
        const at = typeof marker === 'string' ? lensLine(doc.getText(), line, marker) : line;
        return { doc, editor, line: at, explicitLine: true };
      }
      return { doc, editor, line: editor?.selection.active.line ?? 0, explicitLine: false };
    }
    const editor = this.targetEditor();
    if (!editor) return undefined;
    return { doc: editor.document, editor, line: editor.selection.active.line, explicitLine: false };
  }

  async runSelection(): Promise<void> {
    const editor = this.targetEditor();
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
    await this.runCode(doc, dedent(text), startLine, 'manual', `line ${startLine + 1}`, startLine + text.split('\n').length - 1);
  }

  async runCell(args: readonly unknown[] = []): Promise<void> {
    const t = this.commandTarget(args);
    if (!t) return;
    const cell = cellAt(t.doc.getText(), t.line);
    if (cell) await this.runOneCell(t.doc, cell);
  }

  /**
   * Shift+Enter in Colab and Jupyter: run the cell and go to the next one.
   * The cursor moves before the run finishes, so pressing it again queues
   * the next cell (the kernel runs requests in order).
   * A file without `# %%` lines runs statement by statement instead, like
   * the Python extension's Shift+Enter: as one cell, every press would
   * re-run the whole script, data loading and training included.
   */
  async runCellAndAdvance(args: readonly unknown[] = []): Promise<void> {
    const t = this.commandTarget(args);
    if (!t) return;
    const text = t.doc.getText();
    if (!hasCellMarkers(text)) {
      const st = statementAt(text, t.line);
      if (!st) return;
      this.moveCursor(t.editor, st.nextLine);
      await this.runCode(t.doc, dedent(st.text), st.startLine, 'manual', `line ${st.startLine + 1}`, st.endLine);
      return;
    }
    const cell = cellAt(text, t.line);
    if (!cell) return;
    this.moveCursor(t.editor, nextCellLine(text, t.line));
    await this.runOneCell(t.doc, cell);
  }

  /** Put the cursor at the start of `line` (nothing when there is no next line to go to). */
  private moveCursor(editor: vscode.TextEditor | undefined, line: number | undefined): void {
    if (line === undefined || !editor) return;
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Run every cell above the current one, in order: after Restart Kernel or
   * reopening VS Code this brings back what the current cell needs.
   */
  async runCellsAbove(args: readonly unknown[] = []): Promise<void> {
    const t = this.commandTarget(args);
    if (!t) return;
    // The cells as they are now; edits made while they run do not change the plan.
    const cells = cellsAbove(t.doc.getText(), t.line);
    if (cells.length === 0) {
      void vscode.window.showInformationMessage('vrun: there is no code in cells above this one (cells start with a "# %%" line).');
      return;
    }
    for (const cell of cells) {
      const r = await this.runOneCell(t.doc, cell);
      // Later cells usually need what this one defines: stop at the first
      // cell that did not finish (error, Stop, a declined re-training).
      if (!r || r.status !== 'ok' || r.interrupted) {
        void vscode.window.setStatusBarMessage(`vrun: Run Above stopped at the cell at line ${cell.startLine + 1}`, 6000);
        return;
      }
    }
  }

  private runOneCell(doc: vscode.TextDocument, cell: Cell): Promise<ExecuteResult | undefined> {
    // Shown next to the file name in the Output log, so keep it short.
    const label = hasCellMarkers(doc.getText()) ? `cell · line ${cell.startLine + 1}` : '';
    return this.runCode(doc, cell.text, cell.startLine, 'manual', label, cell.endLine);
  }

  async runFile(): Promise<void> {
    const doc = this.targetEditor()?.document;
    if (!doc) return;
    await this.runCode(doc, doc.getText(), 0, 'manual', '', doc.lineCount - 1);
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
    // Live work never starts a kernel: after Stop it must stay stopped.
    if (mode === 'live' && !this.kernel.isRunning) return undefined;
    try {
      await this.ensureKernel();
    } catch {
      return undefined;
    }
    if (mode === 'manual') this.panel.reveal(undefined, true);
    const execId = ++this.execCounter;
    // `file` is for display; `docKey` identifies the document (two files may share a basename).
    this.panel.post({ type: 'execStart', execId, label, mode, file: path.basename(doc.fileName), docKey: doc.uri.toString() });
    const params: ExecuteParams = {
      code,
      file: this.fileLabel(doc),
      lineOffset,
      mode,
      execId,
    };
    const cwd = this.docFolder(doc);
    if (cwd !== undefined) params.cwd = cwd;
    if (mode === 'live') params.timeoutMs = cfg().get<number>('live.timeoutMs', 5000);
    else params.confirmAfterMs = Math.max(0, cfg().get<number>('safeMl.confirmAfterSeconds', 5)) * 1000;
    const stdin = this.programInput(doc);
    if (stdin !== undefined) params.stdin = stdin;
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
      if (mode === 'manual' && --this.manualRunning === 0) this.releaseDeferredLive();
    }

    const html = (result.figures ?? []).map((f) => f.html ?? '');
    if (html.some(Boolean)) {
      this.figureFiles.set(execId, html);
      while (this.figureFiles.size > 30) this.figureFiles.delete(this.figureFiles.keys().next().value!);
    }
    const stale = liveCheck !== undefined && !liveCheck();
    if (!stale) {
      this.panel.post({ type: 'execEnd', execId, result });
      this.applyResultToEditor(doc, result, lineOffset, resultLine);
    } else {
      // Still close the block in the UI, or it would say "live…" forever.
      this.panel.post({ type: 'execEnd', execId, superseded: true });
    }
    void this.refreshVariables();
    return result;
  }

  private async confirmRetrain(result: ExecuteResult): Promise<boolean> {
    const what = result.analysis?.findings.find((f) => f.category === 'training' || f.category === 'expensive');
    const took = result.lastElapsedMs !== undefined ? ` Last time it took ${formatSeconds(result.lastElapsedMs)}.` : '';
    const pick = await vscode.window.showWarningMessage(
      `This code trains a model and already ran in this kernel session (${what?.message ?? 'training detected'}).${took} Run it again?`,
      {
        modal: true,
        detail:
          'A Keras or PyTorch model that already exists keeps its weights: running fit / the training loop again continues training from them. ' +
          'Re-run the cell that builds the model to start from scratch. ' +
          'Settings: "vrun.safeMl.confirmRepeatTraining", "vrun.safeMl.confirmAfterSeconds".',
      },
      'Run Again',
    );
    return pick === 'Run Again';
  }

  /**
   * Inline results stay quiet: an expression's value or a real error, at the
   * end of the code that ran. Older notes in that range are replaced, and a
   * note disappears as soon as its line is edited (see onDocumentChanged).
   */
  private applyResultToEditor(doc: vscode.TextDocument, result: ExecuteResult, startLine: number, line: number): void {
    const enabled = cfg().get<string>('inlineResults', 'values') !== 'off';
    this.decorations.clearInline(doc, startLine, line);
    // Attach to the last line that has code, not to trailing blank lines.
    while (line > startLine && line < doc.lineCount && doc.lineAt(line).isEmptyOrWhitespace) line--;
    if (result.interrupted) {
      // Stopping a run is the student's choice (or the live time budget),
      // not a bug in their code: no red squiggle, just say what happened.
      this.decorations.clearErrors(doc);
      if (enabled) this.decorations.setInline(doc, line, result.interrupted === 'timeout' ? 'live run took longer than the time budget — stopped' : 'stopped');
    } else if (result.status === 'error' && result.error) {
      this.decorations.showError(doc, result.error);
      if (enabled) this.decorations.setInline(doc, line, `${result.error.ename}: ${result.error.evalue}`);
    } else if (result.status === 'blocked') {
      // A syntax error while typing is expected mid-edit: say nothing.
      if (result.analysis?.syntaxError) {
        this.decorations.clearErrors(doc);
        return;
      }
      const f = result.stoppedAt ?? result.analysis?.findings[0];
      const at = this.stopLine(doc, result, startLine) ?? line;
      if (enabled) this.decorations.setInline(doc, at, `not run live — ${f ? f.message : 'see Output'} · Run Cell to run it`);
    } else {
      this.decorations.clearErrors(doc);
      const stop = this.stopLine(doc, result, startLine);
      if (enabled && result.value && stop === undefined) this.decorations.setInline(doc, line, inlineText(result.value));
      // Live ran the safe beginning: say where it stopped and why.
      if (enabled && stop !== undefined && result.stoppedAt) {
        this.decorations.setInline(doc, stop, `Live stops here — ${result.stoppedAt.message} · Run Cell to run the rest`);
      }
    }
  }

  /** 0-based document line of a live stop, if any. */
  private stopLine(doc: vscode.TextDocument, result: ExecuteResult, startLine: number): number | undefined {
    const l = result.stoppedAt?.line;
    if (l === undefined) return undefined;
    const at = l - 1;
    return at >= startLine && at < doc.lineCount ? at : undefined;
  }

  clearInlineResults(): void {
    this.decorations.clearAllInline();
  }

  /** Lines (0-based) that currently show an inline note — for tests. */
  inlineNotes(doc: vscode.TextDocument): Map<number, string> {
    return this.decorations.notes(doc);
  }

  // ------------------------------------------------------------ live mode

  async toggleLiveMode(): Promise<void> {
    const doc = this.targetEditor()?.document;
    if (!doc || doc.languageId !== 'python') {
      void vscode.window.showInformationMessage('vrun: open a Python file to use Live Mode.');
      return;
    }
    const key = doc.uri.toString();
    const sk = `exec:${key}`;
    if (this.liveDocs.delete(key)) {
      this.scheduler.cancel(sk);
      this.deferredLive.delete(sk);
      void vscode.window.setStatusBarMessage('vrun: Live off', 2500);
      this.panel.post({ type: 'liveState', live: false, liveViz: this.liveVizDocs.has(key) });
      return;
    }
    this.liveDocs.add(key);
    this.panel.post({ type: 'liveState', live: true, liveViz: this.liveVizDocs.has(key) });
    void vscode.window.setStatusBarMessage('vrun: Live on — data is loaded once, the rest re-runs as you type', 4000);
    // Turning Live on is an explicit request: start the kernel if needed
    // (live edits never start one on their own) and run once right away,
    // so data files are read now instead of on the first keystroke.
    try {
      await this.ensureKernel();
    } catch {
      // The kernel could not start: Live must not stay "on" doing nothing.
      this.liveDocs.delete(key);
      this.panel.post({ type: 'liveState', live: false, liveViz: this.liveVizDocs.has(key) });
      return;
    }
    if (this.liveDocs.has(key)) this.scheduler.schedule(sk, (gen) => this.runLive(doc, sk, gen));
  }

  async toggleLiveVisualize(): Promise<void> {
    if (!(await this.featureEnabled('visualizer'))) return;
    const doc = this.targetEditor()?.document;
    if (!doc || doc.languageId !== 'python') {
      void vscode.window.showInformationMessage('vrun: open a Python file to use Live Visualize.');
      return;
    }
    const key = doc.uri.toString();
    if (this.liveVizDocs.delete(key)) {
      this.scheduler.cancel(`trace:${key}`);
      void vscode.window.setStatusBarMessage('vrun: Live Visualize OFF', 2500);
    } else {
      this.liveVizDocs.add(key);
      try {
        await this.ensureKernel();
      } catch {
        // No kernel: Live Visualize must not stay "on" doing nothing.
        this.liveVizDocs.delete(key);
        this.panel.post({ type: 'liveState', live: this.liveDocs.has(key), liveViz: false });
        return;
      }
      void this.visualize();
      void vscode.window.setStatusBarMessage('vrun: Live Visualize ON — the visualizer follows your edits', 3500);
    }
    this.panel.post({ type: 'liveState', live: this.liveDocs.has(key), liveViz: this.liveVizDocs.has(key) });
  }

  private releaseDeferredLive(): void {
    const pending = [...this.deferredLive];
    this.deferredLive.clear();
    for (const [key, doc] of pending) {
      if (!doc.isClosed && this.liveDocs.has(doc.uri.toString())) this.scheduler.schedule(key, (g) => this.runLive(doc, key, g));
    }
  }

  // --------------------------------------------------------------- features

  /**
   * The visualizer and DataFrame viewer are opt-in (Settings → vrun) so
   * the default panel stays minimal. Asks once to enable when used while off.
   */
  private async featureEnabled(feature: Feature): Promise<boolean> {
    if (cfg().get<boolean>(`features.${feature}`, false)) return true;
    const label = feature === 'visualizer' ? 'The algorithm visualizer (DSA)' : 'The DataFrame viewer';
    const pick = await vscode.window.showInformationMessage(`vrun: ${label} is turned off.`, 'Turn On', 'Open Settings');
    if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', `vrun.features.${feature}`);
    if (pick !== 'Turn On') return false;
    // Enable it and carry on with what the student asked for. Tell the
    // webview first: the configuration event may arrive after our next
    // message (e.g. "open this DataFrame"), which it would otherwise ignore.
    await cfg().update(`features.${feature}`, true, vscode.ConfigurationTarget.Global);
    this.postFeatures();
    return true;
  }

  private postFeatures(): void {
    this.panel.post({
      type: 'features',
      visualizer: cfg().get<boolean>('features.visualizer', false),
      dataframe: cfg().get<boolean>('features.dataframe', false),
      pageSize: cfg().get<number>('dataframe.pageSize', 50),
    });
  }

  /** Live Mode / Live Visualize state of a document (used by tests and the UI). */
  liveState(uri: vscode.Uri): { live: boolean; liveViz: boolean } {
    const key = uri.toString();
    return { live: this.liveDocs.has(key), liveViz: this.liveVizDocs.has(key) };
  }

  private postLiveState(): void {
    const doc = this.targetEditor()?.document;
    // While the inspector has focus this is the last Python editor; for a
    // non-Python editor Live is shown as off.
    if (!doc) return;
    const key = doc.uri.toString();
    const py = doc.languageId === 'python';
    this.panel.post({ type: 'liveState', live: py && this.liveDocs.has(key), liveViz: py && this.liveVizDocs.has(key) });
  }

  private disableLive(key: string): void {
    this.liveDocs.delete(key);
    this.liveVizDocs.delete(key);
    this.scheduler.cancel(`exec:${key}`);
    this.scheduler.cancel(`trace:${key}`);
    this.deferredLive.delete(`exec:${key}`); // a closed document must never run later
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    if (e.document.uri.scheme === 'file' && e.document.uri.fsPath.toLowerCase().endsWith('.in')) {
      this.onProgramInputChanged(e.document.uri.fsPath);
      return;
    }
    const doc = e.document;
    const key = doc.uri.toString();
    // Inline notes are keyed by line number: an edit invalidates the notes of
    // the lines it touches, and adding/removing lines shifts every later note.
    // An error squiggle belongs to the code that ran; once edited it is stale.
    if (this.decorations.hasErrors(doc)) this.decorations.clearErrors(doc);
    for (const ch of e.contentChanges) {
      const removed = ch.range.end.line - ch.range.start.line;
      const added = (ch.text.match(/\n/g) ?? []).length;
      if (removed !== added) this.decorations.clearInline(doc, ch.range.start.line);
      else this.decorations.clearInline(doc, ch.range.start.line, ch.range.end.line);
    }
    if (this.liveDocs.has(key)) {
      const sk = `exec:${key}`;
      this.scheduler.schedule(sk, (gen) => this.runLive(doc, sk, gen));
    }
    if (this.liveVizDocs.has(key)) {
      const sk = `trace:${key}`;
      this.scheduler.schedule(sk, (gen) => this.traceDocument(doc, 'live', () => this.scheduler.isCurrent(sk, gen)));
    }
  }

  // ---------------------------------------------------------- program input

  /** Text of `<script>.in` (open editor content first, else the file on disk). */
  private programInput(doc: vscode.TextDocument): string | undefined {
    if (doc.uri.scheme !== 'file') return undefined;
    const inPath = inputPathFor(doc.uri.fsPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, inPath));
    let text: string | undefined = open?.getText();
    if (text === undefined) {
      try {
        text = fs.readFileSync(inPath, 'utf8');
      } catch (err) {
        // A missing .in file is normal; anything else (permissions, a folder
        // named solution.in) must not turn into the "create a .in file" hint.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          void vscode.window.showWarningMessage(`vrun: could not read program input ${path.basename(inPath)}: ${(err as Error).message}`);
        }
        return undefined;
      }
    }
    return text.length > MAX_PROGRAM_INPUT_CHARS ? text.slice(0, MAX_PROGRAM_INPUT_CHARS) : text;
  }

  /** Editing solution.in re-runs solution.py when Live (Visualize) is on for it. */
  private onProgramInputChanged(inputPath: string): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !isInputOf(inputPath, doc.uri.fsPath)) continue;
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
  }

  /** "vrun: Edit Program Input": open (creating if needed) `<script>.in`. */
  async editProgramInput(): Promise<void> {
    const doc = this.targetEditor()?.document;
    if (!doc || doc.languageId !== 'python' || doc.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('vrun: open a saved Python file first.');
      return;
    }
    const inPath = inputPathFor(doc.uri.fsPath);
    if (!fs.existsSync(inPath)) fs.writeFileSync(inPath, '');
    await vscode.window.showTextDocument(vscode.Uri.file(inPath), { viewColumn: vscode.ViewColumn.Beside, preview: false });
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
    // Never compete with a manual run: remember the document and run it when
    // the last manual run settles (event-driven, so a hung run cannot cause
    // endless retries).
    if (this.manualRunning > 0) {
      if (this.scheduler.isCurrent(key, gen)) this.deferredLive.set(key, doc);
      return;
    }
    for (const cell of this.liveTargets(doc)) {
      if (!this.scheduler.isCurrent(key, gen)) return;
      const r = await this.runCode(doc, cell.text, cell.startLine, 'live', `line ${cell.startLine + 1}`, cell.endLine, () =>
        this.scheduler.isCurrent(key, gen),
      );
      // A cell that Live stopped before its training leaves later cells
      // without a fitted model: they would only show NotFittedError.
      if (!r || r.status !== 'ok' || r.stoppedAt) return;
    }
  }

  // ------------------------------------------------------------ visualizer

  async visualize(args: readonly unknown[] = []): Promise<void> {
    if (!(await this.featureEnabled('visualizer'))) return;
    const t = this.commandTarget(args);
    if (!t) return;
    this.panel.reveal('visualizer', true);
    // A CodeLens names its cell, whatever is selected; otherwise follow the
    // selection or the cursor.
    await this.traceDocument(t.doc, 'manual', undefined, t.explicitLine ? { kind: 'cell', line: t.line } : { kind: 'auto' });
  }

  /** The whole document, ignoring cells and the selection. */
  async visualizeFile(args: readonly unknown[] = []): Promise<void> {
    if (!(await this.featureEnabled('visualizer'))) return;
    const t = this.commandTarget(args);
    if (!t) return;
    this.panel.reveal('visualizer', true);
    await this.traceDocument(t.doc, 'manual', undefined, { kind: 'file' });
  }

  /** The document of the trace the panel shows, while it is still open. */
  private lastTracedDocument(): vscode.TextDocument | undefined {
    const key = this.lastTrace?.uri.toString();
    if (key === undefined) return undefined;
    return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === key);
  }

  private traceScope(doc: vscode.TextDocument, want: TraceWant): TraceScope {
    const text = doc.getText();
    const whole: TraceScope = { code: text, lineOffset: 0, label: path.basename(doc.fileName) };
    if (want.kind === 'file') return whole;
    let line: number | undefined;
    if (want.kind === 'cell') {
      line = want.line;
    } else {
      const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
      const sel = editor?.selection;
      if (sel && !sel.isEmpty) {
        return { code: dedent(doc.getText(selectionRange(doc, sel))), lineOffset: sel.start.line, label: `selection (line ${sel.start.line + 1})` };
      }
      line = editor?.selection.active.line;
    }
    if (line !== undefined && hasCellMarkers(text)) {
      const cell = cellAt(text, line);
      if (cell) {
        // A cell is traced in a fresh namespace: the functions, imports and
        // constants of the cells above come along (the kernel keeps only
        // what is safe to re-run), or using them would be a NameError.
        return { code: cell.text, lineOffset: cell.startLine, label: `cell at line ${cell.startLine + 1}`, prelude: preludeFor(text, cell.startLine) };
      }
    }
    return whole;
  }

  private async traceDocument(
    doc: vscode.TextDocument,
    mode: Mode,
    isCurrent: (() => boolean) | undefined,
    want: TraceWant = { kind: 'auto' },
  ): Promise<void> {
    const scope = this.traceScope(doc, want);
    if (!scope.code.trim()) return;
    if (mode === 'live' && !this.kernel.isRunning) return; // live work never starts a kernel
    try {
      await this.ensureKernel();
    } catch {
      return;
    }
    const execId = ++this.execCounter;
    const stdin = this.programInput(doc);
    this.panel.post({ type: 'traceStart', execId, label: scope.label, mode });
    const params: TraceParams = {
      code: scope.code,
      mode,
      execId,
      maxSteps: cfg().get<number>('trace.maxSteps', 5000),
      timeoutMs: cfg().get<number>('trace.timeoutMs', 15000),
    };
    if (stdin !== undefined) params.stdin = stdin;
    const cwd = this.docFolder(doc);
    if (cwd !== undefined) params.cwd = cwd;
    if (scope.prelude !== undefined) params.prelude = scope.prelude;
    try {
      const result = await this.kernel.request<TraceResult>('trace', params);
      if (isCurrent && !isCurrent()) {
        // A newer edit superseded this trace; let the UI drop its "Tracing…" state.
        this.panel.post({ type: 'traceSuperseded', execId });
        return;
      }
      // Keyed by execId: the webview may still be showing an older trace
      // (it ignores results older than the newest one it started).
      this.traceContexts.set(execId, { uri: doc.uri, lineOffset: scope.lineOffset });
      this.lastTrace = { uri: doc.uri, result };
      for (const id of this.traceContexts.keys()) if (this.traceContexts.size > 20) this.traceContexts.delete(id);
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
    if (!(await this.featureEnabled('dataframe'))) return;
    if (!name) {
      if (!this.kernel.isRunning) {
        void vscode.window.showInformationMessage('vrun: start the kernel and create a DataFrame first.');
        return;
      }
      await this.refreshVariables();
      const frames = (this.lastVariables?.variables ?? []).filter((v) => v.kind === 'dataframe' || v.kind === 'series' || v.table === true);
      if (frames.length === 0) {
        void vscode.window.showInformationMessage('vrun: no pandas DataFrame or Series variables in the kernel.');
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
        this.postFeatures();
        this.panel.post({ type: 'status', status: this.kernel.status, workload: this.kernel.workload });
        if (this.kernel.info) {
          const i = this.kernel.info;
          this.panel.post({ type: 'session', session: i.session, python: i.python, cwd: i.cwd, pid: i.pid });
        }
        if (this.lastVariables) this.panel.post({ type: 'variables', list: this.lastVariables });
        this.postLiveState();
        return;
      case 'command': {
        // The panel's "Visualize whole file" sits under a trace's notes: it
        // means that trace's file, even if another Python file is in front now.
        const traced = msg.command === 'visualizeFile' ? this.lastTracedDocument() : undefined;
        await vscode.commands.executeCommand(WEBVIEW_COMMAND_IDS[msg.command], ...(traced ? [traced.uri] : []));
        return;
      }
      case 'refreshVariables':
        await this.refreshVariables();
        return;
      case 'openDataFrame':
        await this.openDataFrame(msg.name);
        return;
      case 'inspectVariable':
        return this.forward(msg.requestId, 'variables.inspect', { name: msg.name, maxNodes: 200, maxItems: 100 });
      case 'seriesVariable':
        return this.forward(msg.requestId, 'variables.series', {
          name: msg.name,
          maxPoints: msg.maxPoints,
          timeoutMs: cfg().get<number>('inspect.timeoutMs', 20000),
        });
      case 'imageVariable':
        return this.forward(msg.requestId, 'variables.image', {
          name: msg.name,
          start: msg.start,
          count: msg.count,
          timeoutMs: cfg().get<number>('inspect.timeoutMs', 20000),
        });
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
      {
        const ctx = this.traceContexts.get(msg.execId);
        if (ctx) this.decorations.highlightTraceLine(ctx.uri, msg.line - 1 + ctx.lineOffset);
      }
        return;
      case 'openFigure': {
        const file = this.figureFiles.get(msg.execId)?.[msg.index];
        if (file && file.toLowerCase().endsWith('.html') && path.isAbsolute(file) && fs.existsSync(file)) {
          await vscode.env.openExternal(vscode.Uri.file(file));
        } else {
          void vscode.window.showInformationMessage('vrun: that figure is no longer available; run the cell again.');
        }
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage('vrun: copied', 1500);
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

  /** Start a practice file from one of the bundled examples (opened unsaved). */
  async newPracticeFile(): Promise<void> {
    const dir = path.join(this.context.extensionPath, 'examples');
    const items = [
      { label: 'scikit-learn: classify tabular data', file: 'ml_sklearn_tabular.py', detail: 'Pipeline, cross-validation, confusion matrix, grid search (bundled dataset)' },
      { label: 'PyTorch: a neural network on digits', file: 'ml_pytorch_digits.py', detail: 'Tensors, training loop, loss curve, image preview of the inputs' },
      { label: 'Keras: a neural network on digits', file: 'ml_keras_digits.py', detail: 'model.fit with its progress bar, History chart' },
      { label: 'pandas: clean and explore a table', file: 'pandas_demo.py', detail: 'Load once, Live cells, DataFrame viewer' },
      { label: 'Algorithms: sorting, binary search, two pointers', file: 'dsa_sort_search.py', detail: 'Visualizer: bars, pointers, sliding window, values of the current line' },
      { label: 'Algorithms: recursion and backtracking', file: 'dsa_recursion.py', detail: 'Recursion tree of fib, merge sort, permutations' },
      { label: 'Algorithms: graphs and grids', file: 'dsa_graphs.py', detail: 'BFS, DFS, islands on a grid, Dijkstra, union-find' },
      { label: 'Data structures: linked list, stack, BST, heap, trie', file: 'dsa_structures.py', detail: 'Pointers on nodes, heap as a tree, trie' },
      { label: 'Algorithms: a quick tour', file: 'dsa_demo.py', detail: 'Visualizer: arrays, graphs, trees' },
    ].filter((i) => fs.existsSync(path.join(dir, i.file)));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Start a practice file from…', matchOnDetail: true });
    if (!pick) return;
    const content = fs.readFileSync(path.join(dir, pick.file), 'utf8');
    const doc = await vscode.workspace.openTextDocument({ language: 'python', content });
    await vscode.window.showTextDocument(doc);
  }

  showLog(): void {
    this.output.show();
  }

  dispose(): void {
    this.cancelLiveWork();
    this.kernel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * VS Code's fsPath writes the Windows drive letter in lower case; the kernel
 * shows this folder to the learner ("working folder: C:\..."), so write it
 * the way Explorer and os.getcwd() do.
 */
function displayFolder(folder: string): string {
  return folder.replace(/^([a-z]):(?=[\\/])/, (_m, d: string) => `${d.toUpperCase()}:`);
}

function formatSeconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`;
}
