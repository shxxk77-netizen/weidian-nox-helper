import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthorizedMemberActionAdapter,
  DEFAULT_AUTHORIZED_MEMBER_CONFIG,
  LIVE_PAGE_MEMBER_CONFIG
} from '../extension/src/member/member-action-adapter';
import { memberContext, savePayload } from './memberTestSupport';

test('승인 Mock adapter는 선언된 조회·토큰·쓰기 계약만 사용한다', async () => {
  const calls: Array<{
    pathname: string;
    method: string;
    credentials: string;
    hasToken: boolean;
    bodyKeys: string[];
  }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({
      pathname: url.pathname,
      method: String(init?.method || 'GET'),
      credentials: String(init?.credentials || ''),
      hasToken: typeof body.actionToken === 'string' && Boolean(body.actionToken),
      bodyKeys: Object.keys(body).sort()
    });

    if (url.pathname === '/api/member/context') {
      return jsonResponse({
        ok: true,
        serverIndex: 2,
        gradeCount: 6,
        gradeNames: ['VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5', 'VIP6'],
        name: 'VIP3',
        remaining: 15_000,
        originalProgress: 40
      });
    }
    if (url.pathname === '/api/member/action-token') {
      return jsonResponse({
        ok: true,
        actionToken: 'test-only-raw-token',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 121_000,
        oneTime: true
      });
    }
    if (url.pathname === '/api/member/save') {
      return jsonResponse({ ok: true, serverIndex: 4 });
    }
    return jsonResponse({ ok: false, errorCode: 'NOT_FOUND' }, 404);
  }) as typeof fetch;

  const adapter = new AuthorizedMemberActionAdapter(DEFAULT_AUTHORIZED_MEMBER_CONFIG, fetchImpl);
  const state = await adapter.syncVipGrades(memberContext);
  const acquired = await adapter.acquireActionToken(memberContext, 'save-vip-settings');
  const saved = await adapter.saveVipSettings(
    memberContext,
    acquired.rawToken,
    savePayload({ serverIndex: state.serverIndex, targetIndex: 4 })
  );

  assert.equal(saved.ok, true);
  assert.equal(saved.serverIndex, 4);
  assert.deepEqual(calls, [
    {
      pathname: '/api/member/context',
      method: 'POST',
      credentials: 'include',
      hasToken: false,
      bodyKeys: ['pageUrl', 'sessionFingerprint', 'shopId']
    },
    {
      pathname: '/api/member/action-token',
      method: 'POST',
      credentials: 'include',
      hasToken: false,
      bodyKeys: ['action', 'sessionFingerprint', 'shopId']
    },
    {
      pathname: '/api/member/save',
      method: 'POST',
      credentials: 'include',
      hasToken: true,
      bodyKeys: [
        'actionToken',
        'clientRequestId',
        'gradeCount',
        'gradeNames',
        'serverIndex',
        'shopId',
        'targetIndex'
      ]
    }
  ]);
});

test('실제 Weidian 페이지 읽기는 쓰기 endpoint 미설정과 독립적으로 성공한다', async () => {
  let fetchCalls = 0;
  const adapter = new AuthorizedMemberActionAdapter(
    LIVE_PAGE_MEMBER_CONFIG,
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
  assert.equal(state.serverIndex, 0);
  assert.equal(state.gradeCount, 6);
  assert.deepEqual(state.gradeNames, ['待升级', 'VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5']);
  assert.equal(state.writeAdapter.status, 'write-endpoint-not-configured');
  assert.equal(state.writeAdapter.errorCode, 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED');
});

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
