import * as vscode from 'vscode';
import { VrunController } from './controller';
import { CELL_LENS_SELECTOR, CellLensProvider } from './ui/cellLens';
import { JupyterNotice } from './ui/jupyterNotice';

let controller: VrunController | undefined;

export function activate(context: vscode.ExtensionContext): VrunController {
  const c = new VrunController(context);
  controller = c;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('vrun.startKernel', () => c.startKernel());
  reg('vrun.restartKernel', () => c.restartKernel());
  reg('vrun.stopKernel', () => c.stopKernel());
  reg('vrun.runSelection', () => c.runSelection());
  // Cell commands take (uri, line) from a CodeLens, or the uri from a menu.
  reg('vrun.runCell', (...args) => c.runCell(args));
  reg('vrun.runCellAndAdvance', (...args) => c.runCellAndAdvance(args));
  reg('vrun.runCellsAbove', (...args) => c.runCellsAbove(args));
  reg('vrun.runFile', () => c.runFile());
  reg('vrun.toggleLiveMode', () => c.toggleLiveMode());
  reg('vrun.visualize', (...args) => c.visualize(args));
  reg('vrun.visualizeFile', (...args) => c.visualizeFile(args));
  reg('vrun.toggleLiveVisualize', () => c.toggleLiveVisualize());
  reg('vrun.openVariables', () => c.openVariables());
  reg('vrun.openDataFrame', (name?: unknown) => c.openDataFrame(typeof name === 'string' ? name : undefined));
  reg('vrun.interrupt', () => c.interrupt());
  reg('vrun.showLog', () => c.showLog());
  reg('vrun.clearInlineResults', () => c.clearInlineResults());
  reg('vrun.editInput', () => c.editProgramInput());
  reg('vrun.newPracticeFile', () => c.newPracticeFile());
  const notice = new JupyterNotice(context.globalState);
  const lenses = new CellLensProvider((doc) => notice.maybeShow(doc));
  context.subscriptions.push(notice, lenses, vscode.languages.registerCodeLensProvider(CELL_LENS_SELECTOR, lenses));
  context.subscriptions.push(c);
  // Returned as the extension API so integration tests can observe state.
  return c;
}

export async function deactivate(): Promise<void> {
  if (controller) {
    await controller.kernel.stop(1000).catch(() => undefined);
    controller.dispose();
    controller = undefined;
  }
}
