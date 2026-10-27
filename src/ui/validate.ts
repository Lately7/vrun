/**
 * Validation of messages received from the webview. The webview is treated
 * as untrusted: only allowlisted message types with bounded fields pass.
 * Nothing here ever carries code to execute.
 */

export const WEBVIEW_COMMANDS = [
  'start',
  'restart',
  'stop',
  'interrupt',
  'runCell',
  'runFile',
  'toggleLive',
  'visualize',
  'toggleLiveVisualize',
  'showLog',
] as const;
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export const FILTER_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains', 'isnull', 'notnull'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface SortSpec {
  column: number;
  ascending: boolean;
}
export interface FilterSpec {
  column: number;
  op: FilterOp;
  value?: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; command: WebviewCommand }
  | { type: 'refreshVariables' }
  | { type: 'inspectVariable'; requestId: number; name: string }
  | { type: 'openDataFrame'; name: string }
  | { type: 'dfMetadata'; requestId: number; name: string }
  | {
      type: 'dfPage';
      requestId: number;
      name: string;
      revision: number;
      offset: number;
      limit: number;
      colOffset: number;
      colLimit: number;
      sort?: SortSpec;
      filter?: FilterSpec;
    }
  | { type: 'dfSummary'; requestId: number; name: string; revision: number }
  | { type: 'dfColumn'; requestId: number; name: string; revision: number; column: number }
  | { type: 'traceStep'; line: number }
  | { type: 'copy'; text: string };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}
function isName(v: unknown): v is string {
  return typeof v === 'string' && IDENT.test(v);
}

export function validateWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'refreshVariables':
      return { type: m.type };
    case 'command':
      return (WEBVIEW_COMMANDS as readonly string[]).includes(m.command as string)
        ? { type: 'command', command: m.command as WebviewCommand }
        : undefined;
    case 'inspectVariable':
      return isName(m.name) && isInt(m.requestId, 0, Number.MAX_SAFE_INTEGER)
        ? { type: 'inspectVariable', requestId: m.requestId, name: m.name }
        : undefined;
    case 'openDataFrame':
      return isName(m.name) ? { type: 'openDataFrame', name: m.name } : undefined;
    case 'dfMetadata':
      return isName(m.name) && isInt(m.requestId, 0, Number.MAX_SAFE_INTEGER)
        ? { type: 'dfMetadata', requestId: m.requestId, name: m.name }
        : undefined;
    case 'dfPage': {
      if (
        !isName(m.name) ||
        !isInt(m.requestId, 0, Number.MAX_SAFE_INTEGER) ||
        !isInt(m.revision, 0, Number.MAX_SAFE_INTEGER) ||
        !isInt(m.offset, 0, Number.MAX_SAFE_INTEGER) ||
        !isInt(m.limit, 1, 500) ||
        !isInt(m.colOffset, 0, 1_000_000) ||
        !isInt(m.colLimit, 1, 200)
      ) {
        return undefined;
      }
      const out: WebviewMessage = {
        type: 'dfPage',
        requestId: m.requestId,
        name: m.name,
        revision: m.revision,
        offset: m.offset,
        limit: m.limit,
        colOffset: m.colOffset,
        colLimit: m.colLimit,
      };
      if (m.sort !== undefined && m.sort !== null) {
        const s = m.sort as Record<string, unknown>;
        if (typeof s !== 'object' || !isInt(s.column, 0, 1_000_000) || typeof s.ascending !== 'boolean') return undefined;
        out.sort = { column: s.column, ascending: s.ascending };
      }
      if (m.filter !== undefined && m.filter !== null) {
        const f = m.filter as Record<string, unknown>;
        if (typeof f !== 'object' || !isInt(f.column, 0, 1_000_000)) return undefined;
        if (!(FILTER_OPS as readonly string[]).includes(f.op as string)) return undefined;
        const needsValue = f.op !== 'isnull' && f.op !== 'notnull';
        if (needsValue && (typeof f.value !== 'string' || f.value.length > 1000)) return undefined;
        out.filter = { column: f.column, op: f.op as FilterOp, ...(needsValue ? { value: f.value as string } : {}) };
      }
      return out;
    }
    case 'dfSummary':
      return isName(m.name) && isInt(m.requestId, 0, Number.MAX_SAFE_INTEGER) && isInt(m.revision, 0, Number.MAX_SAFE_INTEGER)
        ? { type: 'dfSummary', requestId: m.requestId, name: m.name, revision: m.revision }
        : undefined;
    case 'dfColumn':
      return isName(m.name) &&
        isInt(m.requestId, 0, Number.MAX_SAFE_INTEGER) &&
        isInt(m.revision, 0, Number.MAX_SAFE_INTEGER) &&
        isInt(m.column, 0, 1_000_000)
        ? { type: 'dfColumn', requestId: m.requestId, name: m.name, revision: m.revision, column: m.column }
        : undefined;
    case 'traceStep':
      return isInt(m.line, 1, 10_000_000) ? { type: 'traceStep', line: m.line } : undefined;
    case 'copy':
      return typeof m.text === 'string' && m.text.length <= 1_000_000 ? { type: 'copy', text: m.text } : undefined;
    default:
      return undefined;
  }
}
