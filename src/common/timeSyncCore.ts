export interface RawTimeSample {
  dateHeader: string;
  startedAtMs: number;
  responseAtMs: number;
}

export interface EstimatedTimeSample {
  roundTripMs: number;
  offsetMs: number;
  uncertaintyMs: number;
}

export function estimateHttpDateSample(sample: RawTimeSample): EstimatedTimeSample {
  const headerMs = Date.parse(sample.dateHeader);
  if (Number.isNaN(headerMs)) {
    throw new Error(`Date 헤더를 해석할 수 없습니다: ${sample.dateHeader}`);
  }

  const roundTripMs = Math.max(0, sample.responseAtMs - sample.startedAtMs);
  const localMidpointMs = sample.startedAtMs + roundTripMs / 2;
  // HTTP Date is normally rounded to one second. Its midpoint avoids the
  // systematic ~500ms early bias produced by treating it as millisecond exact.
  const serverMidpointMs = headerMs + 500;

  return {
    roundTripMs,
    offsetMs: Math.round(serverMidpointMs - localMidpointMs),
    uncertaintyMs: Math.ceil(500 + roundTripMs / 2)
  };
}

export function combineTimeSamples(samples: EstimatedTimeSample[]): EstimatedTimeSample {
  if (samples.length === 0) {
    throw new Error('서버시간 표본이 없습니다.');
  }

  const best = [...samples].sort((a, b) => a.roundTripMs - b.roundTripMs).slice(0, Math.min(3, samples.length));
  const offsets = best.map((sample) => sample.offsetMs).sort((a, b) => a - b);
  const offsetMs = offsets[Math.floor(offsets.length / 2)];
  const nearest = best.reduce((current, sample) =>
    Math.abs(sample.offsetMs - offsetMs) < Math.abs(current.offsetMs - offsetMs) ? sample : current
  );

  return {
    roundTripMs: nearest.roundTripMs,
    offsetMs,
    uncertaintyMs: Math.max(...best.map((sample) => sample.uncertaintyMs))
  };
}
