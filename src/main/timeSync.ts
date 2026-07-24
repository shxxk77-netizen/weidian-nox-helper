import http from 'node:http';
import https from 'node:https';
import type { TimeSyncSnapshot } from '../common/types';
import { combineTimeSamples, estimateHttpDateSample } from '../common/timeSyncCore';
import { AppLogger } from './logger';

export class TimeSyncManager {
  private snapshot: TimeSyncSnapshot | undefined;

  constructor(private readonly logger: AppLogger) {}

  getSnapshot(): TimeSyncSnapshot | undefined {
    return this.snapshot;
  }

  getOffsetMs(): number {
    return this.snapshot?.offsetMs ?? 0;
  }

  async sync(url: string, sampleCount = 5): Promise<TimeSyncSnapshot> {
    const normalizedUrl = normalizeUrl(url);
    const targetSamples = Math.max(1, Math.min(9, Math.round(sampleCount)));
    const samples = [];
    const failures: string[] = [];
    for (let index = 0; index < targetSamples; index += 1) {
      try {
        const response = await requestDateHeader(normalizedUrl, 'HEAD').catch(() => requestDateHeader(normalizedUrl, 'GET'));
        samples.push(estimateHttpDateSample(response));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (samples.length === 0) {
      throw new Error(`서버시간 동기화 실패: ${failures[0] ?? '응답 없음'}`);
    }

    const combined = combineTimeSamples(samples);
    const responseAtMs = Date.now();
    const estimatedServerNowMs = responseAtMs + combined.offsetMs;

    this.snapshot = {
      url: normalizedUrl,
      localTimeIso: new Date(responseAtMs).toISOString(),
      serverTimeIso: new Date(estimatedServerNowMs).toISOString(),
      syncedAtIso: new Date().toISOString(),
      roundTripMs: combined.roundTripMs,
      offsetMs: combined.offsetMs,
      sampleCount: samples.length,
      uncertaintyMs: combined.uncertaintyMs
    };

    this.logger.info(
      `서버시간 동기화 완료: offset ${combined.offsetMs}ms, RTT ${combined.roundTripMs}ms, 오차범위 ±${combined.uncertaintyMs}ms`,
      'time',
      this.snapshot
    );
    return this.snapshot;
  }
}

interface DateHeaderResponse {
  dateHeader: string;
  startedAtMs: number;
  responseAtMs: number;
}

function requestDateHeader(rawUrl: string, method: 'HEAD' | 'GET'): Promise<DateHeaderResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const startedAtMs = Date.now();
    const client = url.protocol === 'http:' ? http : https;
    const request = client.request(
      url,
      {
        method,
        timeout: 5000,
        headers: {
          'User-Agent': 'EWWeidian/0.3'
        }
      },
      (response) => {
        const dateHeader = response.headers.date;
        response.resume();
        const responseAtMs = Date.now();
        if (!dateHeader) {
          reject(new Error('응답에 HTTP Date 헤더가 없습니다.'));
          return;
        }

        resolve({
          dateHeader,
          startedAtMs,
          responseAtMs
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('서버시간 요청 시간 초과'));
    });
    request.on('error', reject);
    request.end();
  });
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return 'https://weidian.com/';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}
