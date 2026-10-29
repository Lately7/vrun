import * as vscode from 'vscode';
import { VeilController } from './controller';

let controller: VeilController | undefined;

export function activate(context: vscode.ExtensionContext): VeilController {
  const c = new VeilController(context);
  controller = c;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('veil.startKernel', () => c.startKernel());
  reg('veil.restartKernel', () => c.restartKernel());
  reg('veil.stopKernel', () => c.stopKernel());
  reg('veil.runSelection', () => c.runSelection());
  reg('veil.runCell', () => c.runCell());
  reg('veil.runFile', () => c.runFile());
  reg('veil.toggleLiveMode', () => c.toggleLiveMode());
  reg('veil.visualize', () => c.visualize());
  reg('veil.toggleLiveVisualize', () => c.toggleLiveVisualize());
  reg('veil.openVariables', () => c.openVariables());
  reg('veil.openDataFrame', (name?: unknown) => c.openDataFrame(typeof name === 'string' ? name : undefined));
  reg('veil.interrupt', () => c.interrupt());
  reg('veil.showLog', () => c.showLog());
  reg('veil.clearInlineResults', () => c.clearInlineResults());
  reg('veil.editInput', () => c.editProgramInput());
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
