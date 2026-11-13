/**
 * Training curves: one line per series (loss, val_loss, accuracy ...) over
 * the epoch / step index, with a data-fitted y range and the best point of
 * each curve marked (lowest loss / error, highest accuracy / score).
 */
import { s, svgRoot } from '../dom';
import { fmtNumber } from '../format';
import { niceTicks } from './common';

export interface Series {
  name: string;
  x: number[];
  y: Array<number | null>;
  len: number;
}

const LOWER_IS_BETTER = /loss|err|mse|mae|rmse|mape|nll|perplexity|cost/i;
const HIGHER_IS_BETTER = /acc|auc|f1|score|precision|recall|r2|iou|dice|map\b/i;

export function bestIndex(sr: Series): number | undefined {
  const lower = LOWER_IS_BETTER.test(sr.name);
  const higher = !lower && HIGHER_IS_BETTER.test(sr.name);
  if (!lower && !higher) return undefined;
  let best: number | undefined;
  sr.y.forEach((v, i) => {
    if (v === null) return;
    if (best === undefined || (lower ? v < sr.y[best]! : v > sr.y[best]!)) best = i;
  });
  return best;
}

/** y range fitted to the data; 0 is kept only when the data comes close to it. */
export function yRange(series: Series[]): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const sr of series) {
    for (const v of sr.y) {
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return undefined;
  const span = hi - lo;
  if (lo > 0 && lo < span * 0.25) lo = 0;
  if (hi < 0 && -hi < span * 0.25) hi = 0;
  return [lo, hi];
}

export function renderLineChart(series: Series[], title: string, width = 560, height = 240): SVGSVGElement {
  const m = { l: 52, r: 14, t: 12, b: 30 };
  const svg = svgRoot(width, height, title);
  const range = yRange(series);
  const maxX = Math.max(1, ...series.map((sr) => sr.len - 1));
  if (!range) return svg;
  const yt = niceTicks(range[0], range[1], 5);
  const xt = niceTicks(0, maxX, 6).filter((t) => t >= 0 && t <= maxX && Number.isInteger(t));
  const [ylo, yhi] = [yt[0], yt[yt.length - 1]];
  const X = (v: number) => m.l + (v / maxX) * (width - m.l - m.r);
  const Y = (v: number) => height - m.b - ((v - ylo) / (yhi - ylo || 1)) * (height - m.t - m.b);
  for (const t of yt) {
    svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis zero' : 'grid' }));
    svg.appendChild(s('text', { x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'tick-text' }, fmtNumber(t)));
  }
  for (const t of xt) {
    svg.appendChild(s('text', { x: X(t), y: height - m.b + 16, 'text-anchor': 'middle', class: 'tick-text' }, fmtNumber(t)));
  }
  series.forEach((sr, k) => {
    const cls = `series-${k % 6}`;
    // A gap (NaN / inf) breaks the line instead of drawing to zero.
    let d = '';
    let pen = false;
    sr.y.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${X(sr.x[i]).toFixed(1)},${Y(v).toFixed(1)} `;
      pen = true;
    });
    svg.appendChild(s('path', { d, class: `curve ${cls}` }));
    if (sr.y.length <= 60) {
      sr.y.forEach((v, i) => {
        if (v === null) return;
        svg.appendChild(s('circle', { cx: X(sr.x[i]), cy: Y(v), r: 2.2, class: `curve-dot ${cls}` }, s('title', {}, `${sr.name} [${sr.x[i]}] = ${fmtNumber(v)}`)));
      });
    }
    const best = bestIndex(sr);
    if (best !== undefined && sr.y[best] !== null) {
      const v = sr.y[best]!;
      svg.appendChild(s('circle', { cx: X(sr.x[best]), cy: Y(v), r: 4.5, class: `curve-best ${cls}` }, s('title', {}, `best ${sr.name}: ${fmtNumber(v)} at ${sr.x[best]}`)));
    }
  });
  return svg;
}
