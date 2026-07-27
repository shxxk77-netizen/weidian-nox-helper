import type {
  BrowserMemberServerState,
  BrowserMemberWriteAdapterMeta,
  MemberActionType,
  MemberPageContext,
  ResetVipSettingsPayload,
  SaveVipSettingsPayload
} from '../../../src/common/types';
import {
  DEFAULT_MEMBER_API_CONNECTION,
  MEMBER_API_BASE_URL,
  MEMBER_API_ENDPOINTS,
  MEMBER_API_HEADERS,
  resolveMemberApiUrl,
  type MemberApiConnectionSettings
} from '../../../src/common/memberAnalysisContract';
import { MemberActionError, type MemberErrorCode } from './member-errors';
import type {
  AcquiredActionToken,
  AuthorizedMemberAdapterConfig,
  MemberActionAdapter,
  MemberMutationResult,
  MemberPageRequestExecutor
} from './member-types';

export {
  MEMBER_API_BASE_URL,
  MEMBER_API_ENDPOINTS,
  MEMBER_API_HEADERS
};

export const MEMBER_TOKEN_SOURCE = {
  mode: 'page-observer',
  requestUrlPattern: 'wdtoken',
  requestMethod: 'GET',
  tokenJsonPath: 'wdtoken',
  credentials: 'include',
  requestHeaders: MEMBER_API_HEADERS,
  tokenPlacement: {
    type: 'query',
    key: 'wdtoken'
  },
  actionBinding: 'shared',
  oneTime: false
} as const;

export function createMemberAnalysisConfig(
  connection: MemberApiConnectionSettings = DEFAULT_MEMBER_API_CONNECTION
): AuthorizedMemberAdapterConfig {
  return {
    baseUrl: connection.baseUrl,
    tokenSource: MEMBER_TOKEN_SOURCE,
    stateSource: {
      mode: 'page-context',
      requestUrlPattern: connection.catalogEndpoint,
      requestMethod: 'GET',
      credentials: 'include',
      requestHeaders: MEMBER_API_HEADERS
    },
    writeEndpoint: {
      saveUrlPattern: connection.saveEndpoint,
      bulkSaveUrlPattern: connection.bulkSaveEndpoint,
      verifyUrlPattern: connection.verifyEndpoint,
      requestMethod: 'GET',
      credentials: 'include',
      requestHeaders: MEMBER_API_HEADERS,
      tokenPlacement: {
        type: 'query',
        key: 'wdtoken'
      },
      memberBinding: 'buyer-ids',
      buyerIdsField: 'buyerIds',
      memberIdField: 'memberId'
    }
  };
}

export const DEFAULT_AUTHORIZED_MEMBER_CONFIG: AuthorizedMemberAdapterConfig =
  createMemberAnalysisConfig();

export const MEMBER_ANALYSIS_CONFIG = DEFAULT_AUTHORIZED_MEMBER_CONFIG;

export class AuthorizedMemberActionAdapter implements MemberActionAdapter {
  constructor(
    private config: AuthorizedMemberAdapterConfig = DEFAULT_AUTHORIZED_MEMBER_CONFIG,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly executeInMemberPage?: MemberPageRequestExecutor
  ) {}

  configureConnection(connection: MemberApiConnectionSettings): void {
    this.config = createMemberAnalysisConfig(connection);
  }

  async detectContext(input: MemberPageContext): Promise<MemberPageContext> {
    validateContext(input);
    return { ...input, gradeNames: [...input.gradeNames] };
  }

  getWriteConfigurationStatus(): BrowserMemberWriteAdapterMeta {
    try {
      this.validateWriteConfiguration('save-vip-settings');
      return { status: 'configured' };
    } catch (error) {
      const caught = error instanceof MemberActionError
        ? error
        : new MemberActionError('MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED');
      return {
        status: 'write-endpoint-not-configured',
        errorCode: caught.code,
        errorMessage: caught.message
      };
    }
  }

  validateWriteConfiguration(action: 'save-vip-settings' | 'reset-vip-settings'): void {
    if (action === 'reset-vip-settings') {
      throw new MemberActionError(
        'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
        '실제 판매자 API에는 별도 reset endpoint가 없습니다. 목표 등급을 선택해 저장하세요.'
      );
    }
    const saveUrl = resolveConfiguredWeidianUrl(
      this.config.baseUrl,
      this.config.writeEndpoint.saveUrlPattern
    );
    if (!/\/wdcrm\/trade\.setMemberLevel\/2\.0$/i.test(saveUrl.pathname)) {
      throw new MemberActionError(
        'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
        '개별 회원 저장 endpoint가 trade.setMemberLevel/2.0 형식이 아닙니다.'
      );
    }
  }

  async acquireActionToken(
    _context: MemberPageContext,
    _action: MemberActionType
  ): Promise<AcquiredActionToken> {
    throw new MemberActionError(
      'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
      'wdtoken은 로그인된 Chrome의 실제 Weidian 요청에서 자동 감지합니다.'
    );
  }

  async syncVipGrades(context: MemberPageContext): Promise<BrowserMemberServerState> {
    return {
      ...stateFromPageContext(context),
      writeAdapter: this.getWriteConfigurationStatus()
    };
  }

  async saveVipSettings(
    context: MemberPageContext,
    rawWdToken: string,
    payload: SaveVipSettingsPayload
  ): Promise<MemberMutationResult> {
    this.validateWriteConfiguration('save-vip-settings');
    const buyerIds = normalizeBuyerIds(payload.buyerIds);
    const memberId = normalizeMemberId(payload.memberId);
    const url = this.createGetUrl(
      this.config.writeEndpoint.saveUrlPattern,
      rawWdToken,
      {
        [this.config.writeEndpoint.buyerIdsField]: buyerIds,
        [this.config.writeEndpoint.memberIdField]: memberId
      }
    );
    const response = await this.requestJson(context, url);
    const code = finiteInteger(response.status?.code);
    const accepted = code === 0 && Number(response.result) === 0;
    if (!accepted) {
      return {
        ok: false,
        errorCode: code === 401 || code === 403 ? 'PERMISSION_DENIED' : 'NETWORK_ERROR',
        errorMessage:
          typeof response.status?.message === 'string'
            ? response.status.message.slice(0, 400)
            : 'Weidian Member 등급 변경 응답이 성공 조건과 일치하지 않습니다.'
      };
    }

    const verified = await this.verifyMemberLevel(
      context,
      rawWdToken,
      buyerIds[0],
      memberId
    ).catch(() => undefined);
    if (verified === false) {
      return {
        ok: false,
        errorCode: 'SERVER_STATE_NOT_CHANGED',
        errorMessage: '저장 후 재조회한 회원 등급이 선택한 등급과 일치하지 않습니다.'
      };
    }
    return {
      ok: true,
      serverIndex: payload.targetIndex,
      verified: verified === true
    };
  }

  async resetVipSettings(
    _context: MemberPageContext,
    _rawWdToken: string,
    _payload: ResetVipSettingsPayload
  ): Promise<MemberMutationResult> {
    this.validateWriteConfiguration('reset-vip-settings');
    return { ok: false, errorCode: 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED' };
  }

  private async verifyMemberLevel(
    context: MemberPageContext,
    rawWdToken: string,
    buyerId: string,
    expectedMemberId: string
  ): Promise<boolean | undefined> {
    const verifyUrl = resolveConfiguredWeidianUrl(
      this.config.baseUrl,
      this.config.writeEndpoint.verifyUrlPattern
    );
    const url = new URL(verifyUrl);
    url.searchParams.set('_', String(Date.now()));
    url.searchParams.set('param', JSON.stringify({
      buyer_id: buyerId,
      page_size: 2
    }));
    url.searchParams.set('wdtoken', rawWdToken);
    const response = await this.requestJson(context, url);
    if (finiteInteger(response.status?.code) !== 0) return undefined;
    const detected = collectMemberLevelIds(response.result);
    if (!detected.length) return undefined;
    return detected.includes(expectedMemberId);
  }

  private createGetUrl(
    pathname: string,
    rawWdToken: string,
    param: Record<string, unknown>
  ): URL {
    const url = resolveConfiguredWeidianUrl(this.config.baseUrl, pathname);
    url.searchParams.set('_', String(Date.now()));
    url.searchParams.set('param', JSON.stringify(param));
    url.searchParams.set(this.config.writeEndpoint.tokenPlacement.key, rawWdToken);
    return url;
  }

  private async requestJson(
    context: MemberPageContext,
    url: URL
  ): Promise<Record<string, any>> {
    if (this.executeInMemberPage) {
      try {
        return await this.executeInMemberPage({
          context,
          url: url.toString(),
          method: 'GET'
        });
      } catch (error) {
        if (error instanceof MemberActionError) throw error;
        throw new MemberActionError(
          'NETWORK_ERROR',
          error instanceof Error ? error.message : '판매자 페이지 요청 실행에 실패했습니다.',
          true
        );
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
        signal: controller.signal,
        headers: this.config.writeEndpoint.requestHeaders
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MemberActionError('NETWORK_TIMEOUT', 'Weidian Member 요청 시간이 초과되었습니다.', true);
      }
      throw new MemberActionError('NETWORK_ERROR', 'Weidian Member API에 연결할 수 없습니다.', true);
    } finally {
      clearTimeout(timer);
    }

    let payload: Record<string, any>;
    try {
      payload = await response.json() as Record<string, any>;
    } catch {
      throw new MemberActionError('SERVER_RESPONSE_INVALID', 'Weidian API가 JSON을 반환하지 않았습니다.', true);
    }
    if (!response.ok) {
      throw new MemberActionError(
        normalizeServerErrorCode(payload.status?.code, response.status),
        typeof payload.status?.message === 'string'
          ? payload.status.message.slice(0, 400)
          : `HTTP ${response.status}`,
        true
      );
    }
    return payload;
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
      oneTime: false
    },
    writeAdapter: {
      status: 'configured'
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

function resolveConfiguredWeidianUrl(baseUrl: string, endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(resolveMemberApiUrl(baseUrl, endpoint));
  } catch {
    throw new MemberActionError('MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED');
  }
  if (url.protocol !== 'https:' || !/(^|\.)weidian\.com$/i.test(url.hostname)) {
    throw new MemberActionError(
      'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
      'Weidian HTTPS endpoint만 Member 쓰기에 사용할 수 있습니다.'
    );
  }
  return url;
}

function normalizeBuyerIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new MemberActionError('SERVER_RESPONSE_INVALID', 'buyerIds가 비어 있습니다.');
  const result = [...new Set(
    value
      .map((item) => String(item || '').trim())
      .filter((item) => /^[A-Za-z0-9_-]{1,100}$/.test(item))
  )].slice(0, 200);
  if (!result.length) throw new MemberActionError('SERVER_RESPONSE_INVALID', 'buyerIds가 비어 있습니다.');
  return result;
}

function normalizeMemberId(value: unknown): string {
  const memberId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(memberId)) {
    throw new MemberActionError('SERVER_RESPONSE_INVALID', '선택한 Member 등급 ID가 올바르지 않습니다.');
  }
  return memberId;
}

function collectMemberLevelIds(value: unknown, depth = 0): string[] {
  if (!value || depth > 6) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => collectMemberLevelIds(item, depth + 1)))];
  }
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const result: string[] = [];
  for (const [key, child] of Object.entries(record).slice(0, 200)) {
    if (/^(?:level|memberId|member_id)$/i.test(key)) {
      const candidate = String(child ?? '').trim();
      if (/^[A-Za-z0-9_-]{1,100}$/.test(candidate)) result.push(candidate);
    }
    if (child && typeof child === 'object') {
      result.push(...collectMemberLevelIds(child, depth + 1));
    }
  }
  return [...new Set(result)];
}

function finiteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function normalizeServerErrorCode(value: unknown, status: number): MemberErrorCode {
  if (status === 401 || status === 403 || Number(value) === 401 || Number(value) === 403) {
    return 'PERMISSION_DENIED';
  }
  return 'NETWORK_ERROR';
}
