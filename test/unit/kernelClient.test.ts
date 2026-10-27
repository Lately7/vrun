/**
 * KernelClient against a real Python worker. Set PYLIVE_PYTHON to the
 * interpreter to use (default: `python`).
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { KernelClient } from '../../src/kernel/kernelClient';
import { ExecuteResult, KernelRequestError, KernelStatus, TraceResult, VariablesList } from '../../src/kernel/protocol';

// Compiled to out/test/unit/, three levels below the repository root.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const opts = {
  pythonPath: process.env.PYLIVE_PYTHON || 'python',
  launcherPath: path.join(ROOT, 'python', 'launcher.py'),
  cwd: ROOT,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KernelClient (real Python)', () => {
  const k = new KernelClient();
  const statuses: KernelStatus[] = [];
  k.onStatus.on((s) => statuses.push(s));
  let stdout = '';
  k.onStream.on((e) => {
    if (e.name === 'stdout') stdout += e.text;
  });

  before(async () => {
    await k.start(opts);
  });
  after(async () => {
    await k.stop();
  });

  it('starts and reports idle with a session', () => {
    assert.equal(k.status, 'idle');
    assert.match(k.session ?? '', /^[0-9a-f]{16}$/);
    assert.ok(statuses.includes('starting'));
  });

  it('executes code, keeps variables, captures stdout', async () => {
    const r1 = await k.request<ExecuteResult>('execute', { code: 'nums = [3, 1, 2]\nprint("hi from python")' });
    assert.equal(r1.status, 'ok');
    const r2 = await k.request<ExecuteResult>('execute', { code: 'sorted(nums)' });
    assert.equal(r2.value?.repr, '[1, 2, 3]');
    await sleep(50);
    assert.match(stdout, /hi from python/);
  });

  it('reports exceptions with the user line', async () => {
    const r = await k.request<ExecuteResult>('execute', { code: 'x = 1\ny = x / 0', file: 'demo.py', lineOffset: 9 });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.ename, 'ZeroDivisionError');
    assert.equal(r.error?.userFrame?.line, 11);
  });

  it('shows busy during execution and interrupts a long loop', async () => {
    let id = -1;
    const p = k.request<ExecuteResult>('execute', { code: 'while True:\n    pass' }, (i) => (id = i));
    await sleep(300);
    assert.equal(k.status, 'busy');
    const hit = await k.interrupt(id, 2000);
    assert.equal(hit, true);
    const r = await p;
    assert.equal(r.interrupted, 'interrupted');
    await sleep(20);
    assert.equal(k.status, 'idle');
  });

  it('inspects variables and validates handles', async () => {
    const list = await k.request<VariablesList>('variables.list');
    assert.ok(list.variables.some((v) => v.name === 'nums' && v.viz === 'array'));
    await assert.rejects(k.request('variables.inspect', { name: 'nums', session: 'deadbeefdeadbeef' }), (e: KernelRequestError) => e.code === 'stale_handle');
  });

  it('traces an algorithm without touching the namespace', async () => {
    const t = await k.request<TraceResult>('trace', { code: 'a = [2, 1]\na.sort()\nnums = None' });
    assert.ok(t.steps.length >= 3);
    const after = await k.request<ExecuteResult>('execute', { code: 'nums' });
    assert.equal(after.value?.repr, '[3, 1, 2]');
  });

  it('restart invalidates the old session and variables', async () => {
    const old = k.session;
    await k.restart(opts);
    assert.notEqual(k.session, old);
    const r = await k.request<ExecuteResult>('execute', { code: "'nums' in globals()" });
    assert.equal(r.value?.repr, 'False');
  });

  it('rejects pending requests when the process dies', async () => {
    const p = k.request<ExecuteResult>('execute', { code: 'import os, time\ntime.sleep(0.2)\nos._exit(3)' });
    await assert.rejects(p, (e: KernelRequestError) => e.code === 'kernel_exited');
    await sleep(50);
    assert.equal(k.status, 'crashed');
    await k.start(opts);
    assert.equal(k.status, 'idle');
  });

  it('fails clearly for a missing interpreter', async () => {
    const k2 = new KernelClient();
    await assert.rejects(k2.start({ ...opts, pythonPath: 'definitely-not-python-xyz' }), /Could not start Python|exited/);
  });
});
