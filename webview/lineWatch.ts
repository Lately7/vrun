/**
 * Values of the subscripts on the line about to run (`arr[j]`, `dp[i - 1][j]`,
 * `seen[ch]`), read from the step's variables and heap: no Python runs.
 */
import { type Encoded, type Heap, type HeapNode, isRef, isTagged, pyStr } from './format';
import type { LineOutcome } from './traceModel';

export interface Watch {
  text: string;
  /** null for a watch with `outOfRange` or `notShown`. */
  value: Encoded;
  /** Not in the container: Python raises IndexError (KeyError) on this subscript. */
  outOfRange?: Miss;
  /** The item exists but was not sent: a long list or dict is cut (part of it, and its len, are sent). */
  notShown?: boolean;
}

/**
 * Why a subscript fails: an index outside 0..len-1 (-len..-1), or a key the
 * dict does not have. For a dict cut to its first `sent` entries (of `len`)
 * the key is only not among those sent: likely the missing one when the
 * line raised KeyError, and never claimed to exist.
 */
export type Miss = { index: number; len: number } | { key: string; sent?: number; len?: number };

/** "index 4, len 4 (0..3)", "index -5, len 4 (-4..3)", "index 0, len 0 (empty)", "key 'x' is not in the dict". */
export function outOfRangeText(m: Miss): string {
  if ('key' in m) {
    return m.sent !== undefined ? `key ${m.key} is probably not in the dict (not among the ${m.sent} of ${m.len} entries sent)` : `key ${m.key} is not in the dict`;
  }
  const valid = m.len === 0 ? 'empty' : m.index < 0 ? `${-m.len}..${m.len - 1}` : `0..${m.len - 1}`;
  return `index ${m.index}, len ${m.len} (${valid})`;
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

/**
 * `name[...]` / `name[...][...]` occurrences (not attributes, not slices);
 * `start` is the column of the name. Brackets are matched outside strings,
 * the indexes keep their string literals (`seen["b"]`).
 */
export function subscriptsOf(line: string): Array<{ name: string; indexes: string[]; text: string; start: number }> {
  const src = stripStrings(line);
  const out: Array<{ name: string; indexes: string[]; text: string; start: number }> = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    if (start > 0 && /[.\w]/.test(src[start - 1])) continue; // obj.items[i], or a word's middle
    let pos = start + m[0].length;
    const indexes: string[] = [];
    let slice = false;
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
      // stripStrings keeps columns: the same span of the line has the literals.
      indexes.push(line.slice(p + 1, q).trim());
      slice ||= src.slice(p + 1, q).includes(':');
      pos = q + 1;
    }
    if (indexes.length && !slice && !indexes.includes('')) {
      out.push({ name: m[0], indexes, text: line.slice(start, pos), start });
      re.lastIndex = pos;
    }
  }
  return out;
}

/**
 * The subscript at `col` may be skipped: it comes after `and` / `or` in the
 * statement (`while i < n and s[i] == ' '`), or the line has a conditional
 * expression. Python then never reads an index past the end there.
 */
export function mayBeSkipped(line: string, col: number): boolean {
  const src = stripStrings(line);
  // The statement's own keyword is not a condition of the subscript.
  const lead = /^\s*(?:if|elif|while|return|assert|yield)\b/.exec(src)?.[0].length ?? 0;
  if (/\b(?:and|or)\b/.test(src.slice(lead, col)) || /\bif\b/.test(src.slice(lead))) return true;
  // A lambda's body, or a one-line body (`if n in memo: return memo[n]`,
  // `def f(): …`) after the colon: it may not run at all on this line.
  if (/\blambda\b/.test(src.slice(0, col))) return true;
  return /^\s*(?:if|elif|else|while|for|except|def|class)\b/.test(src) && colonBefore(src, col);
}

/** A `:` outside brackets before column `col`: a compound statement's own colon (not a slice, a dict or `:=`). */
function colonBefore(src: string, col: number): boolean {
  let depth = 0;
  for (let i = 0; i < col && i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ':' && depth === 0 && src[i + 1] !== '=') return true;
  }
  return false;
}

/**
 * The subscript at `col` is assigned to (`memo[n] = ans`, the left side of
 * `a[i], a[j] = a[j], a[i]`, `x = memo[n] = 0`): its key need not exist
 * before the line. `memo[n] += 1` reads it first, so it is no target.
 * Inside brackets opened before it, it is an argument or an item, not a
 * target: `end=` in `print(memo[n], end=" ")` is a keyword argument.
 */
function isTarget(line: string, col: number): boolean {
  const src = stripStrings(line);
  let depth = 0;
  for (let i = 0; i < col; i++) {
    if ('([{'.includes(src[i])) depth++;
    else if (')]}'.includes(src[i])) depth = Math.max(0, depth - 1);
    else if (src[i] === ';') depth = 0;
  }
  if (depth > 0) return false;
  for (let i = col; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      // Inside a call, or the key of another subscript (`d[memo[n]] = 1`): read.
      if (--depth < 0) return false;
    } else if (depth > 0) continue;
    else if (c === ';') return false; // the next statement
    else if (c === '=' && src[i + 1] !== '=' && !'=!<>:+-*/%&|^@'.includes(src[i - 1])) return true;
  }
  return false;
}

/** Names a line binds itself: comprehension / generator targets and lambda parameters. */
export function boundOnLine(line: string): { comp: Set<string>; gen: Set<string>; lambda: Set<string> } {
  const src = stripStrings(line);
  const out = { comp: new Set<string>(), gen: new Set<string>(), lambda: new Set<string>() };
  const opens: string[] = [];
  const ids = (t: string) => t.match(/[A-Za-z_]\w*/g) ?? [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if ('([{'.includes(ch)) opens.push(ch);
    else if (')]}'.includes(ch)) opens.pop();
    if (!/[A-Za-z_]/.test(ch) || (i > 0 && /[\w.]/.test(src[i - 1]))) continue;
    const word = /^[A-Za-z_]\w*/.exec(src.slice(i))![0];
    if (word === 'for' && opens.length) {
      // `[f(c) for c in kids]`: the targets run up to the `in` of this for.
      const m = /^(.*?)\bin\b/.exec(src.slice(i + 3));
      if (m) for (const n of ids(m[1])) (opens[opens.length - 1] === '(' ? out.gen : out.comp).add(n);
    } else if (word === 'lambda') {
      const m = /^([^:]*):/.exec(src.slice(i + 6));
      if (m) for (const part of m[1].split(',')) for (const n of ids(part.split('=')[0]).slice(0, 1)) out.lambda.add(n);
    }
    i += word.length - 1;
  }
  return out;
}

/** One token: an int, a name, an operator, or a plain '…' / "…" string (no prefix: f"{k}" is not evaluated). */
const TOKEN = /\s*(\d+|[A-Za-z_]\w*|\/\/|[-+*%()]|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/y;
const ESCAPES: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', t: '\t' };

/** The value of a string token, or undefined for an escape it does not know (\x41, \N{…}). */
function strValue(tok: string): string | undefined {
  let out = '';
  for (let i = 1; i < tok.length - 1; i++) {
    if (tok[i] !== '\\') {
      out += tok[i];
      continue;
    }
    const e = ESCAPES[tok[++i]];
    if (e === undefined) return undefined;
    out += e;
  }
  return out;
}

/** Evaluates + - * // % and unary minus over ints, names, len(name) and string literals (`seen["b"]`). */
class Expr {
  private i = 0;
  private readonly toks: string[] = [];
  constructor(text: string, private readonly lookup: (name: string) => Val | undefined, private readonly lenOf: (name: string) => number | undefined) {
    const re = new RegExp(TOKEN.source, 'y');
    for (let pos = 0; text.slice(pos).trim();) {
      re.lastIndex = pos;
      const m = re.exec(text);
      if (!m) {
        this.toks = ['?']; // something else: a call, an attribute, a float
        return;
      }
      this.toks.push(m[1]);
      pos = re.lastIndex;
    }
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
    if (t[0] === '"' || t[0] === "'") return strValue(t);
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
type Cursor = { enc: Encoded } | { row: Encoded[]; len: number };

/** One subscript applied: the item, why there is none, or "exists but was not sent". */
type Got<T> = { item: T } | { miss: Miss } | { cut: true } | undefined;

/**
 * items[key] of a sequence of `len` items (items may be the first ones only).
 * A negative key counts from the end only when the code wrote it so
 * (`a[-1]`, `s[-1 - i]`): a computed -1 (`a[j]` with j = -1) is usually
 * guarded by `j >= 0` and never read; unless the line raised IndexError
 * and the key is below -len (`a[i]` with i = -5, len 4).
 */
function at<T>(items: T[], len: number, key: Val, literal: boolean, indexError: boolean): Got<T> {
  if (typeof key !== 'number') return undefined;
  if (key < 0 && !literal && !(indexError && key < -len)) return undefined;
  // Outside the true length, not just past the items sent: IndexError.
  if (key >= len || key < -len) return { miss: { index: key, len } };
  const i = key < 0 ? len + key : key;
  return i < items.length ? { item: items[i] } : { cut: true };
}

function index(cur: Cursor, key: Val, literal: boolean, heap: Heap, indexError: boolean): Got<Cursor> {
  const wrap = (g: Got<Encoded>): Got<Cursor> => (g && 'item' in g ? { item: { enc: g.item } } : g);
  if ('row' in cur) return wrap(at(cur.row, cur.len, key, literal, indexError));
  const c = cur.enc;
  if (typeof c === 'string') {
    const chars = [...c]; // code points, as Python indexes a str
    return wrap(at(chars, chars.length, key, literal, indexError));
  }
  if (!isRef(c)) return undefined;
  const n: HeapNode | null | undefined = heap[String(c.ref)];
  if (!n) return undefined;
  if (n.kind === 'dict') {
    const entries = n.entries ?? [];
    const found = entries.find(([k]) => sameKey(k, key));
    if (found) return { item: { enc: found[1] } };
    const text = typeof key === 'string' ? pyStr(key) : String(key);
    // A cut dict may or may not hold the key among the entries not sent:
    // never "(not shown)", which says it exists (every memo miss of a big DP).
    const len = n.len ?? entries.length;
    return { miss: len > entries.length ? { key: text, sent: entries.length, len } : { key: text } };
  }
  if (n.kind === 'ndarray' && n.rows) {
    const got = at(n.rows, n.shape?.[0] ?? n.rows.length, key, literal, indexError);
    return got && 'item' in got ? { item: { row: got.item, len: n.shape?.[1] ?? got.item.length } } : got;
  }
  if (!n.items) return undefined;
  // Long arrays and lists send their first items only, plus their length.
  return wrap(at(n.items, n.len ?? (n.kind === 'ndarray' ? n.shape?.[0] : undefined) ?? n.items.length, key, literal, indexError));
}

/** Where the line runs: which frame, and whether it is the line's first event there. */
export interface WatchContext {
  /** Function of the running frame ('<module>', '<lambda>', '<genexpr>', ...). */
  func: string;
  /** The previous step was not this line in this frame: nothing on it ran yet. */
  firstOnLine: boolean;
  /**
   * How the line ended (traceModel.lineOutcome); without it, as 'ended'.
   * A miss is shown (in red) only where Python really reads it: not behind
   * `i < n and`, and not when the error came out of a call on the line.
   */
  outcome?: LineOutcome;
}

const raisedOf = (o: LineOutcome | undefined) => (typeof o === 'object' ? o.raised : undefined);

/**
 * Watches for one source line. `vars` maps the names the running frame sees
 * (its locals over the module's) to their encoded values at this step.
 */
export function watchesFor(line: string, vars: Map<string, Encoded>, heap: Heap, ctx?: WatchContext): Watch[] {
  const out: Watch[] = [];
  const seen = new Set<string>();
  const lookup = (name: string): Val | undefined => scalarOf(vars.get(name));
  const lenOf = (name: string): number | undefined => {
    const v = vars.get(name);
    if (typeof v === 'string') return [...v].length;
    if (!isRef(v)) return undefined;
    const n = heap[String(v.ref)];
    if (!n) return undefined;
    if (n.kind === 'ndarray') return n.shape?.[0];
    return n.len ?? n.items?.length ?? n.entries?.length ?? n.rows?.length;
  };
  // A name the line binds itself has another value inside the comprehension
  // or lambda than the one in the frame (or none yet).
  const bound = boundOnLine(line);
  const hidden = new Set<string>();
  if (ctx?.func !== '<lambda>') bound.lambda.forEach((n) => hidden.add(n));
  if (ctx?.func !== '<genexpr>') bound.gen.forEach((n) => hidden.add(n));
  if (!ctx || ctx.func === '<module>' || ctx.firstOnLine) bound.comp.forEach((n) => hidden.add(n));
  const outcome = ctx?.outcome ?? 'ended';
  const raised = raisedOf(outcome);
  /** Misses behind `and` / `or` / a conditional: Python may have skipped them. */
  const guarded = new Set<Watch>();
  for (const sub of subscriptsOf(line)) {
    if (out.length >= MAX_WATCHES) break;
    const text = sub.text.replace(/\s+(?=\[)/g, '');
    if (seen.has(text)) continue;
    if ((stripStrings(text).match(/[A-Za-z_]\w*/g) ?? []).some((n) => hidden.has(n))) continue;
    const root = vars.get(sub.name);
    if (root === undefined) continue;
    let got: Got<Cursor> = { item: { enc: root } };
    for (const ix of sub.indexes) {
      const key = new Expr(ix, lookup, lenOf).run();
      got = key === undefined ? undefined : index(got.item, key, ix.trimStart().startsWith('-'), heap, raised === 'IndexError');
      if (!got || !('item' in got)) break;
    }
    if (!got) continue;
    if ('cut' in got) {
      // The value exists: silence would read as a missing subscript.
      seen.add(text);
      out.push({ text, value: null, notShown: true });
      continue;
    }
    if ('miss' in got) {
      const miss = got.miss;
      if ('key' in miss && miss.sent !== undefined && readWithoutError(line, sub.start, outcome)) {
        // A key Python read without KeyError exists: of a cut dict, it was only not sent (memo[650] of 700).
        seen.add(text);
        out.push({ text, value: null, notShown: true });
        continue;
      }
      if (!reads(miss, line, sub.start, outcome)) continue;
      seen.add(text);
      const w: Watch = { text, value: null, outOfRange: got.miss };
      if (mayBeSkipped(line, sub.start)) guarded.add(w);
      out.push(w);
      continue;
    }
    if (!('enc' in got.item)) continue; // a whole ndarray row
    seen.add(text);
    out.push({ text, value: got.item.enc });
  }
  // The line raised it: a miss nothing can skip did (`a[i] > 0 and a[i + 1] > 0`
  // stops at a[i]), not one behind a guard. With only guarded misses the
  // guard is the bug (`i <= len(a) and a[i]`): they stay.
  if (raised && guarded.size && out.some((w) => w.outOfRange && !guarded.has(w))) return out.filter((w) => !guarded.has(w));
  return out;
}

/**
 * Python read this subscript and it did not fail: the line ran on without an
 * error, nothing on it can skip the read (`if n in memo: return memo[n]`
 * skips it for every missing n), and it is not an assignment target.
 */
function readWithoutError(line: string, col: number, outcome: LineOutcome): boolean {
  return outcome === 'ran' && !mayBeSkipped(line, col) && !/^\s*for\b/.test(line) && !isTarget(line, col);
}

/** Python reads this failing subscript: the line raised it, or nothing on the line can skip it. */
function reads(miss: Miss, line: string, col: number, outcome: LineOutcome): boolean {
  if (typeof outcome === 'object') return outcome.raised === ('key' in miss ? 'KeyError' : 'IndexError');
  // A key can be missing for many good reasons (a defaultdict, `in` checks): only the error says so.
  // 'ran' and 'unknown': the line did not fail on it.
  if ('key' in miss || outcome !== 'ended') return false;
  // The trace ended on this line (a limit), with the values from before it
  // ran. A `for` header evaluates its iterable once, not on every pass.
  return !mayBeSkipped(line, col) && !/^\s*for\b/.test(line) && !mayChangeBefore(line, col);
}

/** Calls that change none of their arguments: print(a) before a[4] leaves a as it is. */
const PURE_CALLS = new Set(['print', 'len', 'range', 'min', 'max', 'abs', 'sum', 'int', 'float', 'str', 'bool', 'list', 'tuple', 'set',
  'dict', 'sorted', 'reversed', 'enumerate', 'zip', 'isinstance', 'type', 'ord', 'chr', 'round', 'any', 'all', 'divmod', 'pow']);
const KEYWORDS = /^(?:if|elif|while|and|or|not|in|is|return|yield|assert|del|lambda|for|else|await)$/;

/**
 * A call before column `col` may change the container first: in
 * `a.append(5); y = a[4]` the subscript reads a 5-item list, not the 4
 * items of the step before the line.
 */
function mayChangeBefore(line: string, col: number): boolean {
  for (const m of stripStrings(line).slice(0, col).matchAll(/(\.\s*)?\b([A-Za-z_]\w*)\s*\(/g)) {
    if (m[1] || (!PURE_CALLS.has(m[2]) && !KEYWORDS.test(m[2]))) return true;
  }
  return false;
}
