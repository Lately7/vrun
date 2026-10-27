/**
 * Tiny DOM helpers. All text goes through textContent / setAttribute, never
 * innerHTML, so kernel data cannot inject markup into the webview.
 */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;

function apply(el: Element, attrs: Attrs | undefined, children: Child[]): void {
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, children);
  return el;
}

export function svgRoot(width: number, height: number, label: string): SVGSVGElement {
  return s('svg', {
    viewBox: `0 0 ${Math.max(1, width)} ${Math.max(1, height)}`,
    width: Math.max(1, width),
    height: Math.max(1, height),
    role: 'img',
    'aria-label': label,
    class: 'viz-svg',
  });
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function button(label: string, onClick: () => void, opts: { title?: string; cls?: string; disabled?: boolean; pressed?: boolean } = {}): HTMLButtonElement {
  const b = h('button', {
    type: 'button',
    class: opts.cls ?? 'btn',
    title: opts.title,
    disabled: opts.disabled,
    'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed),
  }, label);
  b.addEventListener('click', onClick);
  return b;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function truncateText(t: string, n: number): string {
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
