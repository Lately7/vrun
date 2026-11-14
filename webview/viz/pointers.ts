/**
 * Which int locals are drawn as pointers on a sequence or as the
 * highlighted row / column of a matrix, and from which frame.
 *
 * With the traced source a pointer must (a) come from the frame that works
 * on the object: the innermost frame holding an alias of it, or an inner
 * function that reaches it as a global / closure name; and (b) index an
 * alias in the source (a[j], nums[mid], a[:mid]) or be a bound name
 * (lo, hi, left, right ...) of a sequence the source scans. Without the
 * source the old rule applies: any int local with a pointer-like name.
 * DOM-free.
 */
import { Encoded, Heap, isRef, isTagged } from '../format';
import { Var, isPointerName } from './common';
import { BOUND_NAME, BOUND_PAIRS } from './names';
import { IndexUse, SourceHints, exprsOf, indexNamesOf, isLive, isScanned, lineSubscripts, plainNamesOf } from './sourceHints';

export interface FrameLike {
  func: string;
  /** Line the frame is at (1-based), when known. */
  line?: number;
  locals: Array<[string, Encoded]>;
}

/** A container held in an object's field (self.heap): the frames holding the object index it. */
export interface FieldOf {
  owner: Encoded;
  field: string;
}

export interface Pointer {
  name: string;
  index: number;
  /** It is len, and the running frame's line surely subscripts the sequence with it (no guard skips it): an IndexError. */
  outOfRange?: boolean;
}

export interface PointerFrame {
  /** Index into the frames of the frame whose ints are pointers. */
  frame: number;
  /** Every name any frame gives the object. */
  aliases: string[];
  /** The object's name in that frame, when it has one. */
  local?: string;
}

/** Same list object (heap id), or the same string value (strings have no identity in the trace). */
export function sameTarget(a: Encoded, b: Encoded): boolean {
  if (isRef(a)) return isRef(b) && a.ref === b.ref;
  if (typeof a === 'string') return a === b;
  // A long string is sent cut, with its true length: s[i] past the cut still points into it.
  return isTagged(a) && isTagged(b) && a.$t === 'str' && b.$t === 'str' && a.v === b.v && a.len === b.len;
}

function isInt(v: Encoded): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export function pointerFrame(target: Encoded, depth: number, frames: FrameLike[], hints?: SourceHints, via?: FieldOf): PointerFrame {
  const aliases = new Set<string>();
  let holder = -1;
  if (via) aliases.add(via.field); // self.heap[i] is recorded under `heap` too
  frames.forEach((f, d) => {
    for (const [n, v] of f.locals) {
      if (sameTarget(v, target)) aliases.add(n);
      else if (!(via && sameTarget(v, via.owner))) continue;
      holder = d;
    }
  });
  if (holder < 0) holder = Math.max(0, Math.min(depth, frames.length - 1));
  let frame = holder;
  // A module-level (or enclosing) list used inside a function without a
  // local alias: that function's frame does the indexing. A name the
  // function binds itself (merge_sort's own `left`) is a different object.
  if (hints) {
    for (let d = frames.length - 1; d > holder; d--) {
      const info = hints.funcs.get(frames[d].func);
      if (info && [...aliases].some((a) => info.mentions.has(a) && !info.locals.has(a))) {
        frame = d;
        break;
      }
    }
  }
  const local = frames[frame]?.locals.find(([, v]) => sameTarget(v, target))?.[0];
  return { frame, aliases: [...aliases], local };
}

/**
 * Pointers into a sequence of length `len`; a pointer may sit one past the end (a finished loop).
 * A name the code only uses inside an index expression (s[i - 1], dp[a - c])
 * is not where the code looks: the expression is drawn instead ('i-1').
 */
export function sequencePointers(target: Encoded, depth: number, len: number, frames: FrameLike[], hints: SourceHints, via?: FieldOf, heap?: Heap): { pointers: Pointer[]; at: PointerFrame } {
  const at = pointerFrame(target, depth, frames, hints, via);
  const pointers: Pointer[] = [];
  if (len === 0) return { pointers, at };
  const idx = indexNamesOf(hints, at.aliases, 0);
  const plain = plainNamesOf(hints, at.aliases, 0);
  const scanned = isScanned(hints, at.aliases);
  const locals = frames[at.frame]?.locals ?? [];
  const ints = new Map<string, number>();
  for (const [n, v] of locals) if (isInt(v)) ints.set(n, v);
  // A bound pair is one range: build(node, l, r) over arr bounds arr, not
  // seg, so neither l nor r (nor the mid computed from them) points into seg.
  const skipped = new Set<string>();
  for (const pair of BOUND_PAIRS) {
    if (pair.some((n) => ints.has(n) && indexesOther(hints, n, at.aliases))) for (const n of pair) skipped.add(n);
  }
  for (const n of ints.keys()) {
    if (BOUND_NAME.test(n) && !plain.has(n) && [...(hints.deps.get(n) ?? [])].some((d) => skipped.has(d))) skipped.add(n);
  }
  // `for start, end in intervals`: start is an item's value, not a position.
  for (const a of at.aliases) for (const t of hints.unpack.get(a) ?? []) for (const n of t) skipped.add(n);
  // nums[j + 1] with j + 1 == len(nums) on the line about to run: the
  // off-by-one that raises IndexError. Only in the running frame (a caller
  // waits inside its line, part of it may not have run), and only where
  // Python surely reads it: not behind `j < n - 1 and`, which is false then.
  const line = at.frame === frames.length - 1 ? frames[at.frame]?.line : undefined;
  const text = line !== undefined ? hints.lines[line - 1] ?? '' : '';
  const guard = guardValues(target, frames, at, len, heap);
  const crashes = (e: string, v: number) => v === len && readsOnLine(text, at.aliases, e, guard);
  for (const [n, v] of ints) {
    if (v < 0 || v > len) continue;
    if (plain.has(n)) pointers.push({ name: n, index: v, outOfRange: crashes(n, v) || undefined });
    else if (idx.has(n) || hints.sizes.has(n) || skipped.has(n)) continue;
    else if (scanned && BOUND_NAME.test(n) && !indexesOther(hints, n, at.aliases)) pointers.push({ name: n, index: v });
  }
  for (const e of exprsOf(hints, at.aliases, 0)) {
    const ids = e.match(/[A-Za-z_]\w*/g) ?? [];
    const v = evalIndex(e, ints);
    // dp[i - 1] next to dp[i] is already shown by i; a[n - 1] is just the
    // end. Not when it is the subscript that is about to fail.
    if (ids.every((n) => plain.has(n) || hints.sizes.has(n)) && !(v !== undefined && crashes(e, v))) continue;
    if (v !== undefined && v >= 0 && v <= len && !pointers.some((p) => p.name === e)) pointers.push({ name: e, index: v, outOfRange: crashes(e, v) || undefined });
  }
  return { pointers, at };
}

/** `e` with optional spaces between its characters, as a regex source: 'j+1' matches 'j + 1'. */
function loose(e: string): string {
  return [...e].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
}

/** What a guard before a subscript is evaluated with: the running frame's ints (over the module's) and lengths. */
export interface GuardValues {
  ints: Map<string, number>;
  lenOf: (name: string) => number | undefined;
}

function guardValues(target: Encoded, frames: FrameLike[], at: PointerFrame, len: number, heap?: Heap): GuardValues {
  const module = at.frame > 0 && frames[0]?.func === '<module>' ? frames[0].locals : [];
  const vals = new Map<string, Encoded>([...module, ...(frames[at.frame]?.locals ?? [])]);
  const ints = new Map<string, number>();
  for (const [n, v] of vals) {
    if (isInt(v)) ints.set(n, v);
    else if (typeof v === 'boolean') ints.set(n, v ? 1 : 0);
  }
  const lenOf = (name: string): number | undefined => {
    const v = vals.get(name);
    // self.heap is read as `heap` too.
    if (v === undefined) return at.aliases.includes(name) ? len : undefined;
    if (sameTarget(v, target)) return len;
    if (typeof v === 'string') return [...v].length;
    const n = isRef(v) ? heap?.[String(v.ref)] : undefined;
    return n ? n.len ?? n.items?.length ?? n.entries?.length : undefined;
  };
  return { ints, lenOf };
}

/**
 * Whether the line surely reads `alias[e]` when it runs: an occurrence that
 * nothing before it can skip, or whose short-circuit guards evaluate so that
 * Python goes on to it. `if j < n - 1 and nums[j] > nums[j + 1]` with
 * j = n - 1 never reads nums[n]: drawing it red would make a learner "fix"
 * correct code.
 */
export function readsOnLine(text: string, aliases: string[], e: string, guard?: GuardValues): boolean {
  // A for header evaluates its iterable once, not on every pass; a one-line
  // def / class body does not run when the header does.
  if (!text || /^\s*(?:for|def|class|async)\b/.test(text)) return false;
  const lead = /^\s*(?:if|elif|while|return|assert|yield)\b/.exec(text)?.[0].length ?? 0;
  // A conditional expression, a comprehension or a lambda decides per value.
  if (/\b(?:if|for|lambda)\b/.test(text.slice(lead))) return false;
  for (const a of aliases) {
    const re = new RegExp(`(^|[^\\w])(${loose(a)}\\s*\\[\\s*${loose(e)}\\s*\\])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (reached(text, lead, m.index + m[1].length, guard)) return true;
    }
  }
  return false;
}

type Op = 'and' | 'or';

/**
 * Python reaches column `col` of the line: on every bracket level around
 * it, the `and` / `or` operands before it in its element (after the last
 * `,` `=` `:`) let evaluation go on; and in a one-line `if c: body` (elif,
 * while) the body runs only when `c` is true.
 */
function reached(text: string, lead: number, col: number, guard?: GuardValues): boolean {
  const levels: Array<{ start: number; ops: Array<[string, Op]> }> = [{ start: lead, ops: [] }];
  const header = /^\s*(?:if|elif|while)\b/.test(text);
  let cond: Array<[string, Op]> | undefined;
  for (let i = lead; i < col; i++) {
    const ch = text[i];
    const top = levels[levels.length - 1];
    if ('([{'.includes(ch)) levels.push({ start: i + 1, ops: [] });
    else if (')]}'.includes(ch)) {
      // A closed group is part of the operand around it.
      if (levels.length > 1) levels.pop();
    } else if (ch === ',' || ch === ':' || (ch === '=' && !/[=<>!]/.test(text[i - 1] ?? '') && text[i + 1] !== '=')) {
      // The header's colon (not a walrus `:=`) ends the condition.
      if (ch === ':' && header && !cond && levels.length === 1 && text[i + 1] !== '=') cond = [...top.ops, [text.slice(top.start, i), 'and']];
      top.start = i + 1;
      top.ops = [];
    } else if ((ch === 'a' || ch === 'o') && !/[\w.]/.test(text[i - 1] ?? '')) {
      const w = /^(and|or)\b/.exec(text.slice(i, i + 4));
      if (w) {
        top.ops.push([text.slice(top.start, i), w[1] as Op]);
        top.start = i + w[1].length;
        i += w[1].length - 1;
      }
    }
  }
  return levels.every((l) => chainReaches(l.ops, guard)) && (!cond || surelyTrue(cond, guard));
}

/** `A and B or C`: true when some `or` group has every operand surely true. */
function surelyTrue(ops: Array<[string, Op]>, guard?: GuardValues): boolean {
  if (!guard) return false;
  const groups: string[][] = [[]];
  for (const [operand, op] of ops) {
    groups[groups.length - 1].push(operand);
    if (op === 'or') groups.push([]);
  }
  return groups.some((g) => g.length > 0 && g.every((operand) => truth(operand, guard) === true));
}

/**
 * `A and B or C and <x>`: Python gets to x when every whole `or` group
 * before it is false and every `and` operand of its own group is true.
 * Anything it cannot evaluate here (a call, a subscript, `in`) counts as
 * maybe skipped.
 */
function chainReaches(ops: Array<[string, Op]>, guard?: GuardValues): boolean {
  if (!ops.length) return true;
  if (!guard) return false;
  const groups: string[][] = [[]];
  for (const [operand, op] of ops) {
    groups[groups.length - 1].push(operand);
    if (op === 'or') groups.push([]);
  }
  const own = groups.pop()!;
  for (const g of groups) {
    let value = true;
    for (const operand of g) {
      const t = truth(operand, guard);
      if (t === undefined) return false;
      if (!t) {
        value = false;
        break;
      }
    }
    if (value) return false; // a true `or` operand skips the rest
  }
  return own.every((operand) => truth(operand, guard) === true);
}

/** Index of the bracket closing the one at s[0], or -1. */
function closing(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if ('([{'.includes(s[i])) depth++;
    else if (')]}'.includes(s[i]) && --depth === 0) return i;
  }
  return -1;
}

/** The truth of a comparison chain over ints and len(name) (`j < n - 1`, `not (i >= len(s))`), or undefined. */
export function truth(cond: string, g: GuardValues): boolean | undefined {
  let s = cond.trim();
  let neg = false;
  for (;;) {
    const not = /^not\b\s*/.exec(s);
    if (not) {
      neg = !neg;
      s = s.slice(not[0].length);
    } else if (s.startsWith('(') && closing(s) === s.length - 1) s = s.slice(1, -1).trim();
    else break;
  }
  if (!s || /\b(?:and|or|not|is|in)\b/.test(s)) return undefined;
  let unknown = false;
  s = s.replace(/\blen\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_m, n: string) => {
    const l = g.lenOf(n);
    if (l === undefined) unknown = true;
    return String(l ?? 0);
  });
  if (unknown) return undefined;
  const parts = s.split(/(<=|>=|==|!=|<|>)/);
  const vals: number[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const v = evalIndex(parts[k].replace(/\s+/g, ''), g.ints);
    if (v === undefined) return undefined;
    vals.push(v);
  }
  let t = vals.length === 1 ? vals[0] !== 0 : true;
  for (let k = 1; k < vals.length && t; k++) {
    const [a, op, b] = [vals[k - 1], parts[2 * k - 1], vals[k]];
    t = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : op === '==' ? a === b : a !== b;
  }
  return neg ? !t : t;
}

/**
 * An int-only arithmetic index (i-1, (lo+hi)//2, 2*i+1) with the frame's
 * ints, as Python computes it; undefined for anything else.
 */
export function evalIndex(expr: string, ints: Map<string, number>): number | undefined {
  const toks = expr.match(/\/\/|\d+|[A-Za-z_]\w*|[-+*%()]/g);
  if (!toks || toks.join('') !== expr) return undefined;
  let k = 0;
  const atom = (): number | undefined => {
    const t = toks[k++];
    if (t === undefined) return undefined;
    if (t === '(') {
      const v = sum();
      return toks[k++] === ')' ? v : undefined;
    }
    if (t === '-' || t === '+') {
      const v = atom();
      return v === undefined ? undefined : t === '-' ? -v : v;
    }
    if (/^\d+$/.test(t)) return Number(t);
    return ints.get(t);
  };
  const product = (): number | undefined => {
    let v = atom();
    while (v !== undefined && (toks[k] === '*' || toks[k] === '//' || toks[k] === '%')) {
      const op = toks[k++];
      const r = atom();
      if (r === undefined || (op !== '*' && r === 0)) return undefined;
      v = op === '*' ? v * r : op === '//' ? Math.floor(v / r) : ((v % r) + r) % r;
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = product();
    while (v !== undefined && (toks[k] === '+' || toks[k] === '-')) {
      const op = toks[k++];
      const r = product();
      if (r === undefined) return undefined;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return k === toks.length && v !== undefined && Number.isSafeInteger(v) ? v : undefined;
}

/**
 * A bound name the source uses only as an index of other sequences
 * (merge sort's `mid` in a[:mid]) does not bound this one (`left`).
 */
function indexesOther(hints: SourceHints, name: string, aliases: string[]): boolean {
  const bases = hints.indexes.get(name);
  return bases !== undefined && bases.size > 0 && !aliases.some((a) => bases.has(a));
}

/** The old rule, for a kernel snapshot without source: int locals with pointer-like names. */
export function legacyPointers(vars: Var[], len: number): Pointer[] {
  const out: Pointer[] = [];
  if (len === 0) return out;
  for (const v of vars) {
    if (!isInt(v.value) || !isPointerName(v.name)) continue;
    if (v.value >= 0 && v.value <= len) out.push({ name: v.name, index: v.value });
  }
  return out;
}

export interface Range {
  from: number;
  to: number;
  names: [string, string];
}

/**
 * Ranges between bound pairs (lo..hi, left..right ...) of the drawn pointers, inclusive, clamped to the sequence.
 * With the source, only pairs the code uses as a range (range(l, r), l <= r,
 * a[l:r], r - l): heap children l and r are two indices, not a window.
 */
export function boundRanges(pointers: Pointer[], len: number, hints?: SourceHints): Range[] {
  const out: Range[] = [];
  const by = new Map(pointers.map((p) => [p.name.toLowerCase(), p]));
  for (const [a, b] of BOUND_PAIRS) {
    const pa = by.get(a);
    const pb = by.get(b);
    if (!pa || !pb || pa.index > pb.index || len === 0) continue;
    if (hints && !hints.rangePairs.has(`${pa.name}\u0000${pb.name}`)) continue;
    const to = Math.min(pb.index, len - 1);
    if (pa.index > to) continue;
    out.push({ from: pa.index, to, names: [pa.name, pb.name] });
  }
  return out;
}

export interface MatrixMarks {
  row?: Pointer;
  col?: Pointer;
  /** Other cells the source indexes with a pair of locals (grid[nr][nc] next to grid[r][c]). */
  probes: Array<{ r: number; c: number; names: [string, string] }>;
  /** Names in the first / second subscript of the matrix, for matching string axes. */
  rowNames: Set<string>;
  colNames: Set<string>;
  at?: PointerFrame;
}

/**
 * The solid cell is the one the line about to run reads or writes
 * (grid[bottom][i] on that line, not grid[top][i] from an earlier loop);
 * without one on the line, names bound in a loop that is still running come
 * before leftovers of a finished setup loop.
 */
export function matrixPointers(target: Encoded, depth: number, rows: number, cols: number, frames: FrameLike[], hints: SourceHints, via?: FieldOf): MatrixMarks {
  const at = pointerFrame(target, depth, frames, hints, via);
  const line = frames[at.frame]?.line;
  const ints = new Map<string, number>();
  for (const [n, v] of frames[at.frame]?.locals ?? []) if (isInt(v)) ints.set(n, v);
  const here = line !== undefined ? lineSubscripts(hints, line) : new Map<string, IndexUse>();
  const onLine = new Set<string>();
  for (const a of at.aliases) for (const dim of here.get(a)?.dims ?? []) for (const n of dim) onLine.add(n);
  const rank = (n: string) => (onLine.has(n) ? 0 : isLive(hints, n, line) ? 1 : 2);
  const ranked = (names: Iterable<string>) => [...names].sort((x, y) => rank(x) - rank(y));
  const rowNames = indexNamesOf(hints, at.aliases, 0);
  const colNames = indexNamesOf(hints, at.aliases, 1);
  // A name left over from a finished loop marks no cell: after the loops,
  // `print(grid)` has no current cell, and the setup loop's `a` is not the row.
  const pick = (names: Iterable<string>, limit: number, not?: string): Pointer | undefined => {
    for (const n of ranked(names)) {
      const v = ints.get(n);
      if (v !== undefined && n !== not && v >= 0 && v < limit && rank(n) < 2) return { name: n, index: v };
    }
    return undefined;
  };
  const marks: MatrixMarks = { probes: [], rowNames, colNames, at };
  const seen = new Set<string>();
  const pairs: Array<[string[], string[]]> = [];
  for (const a of at.aliases) pairs.push(...(here.get(a)?.pairs ?? []));
  const later: Array<[string[], string[]]> = [];
  for (const a of at.aliases) later.push(...(hints.index.get(a)?.pairs ?? []));
  const pairRank = (p: [string[], string[]]) => Math.max(...[...p[0], ...p[1]].map(rank), 0);
  pairs.push(...later.map((p, k) => [p, k] as const).sort((x, y) => pairRank(x[0]) - pairRank(y[0]) || x[1] - y[1]).map(([p]) => p));
  for (const [rs, cs] of pairs) {
    const r = pick(rs, rows);
    const c = pick(cs, cols, r?.name);
    if (!r || !c) continue;
    const id = `${r.name}\u0000${c.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!marks.row) {
      marks.row = r;
      marks.col = c;
    } else if (hints.sizes.has(r.name) || hints.sizes.has(c.name)) {
      // dp[m][n] (the answer cell, m = len(a)) is not a cell the loop is probing.
      continue;
    } else if (r.index !== marks.row.index || c.index !== marks.col!.index) {
      marks.probes.push({ r: r.index, c: c.index, names: [r.name, c.name] });
    }
  }
  if (!marks.row) {
    marks.row = pick(rowNames, rows);
    marks.col = pick(colNames, cols, marks.row?.name);
    // Two names the code never uses together (spiral's top and right) make
    // no cell: keep the row alone.
    const r = marks.row?.name;
    const c = marks.col?.name;
    if (r && c && pairs.length && !pairs.some(([rs, cs]) => rs.includes(r) && cs.includes(c))) marks.col = undefined;
  }
  return marks;
}

// Most specific names first: `w` (current capacity) beats `cap` (the limit).
const ROW_PREF = ['i', 'r', 'row', 'y', 'a'];
const COL_PREF = ['j', 'c', 'col', 'w', 'x', 'b', 'cap'];

/** The old matrix rule for a snapshot without source: preferred names i/r/row and j/c/col. */
export function legacyMatrixPointers(vars: Var[]): MatrixMarks {
  const ints = vars.filter((v) => isInt(v.value) && (isPointerName(v.name) || /^(w|cap|a|b)$/i.test(v.name)));
  const byPreference = (names: string[], exclude?: Var) =>
    names.map((n) => ints.find((v) => v.name.toLowerCase() === n && v !== exclude)).find((v) => v !== undefined);
  const rowVar = byPreference(ROW_PREF);
  const colVar = byPreference(COL_PREF, rowVar);
  const asPtr = (v: Var | undefined): Pointer | undefined => (v && isInt(v.value) ? { name: v.name, index: v.value } : undefined);
  return { row: asPtr(rowVar), col: asPtr(colVar), probes: [], rowNames: new Set(), colNames: new Set() };
}

/** Frames rebuilt from de-duplicated vars when the caller has no frame list. */
export function framesFromVars(vars: Var[]): FrameLike[] {
  const depth = Math.max(0, ...vars.map((v) => v.depth));
  const frames: FrameLike[] = Array.from({ length: depth + 1 }, () => ({ func: '', locals: [] }));
  for (const v of vars) frames[v.depth].locals.push([v.name, v.value]);
  return frames;
}
