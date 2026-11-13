/**
 * Step animation (FLIP): every step re-renders the views from scratch, so
 * elements are matched by their `data-anim` key within the nearest
 * `data-anim-scope` (one card). A matched element slides from where it was
 * to where it is now; a new one fades in; one whose class changed (visited,
 * current) pulses. `data-anim-edge` elements fade in after a slide, since
 * their endpoints moved. Positions are relative to the scope, so a card that
 * moves down the page does not make everything in it slide.
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

/** Boxes of all keyed elements under root, relative to their scope. */
export function snapshot(root: Element): Snapshot {
  const out: Snapshot = new Map();
  const scopes = new Map<Element, DOMRect>();
  for (const el of root.querySelectorAll('[data-anim]')) {
    const scope = scopeOf(el);
    if (!scope) continue;
    let sr = scopes.get(scope);
    if (!sr) scopes.set(scope, (sr = scope.getBoundingClientRect()));
    const r = el.getBoundingClientRect();
    out.set(keyOf(el, scope), { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, cls: el.getAttribute('class') ?? '' });
  }
  return out;
}

/** Screen pixels per user unit of an SVG element (1 for HTML). */
function scaleOf(el: Element): [number, number] {
  if (!(el instanceof SVGGraphicsElement)) return [1, 1];
  const m = el.ownerSVGElement?.getScreenCTM() ?? el.getScreenCTM();
  return m && m.a && m.d ? [m.a, m.d] : [1, 1];
}

/** Animate from `before` to the current layout under root. */
export function animateFrom(before: Snapshot, root: Element, ms: number): void {
  if (ms <= 0 || typeof Element.prototype.animate !== 'function') return;
  const now = snapshot(root);
  const movedScopes = new Set<Element>();
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
      }
      continue;
    }
    const dx = old.x - cur.x;
    const dy = old.y - cur.y;
    const sized = el.hasAttribute('data-anim-size') && cur.w > 0 && cur.h > 0;
    const sw = sized ? old.w / cur.w : 1;
    const sh = sized ? old.h / cur.h : 1;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(sw - 1) > 0.01 || Math.abs(sh - 1) > 0.01) {
      const [ax, ay] = scaleOf(el);
      const from = `translate(${dx / ax}px, ${dy / ay}px)${sized ? ` scale(${sw}, ${sh})` : ''}`;
      if (sized) {
        const style = (el as HTMLElement | SVGElement).style;
        style.setProperty('transform-box', 'fill-box');
        style.setProperty('transform-origin', '0 0');
      }
      el.animate([{ transform: from }, { transform: 'none' }], { duration: ms, easing });
      movedScopes.add(scope);
    } else if (old.cls !== cur.cls) {
      el.animate([{ filter: 'brightness(1.9)' }, { filter: 'none' }], { duration: Math.max(ms, 300), easing: 'ease-out' });
    }
  }
  // Edges were drawn for the final positions: show them once the nodes arrive.
  for (const scope of movedScopes) {
    for (const edge of scope.querySelectorAll('[data-anim-edge]')) {
      edge.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: ms, easing: 'linear' });
    }
  }
}
