import type {
  BrowserPageSnapshot,
  BrowserReservationRequest,
  BrowserReservationStatus
} from '../common/types';
import type { AppLogger } from './logger';

export interface BrowserReservationHooks {
  getServerOffsetMs: () => number;
  onExecute?: (request: BrowserReservationRequest) => void | Promise<void>;
  onStatus?: (status: BrowserReservationStatus) => void;
}

export class BrowserReservationRunner {
  private status: BrowserReservationStatus = { running: false, phase: 'idle' };
  private timer?: NodeJS.Timeout;
  private request?: BrowserReservationRequest;

  constructor(
    private readonly logger: AppLogger,
    private readonly hooks: BrowserReservationHooks
  ) {}

  start(request: BrowserReservationRequest): BrowserReservationStatus {
    const url = new URL(request.url);
    if (
      url.protocol !== 'https:' ||
      (!/(^|\.)weidian\.com$/i.test(url.hostname) && !/^k\.youshop10\.com$/i.test(url.hostname))
    ) {
      throw new Error('Weidian HTTPS 상품 URL 또는 k.youshop10.com 공유 주소만 예약할 수 있습니다.');
    }

    const targetServerEpochMs = new Date(request.targetServerTime).getTime();
    if (!Number.isFinite(targetServerEpochMs)) {
      throw new Error('한국 실행시간 형식이 올바르지 않습니다.');
    }
    const serverNowMs = Date.now() + this.hooks.getServerOffsetMs();
    if (targetServerEpochMs < serverNowMs - 5_000) {
      throw new Error('실행시간이 이미 5초 이상 지났습니다.');
    }

    this.clearTimer();
    this.request = { ...request };
    this.status = {
      running: true,
      phase: 'armed',
      targetPageUrl: request.url,
      targetServerTime: request.targetServerTime,
      targetServerEpochMs,
      startedAtIso: new Date().toISOString(),
      message:
        request.mode === 'preview'
          ? '미리보기 예약이 준비되었습니다.'
          : '주문 확인 화면 진입 예약이 준비되었습니다.'
    };
    this.logger.info(this.status.message!, 'browser-reservation', {
      url: request.url,
      targetServerEpochMs,
      optionKeyword: request.optionKeyword,
      mode: request.mode
    });
    this.scheduleOpeningPhase(targetServerEpochMs);
    this.emit();
    return this.getStatus();
  }

  stop(message = '사용자가 예약을 중지했습니다.'): BrowserReservationStatus {
    this.clearTimer();
    this.request = undefined;
    this.status = {
      ...this.status,
      running: false,
      phase: 'stopped',
      message
    };
    this.logger.warn(message, 'browser-reservation');
    this.emit();
    return this.getStatus();
  }

  getStatus(): BrowserReservationStatus {
    return { ...this.status };
  }

  handleSnapshot(snapshot: BrowserPageSnapshot | undefined): void {
    if (!this.status.running || !snapshot) {
      return;
    }
    const serverNowMs = Date.now() + this.hooks.getServerOffsetMs();
    if (
      (snapshot.pageKind === 'checkout' || snapshot.pageKind === 'payment') &&
      this.status.targetServerEpochMs !== undefined &&
      serverNowMs < this.status.targetServerEpochMs - 250
    ) {
      return;
    }
    if (snapshot.pageKind === 'checkout') {
      this.status = {
        ...this.status,
        phase: 'checkout',
        message: '주문 확인 화면에 도착했습니다. 주문 생성은 페이지에서 직접 확인하세요.'
      };
      this.logger.info(this.status.message!, 'browser-reservation');
      this.emit();
      return;
    }
    if (snapshot.pageKind === 'payment') {
      this.clearTimer();
      this.status = {
        ...this.status,
        running: false,
        phase: 'completed',
        message: '결제 대기 화면에 도착했습니다. QR 스캔과 최종 결제는 사용자가 직접 진행합니다.'
      };
      this.logger.info(this.status.message!, 'browser-reservation');
      this.emit();
    }
  }

  private scheduleOpeningPhase(targetServerEpochMs: number): void {
    const delay = Math.max(0, targetServerEpochMs - (Date.now() + this.hooks.getServerOffsetMs()));
    this.timer = setTimeout(() => {
      if (!this.status.running) {
        return;
      }
      this.status = {
        ...this.status,
        phase: 'opening',
        message: '실행시간에 도달했습니다. Chrome 확장 프로그램이 주문 확인 화면 진입을 시도합니다.'
      };
      this.logger.info(this.status.message!, 'browser-reservation');
      this.emit();
      const request = this.request;
      if (request) {
        void Promise.resolve(this.hooks.onExecute?.({ ...request })).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.clearTimer();
          this.status = {
            ...this.status,
            running: false,
            phase: 'failed',
            message: `예약 실행 실패: ${message}`
          };
          this.logger.error(`예약 실행 실패: ${message}`, 'browser-reservation');
          this.emit();
        });
      }
    }, delay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private emit(): void {
    this.hooks.onStatus?.(this.getStatus());
  }
}
