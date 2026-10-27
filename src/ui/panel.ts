import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { WebviewMessage, validateWebviewMessage } from './validate';

export type PanelTab = 'variables' | 'dataframe' | 'output' | 'visualizer';

/** Single inspector webview panel shown beside the editor. */
export class InspectorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: unknown[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: WebviewMessage) => void,
    private readonly log: (text: string) => void,
  ) {}

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  reveal(tab?: PanelTab, preserveFocus = true): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'pylive.inspector',
        'PyLive Inspector',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        },
      );
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
      this.ready = false;
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(
        (raw) => {
          const msg = validateWebviewMessage(raw);
          if (!msg) {
            this.log(`[pylive] rejected invalid webview message: ${JSON.stringify(raw)?.slice(0, 200)}\n`);
            return;
          }
          if (msg.type === 'ready') {
            this.ready = true;
            const pending = this.queue;
            this.queue = [];
            for (const m of pending) void this.panel?.webview.postMessage(m);
          }
          this.onMessage(msg);
        },
        undefined,
        this.disposables,
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        this.queue = [];
      }, undefined, this.disposables);
    } else if (!this.panel.visible) {
      // Revealing in the editor's own group would cover the file being edited:
      // move the panel beside it instead.
      const editorColumn = vscode.window.activeTextEditor?.viewColumn;
      const sameGroup = editorColumn !== undefined && editorColumn === this.panel.viewColumn;
      this.panel.reveal(sameGroup ? vscode.ViewColumn.Beside : undefined, preserveFocus);
    } else if (!preserveFocus) {
      this.panel.reveal(undefined, false);
    }
    if (tab) this.post({ type: 'showTab', tab });
  }

  /** Post to the webview; buffered until the webview reports ready. */
  post(msg: unknown): void {
    if (!this.panel) return;
    if (!this.ready) {
      this.queue.push(msg);
      if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>PyLive Inspector</title>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
