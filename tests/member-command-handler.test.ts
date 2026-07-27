import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActionTokenManager } from '../extension/src/member/action-token-manager';
import { MemberCommandHandler } from '../extension/src/member/member-command-handler';
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
