import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthorizedMemberActionAdapter,
  DEFAULT_AUTHORIZED_MEMBER_CONFIG,
  MEMBER_ANALYSIS_CONFIG,
  MEMBER_API_BASE_URL,
  MEMBER_API_ENDPOINTS,
  MEMBER_API_HEADERS
} from '../extension/src/member/member-action-adapter';
import {
  createMemberSaveCurl,
  createMemberSaveRequestJson,
  MEMBER_SAVE_CURL_TEMPLATE,
  MEMBER_SAVE_ENDPOINT
} from '../src/common/memberAnalysisContract';
import { memberContext, savePayload } from './memberTestSupport';

test('판매자 Member adapter는 GET + Cookie 세션 + wdtoken query 계약을 사용한다', async () => {
  const calls: URL[] = [];
  const adapter = new AuthorizedMemberActionAdapter(
    MEMBER_ANALYSIS_CONFIG,
    fetch,
    async ({ url }) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname === MEMBER_API_ENDPOINTS.save) {
        return { status: { code: 0, message: 'ok' }, result: 0 };
      }
      return {
        status: { code: 0, message: 'ok' },
        result: {
          member_level: [{ level: 'level-4', name: 'VIP5' }]
        }
      };
    }
  );

  assert.equal(MEMBER_ANALYSIS_CONFIG, DEFAULT_AUTHORIZED_MEMBER_CONFIG);
  assert.equal(MEMBER_API_BASE_URL, 'https://thor.weidian.com');
  assert.deepEqual(MEMBER_API_ENDPOINTS, {
    catalog: '/wdcrm/trade.searchMemberByShopId/1.0',
    save: '/wdcrm/trade.setMemberLevel/2.0',
    bulkSave: '/wdcrm/trade.setMemberLevelWithSearchCondition/2.0',
    verify: '/wdcrm/customer.summary.pc/1.0'
  });
  assert.deepEqual(MEMBER_API_HEADERS, {
    accept: 'application/json, text/plain, */*'
  });
  assert.equal(
    MEMBER_SAVE_ENDPOINT,
    'https://thor.weidian.com/wdcrm/trade.setMemberLevel/2.0'
  );
  assert.match(MEMBER_SAVE_CURL_TEMPLATE, /curl --get/);
  assert.match(MEMBER_SAVE_CURL_TEMPLATE, /wdtoken=<WDTOKEN>/);
  assert.match(MEMBER_SAVE_CURL_TEMPLATE, /param=/);

  const selectedVipPayload = {
    shopId: '123456789',
    buyerIds: ['buyer-a'],
    memberId: 'level-4',
    selectedServerIndex: 4,
    selectedGradeName: 'VIP5'
  };
  const preview = JSON.parse(createMemberSaveRequestJson(selectedVipPayload));
  assert.deepEqual(preview.param, {
    buyerIds: ['buyer-a'],
    memberId: 'level-4'
  });
  assert.equal(preview.wdtoken, '<WDTOKEN>');
  assert.deepEqual(preview._selection, {
    shopId: '123456789',
    serverIndex: 4,
    gradeName: 'VIP5'
  });
  assert.match(createMemberSaveCurl(selectedVipPayload), /buyer-a/);
  assert.match(createMemberSaveCurl(selectedVipPayload), /level-4/);
  assert.match(createMemberSaveCurl(selectedVipPayload), /Origin: https:\/\/h5\.weidian\.com/);
  assert.match(
    createMemberSaveCurl(selectedVipPayload),
    /mkt-h5-member-detail\/index\?shopId=123456789/
  );

  const state = await adapter.syncVipGrades(memberContext);
  const saved = await adapter.saveVipSettings(
    memberContext,
    '{"session":"redacted-test-token"}',
    savePayload({ serverIndex: state.serverIndex, targetIndex: 4, memberId: 'level-4' })
  );

  assert.equal(saved.ok, true);
  assert.equal(saved.serverIndex, 4);
  assert.equal(saved.verified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, MEMBER_API_ENDPOINTS.save);
  assert.equal(calls[0].searchParams.get('wdtoken'), '{"session":"redacted-test-token"}');
  assert.deepEqual(JSON.parse(calls[0].searchParams.get('param') || '{}'), {
    buyerIds: ['buyer-test-1'],
    memberId: 'level-4'
  });
  assert.equal(calls[1].pathname, MEMBER_API_ENDPOINTS.verify);
});

test('Member 읽기는 페이지 컨텍스트를 사용하고 wdtoken은 Chrome 관찰 경로를 사용한다', async () => {
  let fetchCalls = 0;
  const adapter = new AuthorizedMemberActionAdapter(
    MEMBER_ANALYSIS_CONFIG,
    (async () => {
      fetchCalls += 1;
      throw new Error('페이지 컨텍스트 읽기에서는 네트워크 adapter를 호출하면 안 됨');
    }) as typeof fetch
  );

  const state = await adapter.syncVipGrades({
    ...memberContext,
    currentServerIndex: 0,
    gradeCount: 6,
    gradeNames: ['待升级', 'VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5'],
    currentName: '待升级',
    remaining: 3000,
    originalProgress: 0,
    stateSource: 'weidian-network'
  });

  assert.equal(fetchCalls, 0);
  assert.equal(state.readSource, 'weidian-network');
  assert.equal(state.actionToken.oneTime, false);
  assert.equal(state.writeAdapter.status, 'configured');
  await assert.rejects(
    () => adapter.acquireActionToken(memberContext, 'save-vip-settings'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED'
  );
});

test('설정된 Weidian Base URL과 개별 저장 endpoint가 다음 GET 요청에 적용된다', async () => {
  let requestedUrl = '';
  const adapter = new AuthorizedMemberActionAdapter(
    MEMBER_ANALYSIS_CONFIG,
    fetch,
    async ({ url }) => {
      requestedUrl = url;
      return { status: { code: 0 }, result: 0 };
    }
  );

  adapter.configureConnection({
    baseUrl: 'https://thor.weidian.com',
    catalogEndpoint: MEMBER_API_ENDPOINTS.catalog,
    saveEndpoint: MEMBER_API_ENDPOINTS.save,
    bulkSaveEndpoint: MEMBER_API_ENDPOINTS.bulkSave,
    verifyEndpoint: MEMBER_API_ENDPOINTS.verify
  });
  await adapter.saveVipSettings(
    memberContext,
    'test-only-wdtoken',
    savePayload({ targetIndex: 4 })
  );

  assert.match(requestedUrl, /^https:\/\/thor\.weidian\.com\/wdcrm\/customer\.summary\.pc\/1\.0\?/);
});
