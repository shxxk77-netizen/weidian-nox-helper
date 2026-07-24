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
  errorCode?: string;
  errorMessage?: string;
  nextActionToken?: AcquiredActionToken;
}

export interface ActionTokenSourceConfig {
  mode?: 'endpoint' | 'page-observer' | 'not-configured';
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
  status?: 'configured' | 'not-configured';
  saveUrlPattern: string;
  resetUrlPattern: string;
  requestMethod: 'POST' | 'PUT' | 'PATCH';
  credentials: 'omit' | 'include';
  contentType: 'application/json';
  requestHeaders?: Record<string, string>;
  tokenPlacement:
    | { type: 'header'; key: string }
    | { type: 'body'; key: string }
    | { type: 'query'; key: string };
  memberBinding: 'current-session-user' | 'explicit-member-id';
  memberIdField?: string;
  shopIdField: string;
  targetIndexField: string;
}

export interface AuthorizedMemberAdapterConfig {
  mode: 'mock-localhost' | 'live-weidian' | 'not-configured';
  baseUrl: string;
  tokenSource: ActionTokenSourceConfig;
  stateSource: MemberStateSourceConfig;
  writeEndpoint: MemberWriteEndpointConfig;
}

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
