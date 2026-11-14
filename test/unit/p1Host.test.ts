/** Cell lenses, cell commands and their package.json contributions (P1 host track). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_PRELUDE_CHARS,
  cellLensSpots,
  cellsAbove,
  jupyterLensesShown,
  lensLine,
  nextCellLine,
  preludeFor,
  shouldShowJupyterNotice,
} from '../../src/ui/cellLensModel';
import { statementAt } from '../../src/ui/statements';
import { validateWebviewMessage } from '../../src/ui/validate';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

describe('cell lens positions', () => {
  it('a file without # %% markers gets no lenses', () => {
    assert.deepEqual(cellLensSpots('x = 1\nprint(x)\n'), []);
  });

  it('one lens per marker line; Run Above only where code is above', () => {
    const src = ['# %% setup', 'def f(n):', '    return n', '# %% use', 'f(3)', '# %%'].join('\n');
    const spots = cellLensSpots(src);
    assert.deepEqual(spots.map((s) => [s.line, s.hasCodeAbove]), [[0, false], [3, true], [5, true]]);
  });

  it('code before the first marker gets a lens on line 0', () => {
    const spots = cellLensSpots('import heapq\n\n# %% two\nx = 2\n');
    assert.deepEqual(spots.map((s) => [s.line, s.hasCodeAbove]), [[0, false], [2, true]]);
  });

  it('a comment-only header gets no lens (running it does nothing)', () => {
    const src = '# Practice: sorting\n# Run each cell with Ctrl+Alt+C\n\n# %% bubble sort\nnums = [3, 1]\n# %% next\nprint(nums)';
    const spots = cellLensSpots(src);
    assert.deepEqual(spots.map((s) => [s.line, s.hasCodeAbove]), [[3, false], [5, true]]);
  });

  it('works with CRLF line ends', () => {
    assert.deepEqual(cellLensSpots('a = 1\r\n# %%\r\nb = a\r\n').map((s) => s.line), [0, 1]);
  });
});

describe('cells above / next cell / prelude', () => {
  const src = [
    '# %% setup', // 0
    'def hanoi(n):', // 1
    '    return 0 if n == 0 else 2 * hanoi(n - 1) + 1', // 2
    '# %% notes', // 3
    '# only a comment', // 4
    '# %% try it', // 5
    'print(hanoi(3))', // 6
    '# %%', // 7
  ].join('\n');

  it('Run Above: the cells before the current one, in order, skipping comment-only cells', () => {
    assert.deepEqual(cellsAbove(src, 6).map((c) => c.startLine), [0]);
    assert.deepEqual(cellsAbove(src, 7).map((c) => c.startLine), [0, 5]);
    assert.deepEqual(cellsAbove(src, 1), []);
    // The marker line itself belongs to its cell.
    assert.deepEqual(cellsAbove(src, 5).map((c) => c.startLine), [0]);
  });

  it('Run and go to next cell: the first body line of the next cell', () => {
    assert.equal(nextCellLine(src, 1), 4);
    assert.equal(nextCellLine(src, 5), 7); // the next cell is only its marker
    assert.equal(nextCellLine(src, 7), undefined); // last cell: stay
    assert.equal(nextCellLine('x = 1\ny = 2', 0), undefined); // no markers: one cell
  });

  it('prelude: every line above the traced cell, nothing for the first cell', () => {
    assert.equal(preludeFor(src, 5), src.split('\n').slice(0, 5).join('\n'));
    assert.equal(preludeFor(src, 0), undefined);
    assert.equal(preludeFor('# header\n\n# %%\nx = 1', 2), undefined, 'comments only: nothing to bring along');
    assert.equal(preludeFor('a = 1\r\n# %%\r\nb = a', 1), 'a = 1', 'CRLF is not sent');
    const big = `x = "${'a'.repeat(MAX_PRELUDE_CHARS)}"\n# %%\nprint(x)`;
    assert.equal(preludeFor(big, 1), undefined, 'too long: left out rather than cut mid-statement');
  });
});

describe('a lens clicked before VS Code redraws it', () => {
  it('re-finds its marker by text after lines were added or removed above', () => {
    const src = ['# %% one', 'a = 1', 'b = 2', 'c = 3', '# %% two', 'd = 4'].join('\n');
    assert.equal(lensLine(src, 4, '# %% two'), 4, 'nothing moved');
    // The lens on "# %% two" was drawn at line 2, then two lines were typed above it.
    assert.equal(lensLine(src, 2, '# %% two'), 4);
    // Drawn at line 5, then a line above it was deleted.
    assert.equal(lensLine(src, 5, '# %% two'), 4);
  });

  it('bare "# %%" markers: the nearest, the one below on a tie', () => {
    const src = ['# %%', 'a = 1', '# %%', 'b = 2', '# %%', 'c = 3'].join('\n');
    assert.equal(lensLine(src, 3, '# %%'), 4);
    assert.equal(lensLine(src, 1, '# %%'), 2);
  });

  it('keeps the old line when the marker text is gone or is not a marker', () => {
    const src = ['# %% renamed', 'a = 1'].join('\n');
    assert.equal(lensLine(src, 1, '# %% old'), 1);
    assert.equal(lensLine('a = 1\nb = 2', 1, 'a = 1'), 1);
  });
});

describe('Shift+Enter in a file without # %% cells: the statement at the cursor', () => {
  const src = [
    '"""Lesson 3', // 0
    'print(x) in here is text', // 1
    '"""', // 2
    'import math', // 3
    '', // 4
    '@staticmethod', // 5
    'def area(r):', // 6
    '    # a comment', // 7
    '    return math.pi * r ** 2', // 8
    '', // 9
    '# loop', // 10
    'for i in range(3):', // 11
    '    if i:', // 12
    '        print(i)', // 13
    'else:', // 14
    '    done = (', // 15
    ')', // 16
    'data = [', // 17
    '    1, 2,', // 18
    ']', // 19
    'total = 1 + \\', // 20
    '    2', // 21
    "s = 'a \\", // 22
    "b'", // 23
    '# end', // 24
  ].join('\n');
  const at = (line: number) => {
    const st = statementAt(src, line);
    return st && [st.startLine, st.endLine, st.nextLine];
  };

  it('a whole def, for/else or bracketed statement, wherever the cursor is in it', () => {
    assert.deepEqual(at(6), [5, 8, 11], 'the decorator belongs to its def');
    assert.deepEqual(at(5), [5, 8, 11]);
    assert.deepEqual(at(8), [5, 8, 11]);
    assert.deepEqual(at(13), [11, 16, 17], 'else and the bracket closing at column 0 continue the for');
    assert.deepEqual(at(18), [17, 19, 20]);
    assert.deepEqual(at(21), [20, 21, 22], 'backslash continuation');
    assert.deepEqual(at(23), [22, 23, undefined], 'escaped newline in a string');
  });

  it('a multi-line string is one statement, even with code-like lines inside', () => {
    assert.deepEqual(at(1), [0, 2, 3]);
    assert.equal(statementAt(src, 3)?.text, 'import math');
  });

  it('between statements the next one runs; after the last, nothing', () => {
    assert.deepEqual(at(4), [5, 8, 11]);
    assert.deepEqual(at(10), [11, 16, 17]);
    assert.equal(statementAt(src, 24), undefined);
    assert.equal(statementAt('# only comments\n\n', 0), undefined);
  });

  it('an indented snippet: its least indent counts as top level', () => {
    const snippet = ['    x = 1', '    if x:', '        y = 2', '    z = 3'].join('\n');
    const st = statementAt(snippet, 2);
    assert.deepEqual(st && [st.startLine, st.endLine, st.nextLine], [1, 2, 3]);
  });

  it('CRLF files', () => {
    assert.deepEqual(statementAt('a = 1\r\nb = (\r\n  2)\r\n', 2), { startLine: 1, endLine: 2, text: 'b = (\n  2)', nextLine: undefined });
  });
});

describe('Jupyter notice', () => {
  const j = { installed: true, active: true, codeLensEnabled: true };
  it('shows once, only while Jupyter is active and its lenses are on', () => {
    assert.equal(shouldShowJupyterNotice(j, false), true);
    assert.equal(shouldShowJupyterNotice(j, true), false);
    assert.equal(shouldShowJupyterNotice({ ...j, active: false }, false), false);
    assert.equal(shouldShowJupyterNotice({ ...j, codeLensEnabled: false }, false), false);
    assert.equal(shouldShowJupyterNotice({ installed: false, active: false, codeLensEnabled: true }, false), false);
  });
  it("labels vrun's lens when Jupyter's is also drawn", () => {
    assert.equal(jupyterLensesShown(j), true);
    assert.equal(jupyterLensesShown({ ...j, codeLensEnabled: false }), false);
    assert.equal(jupyterLensesShown({ installed: false, active: false, codeLensEnabled: true }), false);
  });
});

describe('package.json contributions', () => {
  const commands = new Set((pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command));
  const props = pkg.contributes.configuration.properties as Record<string, { default: unknown }>;

  it('declares the new commands and settings', () => {
    for (const id of ['vrun.runCellAndAdvance', 'vrun.runCellsAbove', 'vrun.visualizeFile']) assert.ok(commands.has(id), id);
    assert.equal(props['vrun.codeLens'].default, true);
    assert.equal(props['vrun.shiftEnterRunsCell'].default, false);
  });

  // VS Code ranks extension keybindings by 400 + their index in the
  // extension's own list (later wins). Checked against Python 2026.10.0
  // (Shift+Enter: its 1st and 2nd) and Jupyter 2025.9.1 (Shift+Enter: 2nd,
  // Ctrl+Enter: 3rd, both gated only by `jupyter.hascodecells`). vrun's
  // keys therefore go last in its own list, which leaves room if they move.
  const kb = (pkg.contributes.keybindings as Array<{ command: string; key: string; when: string; mac?: string }>).map((k, i) => ({
    ...k,
    index: i + 1,
  }));
  const optIn = kb.filter((k) => k.when.startsWith('config.vrun.shiftEnterRunsCell'));

  it('Shift+Enter is opt-in, and wins over the Python and Jupyter extensions once on', () => {
    const shift = kb.filter((k) => k.key === 'shift+enter');
    assert.deepEqual(shift.map((k) => k.command).sort(), ['vrun.runCellAndAdvance', 'vrun.runSelection']);
    for (const k of shift) {
      assert.match(k.when, /^config\.vrun\.shiftEnterRunsCell && /);
      assert.match(k.when, /!suggestWidgetVisible/, 'Shift+Enter in the suggest widget stays VS Code’s');
      assert.ok(k.index > 2, `${k.command} is keybinding #${k.index}`);
    }
  });

  it("Ctrl+Enter is taken from Jupyter only, under the same opt-in", () => {
    const ctrl = kb.filter((k) => k.key === 'ctrl+enter');
    assert.deepEqual(ctrl.map((k) => k.command), ['vrun.runCell']);
    const [k] = ctrl;
    assert.match(k.when, /^config\.vrun\.shiftEnterRunsCell && /);
    // Without Jupyter's cells the key stays VS Code's "insert line below".
    assert.match(k.when, /&& jupyter\.hascodecells &&/);
    assert.match(k.when, /!editorHasSelection/);
    assert.match(k.when, /!suggestWidgetVisible/);
    // Jupyter binds plain ctrl+enter on macOS too; a cmd+enter override would miss it.
    assert.equal(k.mac, undefined);
    assert.ok(k.index > 3, `${k.command} is keybinding #${k.index}`);
  });

  it("vrun's opt-in keys are the last entries of its own list", () => {
    assert.deepEqual(
      optIn.map((k) => k.index),
      Array.from({ length: optIn.length }, (_, i) => kb.length - optIn.length + 1 + i),
    );
  });

  it('the inspector may ask to visualize the whole file', () => {
    assert.deepEqual(validateWebviewMessage({ type: 'command', command: 'visualizeFile' }), { type: 'command', command: 'visualizeFile' });
  });
});
