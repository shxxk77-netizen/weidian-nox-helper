import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActionTokenManager } from '../extension/src/member/action-token-manager';
import { MemberCommandHandler } from '../extension/src/member/member-command-handler';
import { MemberActionError } from '../extension/src/member/member-errors';
import { FakeMemberAdapter, memberContext, savePayload } from './memberTestSupport';

function setup(adapter: FakeMemberAdapter) {
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  return new MemberCommandHandler(adapter, manager, () => adapter.now);
}

test('Timeout 후 상태 미반영이면 새 토큰으로 한 번만 재시도한다', async () => {
  const adapter = new FakeMemberAdapter();
  adapter.saveBehaviors.push(async () => {
    throw new MemberActionError('NETWORK_TIMEOUT', 'timeout', true);
  });
  const handler = setup(adapter);
  const result = await handler.execute({
    id: 'timeout-1',
    type: 'save-vip-settings',
    payload: savePayload({ clientRequestId: 'timeout-retry' }),
    createdAtIso: ''
  }, memberContext);
  assert.equal(result.ok, true);
  assert.equal(adapter.saveCalls, 2);
  assert.equal(adapter.acquireCalls, 2);
});

test('Timeout이더라도 재조회 상태가 반영됐으면 재전송하지 않는다', async () => {
  const adapter = new FakeMemberAdapter();
  adapter.saveBehaviors.push(async (payload, current) => {
    current.serverIndex = payload.targetIndex;
    throw new MemberActionError('NETWORK_TIMEOUT', 'timeout after commit', true);
  });
  const handler = setup(adapter);
  const result = await handler.execute({
    id: 'timeout-2',
    type: 'save-vip-settings',
    payload: savePayload({ clientRequestId: 'timeout-committed' }),
    createdAtIso: ''
  }, memberContext);
  assert.equal(result.ok, true);
  assert.equal(adapter.saveCalls, 1);
  assert.equal(adapter.acquireCalls, 1);
});
