/** Messaging with the extension host, with request/response correlation. */

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export interface HostError {
  code: string;
  message: string;
}

let nextRequestId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: HostError) => void }>();

export function send(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

/** Send a request that the host forwards to the kernel. */
export function request<T>(msg: Record<string, unknown>): Promise<T> {
  const requestId = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ ...msg, requestId });
  });
}

export function handleResponse(msg: { requestId: number; ok: boolean; result?: unknown; error?: HostError }): void {
  const p = pending.get(msg.requestId);
  if (!p) return;
  pending.delete(msg.requestId);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(msg.error ?? { code: 'error', message: 'unknown error' });
}

/** Reject everything in flight (kernel restarted or stopped). */
export function rejectAll(reason: HostError): void {
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}
