export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export interface TimeSyncSnapshot {
  url: string;
  localTimeIso: string;
  serverTimeIso: string;
  syncedAtIso: string;
  roundTripMs: number;
  offsetMs: number;
  sampleCount: number;
  uncertaintyMs: number;
}

export type BrowserPageKind = 'store' | 'product' | 'checkout' | 'payment' | 'member' | 'unknown';

export interface BrowserOptionSnapshot {
  id: string;
  name: string;
  priceText?: string;
  stock?: number;
  selectedQuantity: number;
}

export interface BrowserMemberLevel {
  id: string;
  label: string;
  rank: number;
  minAmount?: number;
  rawText?: string;
}

export type MemberActionType =
  | 'sync-vip-grades'
  | 'save-vip-settings'
  | 'reset-vip-settings';

export type ActionTokenStatus =
  | 'empty'
  | 'acquiring'
  | 'ready'
  | 'consuming'
  | 'consumed'
  | 'expired'
  | 'invalid'
  | 'session-mismatch'
  | 'shop-mismatch'
  | 'permission-denied'
  | 'not-found'
  | 'source-not-configured'
  | 'write-endpoint-not-configured'
  | 'not-configured'
  | 'error';

export type MemberReadSource =
  | 'weidian-network'
  | 'weidian-page'
  | 'mock-endpoint';

export type MemberWriteAdapterStatus =
  | 'configured'
  | 'write-endpoint-not-configured'
  | 'permission-denied'
  | 'error';

export interface BrowserMemberWriteAdapterMeta {
  status: MemberWriteAdapterStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface BrowserActionTokenMeta {
  status: ActionTokenStatus;
  tokenFingerprint?: string;
  shopId?: string;
  action?: MemberActionType;
  issuedAtEpochMs?: number;
  expiresAtEpochMs?: number;
  consumedAtEpochMs?: number;
  oneTime: boolean;
  source?:
    | 'page-bootstrap'
    | 'authorized-response'
    | 'action-response'
    | 'manual-refresh'
    | 'network-request'
    | 'network-response';
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface BrowserMemberServerState {
  shopId: string;
  serverIndex: number;
  gradeCount: number;
  gradeNames: string[];
  name: string;
  remaining: number;
  originalProgress: number;
  syncedAtIso: string;
  readSource: MemberReadSource;
  actionToken: BrowserActionTokenMeta;
  writeAdapter: BrowserMemberWriteAdapterMeta;
}

export interface MemberPageContext {
  origin: string;
  pageUrl: string;
  shopId: string;
  sessionFingerprint: string;
  currentServerIndex: number;
  gradeCount: number;
  gradeNames: string[];
  currentName?: string;
  remaining?: number;
  originalProgress?: number;
  stateSource?: Exclude<MemberReadSource, 'mock-endpoint'>;
}

export interface SyncVipGradesPayload {
  shopId: string;
  targetPageUrl: string;
  clientRequestId: string;
}

export interface SaveVipSettingsPayload {
  shopId: string;
  serverIndex: number;
  targetIndex: number;
  gradeCount: number;
  gradeNames: string[];
  name: string;
  remaining: number;
  originalProgress: number;
  targetPageUrl: string;
  clientRequestId: string;
}

export interface ResetVipSettingsPayload {
  shopId: string;
  targetPageUrl: string;
  clientRequestId: string;
}

export interface BrowserMemberCommandResult {
  commandId: string;
  commandType: BrowserCommandType;
  clientRequestId?: string;
  ok: boolean;
  completedAtIso: string;
  errorCode?: string;
  errorMessage?: string;
  memberServerState?: BrowserMemberServerState;
  actionToken?: BrowserActionTokenMeta;
}

export interface BrowserPageSnapshot {
  pageUrl: string;
  pageTitle: string;
  pageKind: BrowserPageKind;
  observedAtIso: string;
  itemId?: string;
  shopId?: string;
  shopName?: string;
  productTitle?: string;
  priceText?: string;
  stockTotal?: number;
  saleStatus?: 'on_sale' | 'scheduled' | 'sold_out' | 'unknown';
  saleTimeIso?: string;
  imageUrls: string[];
  options: BrowserOptionSnapshot[];
  memberLevels: BrowserMemberLevel[];
  memberServerState?: BrowserMemberServerState;
}

export interface BrowserBridgeState {
  running: boolean;
  port: number;
  connected: boolean;
  extensionPath: string;
  lastSeenAtIso?: string;
  snapshot?: BrowserPageSnapshot;
  lastMemberCommandResult?: BrowserMemberCommandResult;
  lastError?: string;
}

export interface SavedStore {
  id: string;
  name: string;
  url: string;
  memo: string;
  referer?: string;
  pinned: boolean;
  savedAtIso: string;
}

export interface BrowserMemberPreview {
  shopId?: string;
  levelId: string;
  levelLabel: string;
  rank: number;
  name: string;
  nextValue: number;
  serverIndex: number;
  targetIndex: number;
  originalProgress?: number;
}

export type BrowserReservationMode = 'preview' | 'checkout';

export interface BrowserReservationStatus {
  running: boolean;
  phase: 'idle' | 'armed' | 'opening' | 'checkout' | 'completed' | 'stopped' | 'failed';
  targetPageUrl?: string;
  targetServerTime?: string;
  targetServerEpochMs?: number;
  startedAtIso?: string;
  message?: string;
}

export interface BrowserReservationRequest {
  url: string;
  targetServerTime: string;
  optionKeyword: string;
  mode: BrowserReservationMode;
}

export type BrowserCommandType =
  | 'refresh'
  | 'open-options'
  | 'execute-reservation'
  | 'sync-vip-grades'
  | 'refresh-action-token'
  | 'get-action-token-status'
  | 'save-vip-settings'
  | 'reset-vip-settings'
  | 'apply-member-preview'
  | 'restore-member-preview'
  | 'set-watermark'
  | 'save-representative-image'
  | 'save-all-images';

export interface BrowserCommand {
  id: string;
  type: BrowserCommandType;
  payload?: Record<string, unknown>;
  createdAtIso: string;
}

export interface AppSettings {
  timeSyncUrl: string;
  timeSyncSampleCount: number;
  targetServerTime: string;
  browserUrl: string;
  browserExecutable: 'chrome';
  browserCompactWindow: boolean;
  browserBridgePort: number;
  browserWatermarkEnabled: boolean;
  browserWatermarkText: string;
  browserMemberPreviewRank: number;
  browserMemberPreviewLevelId: string;
  browserMemberPreviewName: string;
  browserMemberNextValue: number;
  browserMemberLevelsByShop: Record<string, BrowserMemberLevel[]>;
  browserMemberPreviewByShop: Record<string, BrowserMemberPreview>;
  browserReservationOptionKeyword: string;
  browserReservationMode: BrowserReservationMode;
  savedStores: SavedStore[];
}

export interface AppConfigPayload {
  settings: AppSettings;
  logFilePath: string;
}

export interface RendererApi {
  getConfig: () => Promise<AppConfigPayload>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  syncTime: () => Promise<TimeSyncSnapshot>;
  getTimeSnapshot: () => Promise<TimeSyncSnapshot | undefined>;
  getLogs: () => Promise<LogEntry[]>;
  openLogFile: () => Promise<void>;
  onLog: (callback: (entry: LogEntry) => void) => () => void;
  getBrowserBridgeState: () => Promise<BrowserBridgeState>;
  openInChrome: (url: string) => Promise<void>;
  showExtensionFolder: () => Promise<void>;
  copyText: (text: string) => Promise<void>;
  saveCurrentStore: (store: Omit<SavedStore, 'savedAtIso'>) => Promise<AppSettings>;
  deleteSavedStore: (id: string) => Promise<AppSettings>;
  queueBrowserCommand: (type: BrowserCommandType, payload?: Record<string, unknown>) => Promise<BrowserCommand>;
  startBrowserReservation: (request: BrowserReservationRequest) => Promise<BrowserReservationStatus>;
  stopBrowserReservation: () => Promise<BrowserReservationStatus>;
  getBrowserReservationStatus: () => Promise<BrowserReservationStatus>;
  onBrowserBridgeState: (callback: (state: BrowserBridgeState) => void) => () => void;
  onBrowserReservation: (callback: (status: BrowserReservationStatus) => void) => () => void;
}
