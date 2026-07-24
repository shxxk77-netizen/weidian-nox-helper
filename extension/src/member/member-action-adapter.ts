import type {
  BrowserMemberServerState,
  BrowserMemberWriteAdapterMeta,
  MemberActionType,
  MemberPageContext,
  ResetVipSettingsPayload,
  SaveVipSettingsPayload
} from '../../../src/common/types';
import { MemberActionError, type MemberErrorCode } from './member-errors';
import type {
  AcquiredActionToken,
  AuthorizedMemberAdapterConfig,
  MemberActionAdapter,
  MemberMutationResult
} from './member-types';

export const MEMBER_TOKEN_SOURCE = {
  mode: 'endpoint',
  requestUrlPattern: '/api/member/action-token',
  requestMethod: 'POST',
  tokenJsonPath: 'actionToken',
  expiresAtJsonPath: 'expiresAtEpochMs',
  credentials: 'include',
  requestHeaders: {},
  tokenPlacement: {
    type: 'body',
    key: 'actionToken'
  },
  actionBinding: 'per-action',
  oneTime: true
} as const;

export const DEFAULT_AUTHORIZED_MEMBER_CONFIG: AuthorizedMemberAdapterConfig = {
  mode: 'mock-localhost',
  baseUrl: 'http://127.0.0.1:4173',
  tokenSource: MEMBER_TOKEN_SOURCE,
  stateSource: {
    mode: 'endpoint',
    requestUrlPattern: '/api/member/context',
    requestMethod: 'POST',
    credentials: 'include',
    requestHeaders: {}
  },
  writeEndpoint: {
    status: 'configured',
    saveUrlPattern: '/api/member/save',
    resetUrlPattern: '/api/member/reset',
    requestMethod: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    requestHeaders: {},
    tokenPlacement: {
      type: 'body',
      key: 'actionToken'
    },
    memberBinding: 'current-session-user',
    shopIdField: 'shopId',
    targetIndexField: 'targetIndex'
  }
};

export const LIVE_PAGE_MEMBER_CONFIG: AuthorizedMemberAdapterConfig = {
  mode: 'live-weidian',
  baseUrl: '',
  tokenSource: {
    mode: 'page-observer',
    requestUrlPattern: '',
    requestMethod: 'POST',
    tokenJsonPath: '',
    credentials: 'include',
    requestHeaders: {},
    tokenPlacement: {
      type: 'body',
      key: 'actionToken'
    },
    actionBinding: 'per-action',
    oneTime: true
  },
  stateSource: {
    mode: 'page-context',
    requestUrlPattern: '__CONFIGURE_MEMBER_STATE_ENDPOINT__',
    requestMethod: 'POST',
    credentials: 'include',
    requestHeaders: {}
  },
  writeEndpoint: {
    status: 'not-configured',
    saveUrlPattern: '__CONFIGURE_MEMBER_WRITE_ENDPOINT__',
    resetUrlPattern: '__CONFIGURE_MEMBER_RESET_ENDPOINT__',
    requestMethod: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    requestHeaders: {},
    tokenPlacement: {
      type: 'body',
      key: '__CONFIGURE_ACTION_TOKEN_KEY__'
    },
    memberBinding: 'explicit-member-id',
    memberIdField: '__CONFIGURE_MEMBER_ID_FIELD__',
    shopIdField: '__CONFIGURE_SHOP_ID_FIELD__',
    targetIndexField: '__CONFIGURE_TARGET_INDEX_FIELD__'
  }
};

export const UNCONFIGURED_MEMBER_CONFIG = LIVE_PAGE_MEMBER_CONFIG;

export class AuthorizedMemberActionAdapter implements MemberActionAdapter {
  constructor(
    private readonly config: AuthorizedMemberAdapterConfig = DEFAULT_AUTHORIZED_MEMBER_CONFIG,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async detectContext(input: MemberPageContext): Promise<MemberPageContext> {
    validateContext(input);
    return { ...input, gradeNames: [...input.gradeNames] };
  }

  getWriteConfigurationStatus(): BrowserMemberWriteAdapterMeta {
    try {
      this.assertWriteConfigured('save-vip-settings');
      return { status: 'configured' };
    } catch (error) {
      const caught = error instanceof MemberActionError
        ? error
        : new MemberActionError('UNKNOWN_MEMBER_ERROR');
      return {
        status:
          caught.code === 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
            ? 'write-endpoint-not-configured'
            : caught.code === 'PERMISSION_DENIED'
              ? 'permission-denied'
              : 'error',
        errorCode: caught.code,
        errorMessage: caught.message
      };
    }
  }

  validateWriteConfiguration(action: 'save-vip-settings' | 'reset-vip-settings'): void {
    this.assertWriteConfigured(action);
  }

  async acquireActionToken(
    context: MemberPageContext,
    action: MemberActionType
  ): Promise<AcquiredActionToken> {
    if (this.config.tokenSource.mode === 'page-observer') {
      throw new MemberActionError(
        'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
        '페이지 관찰형 actionToken source는 Chrome 페이지 관찰기를 통해 획득해야 합니다.'
      );
    }
    this.assertTokenConfigured();
    const payload = await this.requestJson(this.config.tokenSource.requestUrlPattern, {
      method: this.config.tokenSource.requestMethod,
      credentials: this.config.tokenSource.credentials,
      headers: this.config.tokenSource.requestHeaders,
      configurationError: 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
      body: {
        shopId: context.shopId,
        action,
        sessionFingerprint: context.sessionFingerprint
      }
    });
    const rawToken = readJsonPath(payload, this.config.tokenSource.tokenJsonPath);
    if (typeof rawToken !== 'string' || !rawToken.trim()) {
      throw new MemberActionError('SERVER_RESPONSE_INVALID', '승인 서버 응답에 actionToken이 없습니다.', true);
    }
    const issuedAtEpochMs = finiteNumber(payload.issuedAtEpochMs) ?? Date.now();
    const expiresAtEpochMs =
      finiteNumber(readJsonPath(payload, this.config.tokenSource.expiresAtJsonPath)) ??
      addExpiresIn(issuedAtEpochMs, readJsonPath(payload, this.config.tokenSource.expiresInJsonPath));
    return {
      rawToken,
      issuedAtEpochMs,
      expiresAtEpochMs,
      oneTime: payload.oneTime === undefined ? this.config.tokenSource.oneTime : Boolean(payload.oneTime),
      source: 'authorized-response'
    };
  }

  async syncVipGrades(context: MemberPageContext): Promise<BrowserMemberServerState> {
    if (this.config.stateSource.mode === 'page-context') {
      return {
        ...stateFromPageContext(context),
        writeAdapter: this.getWriteConfigurationStatus()
      };
    }
    this.assertStateConfigured();
    const payload = await this.requestJson(this.config.stateSource.requestUrlPattern, {
      method: this.config.stateSource.requestMethod,
      credentials: this.config.stateSource.credentials,
      headers: this.config.stateSource.requestHeaders,
      configurationError: 'MEMBER_STATE_ENDPOINT_NOT_CONFIGURED',
      body: {
        shopId: context.shopId,
        sessionFingerprint: context.sessionFingerprint,
        pageUrl: context.pageUrl
      }
    });
    const gradeNames = Array.isArray(payload.gradeNames)
      ? payload.gradeNames.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())).slice(0, 30)
      : [];
    const gradeCount = finiteInteger(payload.gradeCount);
    const serverIndex = finiteInteger(payload.serverIndex);
    if (
      gradeCount === undefined ||
      gradeCount < 1 ||
      serverIndex === undefined ||
      serverIndex < 0 ||
      serverIndex >= gradeCount ||
      gradeNames.length !== gradeCount
    ) {
      throw new MemberActionError('SERVER_RESPONSE_INVALID', '승인 서버의 Member 상태 응답이 올바르지 않습니다.', true);
    }
    return {
      shopId: context.shopId,
      serverIndex,
      gradeCount,
      gradeNames,
      name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : gradeNames[serverIndex],
      remaining: finiteNumber(payload.remaining) ?? 0,
      originalProgress: finiteNumber(payload.originalProgress) ?? 0,
      syncedAtIso: new Date().toISOString(),
      readSource: 'mock-endpoint',
      actionToken: {
        status: 'empty',
        shopId: context.shopId,
        action: 'save-vip-settings',
        oneTime: true
      },
      writeAdapter: this.getWriteConfigurationStatus()
    };
  }

  async saveVipSettings(
    context: MemberPageContext,
    rawActionToken: string,
    payload: SaveVipSettingsPayload
  ): Promise<MemberMutationResult> {
    this.assertWriteConfigured('save-vip-settings');
    return this.mutate(this.config.writeEndpoint.saveUrlPattern, context, rawActionToken, payload);
  }

  async resetVipSettings(
    context: MemberPageContext,
    rawActionToken: string,
    payload: ResetVipSettingsPayload
  ): Promise<MemberMutationResult> {
    this.assertWriteConfigured('reset-vip-settings');
    return this.mutate(this.config.writeEndpoint.resetUrlPattern, context, rawActionToken, payload);
  }

  private async mutate(
    pathname: string,
    context: MemberPageContext,
    rawActionToken: string,
    payload: SaveVipSettingsPayload | ResetVipSettingsPayload
  ): Promise<MemberMutationResult> {
    const body: Record<string, unknown> = {
      [this.config.writeEndpoint.shopIdField]: payload.shopId,
      clientRequestId: payload.clientRequestId
    };
    if ('targetIndex' in payload) {
      body[this.config.writeEndpoint.targetIndexField] = payload.targetIndex;
      body.serverIndex = payload.serverIndex;
      body.gradeCount = payload.gradeCount;
      body.gradeNames = [...payload.gradeNames];
    }
    const headers: Record<string, string> = {};
    const query = new URLSearchParams();
    const placement = this.config.writeEndpoint.tokenPlacement;
    if (placement.type === 'body') body[placement.key] = rawActionToken;
    if (placement.type === 'header') headers[placement.key] = rawActionToken;
    if (placement.type === 'query') query.set(placement.key, rawActionToken);
    const response = await this.requestJson(`${pathname}${query.size ? `?${query}` : ''}`, {
      method: this.config.writeEndpoint.requestMethod,
      credentials: this.config.writeEndpoint.credentials,
      body,
      headers: {
        ...this.config.writeEndpoint.requestHeaders,
        ...headers
      },
      contentType: this.config.writeEndpoint.contentType,
      configurationError: 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
    });
    return {
      ok: response.ok === true,
      serverIndex: finiteInteger(response.serverIndex),
      errorCode: typeof response.errorCode === 'string' ? response.errorCode : undefined,
      errorMessage: typeof response.errorMessage === 'string' ? response.errorMessage.slice(0, 400) : undefined
    };
  }

  private async requestJson(
    pathname: string,
    input: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH';
      credentials: 'omit' | 'include';
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      contentType?: 'application/json';
      configurationError: 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED'
        | 'MEMBER_STATE_ENDPOINT_NOT_CONFIGURED'
        | 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED';
    }
  ): Promise<Record<string, any>> {
    const base = this.authorizedBaseUrl(input.configurationError);
    const url = new URL(pathname, base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        cache: 'no-store',
        credentials: input.credentials,
        signal: controller.signal,
        headers: {
          'content-type': input.contentType || 'application/json',
          ...(input.headers || {})
        },
        body: input.method === 'GET' ? undefined : JSON.stringify(input.body || {})
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MemberActionError('NETWORK_TIMEOUT', '승인 Member 서버 요청 시간이 초과되었습니다.', true);
      }
      throw new MemberActionError('NETWORK_ERROR', '승인 Member 서버에 연결할 수 없습니다.', true);
    } finally {
      clearTimeout(timer);
    }

    let payload: Record<string, any>;
    try {
      payload = await response.json() as Record<string, any>;
    } catch {
      throw new MemberActionError('SERVER_RESPONSE_INVALID', '승인 Member 서버가 JSON을 반환하지 않았습니다.', true);
    }
    if (!response.ok || payload.ok === false) {
      const code = normalizeServerErrorCode(payload.errorCode, response.status);
      throw new MemberActionError(
        code,
        typeof payload.errorMessage === 'string' ? payload.errorMessage.slice(0, 400) : code,
        true
      );
    }
    return payload;
  }

  private assertTokenConfigured(): void {
    if (
      this.config.tokenSource.mode === 'not-configured' ||
      this.config.tokenSource.mode === 'page-observer' ||
      this.config.mode === 'not-configured' ||
      !this.config.baseUrl ||
      this.config.tokenSource.requestUrlPattern.startsWith('__CONFIGURE_')
    ) {
      throw new MemberActionError(
        'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
        '승인된 actionToken source가 설정되지 않았습니다.'
      );
    }
    this.authorizedBaseUrl('ACTION_TOKEN_SOURCE_NOT_CONFIGURED');
  }

  private assertStateConfigured(): void {
    if (this.config.stateSource.mode === 'page-context') return;
    if (
      this.config.writeEndpoint.status === 'not-configured' ||
      this.config.mode === 'not-configured' ||
      !this.config.baseUrl ||
      !this.config.stateSource.requestUrlPattern ||
      this.config.stateSource.requestUrlPattern.startsWith('__CONFIGURE_')
    ) {
      throw new MemberActionError(
        'MEMBER_STATE_ENDPOINT_NOT_CONFIGURED',
        '저장 결과를 검증할 승인 Member 조회 endpoint가 설정되지 않았습니다.'
      );
    }
    this.authorizedBaseUrl('MEMBER_STATE_ENDPOINT_NOT_CONFIGURED');
  }

  private assertWriteConfigured(action: 'save-vip-settings' | 'reset-vip-settings'): void {
    const endpoint = action === 'save-vip-settings'
      ? this.config.writeEndpoint.saveUrlPattern
      : this.config.writeEndpoint.resetUrlPattern;
    const placementKey = this.config.writeEndpoint.tokenPlacement.key;
    if (
      this.config.mode === 'not-configured' ||
      !this.config.baseUrl ||
      !endpoint ||
      endpoint.startsWith('__CONFIGURE_') ||
      !placementKey ||
      placementKey.startsWith('__CONFIGURE_') ||
      !this.config.writeEndpoint.shopIdField ||
      this.config.writeEndpoint.shopIdField.startsWith('__CONFIGURE_') ||
      !this.config.writeEndpoint.targetIndexField ||
      this.config.writeEndpoint.targetIndexField.startsWith('__CONFIGURE_') ||
      (
        this.config.writeEndpoint.memberBinding === 'explicit-member-id' &&
        (
          !this.config.writeEndpoint.memberIdField ||
          this.config.writeEndpoint.memberIdField.startsWith('__CONFIGURE_')
        )
      )
    ) {
      throw new MemberActionError(
        'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
        '승인된 Member 쓰기 endpoint와 요청 계약이 설정되지 않았습니다.'
      );
    }
    this.authorizedBaseUrl('MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED');
  }

  private authorizedBaseUrl(
    configurationError: 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED'
      | 'MEMBER_STATE_ENDPOINT_NOT_CONFIGURED'
      | 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
  ): URL {
    let url: URL;
    try {
      url = new URL(this.config.baseUrl);
    } catch {
      throw new MemberActionError(configurationError);
    }
    const mockAllowed =
      this.config.mode === 'mock-localhost' &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.port === '4173';
    const liveAllowed =
      this.config.mode === 'live-weidian' &&
      url.protocol === 'https:' &&
      /(^|\.)weidian\.com$/i.test(url.hostname);
    if (!mockAllowed && !liveAllowed) {
      throw new MemberActionError(
        configurationError,
        'Member 어댑터 실행환경과 endpoint origin이 일치하지 않습니다.'
      );
    }
    return url;
  }
}

function stateFromPageContext(context: MemberPageContext): BrowserMemberServerState {
  validateContext(context);
  return {
    shopId: context.shopId,
    serverIndex: context.currentServerIndex,
    gradeCount: context.gradeCount,
    gradeNames: [...context.gradeNames],
    name: context.currentName || context.gradeNames[context.currentServerIndex],
    remaining: finiteNumber(context.remaining) ?? 0,
    originalProgress: finiteNumber(context.originalProgress) ?? 0,
    syncedAtIso: new Date().toISOString(),
    readSource: context.stateSource || 'weidian-page',
    actionToken: {
      status: 'empty',
      shopId: context.shopId,
      action: 'save-vip-settings',
      oneTime: true
    },
    writeAdapter: {
      status: 'write-endpoint-not-configured',
      errorCode: 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
      errorMessage: '실제 Member 쓰기 endpoint와 요청 계약이 설정되지 않았습니다.'
    }
  };
}

function validateContext(context: MemberPageContext): void {
  if (!context.shopId) throw new MemberActionError('SHOP_ID_MISSING');
  if (!context.sessionFingerprint) throw new MemberActionError('SESSION_FINGERPRINT_FAILED');
  if (!Number.isInteger(context.currentServerIndex)) throw new MemberActionError('SERVER_INDEX_INVALID');
  if (!Array.isArray(context.gradeNames)) throw new MemberActionError('GRADE_NAMES_INVALID');
  if (context.gradeNames.length !== context.gradeCount) throw new MemberActionError('GRADE_CATALOG_MISMATCH');
}

function readJsonPath(value: Record<string, any>, path: string | undefined): unknown {
  if (!path || path.startsWith('__CONFIGURE_')) return undefined;
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function finiteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function addExpiresIn(issuedAtEpochMs: number, expiresIn: unknown): number | undefined {
  const seconds = finiteNumber(expiresIn);
  return seconds === undefined ? undefined : issuedAtEpochMs + Math.max(0, seconds) * 1_000;
}

function normalizeServerErrorCode(value: unknown, status: number): MemberErrorCode {
  if (status === 401 || status === 403) return 'PERMISSION_DENIED';
  const known = new Set<MemberErrorCode>([
    'ACTION_TOKEN_EXPIRED',
    'ACTION_TOKEN_INVALID',
    'ACTION_TOKEN_ALREADY_USED',
    'SESSION_CHANGED',
    'SESSION_EXPIRED',
    'SHOP_ID_MISMATCH',
    'SERVER_INDEX_MISMATCH',
    'PERMISSION_DENIED',
    'SERVER_STATE_NOT_CHANGED'
  ]);
  return typeof value === 'string' && known.has(value as MemberErrorCode)
    ? value as MemberErrorCode
    : 'NETWORK_ERROR';
}
