/**
 * What the traced source says about how names are used: which names index
 * which sequences (a[i], dp[i][j]), which sequences are scanned (len(a),
 * for x in a), and which names each function binds locally. The views use
 * it to draw a pointer only where the code really uses it as an index, so
 * an unrelated `i` or an outer frame's `mid` does not land on every array.
 *
 * A heuristic scan, not a parser: it only has to be right for the way
 * learners write algorithms, and it must never throw on odd input.
 * DOM-free so it can be unit tested.
 */

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);

export interface IndexUse {
  /** Identifiers per subscript position: a[i] -> [{i}], dp[i - 1][j] -> [{i}, {j}]. */
  dims: Array<Set<string>>;
  /** Identifiers of the first two positions of each 2-D subscript, in source order. */
  pairs: Array<[string[], string[]]>;
}

export interface FuncInfo {
  /** Parameters, assignment / loop / with / import targets and nested defs, minus global/nonlocal names. */
  locals: Set<string>;
  /** Every identifier in the body (nested function bodies excluded). */
  mentions: Set<string>;
}

export interface SourceHints {
  /** Subscript uses by base name; `self.items[i]` is recorded as `self.items` and `items`. */
  index: Map<string, IndexUse>;
  /** The reverse: for each name used inside a subscript, the bases it indexes. */
  indexes: Map<string, Set<string>>;
  /** Names passed to len() / enumerate() / zip() / reversed() or iterated by a for loop. */
  scanned: Set<string>;
  /** Every identifier in the source. */
  idents: Set<string>;
  /** Names assigned a plain len(...): sizes such as n, m, rows, cols, not positions. */
  sizes: Set<string>;
  /** By function name; functions sharing a name (two __init__) are merged. */
  funcs: Map<string, FuncInfo>;
}

/** The source with comments removed and string contents blanked; newlines are kept so lines still line up. */
export function blankStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = src.startsWith(c + c + c, i) ? c + c + c : c;
      out.push(q);
      i += q.length;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(' ', src[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (src.startsWith(q, i)) {
          out.push(q);
          i += q.length;
          break;
        }
        if (q.length === 1 && src[i] === '\n') break; // unterminated: stop at the line end
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

const OPEN = '([{';
const CLOSE = ')]}';

/** Index of the bracket closing the one at `at`, or -1. */
function matching(t: string, at: number): number {
  let depth = 0;
  for (let k = at; k < t.length; k++) {
    if (OPEN.includes(t[k])) depth++;
    else if (CLOSE.includes(t[k])) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** `t` with everything inside brackets (at any depth) replaced by spaces. */
function flatten(t: string, brackets = '[{('): string {
  let depth = 0;
  let out = '';
  for (const ch of t) {
    if (OPEN.includes(ch) && brackets.includes(ch)) {
      depth++;
      out += ' ';
    } else if (CLOSE.includes(ch) && brackets.includes(OPEN[CLOSE.indexOf(ch)])) {
      depth = Math.max(0, depth - 1);
      out += ' ';
    } else out += depth > 0 ? ' ' : ch;
  }
  return out;
}

/** Split at commas outside brackets. */
function splitTop(t: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of t) {
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const IDENT = /(?<![\w.])[A-Za-z_]\w*/g;

/** Plain identifiers of an expression: not attributes, not keywords, not called names, not inside [ ] or { }. */
function exprIdents(t: string): string[] {
  const flat = flatten(t, '[{');
  const out: string[] = [];
  for (const m of flat.matchAll(IDENT)) {
    const name = m[0];
    if (KEYWORDS.has(name)) continue;
    const after = flat.slice((m.index ?? 0) + name.length).trimStart();
    if (after.startsWith('(')) continue; // len(a), min(i, j): the function is not an index
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Names bound by an assignment target list: `a, b`, `(x, y)`, `*rest`; not `a[i]` or `self.x`. */
function targetNames(t: string): string[] {
  const flat = flatten(t, '[{');
  const out: string[] = [];
  for (const m of flat.matchAll(IDENT)) {
    const name = m[0];
    if (KEYWORDS.has(name)) continue;
    const after = t.slice((m.index ?? 0) + name.length).trimStart();
    if (after.startsWith('[') || after.startsWith('.') || after.startsWith('(')) continue;
    out.push(name);
  }
  return out;
}

function addIndex(map: Map<string, IndexUse>, base: string, dims: string[][]): void {
  let use = map.get(base);
  if (!use) map.set(base, (use = { dims: [], pairs: [] }));
  dims.forEach((names, k) => {
    const set = (use!.dims[k] ??= new Set());
    for (const n of names) set.add(n);
  });
  if (dims.length >= 2 && (dims[0].length || dims[1].length)) {
    const key = JSON.stringify([dims[0], dims[1]]);
    if (!use.pairs.some((p) => JSON.stringify(p) === key)) use.pairs.push([dims[0], dims[1]]);
  }
}

function scanSubscripts(b: string, index: Map<string, IndexUse>): void {
  for (let p = b.indexOf('['); p >= 0; p = b.indexOf('[', p + 1)) {
    let q = p;
    while (q > 0 && /[\w.]/.test(b[q - 1])) q--;
    const base = b.slice(q, p);
    if (!/^[A-Za-z_]/.test(base) || base.endsWith('.')) continue; // a list literal, (x)[i], "s"[i]
    const last = base.slice(base.lastIndexOf('.') + 1);
    if (KEYWORDS.has(last)) continue; // `in [1, 2]`, `return [x]`
    const dims: string[][] = [];
    let r = p;
    while (r < b.length && b[r] === '[') {
      const close = matching(b, r);
      if (close < 0) break;
      for (const part of splitTop(b.slice(r + 1, close), ',')) dims.push(exprIdents(part));
      r = close + 1;
    }
    if (!dims.length) continue;
    addIndex(index, base, dims);
    if (last !== base) addIndex(index, last, dims);
  }
}

function scanIterated(b: string, scanned: Set<string>): void {
  const one = [/\b(?:len|enumerate|reversed|iter)\(\s*([A-Za-z_][\w.]*)\s*[),]/g, /\bfor\s+[\w\s,()*]+?\s+in\s+([A-Za-z_][\w.]*)\s*(?=[:\])\n]|\bif\b|$)/g];
  for (const re of one) {
    for (const m of b.matchAll(re)) {
      scanned.add(m[1]);
      scanned.add(m[1].slice(m[1].lastIndexOf('.') + 1));
    }
  }
  for (const m of b.matchAll(/\bzip\(([^()]*)\)/g)) for (const n of exprIdents(m[1])) scanned.add(n);
}

interface Logical {
  line: number;
  indent: number;
  text: string;
}

/** Physical lines joined while brackets are open or a line ends with a backslash. */
function logicalLines(b: string): Logical[] {
  const out: Logical[] = [];
  const lines = b.split('\n');
  let cur: Logical | undefined;
  let depth = 0;
  lines.forEach((raw, i) => {
    if (!cur) {
      if (!raw.trim()) return;
      cur = { line: i, indent: raw.length - raw.trimStart().length, text: raw.trim() };
    } else cur.text += ' ' + raw.trim();
    for (const ch of raw) {
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && !raw.endsWith('\\')) {
      out.push(cur);
      cur = undefined;
    }
  });
  if (cur) out.push(cur);
  return out;
}

const COMPOUND = /^(if|elif|else|for|async\s+for|while|with|async\s+with|try|except|finally)\b/;

/** One statement, plus the body after `:` of a one-line compound statement. */
function statements(text: string): string[] {
  const out: string[] = [];
  for (const part of splitTop(text, ';')) {
    const st = part.trim();
    if (!st) continue;
    out.push(st);
    if (COMPOUND.test(st)) {
      const flat = flatten(st);
      const colon = flat.search(/:(?!=)/);
      if (colon >= 0 && colon < st.length - 1) out.push(...statements(st.slice(colon + 1)));
    }
  }
  return out;
}

/** Names a statement binds in its scope, and names it declares global/nonlocal. */
function bindings(st: string, bound: Set<string>, declared: Set<string>): void {
  let m: RegExpMatchArray | null;
  if ((m = st.match(/^(?:global|nonlocal)\s+(.*)$/))) {
    for (const n of m[1].split(',')) declared.add(n.trim());
    return;
  }
  if ((m = st.match(/^(?:async\s+)?for\s+(.+?)\s+in\b/))) for (const n of targetNames(m[1])) bound.add(n);
  for (const a of st.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) bound.add(a[1]);
  for (const a of st.matchAll(/([A-Za-z_]\w*)\s*:=/g)) bound.add(a[1]);
  if ((m = st.match(/^import\s+(.*)$/))) for (const n of m[1].split(',')) bound.add(n.trim().split(/[\s.]/)[0]);
  if ((m = st.match(/^from\s+\S+\s+import\s+(.*)$/))) for (const n of m[1].replace(/[()]/g, '').split(',')) bound.add(n.trim().split(/\s/)[0]);
  if (COMPOUND.test(st) || /^(return|yield|assert|raise|del|print|lambda)\b/.test(st)) return;
  if ((m = st.match(/^([A-Za-z_]\w*)\s*:(?!=)/))) bound.add(m[1]); // annotated `x: int = 0`
  const aug = flatten(st).match(/^(.*?)(?:\/\/|\*\*|>>|<<|[-+*/%@&|^])=/);
  if (aug) {
    for (const n of targetNames(st.slice(0, aug[1].length))) bound.add(n);
    return;
  }
  // `a = b = 0`: every part before the last bare `=` is a target.
  const flat = flatten(st);
  const parts: number[] = [];
  for (let k = 0; k < flat.length; k++) {
    if (flat[k] !== '=') continue;
    const prev = flat[k - 1] ?? '';
    const next = flat[k + 1] ?? '';
    if (next === '=' || '=!<>:'.includes(prev)) {
      if (next === '=') k++;
      continue;
    }
    parts.push(k);
  }
  let start = 0;
  for (const at of parts) {
    for (const n of targetNames(st.slice(start, at))) bound.add(n);
    start = at + 1;
  }
}

interface Block {
  kind: 'def' | 'class';
  name: string;
  indent: number;
  /** index into the logical lines of the header */
  head: number;
  /** first logical line after the body */
  end: number;
  params: string[];
}

function blocks(lines: Logical[]): Block[] {
  const out: Block[] = [];
  lines.forEach((l, i) => {
    const m = l.text.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(\()?/);
    if (!m) return;
    let params: string[] = [];
    if (m[1] === 'def' && m[3]) {
      const open = l.text.indexOf('(', m[0].length - 1);
      const close = matching(l.text, open);
      if (close > open) {
        params = splitTop(l.text.slice(open + 1, close), ',')
          .map((p) => p.trim().replace(/^\*{1,2}/, '').match(/^[A-Za-z_]\w*/)?.[0] ?? '')
          .filter((p) => p !== '');
      }
    }
    let end = i + 1;
    // A one-line body (`def f(x): return x`) has no indented lines.
    while (end < lines.length && lines[end].indent > l.indent) end++;
    out.push({ kind: m[1] as 'def' | 'class', name: m[2], indent: l.indent, head: i, end, params });
  });
  return out;
}

function funcInfo(lines: Logical[], all: Block[], f: Block): FuncInfo {
  const bound = new Set<string>(f.params);
  const declared = new Set<string>();
  const mentions = new Set<string>();
  const header = lines[f.head].text;
  const colon = flatten(header).search(/:(?!=)/);
  const inline = colon >= 0 ? header.slice(colon + 1).trim() : '';
  const body: string[] = inline ? [inline] : [];
  for (let i = f.head + 1; i < f.end; i++) {
    const nested = all.find((b) => b.head === i);
    if (nested) {
      bound.add(nested.name);
      i = nested.end - 1;
      continue;
    }
    body.push(lines[i].text);
  }
  for (const text of body) {
    for (const m of text.matchAll(IDENT)) if (!KEYWORDS.has(m[0])) mentions.add(m[0]);
    for (const st of statements(text)) bindings(st, bound, declared);
  }
  for (const d of declared) bound.delete(d);
  return { locals: bound, mentions };
}

/** `n = len(a)`, `rows, cols = len(grid), len(grid[0])`. */
function sizeNames(lines: Logical[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    for (const st of statements(l.text)) {
      const m = st.match(/^([A-Za-z_][\w\s,]*?)\s*=(?!=)\s*(.+)$/);
      if (!m) continue;
      const lhs = m[1].split(',').map((x) => x.trim());
      const rhs = splitTop(m[2], ',').map((x) => x.trim());
      if (lhs.length !== rhs.length) continue;
      lhs.forEach((name, k) => {
        if (/^len\(/.test(rhs[k]) && matching(rhs[k], 3) === rhs[k].length - 1) out.add(name);
      });
    }
  }
  return out;
}

export function parseSource(src: string): SourceHints {
  const b = blankStrings(src);
  const index = new Map<string, IndexUse>();
  const scanned = new Set<string>();
  const idents = new Set<string>();
  scanSubscripts(b, index);
  scanIterated(b, scanned);
  for (const m of b.matchAll(IDENT)) idents.add(m[0]);
  const lines = logicalLines(b);
  const all = blocks(lines);
  const indexes = new Map<string, Set<string>>();
  for (const [base, use] of index) {
    for (const dim of use.dims) for (const n of dim ?? []) {
      let set = indexes.get(n);
      if (!set) indexes.set(n, (set = new Set()));
      set.add(base);
    }
  }
  const funcs = new Map<string, FuncInfo>();
  for (const f of all) {
    if (f.kind !== 'def') continue;
    const info = funcInfo(lines, all, f);
    const prev = funcs.get(f.name);
    if (!prev) funcs.set(f.name, info);
    else {
      for (const n of info.locals) prev.locals.add(n);
      for (const n of info.mentions) prev.mentions.add(n);
    }
  }
  return { index, indexes, scanned, idents, sizes: sizeNames(lines), funcs };
}

let cache: { src: string; hints: SourceHints } | undefined;

/** parseSource, cached for the trace on screen (every step render asks again). */
export function sourceHints(src: string): SourceHints {
  if (cache?.src !== src) cache = { src, hints: parseSource(src) };
  return cache.hints;
}

/** Identifiers used in the first subscript position of any of `names` (a[i], a[i:j]). */
export function indexNamesOf(h: SourceHints, names: Iterable<string>, dim = 0): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const x of h.index.get(n)?.dims[dim] ?? []) out.add(x);
  return out;
}

/** True when any of `names` is subscripted or iterated in the source. */
export function isScanned(h: SourceHints, names: Iterable<string>): boolean {
  for (const n of names) if (h.scanned.has(n) || h.index.has(n)) return true;
  return false;
}
