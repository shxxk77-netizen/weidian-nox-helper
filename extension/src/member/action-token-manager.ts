import type {
  BrowserActionTokenMeta,
  MemberActionType,
  MemberPageContext
} from '../../../src/common/types';
import {
  errorCodeToTokenStatus,
  MemberActionError,
  sanitizeMemberErrorMessage
} from './member-errors';
import type { AcquiredActionToken } from './member-types';

interface StoredActionToken {
  rawToken: string;
  fingerprint: string;
  shopId: string;
  action: MemberActionType;
  sessionFingerprint: string;
  origin: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs?: number;
  oneTime: boolean;
  consumed: boolean;
  consuming: boolean;
  source: AcquiredActionToken['source'];
  consumedAtEpochMs?: number;
}

export type ActionTokenAcquirer = (
  context: MemberPageContext,
  action: MemberActionType
) => Promise<AcquiredActionToken>;

export type ActionTokenStatusListener = (
  context: MemberPageContext,
  meta: BrowserActionTokenMeta
) => void;

export interface ActionTokenManager {
  getStatus(context: MemberPageContext, action: MemberActionType): BrowserActionTokenMeta;
  acquire(context: MemberPageContext, action: MemberActionType): Promise<BrowserActionTokenMeta>;
  ingest(
    context: MemberPageContext,
    action: MemberActionType,
    acquired: AcquiredActionToken
  ): Promise<BrowserActionTokenMeta>;
  getOrAcquireRawToken(context: MemberPageContext, action: MemberActionType): Promise<string>;
  markConsuming(context: MemberPageContext, action: MemberActionType): void;
  markConsumed(context: MemberPageContext, action: MemberActionType): void;
  markExpired(context: MemberPageContext, action: MemberActionType): void;
  invalidate(context: MemberPageContext, action: MemberActionType, reason: string): void;
  clearShop(shopId: string): void;
  clearSession(sessionFingerprint: string): void;
  clearAll(): void;
}

export class InMemoryActionTokenManager implements ActionTokenManager {
  private readonly tokens = new Map<string, StoredActionToken>();
  private readonly statusOverrides = new Map<string, BrowserActionTokenMeta>();
  private readonly acquiring = new Map<string, Promise<BrowserActionTokenMeta>>();

  constructor(
    private readonly acquireToken: ActionTokenAcquirer,
    private readonly now: () => number = Date.now,
    private readonly onStatusChange?: ActionTokenStatusListener
  ) {}

  getStatus(context: MemberPageContext, action: MemberActionType): BrowserActionTokenMeta {
    const key = this.tokenKey(context, action);
    const override = this.statusOverrides.get(key);
    if (override) {
      return { ...override };
    }
    const token = this.tokens.get(key);
    if (!token) {
      const mismatch = this.findContextMismatch(context, action);
      return mismatch || {
        status: 'empty',
        shopId: context.shopId,
        action,
        oneTime: true
      };
    }
    if (token.expiresAtEpochMs !== undefined && token.expiresAtEpochMs <= this.now()) {
      this.tokens.delete(key);
      const expired = this.meta(token, 'expired', {
        lastErrorCode: 'ACTION_TOKEN_EXPIRED',
        lastErrorMessage: 'actionToken이 만료되었습니다.'
      });
      this.statusOverrides.set(key, expired);
      this.publish(context, expired);
      return { ...expired };
    }
    if (token.consumed) return this.meta(token, 'consumed');
    if (token.consuming) return this.meta(token, 'consuming');
    return this.meta(token, 'ready');
  }

  async acquire(context: MemberPageContext, action: MemberActionType): Promise<BrowserActionTokenMeta> {
    this.assertContext(context);
    const key = this.tokenKey(context, action);
    if (this.acquiring.has(key)) {
      throw new MemberActionError('ACTION_TOKEN_ALREADY_ACQUIRING', 'actionToken 발급이 이미 진행 중입니다.');
    }
    this.tokens.delete(key);
    const acquiringMeta: BrowserActionTokenMeta = {
      status: 'acquiring',
      shopId: context.shopId,
      action,
      oneTime: true
    };
    this.statusOverrides.set(key, acquiringMeta);
    this.publish(context, acquiringMeta);

    const job = this.acquireToken(context, action)
      .then((acquired) => this.ingest(context, action, acquired))
      .catch((error) => {
        const caught = error instanceof MemberActionError
          ? error
          : new MemberActionError(
              'UNKNOWN_MEMBER_ERROR',
              sanitizeMemberErrorMessage(error instanceof Error ? error.message : String(error))
            );
        const failedMeta: BrowserActionTokenMeta = {
          status: errorCodeToTokenStatus(caught.code),
          shopId: context.shopId,
          action,
          oneTime: true,
          lastErrorCode: caught.code,
          lastErrorMessage: caught.message
        };
        this.statusOverrides.set(key, failedMeta);
        this.publish(context, failedMeta);
        throw caught;
      })
      .finally(() => {
        this.acquiring.delete(key);
      });

    this.acquiring.set(key, job);
    return job;
  }

  async ingest(
    context: MemberPageContext,
    action: MemberActionType,
    acquired: AcquiredActionToken
  ): Promise<BrowserActionTokenMeta> {
    this.assertContext(context);
    const rawToken = acquired.rawToken?.trim();
    if (!rawToken) {
      throw new MemberActionError('ACTION_TOKEN_MISSING', '감지된 actionToken이 비어 있습니다.');
    }
    if (
      acquired.expiresAtEpochMs !== undefined &&
      acquired.expiresAtEpochMs <= this.now()
    ) {
      throw new MemberActionError('ACTION_TOKEN_EXPIRED', '감지된 actionToken이 이미 만료되었습니다.');
    }
    const key = this.tokenKey(context, action);
    const fingerprint = await fingerprintToken(rawToken);
    const existing = this.tokens.get(key);
    if (
      existing &&
      existing.fingerprint === fingerprint &&
      !existing.consumed &&
      !existing.consuming
    ) {
      return this.meta(existing, 'ready');
    }
    const token: StoredActionToken = {
      rawToken,
      fingerprint,
      shopId: context.shopId,
      action,
      sessionFingerprint: context.sessionFingerprint,
      origin: context.origin,
      issuedAtEpochMs: acquired.issuedAtEpochMs,
      expiresAtEpochMs: acquired.expiresAtEpochMs,
      oneTime: acquired.oneTime,
      consumed: false,
      consuming: false,
      source: acquired.source
    };
    this.tokens.set(key, token);
    this.statusOverrides.delete(key);
    const readyMeta = this.meta(token, 'ready');
    this.publish(context, readyMeta);
    return readyMeta;
  }

  async getOrAcquireRawToken(context: MemberPageContext, action: MemberActionType): Promise<string> {
    const key = this.tokenKey(context, action);
    let token = this.tokens.get(key);
    if (token?.expiresAtEpochMs !== undefined && token.expiresAtEpochMs <= this.now() + 5_000) {
      this.markExpired(context, action);
      token = undefined;
    }
    if (!token) {
      await this.acquire(context, action);
      token = this.tokens.get(key);
    }
    if (!token) {
      throw new MemberActionError('ACTION_TOKEN_MISSING');
    }
    if (token.consuming) {
      throw new MemberActionError('ACTION_TOKEN_ALREADY_CONSUMING');
    }
    if (token.consumed) {
      throw new MemberActionError('ACTION_TOKEN_ALREADY_CONSUMED');
    }
    return token.rawToken;
  }

  markConsuming(context: MemberPageContext, action: MemberActionType): void {
    const token = this.requireToken(context, action);
    if (token.consumed) throw new MemberActionError('ACTION_TOKEN_ALREADY_CONSUMED');
    if (token.consuming) throw new MemberActionError('ACTION_TOKEN_ALREADY_CONSUMING');
    token.consuming = true;
    this.statusOverrides.delete(this.tokenKey(context, action));
    this.publish(context, this.meta(token, 'consuming'));
  }

  markConsumed(context: MemberPageContext, action: MemberActionType): void {
    const token = this.requireToken(context, action);
    token.consuming = false;
    token.consumed = true;
    token.consumedAtEpochMs = this.now();
    if (!token.oneTime) {
      token.consumed = false;
      token.consumedAtEpochMs = undefined;
    } else {
      token.rawToken = '';
    }
    this.publish(context, this.meta(token, token.consumed ? 'consumed' : 'ready'));
  }

  markExpired(context: MemberPageContext, action: MemberActionType): void {
    const key = this.tokenKey(context, action);
    const token = this.tokens.get(key);
    this.tokens.delete(key);
    const expiredMeta: BrowserActionTokenMeta = token
      ? this.meta(token, 'expired', {
          lastErrorCode: 'ACTION_TOKEN_EXPIRED',
          lastErrorMessage: 'actionToken이 만료되었습니다.'
        })
      : {
          status: 'expired',
          shopId: context.shopId,
          action,
          oneTime: true,
          lastErrorCode: 'ACTION_TOKEN_EXPIRED',
          lastErrorMessage: 'actionToken이 만료되었습니다.'
        };
    this.statusOverrides.set(key, expiredMeta);
    this.publish(context, expiredMeta);
  }

  invalidate(context: MemberPageContext, action: MemberActionType, reason: string): void {
    const key = this.tokenKey(context, action);
    const token = this.tokens.get(key);
    this.tokens.delete(key);
    const invalidMeta: BrowserActionTokenMeta = token
      ? this.meta(token, 'invalid', {
          lastErrorCode: 'ACTION_TOKEN_INVALID',
          lastErrorMessage: sanitizeMemberErrorMessage(reason)
        })
      : {
          status: 'invalid',
          shopId: context.shopId,
          action,
          oneTime: true,
          lastErrorCode: 'ACTION_TOKEN_INVALID',
          lastErrorMessage: sanitizeMemberErrorMessage(reason)
        };
    this.statusOverrides.set(key, invalidMeta);
    this.publish(context, invalidMeta);
  }

  setFailure(
    context: MemberPageContext,
    action: MemberActionType,
    status: BrowserActionTokenMeta['status'],
    code: string,
    message: string
  ): void {
    const key = this.tokenKey(context, action);
    const token = this.tokens.get(key);
    this.tokens.delete(key);
    const failedMeta: BrowserActionTokenMeta = {
      ...(token ? this.meta(token, status) : {
        status,
        shopId: context.shopId,
        action,
        oneTime: true
      }),
      lastErrorCode: code,
      lastErrorMessage: sanitizeMemberErrorMessage(message)
    };
    this.statusOverrides.set(key, failedMeta);
    this.publish(context, failedMeta);
  }

  clearShop(shopId: string): void {
    this.deleteMatching((token) => token.shopId === shopId);
    this.deleteOverridesContaining(`:${shopId}:`);
  }

  clearSession(sessionFingerprint: string): void {
    this.deleteMatching((token) => token.sessionFingerprint === sessionFingerprint);
    this.deleteOverridesStarting(`${sessionFingerprint}:`);
  }

  clearAll(): void {
    this.tokens.clear();
    this.statusOverrides.clear();
    this.acquiring.clear();
  }

  private requireToken(context: MemberPageContext, action: MemberActionType): StoredActionToken {
    const token = this.tokens.get(this.tokenKey(context, action));
    if (!token) throw new MemberActionError('ACTION_TOKEN_MISSING');
    return token;
  }

  private tokenKey(context: MemberPageContext, action: MemberActionType): string {
    return `${context.sessionFingerprint}:${context.origin}:${context.shopId}:${action}`;
  }

  private assertContext(context: MemberPageContext): void {
    if (!context.shopId) throw new MemberActionError('SHOP_ID_MISSING');
    if (!context.sessionFingerprint) throw new MemberActionError('SESSION_FINGERPRINT_FAILED');
    if (!context.origin) throw new MemberActionError('SESSION_MISSING');
  }

  private publish(context: MemberPageContext, meta: BrowserActionTokenMeta): void {
    this.onStatusChange?.(context, { ...meta });
  }

  private meta(
    token: StoredActionToken,
    status: BrowserActionTokenMeta['status'],
    extra: Partial<BrowserActionTokenMeta> = {}
  ): BrowserActionTokenMeta {
    return {
      status,
      tokenFingerprint: token.fingerprint,
      shopId: token.shopId,
      action: token.action,
      issuedAtEpochMs: token.issuedAtEpochMs,
      expiresAtEpochMs: token.expiresAtEpochMs,
      consumedAtEpochMs: token.consumedAtEpochMs,
      oneTime: token.oneTime,
      source: token.source,
      ...extra
    };
  }

  private findContextMismatch(
    context: MemberPageContext,
    action: MemberActionType
  ): BrowserActionTokenMeta | undefined {
    for (const token of this.tokens.values()) {
      if (token.action !== action || token.origin !== context.origin) continue;
      if (token.shopId === context.shopId && token.sessionFingerprint !== context.sessionFingerprint) {
        return this.meta(token, 'session-mismatch', {
          lastErrorCode: 'SESSION_CHANGED',
          lastErrorMessage: '로그인 세션이 변경되어 기존 actionToken을 사용할 수 없습니다.'
        });
      }
      if (token.sessionFingerprint === context.sessionFingerprint && token.shopId !== context.shopId) {
        return this.meta(token, 'shop-mismatch', {
          lastErrorCode: 'SHOP_ID_MISMATCH',
          lastErrorMessage: '다른 상점에서 발급된 actionToken입니다.'
        });
      }
    }
    return undefined;
  }

  private deleteMatching(predicate: (token: StoredActionToken) => boolean): void {
    for (const [key, token] of this.tokens) {
      if (predicate(token)) this.tokens.delete(key);
    }
  }

  private deleteOverridesContaining(fragment: string): void {
    for (const key of this.statusOverrides.keys()) {
      if (key.includes(fragment)) this.statusOverrides.delete(key);
    }
  }

  private deleteOverridesStarting(prefix: string): void {
    for (const key of this.statusOverrides.keys()) {
      if (key.startsWith(prefix)) this.statusOverrides.delete(key);
    }
  }
}

export async function fingerprintToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
