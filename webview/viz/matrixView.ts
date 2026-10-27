/** 2-D lists / DP tables as a grid; highlights [i][j] for row/col locals. */
import { h } from '../dom';
import { Encoded, Heap, numeric } from '../format';
import { Var, isPointerName, sameEncoded, shortScalar } from './common';

const ROW_NAMES = /^(i|r|row|y|a|x1)$/i;
const COL_NAMES = /^(j|c|col|x|b|y1|w|cap)$/i;

export function renderMatrix(name: string, rows: Encoded[][], prev: Encoded[][] | undefined, vars: Var[], heap: Heap): HTMLElement {
  const ints = vars.filter(
    (v) => typeof v.value === 'number' && Number.isInteger(v.value) && (isPointerName(v.name) || /^(w|cap|a|b)$/i.test(v.name)),
  );
  const rowVar = ints.find((v) => ROW_NAMES.test(v.name));
  const colVar = ints.find((v) => COL_NAMES.test(v.name) && v !== rowVar);
  const ri = typeof rowVar?.value === 'number' ? rowVar.value : -1;
  const ci = typeof colVar?.value === 'number' ? colVar.value : -1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) for (const v of r) {
    const n = numeric(v);
    if (n !== undefined && Number.isFinite(n)) {
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
  }
  const ncols = Math.max(0, ...rows.map((r) => r.length));
  const table = h('table', { class: 'matrix', 'aria-label': `matrix ${name}` });
  const head = h('tr', {}, h('th', {}, ''));
  for (let j = 0; j < ncols; j++) head.appendChild(h('th', { class: j === ci ? 'hl' : '' }, String(j)));
  table.appendChild(head);
  rows.forEach((r, i) => {
    const tr = h('tr', {}, h('th', { class: i === ri ? 'hl' : '' }, String(i)));
    for (let j = 0; j < ncols; j++) {
      const v = r[j];
      const n = numeric(v);
      const changed = prev !== undefined && !sameEncoded(prev[i]?.[j], v);
      const td = h('td', { class: [i === ri && j === ci ? 'cur' : i === ri || j === ci ? 'cross' : '', changed ? 'changed' : ''].join(' ') }, v === undefined ? '' : shortScalar(v, heap));
      if (n !== undefined && Number.isFinite(n) && hi > lo) {
        td.style.setProperty('--heat', String((n - lo) / (hi - lo)));
        td.classList.add('heat');
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  const caption = rowVar || colVar ? h('div', { class: 'muted' }, `highlight: ${rowVar ? `${rowVar.name}=${ri}` : ''} ${colVar ? `${colVar.name}=${ci}` : ''}`) : null;
  return h('div', { class: 'matrix-wrap' }, table, caption);
}
