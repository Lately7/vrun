/**
 * Owns one Python worker process. Independent of the `vscode` module so it
 * can be unit tested with plain Node.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  CONTROL_REQUESTS,
  KernelRequestError,
  KernelStatus,
  ReadyEvent,
  RequestType,
  StreamEvent,
  WorkerMessage,
  isReadyEvent,
  parseWorkerLine,
} from './protocol';

export interface KernelLaunchOptions {
  pythonPath: string;
  launcherPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
}

interface Pending {
  type: RequestType;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }
  fire(value: T): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(value);
      } catch {
        // A faulty listener must not break the kernel's message loop.
      }
    }
  }
}

const MAX_LINE_CHARS = 16 * 1024 * 1024;

export class KernelClient {
  private proc: ChildProcess | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private _status: KernelStatus = 'stopped';
  private _session: string | undefined;
  private _info: ReadyEvent | undefined;
  private stopping = false;
  private interruptTimer: NodeJS.Timeout | undefined;

  readonly onStatus = new Emitter<KernelStatus>();
  readonly onStream = new Emitter<StreamEvent>();
  readonly onLog = new Emitter<string>();
  /** The worker did not stop within the grace period after an interrupt. */
  readonly onInterruptStuck = new Emitter<void>();
  /** Fired when a new session starts; all old handles are invalid. */
  readonly onSession = new Emitter<ReadyEvent>();

  get status(): KernelStatus {
    return this._status;
  }
  get session(): string | undefined {
    return this._session;
  }
  get info(): ReadyEvent | undefined {
    return this._info;
  }
  get isRunning(): boolean {
    return this.proc !== undefined && this._status !== 'stopped' && this._status !== 'crashed';
  }
  /** Number of queued or running non-control requests. */
  get workload(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!CONTROL_REQUESTS.has(p.type)) n++;
    return n;
  }

  private setStatus(s: KernelStatus): void {
    if (this._status !== s) {
      this._status = s;
      this.onStatus.fire(s);
    }
  }

  async start(opts: KernelLaunchOptions): Promise<ReadyEvent> {
    if (this.proc) throw new Error('kernel already running');
    this.setStatus('starting');
    this.stopping = false;
    this.buffer = '';
    const env: NodeJS.ProcessEnv = {
      ...(opts.env ?? process.env),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      MPLBACKEND: 'Agg',
    };
    // argv array + shell:false: the interpreter path is never parsed by a shell.
    const proc = spawn(opts.pythonPath, ['-u', opts.launcherPath], {
      cwd: opts.cwd,
      env,
      shell: false,
      windowsHide: true,
      // POSIX: own process group so killProcess() can signal the whole tree.
      // (Windows uses taskkill /T instead; detached would open a console.)
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    const decoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    proc.stdout!.on('data', (chunk: Buffer) => this.onData(decoder.write(chunk)));
    proc.stderr!.on('data', (chunk: Buffer) => this.onLog.fire(errDecoder.write(chunk)));
    proc.stdin!.on('error', () => undefined); // EPIPE when the worker dies; handled by 'exit'

    return new Promise<ReadyEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.dispose();
        this.onLog.fire('[pylive] kernel did not become ready in time\n');
        this.killProcess();
        reject(new Error('Kernel start timed out'));
      }, opts.startTimeoutMs ?? 30000);
      const sub = this.onSession.on((ready) => {
        clearTimeout(timeout);
        sub.dispose();
        resolve(ready);
      });
      proc.once('error', (err) => {
        clearTimeout(timeout);
        sub.dispose();
        this.proc = undefined;
        this.setStatus('crashed');
        reject(new Error(`Could not start Python (${opts.pythonPath}): ${err.message}`));
      });
      proc.once('exit', (code, signal) => this.onExit(proc, code, signal, () => {
        clearTimeout(timeout);
        sub.dispose();
        reject(new Error(`Python exited during startup (code ${code}). See "PyLive: Show Kernel Log".`));
      }));
    });
  }

  private onExit(proc: ChildProcess, code: number | null, signal: string | null, onEarly: () => void): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    clearTimeout(this.interruptTimer);
    const wasReady = this._session !== undefined;
    this._session = undefined;
    this._info = undefined; // a stopped kernel must not advertise its old session
    const err = new KernelRequestError(
      'kernel_exited',
      this.stopping ? 'Kernel stopped' : `Kernel process exited unexpectedly (code ${code}, signal ${signal})`,
    );
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onLog.fire(`[pylive] kernel exited (code ${code}, signal ${signal})\n`);
    this.setStatus(this.stopping ? 'stopped' : 'crashed');
    if (!wasReady) onEarly();
  }

  private onData(text: string): void {
    this.buffer += text;
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes('\n')) {
      this.onLog.fire('[pylive] protocol line too long; discarding\n');
      this.buffer = '';
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const msg: WorkerMessage | undefined = parseWorkerLine(line);
    if (!msg) {
      this.onLog.fire(`[pylive] ignored malformed message: ${line.slice(0, 200)}\n`);
      return;
    }
    if (msg.type === 'event') {
      if (msg.event === 'ready') {
        if (!isReadyEvent(msg)) {
          this.onLog.fire('[pylive] ignored malformed ready event\n');
          return;
        }
        const ready = msg;
        this._session = ready.session;
        this._info = ready;
        this.setStatus('idle');
        this.onSession.fire(ready);
      } else if (msg.event === 'stream') {
        this.onStream.fire(msg as StreamEvent);
      }
      return;
    }
    if (typeof msg.id !== 'number') {
      if (!msg.ok) this.onLog.fire(`[pylive] worker error: ${msg.error?.code} ${msg.error?.message}\n`);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new KernelRequestError(msg.error!.code, msg.error!.message));
    this.refreshBusy();
  }

  private refreshBusy(): void {
    if (!this.proc || this._session === undefined) return;
    if (this.workload === 0) {
      clearTimeout(this.interruptTimer);
      this.setStatus('idle');
    } else if (this._status !== 'interrupting') {
      this.setStatus('busy');
    }
  }

  /** Sends a request; returns its id synchronously via `onId` (used for interrupt/cancel). */
  request<T>(type: RequestType, params: Record<string, unknown> = {}, onId?: (id: number) => void): Promise<T> {
    const proc = this.proc;
    if (!proc || this._session === undefined) {
      return Promise.reject(new KernelRequestError('not_running', 'Kernel is not running'));
    }
    const id = this.nextId++;
    onId?.(id);
    const line = JSON.stringify({ ...params, id, type }) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { type, resolve: resolve as (v: unknown) => void, reject });
      this.refreshBusy();
      proc.stdin!.write(line, 'utf8', (err) => {
        if (err && this.pending.delete(id)) {
          reject(new KernelRequestError('write_failed', err.message));
          this.refreshBusy();
        }
      });
    });
  }

  /**
   * Interrupt a running request (or everything, if `target` is undefined).
   * If the worker is still busy after `graceMs`, `onInterruptStuck` fires so
   * the UI can offer a restart (the only hard stop for native code).
   */
  async interrupt(target?: number, graceMs = 3000): Promise<boolean> {
    if (!this.isRunning || this.workload === 0) return false;
    this.setStatus('interrupting');
    let hit = false;
    try {
      const r = await this.request<{ interrupted: boolean }>('interrupt', target === undefined ? {} : { target });
      hit = r.interrupted;
    } catch {
      // ignore: exit handling reports the failure
    }
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (this.isRunning && this.workload > 0) this.onInterruptStuck.fire();
    }, graceMs);
    this.refreshBusy();
    return hit;
  }

  cancel(target: number): Promise<{ cancelled: boolean }> {
    return this.request('cancel', { target });
  }

  async stop(graceMs = 2000): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.setStatus('stopped');
      return;
    }
    this.stopping = true;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    if (this._session !== undefined) {
      this.request('shutdown').catch(() => undefined);
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), graceMs)),
    ]);
    if (timedOut) {
      this.killProcess();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    }
  }

  async restart(opts: KernelLaunchOptions): Promise<ReadyEvent> {
    this.setStatus('restarting');
    await this.stop(1000);
    return this.start(opts);
  }

  /** Kill the whole process tree (user code may have spawned children). */
  killProcess(): void {
    const proc = this.proc;
    if (!proc || proc.pid === undefined) return;
    this.stopping = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { shell: false, windowsHide: true });
      killer.on('error', () => proc.kill());
    } else {
      try {
        process.kill(-proc.pid, 'SIGKILL'); // negative pid: the process group
      } catch {
        proc.kill('SIGKILL');
      }
    }
  }

  dispose(): void {
    clearTimeout(this.interruptTimer);
    if (this.proc) {
      this.stopping = true;
      try {
        this.proc.stdin?.end(); // the worker exits on stdin EOF
      } catch {
        /* ignore */
      }
      this.killProcess();
    }
  }
}
