/** Unit tests for VS Code-independent modules (node:test). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cellAt, dedent, splitCells } from '../../src/exec/cells';
import { LiveScheduler } from '../../src/exec/liveScheduler';
import { inputPathFor, isInputOf } from '../../src/exec/programInput';
import { parseWorkerLine } from '../../src/kernel/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEBVIEW_COMMANDS, WEBVIEW_COMMAND_IDS, validateWebviewMessage } from '../../src/ui/validate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cells', () => {
  const src = ['import pandas as pd', '# %% load', 'df = 1', '# %% [live] stats', 'df + 1', '# %%', '# pylive: manual', 'model.fit(X)'].join('\n');

  it('splits on # %% markers and keeps a leading cell', () => {
    const cells = splitCells(src);
    assert.equal(cells.length, 4);
    assert.deepEqual(cells.map((c) => [c.startLine, c.endLine]), [[0, 0], [1, 2], [3, 4], [5, 7]]);
  });

  it('detects live and manual markers', () => {
    const cells = splitCells(src);
    assert.equal(cells[2].live, true);
    assert.equal(cells[2].title, 'stats');
    assert.equal(cells[3].manual, true);
    assert.equal(cells[1].live, false);
  });

  it('whole file is one cell without markers', () => {
    const c = splitCells('a = 1\nb = 2');
    assert.equal(c.length, 1);
    assert.equal(cellAt('a = 1\nb = 2', 1)?.text, 'a = 1\nb = 2');
  });

  it('dedents selections from inside blocks', () => {
    assert.equal(dedent('    x = 1\n      y = 2\n\n    z'), 'x = 1\n  y = 2\n\nz');
  });
});

describe('LiveScheduler', () => {
  it('debounces bursts into one run with the latest generation', async () => {
    const s = new LiveScheduler(() => 30);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) s.schedule('k', async (g) => void runs.push(g));
    await sleep(80);
    assert.deepEqual(runs, [5]);
  });

  it('coalesces edits during a run into exactly one follow-up', async () => {
    const s = new LiveScheduler(() => 10);
    const runs: number[] = [];
    const runner = async (g: number) => {
      runs.push(g);
      await sleep(60);
    };
    s.schedule('k', runner);
    await sleep(25); // first run in flight
    s.schedule('k', runner);
    await sleep(15);
    s.schedule('k', runner);
    await sleep(200);
    assert.equal(runs.length, 2);
    assert.equal(runs[1], 3);
  });

  it('isCurrent detects stale generations', async () => {
    const s = new LiveScheduler(() => 5);
    const g1 = s.schedule('k', async () => undefined);
    const g2 = s.schedule('k', async () => undefined);
    assert.equal(s.isCurrent('k', g1), false);
    assert.equal(s.isCurrent('k', g2), true);
    s.cancel('k');
    assert.equal(s.isCurrent('k', g2), false);
  });
});

describe('protocol parsing', () => {
  it('accepts responses and events', () => {
    assert.equal(parseWorkerLine('{"type":"response","id":1,"ok":true,"result":2}')?.type, 'response');
    assert.equal(parseWorkerLine('{"type":"event","event":"ready","session":"x"}')?.type, 'event');
  });
  it('rejects malformed messages', () => {
    assert.equal(parseWorkerLine('not json'), undefined);
    assert.equal(parseWorkerLine('{"type":"response","id":1,"ok":false}'), undefined);
    assert.equal(parseWorkerLine('{"type":"response","id":{},"ok":true}'), undefined);
    assert.equal(parseWorkerLine('[1,2]'), undefined);
  });
});

describe('webview buttons', () => {
  it('every button maps to a command contributed in package.json', () => {
    // Regression: the Live button sent "pylive.toggleLive", which does not exist.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const contributed = new Set((pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command));
    for (const name of WEBVIEW_COMMANDS) {
      assert.ok(contributed.has(WEBVIEW_COMMAND_IDS[name]), `${name} -> ${WEBVIEW_COMMAND_IDS[name]}`);
    }
  });
});

describe('webview message validation', () => {
  it('accepts allowlisted commands only', () => {
    assert.deepEqual(validateWebviewMessage({ type: 'command', command: 'runCell' }), { type: 'command', command: 'runCell' });
    assert.equal(validateWebviewMessage({ type: 'command', command: 'rm -rf /' }), undefined);
    assert.equal(validateWebviewMessage({ type: 'execute', code: 'import os' }), undefined);
  });

  it('validates DataFrame page parameters', () => {
    const ok = validateWebviewMessage({ type: 'dfPage', requestId: 1, name: 'df', revision: 3, offset: 0, limit: 50, colOffset: 0, colLimit: 50, sort: { column: 2, ascending: false }, filter: { column: 1, op: 'gt', value: '5' } });
    assert.ok(ok && ok.type === 'dfPage' && ok.sort?.column === 2 && ok.filter?.op === 'gt');
    const bad = [
      { limit: 100000 },
      { offset: -1 },
      { name: "df'); import os #" },
      { name: '__import__("os")' },
      { sort: { column: 'x', ascending: true } },
      { filter: { column: 1, op: 'eval', value: '1' } },
      { filter: { column: 1, op: 'eq' } },
      { offset: 1.5 },
    ];
    for (const b of bad) {
      const msg = { type: 'dfPage', requestId: 1, name: 'df', revision: 0, offset: 0, limit: 50, colOffset: 0, colLimit: 50, ...b };
      assert.equal(validateWebviewMessage(msg), undefined, JSON.stringify(b));
    }
  });

  it('isnull filter needs no value', () => {
    const m = validateWebviewMessage({ type: 'dfPage', requestId: 1, name: 'df', revision: 0, offset: 0, limit: 5, colOffset: 0, colLimit: 5, filter: { column: 0, op: 'isnull', value: 'ignored' } });
    assert.ok(m && m.type === 'dfPage' && m.filter && !('value' in m.filter));
  });

  it('rejects non-objects and unknown types', () => {
    for (const raw of [null, 1, 'x', [], { type: 'nope' }, { type: 'copy', text: 5 }, { type: 'traceStep', line: 0 }]) {
      assert.equal(validateWebviewMessage(raw), undefined);
    }
  });
});

describe('program input paths', () => {
  it('maps solution.py to solution.in next to it', () => {
    assert.equal(inputPathFor(join('a', 'b', 'solution.py')), join('a', 'b', 'solution.in'));
    assert.equal(inputPathFor(join('a', 'run')), join('a', 'run.in'));
    assert.ok(isInputOf(join('a', 'solution.in'), join('a', 'solution.py')));
    assert.ok(!isInputOf(join('a', 'other.in'), join('a', 'solution.py')));
  });
});
