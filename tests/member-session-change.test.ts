import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActionTokenManager } from '../extension/src/member/action-token-manager';
import { FakeMemberAdapter, memberContext } from './memberTestSupport';

test('세션 변경과 상점 변경 시 이전 토큰을 폐기한다', async () => {
  const adapter = new FakeMemberAdapter();
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  await manager.acquire(memberContext, 'save-vip-settings');
  manager.clearSession(memberContext.sessionFingerprint);
  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'empty');

  await manager.acquire(memberContext, 'save-vip-settings');
  manager.clearShop(memberContext.shopId);
  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'empty');
});
