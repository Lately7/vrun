/** Chart axis ticks (webview/viz/common.ts) as the line chart uses them. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { niceTicks } from '../../webview/viz/common';

const covers = (lo: number, hi: number, maxTicks: number) => {
  const t = niceTicks(lo, hi, maxTicks);
  const eps = (hi - lo) * 1e-9; // float rounding of the tick values
  assert.ok(t.length >= 2, `${lo}..${hi}: ${t}`);
  assert.ok(t[0] <= lo + eps && t[t.length - 1] >= hi - eps, `${lo}..${hi}: ${t}`);
  assert.ok(t.length <= maxTicks + 2, `${lo}..${hi}: ${t}`);
};

describe('chart ticks cover the data', () => {
  it('the top tick is at or above the highest value (training curves)', () => {
    // lineChart.ts takes its y range from the ticks: loss 2.21 got ticks up
    // to 2 and accuracy 0.65 up to 0.6, drawing the top points off the chart.
    assert.deepEqual(niceTicks(0, 2.21, 5), [0, 0.5, 1, 1.5, 2, 2.5]);
    assert.deepEqual(niceTicks(0, 0.65, 5), [0, 0.2, 0.4, 0.6, 0.8]);
    covers(0, 0.85, 5);
    covers(0.38, 2.0724, 5);
  });

  it('ticks still end on hi when it is a tick', () => {
    assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
    assert.deepEqual(niceTicks(-3, 3, 6), [-3, -2, -1, 0, 1, 2, 3]);
  });

  it('covers random ranges', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 2000; k++) {
      const scale = Math.pow(10, Math.floor(rnd() * 12) - 6);
      const a = (rnd() - 0.5) * 100 * scale;
      const b = a + rnd() * 100 * scale + scale * 1e-3;
      covers(a, b, 1 + Math.floor(rnd() * 10));
    }
  });
});
