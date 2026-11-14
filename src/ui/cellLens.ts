import * as vscode from 'vscode';
import { isCellMarker } from '../exec/cells';
import { JupyterState, cellLensSpots, jupyterLensesShown } from './cellLensModel';

export const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';

/** Only real editors: a lens in a git diff or an output view would run that copy of the code. */
export const CELL_LENS_SELECTOR: vscode.DocumentSelector = [
  { language: 'python', scheme: 'file' },
  { language: 'python', scheme: 'untitled' },
];

export function jupyterState(resource?: vscode.Uri): JupyterState {
  const ext = vscode.extensions.getExtension(JUPYTER_EXTENSION_ID);
  return {
    installed: ext !== undefined,
    active: ext?.isActive ?? false,
    // Jupyter's own setting; when Jupyter is absent the default does not matter.
    codeLensEnabled: vscode.workspace.getConfiguration('jupyter', resource).get<boolean>('interactiveWindow.codeLens.enable', true) !== false,
  };
}

/**
 * "Run Cell | Run Above | Visualize" above each `# %%` cell. Beginners click
 * what they see: without these, the only visible Run buttons belonged to
 * the Python and Jupyter extensions, which run the code in another Python
 * whose variables vrun never shows.
 */
export class CellLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  /** `onCellsShown` is told about each document that got lenses (the Jupyter notice). */
  constructor(private readonly onCellsShown: (doc: vscode.TextDocument) => void) {
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('vrun.codeLens') ||
          e.affectsConfiguration('vrun.features.visualizer') ||
          e.affectsConfiguration('jupyter.interactiveWindow.codeLens.enable')
        ) {
          this.changed.fire();
        }
      }),
      // Installing or removing Jupyter changes the labels.
      vscode.extensions.onDidChange(() => this.changed.fire()),
    ];
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const cfg = vscode.workspace.getConfiguration('vrun');
    if (!cfg.get<boolean>('codeLens', true)) return [];
    const spots = cellLensSpots(doc.getText());
    if (spots.length === 0) return [];
    this.onCellsShown(doc);
    const visualizer = cfg.get<boolean>('features.visualizer', false);
    // Next to Jupyter's identical "Run Cell | Run Above", say whose buttons these are.
    const prefix = jupyterLensesShown(jupyterState(doc.uri)) ? 'vrun: ' : '';
    const run = `$(play) ${prefix}Run Cell`;
    const above = `${prefix}Run Above`;
    const lenses: vscode.CodeLens[] = [];
    for (const spot of spots) {
      const range = new vscode.Range(spot.line, 0, spot.line, 0);
      // The cell is passed by line, plus the marker's text: a lens clicked
      // after an edit above it, before VS Code redraws the lenses, still
      // carries the old line, and the commands re-find the marker from its
      // text (lensLine). The line-0 lens needs no text: the first cell
      // always starts there.
      const marker = doc.lineAt(spot.line).text;
      const args = isCellMarker(marker) ? [doc.uri, spot.line, marker] : [doc.uri, spot.line];
      lenses.push(
        new vscode.CodeLens(range, {
          title: run,
          command: 'vrun.runCell',
          arguments: args,
          tooltip: "Run this cell in vrun's Python (Ctrl+Alt+C); its variables show in the vrun panel",
        }),
      );
      if (spot.hasCodeAbove) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: above,
            command: 'vrun.runCellsAbove',
            arguments: args,
            tooltip: 'Run every cell above this one in vrun, in order (stops at the first error)',
          }),
        );
      }
      // Same rule as the editor title button: the visualizer is opt-in.
      if (visualizer) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(graph) Visualize',
            command: 'vrun.visualize',
            arguments: args,
            tooltip: 'Step through this cell in the visualizer (Ctrl+Alt+V); functions and imports from the cells above are included',
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }
}
