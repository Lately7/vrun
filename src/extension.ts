import * as vscode from 'vscode';
import { VrunController } from './controller';

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
  reg('vrun.runCell', () => c.runCell());
  reg('vrun.runFile', () => c.runFile());
  reg('vrun.toggleLiveMode', () => c.toggleLiveMode());
  reg('vrun.visualize', () => c.visualize());
  reg('vrun.toggleLiveVisualize', () => c.toggleLiveVisualize());
  reg('vrun.openVariables', () => c.openVariables());
  reg('vrun.openDataFrame', (name?: unknown) => c.openDataFrame(typeof name === 'string' ? name : undefined));
  reg('vrun.interrupt', () => c.interrupt());
  reg('vrun.showLog', () => c.showLog());
  reg('vrun.clearInlineResults', () => c.clearInlineResults());
  reg('vrun.editInput', () => c.editProgramInput());
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
