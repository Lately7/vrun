/** Adversarial tests for the VS Code-independent TypeScript modules. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { dedent, hasCellMarkers, isCellMarker, splitCells } from '../../src/exec/cells';
import { LiveScheduler } from '../../src/exec/liveScheduler';
import { KernelClient } from '../../src/kernel/kernelClient';
import { KernelRequestError } from '../../src/kernel/protocol';
import { validateWebviewMessage } from '../../src/ui/validate';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let fixtureDir = '';
let fixturePath = '';

const FIXTURE = String.raw`
import json
import os
import sys
import time

mode = os.environ.get("PYLIVE_CODEX_FIXTURE", "normal")
out = sys.stdout.buffer

def encoded(message):
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"

def send(message):
    out.write(encoded(message))
    out.flush()

ready = {
    "type": "event",
    "event": "ready",
    "session": "0123456789abcdef",
    "pid": os.getpid(),
    "python": {"version": "fixture", "executable": sys.executable},
    "cwd": "hé😀",
}

if mode == "fragment":
    data = encoded(ready)
    marker = "😀".encode("utf-8")
    cut = data.index(marker) + 2
    out.write(data[:cut])
    out.flush()
    time.sleep(0.03)
    out.write(data[cut:])
    out.flush()
elif mode == "batch":
    messages = [
        {"type": "event", "event": "stream", "name": "stdout", "text": "a"},
        {"type": "event", "event": "stream", "name": "stdout", "text": "b"},
        {"type": "event", "event": "stream", "name": "stdout", "text": "c"},
        ready,
    ]
    out.write(b"".join(encoded(message) for message in messages))
    out.flush()
elif mode == "malformed_ready":
    send({"type": "event", "event": "ready"})
    time.sleep(0.5)
    send(ready)
else:
    send(ready)

for raw in sys.stdin.buffer:
    message = json.loads(raw)
    request_id = message["id"]
    request_type = message["type"]
    if mode == "crash" and request_type == "execute":
        os._exit(7)
    if request_type == "shutdown":
        if mode == "ignore_shutdown":
            continue
        send({"type": "response", "id": request_id, "ok": True, "result": {"bye": True}})
        sys.exit(0)
    if mode in ("hang", "ignore_shutdown") and request_type == "execute":
        continue
    response = {"type": "response", "id": request_id, "ok": True, "result": {"echo": request_type}}
    if mode == "unknown_id":
        out.write(encoded({"type": "response", "id": 999999, "ok": True, "result": "stray"}) + encoded(response))
        out.flush()
    else:
        send(response)
`;

before(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'pylive-codex-'));
  fixturePath = path.join(fixtureDir, 'fixture_worker.py');
  writeFileSync(fixturePath, FIXTURE, 'utf8');
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function launchOptions(mode: string) {
  return {
    pythonPath: process.env.PYLIVE_PYTHON || path.resolve('.venv', 'Scripts', 'python.exe'),
    launcherPath: fixturePath,
    cwd: process.cwd(),
    env: { ...process.env, PYLIVE_CODEX_FIXTURE: mode },
    startTimeoutMs: 2_000,
  };
}

async function withClient(mode: string, fn: (client: KernelClient) => Promise<void>): Promise<void> {
  const client = new KernelClient();
  try {
    await within(client.start(launchOptions(mode)));
    await fn(client);
  } finally {
    await client.stop(100);
  }
}

describe('KernelClient adversarial transport and lifecycle', () => {
  it('reassembles a protocol line split inside a multi-byte UTF-8 character', async () => {
    await withClient('fragment', async (client) => {
      assert.equal(client.info?.cwd, 'hé😀');
      assert.equal(client.session, '0123456789abcdef');
    });
  });

  it('processes many complete messages delivered in one stdout chunk', async () => {
    const client = new KernelClient();
    const text: string[] = [];
    client.onStream.on((event) => text.push(event.text));
    try {
      await within(client.start(launchOptions('batch')));
      assert.deepEqual(text, ['a', 'b', 'c']);
    } finally {
      await client.stop(100);
    }
  });

  it('ignores a response for an unknown id without losing the real response', async () => {
    await withClient('unknown_id', async (client) => {
      const result = await within(client.request<{ echo: string }>('ping'));
      assert.deepEqual(result, { echo: 'ping' });
      assert.equal(client.workload, 0);
      assert.equal(client.status, 'idle');
    });
  });

  it('stop rejects a pending request instead of leaving it hung', async () => {
    const client = new KernelClient();
    await client.start(launchOptions('hang'));
    const request = client.request('execute');
    const rejected = assert.rejects(within(request), (error: KernelRequestError) => error.code === 'kernel_exited');
    await within(client.stop(100));
    await rejected;
    assert.equal(client.status, 'stopped');
  });

  it('rejects a second concurrent start and leaves the first startup healthy', async () => {
    const client = new KernelClient();
    try {
      const first = client.start(launchOptions('fragment'));
      await assert.rejects(client.start(launchOptions('normal')), /kernel already running/);
      const ready = await within(first);
      assert.equal(ready.session, '0123456789abcdef');
      assert.equal(client.status, 'idle');
    } finally {
      await client.stop(100);
    }
  });

  it('interrupt while idle is a no-op', async () => {
    await withClient('normal', async (client) => {
      assert.equal(await client.interrupt(), false);
      assert.equal(client.status, 'idle');
      assert.equal(client.workload, 0);
    });
  });

  it('clears session metadata after a clean stop', async () => {
    const client = new KernelClient();
    await client.start(launchOptions('normal'));
    assert.ok(client.info);
    await client.stop(100);
    assert.equal(client.session, undefined);
    assert.equal(client.info, undefined);
  });

  it('rejects requests immediately after a worker crash', async () => {
    const client = new KernelClient();
    await client.start(launchOptions('crash'));
    await assert.rejects(within(client.request('execute')), (error: KernelRequestError) => error.code === 'kernel_exited');
    assert.equal(client.status, 'crashed');
    await assert.rejects(client.request('ping'), (error: KernelRequestError) => error.code === 'not_running');
  });

  it('restart while busy rejects old work and starts a fresh session', async () => {
    const client = new KernelClient();
    await client.start(launchOptions('hang'));
    const pending = client.request('execute');
    const rejected = assert.rejects(within(pending), (error: KernelRequestError) => error.code === 'kernel_exited');
    const ready = await within(client.restart(launchOptions('hang')), 3_000);
    await rejected;
    assert.equal(ready.session, '0123456789abcdef');
    assert.equal(client.status, 'idle');
    await client.stop(100);
  });

  it('force-kills a worker that ignores shutdown within the bounded grace path', async () => {
    const client = new KernelClient();
    await client.start(launchOptions('ignore_shutdown'));
    const pending = client.request('execute');
    const rejected = assert.rejects(within(pending, 2_500), (error: KernelRequestError) => error.code === 'kernel_exited');
    const started = Date.now();
    await within(client.stop(80), 2_500);
    await rejected;
    assert.ok(Date.now() - started < 2_000, 'stop should not wait for a cooperative shutdown');
    assert.equal(client.status, 'stopped');
  });

  it('does not accept a malformed ready event as a successful startup', async () => {
    const client = new KernelClient();
    try {
      const started = Date.now();
      const ready = await within(client.start(launchOptions('malformed_ready')));
      assert.ok(Date.now() - started >= 400, 'startup must wait for the structurally valid ready event');
      assert.equal(ready.session, '0123456789abcdef');
      assert.equal(client.session, ready.session);
    } finally {
      await client.stop(100);
    }
  });
});

describe('LiveScheduler adversarial sequencing', () => {
  it('cancel during an in-flight run followed by schedule neither overlaps nor loses the new run', async () => {
    const scheduler = new LiveScheduler(() => 5);
    const runs: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runner = (label: string) => async () => {
      runs.push(label);
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(60);
      active--;
    };
    scheduler.schedule('doc', runner('old'));
    await sleep(15);
    scheduler.cancel('doc');
    scheduler.schedule('doc', runner('new'));
    await sleep(150);
    assert.deepEqual(runs, ['old', 'new']);
    assert.equal(maxActive, 1, 'a key must never have two runs in flight');
  });

  it('reads a changing debounce value for every schedule call', async () => {
    const delays = [60, 5];
    const scheduler = new LiveScheduler(() => delays.shift() ?? 5);
    const runs: number[] = [];
    scheduler.schedule('doc', async (generation) => void runs.push(generation));
    await sleep(10);
    scheduler.schedule('doc', async (generation) => void runs.push(generation));
    await sleep(35);
    assert.deepEqual(runs, [2]);
  });

  it('cancel removes a pending debounced run', async () => {
    const scheduler = new LiveScheduler(() => 20);
    let runs = 0;
    scheduler.schedule('doc', async () => void runs++);
    scheduler.cancel('doc');
    await sleep(50);
    assert.equal(runs, 0);
  });
});

describe('cell parsing and dedent edge cases', () => {
  it('splits CRLF input without leaking carriage returns', () => {
    const cells = splitCells('before = 1\r\n# %% one\r\nx = 2\r\n# %% [live] two\r\ny = 3');
    assert.deepEqual(cells.map((cell) => [cell.startLine, cell.endLine, cell.text]), [
      [0, 0, 'before = 1'],
      [1, 2, '# %% one\nx = 2'],
      [3, 4, '# %% [live] two\ny = 3'],
    ]);
    assert.equal(cells[2].live, true);
  });

  it('accepts leading whitespace and the compact #%% marker', () => {
    assert.equal(isCellMarker('    #%% compact'), true);
    assert.equal(isCellMarker('\t# %% spaced'), true);
    assert.equal(hasCellMarkers('x = 1\n  #%% next'), true);
  });

  it('does not treat # %%% as a cell marker', () => {
    assert.equal(isCellMarker('# %%% heading'), false);
    assert.equal(splitCells('x = 1\n# %%% heading\ny = 2').length, 1);
  });

  it('represents an empty file as one empty cell', () => {
    assert.deepEqual(splitCells(''), [{ startLine: 0, endLine: 0, text: '', live: false, manual: false, title: '' }]);
  });

  it('dedents consistently tab-indented code', () => {
    assert.equal(dedent('\tif ready:\n\t\twork()\n\telse:\n\t\twait()'), 'if ready:\n\twork()\nelse:\n\twait()');
  });

  it('does not corrupt mixed indentation that has no common whitespace prefix', () => {
    const source = '\twith_tab()\n    with_spaces()';
    assert.equal(dedent(source), source);
  });
});

describe('webview message validation adversarial payloads', () => {
  it('sanitizes inherited properties and explicit __proto__ keys', () => {
    const inherited = Object.create({ type: 'command', command: 'runCell' }) as unknown;
    const explicit = JSON.parse('{"type":"command","command":"runCell","__proto__":{"polluted":true}}') as unknown;
    const expected = { type: 'command', command: 'runCell' };
    assert.deepEqual(validateWebviewMessage(inherited), expected);
    const validated = validateWebviewMessage(explicit);
    assert.deepEqual(validated, expected);
    assert.equal(Object.hasOwn(validated ?? {}, '__proto__'), false);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it('rejects NaN and infinities in every numeric field', () => {
    const base = { type: 'dfPage', requestId: 1, name: 'df', revision: 0, offset: 0, limit: 50, colOffset: 0, colLimit: 50 };
    for (const bad of [
      { requestId: Number.NaN },
      { revision: Number.POSITIVE_INFINITY },
      { offset: Number.NEGATIVE_INFINITY },
      { limit: Number.NaN },
      { colOffset: Number.POSITIVE_INFINITY },
      { colLimit: Number.NEGATIVE_INFINITY },
    ]) {
      assert.equal(validateWebviewMessage({ ...base, ...bad }), undefined);
    }
  });

  it('rejects request ids outside the safe integer range', () => {
    for (const requestId of [Number.MAX_SAFE_INTEGER + 1, 1e100, -1]) {
      assert.equal(validateWebviewMessage({ type: 'inspectVariable', requestId, name: 'x' }), undefined);
      assert.equal(validateWebviewMessage({ type: 'dfMetadata', requestId, name: 'df' }), undefined);
    }
  });

  it('rejects strings containing NUL characters', () => {
    assert.equal(validateWebviewMessage({ type: 'copy', text: 'safe\0suffix' }), undefined);
    assert.equal(
      validateWebviewMessage({
        type: 'dfPage', requestId: 1, name: 'df', revision: 0, offset: 0, limit: 10, colOffset: 0, colLimit: 10,
        filter: { column: 0, op: 'eq', value: 'x\0y' },
      }),
      undefined,
    );
  });
});
