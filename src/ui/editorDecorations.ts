import * as vscode from 'vscode';
import { ErrorInfo } from '../kernel/protocol';

const MAX_INLINE = 120;

/** Inline results, error diagnostics and the trace-step line highlight. */
export class EditorDecorations implements vscode.Disposable {
  private readonly resultType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly traceType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('vrun');
  /** uri -> line -> inline text */
  private inline = new Map<string, Map<number, string>>();

  setInline(doc: vscode.TextDocument, line: number, text: string): void {
    const key = doc.uri.toString();
    let m = this.inline.get(key);
    if (!m) this.inline.set(key, (m = new Map()));
    const oneLine = text.replace(/\s+/g, ' ').trim();
    m.set(line, oneLine.length > MAX_INLINE ? oneLine.slice(0, MAX_INLINE) + '…' : oneLine);
    this.render(doc);
  }

  clearInline(doc: vscode.TextDocument, fromLine = 0, toLine = Number.MAX_SAFE_INTEGER): void {
    const m = this.inline.get(doc.uri.toString());
    if (!m) return;
    let changed = false;
    for (const l of [...m.keys()]) {
      if (l >= fromLine && l <= toLine) changed = m.delete(l) || changed;
    }
    // Called on every keystroke: only touch the editor when something went away.
    if (changed) this.render(doc);
  }

  notes(doc: vscode.TextDocument): Map<number, string> {
    return new Map(this.inline.get(doc.uri.toString()) ?? []);
  }

  /** "vrun: Clear Inline Results": remove every note in every editor. */
  clearAllInline(): void {
    this.inline.clear();
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.resultType, []);
  }

  private render(doc: vscode.TextDocument): void {
    const m = this.inline.get(doc.uri.toString());
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== doc) continue;
      const opts: vscode.DecorationOptions[] = [];
      for (const [line, text] of m ?? []) {
        if (line >= doc.lineCount) continue;
        const end = doc.lineAt(line).range.end;
        opts.push({ range: new vscode.Range(end, end), renderOptions: { after: { contentText: `  ⇒ ${text}` } } });
      }
      editor.setDecorations(this.resultType, opts);
    }
  }

  refreshEditor(editor: vscode.TextEditor): void {
    this.render(editor.document);
  }

  showError(doc: vscode.TextDocument, err: ErrorInfo): void {
    const f = err.userFrame;
    if (!f || f.line < 1) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const line = Math.min(f.line - 1, doc.lineCount - 1);
    const text = doc.lineAt(line);
    let range = text.range;
    if (f.col && f.endCol && (f.endLine ?? f.line) === f.line && f.endCol > f.col) {
      range = new vscode.Range(line, Math.max(0, f.col - 1), line, Math.min(text.text.length, f.endCol - 1));
    }
    const d = new vscode.Diagnostic(range, `${err.ename}: ${err.evalue}`, vscode.DiagnosticSeverity.Error);
    d.source = 'vrun';
    this.diagnostics.set(doc.uri, [d]);
  }

  hasErrors(doc: vscode.TextDocument): boolean {
    return (this.diagnostics.get(doc.uri)?.length ?? 0) > 0;
  }

  clearErrors(doc: vscode.TextDocument): void {
    this.diagnostics.delete(doc.uri);
  }

  highlightTraceLine(uri: vscode.Uri, line0: number): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri.toString()) continue;
      if (line0 < 0 || line0 >= editor.document.lineCount) continue;
      const range = editor.document.lineAt(line0).range;
      editor.setDecorations(this.traceType, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  clearTrace(): void {
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.traceType, []);
  }

  dispose(): void {
    this.resultType.dispose();
    this.traceType.dispose();
    this.diagnostics.dispose();
  }
}
