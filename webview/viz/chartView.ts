/** Function graph ("đồ thị hàm số"): y = values[i], or (x, y) pairs. */
import { s, svgRoot } from '../dom';
import { fmtNumber } from '../format';
import { niceTicks } from './common';

export function renderChart(points: Array<[number, number]>, title: string, highlightX?: number): SVGSVGElement {
  const width = 640;
  const height = 260;
  const m = { l: 48, r: 16, t: 14, b: 30 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), 8);
  const yt = niceTicks(Math.min(...ys, 0), Math.max(...ys, 0), 6);
  const [xlo, xhi] = [xt[0], xt[xt.length - 1]];
  const [ylo, yhi] = [yt[0], yt[yt.length - 1]];
  const X = (v: number) => m.l + ((v - xlo) / (xhi - xlo || 1)) * (width - m.l - m.r);
  const Y = (v: number) => height - m.b - ((v - ylo) / (yhi - ylo || 1)) * (height - m.t - m.b);
  const svg = svgRoot(width, height, title);
  for (const t of yt) {
    svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis zero' : 'grid' }));
    svg.appendChild(s('text', { x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'tick-text' }, fmtNumber(t)));
  }
  for (const t of xt) {
    svg.appendChild(s('line', { x1: X(t), x2: X(t), y1: m.t, y2: height - m.b, class: t === 0 ? 'axis zero' : 'grid' }));
    svg.appendChild(s('text', { x: X(t), y: height - m.b + 16, 'text-anchor': 'middle', class: 'tick-text' }, fmtNumber(t)));
  }
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const d = sorted.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  svg.appendChild(s('path', { d, class: 'chart-line' }));
  if (points.length <= 80) {
    for (const p of points) {
      svg.appendChild(s('circle', { cx: X(p[0]), cy: Y(p[1]), r: 3, class: p[0] === highlightX ? 'chart-dot hl' : 'chart-dot' }, s('title', {}, `(${fmtNumber(p[0])}, ${fmtNumber(p[1])})`)));
    }
  }
  return svg;
}
