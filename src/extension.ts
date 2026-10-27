import * as vscode from 'vscode';
import { PyLiveController } from './controller';

let controller: PyLiveController | undefined;

export function activate(context: vscode.ExtensionContext): PyLiveController {
  const c = new PyLiveController(context);
  controller = c;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('pylive.startKernel', () => c.startKernel());
  reg('pylive.restartKernel', () => c.restartKernel());
  reg('pylive.stopKernel', () => c.stopKernel());
  reg('pylive.runSelection', () => c.runSelection());
  reg('pylive.runCell', () => c.runCell());
  reg('pylive.runFile', () => c.runFile());
  reg('pylive.toggleLiveMode', () => c.toggleLiveMode());
  reg('pylive.visualize', () => c.visualize());
  reg('pylive.toggleLiveVisualize', () => c.toggleLiveVisualize());
  reg('pylive.openVariables', () => c.openVariables());
  reg('pylive.openDataFrame', (name?: unknown) => c.openDataFrame(typeof name === 'string' ? name : undefined));
  reg('pylive.interrupt', () => c.interrupt());
  reg('pylive.showLog', () => c.showLog());
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
