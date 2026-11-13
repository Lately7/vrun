/** Integration tests executed inside the Extension Development Host. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { VrunController } from '../../src/controller';
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

/**
 * Show a document and wait until VS Code reports it as the active editor:
 * showTextDocument can resolve before activeTextEditor is updated, and our
 * commands act on the active editor.
 */
async function showAndActivate(doc: vscode.TextDocument, column?: vscode.ViewColumn): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(doc, column);
  // The extension targets the text tab shown in the active group (see
  // targetEditor); activeTextEditor may lag when the test window lacks focus.
  const isActiveTab = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputText && input.uri.toString() === doc.uri.toString();
  };
  await waitFor(() => isActiveTab(), 5000, `${path.basename(doc.fileName)} to become active`).catch((e) => {
    const active = vscode.window.activeTextEditor?.document.fileName;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    throw new Error(`${(e as Error).message}; active editor=${active ? path.basename(active) : 'none'}; active tab=${tab?.label} (${tab?.input?.constructor.name}); visible=${vscode.window.visibleTextEditors.map((ed) => `${path.basename(ed.document.fileName)}@${ed.viewColumn}`).join(',')}`);
  });
  return editor;
}

/** Put keyboard focus in the inspector webview (it opens beside the editor). */
async function focusPanel(): Promise<void> {
  await vscode.commands.executeCommand('vrun.openVariables');
  const isPanel = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview;
  await waitFor(() => isPanel(), 5000, 'webview tab to become the active tab');
}

function tests(): void {
  let c: VrunController;
  const ws = process.env.PYLIVE_IT_WORKSPACE!;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration('vrun');
    await config.update('pythonPath', process.env.PYLIVE_PYTHON, vscode.ConfigurationTarget.Global);
    // Opt-in panels used by the tests below.
    await config.update('features.visualizer', true, vscode.ConfigurationTarget.Global);
    await config.update('features.dataframe', true, vscode.ConfigurationTarget.Global);
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'vrun');
    assert.ok(ext, 'extension is installed in the dev host');
    c = (await ext.activate()) as VrunController;
  });

  suiteTeardown(async () => {
    await c?.kernel.stop();
  });

  test('all commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'vrun.startKernel', 'vrun.restartKernel', 'vrun.stopKernel', 'vrun.runSelection', 'vrun.runCell',
      'vrun.runFile', 'vrun.toggleLiveMode', 'vrun.openVariables', 'vrun.openDataFrame', 'vrun.interrupt',
      'vrun.visualize', 'vrun.toggleLiveVisualize', 'vrun.newPracticeFile',
    ]) {
      assert.ok(all.includes(id), `missing command ${id}`);
    }
  });

  test('Run File executes in a persistent kernel (command → kernel → result)', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'pandas_demo.py'));
    await showAndActivate(doc);
    let t = Date.now();
    await vscode.commands.executeCommand('vrun.startKernel');
    console.log(`      kernel start: ${Date.now() - t} ms`);
    t = Date.now();
    await vscode.commands.executeCommand('vrun.runFile');
    console.log(`      run file (import pandas + 500k-row DataFrame): ${Date.now() - t} ms`);
    // The variables refresh that follows every run may still be in flight.
    await waitFor(() => c.kernel.status === 'idle', 10000, 'idle');
    const list = await c.kernel.request<VariablesList>('variables.list');
    const df = list.variables.find((v) => v.name === 'df');
    assert.deepEqual(df?.shape, [500000, 2]);
    // Persistence: a new execution reuses df without re-running the file.
    const r = await c.kernel.request<ExecuteResult>('execute', { code: 'df["Quantity"].median()' });
    assert.equal(r.status, 'ok');
    assert.equal(r.value?.repr, '24.5'); // NumPy scalars are shown as plain numbers
  });

  test('Run Cell runs only the cell under the cursor', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(ws, 'dsa_demo.py'));
    const editor = await showAndActivate(doc);
    const line = doc.getText().split('\n').findIndex((l) => l.startsWith('nums = '));
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('vrun.runCell');
    const list = await c.kernel.request<VariablesList>('variables.list');
    const names = list.variables.map((v) => v.name);
    assert.ok(names.includes('nums') && names.includes('mid'));
    assert.ok(!names.includes('graph'), 'other cells must not run');
  });

  test('Visualize traces without changing kernel variables', async () => {
    const before = await c.kernel.request<VariablesList>('variables.list');
    await vscode.commands.executeCommand('vrun.visualize');
    const after = await c.kernel.request<VariablesList>('variables.list');
    assert.equal(after.revision, before.revision);
  });

  test('Live Mode works when toggled from the inspector panel (editor not focused)', async () => {
    const file = path.join(ws, 'live_demo.py');
    fs.writeFileSync(file, 'live_value = 1\n');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    // The user clicks the Live button in the inspector, so the webview tab is
    // active. (VS Code still reports the visible Python editor as active;
    // the button -> command mapping itself is covered by a unit test.)
    await focusPanel();
    await vscode.commands.executeCommand('vrun.toggleLiveMode');
    assert.equal(c.liveState(doc.uri).live, true, 'Live Mode must turn on for the last Python editor');
    // Editing re-runs the cell automatically after the debounce.
    await editor.edit((e) => e.replace(new vscode.Range(0, 0, 0, doc.lineAt(0).text.length), 'live_value = 41 + 1'));
    await waitFor(async () => {
      const r = await c.kernel.request<ExecuteResult>('execute', { code: "globals().get('live_value')" });
      return r.value?.repr === '42';
    }, 15000, 'live re-run');
    await focusPanel();
    await vscode.commands.executeCommand('vrun.toggleLiveMode');
    assert.equal(c.liveState(doc.uri).live, false);
    // Run File from the panel also targets that editor.
    await c.kernel.request<ExecuteResult>('execute', { code: 'live_value = 0' });
    await vscode.commands.executeCommand('vrun.runFile');
    const r = await c.kernel.request<ExecuteResult>('execute', { code: 'live_value' });
    assert.equal(r.value?.repr, '42');
    await doc.save();
  });

  test('Live Mode on a pandas file reads the data once, then reuses it', async () => {
    const csv = path.join(ws, 'sales.csv').replace(/\\/g, '/');
    fs.writeFileSync(csv, 'v\n1\n2\n3\n');
    const file = path.join(ws, 'pandas_live.py');
    fs.writeFileSync(file, `import pandas as pd\ndf = pd.read_csv("${csv}")\ntotal = df["v"].sum()\n`);
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    // Turning Live on runs once right away (and starts the kernel if needed).
    await vscode.commands.executeCommand('vrun.toggleLiveMode');
    const totalIs = (expected: string) => async () => {
      const r = await c.kernel.request<ExecuteResult>('execute', { code: "globals().get('total')" });
      return r.value?.repr === expected;
    };
    await waitFor(totalIs('6'), 15000, 'first live run');
    // If Live re-read the file now, it would fail: the file is gone.
    fs.unlinkSync(csv);
    await editor.edit((e) => e.replace(doc.lineAt(2).range, 'total = df["v"].sum() * 10'));
    await waitFor(totalIs('60'), 15000, 'live re-run without re-reading');
    await vscode.commands.executeCommand('vrun.toggleLiveMode');
    await doc.save();
  });

  test('a DataFrame result is shown inline by its shape, not a squeezed table', async () => {
    const file = path.join(ws, 'df_inline.py');
    fs.writeFileSync(file, 'import pandas as pd\npd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]})\n');
    const doc = await vscode.workspace.openTextDocument(file);
    await showAndActivate(doc);
    await vscode.commands.executeCommand('vrun.runFile');
    assert.deepEqual([...c.inlineNotes(doc)], [[1, 'DataFrame 3 × 2']]);
  });

  test('Live Visualize re-traces when the program input (.in) changes', async () => {
    const file = path.join(ws, 'judge.py');
    const input = path.join(ws, 'judge.in');
    fs.writeFileSync(file, 'n = int(input())\nnums = list(map(int, input().split()))\ntotal = sum(nums[:n])\n');
    fs.writeFileSync(input, '2\n5 7 9\n');
    const doc = await vscode.workspace.openTextDocument(file);
    await showAndActivate(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('vrun.toggleLiveVisualize');
    const totalInTrace = () => {
      const t = c.lastTrace;
      if (!t || t.uri.toString() !== doc.uri.toString() || !t.result.steps.length) return undefined;
      const locals = new Map(t.result.steps[t.result.steps.length - 1].stack[0].locals);
      return locals.get('total');
    };
    const describeTrace = () => {
      const t = c.lastTrace;
      return t
        ? `last trace: ${path.basename(t.uri.fsPath)} steps=${t.result.steps.length} status=${t.result.status} error=${t.result.error?.ename}:${t.result.error?.evalue} stdout=${JSON.stringify(t.result.stdout)}`
        : 'no trace';
    };
    await waitFor(() => totalInTrace() === 12, 15000, 'trace with the first input').catch((e) => {
      throw new Error(`${(e as Error).message}; ${describeTrace()}; liveViz=${c.liveState(doc.uri).liveViz}`);
    });
    // Editing the .in file (unsaved) re-traces with the new input.
    const inDoc = await vscode.workspace.openTextDocument(input);
    const inEditor = await showAndActivate(inDoc, vscode.ViewColumn.One);
    await inEditor.edit((e) => e.replace(new vscode.Range(0, 0, 0, 1), '3'));
    await waitFor(() => totalInTrace() === 21, 15000, 'trace with the edited input');
    await showAndActivate(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('vrun.toggleLiveVisualize');
    await inDoc.save();
  });

  test('inline results are quiet and disappear when their line is edited', async () => {
    const file = path.join(ws, 'inline_demo.py');
    fs.writeFileSync(file, 'x = 1\nprint(x)\nx + 1\n');
    const doc = await vscode.workspace.openTextDocument(file);
    // Same group as the inspector on purpose: running must not cover the file.
    const editor = await showAndActivate(doc);
    await vscode.commands.executeCommand('vrun.runFile');
    assert.ok(vscode.window.visibleTextEditors.some((ed) => ed.document === doc), 'the edited file stays visible');
    // Only the value of the final expression (on its own line), no "✓ [n] ms" noise.
    assert.deepEqual([...c.inlineNotes(doc)], [[2, '2']]);
    // Editing the line removes its note at once.
    await editor.edit((e) => e.insert(new vscode.Position(2, 5), '0'));
    assert.equal(c.inlineNotes(doc).size, 0);
    // Live Mode with a half-typed statement says nothing in the editor.
    await vscode.commands.executeCommand('vrun.toggleLiveMode');
    await editor.edit((e) => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), 'for i in range(3)\n'));
    await sleep(2500); // debounce + live run
    assert.equal(c.inlineNotes(doc).size, 0);
    await vscode.commands.executeCommand('vrun.toggleLiveMode');
    // And the clear command removes everything.
    await editor.edit((e) => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), '40 + 2\n'));
    await vscode.commands.executeCommand('vrun.runFile');
    assert.equal(c.inlineNotes(doc).size, 1);
    await vscode.commands.executeCommand('vrun.clearInlineResults');
    assert.equal(c.inlineNotes(doc).size, 0);
    await doc.save();
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
    await vscode.commands.executeCommand('vrun.interrupt');
    const r = await p;
    assert.equal(r.interrupted, 'interrupted');
    const again = await c.kernel.request<ExecuteResult>('execute', { code: 'i > 0' });
    assert.equal(again.value?.repr, 'True');
  });

  test('restart invalidates old sessions and variables', async () => {
    const old = c.kernel.session;
    await vscode.commands.executeCommand('vrun.restartKernel');
    assert.notEqual(c.kernel.session, old);
    await assert.rejects(c.kernel.request('variables.inspect', { name: 'df', session: old }), /previous kernel session/);
    const r = await c.kernel.request<ExecuteResult>('execute', { code: "'df' in globals()" });
    assert.equal(r.value?.repr, 'False');
  });

  test('stop terminates the kernel process', async () => {
    const pid = c.kernel.info?.pid;
    await vscode.commands.executeCommand('vrun.stopKernel');
    assert.equal(c.kernel.status, 'stopped');
    assert.ok(pid);
    await sleep(300);
    assert.throws(() => process.kill(pid!, 0), 'kernel process must be gone');
  });
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  suite('vrun (Extension Development Host)', tests);
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
