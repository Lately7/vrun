/**
 * Program input for judge-style exercises: `solution.py` reads its stdin from
 * `solution.in` next to it (the usual competitive-programming convention).
 * Pure path helpers, testable without VS Code.
 */
import * as path from 'node:path';

/** Upper bound for input text sent with a run (the request limit is 4 MiB). */
export const MAX_PROGRAM_INPUT_CHARS = 1_000_000;

export function inputPathFor(scriptPath: string): string {
  const ext = path.extname(scriptPath);
  return (ext ? scriptPath.slice(0, -ext.length) : scriptPath) + '.in';
}

/** True when `inputPath` is the program input of `scriptPath`. */
export function isInputOf(inputPath: string, scriptPath: string): boolean {
  return samePath(inputPath, inputPathFor(scriptPath));
}

export function samePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  // Windows paths are case-insensitive.
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
