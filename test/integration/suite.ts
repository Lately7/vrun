/** Integration tests executed inside the Extension Development Host. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { VrunController } from '../../src/controller';
import type { ExecuteResult, RequestType, TraceStep, VariablesList } from '../../src/kernel/protocol';

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

/** vrun's CodeLenses on a document, or undefined when there are none. */
async function vrunLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[] | undefined> {
  const all = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri, 50);
  const ours = (all ?? []).filter((l) => l.command?.command.startsWith('vrun.'));
  return ours.length ? ours : undefined;
}

/** [line, commands] per line, in line order. */
function lensSummary(lenses: vscode.CodeLens[]): Array<[number, string[]]> {
  const byLine = new Map<number, string[]>();
  for (const l of lenses) {
    const line = l.range.start.line;
    byLine.set(line, [...(byLine.get(line) ?? []), l.command!.command]);
  }
  return [...byLine].sort((a, b) => a[0] - b[0]);
}

/** Value of a module-level variable at the last step that has it. */
function moduleValue(steps: TraceStep[], name: string): unknown {
  for (let i = steps.length - 1; i >= 0; i--) {
    const top = steps[i].stack[0];
    if (typeof top === 'object') {
      const hit = top.locals.find(([n]) => n === name);
      if (hit) return hit[1];
    }
  }
  return undefined;
}

/** VS Code's fsPath writes the drive letter in lower case. */
function sameDir(a: unknown, b: string): boolean {
  return typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function tests(): void {
  let c: VrunController;
  const ws = process.env.PYLIVE_IT_WORKSPACE!;

  /** repr of a global in the kernel ('None' when it is not defined). */
  async function globalRepr(name: string): Promise<string> {
    const r = await c.kernel.request<ExecuteResult>('execute', { code: `globals().get(${JSON.stringify(name)})` });
    return r.value?.repr ?? (r.status === 'ok' ? 'None' : `<${r.status}>`);
  }

  /** The requests the extension sends to the kernel while `fn` runs, with each response once it arrived. */
  async function recordRequests(fn: () => Thenable<unknown>): Promise<Array<[RequestType, Record<string, unknown>, unknown]>> {
    const kernel = c.kernel;
    const calls: Array<[RequestType, Record<string, unknown>, unknown]> = [];
    const original = kernel.request.bind(kernel);
    kernel.request = ((type: RequestType, params?: Record<string, unknown>, onId?: (id: number) => void) => {
      const call: [RequestType, Record<string, unknown>, unknown] = [type, params ?? {}, undefined];
      calls.push(call);
      const reply = original(type, params, onId);
      // Registered before the caller's await, so it is filled in when the command returns.
      void reply.then((r) => (call[2] = r), () => undefined);
      return reply;
    }) as typeof kernel.request;
    try {
      await fn();
    } finally {
      // The method lives on the prototype: removing the stub restores it.
      Reflect.deleteProperty(kernel, 'request');
    }
    return calls;
  }

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
      'vrun.runCellAndAdvance', 'vrun.runCellsAbove', 'vrun.visualizeFile',
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

  test('cell CodeLens: Run Cell | Run Above | Visualize on every # %% line', async () => {
    const file = path.join(ws, 'lens_cells.py');
    fs.writeFileSync(file, 'import math\n\n# %% setup\nlens_a = 1\n# %% use\nlens_b = lens_a + 1\n');
    const doc = await vscode.workspace.openTextDocument(file);
    await showAndActivate(doc);
    const lenses = await waitFor(() => vrunLenses(doc), 10000, 'cell lenses');
    // Code before the first marker gets a lens on line 0; the first cell has nothing above it.
    assert.deepEqual(lensSummary(lenses), [
      [0, ['vrun.runCell', 'vrun.visualize']],
      [2, ['vrun.runCell', 'vrun.runCellsAbove', 'vrun.visualize']],
      [4, ['vrun.runCell', 'vrun.runCellsAbove', 'vrun.visualize']],
    ]);
    // Clicking "Run Above" on the last cell runs the two cells above it, not the cell itself.
    await c.kernel.request<ExecuteResult>('execute', { code: "globals().pop('lens_a', None); globals().pop('lens_b', None)" });
    const above = lenses.find((l) => l.range.start.line === 4 && l.command?.command === 'vrun.runCellsAbove')!.command!;
    await vscode.commands.executeCommand(above.command, ...(above.arguments ?? []));
    assert.equal(await globalRepr('lens_a'), '1');
    assert.equal(await globalRepr('lens_b'), 'None');
    // "Run Cell" runs the cell it sits on, wherever the cursor is.
    const run = lenses.find((l) => l.range.start.line === 4 && l.command?.command === 'vrun.runCell')!.command!;
    await vscode.commands.executeCommand(run.command, ...(run.arguments ?? []));
    assert.equal(await globalRepr('lens_b'), '2');
    // Clicked after lines were added above it, before VS Code redrew the
    // lenses: the lens still carries line 4, which now lies in the cell above.
    await c.kernel.request<ExecuteResult>('execute', { code: "globals().pop('lens_b', None)" });
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc)!;
    await editor.edit((e) => e.insert(new vscode.Position(4, 0), 'lens_c = 0\nlens_d = 0\n'));
    try {
      await vscode.commands.executeCommand(run.command, ...(run.arguments ?? []));
      assert.equal(await globalRepr('lens_b'), '2', 'the stale lens ran the cell it sits on');
      assert.equal(await globalRepr('lens_c'), 'None', 'not the cell above it');
    } finally {
      await editor.edit((e) => e.delete(new vscode.Range(4, 0, 6, 0)));
      await doc.save();
    }
    // The setting turns them off.
    const config = vscode.workspace.getConfiguration('vrun');
    await config.update('codeLens', false, vscode.ConfigurationTarget.Global);
    try {
      await waitFor(async () => ((await vrunLenses(doc)) ? undefined : true), 10000, 'lenses to go away');
    } finally {
      await config.update('codeLens', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('Run Cells Above runs the cells above in order and stops at the first error', async () => {
    const file = path.join(ws, 'above_cells.py');
    fs.writeFileSync(file, '# %% one\nabove_a = 1\n# %% two\nabove_b = above_a + 1\n# %% three\nabove_c = above_b + 1\n');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    editor.selection = new vscode.Selection(5, 0, 5, 0);
    await vscode.commands.executeCommand('vrun.runCellsAbove');
    assert.deepEqual([await globalRepr('above_a'), await globalRepr('above_b'), await globalRepr('above_c')], ['1', '2', 'None']);

    const errFile = path.join(ws, 'above_error.py');
    fs.writeFileSync(errFile, '# %%\nstop_a = 1\nraise ValueError("bad data")\n# %%\nstop_b = 2\n# %%\nstop_c = 3\n');
    const errDoc = await vscode.workspace.openTextDocument(errFile);
    const errEditor = await showAndActivate(errDoc);
    errEditor.selection = new vscode.Selection(6, 0, 6, 0);
    await vscode.commands.executeCommand('vrun.runCellsAbove');
    assert.deepEqual([await globalRepr('stop_a'), await globalRepr('stop_b')], ['1', 'None'], 'the cell after the error must not run');
  });

  test('Run Cell and Go to Next Cell runs the cell and moves the cursor into the next one', async () => {
    const file = path.join(ws, 'advance_cells.py');
    fs.writeFileSync(file, '# %% one\nadvance_a = 10\n# %% two\nadvance_b = advance_a * 2\n');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    editor.selection = new vscode.Selection(1, 3, 1, 3);
    await vscode.commands.executeCommand('vrun.runCellAndAdvance');
    assert.equal(editor.selection.active.line, 3, 'the cursor is on the first line of the next cell');
    assert.equal(await globalRepr('advance_a'), '10');
    assert.equal(await globalRepr('advance_b'), 'None', 'only the current cell ran');
    // On the last cell there is nowhere to go: it runs and the cursor stays.
    await vscode.commands.executeCommand('vrun.runCellAndAdvance');
    assert.equal(editor.selection.active.line, 3);
    assert.equal(await globalRepr('advance_b'), '20');
  });

  test('Run Cell and Go to Next Cell in a file without # %% runs one statement at a time', async () => {
    const file = path.join(ws, 'plain_steps.py');
    fs.writeFileSync(file, 'step_a = 1\ndef step_f(n):\n    return n + step_a\n\nstep_b = step_f(1)\n');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('vrun.runCellAndAdvance');
    assert.equal(editor.selection.active.line, 1);
    assert.equal(await globalRepr('step_a'), '1');
    assert.equal(await globalRepr('step_b'), 'None', 'not the whole file');
    // The whole def, then the cursor skips the blank line to the next statement.
    await vscode.commands.executeCommand('vrun.runCellAndAdvance');
    assert.equal(editor.selection.active.line, 4);
    assert.equal(await globalRepr('step_b'), 'None');
    await vscode.commands.executeCommand('vrun.runCellAndAdvance');
    assert.equal(editor.selection.active.line, 4, 'the last statement: the cursor stays');
    assert.equal(await globalRepr('step_b'), '2');
  });

  test('Visualize on a cell brings the cells above (prelude); Visualize File traces the whole file', async () => {
    const file = path.join(ws, 'viz_cells.py');
    const src = '# %% setup\ndef double(n):\n    return n * 2\n\n# %% use\nviz_total = double(21)\n';
    fs.writeFileSync(file, src);
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    editor.selection = new vscode.Selection(5, 0, 5, 0);
    const calls = await recordRequests(() => vscode.commands.executeCommand('vrun.visualize'));
    const trace = calls.find(([type]) => type === 'trace')?.[1];
    assert.ok(trace, 'a trace request was sent');
    assert.equal(trace.code, '# %% use\nviz_total = double(21)\n');
    assert.equal(trace.prelude, '# %% setup\ndef double(n):\n    return n * 2\n');
    assert.ok(sameDir(trace.cwd, ws), `trace cwd ${String(trace.cwd)}`);
    const t = c.lastTrace!;
    assert.equal(t.uri.toString(), doc.uri.toString());
    assert.equal(t.result.error, null, `cell trace failed: ${t.result.error?.ename}: ${t.result.error?.evalue}`);
    assert.equal(moduleValue(t.result.steps, 'viz_total'), 42);
    const traceNotes: unknown = t.result.notes;

    // The whole document, although the cursor is in the second cell.
    const fileCalls = await recordRequests(() => vscode.commands.executeCommand('vrun.visualizeFile'));
    const whole = fileCalls.find(([type]) => type === 'trace')?.[1];
    assert.equal(whole?.code, src);
    assert.equal(whole?.prelude, undefined);
    assert.equal(moduleValue(c.lastTrace!.result.steps, 'viz_total'), 42);
    assert.ok(c.lastTrace!.result.steps.some((s) => s.line === 3), 'the trace steps into double() from the first cell');

    // The panel's "Visualize whole file" button means the traced file, even
    // after the learner moved on to another Python file.
    const otherFile = path.join(ws, 'viz_other.py');
    fs.writeFileSync(otherFile, 'viz_other = 1\n');
    await showAndActivate(await vscode.workspace.openTextDocument(otherFile));
    const fromPanel = c as unknown as { onWebviewMessage(m: { type: 'command'; command: 'visualizeFile' }): Promise<void> };
    const buttonCalls = await recordRequests(() => fromPanel.onWebviewMessage({ type: 'command', command: 'visualizeFile' }));
    assert.equal(buttonCalls.find(([type]) => type === 'trace')?.[1].code, src, 'the button traced the file of the shown trace');
    assert.equal(c.lastTrace!.uri.toString(), doc.uri.toString());

    // Kernel side, checked last so a kernel regression does not hide the
    // host checks above: the cell trace's header names what came from the
    // cells above (C3), and notes are text (C2).
    assert.ok(Array.isArray(traceNotes) && traceNotes.every((n) => typeof n === 'string'), `trace notes must be strings: ${JSON.stringify(traceNotes)}`);
    assert.ok((traceNotes as string[]).some((n) => n.includes('cells above') && n.includes('double')), `prelude note: ${JSON.stringify(traceNotes)}`);
  });

  test('Run Cell finds a data file next to a script in another folder (working folder)', async () => {
    // The kernel was started from the workspace folder; lesson 2 lives in a subfolder.
    const dir = path.join(ws, 'lesson2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scores.csv'), 'name,score\nAn,9\nBinh,7\n');
    const file = path.join(dir, 'lesson.py');
    fs.writeFileSync(file, '# %%\nimport csv\nwith open("scores.csv", encoding="utf-8") as f:\n    lesson_rows = list(csv.DictReader(f))\nlesson_n = len(lesson_rows)\n');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await showAndActivate(doc);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    const calls = await recordRequests(() => vscode.commands.executeCommand('vrun.runCell'));
    const execCall = calls.find(([type]) => type === 'execute');
    const sent = execCall?.[1].cwd;
    assert.ok(sameDir(sent, dir), `execute cwd ${String(sent)}`);
    // Shown to the learner ("working folder: C:\..."): written like Explorer does, not fsPath's "c:".
    if (process.platform === 'win32') assert.match(String(sent), /^[A-Z]:\\/);
    assert.equal(await globalRepr('lesson_n'), '2');
    const notes: unknown = (execCall?.[2] as ExecuteResult | undefined)?.notes;
    // An unsaved buffer has no folder of its own: no cwd is sent.
    const untitled = await vscode.workspace.openTextDocument({ language: 'python', content: 'untitled_x = 1\n' });
    await showAndActivate(untitled);
    const uCalls = await recordRequests(() => vscode.commands.executeCommand('vrun.runCell'));
    const exec = uCalls.find(([type]) => type === 'execute')?.[1];
    assert.ok(exec && !('cwd' in exec), 'untitled buffers send no cwd');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    // A trace follows the same folder: back in the workspace folder first
    // (a run of a file there), then Visualize lesson 2.
    const home = path.join(ws, 'home_cell.py');
    fs.writeFileSync(home, 'home_x = 1\n');
    await showAndActivate(await vscode.workspace.openTextDocument(home));
    await vscode.commands.executeCommand('vrun.runCell');
    assert.equal(await globalRepr('home_x'), '1');
    // A JSON string is a valid Python literal for the path.
    const atHome = await c.kernel.request<ExecuteResult>('execute', { code: `__import__("os").path.samefile(__import__("os").getcwd(), ${JSON.stringify(ws)})` });
    assert.equal(atHome.value?.repr, 'True', 'the run moved the kernel back to the workspace folder');
    const lessonEditor = await showAndActivate(doc);
    lessonEditor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('vrun.visualize');
    const tr = c.lastTrace!;
    assert.equal(tr.uri.toString(), doc.uri.toString());
    assert.equal(tr.result.error, null, `lesson 2 trace failed: ${tr.result.error?.ename}: ${tr.result.error?.evalue}`);
    assert.equal(moduleValue(tr.result.steps, 'lesson_n'), 2);
    // Kernel side, checked last: it says where it now works (C1/C2). The
    // Output tab renders each note as a paragraph, so a note that is not
    // text blanks the whole run there.
    assert.ok(Array.isArray(notes) && notes.every((n) => typeof n === 'string'), `run notes must be strings: ${JSON.stringify(notes)}`);
    const moved = (notes as string[]).find((n) => n.startsWith('working folder: '));
    assert.ok(moved && sameDir(moved.slice('working folder: '.length), dir), `working-folder note: ${JSON.stringify(notes)}`);
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
      // A module-level last step: its stack is the module frame alone (the
      // top frame is always sent in full).
      const top = t.result.steps[t.result.steps.length - 1].stack[0];
      return typeof top === 'number' ? undefined : new Map(top.locals).get('total');
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
