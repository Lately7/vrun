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
