import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  BrowserBridgeState,
  BrowserCommand,
  BrowserCommandType,
  BrowserMemberApiContractObservation,
  BrowserMemberLevel,
  BrowserMemberCommandResult,
  BrowserMemberServerState,
  BrowserMemberPreview,
  BrowserPageSnapshot,
  BrowserReservationStatus
} from '../common/types';
import type { MemberApiConnectionSettings } from '../common/memberAnalysisContract';
import { normalizeMemberApiContractObservation } from '../common/memberApiContract';
import type { AppLogger } from './logger';

export interface BrowserBridgePublicContext {
  serverOffsetMs: number;
  watermark: {
    enabled: boolean;
    text: string;
  };
  memberPreview: BrowserMemberPreview;
  memberLevels: BrowserMemberLevel[];
  reservation: BrowserReservationStatus;
  reservationOptionKeyword: string;
  reservationMode: 'preview' | 'checkout';
  memberApi: MemberApiConnectionSettings;
}

export interface BrowserBridgeHooks {
  extensionPath: string;
  getContext: () => BrowserBridgePublicContext;
  saveMemberPreview?: (preview: BrowserMemberPreview) => void;
  saveDetectedMemberLevels?: (shopId: string, levels: BrowserMemberLevel[]) => void;
  onState?: (state: BrowserBridgeState) => void;
}

export class BrowserBridgeService {
  private server?: http.Server;
  private snapshot?: BrowserPageSnapshot;
  private lastSeenAtMs?: number;
  private lastError?: string;
  private commands: BrowserCommand[] = [];
  private lastMemberCommandResult?: BrowserMemberCommandResult;
  private memberApiContracts: BrowserMemberApiContractObservation[] = [];
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly port: number,
    private readonly logger: AppLogger,
    private readonly hooks: BrowserBridgeHooks
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, '127.0.0.1');
    });

    this.heartbeat = setInterval(() => this.emitState(), 1_000);
    this.heartbeat.unref();
    this.logger.info(`Chrome 브리지 시작: 127.0.0.1:${this.port}`, 'browser');
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  getState(): BrowserBridgeState {
    const connected = this.lastSeenAtMs !== undefined && Date.now() - this.lastSeenAtMs < 90_000;
    return {
      running: Boolean(this.server?.listening),
      port: this.port,
      connected,
      extensionPath: this.hooks.extensionPath,
      lastSeenAtIso: this.lastSeenAtMs ? new Date(this.lastSeenAtMs).toISOString() : undefined,
      snapshot: this.snapshot,
      lastMemberCommandResult: this.lastMemberCommandResult,
      memberApiContracts: this.memberApiContracts.map((contract) => ({ ...contract })),
      lastError: this.lastError
    };
  }

  queueCommand(type: BrowserCommandType, payload?: Record<string, unknown>): BrowserCommand {
    if (!ALLOWED_COMMAND_TYPES.has(type)) {
      throw new Error(`지원하지 않는 Chrome 명령입니다: ${String(type)}`);
    }
    assertNoSensitiveMemberValues(payload);
    const command: BrowserCommand = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type,
      payload,
      createdAtIso: new Date().toISOString()
    };
    this.commands.push(command);
    this.commands = this.commands.slice(-50);
    this.logger.info(`Chrome 명령 대기: ${type}`, 'browser', payload);
    return command;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (!isAllowedExtensionOrigin(origin)) {
      this.sendJson(response, 403, { ok: false, error: 'Chrome 확장 프로그램 요청만 허용됩니다.' });
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', origin!);
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      if (request.method === 'GET' && request.url === '/api/state') {
        this.markSeen();
        this.sendJson(response, 200, {
          ok: true,
          serverNowIso: new Date().toISOString(),
          context: this.hooks.getContext(),
          commands: this.commands
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/observation') {
        const body = await readJsonBody(request);
        this.snapshot = normalizeBrowserObservation(body);
        if (this.snapshot.shopId && this.snapshot.memberLevels.length > 0) {
          this.hooks.saveDetectedMemberLevels?.(this.snapshot.shopId, this.snapshot.memberLevels);
        }
        this.markSeen();
        this.lastError = undefined;
        this.logger.debug(`Chrome 페이지 관찰: ${this.snapshot.pageKind}`, 'browser', {
          url: this.snapshot.pageUrl,
          itemId: this.snapshot.itemId,
          stockTotal: this.snapshot.stockTotal
        });
        this.sendJson(response, 200, {
          ok: true,
          state: {
            ok: true,
            serverNowIso: new Date().toISOString(),
            context: this.hooks.getContext(),
            commands: this.commands
          }
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/ack') {
        const body = (await readJsonBody(request)) as { ids?: unknown };
        const ids = new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []);
        this.commands = this.commands.filter((command) => !ids.has(command.id));
        this.markSeen();
        this.sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/member-preview') {
        const preview = normalizeMemberPreview(await readJsonBody(request));
        this.hooks.saveMemberPreview?.(preview);
        this.markSeen();
        this.logger.info(`회원등급 로컬 미리보기 저장: ${preview.levelLabel}`, 'browser', preview);
        this.sendJson(response, 200, { ok: true, context: this.hooks.getContext() });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/member-token-state') {
        const body = await readJsonBody(request) as Record<string, unknown>;
        const shopId = requiredString(body.shopId, 'shopId');
        const actionToken = normalizeActionTokenMeta(body.actionToken, shopId);
        const previousStatus =
          this.snapshot?.memberServerState?.shopId === shopId
            ? this.snapshot.memberServerState.actionToken.status
            : 'empty';
        if (this.snapshot?.memberServerState?.shopId === shopId) {
          this.snapshot = {
            ...this.snapshot,
            memberServerState: {
              ...this.snapshot.memberServerState,
              actionToken
            }
          };
        }
        this.markSeen();
        this.logger.info(
          `actionToken 상태 전이: ${previousStatus} -> ${actionToken.status}`,
          'member-token',
          {
            shopId,
            status: actionToken.status,
            fingerprint: actionToken.tokenFingerprint,
            source: actionToken.source,
            errorCode: actionToken.lastErrorCode
          }
        );
        this.sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/member-api-contract') {
        const observation = normalizeMemberApiContractObservation(await readJsonBody(request));
        const existingIndex = this.memberApiContracts.findIndex((item) => item.id === observation.id);
        if (existingIndex >= 0) {
          const existing = this.memberApiContracts[existingIndex];
          this.memberApiContracts[existingIndex] = {
            ...existing,
            ...observation,
            observedAtIso: existing.observedAtIso,
            lastObservedAtIso: observation.lastObservedAtIso,
            sampleCount: existing.sampleCount + 1
          };
        } else {
          this.memberApiContracts.push(observation);
        }
        this.memberApiContracts = this.memberApiContracts
          .sort((left, right) => right.lastObservedAtIso.localeCompare(left.lastObservedAtIso))
          .slice(0, 150);
        this.markSeen();
        this.logger.info(
          `Member API 관찰: ${observation.method} ${observation.url}`,
          'member-contract',
          {
            id: observation.id,
            source: observation.source,
            shopId: observation.shopId,
            page: observation.page,
            method: observation.method,
            url: observation.url,
            queryKeys: observation.queryKeys,
            queryShape: observation.queryShape,
            requestHeaderNames: observation.requestHeaderNames,
            requestHeaderMetadata: observation.requestHeaderMetadata,
            requestBodyShape: observation.requestBodyShape,
            tokenPlacement: observation.tokenPlacement,
            chromeSessionCookie: observation.chromeSessionCookie,
            status: observation.status,
            responseHeaderNames: observation.responseHeaderNames,
            responseContentType: observation.responseContentType,
            responseBodyShape: observation.responseBodyShape
          }
        );
        this.sendJson(response, 200, {
          ok: true,
          id: observation.id,
          count: this.memberApiContracts.length
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/command-result') {
        this.lastMemberCommandResult = normalizeMemberCommandResult(await readJsonBody(request));
        if (this.lastMemberCommandResult.memberServerState && this.snapshot) {
          this.snapshot = {
            ...this.snapshot,
            memberServerState: this.lastMemberCommandResult.memberServerState
          };
        }
        this.markSeen();
        this.lastError = this.lastMemberCommandResult.ok
          ? undefined
          : this.lastMemberCommandResult.errorMessage;
        this.logger.info(
          `Member 명령 ${this.lastMemberCommandResult.ok ? '완료' : '실패'}: ${this.lastMemberCommandResult.commandType}`,
          'member',
          this.lastMemberCommandResult
        );
        this.sendJson(response, 200, { ok: true });
        return;
      }

      this.sendJson(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Chrome 브리지 요청 실패: ${this.lastError}`, 'browser');
      this.sendJson(response, 400, { ok: false, error: this.lastError });
      this.emitState();
    }
  }

  private markSeen(): void {
    this.lastSeenAtMs = Date.now();
    this.emitState();
  }

  private emitState(): void {
    this.hooks.onState?.(this.getState());
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
  }
}

export function isAllowedExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-z]{32}$/i.test(origin);
}

export function normalizeBrowserObservation(value: unknown): BrowserPageSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('페이지 관찰 데이터 형식이 올바르지 않습니다.');
  }
  const input = value as Record<string, unknown>;
  const pageUrl = requiredString(input.pageUrl, '페이지 URL');
  const parsedUrl = new URL(pageUrl);
  if (parsedUrl.protocol !== 'https:' || !/(^|\.)weidian\.com$/i.test(parsedUrl.hostname)) {
    throw new Error('Weidian HTTPS 페이지 관찰만 허용됩니다.');
  }

  const pageKinds = new Set(['store', 'product', 'checkout', 'payment', 'member', 'unknown']);
  const pageKind = typeof input.pageKind === 'string' && pageKinds.has(input.pageKind) ? input.pageKind : 'unknown';
  const imageUrls = Array.isArray(input.imageUrls)
    ? input.imageUrls.filter((url): url is string => typeof url === 'string' && /^https:\/\//i.test(url)).slice(0, 200)
    : [];
  const options = Array.isArray(input.options)
    ? input.options.slice(0, 200).flatMap((option, index) => {
        if (!option || typeof option !== 'object') {
          return [];
        }
        const item = option as Record<string, unknown>;
        const name = optionalString(item.name);
        if (!name) {
          return [];
        }
        const stockValue = Number(item.stock);
        return [
          {
            id: optionalString(item.id) || `option-${index}`,
            name,
            priceText: optionalString(item.priceText),
            stock: Number.isFinite(stockValue) ? Math.max(0, Math.round(stockValue)) : undefined,
            selectedQuantity: Math.max(0, Math.round(Number(item.selectedQuantity) || 0))
          }
        ];
      })
    : [];
  const stockTotalValue = Number(input.stockTotal);

  return {
    pageUrl,
    pageTitle: optionalString(input.pageTitle) || '',
    pageKind: pageKind as BrowserPageSnapshot['pageKind'],
    observedAtIso: optionalString(input.observedAtIso) || new Date().toISOString(),
    itemId: optionalString(input.itemId),
    shopId: optionalString(input.shopId),
    buyerIds: Array.isArray(input.buyerIds)
      ? [...new Set(
          input.buyerIds
            .map((value) => String(value || '').trim())
            .filter((value) => /^[A-Za-z0-9_-]{1,100}$/.test(value))
        )].slice(0, 200)
      : [],
    shopName: optionalString(input.shopName),
    productTitle: optionalString(input.productTitle),
    priceText: optionalString(input.priceText),
    stockTotal: Number.isFinite(stockTotalValue) ? Math.max(0, Math.round(stockTotalValue)) : undefined,
    saleStatus: normalizeSaleStatus(input.saleStatus),
    saleTimeIso: optionalString(input.saleTimeIso),
    imageUrls,
    options,
    memberLevels: normalizeMemberLevels(input.memberLevels),
    memberServerState: normalizeMemberServerState(input.memberServerState)
  };
}

const ALLOWED_COMMAND_TYPES = new Set<BrowserCommandType>([
  'refresh',
  'open-options',
  'execute-reservation',
  'sync-vip-grades',
  'refresh-action-token',
  'get-action-token-status',
  'save-vip-settings',
  'reset-vip-settings',
  'apply-member-preview',
  'restore-member-preview',
  'set-watermark',
  'save-representative-image',
  'save-all-images'
]);

const SENSITIVE_MEMBER_KEYS = /^(?:actionToken|wdtoken|token|ct|cookie|authorization|qrCodeStatusKey|session|sessionId|accessToken|refreshToken)$/i;

function assertNoSensitiveMemberValues(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 8) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_MEMBER_KEYS.test(key)) {
      throw new Error(`민감정보 ${key}은(는) Electron 명령 payload에 포함할 수 없습니다.`);
    }
    assertNoSensitiveMemberValues(child, depth + 1);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) {
      throw new Error('요청 데이터가 너무 큽니다.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`${label}이(가) 없습니다.`);
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4_000) : undefined;
}

function normalizeSaleStatus(value: unknown): BrowserPageSnapshot['saleStatus'] {
  return value === 'on_sale' || value === 'scheduled' || value === 'sold_out' ? value : 'unknown';
}

function normalizeMemberLevels(value: unknown): BrowserMemberLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value.slice(0, 60).flatMap((level, index) => {
    if (!level || typeof level !== 'object') return [];
    const item = level as Record<string, unknown>;
    const label = optionalString(item.label);
    if (!label) return [];
    const key = label.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const rankValue = Number(item.rank);
    const rank = Number.isFinite(rankValue) ? Math.max(1, Math.round(rankValue)) : index + 1;
    const minAmount = Number(item.minAmount);
    return [{
      id: optionalString(item.id) || `level-${rank}`,
      label: label.slice(0, 80),
      rank,
      minAmount: Number.isFinite(minAmount) ? Math.max(0, minAmount) : undefined,
      rawText: optionalString(item.rawText)?.slice(0, 160)
    }];
  }).slice(0, 30);
}

function normalizeMemberServerState(value: unknown): BrowserMemberServerState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const shopId = optionalString(input.shopId);
  const gradeNames = Array.isArray(input.gradeNames)
    ? input.gradeNames
        .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
        .map((name) => name.trim().slice(0, 80))
        .slice(0, 30)
    : [];
  const gradeCount = Number(input.gradeCount);
  const serverIndex = Number(input.serverIndex);
  if (
    !shopId ||
    !Number.isInteger(gradeCount) ||
    gradeCount < 1 ||
    gradeNames.length !== gradeCount ||
    !Number.isInteger(serverIndex) ||
    serverIndex < 0 ||
    serverIndex >= gradeCount
  ) {
    return undefined;
  }
  return {
    shopId,
    serverIndex,
    gradeCount,
    gradeNames,
    name: optionalString(input.name)?.slice(0, 80) || gradeNames[serverIndex],
    remaining: finiteNonNegative(input.remaining),
    originalProgress: finiteNonNegative(input.originalProgress),
    syncedAtIso: normalizeIso(input.syncedAtIso),
    readSource: normalizeMemberReadSource(input.readSource),
    actionToken: normalizeActionTokenMeta(input.actionToken, shopId),
    writeAdapter: normalizeWriteAdapterMeta(input.writeAdapter)
  };
}

function normalizeActionTokenMeta(value: unknown, shopId: string) {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const statuses = new Set([
    'empty',
    'acquiring',
    'ready',
    'consuming',
    'consumed',
    'expired',
    'invalid',
    'session-mismatch',
    'shop-mismatch',
    'permission-denied',
    'not-found',
    'source-not-configured',
    'write-endpoint-not-configured',
    'not-configured',
    'error'
  ]);
  const actions = new Set(['sync-vip-grades', 'save-vip-settings', 'reset-vip-settings']);
  const sources = new Set([
    'page-bootstrap',
    'authorized-response',
    'action-response',
    'manual-refresh',
    'network-request',
    'network-response'
  ]);
  const status = typeof input.status === 'string' && statuses.has(input.status) ? input.status : 'empty';
  const action = typeof input.action === 'string' && actions.has(input.action) ? input.action : undefined;
  const source = typeof input.source === 'string' && sources.has(input.source) ? input.source : undefined;
  return {
    status: status as BrowserMemberServerState['actionToken']['status'],
    tokenFingerprint: optionalString(input.tokenFingerprint)?.slice(0, 24),
    shopId: optionalString(input.shopId) || shopId,
    action: action as BrowserMemberServerState['actionToken']['action'],
    issuedAtEpochMs: finiteEpoch(input.issuedAtEpochMs),
    expiresAtEpochMs: finiteEpoch(input.expiresAtEpochMs),
    consumedAtEpochMs: finiteEpoch(input.consumedAtEpochMs),
    oneTime: Boolean(input.oneTime),
    source: source as BrowserMemberServerState['actionToken']['source'],
    lastErrorCode: optionalString(input.lastErrorCode)?.slice(0, 100),
    lastErrorMessage: optionalString(input.lastErrorMessage)?.slice(0, 400)
  };
}

function normalizeMemberReadSource(value: unknown): BrowserMemberServerState['readSource'] {
  return value === 'weidian-network' || value === 'mock-endpoint'
    ? value
    : 'weidian-page';
}

function normalizeWriteAdapterMeta(value: unknown): BrowserMemberServerState['writeAdapter'] {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const statuses = new Set([
    'configured',
    'write-endpoint-not-configured',
    'permission-denied',
    'error'
  ]);
  const status =
    typeof input.status === 'string' && statuses.has(input.status)
      ? input.status
      : 'write-endpoint-not-configured';
  return {
    status: status as BrowserMemberServerState['writeAdapter']['status'],
    errorCode:
      optionalString(input.errorCode)?.slice(0, 100) ||
      (status === 'write-endpoint-not-configured'
        ? 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
        : undefined),
    errorMessage: optionalString(input.errorMessage)?.slice(0, 400)
  };
}

function normalizeMemberCommandResult(value: unknown): BrowserMemberCommandResult {
  if (!value || typeof value !== 'object') {
    throw new Error('Member 명령 결과 형식이 올바르지 않습니다.');
  }
  const input = value as Record<string, unknown>;
  const commandId = requiredString(input.commandId, 'commandId').slice(0, 200);
  const commandType = optionalString(input.commandType) as BrowserCommandType | undefined;
  if (!commandType || !ALLOWED_COMMAND_TYPES.has(commandType)) {
    throw new Error('Member 명령 결과의 commandType이 올바르지 않습니다.');
  }
  return {
    commandId,
    commandType,
    clientRequestId: optionalString(input.clientRequestId)?.slice(0, 200),
    ok: input.ok === true,
    completedAtIso: normalizeIso(input.completedAtIso),
    errorCode: optionalString(input.errorCode)?.slice(0, 100),
    errorMessage: optionalString(input.errorMessage)?.slice(0, 400),
    memberServerState: normalizeMemberServerState(input.memberServerState),
    actionToken: input.actionToken && typeof input.actionToken === 'object'
      ? normalizeActionTokenMeta(input.actionToken, optionalString((input.actionToken as Record<string, unknown>).shopId) || '')
      : undefined
  };
}

function normalizeMemberPreview(value: unknown): BrowserMemberPreview {
  if (!value || typeof value !== 'object') {
    throw new Error('회원등급 설정 데이터 형식이 올바르지 않습니다.');
  }
  const input = value as Record<string, unknown>;
  const rawRank = Number(input.rank);
  const rank = Number.isFinite(rawRank) ? Math.round(Math.min(99, Math.max(1, rawRank))) : 1;
  const levelLabel = optionalString(input.levelLabel) || optionalString(input.label) || `VIP${rank}`;
  const name = optionalString(input.name) || levelLabel;
  const nextValue = Math.max(0, Number(input.nextValue) || 0);
  return {
    shopId: optionalString(input.shopId),
    levelId: optionalString(input.levelId) || `level-${rank}`,
    levelLabel: levelLabel.slice(0, 80),
    rank,
    name: name.slice(0, 80),
    nextValue,
    serverIndex: nonNegativeInteger(input.serverIndex, rank - 1),
    targetIndex: nonNegativeInteger(input.targetIndex, rank - 1),
    originalProgress: Number.isFinite(Number(input.originalProgress))
      ? Math.max(0, Number(input.originalProgress))
      : undefined
  };
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function finiteEpoch(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : Math.max(0, Math.round(fallback));
}

function normalizeIso(value: unknown): string {
  const text = optionalString(value);
  return text && Number.isFinite(new Date(text).getTime()) ? text : new Date().toISOString();
}
