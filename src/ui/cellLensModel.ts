/**
 * Pure helpers behind the cell CodeLens and the cell commands (Run Above,
 * Run Cell and Go to Next Cell, Visualize with the cells above). No vscode
 * import, so they are unit-testable.
 */
import { Cell, isCellMarker, splitCells } from '../exec/cells';

/**
 * The worker caps traced code at 200 000 characters; a longer prelude is
 * left out rather than cut mid-statement (the trace then simply runs the
 * cell alone, as before).
 */
export const MAX_PRELUDE_CHARS = 200_000;

/** A line that would run: not blank, not only a comment. */
const CODE_LINE = /^\s*[^\s#]/;

export function cellHasCode(cell: Cell): boolean {
  return cell.text.split(/\r?\n/).some((l) => CODE_LINE.test(l));
}

export interface LensSpot {
  /** 0-based line the lens sits on (the marker line, or 0). */
  line: number;
  cell: Cell;
  /** Cells above this one hold code (Run Above would do something). */
  hasCodeAbove: boolean;
}

/**
 * Where the cell lenses go: on every `# %%` marker line, plus line 0 when
 * the file has markers but code before the first one. A comment-only header
 * (like the practice files') gets no lens: running it does nothing.
 * Files without markers get none; Ctrl+Alt+C runs them whole.
 */
export function cellLensSpots(source: string): LensSpot[] {
  const cells = splitCells(source);
  const lines = source.split(/\r?\n/);
  if (!lines.some(isCellMarker)) return [];
  const spots: LensSpot[] = [];
  let codeAbove = false;
  for (const cell of cells) {
    const marked = isCellMarker(lines[cell.startLine] ?? '');
    if (marked || cellHasCode(cell)) spots.push({ line: cell.startLine, cell, hasCodeAbove: codeAbove });
    codeAbove ||= cellHasCode(cell);
  }
  return spots;
}

/**
 * The line a clicked cell lens means. VS Code fixes a lens's arguments when
 * it draws it, and lines typed or pasted above move the marker before the
 * lenses are redrawn: the old line number then lies in the cell above. So
 * the lens also passes its marker's text, and the nearest line with that
 * text wins (on a tie the one further down, as text is more often added
 * above than removed).
 * The old line stands when the marker itself was edited.
 */
export function lensLine(source: string, line: number, marker: string): number {
  const lines = source.split(/\r?\n/);
  if (lines[line] === marker || !isCellMarker(marker)) return line;
  let best = -1;
  lines.forEach((l, i) => {
    if (l === marker && (best < 0 || Math.abs(i - line) <= Math.abs(best - line))) best = i;
  });
  return best >= 0 ? best : line;
}

/** Index of the cell that contains `line` (clamped into the document). */
function cellIndexAt(cells: Cell[], line: number): number {
  const i = cells.findIndex((c) => line >= c.startLine && line <= c.endLine);
  return i >= 0 ? i : line < 0 ? 0 : cells.length - 1;
}

/** Cells strictly above the one at `line` that have code, in file order. */
export function cellsAbove(source: string, line: number): Cell[] {
  const cells = splitCells(source);
  return cells.slice(0, cellIndexAt(cells, line)).filter(cellHasCode);
}

/**
 * Where "Run Cell and Go to Next Cell" puts the cursor: the first line of
 * the next cell's body (its marker line when it has no body). Undefined on
 * the last cell: the cursor stays, as there is nothing to go to.
 */
export function nextCellLine(source: string, line: number): number | undefined {
  const cells = splitCells(source);
  const next = cells[cellIndexAt(cells, line) + 1];
  if (!next) return undefined;
  return next.endLine > next.startLine ? next.startLine + 1 : next.startLine;
}

/**
 * Text above a traced cell, sent as the trace `prelude` so the cell can use
 * functions, classes, imports and constants from the cells above. The
 * kernel keeps only the statements that are safe to re-run; undefined when
 * there is nothing above or it is too long to send.
 */
export function preludeFor(source: string, cellStartLine: number): string | undefined {
  if (cellStartLine <= 0) return undefined;
  const lines = source.split(/\r?\n/).slice(0, cellStartLine);
  if (!lines.some((l) => CODE_LINE.test(l))) return undefined;
  const text = lines.join('\n');
  return text.length <= MAX_PRELUDE_CHARS ? text : undefined;
}

export interface JupyterState {
  /** ms-toolsai.jupyter is installed and enabled. */
  installed: boolean;
  active: boolean;
  /** jupyter.interactiveWindow.codeLens.enable (Jupyter's own Run Cell lens). */
  codeLensEnabled: boolean;
}

/** Jupyter draws its own "Run Cell" next to vrun's: label ours so they differ. */
export function jupyterLensesShown(j: JupyterState): boolean {
  return j.installed && j.codeLensEnabled;
}

/**
 * The one-time notice about Jupyter's Run Cell. Only once Jupyter is active
 * (its lenses and Shift+Enter are really there) and only while its lenses
 * are on: a learner who already hid them needs no explanation.
 */
export function shouldShowJupyterNotice(j: JupyterState, alreadyShown: boolean): boolean {
  return !alreadyShown && j.installed && j.active && j.codeLensEnabled;
}
