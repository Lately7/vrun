/**
 * Cell detection for plain .py files using the common `# %%` convention.
 * Pure functions (no vscode import) so they are unit-testable.
 */

export interface Cell {
  /** 0-based first line of the cell body (the marker line itself, if any, is included). */
  startLine: number;
  /** 0-based last line (inclusive). */
  endLine: number;
  text: string;
  /** `# %% [live]` — opted in to Live Mode re-execution. */
  live: boolean;
  /** `# pylive: manual` inside the cell — never re-run automatically. */
  manual: boolean;
  title: string;
}

const MARKER = /^\s*#\s*%%(.*)$/;

export function isCellMarker(line: string): boolean {
  return MARKER.test(line);
}

export function splitCells(source: string): Cell[] {
  const lines = source.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (MARKER.test(l)) starts.push(i);
  });
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
  const cells: Cell[] = [];
  for (let k = 0; k < starts.length; k++) {
    const startLine = starts[k];
    const endLine = (k + 1 < starts.length ? starts[k + 1] : lines.length) - 1;
    if (endLine < startLine) continue;
    const body = lines.slice(startLine, endLine + 1);
    const m = MARKER.exec(lines[startLine]);
    const header = m ? m[1].trim() : '';
    cells.push({
      startLine,
      endLine,
      text: body.join('\n'),
      live: /\[live\]/i.test(header),
      manual: body.some((l) => /^\s*#\s*pylive:\s*manual\b/i.test(l)),
      title: header.replace(/\[live\]/i, '').trim(),
    });
  }
  return cells;
}

export function cellAt(source: string, line: number): Cell | undefined {
  return splitCells(source).find((c) => line >= c.startLine && line <= c.endLine);
}

export function hasCellMarkers(source: string): boolean {
  return source.split(/\r?\n/).some(isCellMarker);
}

/**
 * Remove common leading indentation so a selection taken from inside a
 * block (e.g. a function body) can still be executed.
 */
export function dedent(text: string): string {
  const lines = text.split(/\r?\n/);
  // Common whitespace *prefix* (like textwrap.dedent): a tab and four spaces
  // are different indentation and must not be cut by character count.
  let prefix: string | undefined;
  for (const l of lines) {
    if (!l.trim()) continue;
    const ws = l.slice(0, l.length - l.trimStart().length);
    if (prefix === undefined) {
      prefix = ws;
    } else {
      let i = 0;
      while (i < prefix.length && i < ws.length && prefix[i] === ws[i]) i++;
      prefix = prefix.slice(0, i);
    }
  }
  // Whitespace-only lines are normalised to empty, as textwrap.dedent does.
  const cut = prefix?.length ?? 0;
  return lines.map((l) => (l.trim() ? l.slice(cut) : '')).join('\n');
}
