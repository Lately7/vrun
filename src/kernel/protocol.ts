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
  figures?: Array<{ png?: string; error?: string }>;
  analysis?: Analysis;
  interrupted?: 'interrupted' | 'timeout';
  outputTruncated?: boolean;
}

export interface HeapNode {
  kind: string;
  [key: string]: unknown;
}

export interface TraceStep {
  line: number;
  event: 'line' | 'return' | 'exception';
  stack: Array<{ func: string; line: number; locals: Array<[string, Encoded]> }>;
  heap: Record<string, HeapNode>;
  out: number;
  ret?: Encoded;
  exc?: string;
  truncated?: boolean;
}

export interface TraceResult {
  status: 'ok' | 'blocked';
  steps: TraceStep[];
  stopped: string | null;
  error: ErrorInfo | null;
  stdout: string;
  stdoutTruncated?: boolean;
  elapsedMs?: number;
  source?: string;
  analysis?: Analysis;
}

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
