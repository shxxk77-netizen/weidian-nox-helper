import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActionTokenManager } from '../extension/src/member/action-token-manager';
import { MemberActionError } from '../extension/src/member/member-errors';
import { FakeMemberAdapter, memberContext } from './memberTestSupport';

test('actionToken 원문은 metadata에 노출하지 않고 fingerprint만 제공한다', async () => {
  const adapter = new FakeMemberAdapter();
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  const meta = await manager.acquire(memberContext, 'save-vip-settings');
  assert.equal(meta.status, 'ready');
  assert.match(meta.tokenFingerprint || '', /^[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(meta).includes('raw-secret'), false);
  const raw = await manager.getOrAcquireRawToken(memberContext, 'save-vip-settings');
  assert.match(raw, /^raw-secret-/);
  manager.markConsuming(memberContext, 'save-vip-settings');
  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'consuming');
  manager.markConsumed(memberContext, 'save-vip-settings');
  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'consumed');
});

test('만료와 세션·상점 불일치를 구분한다', async () => {
  const adapter = new FakeMemberAdapter();
  const manager = new InMemoryActionTokenManager(
    (context, action) => adapter.acquireActionToken(context, action),
    () => adapter.now
  );
  await manager.acquire(memberContext, 'save-vip-settings');
  assert.equal(
    manager.getStatus({ ...memberContext, sessionFingerprint: 'session-b' }, 'save-vip-settings').status,
    'session-mismatch'
  );
  assert.equal(
    manager.getStatus({ ...memberContext, shopId: '987654321' }, 'save-vip-settings').status,
    'shop-mismatch'
  );
  adapter.now += 121_000;
  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'expired');
});

test('획득 전 empty와 획득 실패 not-found를 구분하고 상태 전이를 알린다', async () => {
  const transitions: string[] = [];
  const manager = new InMemoryActionTokenManager(
    async () => {
      throw new MemberActionError('ACTION_TOKEN_NOT_FOUND', '페이지에서 actionToken을 찾지 못했습니다.');
    },
    Date.now,
    (_context, meta) => transitions.push(meta.status)
  );

  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'empty');
  await assert.rejects(
    () => manager.acquire(memberContext, 'save-vip-settings'),
    (error: unknown) =>
      error instanceof MemberActionError &&
      error.code === 'ACTION_TOKEN_NOT_FOUND'
  );
  assert.equal(manager.getStatus(memberContext, 'save-vip-settings').status, 'not-found');
  assert.deepEqual(transitions, ['acquiring', 'not-found']);
});

test('토큰 소스 미설정은 source-not-configured로 표시한다', async () => {
  const manager = new InMemoryActionTokenManager(async () => {
    throw new MemberActionError('ACTION_TOKEN_SOURCE_NOT_CONFIGURED');
  });
  await assert.rejects(() => manager.acquire(memberContext, 'save-vip-settings'));
  assert.equal(
    manager.getStatus(memberContext, 'save-vip-settings').status,
    'source-not-configured'
  );
});
