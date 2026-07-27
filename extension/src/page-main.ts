// @ts-nocheck
import { detectActionTokens } from './member/action-token-detector';

(() => {
  let lastObservedMemberState = null;
  installMemberApiContractObserver();

  const REQUEST_TYPES = new Set([
    'EW_MEMBER_SYNC',
    'EW_MEMBER_TOKEN_REFRESH',
    'EW_MEMBER_TOKEN_SCAN',
    'EW_MEMBER_TOKEN_STATUS',
    'EW_MEMBER_SAVE',
    'EW_MEMBER_RESET'
  ]);

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (
      message?.source === 'EW_WEIDIAN_CONTENT' &&
      message.type === 'EW_EXECUTE_MEMBER_PAGE_REQUEST' &&
      message.requestId
    ) {
      try {
        const payload = await executeMemberPageRequest(message.request);
        window.postMessage({
          source: 'EW_WEIDIAN_PAGE_MAIN',
          type: 'EW_MEMBER_PAGE_REQUEST_RESULT',
          requestId: message.requestId,
          ok: true,
          payload
        }, location.origin);
      } catch (error) {
        window.postMessage({
          source: 'EW_WEIDIAN_PAGE_MAIN',
          type: 'EW_MEMBER_PAGE_REQUEST_RESULT',
          requestId: message.requestId,
          ok: false,
          errorCode: error?.code || 'NETWORK_ERROR',
          errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error))
        }, location.origin);
      }
      return;
    }
    if (message?.source !== 'EW_WEIDIAN_CONTENT' || !REQUEST_TYPES.has(message.type) || !message.requestId) return;
    try {
      if (message.type === 'EW_MEMBER_TOKEN_REFRESH' || message.type === 'EW_MEMBER_TOKEN_SCAN') {
        scanBootstrapActionTokens();
      }
      const observed = await collectMemberContext();
      window.postMessage({
        source: 'EW_WEIDIAN_PAGE_MAIN',
        type: 'EW_MEMBER_RESULT',
        requestId: message.requestId,
        observed
      }, location.origin);
    } catch (error) {
      window.postMessage({
        source: 'EW_WEIDIAN_PAGE_MAIN',
        type: 'EW_MEMBER_ERROR',
        requestId: message.requestId,
        errorCode: error?.code || 'UNKNOWN_MEMBER_ERROR',
        errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error))
      }, location.origin);
    }
  });

  async function executeMemberPageRequest(request) {
    const url = new URL(String(request?.url || ''));
    if (
      request?.method !== 'GET' ||
      url.protocol !== 'https:' ||
      url.hostname !== 'thor.weidian.com' ||
      ![
        '/wdcrm/trade.setMemberLevel/2.0',
        '/wdcrm/customer.summary.pc/1.0'
      ].includes(url.pathname) ||
      !url.searchParams.get('wdtoken') ||
      !url.searchParams.get('param')
    ) {
      throw codedError('MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED', '허용되지 않은 Member 요청입니다.');
    }
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw codedError('SERVER_RESPONSE_INVALID', 'Weidian API가 JSON을 반환하지 않았습니다.');
    }
    if (!response.ok) {
      throw codedError(
        response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : 'NETWORK_ERROR',
        payload?.status?.message || `HTTP ${response.status}`
      );
    }
    return payload;
  }

  async function collectMemberContext() {
    const url = new URL(location.href);
    if (
      url.protocol !== 'https:' ||
      !/(^|\.)weidian\.com$/i.test(url.hostname) ||
      !/mkt-h5-member-detail/i.test(url.pathname)
    ) {
      throw codedError('TARGET_PAGE_MISMATCH', '현재 페이지가 Weidian Member 상세 페이지가 아닙니다.');
    }
    const bodyText = String(document.body?.innerText || document.body?.textContent || '').slice(0, 100_000);
    const shopId =
      url.searchParams.get('shopId') ||
      url.searchParams.get('shopid') ||
      bodyText.match(/(?:shop|店铺|상점)\s*(?:ID)?\s*[:：]?\s*(\d{6,20})/i)?.[1];
    if (!shopId) throw codedError('SHOP_ID_MISSING');
    const observedState =
      lastObservedMemberState?.shopId === String(shopId)
        ? lastObservedMemberState
        : null;
    const gradeNames = observedState?.gradeNames?.length
      ? [...observedState.gradeNames]
      : detectGradeNames(bodyText);
    if (!gradeNames.length) throw codedError('GRADE_NAMES_INVALID', 'Member 등급 목록을 감지하지 못했습니다.');
    const serverIndex = Number.isInteger(observedState?.serverIndex)
      ? observedState.serverIndex
      : detectServerIndex(bodyText, gradeNames);
    if (serverIndex < 0 || serverIndex >= gradeNames.length) throw codedError('SERVER_INDEX_INVALID');
    const name = observedState?.name || gradeNames[serverIndex];
    const remaining = observedState?.remaining ??
      detectNumber(bodyText, /(?:再消费|还需消费|升级还需|다음 등급까지|remaining|next level)[^0-9]{0,20}([0-9][0-9,.]*)/i);
    const originalProgress = observedState?.originalProgress ??
      detectNumber(bodyText, /(?:成长值|进度|progress|진행률)[^0-9]{0,20}([0-9]{1,3}(?:\.[0-9]+)?)\s*%?/i);
    const sessionFingerprint = await fingerprintSession([
      location.origin,
      document.cookie,
      document.querySelector('meta[name="user-id"]')?.content || '',
      document.querySelector('[data-user-id]')?.getAttribute('data-user-id') || '',
      document.querySelector('[class*="user-name"], [class*="nickname"]')?.textContent || ''
    ].join('|'));
    if (!sessionFingerprint) throw codedError('SESSION_FINGERPRINT_FAILED');
    return {
      context: {
        origin: location.origin,
        pageUrl: location.href,
        shopId: String(shopId),
        sessionFingerprint,
        currentServerIndex: serverIndex,
        gradeCount: gradeNames.length,
        gradeNames,
        currentName: name,
        remaining,
        originalProgress,
        stateSource: observedState?.stateSource || 'weidian-page'
      },
      name,
      remaining,
      originalProgress
    };
  }

  function detectGradeNames(bodyText) {
    const candidates = [];
    for (const element of document.querySelectorAll(
      '[class*="vip" i], [class*="member" i], [class*="grade" i], [class*="level" i], [class*="rank" i]'
    )) {
      const text = normalize(element.textContent);
      const label = memberLabel(text);
      if (label) candidates.push(label);
    }
    for (const match of bodyText.matchAll(/\b(?:VIP|LV|V)\s*([0-9]{1,2})\b/gi)) {
      candidates.push(`VIP${Number(match[1])}`);
    }
    const named = [
      '普通会员', '白银会员', '黄金会员', '铂金会员', '钻石会员', '黑卡会员', '至尊会员',
      '일반회원', '실버회원', '골드회원', '플래티넘회원', '다이아회원', '블랙회원'
    ];
    for (const label of named) if (bodyText.includes(label)) candidates.push(label);
    const unique = [...new Set(candidates.map(normalize).filter(Boolean))];
    return unique.sort((left, right) => rankOf(left) - rankOf(right)).slice(0, 30);
  }

  function detectServerIndex(bodyText, gradeNames) {
    const activeSelectors = [
      '[aria-current="true"]',
      '[class*="active" i]',
      '[class*="current" i]',
      '[class*="selected" i]'
    ];
    for (const element of document.querySelectorAll(activeSelectors.join(','))) {
      const label = memberLabel(normalize(element.textContent));
      const index = gradeNames.findIndex((name) => name.toLowerCase() === String(label || '').toLowerCase());
      if (index >= 0) return index;
    }
    const currentText = bodyText.match(
      /(?:当前等级|当前会员|會員等級|회원등급|current level)[^A-Za-z0-9\u4e00-\u9fff가-힣]{0,12}([A-Za-z0-9\u4e00-\u9fff가-힣 ]{2,30})/i
    )?.[1];
    const currentLabel = memberLabel(normalize(currentText));
    const detected = gradeNames.findIndex((name) => name.toLowerCase() === String(currentLabel || '').toLowerCase());
    return detected >= 0 ? detected : 0;
  }

  function memberLabel(text) {
    const numbered = text.match(/\b(?:VIP|LV|V)\s*([0-9]{1,2})\b/i);
    if (numbered) return `VIP${Number(numbered[1])}`;
    const named = text.match(/([\u4e00-\u9fff가-힣]{1,10}(?:会员|會員|卡|회원))/);
    return named?.[1];
  }

  function rankOf(label) {
    const rank = label.match(/([0-9]{1,2})/)?.[1];
    return rank ? Number(rank) : 100;
  }

  function detectNumber(text, pattern) {
    const value = Number(text.match(pattern)?.[1]?.replace(/,/g, ''));
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  async function fingerprintSession(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
      .slice(0, 12)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function codedError(code, message = code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function sanitizeMessage(message) {
    return String(message)
      .replace(/\b(actionToken|wdtoken|token|cookie|authorization|ct|session)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
      .slice(0, 400);
  }

  function installMemberApiContractObserver() {
    if (
      window.__EW_MEMBER_API_CONTRACT_OBSERVER__ ||
      location.protocol !== 'https:' ||
      !/(^|\.)weidian\.com$/i.test(location.hostname) ||
      !/(?:mkt-h5-member-detail|decoration\/uni-mine|pc-vue-customer|mkt-pc-member|weidian-loader)/i.test(
        `${location.pathname}${location.hash}`
      )
    ) {
      return;
    }
    window.__EW_MEMBER_API_CONTRACT_OBSERVER__ = true;
    let observationCount = 0;
    const maxObservations = 120;
    const nativeFetch = window.fetch;
    const nativeXhrOpen = XMLHttpRequest.prototype.open;
    const nativeXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const nativeXhrSend = XMLHttpRequest.prototype.send;
    const xhrContracts = new WeakMap();

    window.fetch = async function observedFetch(input, init) {
      const request = describeFetchRequest(input, init);
      let response;
      try {
        response = await nativeFetch.apply(this, arguments);
      } catch (error) {
        emitContract({
          transport: 'fetch',
          ...request,
          outcome: 'network-error',
          errorName: error instanceof Error ? error.name : 'Error'
        });
        throw error;
      }
      void describeFetchResponse(response, request.url)
        .then((responseContract) => emitContract({
          transport: 'fetch',
          ...request,
          ...responseContract
        }))
        .catch(() => emitContract({
          transport: 'fetch',
          ...request,
          status: response.status,
          outcome: response.ok ? 'ok' : 'http-error'
        }));
      return response;
    };

    XMLHttpRequest.prototype.open = function observedOpen(method, url) {
      xhrContracts.set(this, {
        method: String(method || 'GET').toUpperCase(),
        ...describeUrl(url),
        requestHeaderNames: [],
        requestHeaders: {}
      });
      return nativeXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function observedSetRequestHeader(name, value) {
      const request = xhrContracts.get(this);
      if (request) {
        const normalizedName = String(name || '').toLowerCase();
        request.requestHeaderNames = [
          ...new Set([...(request.requestHeaderNames || []), normalizedName])
        ].sort();
        request.requestHeaders[normalizedName] = String(value || '');
      }
      return nativeXhrSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function observedSend(body) {
      const request = xhrContracts.get(this) || {
        method: 'GET',
        url: 'unknown',
        queryKeys: [],
        requestHeaderNames: []
      };
      const { requestHeaders: rawRequestHeaders, ...safeRequest } = request;
      const requestBodyShape = describeBody(body);
      const requestHeaderNames = request.requestHeaderNames || [];
      emitRequestTokenCandidates(request.url, rawRequestHeaders, body);
      this.addEventListener('loadend', () => {
        let responseBodyShape;
        let responseValue;
        try {
          responseValue = this.responseType === 'json'
            ? this.response
            : JSON.parse(String(this.responseText || ''));
          responseBodyShape = shapeOf(responseValue);
        } catch {
          responseBodyShape = undefined;
        }
        if (responseValue !== undefined) {
          observeMemberState(request.url, responseValue);
          observeSellerMemberCatalog(request.url, responseValue);
          emitDetectedTokens(
            detectActionTokens(responseValue, {
              placement: 'response',
              url: request.url
            })
          );
        }
        emitContract({
          transport: 'xhr',
          ...safeRequest,
          requestBodyShape,
          requestHeaderNames,
          tokenPlacement: detectTokenPlacement(
            request.queryKeys,
            requestHeaderNames,
            requestBodyShape,
            request.queryShape
          ),
          credentials: this.withCredentials ? 'include' : 'same-origin',
          status: this.status,
          outcome: this.status >= 200 && this.status < 400 ? 'ok' : 'http-error',
          responseContentType: safeContentType(this.getResponseHeader('content-type')),
          responseHeaderNames: headerNamesFromXhr(this),
          responseBodyShape
        });
      }, { once: true });
      return nativeXhrSend.apply(this, arguments);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scanBootstrapActionTokens, { once: true });
    } else {
      scanBootstrapActionTokens();
    }

    function emitContract(contract) {
      if (observationCount >= maxObservations) return;
      observationCount += 1;
      const sanitized = {
        observerVersion: 1,
        observedAtIso: new Date().toISOString(),
        page: `${location.origin}${location.pathname}`,
        ...contract
      };
      console.info(`[EW_MEMBER_API_CONTRACT] ${JSON.stringify(sanitized)}`);
      window.postMessage({
        source: 'EW_WEIDIAN_PAGE_MAIN',
        type: 'EW_MEMBER_API_CONTRACT',
        observation: sanitized
      }, location.origin);
    }
  }

  const emittedTokenCandidates = new Set();

  function emitRequestTokenCandidates(rawUrl, headers, body) {
    try {
      const url = new URL(String(rawUrl || ''), location.href);
      emitDetectedTokens(
        detectActionTokens(Object.fromEntries(url.searchParams.entries()), {
          placement: 'query',
          url: url.href
        })
      );
    } catch {
      // Invalid URLs are already represented in the contract observer.
    }
    emitDetectedTokens(
      detectActionTokens(headers || {}, {
        placement: 'header',
        url: String(rawUrl || '')
      })
    );
    emitDetectedTokens(
      detectActionTokens(body, {
        placement: 'body',
        url: String(rawUrl || '')
      })
    );
  }

  function emitDetectedTokens(candidates) {
    for (const candidate of candidates || []) {
      const dedupeKey = `${candidate.source}:${candidate.rawToken}`;
      if (emittedTokenCandidates.has(dedupeKey)) continue;
      emittedTokenCandidates.add(dedupeKey);
      void collectTokenContext()
        .then((context) => {
          window.postMessage({
            source: 'EW_WEIDIAN_PAGE_MAIN',
            type: 'EW_MEMBER_ACTION_TOKEN_DETECTED',
            context,
            detection: candidate
          }, location.origin);
        })
        .catch(() => {});
    }
  }

  function scanBootstrapActionTokens() {
    for (const script of document.querySelectorAll(
      'script[type="application/json"], script#__NEXT_DATA__, script[data-state], script[data-hydration]'
    )) {
      const text = String(script.textContent || '');
      if (!text || text.length > 1_000_000) continue;
      emitDetectedTokens(
        detectActionTokens(text, {
          placement: 'bootstrap',
          url: location.href
        })
      );
    }
    for (const value of [
      window.__NEXT_DATA__,
      window.__INITIAL_STATE__,
      window.__PRELOADED_STATE__,
      window.__NUXT__
    ]) {
      if (value === undefined) continue;
      emitDetectedTokens(
        detectActionTokens(value, {
          placement: 'bootstrap',
          url: location.href
        })
      );
    }
  }

  async function collectTokenContext() {
    const url = new URL(location.href);
    const bodyText = String(document.body?.innerText || document.body?.textContent || '').slice(0, 100_000);
    const shopId =
      url.searchParams.get('shopId') ||
      url.searchParams.get('shopid') ||
      bodyText.match(/(?:shop|店铺|상점)\s*(?:ID)?\s*[:：]?\s*(\d{6,20})/i)?.[1];
    if (!shopId) throw codedError('SHOP_ID_MISSING');
    const sessionFingerprint = await fingerprintSession([
      location.origin,
      document.cookie,
      document.querySelector('meta[name="user-id"]')?.content || '',
      document.querySelector('[data-user-id]')?.getAttribute('data-user-id') || '',
      document.querySelector('[class*="user-name"], [class*="nickname"]')?.textContent || ''
    ].join('|'));
    return {
      origin: location.origin,
      pageUrl: location.href,
      shopId: String(shopId),
      sessionFingerprint
    };
  }

  function observeMemberState(requestUrl, payload) {
    let url;
    try {
      url = new URL(String(requestUrl || ''), location.href);
    } catch {
      return;
    }
    if (!/shopmember\.buyer\.memberIdentityCenter\/1\.0/i.test(url.pathname)) return;
    const result = unwrapMemberResult(payload);
    if (!result || typeof result !== 'object') return;
    const shopId =
      new URL(location.href).searchParams.get('shopId') ||
      new URL(location.href).searchParams.get('shopid');
    if (!shopId) return;
    const levels = Array.isArray(result.memberLevelList) ? result.memberLevelList : [];
    const indexedLevels = levels
      .map((level, index) => {
        const detectedIndex = Number(
          level?.memberLevel ??
          level?.level ??
          level?.serverIndex
        );
        return {
          index:
            Number.isInteger(detectedIndex) && detectedIndex >= 0
              ? detectedIndex
              : index + 1,
          label: normalize(
            level?.levelName ||
            level?.memberLevelName ||
            level?.name ||
            level?.cardName ||
            `VIP${index + 1}`
          )
        };
      })
      .filter((level) => level.label && level.index < 30);
    if (!indexedLevels.length) return;
    const rawServerIndex = Number(result.level);
    const detectedServerIndex =
      Number.isInteger(rawServerIndex) && rawServerIndex >= 0
        ? rawServerIndex
        : 0;
    const maxIndex = Math.min(
      29,
      Math.max(detectedServerIndex, ...indexedLevels.map((level) => level.index))
    );
    const gradeNames = Array.from({ length: maxIndex + 1 }, (_, index) => `等级${index}`);
    for (const level of indexedLevels) gradeNames[level.index] = level.label;
    if (!indexedLevels.some((level) => level.index === 0)) {
      gradeNames[0] =
        normalize(result.levelName || result.currentLevel?.levelName || result.mainTitleText) ||
        '待升级';
    }
    const serverIndex = Math.min(maxIndex, detectedServerIndex);
    const growthNum = finiteNonNegative(result.growthNum);
    const needGrowthNum = finiteNonNegative(result.needGrowthNum);
    const remaining =
      needGrowthNum ??
      detectNumber(
        String(result.showGrowthMsg || ''),
        /([0-9][0-9,.]*)/
      );
    const explicitProgress = finiteNonNegative(result.upgradeProcess);
    const originalProgress =
      explicitProgress ??
      (
        growthNum !== undefined &&
        remaining !== undefined &&
        growthNum + remaining > 0
          ? Math.round((growthNum / (growthNum + remaining)) * 10_000) / 100
          : 0
      );
    lastObservedMemberState = {
      shopId: String(shopId),
      serverIndex,
      gradeNames,
      name:
        normalize(result.memberInfo?.levelName || result.levelName || result.currentLevel?.levelName) ||
        gradeNames[serverIndex],
      remaining: remaining ?? 0,
      originalProgress,
      stateSource: 'weidian-network'
    };
  }

  function observeSellerMemberCatalog(requestUrl, payload) {
    let url;
    try {
      url = new URL(String(requestUrl || ''), location.href);
    } catch {
      return;
    }
    if (!/\/wdcrm\/trade\.searchMemberByShopId\/1\.0$/i.test(url.pathname)) return;
    const datas = payload?.result?.datas || payload?.data?.result?.datas;
    if (!Array.isArray(datas)) return;
    const seen = new Set();
    const memberLevels = datas.flatMap((item, index) => {
      const id = String(item?.level ?? '').trim();
      const label = normalize(item?.name || item?.levelName || item?.memberName);
      if (
        !id ||
        !label ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
        seen.has(id)
      ) {
        return [];
      }
      seen.add(id);
      return [{
        id,
        label,
        rank: index + 1
      }];
    }).slice(0, 30);
    if (!memberLevels.length) return;
    window.postMessage({
      source: 'EW_WEIDIAN_PAGE_MAIN',
      type: 'EW_SELLER_MEMBER_CATALOG',
      memberLevels
    }, location.origin);
  }

  function unwrapMemberResult(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    if (payload.result && typeof payload.result === 'object') return payload.result;
    if (payload.data?.result && typeof payload.data.result === 'object') return payload.data.result;
    if (payload.data && typeof payload.data === 'object') return payload.data;
    return payload;
  }

  function finiteNonNegative(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : undefined;
  }

  function describeFetchRequest(input, init) {
    const requestUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;
    const describedUrl = describeUrl(requestUrl);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const headers = new Headers(input?.headers || {});
    new Headers(init?.headers || {}).forEach((value, key) => headers.set(key, value));
    const requestHeaderNames = [...headers.keys()].map((key) => key.toLowerCase()).sort();
    const requestBodyShape = describeBody(init?.body);
    emitRequestTokenCandidates(
      String(requestUrl || ''),
      Object.fromEntries(headers.entries()),
      init?.body
    );
    return {
      method,
      ...describedUrl,
      credentials: String(init?.credentials || input?.credentials || 'same-origin'),
      requestHeaderNames,
      requestBodyShape,
      tokenPlacement: detectTokenPlacement(
        describedUrl.queryKeys,
        requestHeaderNames,
        requestBodyShape,
        describedUrl.queryShape
      )
    };
  }

  async function describeFetchResponse(response, requestUrl) {
    const responseHeaderNames = [...response.headers.keys()].map((key) => key.toLowerCase()).sort();
    const contentType = safeContentType(response.headers.get('content-type'));
    let responseBodyShape;
    let responseValue;
    if (/json|text|javascript/i.test(contentType)) {
      const clone = response.clone();
      const text = (await clone.text()).slice(0, 1_000_000);
      try {
        responseValue = JSON.parse(text);
        responseBodyShape = shapeOf(responseValue);
      } catch {
        responseBodyShape = text ? 'text' : 'empty';
      }
    }
    if (responseValue !== undefined) {
      observeMemberState(requestUrl, responseValue);
      observeSellerMemberCatalog(requestUrl, responseValue);
      emitDetectedTokens(
        detectActionTokens(responseValue, {
          placement: 'response',
          url: requestUrl
        })
      );
    }
    return {
      status: response.status,
      outcome: response.ok ? 'ok' : 'http-error',
      responseContentType: contentType,
      responseHeaderNames,
      responseBodyShape
    };
  }

  function describeUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      const queryShape = describeSearchParams(url.searchParams);
      return {
        url: `${url.origin}${url.pathname}`,
        queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
        queryShape
      };
    } catch {
      return { url: 'invalid', queryKeys: [], queryShape: undefined };
    }
  }

  function describeSearchParams(params) {
    const keys = [...new Set([...params.keys()])].sort();
    if (!keys.length) return undefined;
    return Object.fromEntries(keys.map((key) => {
      const values = params.getAll(key);
      const shape = values.length > 1
        ? [describeEncodedValue(values[0])]
        : describeEncodedValue(values[0]);
      return [key, shape];
    }));
  }

  function describeEncodedValue(value) {
    const text = String(value || '');
    try {
      return shapeOf(JSON.parse(text));
    } catch {
      return 'string';
    }
  }

  function describeBody(body) {
    if (body === undefined || body === null) return undefined;
    if (body instanceof URLSearchParams) {
      return describeSearchParams(body);
    }
    if (body instanceof FormData) {
      const result = {};
      for (const [key, value] of body.entries()) {
        result[key] = typeof value === 'string' ? describeEncodedValue(value) : 'file';
      }
      return result;
    }
    if (typeof body === 'string') {
      try {
        return shapeOf(JSON.parse(body));
      } catch {
        try {
          const params = new URLSearchParams(body);
          if ([...params.keys()].length) {
            return describeSearchParams(params);
          }
        } catch {
          // Keep only the primitive type.
        }
        return 'string';
      }
    }
    if (body instanceof Blob) return `blob:${safeContentType(body.type)}`;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return 'binary';
    return shapeOf(body);
  }

  function shapeOf(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return depth >= 3 ? 'array' : [value.length ? shapeOf(value[0], depth + 1) : 'empty'];
    if (typeof value !== 'object') return typeof value;
    if (depth >= 3) return 'object';
    const result = {};
    for (const key of Object.keys(value).slice(0, 80).sort()) {
      result[key] = shapeOf(value[key], depth + 1);
    }
    return result;
  }

  function detectTokenPlacement(queryKeys, headerNames, bodyShape, queryShape) {
    const isActionTokenKey = (key) => /^(?:(?:x-)?action[-_]?token|wdtoken)$/i.test(String(key));
    if (queryKeys.some(isActionTokenKey)) return 'query';
    if (containsShapeKey(queryShape, isActionTokenKey)) return 'query';
    if (headerNames.some(isActionTokenKey)) return 'header';
    if (containsShapeKey(bodyShape, isActionTokenKey)) return 'body';
    return 'not-observed';
  }

  function containsShapeKey(value, predicate) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((item) => containsShapeKey(item, predicate));
    return Object.entries(value).some(([key, child]) => predicate(key) || containsShapeKey(child, predicate));
  }

  function safeContentType(value) {
    return String(value || '').split(';')[0].trim().toLowerCase().slice(0, 100);
  }

  function headerNamesFromXhr(xhr) {
    try {
      return String(xhr.getAllResponseHeaders() || '')
        .split(/\r?\n/)
        .map((line) => line.split(':')[0].trim().toLowerCase())
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }
})();
