/**
 * Typed protocol between the extension host and the Python worker.
 * See ARCHITECTURE.md §3. Messages are newline-delimited JSON.
 */

export type KernelStatus =
  | 'stopped'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'interrupting'
  | 'restarting'
  | 'crashed';

/** Tagged non-JSON-native value produced by serialize.py. */
export interface Tagged {
  $t: string;
  v?: string;
  len?: number;
  type?: string;
  [key: string]: unknown;
}

export type Encoded = null | boolean | number | string | Tagged | { ref: number; missing?: boolean };

export interface ErrorInfo {
  ename: string;
  evalue: string;
  traceback: string;
  frames: FrameInfo[];
  userFrame: FrameInfo | null;
  /** What to do about it, for errors with a known cause (DataLoader workers, torn imports). */
  hint?: string;
}

export interface FrameInfo {
  file: string;
  line: number;
  name: string;
  col?: number;
  endLine?: number;
  endCol?: number;
}

export interface Finding {
  /** Line within the code that was sent (1-based). */
  line: number;
  /** The same line in the document (1-based). */
  fileLine?: number;
  category: string;
  message: string;
}

/** Where a live run stopped: the first statement that may not re-run. */
export interface StopInfo {
  line: number;
  category: string;
  message: string;
}

export interface Analysis {
  safe: boolean;
  training?: boolean;
  syntaxError?: boolean;
  findings: Finding[];
}

export interface ExecuteResult {
  status: 'ok' | 'error' | 'blocked' | 'needs_confirmation';
  executionCount: number;
  elapsedMs?: number;
  value?: { type: string; shortType: string; repr: string; shape?: number[]; dataframe?: boolean; viz?: string | null };
  error?: ErrorInfo;
  /** png: a rendered figure; html: an interactive (plotly) figure saved as a file. */
  figures?: Array<{ png?: string; error?: string; html?: string; title?: string }>;
  analysis?: Analysis;
  interrupted?: 'interrupted' | 'timeout';
  outputTruncated?: boolean;
  /** Data-loading statements reused from an earlier run ("load once"). */
  skippedLoads?: Array<{ line: number; code: string }>;
  /** Data-loading statements that actually ran in this execution. */
  loadedNow?: Array<{ line: number; code: string }>;
  /** Live Mode ran the safe beginning of the code and stopped here. */
  stoppedAt?: StopInfo;
  /** needs_confirmation: how long the previous run of this training code took. */
  lastElapsedMs?: number;
  /** Notes about the run, e.g. notebook magics that were ignored. */
  notes?: string[];
}

export interface HeapNode {
  kind: string;
  [key: string]: unknown;
}

export interface TraceFrame {
  func: string;
  line: number;
  locals: Array<[string, Encoded]>;
  /** Call id: the same id on every step of one call (call tree). */
  fid?: number;
  /** Parameter names, on the first step of the call only. */
  params?: string[];
  /** Qualified name when it differs from func (Trie.__init__), first step only. */
  qual?: string;
  /** A class body: runs like a call, but is not one. First step only. */
  body?: boolean;
  /** Id of the code object (recursion: calls of the same code). First step only. */
  code?: number;
}

export interface TraceStep {
  line: number;
  event: 'line' | 'return' | 'exception';
  /**
   * Outermost frame first. With TraceResult.stackRuns, a number n stands for
   * n frames that are the same as at those positions of the previous step.
   */
  stack: Array<TraceFrame | number>;
  /** With TraceResult.heapDelta: only the nodes that changed since they were last sent. */
  heap: Record<string, HeapNode>;
  /** Heap ids no longer sent (over the node cap): drop their older copies. */
  gone?: string[];
  out: number;
  /** On a return step: the returned (or, with yield, the yielded) value. */
  ret?: Encoded;
  /** A generator suspended at a yield; the call goes on later. */
  yield?: boolean;
  /** On a return step: the call ended by this exception, it did not return. */
  raised?: string;
  exc?: string;
  truncated?: boolean;
}

/**
 * A trace that hit a limit after the program came back to a state it had
 * been in before: almost certainly an endless loop, which more steps
 * cannot fix.
 */
export interface TraceLoop {
  /** Step index where the repeated state was first seen. */
  first: number;
  /** Step index where it came back. */
  repeat: number;
  /** Line (in the traced code) of the repeated state. */
  line: number;
  /** The values that did not change between the two steps. */
  values: Array<[string, Encoded]>;
  /** The loop printed the same output on each pass (output does not change what it does next). */
  prints?: boolean;
}

export interface TraceResult {
  status: 'ok' | 'blocked';
  steps: TraceStep[];
  /** Steps carry heap deltas; the full heap of step k is steps[0..k] applied in order. */
  heapDelta?: boolean;
  /** Steps' stacks may contain runs of unchanged frames (see TraceStep.stack). */
  stackRuns?: boolean;
  stopped: string | null;
  error: ErrorInfo | null;
  stdout: string;
  stdoutTruncated?: boolean;
  elapsedMs?: number;
  source?: string;
  analysis?: Analysis;
  /** Notes for the run header, e.g. names taken from the cells above or a folder change. */
  notes?: string[];
  /** Set with `stopped` when the limit was hit inside a likely endless loop. */
  loop?: TraceLoop;
}

/**
 * Parameters of `execute`. A type alias (not an interface) so it is
 * assignable to the client's Record<string, unknown> parameter.
 */
export type ExecuteParams = {
  code: string;
  /** Shown in tracebacks; the absolute path for a saved file. */
  file?: string;
  lineOffset?: number;
  mode?: 'manual' | 'live';
  execId?: number;
  timeoutMs?: number;
  confirmAfterMs?: number;
  stdin?: string;
  force?: boolean;
  /**
   * Folder of the saved file the code comes from (absent for untitled
   * buffers). The kernel moves its working folder there unless the code
   * changed it itself, so `open("data.csv")` finds the file next to it.
   */
  cwd?: string;
};

/** Parameters of `trace` (see ExecuteParams for why this is a type alias). */
export type TraceParams = {
  code: string;
  mode?: 'manual' | 'live';
  execId?: number;
  maxSteps?: number;
  timeoutMs?: number;
  stdin?: string;
  cwd?: string;
  /**
   * Text of every line above the traced cell of a `# %%` file. The tracer
   * runs only its definitions, imports and simple literal assignments
   * (untraced), so a cell can use what the setup cell defines.
   */
  prelude?: string;
};

export interface VariableInfo {
  name: string;
  type: string;
  kind: string;
  value?: Encoded;
  len?: number;
  shape?: number[];
  dtype?: string;
  dtypes?: Record<string, number>;
  size?: number | null;
  sizeIsLowerBound?: boolean;
  preview?: Encoded[];
  viz?: string | null;
  fitted?: boolean;
  fittedAttrs?: string[];
  /** A 1-D / 2-D array or CPU tensor that the DataFrame tab can page. */
  table?: boolean;
  error?: string;
}

export interface VariablesList {
  variables: VariableInfo[];
  omitted: number;
  session: string;
  revision: number;
}

export interface WorkerErrorPayload {
  code: string;
  message: string;
}

export interface ResponseMessage {
  type: 'response';
  id: number | string | null;
  ok: boolean;
  result?: unknown;
  error?: WorkerErrorPayload;
}

export interface EventMessage {
  type: 'event';
  event: 'ready' | 'stream' | string;
  [key: string]: unknown;
}

export interface ReadyEvent extends EventMessage {
  event: 'ready';
  session: string;
  pid: number;
  python: { version: string; executable: string };
  cwd: string;
}

export interface StreamEvent extends EventMessage {
  event: 'stream';
  name: 'stdout' | 'stderr';
  text: string;
  execId?: number | null;
}

export type WorkerMessage = ResponseMessage | EventMessage;

/** Requests the host may send. Control requests bypass the worker's queue. */
export type RequestType =
  | 'execute'
  | 'trace'
  | 'analyze'
  | 'variables.list'
  | 'variables.inspect'
  | 'variables.image'
  | 'variables.series'
  | 'dataframe.metadata'
  | 'dataframe.page'
  | 'dataframe.summary'
  | 'dataframe.column'
  | 'interrupt'
  | 'cancel'
  | 'shutdown'
  | 'ping';

export const CONTROL_REQUESTS: ReadonlySet<RequestType> = new Set(['interrupt', 'cancel', 'shutdown', 'ping']);

export class KernelRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KernelRequestError';
  }
}

/** A ready event starts a session, so every field is checked, not just the tag. */
export function isReadyEvent(msg: EventMessage): msg is ReadyEvent {
  const m = msg as Record<string, unknown>;
  const py = m.python as Record<string, unknown> | undefined;
  return (
    m.event === 'ready' &&
    typeof m.session === 'string' &&
    /^[0-9a-f]{16}$/.test(m.session) &&
    typeof m.pid === 'number' &&
    Number.isSafeInteger(m.pid) &&
    m.pid > 0 &&
    typeof m.cwd === 'string' &&
    typeof py === 'object' &&
    py !== null &&
    typeof py.version === 'string' &&
    typeof py.executable === 'string'
  );
}

/** Validates the outer shape of a line received from the worker. */
export function parseWorkerLine(line: string): WorkerMessage | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  if (m.type === 'response' && typeof m.ok === 'boolean') {
    if (m.id !== null && typeof m.id !== 'number' && typeof m.id !== 'string') return undefined;
    if (!m.ok) {
      const e = m.error as Record<string, unknown> | undefined;
      if (!e || typeof e.code !== 'string' || typeof e.message !== 'string') return undefined;
    }
    return m as unknown as ResponseMessage;
  }
  if (m.type === 'event' && typeof m.event === 'string') {
    return m as unknown as EventMessage;
  }
  return undefined;
}
