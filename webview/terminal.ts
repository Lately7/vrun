/**
 * Terminal model for captured output (no DOM: unit-tested in node).
 *
 * Training loops report progress by redrawing one line: tqdm and LightGBM
 * write "\r" + the new frame, Keras backs up with "\b", nested tqdm bars move
 * the cursor up with ESC[A, and many logs colour text with ANSI SGR codes.
 * Appended as plain text, every frame piled up and escape codes showed raw.
 * Only what such libraries emit is modelled: \n \r \b, SGR colours, erase in
 * line/display and cursor moves. Any other control sequence is dropped,
 * never shown.
 */

export interface Run {
  text: string;
  cls: string;
}

export interface Line {
  runs: Run[];
  len: number;
  /** Redrawn in place at least once: a progress bar, not an error message. */
  redrawn: boolean;
}

interface Style {
  fg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const MAX_LINE_CHARS = 20_000;
const MAX_LINES = 20_000;
// ESC [ params intermediates final, ESC ] ... BEL|ESC \, or ESC intermediates final.
const CSI_FINAL = /[@-~]/;

function plainStyle(): Style {
  return { fg: null, bold: false, dim: false, italic: false, underline: false };
}

function styleClass(stream: string, s: Style): string {
  const parts: string[] = [];
  if (stream === 'stderr') parts.push('stderr');
  if (s.fg !== null) parts.push(`a-fg${s.fg}`);
  if (s.bold) parts.push('a-b');
  if (s.dim) parts.push('a-dim');
  if (s.italic) parts.push('a-i');
  if (s.underline) parts.push('a-u');
  return parts.join(' ');
}

function newLine(): Line {
  return { runs: [], len: 0, redrawn: false };
}

/** Replace [from, from + text.length) of a line, padding with spaces. */
function writeAt(line: Line, from: number, text: string, cls: string): void {
  if (from > line.len) {
    pushRun(line, ' '.repeat(from - line.len), '');
  }
  if (from === line.len) {
    pushRun(line, text, cls);
    return;
  }
  const to = from + text.length;
  const out: Run[] = [];
  let pos = 0;
  let inserted = false;
  for (const r of line.runs) {
    const start = pos;
    const end = pos + r.text.length;
    pos = end;
    if (end <= from || start >= to) {
      if (start >= to && !inserted) {
        out.push({ text, cls });
        inserted = true;
      }
      out.push(r);
      continue;
    }
    if (start < from) out.push({ text: r.text.slice(0, from - start), cls: r.cls });
    if (!inserted) {
      out.push({ text, cls });
      inserted = true;
    }
    if (end > to) out.push({ text: r.text.slice(to - start), cls: r.cls });
  }
  if (!inserted) out.push({ text, cls });
  line.runs = mergeRuns(out);
  line.len = Math.max(line.len, to);
}

function pushRun(line: Line, text: string, cls: string): void {
  const last = line.runs[line.runs.length - 1];
  if (last && last.cls === cls) last.text += text;
  else line.runs.push({ text, cls });
  line.len += text.length;
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && last.cls === r.cls) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function truncateLine(line: Line, at: number): void {
  if (at >= line.len) return;
  const out: Run[] = [];
  let pos = 0;
  for (const r of line.runs) {
    if (pos >= at) break;
    out.push(pos + r.text.length <= at ? r : { text: r.text.slice(0, at - pos), cls: r.cls });
    pos += r.text.length;
  }
  line.runs = out;
  line.len = at;
}

/** The terminal model, without DOM (unit-tested in node). */
export class Terminal {
  lines: Line[] = [newLine()];
  /** Lines changed since the last take(); removed ones are listed apart. */
  dirty = new Set<Line>(this.lines);
  removed: Line[] = [];
  trimmed = false;
  chars = 0;
  private row = 0;
  private col = 0;
  private pending = new Map<string, string>();
  private styles = new Map<string, Style>();

  constructor(private maxChars: number) {}

  get text(): string {
    return this.lines.map((l) => l.runs.map((r) => r.text).join('')).join('\n');
  }

  write(stream: string, chunk: string): void {
    let text = (this.pending.get(stream) ?? '') + chunk;
    this.pending.delete(stream);
    let style = this.styles.get(stream) ?? plainStyle();
    let i = 0;
    let textStart = 0;
    const flushText = (end: number) => {
      if (end > textStart) this.put(text.slice(textStart, end), styleClass(stream, style));
    };
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c >= 0x20 || c === 0x09) {
        i++;
        continue;
      }
      flushText(i);
      if (c === 0x0a) {
        this.newline();
        i++;
      } else if (c === 0x0d) {
        this.col = 0;
        i++;
      } else if (c === 0x08) {
        this.col = Math.max(0, this.col - 1);
        i++;
      } else if (c === 0x1b) {
        const consumed = this.escape(text, i, style);
        if (consumed === null) {
          // Split across chunks: keep the start for the next write.
          this.pending.set(stream, text.slice(i));
          text = text.slice(0, i);
          textStart = i;
          break;
        }
        style = consumed.style;
        i = consumed.next;
      } else {
        i++; // other C0 controls (bell, NUL ...) are not shown
      }
      textStart = i;
    }
    flushText(text.length);
    this.styles.set(stream, style);
    this.trim();
  }

  private put(text: string, cls: string): void {
    // Past MAX_LINE_CHARS the text continues on the next line, as a terminal
    // wraps: cutting it silently lost the end of a printed list or JSON
    // line. maxChars (trim) still bounds the total.
    while (text) {
      if (this.col >= MAX_LINE_CHARS) this.newline();
      const line = this.lines[this.row];
      const piece = text.slice(0, MAX_LINE_CHARS - this.col);
      const before = line.len;
      if (this.col < line.len) line.redrawn = true;
      writeAt(line, this.col, piece, cls);
      this.col += piece.length;
      this.chars += line.len - before;
      this.dirty.add(line);
      text = text.slice(piece.length);
    }
  }

  private newline(): void {
    this.row++;
    this.addLinesTo(this.row);
    this.col = 0;
  }

  private addLinesTo(row: number): void {
    while (this.lines.length <= row) {
      const line = newLine();
      this.lines.push(line);
      this.dirty.add(line);
    }
  }

  /** Parse one escape sequence at i; null if it continues in the next chunk. */
  private escape(text: string, i: number, style: Style): { next: number; style: Style } | null {
    if (i + 1 >= text.length) return null;
    const kind = text[i + 1];
    if (kind === '[') {
      let j = i + 2;
      while (j < text.length && !CSI_FINAL.test(text[j])) {
        if (j - i > 64) return { next: j, style }; // garbage: drop it
        j++;
      }
      if (j >= text.length) return null;
      const params = text.slice(i + 2, j);
      const next = this.csi(params, text[j], style);
      return { next: j + 1, style: next };
    }
    if (kind === ']') {
      // OSC (window titles, hyperlinks): ends with BEL or ESC \.
      for (let j = i + 2; j < text.length; j++) {
        if (text.charCodeAt(j) === 0x07) return { next: j + 1, style };
        if (text.charCodeAt(j) === 0x1b) {
          if (j + 1 >= text.length) return null;
          if (text[j + 1] === '\\') return { next: j + 2, style };
        }
        if (j - i > 4096) return { next: j, style };
      }
      return null;
    }
    // ESC, intermediates (0x20-0x2f), final: consuming one character after
    // ESC showed the final of ESC ( B (tput sgr0), ESC ) 0 and ESC # 8.
    let j = i + 1;
    while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) {
      if (j - i > 8) return { next: j, style }; // garbage: drop it
      j++;
    }
    if (j >= text.length) return null;
    // Anything else (\n, \r, a second ESC) is not a final byte: it stays.
    const f = text.charCodeAt(j);
    return { next: f >= 0x30 && f <= 0x7e ? j + 1 : j, style };
  }

  private csi(params: string, final: string, style: Style): Style {
    if (params.startsWith('?') || params.startsWith('>')) return style; // cursor visibility etc.
    const nums = params.split(';').map((p) => (p === '' ? NaN : Number(p)));
    const n = (k: number, dflt: number) => (Number.isFinite(nums[k]) ? nums[k] : dflt);
    const line = this.lines[this.row];
    switch (final) {
      case 'm':
        return applySgr(style, nums);
      case 'K': {
        const mode = n(0, 0);
        if (mode === 0) truncateLine(line, this.col);
        else if (mode === 1) writeAt(line, 0, ' '.repeat(Math.min(this.col + 1, line.len)), '');
        else if (mode === 2) truncateLine(line, 0);
        line.redrawn = true;
        this.dirty.add(line);
        this.recount();
        return style;
      }
      case 'A':
        this.row = Math.max(0, this.row - Math.max(1, n(0, 1)));
        return style;
      case 'B':
      case 'E': {
        // Blank lines are added only up to MAX_LINES (a screen that tall):
        // ESC[999999999B created every line, freezing the panel.
        const row = Math.min(this.row + Math.max(1, n(0, 1)), Math.max(this.lines.length, MAX_LINES) - 1);
        this.addLinesTo(row);
        this.row = row;
        this.col = final === 'B' ? Math.min(this.col, this.lines[row].len) : 0;
        return style;
      }
      case 'F':
        this.row = Math.max(0, this.row - Math.max(1, n(0, 1)));
        this.col = 0;
        return style;
      case 'C':
        this.col = Math.min(MAX_LINE_CHARS, this.col + Math.max(1, n(0, 1)));
        return style;
      case 'D':
        this.col = Math.max(0, this.col - Math.max(1, n(0, 1)));
        return style;
      case 'G':
        this.col = Math.min(MAX_LINE_CHARS, Math.max(0, n(0, 1) - 1));
        return style;
      case 'H':
      case 'f': {
        const row = Math.min(MAX_LINES - 1, Math.max(0, n(0, 1) - 1)); // as for B
        this.addLinesTo(row);
        this.row = row;
        this.col = Math.min(MAX_LINE_CHARS, Math.max(0, n(1, 1) - 1));
        return style;
      }
      case 'J':
        // "\x1b[2J\x1b[H" redraws a frame (games of life, animations).
        if (n(0, 0) >= 2) this.reset();
        else if (n(0, 0) === 0) {
          truncateLine(line, this.col);
          // A loop, not push(...lines): spreading 200k lines overflowed the stack.
          for (const l of this.lines.splice(this.row + 1)) this.removed.push(l);
          this.dirty.add(line);
          this.recount();
        }
        return style;
      default:
        return style;
    }
  }

  private reset(): void {
    for (const l of this.lines) this.removed.push(l);
    this.lines = [newLine()];
    this.row = 0;
    this.col = 0;
    this.chars = 0;
    this.dirty = new Set(this.lines);
  }

  private recount(): void {
    this.chars = this.lines.reduce((n, l) => n + l.len, 0);
  }

  /** Keep the newest output: drop whole lines from the top. */
  private trim(): void {
    let drop = 0;
    let chars = this.chars;
    while (drop < this.row && (chars > this.maxChars || this.lines.length - drop > MAX_LINES)) {
      chars -= this.lines[drop].len;
      drop++;
    }
    if (drop === 0) return;
    for (const l of this.lines.splice(0, drop)) {
      this.removed.push(l);
      this.dirty.delete(l);
    }
    this.row -= drop;
    this.chars = chars;
    this.trimmed = true;
  }

}

const SGR_BASIC: Record<number, number> = { 30: 0, 31: 1, 32: 2, 33: 3, 34: 4, 35: 5, 36: 6, 37: 7, 90: 8, 91: 9, 92: 10, 93: 11, 94: 12, 95: 13, 96: 14, 97: 15 };

function applySgr(style: Style, nums: number[]): Style {
  const s = { ...style };
  const codes = nums.length ? nums : [0];
  for (let k = 0; k < codes.length; k++) {
    const c = Number.isFinite(codes[k]) ? codes[k] : 0;
    if (c === 0) Object.assign(s, plainStyle());
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) {
      s.bold = false;
      s.dim = false;
    } else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c === 39) s.fg = null;
    else if (c in SGR_BASIC) s.fg = SGR_BASIC[c];
    else if (c === 38 || c === 48) {
      // 38;5;n (256 colours) or 38;2;r;g;b. Only the 16 basic ones are kept.
      if (codes[k + 1] === 5) {
        const idx = codes[k + 2];
        if (c === 38 && Number.isFinite(idx) && idx >= 0 && idx < 16) s.fg = idx;
        k += 2;
      } else if (codes[k + 1] === 2) {
        k += 4;
      }
    }
    // Backgrounds (40-47, 100-107) and blink are ignored on purpose: they
    // fight the panel theme.
  }
  return s;
}
