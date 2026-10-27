/** Integration tests executed inside the Extension Development Host. */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { PyLiveController } from '../../src/controller';
import type { ExecuteResult, VariablesList } from '../../src/kernel/protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 30000, what = 'condition'): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function tests(): void {
  let c: PyLiveController;
  const ws = process.env.PYLIVE_IT_WORKSPACE!;

  suiteSetup(async () => {
    await vscode.workspace.getConfiguration('pylive').update('pythonPath', process.env.PYLIVE_PYTHON, vscode.ConfigurationTarget.Global);
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'pylive-inspector');
    assert.ok(ext, 'extension is installed in the dev host');
    c = (await ext.activate()) as PyLiveController;
  });

  suiteTeardown(async () => {
    await c?.kernel.stop();
  });

  test('all commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'pylive.startKernel', 'pylive.restartKernel', 'pylive.stopKernel', 'pylive.runSelection', 'pylive.runCell',
      'pylive.runFile', 'pylive.toggleLiveMode', 'pylive.openVariables', 'pylive.openDataFrame', 'pylive.interrupt',
      'pylive.visualize', 'pylive.toggleLiveVisualize',
    ]) {
      assert.ok(all.includes(id), `missing command ${id}`);
    }
  });

  test('Run File executes in a persistent kernel (command → kernel → result)', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'pandas_demo.py'));
    await vscode.window.showTextDocument(doc);
    let t = Date.now();
    await vscode.commands.executeCommand('pylive.startKernel');
    console.log(`      kernel start: ${Date.now() - t} ms`);
    t = Date.now();
    await vscode.commands.executeCommand('pylive.runFile');
    console.log(`      run file (import pandas + 500k-row DataFrame): ${Date.now() - t} ms`);
    // The variables refresh that follows every run may still be in flight.
    await waitFor(() => c.kernel.status === 'idle', 10000, 'idle');
    const list = await c.kernel.request<VariablesList>('variables.list');
    const df = list.variables.find((v) => v.name === 'df');
    assert.deepEqual(df?.shape, [500000, 2]);
    // Persistence: a new execution reuses df without re-running the file.
    const r = await c.kernel.request<ExecuteResult>('execute', { code: 'df["Quantity"].median()' });
    assert.equal(r.status, 'ok');
    assert.equal(r.value?.repr, 'np.float64(24.5)');
  });

  test('Run Cell runs only the cell under the cursor', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'dsa_demo.py'));
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex((l) => l.startsWith('nums = '));
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('pylive.runCell');
    const list = await c.kernel.request<VariablesList>('variables.list');
    const names = list.variables.map((v) => v.name);
    assert.ok(names.includes('nums') && names.includes('mid'));
    assert.ok(!names.includes('graph'), 'other cells must not run');
  });

  test('Visualize traces without changing kernel variables', async () => {
    const before = await c.kernel.request<VariablesList>('variables.list');
    await vscode.commands.executeCommand('pylive.visualize');
    const after = await c.kernel.request<VariablesList>('variables.list');
    assert.equal(after.revision, before.revision);
  });

  test('extension host stays responsive during a long kernel computation', async () => {
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 50);
      last = now;
    }, 50);
    const r = await c.kernel.request<ExecuteResult>('execute', {
      code: 'import time\nt0 = time.time()\nwhile time.time() - t0 < 3:\n    sum(range(10000))\nprint("x" * 100000)',
    });
    clearInterval(timer);
    console.log(`      max event-loop lag during 3 s computation: ${maxLag} ms`);
    assert.equal(r.status, 'ok');
    assert.ok(maxLag < 300, `max event-loop lag ${maxLag} ms`);
  });

  test('interrupt stops a long-running cell and the kernel stays usable', async () => {
    const p = c.kernel.request<ExecuteResult>('execute', { code: 'i = 0\nwhile True:\n    i += 1' });
    await waitFor(() => c.kernel.status === 'busy', 5000, 'busy');
    await vscode.commands.executeCommand('pylive.interrupt');
    const r = await p;
    assert.equal(r.interrupted, 'interrupted');
    const again = await c.kernel.request<ExecuteResult>('execute', { code: 'i > 0' });
    assert.equal(again.value?.repr, 'True');
  });

  test('restart invalidates old sessions and variables', async () => {
    const old = c.kernel.session;
    await vscode.commands.executeCommand('pylive.restartKernel');
    assert.notEqual(c.kernel.session, old);
    await assert.rejects(c.kernel.request('variables.inspect', { name: 'df', session: old }), /previous kernel session/);
    const r = await c.kernel.request<ExecuteResult>('execute', { code: "'df' in globals()" });
    assert.equal(r.value?.repr, 'False');
  });

  test('stop terminates the kernel process', async () => {
    const pid = c.kernel.info?.pid;
    await vscode.commands.executeCommand('pylive.stopKernel');
    assert.equal(c.kernel.status, 'stopped');
    assert.ok(pid);
    await sleep(300);
    assert.throws(() => process.kill(pid!, 0), 'kernel process must be gone');
  });
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  suite('PyLive Inspector (Extension Development Host)', tests);
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
