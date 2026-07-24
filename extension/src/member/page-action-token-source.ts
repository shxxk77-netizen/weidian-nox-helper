import type {
  MemberActionType,
  MemberPageContext
} from '../../../src/common/types';
import { MemberActionError } from './member-errors';
import type { AcquiredActionToken } from './member-types';

interface PendingAcquisition {
  resolve: (token: AcquiredActionToken) => void;
  reject: (error: MemberActionError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type PageTokenScanRequester = (
  context: MemberPageContext,
  action: MemberActionType
) => Promise<void>;

export class PageObservedActionTokenSource {
  private readonly pending = new Map<string, PendingAcquisition>();

  constructor(
    private readonly requestScan: PageTokenScanRequester,
    private readonly timeoutMs = 3_000
  ) {}

  async acquire(
    context: MemberPageContext,
    action: MemberActionType
  ): Promise<AcquiredActionToken> {
    const key = tokenKey(context, action);
    if (this.pending.has(key)) {
      throw new MemberActionError(
        'ACTION_TOKEN_ALREADY_ACQUIRING',
        '동일한 Member 컨텍스트에서 actionToken 감지가 이미 진행 중입니다.'
      );
    }

    return new Promise<AcquiredActionToken>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new MemberActionError(
          'ACTION_TOKEN_NOT_FOUND',
          '실제 Weidian Member 페이지의 bootstrap·요청·응답에서 actionToken을 찾지 못했습니다.'
        ));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      void this.requestScan(context, action).catch((error) => {
        const pending = this.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(
          error instanceof MemberActionError
            ? error
            : new MemberActionError(
                'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
                error instanceof Error ? error.message : String(error)
              )
        );
      });
    });
  }

  accept(
    context: MemberPageContext,
    action: MemberActionType,
    token: AcquiredActionToken
  ): boolean {
    const key = tokenKey(context, action);
    const pending = this.pending.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve(token);
    return true;
  }

  clearContext(context: MemberPageContext): void {
    const prefix = `${context.sessionFingerprint}:${context.origin}:${context.shopId}:`;
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(new MemberActionError('SESSION_CHANGED'));
    }
  }

  clearAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new MemberActionError('SESSION_CHANGED'));
    }
    this.pending.clear();
  }
}

function tokenKey(context: MemberPageContext, action: MemberActionType): string {
  return `${context.sessionFingerprint}:${context.origin}:${context.shopId}:${action}`;
}
