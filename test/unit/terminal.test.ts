/** Terminal model of the Output tab (webview/console.ts), without a DOM. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Terminal } from '../../webview/terminal';

const term = (...chunks: Array<[string, string]>) => {
  const t = new Terminal(100_000);
  for (const [stream, text] of chunks) t.write(stream, text);
  return t;
};
const out = (...texts: string[]) => term(...texts.map((x): [string, string] => ['stdout', x]));

describe('output terminal', () => {
  it('a carriage return redraws the line (tqdm)', () => {
    const t = term(['stderr', '\r  0%|          | 0/5'], ['stderr', '\r 40%|████      | 2/5'], ['stderr', '\r100%|██████████| 5/5\n']);
    assert.equal(t.text, '100%|██████████| 5/5\n');
    assert.equal(t.lines[0].redrawn, true);
  });

  it('a shorter frame leaves the old tail, like a terminal', () => {
    assert.equal(out('epoch 10 loss 0.25', '\repoch 9').text, 'epoch 90 loss 0.25');
  });

  it('backspaces move the cursor back (Keras progress bar)', () => {
    assert.equal(out('1/3 [=>...]', '\b\b\b\b\b\b\b\b\b\b\b', '2/3 [==>..]').text, '2/3 [==>..]');
  });

  it('keeps a progress line apart from ordinary lines', () => {
    const t = out('start\n', 'a\rb\n', 'end');
    assert.equal(t.text, 'start\nb\nend');
    assert.deepEqual(t.lines.map((l) => l.redrawn), [false, true, false]);
  });

  it('turns SGR colours into classes and never shows escape codes', () => {
    const t = out('\x1b[32mgreen\x1b[0m plain \x1b[1;31mbold red\x1b[39m bold');
    assert.equal(t.text, 'green plain bold red bold');
    assert.deepEqual(t.lines[0].runs.map((r) => r.cls), ['a-fg2', '', 'a-fg1 a-b', 'a-b']);
  });

  it('stderr runs are marked so the panel can colour them', () => {
    const t = term(['stdout', 'ok '], ['stderr', 'warn']);
    assert.deepEqual(t.lines[0].runs.map((r) => r.cls), ['', 'stderr']);
  });

  it('an escape split across chunks is still understood', () => {
    assert.equal(out('a\x1b', '[3', '1mb\x1b[0', 'mc').text, 'abc');
  });

  it('erase in line and cursor up handle nested tqdm bars', () => {
    const t = out('outer 1/2\n', 'inner 5/5', '\r\x1b[2K', '\x1b[A\router 2/2');
    assert.equal(t.text, 'outer 2/2\n');
  });

  it('drops 256-colour, truecolour, OSC hyperlinks and cursor visibility codes', () => {
    const t = out('\x1b[38;5;196mred\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b[?25lhidden\x1b[?25h');
    assert.equal(t.text, 'red rgb link hidden');
  });

  it('clear screen restarts the frame (text animations)', () => {
    assert.equal(out('frame 1\n###\n', '\x1b[2J\x1b[H', 'frame 2').text, 'frame 2');
  });

  it('keeps only the newest lines past the size limit', () => {
    const t = new Terminal(50);
    for (let i = 0; i < 100; i++) t.write('stdout', `line ${i}\n`);
    assert.ok(t.trimmed);
    assert.ok(t.chars <= 50);
    assert.match(t.text, /line 99\n$/);
    assert.doesNotMatch(t.text, /line 0\n/);
  });

  it('control characters other than \\n \\r \\b are not shown; tabs are kept', () => {
    assert.equal(out('a\x07b\x00c\td').text, 'abc\td');
  });

  it('a progress line collapsed by the kernel (outbuf.py) is still a redraw', () => {
    // collapse_carriage_returns('\r1/3\r2/3\r3/3\n'), see test_review_output.py.
    const t = term(['stderr', '\r3\r3/3\n']);
    assert.equal(t.text, '3/3\n');
    assert.equal(t.lines[0].redrawn, true);
  });

  it('a line longer than the line limit continues on the next line, nothing is lost', () => {
    const long = Array.from({ length: 6000 }, (_, i) => i).join(', ');
    const t = new Terminal(400_000);
    for (let i = 0; i < long.length; i += 8192) t.write('stdout', long.slice(i, i + 8192));
    t.write('stdout', '\nEND\n');
    assert.equal(t.text.replace(/\n/g, ''), long + 'END');
    assert.ok(t.lines.every((l) => l.len <= 20_000));
    assert.ok(t.lines.length >= 3 && t.lines.every((l) => !l.redrawn));
    assert.equal(t.chars, long.length + 3);
  });

  it('huge cursor-movement counts are clamped', () => {
    const start = Date.now();
    const down = out('a\x1b[999999999Bb');
    assert.ok(down.lines.length <= 20_000);
    assert.match(down.text, /^a\n+b$/);
    const home = out('a\x1b[999999999;1Hb');
    assert.ok(home.lines.length <= 20_000);
    assert.ok(out('\x1b[3000000B'.repeat(1000) + 'x').lines.length <= 20_001);
    assert.ok(out('\x1b[3000000E'.repeat(1000)).lines.length <= 20_001);
    assert.ok(Date.now() - start < 5000);
    // Small moves keep working: down within existing lines keeps the column.
    assert.equal(out('ab\ncd\x1b[A\x1b[BX').text, 'ab\ncdX');
    assert.equal(out('ab\ncd\x1b[A\x1b[EX').text, 'ab\nXd');
  });

  it('clearing after many lines in one chunk does not overflow the stack', () => {
    const t = new Terminal(100_000);
    t.write('stdout', '\n'.repeat(200_000) + '\x1b[2Jafter');
    assert.equal(t.text, 'after');
    assert.ok(t.removed.length >= 200_000);
    const u = new Terminal(100_000);
    u.write('stdout', 'top' + '\n'.repeat(200_000) + '\x1b[1;4H\x1b[J');
    assert.equal(u.text, 'top');
    assert.ok(u.removed.length >= 200_000);
  });

  it('escape sequences with intermediate bytes are consumed whole', () => {
    assert.equal(out('red\x1b(B\x1b[m plain').text, 'red plain');
    assert.equal(out('a\x1b)0b').text, 'ab');
    assert.equal(out('a\x1b#8b').text, 'ab');
    assert.equal(out('a\x1b(', 'Bb').text, 'ab'); // split across chunks
    assert.equal(out('a\x1b\nb').text, 'a\nb'); // a newline is not a final byte
  });
});
