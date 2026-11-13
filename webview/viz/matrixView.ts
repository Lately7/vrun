/**
 * 2-D lists / DP tables as a grid: the [row][col] the code is at, other
 * cells it probes, (r, c) cells held by visited / queue / path collections,
 * and string characters as headers of a DP over strings.
 */
import { h } from '../dom';
import { Encoded, Heap, numeric } from '../format';
import { sameEncoded, shortScalar } from './common';
import { MatrixMarks } from './pointers';
import { CellMarks } from './shapes';

export interface MatrixOpts {
  name: string;
  rows: Encoded[][];
  prev?: Encoded[][];
  heap: Heap;
  marks: MatrixMarks;
  cells?: CellMarks;
  rowLabels?: string[];
  colLabels?: string[];
}

const LEGEND: Record<string, string> = { visited: 'filled', frontier: 'outlined', onpath: 'path' };

function header(index: number, ch: string | undefined, hl: boolean): HTMLTableCellElement {
  if (ch === undefined) return h('th', { class: hl ? 'hl' : '' }, String(index));
  return h('th', { class: `ch ${hl ? 'hl' : ''}`, title: `index ${index}` }, h('span', { class: 'axis-ch' }, ch === '' ? 'ε' : ch === ' ' ? '␣' : ch), h('span', { class: 'axis-ix' }, String(index)));
}

export function renderMatrix(o: MatrixOpts): HTMLElement {
  const { rows, prev, marks } = o;
  const ri = marks.row?.index ?? -1;
  const ci = marks.col?.index ?? -1;
  const probes = new Set(marks.probes.map((p) => `${p.r},${p.c}`));
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
  const table = h('table', { class: 'matrix', 'aria-label': `matrix ${o.name}` });
  const head = h('tr', {}, h('th', {}, ''));
  for (let j = 0; j < ncols; j++) head.appendChild(header(j, o.colLabels?.[j], j === ci));
  table.appendChild(head);
  rows.forEach((r, i) => {
    const tr = h('tr', {}, header(i, o.rowLabels?.[i], i === ri));
    for (let j = 0; j < ncols; j++) {
      const v = r[j];
      const n = numeric(v);
      const changed = prev !== undefined && !sameEncoded(prev[i]?.[j], v);
      const held = o.cells?.cells.get(`${i},${j}`);
      const cls = [
        i === ri && j === ci ? 'cur' : i === ri || j === ci ? 'cross' : '',
        probes.has(`${i},${j}`) ? 'probe' : '',
        changed ? 'changed' : '',
        ...(held ?? []),
      ].join(' ');
      const td = h('td', { class: cls }, v === undefined ? '' : shortScalar(v, o.heap));
      if (n !== undefined && Number.isFinite(n) && hi > lo) {
        td.style.setProperty('--heat', String((n - lo) / (hi - lo)));
        td.classList.add('heat');
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  const parts: string[] = [];
  if (marks.row || marks.col) parts.push(`highlight: ${[marks.row, marks.col].filter((p) => p).map((p) => `${p!.name}=${p!.index}`).join(' ')}`);
  for (const p of marks.probes) parts.push(`${p.names[0]},${p.names[1]} = ${p.r},${p.c} (dashed)`);
  for (const l of o.cells?.legend ?? []) parts.push(`${l.name} ${LEGEND[l.cls]}`);
  const caption = parts.length ? h('div', { class: 'muted' }, parts.join(' · ')) : null;
  return h('div', { class: 'matrix-wrap' }, table, caption);
}
