/**
 * Values of the subscripts on the line about to run (`arr[j]`, `dp[i - 1][j]`,
 * `seen[ch]`), read from the step's variables and heap: no Python runs.
 */
import { type Encoded, type Heap, type HeapNode, isRef, isTagged } from './format';

export interface Watch {
  text: string;
  value: Encoded;
}

type Val = number | string;

const MAX_WATCHES = 4;

/** Replace string literals and comments by spaces, keeping columns. */
function stripStrings(line: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      out += ' ';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ' ';
    } else if (ch === '#') {
      break;
    } else out += ch;
  }
  return out;
}

/** `name[...]` / `name[...][...]` occurrences (not attributes, not slices). */
export function subscriptsOf(line: string): Array<{ name: string; indexes: string[]; text: string }> {
  const src = stripStrings(line);
  const out: Array<{ name: string; indexes: string[]; text: string }> = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    if (start > 0 && /[.\w]/.test(src[start - 1])) continue; // obj.items[i], or a word's middle
    let pos = start + m[0].length;
    const indexes: string[] = [];
    while (true) {
      let p = pos;
      while (src[p] === ' ') p++;
      if (src[p] !== '[') break;
      let depth = 0;
      let q = p;
      for (; q < src.length; q++) {
        if (src[q] === '[') depth++;
        else if (src[q] === ']' && --depth === 0) break;
      }
      if (q >= src.length) break;
      indexes.push(src.slice(p + 1, q).trim());
      pos = q + 1;
    }
    if (indexes.length && !indexes.some((x) => x === '' || x.includes(':'))) {
      out.push({ name: m[0], indexes, text: line.slice(start, pos) });
      re.lastIndex = pos;
    }
  }
  return out;
}

/** Evaluates + - * // % and unary minus over ints, names and len(name). */
class Expr {
  private i = 0;
  private readonly toks: string[];
  constructor(text: string, private readonly lookup: (name: string) => Val | undefined, private readonly lenOf: (name: string) => number | undefined) {
    this.toks = text.match(/\d+|[A-Za-z_]\w*|\/\/|[-+*%()]/g) ?? [];
    if (this.toks.join('') !== text.replace(/\s+/g, '')) this.toks = ['?'];
  }

  run(): Val | undefined {
    const v = this.sum();
    return this.i === this.toks.length ? v : undefined;
  }

  private sum(): Val | undefined {
    let v = this.product();
    while (this.toks[this.i] === '+' || this.toks[this.i] === '-') {
      const op = this.toks[this.i++];
      const r = this.product();
      if (typeof v !== 'number' || typeof r !== 'number') return undefined;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  private product(): Val | undefined {
    let v = this.unary();
    while (['*', '//', '%'].includes(this.toks[this.i])) {
      const op = this.toks[this.i++];
      const r = this.unary();
      if (typeof v !== 'number' || typeof r !== 'number') return undefined;
      if (op !== '*' && r === 0) return undefined;
      v = op === '*' ? v * r : op === '//' ? Math.floor(v / r) : ((v % r) + r) % r;
    }
    return v;
  }

  private unary(): Val | undefined {
    if (this.toks[this.i] === '-') {
      this.i++;
      const v = this.unary();
      return typeof v === 'number' ? -v : undefined;
    }
    return this.atom();
  }

  private atom(): Val | undefined {
    const t = this.toks[this.i++];
    if (t === undefined) return undefined;
    if (/^\d+$/.test(t)) return Number(t);
    if (t === '(') {
      const v = this.sum();
      return this.toks[this.i++] === ')' ? v : undefined;
    }
    if (t === 'len' && this.toks[this.i] === '(') {
      const name = this.toks[this.i + 1];
      if (this.toks[this.i + 2] !== ')') return undefined;
      this.i += 3;
      return this.lenOf(name);
    }
    if (/^[A-Za-z_]/.test(t)) return this.lookup(t);
    return undefined;
  }
}

function scalarOf(v: Encoded | undefined): Val | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isTagged(v) && v.$t === 'int' && v.v !== undefined && /^-?\d+$/.test(v.v)) return Number(v.v);
  return undefined;
}

function sameKey(k: Encoded, want: Val): boolean {
  const s = scalarOf(k);
  return s !== undefined && s === want;
}

/** A value being indexed: an encoded value, or a row of a 2-D ndarray (rows are not heap nodes). */
type Cursor = { enc: Encoded } | { row: Encoded[] };

function at<T>(items: T[], len: number, key: Val): T | undefined {
  if (typeof key !== 'number') return undefined;
  const i = key < 0 ? len + key : key;
  return i >= 0 && i < items.length ? items[i] : undefined;
}

function index(cur: Cursor, key: Val, heap: Heap): Cursor | undefined {
  if ('row' in cur) {
    const v = at(cur.row, cur.row.length, key);
    return v === undefined ? undefined : { enc: v };
  }
  const c = cur.enc;
  if (typeof c === 'string') {
    const ch = at([...c], c.length, key);
    return ch === undefined ? undefined : { enc: ch };
  }
  if (!isRef(c)) return undefined;
  const n: HeapNode | null | undefined = heap[String(c.ref)];
  if (!n) return undefined;
  if (n.kind === 'dict') {
    const v = n.entries?.find(([k]) => sameKey(k, key))?.[1];
    return v === undefined ? undefined : { enc: v };
  }
  if (n.kind === 'ndarray' && n.rows) {
    const row = at(n.rows, n.shape?.[0] ?? n.rows.length, key);
    return row === undefined ? undefined : { row };
  }
  if (!n.items) return undefined;
  const v = at(n.items, n.len ?? n.items.length, key);
  return v === undefined ? undefined : { enc: v };
}

/**
 * Watches for one source line. `vars` maps visible names (innermost frame
 * first) to their encoded values at this step.
 */
export function watchesFor(line: string, vars: Map<string, Encoded>, heap: Heap): Watch[] {
  const out: Watch[] = [];
  const seen = new Set<string>();
  const lookup = (name: string): Val | undefined => scalarOf(vars.get(name));
  const lenOf = (name: string): number | undefined => {
    const v = vars.get(name);
    if (typeof v === 'string') return v.length;
    if (!isRef(v)) return undefined;
    const n = heap[String(v.ref)];
    return n ? n.len ?? n.items?.length ?? n.entries?.length ?? n.rows?.length : undefined;
  };
  for (const sub of subscriptsOf(line)) {
    if (out.length >= MAX_WATCHES) break;
    const text = sub.text.replace(/\s+(?=\[)/g, '');
    if (seen.has(text)) continue;
    const root = vars.get(sub.name);
    if (root === undefined) continue;
    let cur: Cursor | undefined = { enc: root };
    for (const ix of sub.indexes) {
      const key = new Expr(ix, lookup, lenOf).run();
      cur = key === undefined ? undefined : index(cur, key, heap);
      if (cur === undefined) break;
    }
    if (cur === undefined || !('enc' in cur)) continue;
    seen.add(text);
    out.push({ text, value: cur.enc });
  }
  return out;
}
