import assert from 'node:assert/strict';
import test from 'node:test';
import { combineTimeSamples, estimateHttpDateSample } from '../src/common/timeSyncCore';

test('초 단위 HTTP Date를 중앙값으로 보정해 고정 편향을 줄인다', () => {
  const sample = estimateHttpDateSample({
    dateHeader: 'Wed, 22 Jul 2026 12:00:00 GMT',
    startedAtMs: Date.parse('2026-07-22T11:59:59.900Z'),
    responseAtMs: Date.parse('2026-07-22T12:00:00.100Z')
  });
  assert.equal(sample.roundTripMs, 200);
  assert.equal(sample.offsetMs, 500);
  assert.equal(sample.uncertaintyMs, 600);
});

test('가장 낮은 RTT 표본 세 개의 중앙 offset을 선택한다', () => {
  const combined = combineTimeSamples([
    { roundTripMs: 120, offsetMs: 410, uncertaintyMs: 560 },
    { roundTripMs: 30, offsetMs: 500, uncertaintyMs: 515 },
    { roundTripMs: 20, offsetMs: 490, uncertaintyMs: 510 },
    { roundTripMs: 40, offsetMs: 510, uncertaintyMs: 520 },
    { roundTripMs: 500, offsetMs: 9000, uncertaintyMs: 750 }
  ]);
  assert.equal(combined.offsetMs, 500);
  assert.equal(combined.roundTripMs, 30);
  assert.equal(combined.uncertaintyMs, 520);
});
