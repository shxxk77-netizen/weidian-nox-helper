import type {
  BrowserActionTokenMeta,
  BrowserCommand,
  BrowserMemberCommandResult,
  BrowserMemberServerState,
  MemberActionType,
  MemberPageContext,
  ResetVipSettingsPayload,
  SaveVipSettingsPayload,
  SyncVipGradesPayload
} from '../../../src/common/types';
import { InMemoryActionTokenManager } from './action-token-manager';
import { validateMemberPageContext } from './member-context';
import {
  errorCodeToTokenStatus,
  MemberActionError,
  sanitizeMemberErrorMessage,
  toMemberActionError
} from './member-errors';
import type { MemberActionAdapter, MemberMutationResult } from './member-types';

const MEMBER_COMMAND_TYPES = new Set([
  'sync-vip-grades',
  'refresh-action-token',
  'get-action-token-status',
  'save-vip-settings',
  'reset-vip-settings'
]);

export class MemberCommandHandler {
  private readonly locks = new Set<string>();
  private readonly processedRequestIds = new Map<string, number>();
  private readonly states = new Map<string, BrowserMemberServerState>();

  constructor(
    private readonly adapter: MemberActionAdapter,
    readonly tokenManager: InMemoryActionTokenManager,
    private readonly now: () => number = Date.now
  ) {}

  async execute(command: BrowserCommand, rawContext: MemberPageContext): Promise<BrowserMemberCommandResult> {
    const clientRequestId = optionalString(command.payload?.clientRequestId);
    try {
      if (!MEMBER_COMMAND_TYPES.has(command.type)) {
        throw new MemberActionError('UNKNOWN_MEMBER_ERROR', `지원하지 않는 Member 명령: ${command.type}`);
      }
      if (!clientRequestId) throw new MemberActionError('CLIENT_REQUEST_ID_MISSING');
      this.cleanupProcessed();
      if (clientRequestId && this.processedRequestIds.has(clientRequestId)) {
        throw new MemberActionError('DUPLICATE_CLIENT_REQUEST');
      }
      if (clientRequestId) this.processedRequestIds.set(clientRequestId, this.now());

      const context = validateMemberPageContext(await this.adapter.detectContext(rawContext));
      if (command.type === 'sync-vip-grades') {
        return await this.withLock(context.shopId, 'sync-vip-grades', async () => {
          validateSyncPayload(command.payload, context);
          return this.success(command, clientRequestId, await this.sync(context, false));
        });
      }
      if (command.type === 'get-action-token-status') {
        const action = normalizeRequestedAction(command.payload?.action);
        const state = this.states.get(context.shopId);
        return this.success(command, clientRequestId, state, this.tokenManager.getStatus(context, action));
      }
      if (command.type === 'refresh-action-token') {
        const action = normalizeRequestedAction(command.payload?.action);
        if (this.tokenManager.getStatus(context, action).status !== 'empty') {
          this.tokenManager.invalidate(context, action, '사용자가 actionToken 새로고침을 요청했습니다.');
        }
        const meta = await this.tokenManager.acquire(context, action);
        const state = await this.sync(context, false, meta);
        return this.success(command, clientRequestId, state, meta);
      }
      if (command.type === 'save-vip-settings') {
        return await this.withLock(context.shopId, 'save-vip-settings', async () => {
          const payload = validateSaveVipSettingsPayload(command.payload);
          this.assertTarget(context, payload.shopId, payload.targetPageUrl);
          const state = await this.save(context, payload);
          return this.success(command, clientRequestId, state, state.actionToken);
        });
      }
      return await this.withLock(context.shopId, 'reset-vip-settings', async () => {
        const payload = validateResetVipSettingsPayload(command.payload);
        this.assertTarget(context, payload.shopId, payload.targetPageUrl);
        const state = await this.reset(context, payload);
        return this.success(command, clientRequestId, state, state.actionToken);
      });
    } catch (error) {
      const caught = toMemberActionError(error);
      const context = safeContext(rawContext);
      const action = command.type === 'reset-vip-settings' ? 'reset-vip-settings' : 'save-vip-settings';
      let tokenMeta: BrowserActionTokenMeta | undefined;
      if (context) {
        if (
          caught.code === 'PERMISSION_DENIED' ||
          caught.code === 'SHOP_ID_MISMATCH' ||
          caught.code === 'SESSION_CHANGED' ||
          caught.code === 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED'
        ) {
          this.tokenManager.setFailure(
            context,
            action,
            errorCodeToTokenStatus(caught.code),
            caught.code,
            caught.message
          );
        }
        tokenMeta = this.tokenManager.getStatus(context, action);
      }
      const state = context ? this.states.get(context.shopId) : undefined;
      return {
        commandId: command.id,
        commandType: command.type,
        clientRequestId,
        ok: false,
        completedAtIso: new Date(this.now()).toISOString(),
        errorCode: caught.code,
        errorMessage: sanitizeMemberErrorMessage(caught.message),
        memberServerState: state ? { ...state, actionToken: tokenMeta || state.actionToken } : undefined,
        actionToken: tokenMeta
      };
    }
  }

  clearShop(shopId: string): void {
    this.states.delete(shopId);
    this.tokenManager.clearShop(shopId);
  }

  clearSession(sessionFingerprint: string): void {
    this.tokenManager.clearSession(sessionFingerprint);
  }

  private async sync(
    context: MemberPageContext,
    acquireIfEmpty: boolean,
    suppliedMeta?: BrowserActionTokenMeta
  ): Promise<BrowserMemberServerState> {
    const state = await this.adapter.syncVipGrades(context);
    const effectiveContext = contextFromState(context, state);
    let actionToken = suppliedMeta || this.tokenManager.getStatus(effectiveContext, 'save-vip-settings');
    if (
      acquireIfEmpty &&
      ['empty', 'expired', 'invalid', 'consumed', 'error'].includes(actionToken.status)
    ) {
      actionToken = await this.tokenManager.acquire(effectiveContext, 'save-vip-settings');
    }
    const next = { ...state, actionToken };
    this.states.set(context.shopId, next);
    return next;
  }

  private async save(
    context: MemberPageContext,
    payload: SaveVipSettingsPayload
  ): Promise<BrowserMemberServerState> {
    this.adapter.validateWriteConfiguration?.('save-vip-settings');
    const before = await this.adapter.syncVipGrades(context);
    assertPayloadMatchesState(payload, before);
    const effectiveContext = contextFromState(context, before);
    const target = payload.targetIndex;

    let mutationError: MemberActionError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.performMutation(
          effectiveContext,
          'save-vip-settings',
          (rawToken) => this.adapter.saveVipSettings(effectiveContext, rawToken, payload)
        );
        mutationError = undefined;
      } catch (error) {
        mutationError = toMemberActionError(error);
      }

      const verified = await this.adapter.syncVipGrades(effectiveContext);
      if (verified.serverIndex === target) {
        const state = {
          ...verified,
          actionToken: this.tokenManager.getStatus(effectiveContext, 'save-vip-settings')
        };
        this.states.set(context.shopId, state);
        return state;
      }

      if (!mutationError) {
        throw new MemberActionError(
          'SERVER_STATE_NOT_CHANGED',
          `재조회된 serverIndex ${verified.serverIndex}가 targetIndex ${target}와 일치하지 않습니다.`
        );
      }
      if (!shouldRetry(mutationError, attempt)) throw mutationError;
      this.tokenManager.invalidate(effectiveContext, 'save-vip-settings', mutationError.code);
      await this.tokenManager.acquire(effectiveContext, 'save-vip-settings');
    }
    throw mutationError || new MemberActionError('SERVER_STATE_NOT_CHANGED');
  }

  private async reset(
    context: MemberPageContext,
    payload: ResetVipSettingsPayload
  ): Promise<BrowserMemberServerState> {
    this.adapter.validateWriteConfiguration?.('reset-vip-settings');
    const before = await this.adapter.syncVipGrades(context);
    const effectiveContext = contextFromState(context, before);
    let mutationError: MemberActionError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.performMutation(
          effectiveContext,
          'reset-vip-settings',
          (rawToken) => this.adapter.resetVipSettings(effectiveContext, rawToken, payload)
        );
        mutationError = undefined;
      } catch (error) {
        mutationError = toMemberActionError(error);
      }
      const verified = await this.adapter.syncVipGrades(effectiveContext);
      if (verified.serverIndex === 0) {
        const state = {
          ...verified,
          actionToken: this.tokenManager.getStatus(effectiveContext, 'reset-vip-settings')
        };
        this.states.set(context.shopId, state);
        return state;
      }
      if (!mutationError) {
        throw new MemberActionError('SERVER_STATE_NOT_CHANGED', `reset 후 serverIndex가 ${verified.serverIndex}입니다.`);
      }
      if (!shouldRetry(mutationError, attempt)) throw mutationError;
      this.tokenManager.invalidate(effectiveContext, 'reset-vip-settings', mutationError.code);
      await this.tokenManager.acquire(effectiveContext, 'reset-vip-settings');
    }
    throw mutationError || new MemberActionError('SERVER_STATE_NOT_CHANGED');
  }

  private async performMutation(
    context: MemberPageContext,
    action: 'save-vip-settings' | 'reset-vip-settings',
    mutate: (rawToken: string) => Promise<MemberMutationResult>
  ): Promise<void> {
    this.adapter.validateWriteConfiguration?.(action);
    const rawToken = await this.tokenManager.getOrAcquireRawToken(context, action);
    this.tokenManager.markConsuming(context, action);
    try {
      const result = await mutate(rawToken);
      this.tokenManager.markConsumed(context, action);
      if (!result.ok) {
        throw new MemberActionError(
          normalizeMutationErrorCode(result.errorCode),
          result.errorMessage || result.errorCode || 'Member 저장 요청이 실패했습니다.',
          true
        );
      }
    } catch (error) {
      const caught = toMemberActionError(error);
      if (caught.requestStarted) {
        try {
          this.tokenManager.markConsumed(context, action);
        } catch {
          // The token may already be marked consumed after a parsed server response.
        }
      }
      throw caught;
    }
  }

  private assertTarget(context: MemberPageContext, shopId: string, targetPageUrl: string): void {
    if (context.shopId !== shopId) throw new MemberActionError('SHOP_ID_MISMATCH');
    if (!targetPageUrl) throw new MemberActionError('TARGET_PAGE_URL_MISSING');
    let target: URL;
    try {
      target = new URL(targetPageUrl);
    } catch {
      throw new MemberActionError('TARGET_PAGE_MISMATCH');
    }
    const current = new URL(context.pageUrl);
    if (target.origin !== current.origin || target.pathname !== current.pathname) {
      throw new MemberActionError('TARGET_PAGE_MISMATCH');
    }
  }

  private async withLock<T>(
    shopId: string,
    action: string,
    task: () => Promise<T>
  ): Promise<T> {
    const key = `${shopId}:${action}`;
    if (this.locks.has(key)) throw new MemberActionError('MEMBER_ACTION_ALREADY_RUNNING');
    this.locks.add(key);
    try {
      return await task();
    } finally {
      this.locks.delete(key);
    }
  }

  private success(
    command: BrowserCommand,
    clientRequestId: string | undefined,
    memberServerState?: BrowserMemberServerState,
    actionToken?: BrowserActionTokenMeta
  ): BrowserMemberCommandResult {
    return {
      commandId: command.id,
      commandType: command.type,
      clientRequestId,
      ok: true,
      completedAtIso: new Date(this.now()).toISOString(),
      memberServerState,
      actionToken: actionToken || memberServerState?.actionToken
    };
  }

  private cleanupProcessed(): void {
    const cutoff = this.now() - 5 * 60_000;
    for (const [id, savedAt] of this.processedRequestIds) {
      if (savedAt < cutoff) this.processedRequestIds.delete(id);
    }
  }
}

export function validateSaveVipSettingsPayload(value: unknown): SaveVipSettingsPayload {
  if (!value || typeof value !== 'object') throw new MemberActionError('SERVER_RESPONSE_INVALID');
  const payload = value as Partial<SaveVipSettingsPayload>;
  if (!payload.shopId) throw new MemberActionError('SHOP_ID_MISSING');
  if (!Number.isInteger(payload.serverIndex)) throw new MemberActionError('SERVER_INDEX_INVALID');
  if (!Number.isInteger(payload.targetIndex)) throw new MemberActionError('TARGET_INDEX_INVALID');
  if ((payload.targetIndex as number) < 0 || (payload.targetIndex as number) >= Number(payload.gradeCount)) {
    throw new MemberActionError('TARGET_INDEX_OUT_OF_RANGE');
  }
  if (!Array.isArray(payload.gradeNames)) throw new MemberActionError('GRADE_NAMES_INVALID');
  if (payload.gradeNames.length !== payload.gradeCount) throw new MemberActionError('GRADE_CATALOG_MISMATCH');
  if (!payload.clientRequestId) throw new MemberActionError('CLIENT_REQUEST_ID_MISSING');
  if (!payload.targetPageUrl) throw new MemberActionError('TARGET_PAGE_URL_MISSING');
  return {
    shopId: payload.shopId,
    serverIndex: payload.serverIndex as number,
    targetIndex: payload.targetIndex as number,
    gradeCount: payload.gradeCount as number,
    gradeNames: payload.gradeNames.map(String),
    name: String(payload.name || ''),
    remaining: finiteNumber(payload.remaining),
    originalProgress: finiteNumber(payload.originalProgress),
    targetPageUrl: payload.targetPageUrl,
    clientRequestId: payload.clientRequestId
  };
}

function validateResetVipSettingsPayload(value: unknown): ResetVipSettingsPayload {
  if (!value || typeof value !== 'object') throw new MemberActionError('SERVER_RESPONSE_INVALID');
  const payload = value as Partial<ResetVipSettingsPayload>;
  if (!payload.shopId) throw new MemberActionError('SHOP_ID_MISSING');
  if (!payload.targetPageUrl) throw new MemberActionError('TARGET_PAGE_URL_MISSING');
  if (!payload.clientRequestId) throw new MemberActionError('CLIENT_REQUEST_ID_MISSING');
  return {
    shopId: payload.shopId,
    targetPageUrl: payload.targetPageUrl,
    clientRequestId: payload.clientRequestId
  };
}

function validateSyncPayload(value: unknown, context: MemberPageContext): SyncVipGradesPayload {
  if (!value || typeof value !== 'object') throw new MemberActionError('SERVER_RESPONSE_INVALID');
  const payload = value as Partial<SyncVipGradesPayload>;
  if (!payload.shopId) throw new MemberActionError('SHOP_ID_MISSING');
  if (payload.shopId !== context.shopId) throw new MemberActionError('SHOP_ID_MISMATCH');
  if (!payload.targetPageUrl) throw new MemberActionError('TARGET_PAGE_URL_MISSING');
  if (!payload.clientRequestId) throw new MemberActionError('CLIENT_REQUEST_ID_MISSING');
  return payload as SyncVipGradesPayload;
}

function assertPayloadMatchesState(payload: SaveVipSettingsPayload, state: BrowserMemberServerState): void {
  if (payload.serverIndex !== state.serverIndex) throw new MemberActionError('SERVER_INDEX_MISMATCH');
  if (payload.gradeCount !== state.gradeCount || payload.gradeNames.length !== state.gradeNames.length) {
    throw new MemberActionError('GRADE_CATALOG_MISMATCH');
  }
  if (payload.gradeNames.some((name, index) => name !== state.gradeNames[index])) {
    throw new MemberActionError('GRADE_CATALOG_MISMATCH');
  }
}

function contextFromState(context: MemberPageContext, state: BrowserMemberServerState): MemberPageContext {
  return {
    ...context,
    currentServerIndex: state.serverIndex,
    gradeCount: state.gradeCount,
    gradeNames: [...state.gradeNames]
  };
}

function normalizeRequestedAction(value: unknown): MemberActionType {
  return value === 'reset-vip-settings' ? 'reset-vip-settings' : 'save-vip-settings';
}

function normalizeMutationErrorCode(value: string | undefined) {
  if (value === 'ACTION_TOKEN_EXPIRED') return 'ACTION_TOKEN_EXPIRED' as const;
  if (value === 'ACTION_TOKEN_INVALID') return 'ACTION_TOKEN_INVALID' as const;
  if (value === 'ACTION_TOKEN_ALREADY_USED') return 'ACTION_TOKEN_ALREADY_USED' as const;
  if (value === 'PERMISSION_DENIED') return 'PERMISSION_DENIED' as const;
  return 'NETWORK_ERROR' as const;
}

function shouldRetry(error: MemberActionError, attempt: number): boolean {
  return attempt === 0 && [
    'ACTION_TOKEN_EXPIRED',
    'ACTION_TOKEN_INVALID',
    'ACTION_TOKEN_ALREADY_USED',
    'NETWORK_TIMEOUT'
  ].includes(error.code);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function finiteNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function safeContext(value: MemberPageContext): MemberPageContext | undefined {
  try {
    return validateMemberPageContext(value);
  } catch {
    return undefined;
  }
}
