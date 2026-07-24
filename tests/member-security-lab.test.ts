import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
// The lab server is intentionally plain ESM so it can also run without a TypeScript loader.
// @ts-expect-error JavaScript lab module is bundled by scripts/build-tests.mjs.
import {
  MEMBER_LAB_MODES,
  MEMBER_LAB_PRIMARY_SHOP_ID,
  createMemberSecurityLabServer
} from '../scripts/member-security-lab-core.mjs';

type LabMode = 'vulnerable' | 'fixed';

interface LabClient {
  baseUrl: string;
  close(): Promise<void>;
  login(username: string, password: string): Promise<{ cookie: string; body: any }>;
  request(pathname: string, options?: {
    cookie?: string;
    body?: Record<string, unknown>;
    method?: 'GET' | 'POST';
  }): Promise<{ status: number; body: any; cookie?: string }>;
}

test('세션 쿠키 없거나 위조된 요청은 Member 읽기 전 차단된다', async (t) => {
  const lab = await startLab(MEMBER_LAB_MODES.FIXED);
  t.after(() => lab.close());

  const missing = await lab.request('/api/member/context', {
    body: { shopId: MEMBER_LAB_PRIMARY_SHOP_ID }
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.errorCode, 'SESSION_COOKIE_MISSING');

  const forged = await lab.request('/api/member/context', {
    cookie: 'weidian_member_lab_session=forged',
    body: { shopId: MEMBER_LAB_PRIMARY_SHOP_ID }
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.errorCode, 'SESSION_INVALID');
});

test('취약 모드는 일반 회원의 serverIndex 및 진행도 변조를 재현하고 저장 후 재조회한다', async (t) => {
  const lab = await startLab(MEMBER_LAB_MODES.VULNERABLE);
  t.after(() => lab.close());
  const { cookie, body: login } = await lab.login('member', 'member-test');
  assert.equal(login.session.role, 'member');

  const before = await readContext(lab, cookie);
  assert.equal(before.serverIndex, 1);
  assert.equal(before.targetIndex, 3);
  assert.equal(before.remaining, 4_000);
  assert.equal(before.originalProgress, 20);

  const token = await acquireToken(lab, cookie, 'save-vip-settings');
  const saved = await lab.request('/api/member/save', {
    cookie,
    body: {
      shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
      actionToken: token,
      serverIndex: before.serverIndex,
      targetIndex: 5,
      remaining: 0,
      originalProgress: 100,
      role: 'platform-admin'
    }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.policy, 'session-and-action-token-only');
  assert.equal(saved.body.serverIndex, 5);

  const after = await readContext(lab, cookie);
  assert.equal(after.serverIndex, 5);
  assert.equal(after.name, 'VIP5');
  assert.equal(after.remaining, 0);
  assert.equal(after.originalProgress, 100);

  const replay = await lab.request('/api/member/save', {
    cookie,
    body: {
      shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
      actionToken: token,
      serverIndex: 5,
      targetIndex: 4
    }
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.errorCode, 'ACTION_TOKEN_ALREADY_USED');

  const audit = await lab.request('/api/lab/audit', { method: 'GET', cookie });
  assert.equal(audit.status, 200);
  assert.equal(JSON.stringify(audit.body).includes(token), false);
  assert.ok(
    audit.body.entries.some((entry: any) =>
      entry.event === 'member-write-allowed' &&
      entry.policy === 'session-and-action-token-only'
    )
  );
});

test('actionToken은 만료되고 재발급되며 중복 요청 중 하나만 성공한다', async (t) => {
  let now = 1_000;
  const expiringLab = await startLab(MEMBER_LAB_MODES.VULNERABLE, {
    clock: () => now,
    tokenTtlMs: 100
  });
  t.after(() => expiringLab.close());
  const { cookie } = await expiringLab.login('member', 'member-test');

  const expiredToken = await acquireToken(expiringLab, cookie, 'save-vip-settings');
  now = 1_101;
  const expired = await expiringLab.request('/api/member/save', {
    cookie,
    body: {
      shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
      actionToken: expiredToken,
      targetIndex: 2
    }
  });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.errorCode, 'ACTION_TOKEN_EXPIRED');

  const reissuedToken = await acquireToken(expiringLab, cookie, 'save-vip-settings');
  assert.notEqual(reissuedToken, expiredToken);
  const duplicateBody = {
    shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
    actionToken: reissuedToken,
    targetIndex: 2
  };
  const results = await Promise.all([
    expiringLab.request('/api/member/save', { cookie, body: duplicateBody }),
    expiringLab.request('/api/member/save', { cookie, body: duplicateBody })
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.deepEqual(
    results.map((result) => result.body.errorCode || 'OK').sort(),
    ['ACTION_TOKEN_ALREADY_USED', 'OK']
  );
});

test('세션 만료와 actionToken의 세션·상점·명령 귀속을 구분한다', async (t) => {
  let now = 5_000;
  const lab = await startLab(MEMBER_LAB_MODES.VULNERABLE, {
    clock: () => now,
    sessionTtlMs: 100,
    tokenTtlMs: 1_000
  });
  t.after(() => lab.close());
  const member = await lab.login('member', 'member-test');
  const admin = await lab.login('shop-admin-a', 'shop-admin-a-test');
  const token = await acquireToken(lab, member.cookie, 'save-vip-settings');

  const otherSession = await lab.request('/api/member/save', {
    cookie: admin.cookie,
    body: {
      shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
      actionToken: token,
      targetIndex: 2
    }
  });
  assert.equal(otherSession.status, 403);
  assert.equal(otherSession.body.errorCode, 'ACTION_TOKEN_CONTEXT_MISMATCH');

  const otherShop = await lab.request('/api/member/save', {
    cookie: member.cookie,
    body: {
      shopId: '2098765432',
      actionToken: token,
      targetIndex: 2
    }
  });
  assert.equal(otherShop.status, 403);
  assert.equal(otherShop.body.errorCode, 'ACTION_TOKEN_CONTEXT_MISMATCH');

  now = 5_101;
  const expiredSession = await lab.request('/api/member/context', {
    cookie: member.cookie,
    body: { shopId: MEMBER_LAB_PRIMARY_SHOP_ID }
  });
  assert.equal(expiredSession.status, 401);
  assert.equal(expiredSession.body.errorCode, 'SESSION_EXPIRED');
});

test('수정 모드는 역할·상점 권한·필드 allowlist·등급 산정 규칙을 모두 재검증한다', async (t) => {
  const lab = await startLab(MEMBER_LAB_MODES.FIXED);
  t.after(() => lab.close());
  const member = await lab.login('member', 'member-test');
  const adminA = await lab.login('shop-admin-a', 'shop-admin-a-test');
  const adminB = await lab.login('shop-admin-b', 'shop-admin-b-test');

  const initial = await readContext(lab, adminA.cookie);
  assert.equal(initial.serverIndex, 1);
  assert.equal(initial.targetIndex, 3);

  const memberDenied = await saveWithFreshToken(lab, member.cookie, {
    serverIndex: 1,
    targetIndex: 3,
    gradeCount: initial.gradeCount,
    gradeNames: initial.gradeNames
  });
  assert.equal(memberDenied.status, 403);
  assert.equal(memberDenied.body.errorCode, 'PERMISSION_DENIED');

  const wrongShopDenied = await saveWithFreshToken(lab, adminB.cookie, {
    serverIndex: 1,
    targetIndex: 3,
    gradeCount: initial.gradeCount,
    gradeNames: initial.gradeNames
  });
  assert.equal(wrongShopDenied.status, 403);
  assert.equal(wrongShopDenied.body.errorCode, 'SHOP_PERMISSION_DENIED');

  const fieldDenied = await saveWithFreshToken(lab, adminA.cookie, {
    serverIndex: 1,
    targetIndex: 3,
    gradeCount: initial.gradeCount,
    gradeNames: initial.gradeNames,
    remaining: 0
  });
  assert.equal(fieldDenied.status, 400);
  assert.equal(fieldDenied.body.errorCode, 'FIELD_NOT_ALLOWED');
  assert.deepEqual(fieldDenied.body.fields, ['remaining']);

  const staleStateDenied = await saveWithFreshToken(lab, adminA.cookie, {
    serverIndex: 0,
    targetIndex: 3,
    gradeCount: initial.gradeCount,
    gradeNames: initial.gradeNames
  });
  assert.equal(staleStateDenied.status, 409);
  assert.equal(staleStateDenied.body.errorCode, 'SERVER_INDEX_MISMATCH');

  const ruleDenied = await saveWithFreshToken(lab, adminA.cookie, {
    serverIndex: 1,
    targetIndex: 5,
    gradeCount: initial.gradeCount,
    gradeNames: initial.gradeNames
  });
  assert.equal(ruleDenied.status, 422);
  assert.equal(ruleDenied.body.errorCode, 'GRADE_RULE_VIOLATION');
  assert.equal(ruleDenied.body.eligibleTargetIndex, 3);

  const saved = await saveWithFreshToken(lab, adminA.cookie, {
    serverIndex: 1,
    targetIndex: 3,
    gradeCount: initial.gradeCount,
    gradeNames: initial.gradeNames
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.policy, 'role-shop-field-and-grade-rule');
  assert.equal(saved.body.serverIndex, 3);

  const after = await readContext(lab, adminA.cookie);
  assert.equal(after.serverIndex, 3);
  assert.equal(after.targetIndex, 3);
  assert.equal(after.remaining, 4_000);
  assert.equal(after.originalProgress, 20);
});

test('실제 Weidian 쓰기 어댑터는 두 모드 모두 명시적으로 비활성 상태다', async (t) => {
  for (const mode of [MEMBER_LAB_MODES.VULNERABLE, MEMBER_LAB_MODES.FIXED] as LabMode[]) {
    const lab = await startLab(mode);
    t.after(() => lab.close());
    const health = await lab.request('/health', { method: 'GET' });
    assert.equal(health.status, 200);
    assert.equal(health.body.liveWeidianAdapter.status, 'disabled');
    assert.equal(
      health.body.liveWeidianAdapter.errorCode,
      'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
    );
  }
});

async function startLab(
  mode: LabMode,
  options: Record<string, unknown> = {}
): Promise<LabClient> {
  const { server } = createMemberSecurityLabServer({ mode, ...options });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const request: LabClient['request'] = async (pathname, input = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: input.method || 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.cookie ? { cookie: input.cookie } : {})
      },
      body:
        (input.method || 'POST') === 'GET'
          ? undefined
          : JSON.stringify(input.body || {})
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';', 1)[0]
    };
  };

  return {
    baseUrl,
    request,
    async login(username, password) {
      const result = await request('/api/lab/login', {
        body: { username, password }
      });
      assert.equal(result.status, 200);
      assert.ok(result.cookie);
      return { cookie: result.cookie as string, body: result.body };
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => error ? reject(error) : resolve());
      });
    }
  };
}

async function readContext(lab: LabClient, cookie: string) {
  const result = await lab.request('/api/member/context', {
    cookie,
    body: { shopId: MEMBER_LAB_PRIMARY_SHOP_ID }
  });
  assert.equal(result.status, 200);
  return result.body;
}

async function acquireToken(
  lab: LabClient,
  cookie: string,
  action: 'save-vip-settings' | 'reset-vip-settings'
) {
  const result = await lab.request('/api/member/action-token', {
    cookie,
    body: {
      shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
      action
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.oneTime, true);
  return String(result.body.actionToken);
}

async function saveWithFreshToken(
  lab: LabClient,
  cookie: string,
  body: Record<string, unknown>
) {
  const actionToken = await acquireToken(lab, cookie, 'save-vip-settings');
  return lab.request('/api/member/save', {
    cookie,
    body: {
      shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
      actionToken,
      clientRequestId: `test-${Math.random()}`,
      ...body
    }
  });
}
