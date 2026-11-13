/** The Output tab's console: a <pre> that shows a Terminal (see terminal.ts). */
import { clear, h } from './dom';
import { Line, Terminal } from './terminal';

/** A <pre> showing a Terminal; only changed lines are redrawn. */
export class ConsoleView {
  readonly el: HTMLElement;
  private term: Terminal;
  private els = new Map<Line, HTMLElement>();
  private trimNote: HTMLElement | null = null;

  constructor(maxChars: number, cls = 'console') {
    this.term = new Terminal(maxChars);
    this.el = h('pre', { class: cls });
    this.el.hidden = true;
  }

  write(stream: string, chunk: string): void {
    this.term.write(stream, chunk);
    this.render();
  }

  private render(): void {
    const t = this.term;
    for (const l of t.removed) {
      this.els.get(l)?.remove();
      this.els.delete(l);
    }
    t.removed = [];
    if (t.trimmed && !this.trimNote) {
      this.trimNote = h('div', { class: 'ln trim-note' }, '[… earlier output trimmed]');
      this.el.prepend(this.trimNote);
    }
    // Lines are only ever added at the end, so new elements go after the
    // previous line's element.
    let anchor: HTMLElement | null = this.trimNote;
    for (const line of t.lines) {
      let el = this.els.get(line);
      if (!el) {
        el = h('div', { class: 'ln' });
        if (anchor) anchor.after(el);
        else this.el.prepend(el);
        this.els.set(line, el);
        t.dirty.add(line);
      }
      anchor = el;
    }
    for (const line of t.dirty) {
      const el = this.els.get(line);
      if (!el) continue;
      clear(el);
      for (const r of line.runs) el.appendChild(r.cls ? h('span', { class: r.cls }, r.text) : document.createTextNode(r.text));
      el.classList.toggle('progress', line.redrawn);
    }
    t.dirty.clear();
    this.el.hidden = t.chars === 0 && !t.trimmed;
  }
}
