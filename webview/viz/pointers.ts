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
import { Encoded, isRef } from '../format';
import { Var, isPointerName } from './common';
import { BOUND_NAME, BOUND_PAIRS } from './names';
import { SourceHints, indexNamesOf, isScanned } from './sourceHints';

export interface FrameLike {
  func: string;
  locals: Array<[string, Encoded]>;
}

export interface Pointer {
  name: string;
  index: number;
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
  return typeof a === 'string' && a === b;
}

function isInt(v: Encoded): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export function pointerFrame(target: Encoded, depth: number, frames: FrameLike[], hints?: SourceHints): PointerFrame {
  const aliases = new Set<string>();
  let holder = -1;
  frames.forEach((f, d) => {
    for (const [n, v] of f.locals) {
      if (!sameTarget(v, target)) continue;
      aliases.add(n);
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

/** Pointers into a sequence of length `len`; a pointer may sit one past the end (a finished loop). */
export function sequencePointers(target: Encoded, depth: number, len: number, frames: FrameLike[], hints: SourceHints): { pointers: Pointer[]; at: PointerFrame } {
  const at = pointerFrame(target, depth, frames, hints);
  const pointers: Pointer[] = [];
  if (len === 0) return { pointers, at };
  const idx = indexNamesOf(hints, at.aliases, 0);
  const scanned = isScanned(hints, at.aliases);
  for (const [n, v] of frames[at.frame]?.locals ?? []) {
    if (!isInt(v) || v < 0 || v > len) continue;
    if (idx.has(n) || (scanned && BOUND_NAME.test(n) && !indexesOther(hints, n, at.aliases))) pointers.push({ name: n, index: v });
  }
  return { pointers, at };
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

/** Ranges between bound pairs (lo..hi, left..right ...) of the drawn pointers, inclusive, clamped to the sequence. */
export function boundRanges(pointers: Pointer[], len: number): Range[] {
  const out: Range[] = [];
  const by = new Map(pointers.map((p) => [p.name.toLowerCase(), p]));
  for (const [a, b] of BOUND_PAIRS) {
    const pa = by.get(a);
    const pb = by.get(b);
    if (!pa || !pb || pa.index > pb.index || len === 0) continue;
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

export function matrixPointers(target: Encoded, depth: number, rows: number, cols: number, frames: FrameLike[], hints: SourceHints): MatrixMarks {
  const at = pointerFrame(target, depth, frames, hints);
  const ints = new Map<string, number>();
  for (const [n, v] of frames[at.frame]?.locals ?? []) if (isInt(v)) ints.set(n, v);
  const rowNames = indexNamesOf(hints, at.aliases, 0);
  const colNames = indexNamesOf(hints, at.aliases, 1);
  const pick = (names: Iterable<string>, limit: number, not?: string): Pointer | undefined => {
    for (const n of names) {
      const v = ints.get(n);
      if (v !== undefined && n !== not && v >= 0 && v < limit) return { name: n, index: v };
    }
    return undefined;
  };
  const marks: MatrixMarks = { probes: [], rowNames, colNames, at };
  const seen = new Set<string>();
  for (const a of at.aliases) {
    for (const [rs, cs] of hints.index.get(a)?.pairs ?? []) {
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
  }
  if (!marks.row) {
    marks.row = pick(rowNames, rows);
    marks.col = pick(colNames, cols, marks.row?.name);
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
