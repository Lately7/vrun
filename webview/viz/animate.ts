/**
 * Step animation (FLIP): every step re-renders the views from scratch, so
 * elements are matched by their `data-anim` key within the nearest
 * `data-anim-scope` (one card). A matched element slides from where it was
 * to where it is now; a new one fades in; one whose class changed (visited,
 * current) pulses. `data-anim-edge="k1 k2"` elements (keys of their
 * endpoints) fade in after a slide when an endpoint moved or is new; an edge
 * without keys does so when anything but a pointer label in its card moved.
 * Positions are relative to the scope, so a card that moves down the page
 * does not make everything in it slide. A keyed element is measured by its
 * direct `data-anim-anchor` child when it has one: a bar's group grows with
 * its value, but its cell stays in the row.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: string;
}

export type Snapshot = Map<string, Box>;

const KEY_SEP = '\u0000';

function scopeOf(el: Element): Element | null {
  return el.closest('[data-anim-scope]');
}

function keyOf(el: Element, scope: Element): string {
  return `${scope.getAttribute('data-anim-scope')}${KEY_SEP}${el.getAttribute('data-anim')}`;
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Boxes of all keyed elements under root, relative to their scope (a shared scope: to the cards' container). */
export function snapshot(root: Element): Snapshot {
  const out: Snapshot = new Map();
  const scopes = new Map<Element, DOMRect>();
  for (const el of root.querySelectorAll('[data-anim]')) {
    const scope = scopeOf(el);
    if (!scope) continue;
    let sr = scopes.get(scope);
    if (!sr) scopes.set(scope, (sr = (scope.hasAttribute('data-anim-shared') ? scope.parentElement ?? scope : scope).getBoundingClientRect()));
    const r = (el.querySelector(':scope > [data-anim-anchor]') ?? el).getBoundingClientRect();
    out.set(keyOf(el, scope), { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, cls: stateOf(el) });
  }
  return out;
}

// Classes that change on most steps (a pointer passing by, a changed cell
// that already flashes): a pulse for them would be noise.
const NOISY = new Set(['changed', 'pointed', 'cur', 'cross']);

/**
 * State classes of a keyed element and its direct children: views keep the
 * state (visited, current, frontier) on the circle or rect inside the group.
 */
function stateOf(el: Element): string {
  const own = (c: string | null) => (c ?? '').split(/\s+/).filter((t) => t && !NOISY.has(t)).sort().join('.');
  return [own(el.getAttribute('class')), ...[...el.children].map((c) => own(c.getAttribute('class')))].join('|');
}

/** Screen pixels per user unit of an SVG element (1 for HTML), one lookup per <svg>. */
function scaleOf(el: Element, cache: Map<Element, [number, number]>): [number, number] {
  if (!(el instanceof SVGGraphicsElement)) return [1, 1];
  const svg = el.ownerSVGElement ?? el;
  let s = cache.get(svg);
  if (!s) {
    const m = svg.getScreenCTM();
    cache.set(svg, (s = m && m.a && m.d ? [m.a, m.d] : [1, 1]));
  }
  return s;
}

/** Animate from `before` to the current layout under root. */
export function animateFrom(before: Snapshot, root: Element, ms: number): void {
  if (ms <= 0 || typeof Element.prototype.animate !== 'function') return;
  const now = snapshot(root);
  // Per card: keys that moved or appeared, and whether more than a pointer moved.
  const moved = new Map<Element, { keys: Set<string>; any: boolean }>();
  const mark = (scope: Element, el: Element, isMove: boolean) => {
    let m = moved.get(scope);
    if (!m) moved.set(scope, (m = { keys: new Set(), any: false }));
    const k = el.getAttribute('data-anim') ?? '';
    m.keys.add(k);
    if (isMove && !k.startsWith('p:')) m.any = true;
  };
  const scales = new Map<Element, [number, number]>();
  const knownScopes = new Set<string>();
  for (const key of before.keys()) knownScopes.add(key.slice(0, key.indexOf(KEY_SEP)));
  const easing = 'cubic-bezier(.4,0,.2,1)';
  for (const el of root.querySelectorAll('[data-anim]')) {
    const scope = scopeOf(el);
    if (!scope) continue;
    const key = keyOf(el, scope);
    const old = before.get(key);
    const cur = now.get(key);
    if (!cur) continue;
    if (!old) {
      // New in a card that existed: fade in. A brand-new card just appears.
      if (knownScopes.has(scope.getAttribute('data-anim-scope') ?? '')) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
        mark(scope, el, false);
      }
      continue;
    }
    const dx = old.x - cur.x;
    const dy = old.y - cur.y;
    const sized = el.hasAttribute('data-anim-size') && cur.w > 0 && cur.h > 0;
    const sw = sized ? old.w / cur.w : 1;
    const sh = sized ? old.h / cur.h : 1;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(sw - 1) > 0.01 || Math.abs(sh - 1) > 0.01) {
      const [ax, ay] = scaleOf(el, scales);
      const from = `translate(${dx / ax}px, ${dy / ay}px)${sized ? ` scale(${sw}, ${sh})` : ''}`;
      if (sized) {
        const style = (el as HTMLElement | SVGElement).style;
        style.setProperty('transform-box', 'fill-box');
        style.setProperty('transform-origin', '0 0');
      }
      el.animate([{ transform: from }, { transform: 'none' }], { duration: ms, easing });
      mark(scope, el, true);
    } else if (old.cls !== cur.cls) {
      el.animate([{ filter: 'brightness(1.9)' }, { filter: 'none' }], { duration: Math.max(ms, 300), easing: 'ease-out' });
    }
  }
  // Edges were drawn for the final positions: show them once the nodes arrive.
  for (const [scope, m] of moved) {
    for (const edge of scope.querySelectorAll('[data-anim-edge]')) {
      if (scopeOf(edge) !== scope) continue;
      const ends = (edge.getAttribute('data-anim-edge') ?? '').split(/\s+/).filter(Boolean);
      if (ends.length ? !ends.some((k) => m.keys.has(k)) : !m.any) continue;
      edge.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: ms, easing: 'linear' });
    }
  }
}
