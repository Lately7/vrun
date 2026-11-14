/**
 * The top-level statement at the cursor, for Shift+Enter in a file without
 * `# %%` cells. The Python extension's Shift+Enter (the habit learners
 * bring) runs that statement, a whole `def`/`for`/`if` included, and moves
 * on; running the whole file instead would re-load data and re-train on
 * every press. No vscode import, so it is unit-testable.
 *
 * Python is not parsed here: a small scanner follows brackets, strings and
 * backslash continuations, which is all it takes to tell where a top-level
 * statement starts. Code it misreads fails in the kernel with a
 * SyntaxError, as running a single line would.
 */

export interface Statement {
  /** 0-based first and last line (inclusive) of the statement. */
  startLine: number;
  endLine: number;
  text: string;
  /** First line of the next statement; undefined after the last one. */
  nextLine?: number;
}

interface LineInfo {
  /** Not inside brackets, a string or a backslash continuation. */
  clean: boolean;
  /** Has something other than whitespace and a comment (string text counts). */
  code: boolean;
  indent: number;
}

function scanLines(lines: string[]): LineInfo[] {
  const info: LineInfo[] = [];
  let depth = 0;
  let quote = ''; // the open string's quote: ', ", ''' or """
  let continued = false;
  for (const line of lines) {
    const clean = depth === 0 && quote === '' && !continued;
    let code = false;
    let escapedEnd = false;
    continued = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        code = true;
        if (ch === '\\') {
          escapedEnd = i === line.length - 1;
          i++;
        } else if (line.startsWith(quote, i)) {
          i += quote.length - 1;
          quote = '';
        }
        continue;
      }
      if (ch === '#') break;
      if (ch === ' ' || ch === '\t' || ch === '\f') continue;
      code = true;
      if (ch === '"' || ch === "'") {
        quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length - 1;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth = Math.max(0, depth - 1);
      } else if (ch === '\\' && i === line.length - 1) {
        continued = true;
      }
    }
    // A one-quote string ends with its line unless the newline is escaped.
    if (quote.length === 1 && !escapedEnd) quote = '';
    info.push({ clean, code, indent: line.length - line.trimStart().length });
  }
  return info;
}

/** Lines that continue the compound statement above them. */
const CONTINUES = /^(else|elif|except|finally)\b/;

/**
 * The statement containing `line`; on a blank or comment line between
 * statements, the next statement below. Undefined when there is no code
 * at or below the cursor.
 */
export function statementAt(source: string, line: number): Statement | undefined {
  const lines = source.split(/\r?\n/);
  const info = scanLines(lines);
  const firsts = info.flatMap((x, i) => (x.clean && x.code ? [i] : []));
  if (firsts.length === 0) return undefined;
  // A pasted indented snippet has no column-0 code: its least indent is "top level".
  const top = Math.min(...firsts.map((i) => info[i].indent));
  const heads = firsts.filter((i) => info[i].indent === top && !CONTINUES.test(lines[i].trimStart()));
  // A decorator and the def/class it decorates are one statement.
  const starts = heads.filter((s, j) => j === 0 || !lines[heads[j - 1]].trimStart().startsWith('@'));
  if (starts.length === 0) return undefined;
  const endOf = (j: number): number => {
    let e = (j + 1 < starts.length ? starts[j + 1] : lines.length) - 1;
    while (e > starts[j] && !info[e].code) e--;
    return e;
  };
  let k = -1;
  for (let j = 0; j < starts.length && starts[j] <= line; j++) k = j;
  if (k < 0 || line > endOf(k)) k++;
  if (k >= starts.length) return undefined;
  const startLine = starts[k];
  const endLine = endOf(k);
  return {
    startLine,
    endLine,
    text: lines.slice(startLine, endLine + 1).join('\n'),
    nextLine: starts[k + 1],
  };
}
