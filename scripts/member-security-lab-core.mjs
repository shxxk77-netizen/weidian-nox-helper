import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MEMBER_LAB_MODES = Object.freeze({
  VULNERABLE: 'vulnerable',
  FIXED: 'fixed'
});

export const MEMBER_LAB_COOKIE = 'weidian_member_lab_session';
export const MEMBER_LAB_PRIMARY_SHOP_ID = '1680489787';
export const MEMBER_LAB_SECONDARY_SHOP_ID = '2098765432';

const GRADE_NAMES = Object.freeze(['普通会员', 'VIP1', 'VIP2', 'VIP3', 'VIP4', 'VIP5']);
const GRADE_THRESHOLDS = Object.freeze([0, 3_000, 7_000, 11_000, 16_000, 30_000]);
const DEFAULT_TOKEN_TTL_MS = 120_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1_000;
const MAX_BODY_BYTES = 100_000;

const ACCOUNT_FIXTURES = Object.freeze({
  member: Object.freeze({
    password: 'member-test',
    userId: 'user-member-001',
    role: 'member',
    allowedShopIds: Object.freeze([])
  }),
  'shop-admin-a': Object.freeze({
    password: 'shop-admin-a-test',
    userId: 'user-shop-admin-a',
    role: 'shop-admin',
    allowedShopIds: Object.freeze([MEMBER_LAB_PRIMARY_SHOP_ID])
  }),
  'shop-admin-b': Object.freeze({
    password: 'shop-admin-b-test',
    userId: 'user-shop-admin-b',
    role: 'shop-admin',
    allowedShopIds: Object.freeze([MEMBER_LAB_SECONDARY_SHOP_ID])
  }),
  'platform-admin': Object.freeze({
    password: 'platform-admin-test',
    userId: 'user-platform-admin',
    role: 'platform-admin',
    allowedShopIds: Object.freeze(['*'])
  })
});

const FIXED_SAVE_FIELDS = new Set([
  'shopId',
  'actionToken',
  'targetIndex',
  'serverIndex',
  'gradeCount',
  'gradeNames',
  'clientRequestId'
]);
const FIXED_RESET_FIELDS = new Set(['shopId', 'actionToken', 'clientRequestId']);

export function createMemberSecurityLab(options = {}) {
  const mode = normalizeMode(options.mode);
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const tokenTtlMs = positiveInteger(options.tokenTtlMs, DEFAULT_TOKEN_TTL_MS);
  const sessionTtlMs = positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  const sessions = new Map();
  const tokens = new Map();
  const states = seedStates();
  const auditEntries = [];

  const handler = async (request, response) => {
    setCommonHeaders(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    let requestBody;
    let session;
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'weidian-member-security-lab',
          mode,
          liveWeidianAdapter: {
            status: 'disabled',
            errorCode: 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
          }
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/lab/config') {
        sendJson(response, 200, {
          ok: true,
          mode,
          cookieName: MEMBER_LAB_COOKIE,
          tokenTtlMs,
          sessionTtlMs,
          primaryShopId: MEMBER_LAB_PRIMARY_SHOP_ID,
          secondaryShopId: MEMBER_LAB_SECONDARY_SHOP_ID,
          fixtureAccounts: Object.entries(ACCOUNT_FIXTURES).map(([username, account]) => ({
            username,
            role: account.role,
            allowedShopIds: [...account.allowedShopIds]
          })),
          liveWeidianAdapter: {
            status: 'disabled',
            errorCode: 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
          }
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/lab/login') {
        requestBody = await readJsonBody(request);
        const username = requiredString(requestBody.username, 'USERNAME_MISSING');
        const password = requiredString(requestBody.password, 'PASSWORD_MISSING');
        const account = ACCOUNT_FIXTURES[username];
        if (!account || !constantTimeEqual(password, account.password)) {
          throw httpError(401, 'INVALID_CREDENTIALS');
        }

        const sessionId = randomBytes(32).toString('base64url');
        const issuedAtEpochMs = clock();
        const expiresAtEpochMs = issuedAtEpochMs + sessionTtlMs;
        session = {
          sessionId,
          username,
          userId: account.userId,
          role: account.role,
          allowedShopIds: [...account.allowedShopIds],
          issuedAtEpochMs,
          expiresAtEpochMs
        };
        sessions.set(sessionId, session);
        response.setHeader(
          'Set-Cookie',
          `${MEMBER_LAB_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1_000)}`
        );
        audit('session-issued', session, {
          sessionFingerprint: fingerprint(sessionId),
          expiresAtEpochMs
        });
        sendJson(response, 200, {
          ok: true,
          session: publicSession(session),
          sessionFingerprint: fingerprint(sessionId)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/lab/logout') {
        session = requireSession(request, sessions, clock);
        sessions.delete(session.sessionId);
        response.setHeader(
          'Set-Cookie',
          `${MEMBER_LAB_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
        );
        audit('session-revoked', session);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/lab/audit') {
        session = requireSession(request, sessions, clock);
        sendJson(response, 200, {
          ok: true,
          mode,
          entries: auditEntries.slice(-200)
        });
        return;
      }

      if (request.method !== 'POST') {
        throw httpError(404, 'NOT_FOUND');
      }

      session = requireSession(request, sessions, clock);
      requestBody = await readJsonBody(request);

      if (url.pathname === '/api/member/context') {
        const shopId = requireShopId(requestBody.shopId, states);
        const state = states.get(shopId);
        const memberState = serializeState(state, mode);
        audit('member-read', session, { shopId, serverIndex: memberState.serverIndex });
        sendJson(response, 200, {
          ok: true,
          mode,
          ...memberState,
          session: publicSession(session)
        });
        return;
      }

      if (url.pathname === '/api/member/action-token') {
        const shopId = requireShopId(requestBody.shopId, states);
        const action = normalizeAction(requestBody.action);
        const rawToken = randomBytes(32).toString('base64url');
        const issuedAtEpochMs = clock();
        const expiresAtEpochMs = issuedAtEpochMs + tokenTtlMs;
        tokens.set(rawToken, {
          sessionId: session.sessionId,
          shopId,
          action,
          issuedAtEpochMs,
          expiresAtEpochMs,
          usedAtEpochMs: undefined
        });
        audit('action-token-issued', session, {
          shopId,
          action,
          tokenFingerprint: fingerprint(rawToken),
          expiresAtEpochMs
        });
        sendJson(response, 200, {
          ok: true,
          actionToken: rawToken,
          issuedAtEpochMs,
          expiresAtEpochMs,
          oneTime: true
        });
        return;
      }

      if (url.pathname === '/api/member/save') {
        const shopId = requireShopId(requestBody.shopId, states);
        consumeActionToken(
          requestBody.actionToken,
          session,
          shopId,
          'save-vip-settings',
          tokens,
          clock,
          audit
        );
        const state = states.get(shopId);
        const targetIndex = requireTargetIndex(requestBody.targetIndex, state.gradeNames.length);

        if (mode === MEMBER_LAB_MODES.VULNERABLE) {
          const beforeServerIndex = state.serverIndex;
          state.serverIndex = targetIndex;
          if (Number.isFinite(Number(requestBody.remaining))) {
            state.remainingOverride = Number(requestBody.remaining);
          }
          if (Number.isFinite(Number(requestBody.originalProgress))) {
            state.originalProgressOverride = Number(requestBody.originalProgress);
          }
          const memberState = serializeState(state, mode);
          audit('member-write-allowed', session, {
            shopId,
            policy: 'session-and-action-token-only',
            beforeServerIndex,
            targetIndex,
            afterServerIndex: memberState.serverIndex
          });
          sendJson(response, 200, {
            ok: true,
            mode,
            policy: 'session-and-action-token-only',
            serverIndex: memberState.serverIndex,
            state: memberState
          });
          return;
        }

        requireAuthorizedShopAdmin(session, shopId);
        assertAllowedFields(requestBody, FIXED_SAVE_FIELDS);
        assertCurrentServerState(requestBody, state);
        const eligibleTargetIndex = calculateEligibleIndex(state.lifetimeSpend, state.gradeThresholds);
        if (targetIndex !== eligibleTargetIndex) {
          throw httpError(422, 'GRADE_RULE_VIOLATION', {
            requestedTargetIndex: targetIndex,
            eligibleTargetIndex
          });
        }

        const beforeServerIndex = state.serverIndex;
        state.serverIndex = eligibleTargetIndex;
        state.remainingOverride = undefined;
        state.originalProgressOverride = undefined;
        const memberState = serializeState(state, mode);
        audit('member-write-allowed', session, {
          shopId,
          policy: 'role-shop-field-and-grade-rule',
          beforeServerIndex,
          targetIndex,
          afterServerIndex: memberState.serverIndex
        });
        sendJson(response, 200, {
          ok: true,
          mode,
          policy: 'role-shop-field-and-grade-rule',
          serverIndex: memberState.serverIndex,
          state: memberState
        });
        return;
      }

      if (url.pathname === '/api/member/reset') {
        const shopId = requireShopId(requestBody.shopId, states);
        consumeActionToken(
          requestBody.actionToken,
          session,
          shopId,
          'reset-vip-settings',
          tokens,
          clock,
          audit
        );
        const state = states.get(shopId);
        if (mode === MEMBER_LAB_MODES.VULNERABLE) {
          state.serverIndex = 0;
          state.remainingOverride = undefined;
          state.originalProgressOverride = undefined;
        } else {
          if (session.role !== 'platform-admin') throw httpError(403, 'PERMISSION_DENIED');
          requireAuthorizedShopAdmin(session, shopId);
          assertAllowedFields(requestBody, FIXED_RESET_FIELDS);
          state.serverIndex = calculateEligibleIndex(state.lifetimeSpend, state.gradeThresholds);
          state.remainingOverride = undefined;
          state.originalProgressOverride = undefined;
        }
        const memberState = serializeState(state, mode);
        audit('member-reset-allowed', session, {
          shopId,
          serverIndex: memberState.serverIndex
        });
        sendJson(response, 200, {
          ok: true,
          mode,
          serverIndex: memberState.serverIndex,
          state: memberState
        });
        return;
      }

      throw httpError(404, 'NOT_FOUND');
    } catch (error) {
      const normalized = normalizeError(error);
      if (session) {
        audit('request-denied', session, {
          path: request.url,
          errorCode: normalized.errorCode
        });
      }
      sendJson(response, normalized.statusCode, {
        ok: false,
        mode,
        errorCode: normalized.errorCode,
        errorMessage: normalized.errorCode,
        ...(normalized.details || {})
      });
    }
  };

  function audit(event, session, details = {}) {
    auditEntries.push({
      atEpochMs: clock(),
      event,
      mode,
      principal: session
        ? {
            userId: session.userId,
            role: session.role,
            sessionFingerprint: fingerprint(session.sessionId)
          }
        : undefined,
      ...details
    });
    if (auditEntries.length > 500) auditEntries.shift();
  }

  return {
    mode,
    handler,
    inspect() {
      return {
        sessions: sessions.size,
        tokens: tokens.size,
        states: [...states.values()].map((state) => serializeState(state, mode)),
        auditEntries: auditEntries.map((entry) => ({ ...entry }))
      };
    }
  };
}

export function createMemberSecurityLabServer(options = {}) {
  const lab = createMemberSecurityLab(options);
  const server = http.createServer(lab.handler);
  return { lab, server };
}

function seedStates() {
  return new Map([
    [
      MEMBER_LAB_PRIMARY_SHOP_ID,
      {
        shopId: MEMBER_LAB_PRIMARY_SHOP_ID,
        ownerUserId: 'owner-primary-shop',
        serverIndex: 1,
        lifetimeSpend: 12_000,
        gradeNames: [...GRADE_NAMES],
        gradeThresholds: [...GRADE_THRESHOLDS],
        remainingOverride: undefined,
        originalProgressOverride: undefined
      }
    ],
    [
      MEMBER_LAB_SECONDARY_SHOP_ID,
      {
        shopId: MEMBER_LAB_SECONDARY_SHOP_ID,
        ownerUserId: 'owner-secondary-shop',
        serverIndex: 1,
        lifetimeSpend: 5_000,
        gradeNames: [...GRADE_NAMES],
        gradeThresholds: [...GRADE_THRESHOLDS],
        remainingOverride: undefined,
        originalProgressOverride: undefined
      }
    ]
  ]);
}

function serializeState(state, mode) {
  const eligibleTargetIndex = calculateEligibleIndex(state.lifetimeSpend, state.gradeThresholds);
  const calculatedProgress = calculateProgress(
    state.lifetimeSpend,
    eligibleTargetIndex,
    state.gradeThresholds
  );
  const vulnerable = mode === MEMBER_LAB_MODES.VULNERABLE;
  return {
    shopId: state.shopId,
    serverIndex: state.serverIndex,
    targetIndex: eligibleTargetIndex,
    gradeCount: state.gradeNames.length,
    gradeNames: [...state.gradeNames],
    name: state.gradeNames[state.serverIndex],
    remaining:
      vulnerable && state.remainingOverride !== undefined
        ? state.remainingOverride
        : calculatedProgress.remaining,
    originalProgress:
      vulnerable && state.originalProgressOverride !== undefined
        ? state.originalProgressOverride
        : calculatedProgress.originalProgress
  };
}

function calculateEligibleIndex(lifetimeSpend, thresholds) {
  let result = 0;
  for (let index = 0; index < thresholds.length; index += 1) {
    if (lifetimeSpend >= thresholds[index]) result = index;
  }
  return result;
}

function calculateProgress(lifetimeSpend, eligibleIndex, thresholds) {
  if (eligibleIndex >= thresholds.length - 1) {
    return { remaining: 0, originalProgress: 100 };
  }
  const currentThreshold = thresholds[eligibleIndex];
  const nextThreshold = thresholds[eligibleIndex + 1];
  const completed = Math.max(0, lifetimeSpend - currentThreshold);
  const interval = Math.max(1, nextThreshold - currentThreshold);
  return {
    remaining: Math.max(0, nextThreshold - lifetimeSpend),
    originalProgress: Math.round((completed / interval) * 10_000) / 100
  };
}

function requireSession(request, sessions, clock) {
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies[MEMBER_LAB_COOKIE];
  if (!sessionId) throw httpError(401, 'SESSION_COOKIE_MISSING');
  const session = sessions.get(sessionId);
  if (!session) throw httpError(401, 'SESSION_INVALID');
  if (session.expiresAtEpochMs <= clock()) {
    sessions.delete(sessionId);
    throw httpError(401, 'SESSION_EXPIRED');
  }
  return session;
}

function consumeActionToken(rawValue, session, shopId, action, tokens, clock, audit) {
  const rawToken = requiredString(rawValue, 'ACTION_TOKEN_INVALID');
  const token = tokens.get(rawToken);
  if (!token) throw httpError(401, 'ACTION_TOKEN_INVALID');
  if (token.usedAtEpochMs !== undefined) throw httpError(409, 'ACTION_TOKEN_ALREADY_USED');
  if (token.expiresAtEpochMs <= clock()) throw httpError(401, 'ACTION_TOKEN_EXPIRED');
  if (
    token.sessionId !== session.sessionId ||
    token.shopId !== shopId ||
    token.action !== action
  ) {
    throw httpError(403, 'ACTION_TOKEN_CONTEXT_MISMATCH');
  }
  token.usedAtEpochMs = clock();
  audit('action-token-consumed', session, {
    shopId,
    action,
    tokenFingerprint: fingerprint(rawToken),
    usedAtEpochMs: token.usedAtEpochMs
  });
}

function requireAuthorizedShopAdmin(session, shopId) {
  if (session.role !== 'shop-admin' && session.role !== 'platform-admin') {
    throw httpError(403, 'PERMISSION_DENIED');
  }
  if (!session.allowedShopIds.includes('*') && !session.allowedShopIds.includes(shopId)) {
    throw httpError(403, 'SHOP_PERMISSION_DENIED');
  }
}

function assertAllowedFields(body, allowedFields) {
  const unexpected = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unexpected.length) {
    throw httpError(400, 'FIELD_NOT_ALLOWED', { fields: unexpected.sort() });
  }
}

function assertCurrentServerState(body, state) {
  const serverIndex = Number(body.serverIndex);
  if (!Number.isInteger(serverIndex) || serverIndex !== state.serverIndex) {
    throw httpError(409, 'SERVER_INDEX_MISMATCH', {
      expectedServerIndex: state.serverIndex
    });
  }
  if (Number(body.gradeCount) !== state.gradeNames.length) {
    throw httpError(409, 'GRADE_CATALOG_MISMATCH');
  }
  if (
    !Array.isArray(body.gradeNames) ||
    body.gradeNames.length !== state.gradeNames.length ||
    body.gradeNames.some((name, index) => name !== state.gradeNames[index])
  ) {
    throw httpError(409, 'GRADE_CATALOG_MISMATCH');
  }
}

function requireShopId(rawValue, states) {
  const shopId = requiredString(rawValue, 'SHOP_ID_MISSING');
  if (!/^\d{6,20}$/.test(shopId)) throw httpError(400, 'SHOP_ID_INVALID');
  if (!states.has(shopId)) throw httpError(404, 'SHOP_NOT_FOUND');
  return shopId;
}

function requireTargetIndex(rawValue, gradeCount) {
  const targetIndex = Number(rawValue);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= gradeCount) {
    throw httpError(400, 'TARGET_INDEX_OUT_OF_RANGE');
  }
  return targetIndex;
}

function normalizeAction(value) {
  if (value === 'save-vip-settings' || value === 'reset-vip-settings') return value;
  throw httpError(400, 'ACTION_TOKEN_CONTEXT_MISMATCH');
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw httpError(413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'JSON_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'JSON_OBJECT_REQUIRED');
  }
  return value;
}

function parseCookies(rawValue = '') {
  const result = {};
  for (const part of String(rawValue).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function publicSession(session) {
  return {
    username: session.username,
    userId: session.userId,
    role: session.role,
    allowedShopIds: [...session.allowedShopIds],
    issuedAtEpochMs: session.issuedAtEpochMs,
    expiresAtEpochMs: session.expiresAtEpochMs
  };
}

function requiredString(value, errorCode) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw httpError(400, errorCode);
  return result;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function normalizeMode(value) {
  if (value === MEMBER_LAB_MODES.VULNERABLE || value === MEMBER_LAB_MODES.FIXED) return value;
  if (value === undefined) return MEMBER_LAB_MODES.FIXED;
  throw new Error(`Unsupported MEMBER_LAB_MODE: ${String(value)}`);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function httpError(statusCode, errorCode, details) {
  const error = new Error(errorCode);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  error.details = details;
  return error;
}

function normalizeError(error) {
  return {
    statusCode: Number(error?.statusCode) || 500,
    errorCode: String(error?.errorCode || 'INTERNAL_SERVER_ERROR'),
    details:
      error?.details && typeof error.details === 'object'
        ? error.details
        : undefined
  };
}

function setCommonHeaders(request, response) {
  const origin = String(request.headers.origin || '');
  if (
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin) ||
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  ) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}
