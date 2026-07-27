import type {
  BrowserActionTokenMeta,
  BrowserMemberServerState,
  BrowserMemberWriteAdapterMeta,
  MemberActionType,
  MemberPageContext,
  ResetVipSettingsPayload,
  SaveVipSettingsPayload
} from '../../../src/common/types';

export type {
  BrowserActionTokenMeta,
  BrowserMemberServerState,
  MemberActionType,
  MemberPageContext,
  ResetVipSettingsPayload,
  SaveVipSettingsPayload
};

export interface AcquiredActionToken {
  rawToken: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs?: number;
  oneTime: boolean;
  source:
    | 'page-bootstrap'
    | 'authorized-response'
    | 'action-response'
    | 'manual-refresh'
    | 'network-request'
    | 'network-response';
}

export interface MemberMutationResult {
  ok: boolean;
  serverIndex?: number;
  verified?: boolean;
  errorCode?: string;
  errorMessage?: string;
  nextActionToken?: AcquiredActionToken;
}

export interface ActionTokenSourceConfig {
  mode?: 'endpoint' | 'page-observer';
  requestUrlPattern: string;
  requestMethod: 'GET' | 'POST';
  tokenJsonPath: string;
  expiresAtJsonPath?: string;
  expiresInJsonPath?: string;
  credentials: 'omit' | 'include';
  requestHeaders?: Record<string, string>;
  tokenPlacement:
    | { type: 'header'; key: string }
    | { type: 'body'; key: string }
    | { type: 'query'; key: string };
  actionBinding: 'shared' | 'per-action';
  oneTime: boolean;
}

export interface MemberStateSourceConfig {
  mode: 'page-context' | 'endpoint';
  requestUrlPattern: string;
  requestMethod: 'GET' | 'POST';
  credentials: 'omit' | 'include';
  requestHeaders?: Record<string, string>;
}

export interface MemberWriteEndpointConfig {
  saveUrlPattern: string;
  bulkSaveUrlPattern: string;
  verifyUrlPattern: string;
  requestMethod: 'GET';
  credentials: 'omit' | 'include';
  requestHeaders?: Record<string, string>;
  tokenPlacement: { type: 'query'; key: 'wdtoken' };
  memberBinding: 'buyer-ids';
  buyerIdsField: 'buyerIds';
  memberIdField: 'memberId';
}

export interface AuthorizedMemberAdapterConfig {
  baseUrl: string;
  tokenSource: ActionTokenSourceConfig;
  stateSource: MemberStateSourceConfig;
  writeEndpoint: MemberWriteEndpointConfig;
}

export interface MemberPageRequest {
  context: MemberPageContext;
  url: string;
  method: 'GET';
}

export type MemberPageRequestExecutor = (
  request: MemberPageRequest
) => Promise<Record<string, any>>;

export interface MemberActionAdapter {
  detectContext(input: MemberPageContext): Promise<MemberPageContext>;
  getWriteConfigurationStatus(): BrowserMemberWriteAdapterMeta;
  validateWriteConfiguration?(action: 'save-vip-settings' | 'reset-vip-settings'): void;
  acquireActionToken(context: MemberPageContext, action: MemberActionType): Promise<AcquiredActionToken>;
  syncVipGrades(context: MemberPageContext): Promise<BrowserMemberServerState>;
  saveVipSettings(
    context: MemberPageContext,
    rawActionToken: string,
    payload: SaveVipSettingsPayload
  ): Promise<MemberMutationResult>;
  resetVipSettings(
    context: MemberPageContext,
    rawActionToken: string,
    payload: ResetVipSettingsPayload
  ): Promise<MemberMutationResult>;
}
