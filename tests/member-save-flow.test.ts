import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActionTokenManager } from '../extension/src/member/action-token-manager';
import { MemberCommandHandler } from '../extension/src/member/member-command-handler';
import { FakeMemberAdapter, memberContext, savePayload } from './memberTestSupport';

test('저장 후 재조회 serverIndex가 targetIndex와 일치할 때만 성공한다', async () => {
  const adapter = new FakeMemberAdapter();
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  const handler = new MemberCommandHandler(adapter, manager, () => adapter.now);
  const result = await handler.execute({
    id: 'save-1',
    type: 'save-vip-settings',
    payload: savePayload({ targetIndex: 4, clientRequestId: 'save-success' }),
    createdAtIso: ''
  }, memberContext);
  assert.equal(result.ok, true);
  assert.equal(result.memberServerState?.serverIndex, 4);
  assert.equal(result.memberServerState?.actionToken.status, 'consumed');
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
});

test('서버 상태가 바뀌지 않으면 성공으로 표시하지 않는다', async () => {
  const adapter = new FakeMemberAdapter();
  adapter.saveBehaviors.push(async () => ({ ok: true, serverIndex: 2 }));
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  const handler = new MemberCommandHandler(adapter, manager, () => adapter.now);
  const result = await handler.execute({
    id: 'save-2',
    type: 'save-vip-settings',
    payload: savePayload({ clientRequestId: 'state-not-changed' }),
    createdAtIso: ''
  }, memberContext);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SERVER_STATE_NOT_CHANGED');
});
