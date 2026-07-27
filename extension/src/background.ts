// @ts-nocheck
import { InMemoryActionTokenManager } from './member/action-token-manager';
import {
  AuthorizedMemberActionAdapter,
  MEMBER_ANALYSIS_CONFIG
} from './member/member-action-adapter';
import { MemberCommandHandler } from './member/member-command-handler';
import { PageObservedActionTokenSource } from './member/page-action-token-source';

const BRIDGE_BASE = 'http://127.0.0.1:17873';
const ports = new Map();
const tabContexts = new Map();
const tabActionIntents = new Map();
let pollInFlight = false;
let fastPollTimer = null;
const memberLevelCache = new Map();
const memberLevelJobs = new Map();
const memberRequestContracts = new Map();
const observedWdTokens = new Map();
let latestSellerMemberLevels = null;
let memberRequestObservationCount = 0;
let memberApiConnectionFingerprint = '';
const MAX_MEMBER_REQUEST_OBSERVATIONS = 500;

const memberAdapter = new AuthorizedMemberActionAdapter(
  MEMBER_ANALYSIS_CONFIG,
  fetch,
  executeMemberRequestInSellerPage
);
const pageTokenSource = new PageObservedActionTokenSource(requestMemberActionTokenScan);
const actionTokenManager = new InMemoryActionTokenManager(
  (context, action) => pageTokenSource.acquire(context, action),
  Date.now,
  publishActionTokenState
);
const memberCommandHandler = new MemberCommandHandler(memberAdapter, actionTokenManager);

installMemberApiContractObserver();

function installMemberApiContractObserver() {
  if (!chrome.webRequest?.onBeforeRequest) return;
  const filter = {
    urls: ['https://weidian.com/*', 'https://*.weidian.com/*'],
    types: ['xmlhttprequest', 'other']
  };

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!isCandidateWeidianApiUrl(details.url) || memberRequestObservationCount >= MAX_MEMBER_REQUEST_OBSERVATIONS) {
        return;
      }
      captureObservedWdToken(details);
      const describedUrl = describeContractUrl(details.url);
      memberRequestContracts.set(details.requestId, {
        observerVersion: 1,
        source: 'chrome-web-request',
        observedAtIso: new Date().toISOString(),
        transport: details.type || 'unknown',
        tabId: details.tabId,
        method: String(details.method || 'GET').toUpperCase(),
        ...describedUrl,
        requestBodyShape: describeWebRequestBody(details.requestBody)
      });
      trimMemberRequestContracts();
    },
    filter,
    ['requestBody']
  );

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const contract = memberRequestContracts.get(details.requestId);
      if (!contract) return;
      const headerNames = headerNamesOnly(details.requestHeaders);
      contract.requestHeaderNames = headerNames;
      contract.requestHeaderMetadata = safeRequestHeaderMetadata(details.requestHeaders);
      contract.chromeSessionCookie = headerNames.includes('cookie');
      contract.tokenPlacement = detectContractTokenPlacement(
        contract.queryKeys || [],
        headerNames,
        contract.requestBodyShape,
        contract.queryShape
      );
    },
    filter,
    ['requestHeaders', 'extraHeaders']
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const contract = memberRequestContracts.get(details.requestId);
      if (!contract) return;
      contract.status = details.statusCode;
      contract.outcome = details.statusCode >= 200 && details.statusCode < 400 ? 'ok' : 'http-error';
      contract.responseHeaderNames = headerNamesOnly(details.responseHeaders);
      contract.responseContentType = contentTypeFromHeaders(details.responseHeaders);
      emitMemberRequestContract(details.requestId);
    },
    filter,
    ['responseHeaders', 'extraHeaders']
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const contract = memberRequestContracts.get(details.requestId);
      if (!contract) return;
      contract.outcome = 'network-error';
      contract.errorName = String(details.error || 'network-error').slice(0, 120);
      emitMemberRequestContract(details.requestId);
    },
    filter
  );
}

function captureObservedWdToken(details) {
  try {
    const url = new URL(details.url);
    const rawToken = String(url.searchParams.get('wdtoken') || '').trim();
    if (
      !rawToken ||
      rawToken.length > 4096 ||
      !Number.isInteger(details.tabId) ||
      details.tabId < 0
    ) {
      return;
    }
    observedWdTokens.set(details.tabId, {
      rawToken,
      tabId: details.tabId,
      observedAtEpochMs: Date.now(),
      sourceUrl: `${url.origin}${url.pathname}`
    });
    trimObservedWdTokens();
  } catch {
    // Only valid Weidian request URLs are captured.
  }
}

function trimObservedWdTokens() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [tabId, token] of observedWdTokens) {
    if (token.observedAtEpochMs < cutoff) observedWdTokens.delete(tabId);
  }
}

function latestObservedWdToken() {
  trimObservedWdTokens();
  return [...observedWdTokens.values()]
    .sort((left, right) => right.observedAtEpochMs - left.observedAtEpochMs)[0];
}

function isCandidateWeidianApiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)weidian\.com$/i.test(url.hostname) &&
      (
        url.hostname === 'thor.weidian.com' ||
        /\/\d+\.\d+(?:\/|$)/.test(url.pathname) ||
        /(?:api|member|customer|grade|vip|shopidentity)/i.test(url.pathname)
      );
  } catch {
    return false;
  }
}

function isLikelyMemberApiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)weidian\.com$/i.test(url.hostname) &&
      /(?:member|customer|grade|vip|shopidentity|identitycenter|wdcrm)/i.test(
        `${url.hostname}${url.pathname}`
      );
  } catch {
    return false;
  }
}

function isMemberPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)weidian\.com$/i.test(url.hostname) &&
      /\/m\/mkt-h5-member-detail\/index(?:\.html)?\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function describeContractUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      url: `${url.origin}${url.pathname}`,
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      queryShape: describeContractSearchParams(url.searchParams)
    };
  } catch {
    return { url: 'invalid', queryKeys: [], queryShape: undefined };
  }
}

function describeContractSearchParams(params) {
  const keys = [...new Set([...params.keys()])].sort();
  if (!keys.length) return undefined;
  return Object.fromEntries(keys.map((key) => {
    const values = params.getAll(key);
    const shape = values.length > 1
      ? [describeContractEncodedValue(values[0])]
      : describeContractEncodedValue(values[0]);
    return [key, shape];
  }));
}

function describeWebRequestBody(requestBody) {
  if (!requestBody) return undefined;
  if (requestBody.formData) {
    return Object.fromEntries(
      Object.keys(requestBody.formData).sort().map((key) => [
        key,
        requestBody.formData[key]?.length > 1 ? ['string'] : 'string'
      ])
    );
  }
  const bytes = requestBody.raw?.flatMap((entry) => {
    if (!entry?.bytes) return [];
    try {
      return [new Uint8Array(entry.bytes)];
    } catch {
      return [];
    }
  });
  if (!bytes?.length) return requestBody.error ? 'unavailable' : undefined;
  try {
    const totalLength = bytes.reduce((total, chunk) => total + chunk.byteLength, 0);
    const joined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of bytes) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return describeContractEncodedValue(new TextDecoder().decode(joined));
  } catch {
    return 'binary';
  }
}

function describeContractEncodedValue(value) {
  const text = String(value || '');
  try {
    return contractShapeOf(JSON.parse(text));
  } catch {
    try {
      const params = new URLSearchParams(text);
      if ([...params.keys()].length) return describeContractSearchParams(params);
    } catch {
      // Keep only the primitive type.
    }
    return 'string';
  }
}

function contractShapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth >= 3 ? 'array' : [value.length ? contractShapeOf(value[0], depth + 1) : 'empty'];
  if (typeof value !== 'object') return typeof value;
  if (depth >= 3) return 'object';
  return Object.fromEntries(
    Object.keys(value).sort().slice(0, 80).map((key) => [key, contractShapeOf(value[key], depth + 1)])
  );
}

function headerNamesOnly(headers) {
  return [...new Set((headers || []).map((header) => String(header.name || '').toLowerCase()).filter(Boolean))].sort();
}

function safeRequestHeaderMetadata(headers) {
  const result = {};
  for (const header of headers || []) {
    const name = String(header.name || '').toLowerCase();
    const value = String(header.value || '');
    if (name === 'content-type') result.contentType = value.split(';')[0].trim().toLowerCase().slice(0, 100);
    if (name === 'origin') result.origin = safeContractPage(value, true);
    if (name === 'referer') result.referer = safeContractPage(value, false);
  }
  return Object.keys(result).length ? result : undefined;
}

function safeContractPage(value, originOnly) {
  try {
    const url = new URL(value);
    if (!/(^|\.)weidian\.com$/i.test(url.hostname)) return 'non-weidian';
    return originOnly ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid';
  }
}

function contentTypeFromHeaders(headers) {
  const value = (headers || []).find((header) => String(header.name || '').toLowerCase() === 'content-type')?.value;
  return String(value || '').split(';')[0].trim().toLowerCase().slice(0, 100);
}

function detectContractTokenPlacement(queryKeys, headerNames, bodyShape, queryShape) {
  const isActionTokenKey = (key) => /^(?:(?:x-)?action[-_]?token|wdtoken)$/i.test(String(key));
  if (queryKeys.some(isActionTokenKey) || containsContractShapeKey(queryShape, isActionTokenKey)) return 'query';
  if (headerNames.some(isActionTokenKey)) return 'header';
  if (containsContractShapeKey(bodyShape, isActionTokenKey)) return 'body';
  return 'not-observed';
}

function containsContractShapeKey(value, predicate) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsContractShapeKey(item, predicate));
  return Object.entries(value).some(([key, child]) => predicate(key) || containsContractShapeKey(child, predicate));
}

function emitMemberRequestContract(requestId) {
  const contract = memberRequestContracts.get(requestId);
  memberRequestContracts.delete(requestId);
  if (!contract || memberRequestObservationCount >= MAX_MEMBER_REQUEST_OBSERVATIONS) return;
  const tabId = contract.tabId;
  delete contract.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'EW_MEMBER_API_CONTRACT_OBSERVATION',
    observation: contract
  }).catch(() => {});
  void publishMemberRequestContract(tabId, contract);
}

async function publishMemberRequestContract(tabId, observation) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const pageUrl = String(tab.url || '');
    if (!isMemberPageUrl(pageUrl) && !isLikelyMemberApiUrl(observation.url)) return;
    const page = safeMemberPage(pageUrl);
    const shopId = memberShopIdFromPage(pageUrl);
    await bridgeFetch('/api/member-api-contract', {
      method: 'POST',
      body: JSON.stringify({
        source: observation.source === 'page-main' ? 'page-main' : 'chrome-web-request',
        pageUrl: page,
        shopId,
        observation
      })
    });
    memberRequestObservationCount += 1;
  } catch {
    // The next live request can be retried when the local bridge is available.
  }
}

function safeMemberPage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)weidian\.com$/i.test(url.hostname)) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function memberShopIdFromPage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const shopId = url.searchParams.get('shopId') || url.searchParams.get('shopid');
    return /^\d{6,20}$/.test(String(shopId || '')) ? shopId : undefined;
  } catch {
    return undefined;
  }
}

function trimMemberRequestContracts() {
  if (memberRequestContracts.size <= 250) return;
  const oldest = [...memberRequestContracts.keys()].slice(0, memberRequestContracts.size - 200);
  for (const requestId of oldest) memberRequestContracts.delete(requestId);
}

async function bridgeFetch(path, init = {}) {
  const response = await fetch(`${BRIDGE_BASE}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error(`bridge ${response.status}`);
  return response.json();
}

async function requestMemberActionTokenScan(context, action) {
  const observedWdToken = latestObservedWdToken();
  if (observedWdToken) {
    pageTokenSource.accept(context, action, {
      rawToken: observedWdToken.rawToken,
      issuedAtEpochMs: observedWdToken.observedAtEpochMs,
      oneTime: false,
      source: 'network-request'
    });
    return;
  }
  const tabEntry = [...tabContexts.entries()].find(([, candidate]) =>
    candidate.shopId === context.shopId &&
    candidate.sessionFingerprint === context.sessionFingerprint
  );
  if (!tabEntry) {
    throw memberCommandError(
      'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
      '현재 Chrome 세션에서 wdtoken이 포함된 Weidian 요청을 찾지 못했습니다.'
    );
  }
  const [tabId] = tabEntry;
  let result;
  try {
    result = await chrome.tabs.sendMessage(tabId, {
      type: 'EW_SCAN_MEMBER_ACTION_TOKEN',
      action,
      requestId: crypto.randomUUID()
    });
  } catch {
    throw memberCommandError(
      'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
      'Weidian 페이지의 wdtoken 관찰기에 연결하지 못했습니다.'
    );
  }
  if (!result?.ok) {
    throw memberCommandError(
      result?.errorCode || 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
      result?.errorMessage || 'Weidian 페이지의 wdtoken 관찰기를 실행하지 못했습니다.'
    );
  }
}

async function executeMemberRequestInSellerPage(request) {
  const url = new URL(String(request.url || ''));
  if (
    request.method !== 'GET' ||
    url.protocol !== 'https:' ||
    url.hostname !== 'thor.weidian.com' ||
    ![
      '/wdcrm/trade.setMemberLevel/2.0',
      '/wdcrm/customer.summary.pc/1.0'
    ].includes(url.pathname)
  ) {
    throw memberCommandError(
      'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
      '허용되지 않은 Weidian Member endpoint입니다.'
    );
  }
  const rawWdToken = String(url.searchParams.get('wdtoken') || '');
  const tokenRecord = [...observedWdTokens.values()]
    .filter((record) => record.rawToken === rawWdToken)
    .sort((left, right) => right.observedAtEpochMs - left.observedAtEpochMs)[0] ||
    latestObservedWdToken();
  if (!tokenRecord) {
    throw memberCommandError(
      'ACTION_TOKEN_NOT_FOUND',
      '판매자 페이지 요청에서 wdtoken을 먼저 감지해야 합니다.'
    );
  }
  let result;
  try {
    result = await chrome.tabs.sendMessage(tokenRecord.tabId, {
      type: 'EW_EXECUTE_MEMBER_PAGE_REQUEST',
      request: {
        method: 'GET',
        url: url.toString()
      },
      requestId: crypto.randomUUID()
    });
  } catch {
    throw memberCommandError(
      'TARGET_PAGE_MISMATCH',
      'wdtoken을 감지한 판매자 탭에서 Member 요청을 실행할 수 없습니다.'
    );
  }
  if (!result?.ok || !result.payload || typeof result.payload !== 'object') {
    throw memberCommandError(
      result?.errorCode || 'NETWORK_ERROR',
      result?.errorMessage || '판매자 페이지의 Member 요청이 실패했습니다.'
    );
  }
  return result.payload;
}

function publishActionTokenState(context, actionToken) {
  const safeMeta = {
    ...actionToken,
    tokenFingerprint: actionToken.tokenFingerprint,
    rawToken: undefined
  };
  for (const [tabId, candidate] of tabContexts) {
    if (
      candidate.shopId !== context.shopId ||
      candidate.sessionFingerprint !== context.sessionFingerprint
    ) {
      continue;
    }
    chrome.tabs.sendMessage(tabId, {
      type: 'EW_MEMBER_ACTION_TOKEN_STATE',
      shopId: context.shopId,
      actionToken: safeMeta
    }).catch(() => {});
  }
  bridgeFetch('/api/member-token-state', {
    method: 'POST',
    body: JSON.stringify({
      shopId: context.shopId,
      actionToken: safeMeta
    })
  }).catch(() => {});
}

async function pollBridge() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const state = await bridgeFetch('/api/state');
    applyMemberApiConnection(state?.context?.memberApi);
    deliverStateToPorts(state);
    const delivered = await deliverStateToTabsWithoutPorts(state);
    if (delivered.size > 0) await ackCommands([...delivered]);
  } catch {
    // The desktop app may not be running.
  } finally {
    pollInFlight = false;
  }
}

function applyMemberApiConnection(connection) {
  if (!connection || typeof connection !== 'object') return;
  const fingerprint = JSON.stringify(connection);
  if (fingerprint === memberApiConnectionFingerprint) return;
  try {
    memberAdapter.configureConnection(connection);
    memberApiConnectionFingerprint = fingerprint;
  } catch {
    // Desktop settings validation remains the source of truth.
  }
}

async function deliverStateToTabsWithoutPorts(state) {
  const tabs = await chrome.tabs.query({ url: ['https://weidian.com/*', 'https://*.weidian.com/*'] });
  const connectedTabIds = new Set(
    [...ports.values()].map((entry) => entry.tabId).filter((tabId) => Number.isInteger(tabId))
  );
  const delivered = new Set();
  for (const tab of tabs) {
    if (!tab.id || connectedTabIds.has(tab.id)) continue;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'EW_BRIDGE_STATE', state });
      for (const id of result?.handledCommandIds || []) delivered.add(id);
    } catch {
      // The tab may still be loading.
    }
  }
  return delivered;
}

function deliverStateToPorts(state) {
  for (const [key, entry] of ports) {
    try {
      entry.port.postMessage({ type: 'EW_BRIDGE_STATE', state });
    } catch {
      ports.delete(key);
    }
  }
}

async function ackCommands(ids) {
  if (!ids.length) return;
  await bridgeFetch('/api/ack', {
    method: 'POST',
    body: JSON.stringify({ ids })
  }).catch(() => {});
}

function ensureFastPoll() {
  if (fastPollTimer) return;
  fastPollTimer = setInterval(pollBridge, 350);
  void pollBridge();
}

function stopFastPollIfIdle() {
  if (ports.size > 0 || !fastPollTimer) return;
  clearInterval(fastPollTimer);
  fastPollTimer = null;
}

chrome.runtime.onInstalled.addListener(() => {
  pageTokenSource.clearAll();
  actionTokenManager.clearAll();
  observedWdTokens.clear();
  latestSellerMemberLevels = null;
  tabContexts.clear();
  chrome.alarms.create('ew-weidian-heartbeat', { delayInMinutes: 0, periodInMinutes: 0.5 });
  void pollBridge();
});

chrome.runtime.onStartup.addListener(() => {
  pageTokenSource.clearAll();
  actionTokenManager.clearAll();
  observedWdTokens.clear();
  latestSellerMemberLevels = null;
  chrome.alarms.create('ew-weidian-heartbeat', { delayInMinutes: 0, periodInMinutes: 0.5 });
  void pollBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ew-weidian-heartbeat') void pollBridge();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'EW_WEIDIAN_PORT') return;
  const tabId = port.sender?.tab?.id;
  const key = `${tabId ?? 'unknown'}-${Date.now()}-${Math.random()}`;
  ports.set(key, { port, tabId });
  ensureFastPoll();
  port.onMessage.addListener((message) => {
    if (message?.type === 'EW_ACK' && Array.isArray(message.ids)) void ackCommands(message.ids);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(key);
    stopFastPollIfIdle();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'EW_SELLER_MEMBER_CATALOG_OBSERVED') {
    const memberLevels = normalizeSellerMemberLevels(message.memberLevels);
    if (memberLevels.length) {
      latestSellerMemberLevels = {
        observedAtEpochMs: Date.now(),
        memberLevels
      };
      sendResponse({ ok: true, count: memberLevels.length });
    } else {
      sendResponse({ ok: false, count: 0 });
    }
    return false;
  }

  if (message?.type === 'EW_MEMBER_API_CONTRACT_OBSERVED' && message.observation) {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || tabId < 0) {
      sendResponse({ ok: false });
      return false;
    }
    void publishMemberRequestContract(tabId, {
      ...message.observation,
      source: 'page-main'
    })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'EW_OBSERVATION') {
    if (sender.tab && !sender.tab.active) {
      sendResponse({ ok: true, ignored: 'inactive-tab' });
      return false;
    }
    bridgeFetch('/api/observation', {
      method: 'POST',
      body: JSON.stringify(message.payload)
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'EW_ACK_COMMANDS') {
    const ids = Array.isArray(message.ids) ? message.ids.filter((id) => typeof id === 'string') : [];
    ackCommands(ids)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'EW_MEMBER_ACTION_TOKEN_DETECTED') {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || !message.context || !message.detection) {
      sendResponse({ ok: false, errorCode: 'SESSION_MISSING' });
      return false;
    }
    handleDetectedActionToken(tabId, message.context, message.detection)
      .then((meta) => sendResponse({ ok: true, actionToken: meta }))
      .catch((error) =>
        sendResponse({
          ok: false,
          errorCode: error?.code || 'UNKNOWN_MEMBER_ERROR',
          errorMessage: sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
        })
      );
    return true;
  }

  if (message?.type === 'EW_RUN_MEMBER_COMMAND') {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || !message.command || !message.context) {
      sendResponse({ ok: false, errorCode: 'SESSION_MISSING', errorMessage: 'Member 탭 컨텍스트가 없습니다.' });
      return false;
    }
    handleMemberCommand(tabId, message.command, message.context)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          errorCode: error?.code || 'UNKNOWN_MEMBER_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      );
    return true;
  }

  if (message?.type === 'EW_REPORT_MEMBER_COMMAND_ERROR') {
    if (!sender.tab || !message.command) {
      sendResponse({ ok: false });
      return false;
    }
    reportMemberCommandFailure(
      message.command,
      message.errorCode || 'UNKNOWN_MEMBER_ERROR',
      message.errorMessage || 'Member 명령이 실행되기 전에 실패했습니다.'
    )
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'EW_DOWNLOAD_IMAGES') {
    const urls = Array.isArray(message.urls)
      ? message.urls.filter((url) => typeof url === 'string' && /^https:\/\//i.test(url)).slice(0, 200)
      : [];
    const folder = sanitizePathPart(message.folder || 'images');
    Promise.all(
      urls.map((url, index) =>
        chrome.downloads.download({
          url,
          filename: `weidian/${folder}/${String(index + 1).padStart(3, '0')}-${fileNameFromUrl(url)}`,
          conflictAction: 'uniquify',
          saveAs: false
        })
      )
    )
      .then((ids) => sendResponse({ ok: true, count: ids.length }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'EW_SAVE_MEMBER_PREVIEW') {
    bridgeFetch('/api/member-preview', {
      method: 'POST',
      body: JSON.stringify(message.preview || {})
    })
      .then((result) => sendResponse({ ok: true, context: result.context }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'EW_DISCOVER_MEMBER_LEVELS') {
    const shopId = String(message.shopId || '').trim();
    if (!/^\d{6,20}$/.test(shopId)) {
      sendResponse({ ok: false, error: '상점 ID 형식이 올바르지 않습니다.' });
      return false;
    }
    discoverMemberLevels(shopId)
      .then((memberLevels) => sendResponse({ ok: memberLevels.length > 0, memberLevels }))
      .catch((error) => sendResponse({ ok: false, error: String(error), memberLevels: [] }));
    return true;
  }
  return false;
});

async function handleMemberCommand(tabId, command, context) {
  let result;
  try {
    const verifiedContext = {
      ...context,
      sessionFingerprint: await fingerprintChromeSession(context)
    };
    const previous = tabContexts.get(tabId);
    if (previous?.sessionFingerprint && previous.sessionFingerprint !== verifiedContext.sessionFingerprint) {
      memberCommandHandler.clearSession(previous.sessionFingerprint);
    }
    if (previous?.shopId && previous.shopId !== verifiedContext.shopId) {
      memberCommandHandler.clearShop(previous.shopId);
    }
    tabContexts.set(tabId, {
      shopId: verifiedContext.shopId,
      sessionFingerprint: verifiedContext.sessionFingerprint,
      origin: verifiedContext.origin,
      pageUrl: verifiedContext.pageUrl
    });
    tabActionIntents.set(tabId, {
      action:
        command.type === 'reset-vip-settings' ||
        (
          command.type === 'refresh-action-token' &&
          command.payload?.action === 'reset-vip-settings'
        )
          ? 'reset-vip-settings'
          : 'save-vip-settings',
      savedAtEpochMs: Date.now()
    });
    result = await memberCommandHandler.execute(command, verifiedContext);
  } catch (error) {
    result = memberCommandFailureResult(command, error?.code || 'UNKNOWN_MEMBER_ERROR', error);
  }
  await bridgeFetch('/api/command-result', {
    method: 'POST',
    body: JSON.stringify(result)
  }).catch(() => {});
  return result;
}

async function handleDetectedActionToken(tabId, rawContext, detection) {
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = new URL(String(tab.url || ''));
  const pageUrl = new URL(String(rawContext.pageUrl || ''));
  if (
    tabUrl.origin !== pageUrl.origin ||
    tabUrl.pathname !== pageUrl.pathname ||
    pageUrl.protocol !== 'https:' ||
    !/(^|\.)weidian\.com$/i.test(pageUrl.hostname)
  ) {
    throw memberCommandError('TARGET_PAGE_MISMATCH', '토큰 감지 페이지와 Chrome 탭이 일치하지 않습니다.');
  }
  const shopId = String(rawContext.shopId || '').trim();
  if (!/^\d{6,20}$/.test(shopId)) {
    throw memberCommandError('SHOP_ID_MISSING');
  }
  const rawToken = String(detection.rawToken || '').trim();
  if (!rawToken || rawToken.length > 4096) {
    throw memberCommandError('ACTION_TOKEN_MISSING');
  }
  if (detection.source === 'network-request' && detection.oneTime !== false) {
    return {
      status: 'consumed',
      shopId,
      action: normalizeDetectedAction(tabId, detection.action),
      oneTime: detection.oneTime !== false,
      source: 'network-request'
    };
  }
  const context = {
    origin: pageUrl.origin,
    pageUrl: pageUrl.href,
    shopId,
    sessionFingerprint: await fingerprintChromeSession({
      ...rawContext,
      origin: pageUrl.origin,
      pageUrl: pageUrl.href,
      shopId
    }),
    currentServerIndex: 0,
    gradeCount: 1,
    gradeNames: ['UNKNOWN']
  };
  const previous = tabContexts.get(tabId);
  if (previous?.sessionFingerprint && previous.sessionFingerprint !== context.sessionFingerprint) {
    memberCommandHandler.clearSession(previous.sessionFingerprint);
  }
  if (previous?.shopId && previous.shopId !== context.shopId) {
    memberCommandHandler.clearShop(previous.shopId);
  }
  tabContexts.set(tabId, {
    shopId: context.shopId,
    sessionFingerprint: context.sessionFingerprint,
    origin: context.origin,
    pageUrl: context.pageUrl
  });
  const action = normalizeDetectedAction(tabId, detection.action);
  const acquired = {
    rawToken,
    issuedAtEpochMs: finiteEpochOrNow(detection.issuedAtEpochMs),
    expiresAtEpochMs: finiteEpoch(detection.expiresAtEpochMs),
    oneTime: detection.oneTime !== false,
    source:
      detection.source === 'page-bootstrap'
        ? 'page-bootstrap'
        : detection.source === 'network-request'
          ? 'network-request'
          : 'network-response'
  };
  if (pageTokenSource.accept(context, action, acquired)) {
    return {
      status: 'acquiring',
      shopId,
      action,
      oneTime: acquired.oneTime,
      source: acquired.source
    };
  }
  return actionTokenManager.ingest(context, action, acquired);
}

function normalizeDetectedAction(tabId, action) {
  if (action === 'reset-vip-settings' || action === 'save-vip-settings') return action;
  const intent = tabActionIntents.get(tabId);
  if (intent && Date.now() - intent.savedAtEpochMs <= 2 * 60_000) return intent.action;
  return 'save-vip-settings';
}

function finiteEpochOrNow(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : Date.now();
}

function finiteEpoch(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : undefined;
}

async function reportMemberCommandFailure(command, errorCode, errorMessage) {
  const result = memberCommandFailureResult(command, errorCode, errorMessage);
  await bridgeFetch('/api/command-result', {
    method: 'POST',
    body: JSON.stringify(result)
  }).catch(() => {});
  return result;
}

function memberCommandFailureResult(command, errorCode, errorMessage) {
  return {
    commandId: String(command?.id || 'unknown').slice(0, 200),
    commandType: command?.type || 'sync-vip-grades',
    clientRequestId: String(command?.payload?.clientRequestId || '').slice(0, 200) || undefined,
    ok: false,
    completedAtIso: new Date().toISOString(),
    errorCode: String(errorCode || 'UNKNOWN_MEMBER_ERROR').slice(0, 100),
    errorMessage: sanitizeErrorMessage(
      errorMessage instanceof Error ? errorMessage.message : String(errorMessage || errorCode || 'Member 명령 실패')
    )
  };
}

chrome.tabs.onRemoved.addListener((tabId) => clearTabContext(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) clearTabContext(tabId);
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  const domain = String(changeInfo.cookie?.domain || '').replace(/^\./, '');
  if (!/(^|\.)weidian\.com$/i.test(domain)) return;
  pageTokenSource.clearAll();
  actionTokenManager.clearAll();
  tabContexts.clear();
  observedWdTokens.clear();
  latestSellerMemberLevels = null;
});

function clearTabContext(tabId) {
  const previous = tabContexts.get(tabId);
  if (!previous) return;
  pageTokenSource.clearContext(previous);
  if (previous.sessionFingerprint) memberCommandHandler.clearSession(previous.sessionFingerprint);
  if (previous.shopId) memberCommandHandler.clearShop(previous.shopId);
  tabContexts.delete(tabId);
  tabActionIntents.delete(tabId);
  observedWdTokens.delete(tabId);
}

async function fingerprintChromeSession(context) {
  let url;
  try {
    url = new URL(context.pageUrl);
  } catch {
    throw memberCommandError('TARGET_PAGE_MISMATCH', 'Member 페이지 URL을 해석할 수 없습니다.');
  }
  if (url.origin !== context.origin || !/(^|\.)weidian\.com$/i.test(url.hostname)) {
    throw memberCommandError('TARGET_PAGE_MISMATCH', '현재 Weidian 페이지 origin과 컨텍스트가 일치하지 않습니다.');
  }
  const cookies = await chrome.cookies.getAll({ url: context.pageUrl });
  if (!cookies.length) {
    throw memberCommandError('SESSION_MISSING', '로그인된 Chrome Weidian 세션을 확인하지 못했습니다.');
  }
  const ephemeralCookieMaterial = cookies
    .slice()
    .sort((left, right) =>
      `${left.domain}:${left.path}:${left.name}`.localeCompare(`${right.domain}:${right.path}:${right.name}`)
    )
    .map((cookie) => `${cookie.domain}\t${cookie.path}\t${cookie.name}\t${cookie.value}`)
    .join('\n');
  const input = new TextEncoder().encode(
    `${context.origin}\n${context.sessionFingerprint || ''}\n${ephemeralCookieMaterial}`
  );
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function memberCommandError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function sanitizeErrorMessage(message) {
  return String(message)
    .replace(
      /\b(actionToken|wdtoken|accessToken|refreshToken|qrCodeStatusKey|authorization|cookie|sessionId|session|token|ct)\b\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]'
    )
    .slice(0, 400);
}

async function discoverMemberLevels(shopId) {
  if (
    latestSellerMemberLevels &&
    Date.now() - latestSellerMemberLevels.observedAtEpochMs < 10 * 60_000
  ) {
    return latestSellerMemberLevels.memberLevels;
  }
  const cached = memberLevelCache.get(shopId);
  if (cached && Date.now() - cached.savedAt < 10 * 60_000) return cached.memberLevels;
  if (memberLevelJobs.has(shopId)) return memberLevelJobs.get(shopId);
  const job = (async () => {
    let tab;
    try {
      const url =
        `https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=${encodeURIComponent(shopId)}` +
        '&ew_discovery=1';
      tab = await chrome.tabs.create({ url, active: false });
      const memberLevels = await collectMemberLevelsFromTab(tab.id);
      if (memberLevels.length > 0) memberLevelCache.set(shopId, { savedAt: Date.now(), memberLevels });
      return memberLevels;
    } finally {
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
      memberLevelJobs.delete(shopId);
    }
  })();
  memberLevelJobs.set(shopId, job);
  return job;
}

function normalizeSellerMemberLevels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const id = String(item.id || '').trim();
    const label = String(item.label || '').trim().slice(0, 80);
    if (!id || !label || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    const rankValue = Number(item.rank);
    return [{
      id,
      label,
      rank: Number.isInteger(rankValue) && rankValue > 0 ? rankValue : index + 1,
      rawText: 'Weidian seller member catalog'
    }];
  }).slice(0, 30);
}

async function collectMemberLevelsFromTab(tabId) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(attempt === 0 ? 800 : 500);
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'EW_COLLECT_MEMBER_LEVELS' });
      const levels = Array.isArray(result?.memberLevels) ? result.memberLevels : [];
      if (levels.length > 0) return levels;
    } catch {
      // The page or content script is still loading.
    }
  }
  return [];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePathPart(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'images';
}

function fileNameFromUrl(value) {
  try {
    const name = new URL(value).pathname.split('/').pop() || 'image.jpg';
    return sanitizePathPart(decodeURIComponent(name)).replace(/_+$/g, '') || 'image.jpg';
  } catch {
    return 'image.jpg';
  }
}

chrome.alarms.create('ew-weidian-heartbeat', { delayInMinutes: 0, periodInMinutes: 0.5 });
