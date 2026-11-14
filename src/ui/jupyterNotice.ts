import * as vscode from 'vscode';
import { jupyterState } from './cellLens';
import { shouldShowJupyterNotice } from './cellLensModel';

const SHOWN_KEY = 'vrun.jupyterNoticeShown';
/** Jupyter activates on Python files too, possibly just after our lenses were asked for. */
const RECHECK_MS = 5000;

const USE_VRUN = 'Use vrun for Run Cell and Shift+Enter';
const HIDE_ONLY = "Only hide Jupyter's buttons";
const HIDE = "Hide Jupyter's Run Cell";

/**
 * Once per machine: with the Jupyter extension, a `# %%` file shows two
 * "Run Cell" buttons, and Shift+Enter / Ctrl+Enter run Jupyter's. Learners
 * who use Jupyter's see their variables missing from vrun and think vrun is
 * broken, so say that these are two separate Pythons and offer to hand the
 * buttons and keys to vrun. Nothing is changed unless a button is clicked.
 */
export class JupyterNotice implements vscode.Disposable {
  private pending = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly globalState: vscode.Memento) {}

  /** Called whenever cell lenses are shown for a document. */
  maybeShow(doc: vscode.TextDocument): void {
    if (this.pending || this.globalState.get<boolean>(SHOWN_KEY, false)) return;
    const state = jupyterState(doc.uri);
    if (!shouldShowJupyterNotice(state, false)) {
      if (state.installed && !state.active && state.codeLensEnabled && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (!doc.isClosed) this.maybeShow(doc);
        }, RECHECK_MS);
      }
      return;
    }
    this.pending = true;
    void this.show(doc.uri).finally(() => (this.pending = false));
  }

  private async show(resource: vscode.Uri): Promise<void> {
    // Marked before asking: closing the toast without a choice also counts.
    await this.globalState.update(SHOWN_KEY, true);
    // With this on, vrun's Shift+Enter and Ctrl+Enter outrank Jupyter's
    // (package.json), so only the buttons remain an issue.
    const vrunHasKeys = vscode.workspace.getConfiguration('vrun').get<boolean>('shiftEnterRunsCell', false);
    const pick = await vscode.window.showInformationMessage(
      `vrun: The Jupyter extension also puts a "Run Cell" button above each cell${vrunHasKeys ? '' : ' and takes Shift+Enter and Ctrl+Enter in files with # %% cells'}. ` +
        "Jupyter runs your code in its own, separate Python, so vrun's Variables and Output never see those variables. " +
        'For vrun, click "vrun: Run Cell" or press Ctrl+Alt+C.',
      // Hiding Jupyter's buttons does not touch its keys (they do not depend
      // on its lens setting), so the first choice hands over both: a learner
      // who clicks it and then presses Shift+Enter must not land in Jupyter.
      ...(vrunHasKeys ? [HIDE] : [USE_VRUN, HIDE_ONLY]),
    );
    if (pick === undefined) return;
    try {
      if (pick === USE_VRUN) {
        await vscode.workspace.getConfiguration('vrun').update('shiftEnterRunsCell', true, vscode.ConfigurationTarget.Global);
      }
      // Workspace settings, so other projects keep Jupyter as it was; with
      // no folder open there are only user settings.
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('jupyter', resource).update('interactiveWindow.codeLens.enable', false, target);
      const hidden = `vrun: Jupyter's Run Cell hidden${target === vscode.ConfigurationTarget.Workspace ? ' in this workspace' : ''}.`;
      if (pick === USE_VRUN) {
        void vscode.window.setStatusBarMessage(`${hidden} Shift+Enter and Ctrl+Enter now run the cell in vrun (vrun.shiftEnterRunsCell).`, 10000);
      } else if (!vrunHasKeys) {
        // The notice does not come back: say once where the keys are handed over.
        void vscode.window.setStatusBarMessage(`${hidden} Shift+Enter and Ctrl+Enter still run the cell in Jupyter; turn on vrun.shiftEnterRunsCell to give them to vrun.`, 15000);
      } else {
        void vscode.window.setStatusBarMessage(`${hidden} (jupyter.interactiveWindow.codeLens.enable)`, 6000);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`vrun: could not change the setting. ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
