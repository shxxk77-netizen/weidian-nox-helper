import type {
  BrowserMemberServerState,
  MemberActionType,
  MemberPageContext,
  ResetVipSettingsPayload,
  SaveVipSettingsPayload
} from '../src/common/types';
import type {
  AcquiredActionToken,
  MemberActionAdapter,
  MemberMutationResult
} from '../extension/src/member/member-types';

export const memberContext: MemberPageContext = {
  origin: 'https://h5.weidian.com',
  pageUrl: 'https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=123456789',
  shopId: '123456789',
  sessionFingerprint: 'session-a',
  currentServerIndex: 2,
  gradeCount: 6,
  gradeNames: ['VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6']
};

export function savePayload(overrides: Partial<SaveVipSettingsPayload> = {}): SaveVipSettingsPayload {
  return {
    shopId: memberContext.shopId,
    serverIndex: 2,
    targetIndex: 4,
    gradeCount: 6,
    gradeNames: [...memberContext.gradeNames],
    name: 'VIP5',
    remaining: 100,
    originalProgress: 35,
    targetPageUrl: memberContext.pageUrl,
    clientRequestId: `request-${Math.random()}`,
    ...overrides
  };
}

export class FakeMemberAdapter implements MemberActionAdapter {
  serverIndex = 2;
  acquireCalls = 0;
  saveCalls = 0;
  resetCalls = 0;
  saveBehaviors: Array<
    (payload: SaveVipSettingsPayload, adapter: FakeMemberAdapter) => Promise<MemberMutationResult>
  > = [];
  saveDelayMs = 0;
  now = 1_000_000;

  async detectContext(input: MemberPageContext): Promise<MemberPageContext> {
    return { ...input, gradeNames: [...input.gradeNames] };
  }

  getWriteConfigurationStatus() {
    return { status: 'configured' as const };
  }

  async acquireActionToken(
    context: MemberPageContext,
    action: MemberActionType
  ): Promise<AcquiredActionToken> {
    this.acquireCalls += 1;
    return {
      rawToken: `raw-secret-${context.shopId}-${action}-${this.acquireCalls}`,
      issuedAtEpochMs: this.now,
      expiresAtEpochMs: this.now + 120_000,
      oneTime: true,
      source: 'authorized-response'
    };
  }

  async syncVipGrades(context: MemberPageContext): Promise<BrowserMemberServerState> {
    return {
      shopId: context.shopId,
      serverIndex: this.serverIndex,
      gradeCount: 6,
      gradeNames: ['VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6'],
      name: `VIP${this.serverIndex + 1}`,
      remaining: 100,
      originalProgress: 35,
      syncedAtIso: new Date(this.now).toISOString(),
      readSource: 'mock-endpoint',
      actionToken: {
        status: 'empty',
        shopId: context.shopId,
        action: 'save-vip-settings',
        oneTime: true
      },
      writeAdapter: {
        status: 'configured'
      }
    };
  }

  async saveVipSettings(
    _context: MemberPageContext,
    _rawActionToken: string,
    payload: SaveVipSettingsPayload
  ): Promise<MemberMutationResult> {
    this.saveCalls += 1;
    if (this.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, this.saveDelayMs));
    const behavior = this.saveBehaviors.shift();
    if (behavior) return behavior(payload, this);
    this.serverIndex = payload.targetIndex;
    return { ok: true, serverIndex: this.serverIndex };
  }

  async resetVipSettings(
    _context: MemberPageContext,
    _rawActionToken: string,
    _payload: ResetVipSettingsPayload
  ): Promise<MemberMutationResult> {
    this.resetCalls += 1;
    this.serverIndex = 0;
    return { ok: true, serverIndex: 0 };
  }
}
