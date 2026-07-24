import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActionTokenManager } from '../extension/src/member/action-token-manager';
import { MemberCommandHandler } from '../extension/src/member/member-command-handler';
import {
  AuthorizedMemberActionAdapter,
  DEFAULT_AUTHORIZED_MEMBER_CONFIG,
  UNCONFIGURED_MEMBER_CONFIG
} from '../extension/src/member/member-action-adapter';
import { FakeMemberAdapter, memberContext, savePayload } from './memberTestSupport';

function createHandler(adapter: FakeMemberAdapter): MemberCommandHandler {
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  return new MemberCommandHandler(adapter, manager, () => adapter.now);
}

test('중복 clientRequestId를 차단한다', async () => {
  const adapter = new FakeMemberAdapter();
  const handler = createHandler(adapter);
  const payload = {
    shopId: memberContext.shopId,
    targetPageUrl: memberContext.pageUrl,
    clientRequestId: 'duplicate-id'
  };
  const first = await handler.execute({ id: '1', type: 'sync-vip-grades', payload, createdAtIso: '' }, memberContext);
  const second = await handler.execute({ id: '2', type: 'sync-vip-grades', payload, createdAtIso: '' }, memberContext);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.errorCode, 'DUPLICATE_CLIENT_REQUEST');
});

test('clientRequestId가 없는 Member 명령을 실행하지 않는다', async () => {
  const adapter = new FakeMemberAdapter();
  const handler = createHandler(adapter);
  const result = await handler.execute(
    {
      id: 'missing-request-id',
      type: 'sync-vip-grades',
      payload: {
        shopId: memberContext.shopId,
        targetPageUrl: memberContext.pageUrl
      },
      createdAtIso: ''
    },
    memberContext
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CLIENT_REQUEST_ID_MISSING');
});

test('승인 token source 미설정 상태에서는 네트워크 요청 없이 명시적 오류를 반환한다', async () => {
  let fetchCalls = 0;
  const adapter = new AuthorizedMemberActionAdapter(
    UNCONFIGURED_MEMBER_CONFIG,
    (async () => {
      fetchCalls += 1;
      throw new Error('호출되면 안 됨');
    }) as typeof fetch
  );
  await assert.rejects(
    () => adapter.acquireActionToken(memberContext, 'save-vip-settings'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED'
  );
  assert.equal(fetchCalls, 0);
});

test('Member 쓰기 endpoint 미설정 상태에서는 토큰 발급과 네트워크 요청 전에 차단한다', async () => {
  let fetchCalls = 0;
  const adapter = new AuthorizedMemberActionAdapter(
    {
      ...DEFAULT_AUTHORIZED_MEMBER_CONFIG,
      writeEndpoint: {
        ...DEFAULT_AUTHORIZED_MEMBER_CONFIG.writeEndpoint,
        saveUrlPattern: '__CONFIGURE_MEMBER_WRITE_ENDPOINT__',
        resetUrlPattern: '__CONFIGURE_MEMBER_RESET_ENDPOINT__'
      }
    },
    (async () => {
      fetchCalls += 1;
      throw new Error('호출되면 안 됨');
    }) as typeof fetch
  );
  const manager = new InMemoryActionTokenManager((context, action) =>
    adapter.acquireActionToken(context, action)
  );
  const handler = new MemberCommandHandler(adapter, manager);
  const result = await handler.execute(
    {
      id: 'write-not-configured',
      type: 'save-vip-settings',
      payload: savePayload({ clientRequestId: 'write-not-configured-request' }),
      createdAtIso: ''
    },
    memberContext
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED');
  assert.equal(fetchCalls, 0);
  assert.throws(
    () => adapter.validateWriteConfiguration('reset-vip-settings'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
  );
});

test('Member 재조회 endpoint 미설정 상태에서는 요청을 전송하지 않는다', async () => {
  let fetchCalls = 0;
  const adapter = new AuthorizedMemberActionAdapter(
    {
      ...DEFAULT_AUTHORIZED_MEMBER_CONFIG,
      stateSource: {
        ...DEFAULT_AUTHORIZED_MEMBER_CONFIG.stateSource,
        requestUrlPattern: '__CONFIGURE_MEMBER_STATE_ENDPOINT__'
      }
    },
    (async () => {
      fetchCalls += 1;
      throw new Error('호출되면 안 됨');
    }) as typeof fetch
  );
  await assert.rejects(
    () => adapter.syncVipGrades(memberContext),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'MEMBER_STATE_ENDPOINT_NOT_CONFIGURED'
  );
  assert.equal(fetchCalls, 0);
});

test('동일 상점 저장 더블클릭은 한 요청만 실행한다', async () => {
  const adapter = new FakeMemberAdapter();
  adapter.saveDelayMs = 30;
  const handler = createHandler(adapter);
  const first = handler.execute(
    { id: '1', type: 'save-vip-settings', payload: savePayload({ clientRequestId: 'double-1' }), createdAtIso: '' },
    memberContext
  );
  const second = handler.execute(
    { id: '2', type: 'save-vip-settings', payload: savePayload({ clientRequestId: 'double-2' }), createdAtIso: '' },
    memberContext
  );
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok)?.errorCode, 'MEMBER_ACTION_ALREADY_RUNNING');
  assert.equal(adapter.saveCalls, 1);
});
