/** Formatting of values encoded by python/pylive_kernel/serialize.py. */

export interface Tagged {
  $t: string;
  v?: string;
  len?: number;
  type?: string;
  bits?: number;
  shape?: number[];
}
export interface Ref {
  ref: number;
  missing?: boolean;
}
export type Encoded = null | boolean | number | string | Tagged | Ref;

export interface HeapNode {
  kind: 'list' | 'tuple' | 'set' | 'deque' | 'dict' | 'object' | 'ndarray';
  items?: Encoded[];
  entries?: [Encoded, Encoded][];
  fields?: [string, Encoded][];
  rows?: Encoded[][];
  len?: number;
  type?: string;
  shape?: number[];
  dtype?: string;
  /** 0-d arrays */
  value?: Encoded;
}
export type Heap = Record<string, HeapNode | null>;

export function isRef(v: unknown): v is Ref {
  return typeof v === 'object' && v !== null && typeof (v as Ref).ref === 'number';
}
export function isTagged(v: unknown): v is Tagged {
  return typeof v === 'object' && v !== null && typeof (v as Tagged).$t === 'string';
}

/** Numeric value of an encoded scalar, or undefined. Booleans are not numbers. */
export function numeric(v: Encoded | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (isTagged(v)) {
    if (v.$t === 'inf') return Infinity;
    if (v.$t === '-inf') return -Infinity;
    if (v.$t === 'int' && v.v !== undefined) return Number(v.v);
  }
  return undefined;
}

export function fmtNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-4 || a >= 1e9)) return n.toExponential(4);
  return String(Number(n.toPrecision(8)));
}

export function fmtScalar(v: Encoded | undefined, heap?: Heap): string {
  if (v === undefined) return '';
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'string') return v;
  if (isRef(v)) {
    const node = heap?.[String(v.ref)];
    if (!node) return '…';
    if (node.kind === 'object') return `${node.type ?? 'object'}`;
    if (node.kind === 'ndarray') {
      // Short 1-D arrays read as their values (cross_validate's test_score).
      if (node.items && node.shape?.length === 1 && node.shape[0] <= 8) return `[${node.items.map((x) => fmtScalar(x, heap)).join(', ')}]`;
      if (node.value !== undefined) return fmtScalar(node.value, heap);
      return `ndarray ${(node.shape ?? []).join('×')} ${node.dtype ?? ''}`.trim();
    }
    if (node.kind === 'dict' && node.type) return `${node.type}[${node.len ?? '?'}]`;
    return `${node.kind}[${node.len ?? '?'}]`;
  }
  switch (v.$t) {
    case 'nan':
      return 'NaN';
    case 'na':
      return '<NA>';
    case 'nat':
      return 'NaT';
    case 'inf':
      return 'inf';
    case '-inf':
      return '-inf';
    case 'int':
      return v.v ?? `<int ${v.bits} bits>`;
    case 'str':
      return `${v.v}… (${v.len} chars)`;
    case 'dt':
      return (v.v ?? '').replace('T', ' ');
    case 'bytes':
      return `b'${v.v}'… (${v.len} bytes)`;
    case 'fn':
      return `ƒ ${v.v}`;
    case 'cls':
      return `class ${v.v}`;
    case 'obj':
      return v.len !== undefined ? `${v.type}[${v.len}]` : `<${v.type}>`;
    default:
      return v.v ?? `<${v.$t}>`;
  }
}

/** A str as Python writes it: '0' is not 0, '(' is not a parenthesis. */
export function pyStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const esc: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  let body = s.replace(/[\\\n\r\t]/g, (c) => esc[c]);
  if (q === "'") body = body.replace(/'/g, "\\'");
  return q + body + q;
}

/** fmtScalar, with strings quoted (values of variables, not labels). */
export function fmtPy(v: Encoded | undefined, heap?: Heap): string {
  if (typeof v === 'string') return pyStr(v);
  if (isTagged(v) && v.$t === 'str') return `${pyStr(v.v ?? '').slice(0, -1)}… (${v.len} chars)`;
  return fmtScalar(v, heap);
}

/**
 * A container preview the way Python prints it, strings quoted: input().split()
 * read as ['10', '2'] must not look like the ints [10, 2], and a deque or a
 * dict whose values were not sent must not look like a set.
 */
export function fmtPreview(kind: string, preview: Encoded[], len: number | undefined, values?: Encoded[], type?: string): string {
  // A dict whose values are containers sends only its keys: `'a': …` still reads as a dict.
  const items = preview.map((p, i) => (kind !== 'dict' ? fmtPy(p) : `${fmtPy(p)}: ${values && i < values.length ? fmtPy(values[i]) : '…'}`));
  const more = (len ?? 0) > preview.length ? ', …' : '';
  const body = items.join(', ') + more;
  switch (kind) {
    case 'tuple':
      return `(${body}${len === 1 && preview.length === 1 ? ',' : ''})`;
    case 'set':
      return len === 0 ? 'set()' : `{${body}}`;
    case 'frozenset':
      return len === 0 ? 'frozenset()' : `frozenset({${body}})`;
    case 'deque':
      return `deque([${body}])`;
    case 'dict': {
      // Counter / OrderedDict / defaultdict print their type around the dict (Python 3.12).
      const t = type?.replace(/^collections\./, '');
      if (t === 'Counter' || t === 'OrderedDict') return len === 0 ? `${t}()` : `${t}({${body}})`;
      if (t === 'defaultdict') return `defaultdict(…, {${body}})`;
      return `{${body}}`;
    }
    default:
      return `[${body}]`;
  }
}

/**
 * Names of Python built-ins a learner is likely to reuse as a variable
 * (input = sys.stdin.readline, max = 0, list = [...]). The kernel is shared by
 * every file of the window, so such a value breaks max(a) in another file.
 */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr',
  'classmethod', 'compile', 'complex', 'copyright', 'credits', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval',
  'exec', 'exit', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id',
  'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'license', 'list', 'locals', 'map', 'max', 'memoryview',
  'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'quit', 'range', 'repr', 'reversed',
  'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
]);

/**
 * True when a variable hides the built-in of the same name. `max = max`
 * (the built-in itself, re-bound) hides nothing; the learner's own
 * `def sum(xs)` does: the name matches, the type tells them apart (a
 * built-in function's type is builtin_function_or_method, a def's is
 * function).
 */
export function shadowsBuiltin(name: string, value: Encoded | undefined, type?: string): boolean {
  if (!BUILTIN_NAMES.has(name)) return false;
  if (!isTagged(value) || value.v !== name) return true;
  if (value.$t === 'fn') return type !== undefined && type !== 'builtin_function_or_method';
  // A class of the same name: list = list. (A learner's own `class list`
  // has type `type` too; that is rare enough to leave untagged.)
  return value.$t !== 'cls';
}

/** CSS class used to style missing/special values distinctly. */
export function scalarClass(v: Encoded | undefined): string {
  if (v === null) return 'v-none';
  if (isTagged(v)) {
    if (['nan', 'na', 'nat'].includes(v.$t)) return 'v-missing';
    if (v.$t === 'obj') return 'v-obj';
    if (v.$t === 'dt' || v.$t === 'date' || v.$t === 'td') return 'v-date';
  }
  if (typeof v === 'number') return 'v-num';
  if (typeof v === 'boolean') return 'v-bool';
  return '';
}
