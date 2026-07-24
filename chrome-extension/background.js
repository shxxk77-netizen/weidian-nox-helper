"use strict";
(() => {
  // extension/src/member/member-errors.ts
  var MemberActionError = class extends Error {
    constructor(code, message = code, requestStarted = false) {
      super(message);
      this.code = code;
      this.requestStarted = requestStarted;
      this.name = "MemberActionError";
    }
  };
  function toMemberActionError(error) {
    if (error instanceof MemberActionError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new MemberActionError("UNKNOWN_MEMBER_ERROR", sanitizeMemberErrorMessage(message));
  }
  function sanitizeMemberErrorMessage(message) {
    return String(message).replace(
      /\b(actionToken|accessToken|refreshToken|qrCodeStatusKey|authorization|cookie|sessionId|session|token|ct)\b\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]"
    ).slice(0, 400);
  }
  function errorCodeToTokenStatus(code) {
    if (code === "ACTION_TOKEN_EXPIRED") return "expired";
    if (code === "ACTION_TOKEN_INVALID" || code === "ACTION_TOKEN_ALREADY_USED") return "invalid";
    if (code === "ACTION_TOKEN_CONTEXT_MISMATCH" || code === "SESSION_CHANGED") return "session-mismatch";
    if (code === "SHOP_ID_MISMATCH") return "shop-mismatch";
    if (code === "PERMISSION_DENIED") return "permission-denied";
    if (code === "ACTION_TOKEN_NOT_FOUND" || code === "ACTION_TOKEN_MISSING") return "not-found";
    if (code === "ACTION_TOKEN_SOURCE_NOT_CONFIGURED") return "source-not-configured";
    if (code === "MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED") return "write-endpoint-not-configured";
    return "error";
  }

  // extension/src/member/action-token-manager.ts
  var InMemoryActionTokenManager = class {
    constructor(acquireToken, now = Date.now, onStatusChange) {
      this.acquireToken = acquireToken;
      this.now = now;
      this.onStatusChange = onStatusChange;
    }
    tokens = /* @__PURE__ */ new Map();
    statusOverrides = /* @__PURE__ */ new Map();
    acquiring = /* @__PURE__ */ new Map();
    getStatus(context, action) {
      const key = this.tokenKey(context, action);
      const override = this.statusOverrides.get(key);
      if (override) {
        return { ...override };
      }
      const token = this.tokens.get(key);
      if (!token) {
        const mismatch = this.findContextMismatch(context, action);
        return mismatch || {
          status: "empty",
          shopId: context.shopId,
          action,
          oneTime: true
        };
      }
      if (token.expiresAtEpochMs !== void 0 && token.expiresAtEpochMs <= this.now()) {
        this.tokens.delete(key);
        const expired = this.meta(token, "expired", {
          lastErrorCode: "ACTION_TOKEN_EXPIRED",
          lastErrorMessage: "actionToken\uC774 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."
        });
        this.statusOverrides.set(key, expired);
        this.publish(context, expired);
        return { ...expired };
      }
      if (token.consumed) return this.meta(token, "consumed");
      if (token.consuming) return this.meta(token, "consuming");
      return this.meta(token, "ready");
    }
    async acquire(context, action) {
      this.assertContext(context);
      const key = this.tokenKey(context, action);
      if (this.acquiring.has(key)) {
        throw new MemberActionError("ACTION_TOKEN_ALREADY_ACQUIRING", "actionToken \uBC1C\uAE09\uC774 \uC774\uBBF8 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4.");
      }
      this.tokens.delete(key);
      const acquiringMeta = {
        status: "acquiring",
        shopId: context.shopId,
        action,
        oneTime: true
      };
      this.statusOverrides.set(key, acquiringMeta);
      this.publish(context, acquiringMeta);
      const job = this.acquireToken(context, action).then((acquired) => this.ingest(context, action, acquired)).catch((error) => {
        const caught = error instanceof MemberActionError ? error : new MemberActionError(
          "UNKNOWN_MEMBER_ERROR",
          sanitizeMemberErrorMessage(error instanceof Error ? error.message : String(error))
        );
        const failedMeta = {
          status: errorCodeToTokenStatus(caught.code),
          shopId: context.shopId,
          action,
          oneTime: true,
          lastErrorCode: caught.code,
          lastErrorMessage: caught.message
        };
        this.statusOverrides.set(key, failedMeta);
        this.publish(context, failedMeta);
        throw caught;
      }).finally(() => {
        this.acquiring.delete(key);
      });
      this.acquiring.set(key, job);
      return job;
    }
    async ingest(context, action, acquired) {
      this.assertContext(context);
      const rawToken = acquired.rawToken?.trim();
      if (!rawToken) {
        throw new MemberActionError("ACTION_TOKEN_MISSING", "\uAC10\uC9C0\uB41C actionToken\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.");
      }
      if (acquired.expiresAtEpochMs !== void 0 && acquired.expiresAtEpochMs <= this.now()) {
        throw new MemberActionError("ACTION_TOKEN_EXPIRED", "\uAC10\uC9C0\uB41C actionToken\uC774 \uC774\uBBF8 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      const key = this.tokenKey(context, action);
      const fingerprint = await fingerprintToken(rawToken);
      const existing = this.tokens.get(key);
      if (existing && existing.fingerprint === fingerprint && !existing.consumed && !existing.consuming) {
        return this.meta(existing, "ready");
      }
      const token = {
        rawToken,
        fingerprint,
        shopId: context.shopId,
        action,
        sessionFingerprint: context.sessionFingerprint,
        origin: context.origin,
        issuedAtEpochMs: acquired.issuedAtEpochMs,
        expiresAtEpochMs: acquired.expiresAtEpochMs,
        oneTime: acquired.oneTime,
        consumed: false,
        consuming: false,
        source: acquired.source
      };
      this.tokens.set(key, token);
      this.statusOverrides.delete(key);
      const readyMeta = this.meta(token, "ready");
      this.publish(context, readyMeta);
      return readyMeta;
    }
    async getOrAcquireRawToken(context, action) {
      const key = this.tokenKey(context, action);
      let token = this.tokens.get(key);
      if (token?.expiresAtEpochMs !== void 0 && token.expiresAtEpochMs <= this.now() + 5e3) {
        this.markExpired(context, action);
        token = void 0;
      }
      if (!token) {
        await this.acquire(context, action);
        token = this.tokens.get(key);
      }
      if (!token) {
        throw new MemberActionError("ACTION_TOKEN_MISSING");
      }
      if (token.consuming) {
        throw new MemberActionError("ACTION_TOKEN_ALREADY_CONSUMING");
      }
      if (token.consumed) {
        throw new MemberActionError("ACTION_TOKEN_ALREADY_CONSUMED");
      }
      return token.rawToken;
    }
    markConsuming(context, action) {
      const token = this.requireToken(context, action);
      if (token.consumed) throw new MemberActionError("ACTION_TOKEN_ALREADY_CONSUMED");
      if (token.consuming) throw new MemberActionError("ACTION_TOKEN_ALREADY_CONSUMING");
      token.consuming = true;
      this.statusOverrides.delete(this.tokenKey(context, action));
      this.publish(context, this.meta(token, "consuming"));
    }
    markConsumed(context, action) {
      const token = this.requireToken(context, action);
      token.consuming = false;
      token.consumed = true;
      token.consumedAtEpochMs = this.now();
      if (!token.oneTime) {
        token.consumed = false;
        token.consumedAtEpochMs = void 0;
      } else {
        token.rawToken = "";
      }
      this.publish(context, this.meta(token, token.consumed ? "consumed" : "ready"));
    }
    markExpired(context, action) {
      const key = this.tokenKey(context, action);
      const token = this.tokens.get(key);
      this.tokens.delete(key);
      const expiredMeta = token ? this.meta(token, "expired", {
        lastErrorCode: "ACTION_TOKEN_EXPIRED",
        lastErrorMessage: "actionToken\uC774 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."
      }) : {
        status: "expired",
        shopId: context.shopId,
        action,
        oneTime: true,
        lastErrorCode: "ACTION_TOKEN_EXPIRED",
        lastErrorMessage: "actionToken\uC774 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."
      };
      this.statusOverrides.set(key, expiredMeta);
      this.publish(context, expiredMeta);
    }
    invalidate(context, action, reason) {
      const key = this.tokenKey(context, action);
      const token = this.tokens.get(key);
      this.tokens.delete(key);
      const invalidMeta = token ? this.meta(token, "invalid", {
        lastErrorCode: "ACTION_TOKEN_INVALID",
        lastErrorMessage: sanitizeMemberErrorMessage(reason)
      }) : {
        status: "invalid",
        shopId: context.shopId,
        action,
        oneTime: true,
        lastErrorCode: "ACTION_TOKEN_INVALID",
        lastErrorMessage: sanitizeMemberErrorMessage(reason)
      };
      this.statusOverrides.set(key, invalidMeta);
      this.publish(context, invalidMeta);
    }
    setFailure(context, action, status, code, message) {
      const key = this.tokenKey(context, action);
      const token = this.tokens.get(key);
      this.tokens.delete(key);
      const failedMeta = {
        ...token ? this.meta(token, status) : {
          status,
          shopId: context.shopId,
          action,
          oneTime: true
        },
        lastErrorCode: code,
        lastErrorMessage: sanitizeMemberErrorMessage(message)
      };
      this.statusOverrides.set(key, failedMeta);
      this.publish(context, failedMeta);
    }
    clearShop(shopId) {
      this.deleteMatching((token) => token.shopId === shopId);
      this.deleteOverridesContaining(`:${shopId}:`);
    }
    clearSession(sessionFingerprint) {
      this.deleteMatching((token) => token.sessionFingerprint === sessionFingerprint);
      this.deleteOverridesStarting(`${sessionFingerprint}:`);
    }
    clearAll() {
      this.tokens.clear();
      this.statusOverrides.clear();
      this.acquiring.clear();
    }
    requireToken(context, action) {
      const token = this.tokens.get(this.tokenKey(context, action));
      if (!token) throw new MemberActionError("ACTION_TOKEN_MISSING");
      return token;
    }
    tokenKey(context, action) {
      return `${context.sessionFingerprint}:${context.origin}:${context.shopId}:${action}`;
    }
    assertContext(context) {
      if (!context.shopId) throw new MemberActionError("SHOP_ID_MISSING");
      if (!context.sessionFingerprint) throw new MemberActionError("SESSION_FINGERPRINT_FAILED");
      if (!context.origin) throw new MemberActionError("SESSION_MISSING");
    }
    publish(context, meta) {
      this.onStatusChange?.(context, { ...meta });
    }
    meta(token, status, extra = {}) {
      return {
        status,
        tokenFingerprint: token.fingerprint,
        shopId: token.shopId,
        action: token.action,
        issuedAtEpochMs: token.issuedAtEpochMs,
        expiresAtEpochMs: token.expiresAtEpochMs,
        consumedAtEpochMs: token.consumedAtEpochMs,
        oneTime: token.oneTime,
        source: token.source,
        ...extra
      };
    }
    findContextMismatch(context, action) {
      for (const token of this.tokens.values()) {
        if (token.action !== action || token.origin !== context.origin) continue;
        if (token.shopId === context.shopId && token.sessionFingerprint !== context.sessionFingerprint) {
          return this.meta(token, "session-mismatch", {
            lastErrorCode: "SESSION_CHANGED",
            lastErrorMessage: "\uB85C\uADF8\uC778 \uC138\uC158\uC774 \uBCC0\uACBD\uB418\uC5B4 \uAE30\uC874 actionToken\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
          });
        }
        if (token.sessionFingerprint === context.sessionFingerprint && token.shopId !== context.shopId) {
          return this.meta(token, "shop-mismatch", {
            lastErrorCode: "SHOP_ID_MISMATCH",
            lastErrorMessage: "\uB2E4\uB978 \uC0C1\uC810\uC5D0\uC11C \uBC1C\uAE09\uB41C actionToken\uC785\uB2C8\uB2E4."
          });
        }
      }
      return void 0;
    }
    deleteMatching(predicate) {
      for (const [key, token] of this.tokens) {
        if (predicate(token)) this.tokens.delete(key);
      }
    }
    deleteOverridesContaining(fragment) {
      for (const key of this.statusOverrides.keys()) {
        if (key.includes(fragment)) this.statusOverrides.delete(key);
      }
    }
    deleteOverridesStarting(prefix) {
      for (const key of this.statusOverrides.keys()) {
        if (key.startsWith(prefix)) this.statusOverrides.delete(key);
      }
    }
  };
  async function fingerprintToken(token) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].slice(0, 6).map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  // extension/src/member/member-action-adapter.ts
  var MEMBER_TOKEN_SOURCE = {
    mode: "endpoint",
    requestUrlPattern: "/api/member/action-token",
    requestMethod: "POST",
    tokenJsonPath: "actionToken",
    expiresAtJsonPath: "expiresAtEpochMs",
    credentials: "include",
    requestHeaders: {},
    tokenPlacement: {
      type: "body",
      key: "actionToken"
    },
    actionBinding: "per-action",
    oneTime: true
  };
  var DEFAULT_AUTHORIZED_MEMBER_CONFIG = {
    mode: "mock-localhost",
    baseUrl: "http://127.0.0.1:4173",
    tokenSource: MEMBER_TOKEN_SOURCE,
    stateSource: {
      mode: "endpoint",
      requestUrlPattern: "/api/member/context",
      requestMethod: "POST",
      credentials: "include",
      requestHeaders: {}
    },
    writeEndpoint: {
      status: "configured",
      saveUrlPattern: "/api/member/save",
      resetUrlPattern: "/api/member/reset",
      requestMethod: "POST",
      credentials: "include",
      contentType: "application/json",
      requestHeaders: {},
      tokenPlacement: {
        type: "body",
        key: "actionToken"
      },
      memberBinding: "current-session-user",
      shopIdField: "shopId",
      targetIndexField: "targetIndex"
    }
  };
  var LIVE_PAGE_MEMBER_CONFIG = {
    mode: "live-weidian",
    baseUrl: "",
    tokenSource: {
      mode: "page-observer",
      requestUrlPattern: "",
      requestMethod: "POST",
      tokenJsonPath: "",
      credentials: "include",
      requestHeaders: {},
      tokenPlacement: {
        type: "body",
        key: "actionToken"
      },
      actionBinding: "per-action",
      oneTime: true
    },
    stateSource: {
      mode: "page-context",
      requestUrlPattern: "__CONFIGURE_MEMBER_STATE_ENDPOINT__",
      requestMethod: "POST",
      credentials: "include",
      requestHeaders: {}
    },
    writeEndpoint: {
      status: "not-configured",
      saveUrlPattern: "__CONFIGURE_MEMBER_WRITE_ENDPOINT__",
      resetUrlPattern: "__CONFIGURE_MEMBER_RESET_ENDPOINT__",
      requestMethod: "POST",
      credentials: "include",
      contentType: "application/json",
      requestHeaders: {},
      tokenPlacement: {
        type: "body",
        key: "__CONFIGURE_ACTION_TOKEN_KEY__"
      },
      memberBinding: "explicit-member-id",
      memberIdField: "__CONFIGURE_MEMBER_ID_FIELD__",
      shopIdField: "__CONFIGURE_SHOP_ID_FIELD__",
      targetIndexField: "__CONFIGURE_TARGET_INDEX_FIELD__"
    }
  };
  var AuthorizedMemberActionAdapter = class {
    constructor(config = DEFAULT_AUTHORIZED_MEMBER_CONFIG, fetchImpl = fetch) {
      this.config = config;
      this.fetchImpl = fetchImpl;
    }
    async detectContext(input) {
      validateContext(input);
      return { ...input, gradeNames: [...input.gradeNames] };
    }
    getWriteConfigurationStatus() {
      try {
        this.assertWriteConfigured("save-vip-settings");
        return { status: "configured" };
      } catch (error) {
        const caught = error instanceof MemberActionError ? error : new MemberActionError("UNKNOWN_MEMBER_ERROR");
        return {
          status: caught.code === "MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED" ? "write-endpoint-not-configured" : caught.code === "PERMISSION_DENIED" ? "permission-denied" : "error",
          errorCode: caught.code,
          errorMessage: caught.message
        };
      }
    }
    validateWriteConfiguration(action) {
      this.assertWriteConfigured(action);
    }
    async acquireActionToken(context, action) {
      if (this.config.tokenSource.mode === "page-observer") {
        throw new MemberActionError(
          "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
          "\uD398\uC774\uC9C0 \uAD00\uCC30\uD615 actionToken source\uB294 Chrome \uD398\uC774\uC9C0 \uAD00\uCC30\uAE30\uB97C \uD1B5\uD574 \uD68D\uB4DD\uD574\uC57C \uD569\uB2C8\uB2E4."
        );
      }
      this.assertTokenConfigured();
      const payload = await this.requestJson(this.config.tokenSource.requestUrlPattern, {
        method: this.config.tokenSource.requestMethod,
        credentials: this.config.tokenSource.credentials,
        headers: this.config.tokenSource.requestHeaders,
        configurationError: "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
        body: {
          shopId: context.shopId,
          action,
          sessionFingerprint: context.sessionFingerprint
        }
      });
      const rawToken = readJsonPath(payload, this.config.tokenSource.tokenJsonPath);
      if (typeof rawToken !== "string" || !rawToken.trim()) {
        throw new MemberActionError("SERVER_RESPONSE_INVALID", "\uC2B9\uC778 \uC11C\uBC84 \uC751\uB2F5\uC5D0 actionToken\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", true);
      }
      const issuedAtEpochMs = finiteNumber(payload.issuedAtEpochMs) ?? Date.now();
      const expiresAtEpochMs = finiteNumber(readJsonPath(payload, this.config.tokenSource.expiresAtJsonPath)) ?? addExpiresIn(issuedAtEpochMs, readJsonPath(payload, this.config.tokenSource.expiresInJsonPath));
      return {
        rawToken,
        issuedAtEpochMs,
        expiresAtEpochMs,
        oneTime: payload.oneTime === void 0 ? this.config.tokenSource.oneTime : Boolean(payload.oneTime),
        source: "authorized-response"
      };
    }
    async syncVipGrades(context) {
      if (this.config.stateSource.mode === "page-context") {
        return {
          ...stateFromPageContext(context),
          writeAdapter: this.getWriteConfigurationStatus()
        };
      }
      this.assertStateConfigured();
      const payload = await this.requestJson(this.config.stateSource.requestUrlPattern, {
        method: this.config.stateSource.requestMethod,
        credentials: this.config.stateSource.credentials,
        headers: this.config.stateSource.requestHeaders,
        configurationError: "MEMBER_STATE_ENDPOINT_NOT_CONFIGURED",
        body: {
          shopId: context.shopId,
          sessionFingerprint: context.sessionFingerprint,
          pageUrl: context.pageUrl
        }
      });
      const gradeNames = Array.isArray(payload.gradeNames) ? payload.gradeNames.filter((name) => typeof name === "string" && Boolean(name.trim())).slice(0, 30) : [];
      const gradeCount = finiteInteger(payload.gradeCount);
      const serverIndex = finiteInteger(payload.serverIndex);
      if (gradeCount === void 0 || gradeCount < 1 || serverIndex === void 0 || serverIndex < 0 || serverIndex >= gradeCount || gradeNames.length !== gradeCount) {
        throw new MemberActionError("SERVER_RESPONSE_INVALID", "\uC2B9\uC778 \uC11C\uBC84\uC758 Member \uC0C1\uD0DC \uC751\uB2F5\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", true);
      }
      return {
        shopId: context.shopId,
        serverIndex,
        gradeCount,
        gradeNames,
        name: typeof payload.name === "string" ? payload.name.slice(0, 80) : gradeNames[serverIndex],
        remaining: finiteNumber(payload.remaining) ?? 0,
        originalProgress: finiteNumber(payload.originalProgress) ?? 0,
        syncedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
        readSource: "mock-endpoint",
        actionToken: {
          status: "empty",
          shopId: context.shopId,
          action: "save-vip-settings",
          oneTime: true
        },
        writeAdapter: this.getWriteConfigurationStatus()
      };
    }
    async saveVipSettings(context, rawActionToken, payload) {
      this.assertWriteConfigured("save-vip-settings");
      return this.mutate(this.config.writeEndpoint.saveUrlPattern, context, rawActionToken, payload);
    }
    async resetVipSettings(context, rawActionToken, payload) {
      this.assertWriteConfigured("reset-vip-settings");
      return this.mutate(this.config.writeEndpoint.resetUrlPattern, context, rawActionToken, payload);
    }
    async mutate(pathname, context, rawActionToken, payload) {
      const body = {
        [this.config.writeEndpoint.shopIdField]: payload.shopId,
        clientRequestId: payload.clientRequestId
      };
      if ("targetIndex" in payload) {
        body[this.config.writeEndpoint.targetIndexField] = payload.targetIndex;
        body.serverIndex = payload.serverIndex;
        body.gradeCount = payload.gradeCount;
        body.gradeNames = [...payload.gradeNames];
      }
      const headers = {};
      const query = new URLSearchParams();
      const placement = this.config.writeEndpoint.tokenPlacement;
      if (placement.type === "body") body[placement.key] = rawActionToken;
      if (placement.type === "header") headers[placement.key] = rawActionToken;
      if (placement.type === "query") query.set(placement.key, rawActionToken);
      const response = await this.requestJson(`${pathname}${query.size ? `?${query}` : ""}`, {
        method: this.config.writeEndpoint.requestMethod,
        credentials: this.config.writeEndpoint.credentials,
        body,
        headers: {
          ...this.config.writeEndpoint.requestHeaders,
          ...headers
        },
        contentType: this.config.writeEndpoint.contentType,
        configurationError: "MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED"
      });
      return {
        ok: response.ok === true,
        serverIndex: finiteInteger(response.serverIndex),
        errorCode: typeof response.errorCode === "string" ? response.errorCode : void 0,
        errorMessage: typeof response.errorMessage === "string" ? response.errorMessage.slice(0, 400) : void 0
      };
    }
    async requestJson(pathname, input) {
      const base = this.authorizedBaseUrl(input.configurationError);
      const url = new URL(pathname, base);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5e3);
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: input.method,
          cache: "no-store",
          credentials: input.credentials,
          signal: controller.signal,
          headers: {
            "content-type": input.contentType || "application/json",
            ...input.headers || {}
          },
          body: input.method === "GET" ? void 0 : JSON.stringify(input.body || {})
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new MemberActionError("NETWORK_TIMEOUT", "\uC2B9\uC778 Member \uC11C\uBC84 \uC694\uCCAD \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", true);
        }
        throw new MemberActionError("NETWORK_ERROR", "\uC2B9\uC778 Member \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", true);
      } finally {
        clearTimeout(timer);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new MemberActionError("SERVER_RESPONSE_INVALID", "\uC2B9\uC778 Member \uC11C\uBC84\uAC00 JSON\uC744 \uBC18\uD658\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.", true);
      }
      if (!response.ok || payload.ok === false) {
        const code = normalizeServerErrorCode(payload.errorCode, response.status);
        throw new MemberActionError(
          code,
          typeof payload.errorMessage === "string" ? payload.errorMessage.slice(0, 400) : code,
          true
        );
      }
      return payload;
    }
    assertTokenConfigured() {
      if (this.config.tokenSource.mode === "not-configured" || this.config.tokenSource.mode === "page-observer" || this.config.mode === "not-configured" || !this.config.baseUrl || this.config.tokenSource.requestUrlPattern.startsWith("__CONFIGURE_")) {
        throw new MemberActionError(
          "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
          "\uC2B9\uC778\uB41C actionToken source\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
        );
      }
      this.authorizedBaseUrl("ACTION_TOKEN_SOURCE_NOT_CONFIGURED");
    }
    assertStateConfigured() {
      if (this.config.stateSource.mode === "page-context") return;
      if (this.config.writeEndpoint.status === "not-configured" || this.config.mode === "not-configured" || !this.config.baseUrl || !this.config.stateSource.requestUrlPattern || this.config.stateSource.requestUrlPattern.startsWith("__CONFIGURE_")) {
        throw new MemberActionError(
          "MEMBER_STATE_ENDPOINT_NOT_CONFIGURED",
          "\uC800\uC7A5 \uACB0\uACFC\uB97C \uAC80\uC99D\uD560 \uC2B9\uC778 Member \uC870\uD68C endpoint\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
        );
      }
      this.authorizedBaseUrl("MEMBER_STATE_ENDPOINT_NOT_CONFIGURED");
    }
    assertWriteConfigured(action) {
      const endpoint = action === "save-vip-settings" ? this.config.writeEndpoint.saveUrlPattern : this.config.writeEndpoint.resetUrlPattern;
      const placementKey = this.config.writeEndpoint.tokenPlacement.key;
      if (this.config.mode === "not-configured" || !this.config.baseUrl || !endpoint || endpoint.startsWith("__CONFIGURE_") || !placementKey || placementKey.startsWith("__CONFIGURE_") || !this.config.writeEndpoint.shopIdField || this.config.writeEndpoint.shopIdField.startsWith("__CONFIGURE_") || !this.config.writeEndpoint.targetIndexField || this.config.writeEndpoint.targetIndexField.startsWith("__CONFIGURE_") || this.config.writeEndpoint.memberBinding === "explicit-member-id" && (!this.config.writeEndpoint.memberIdField || this.config.writeEndpoint.memberIdField.startsWith("__CONFIGURE_"))) {
        throw new MemberActionError(
          "MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED",
          "\uC2B9\uC778\uB41C Member \uC4F0\uAE30 endpoint\uC640 \uC694\uCCAD \uACC4\uC57D\uC774 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
        );
      }
      this.authorizedBaseUrl("MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED");
    }
    authorizedBaseUrl(configurationError) {
      let url;
      try {
        url = new URL(this.config.baseUrl);
      } catch {
        throw new MemberActionError(configurationError);
      }
      const mockAllowed = this.config.mode === "mock-localhost" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "4173";
      const liveAllowed = this.config.mode === "live-weidian" && url.protocol === "https:" && /(^|\.)weidian\.com$/i.test(url.hostname);
      if (!mockAllowed && !liveAllowed) {
        throw new MemberActionError(
          configurationError,
          "Member \uC5B4\uB311\uD130 \uC2E4\uD589\uD658\uACBD\uACFC endpoint origin\uC774 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
        );
      }
      return url;
    }
  };
  function stateFromPageContext(context) {
    validateContext(context);
    return {
      shopId: context.shopId,
      serverIndex: context.currentServerIndex,
      gradeCount: context.gradeCount,
      gradeNames: [...context.gradeNames],
      name: context.currentName || context.gradeNames[context.currentServerIndex],
      remaining: finiteNumber(context.remaining) ?? 0,
      originalProgress: finiteNumber(context.originalProgress) ?? 0,
      syncedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
      readSource: context.stateSource || "weidian-page",
      actionToken: {
        status: "empty",
        shopId: context.shopId,
        action: "save-vip-settings",
        oneTime: true
      },
      writeAdapter: {
        status: "write-endpoint-not-configured",
        errorCode: "MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED",
        errorMessage: "\uC2E4\uC81C Member \uC4F0\uAE30 endpoint\uC640 \uC694\uCCAD \uACC4\uC57D\uC774 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
      }
    };
  }
  function validateContext(context) {
    if (!context.shopId) throw new MemberActionError("SHOP_ID_MISSING");
    if (!context.sessionFingerprint) throw new MemberActionError("SESSION_FINGERPRINT_FAILED");
    if (!Number.isInteger(context.currentServerIndex)) throw new MemberActionError("SERVER_INDEX_INVALID");
    if (!Array.isArray(context.gradeNames)) throw new MemberActionError("GRADE_NAMES_INVALID");
    if (context.gradeNames.length !== context.gradeCount) throw new MemberActionError("GRADE_CATALOG_MISMATCH");
  }
  function readJsonPath(value, path) {
    if (!path || path.startsWith("__CONFIGURE_")) return void 0;
    return path.split(".").reduce((current, key) => {
      if (!current || typeof current !== "object") return void 0;
      return current[key];
    }, value);
  }
  function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : void 0;
  }
  function finiteInteger(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) ? numeric : void 0;
  }
  function addExpiresIn(issuedAtEpochMs, expiresIn) {
    const seconds = finiteNumber(expiresIn);
    return seconds === void 0 ? void 0 : issuedAtEpochMs + Math.max(0, seconds) * 1e3;
  }
  function normalizeServerErrorCode(value, status) {
    if (status === 401 || status === 403) return "PERMISSION_DENIED";
    const known = /* @__PURE__ */ new Set([
      "ACTION_TOKEN_EXPIRED",
      "ACTION_TOKEN_INVALID",
      "ACTION_TOKEN_ALREADY_USED",
      "SESSION_CHANGED",
      "SESSION_EXPIRED",
      "SHOP_ID_MISMATCH",
      "SERVER_INDEX_MISMATCH",
      "PERMISSION_DENIED",
      "SERVER_STATE_NOT_CHANGED"
    ]);
    return typeof value === "string" && known.has(value) ? value : "NETWORK_ERROR";
  }

  // extension/src/member/member-context.ts
  function validateMemberPageContext(context) {
    let pageUrl;
    try {
      pageUrl = new URL(context.pageUrl);
    } catch {
      throw new MemberActionError("TARGET_PAGE_MISMATCH");
    }
    if (pageUrl.protocol !== "https:" || !/(^|\.)weidian\.com$/i.test(pageUrl.hostname) || !/mkt-h5-member-detail/i.test(pageUrl.pathname)) {
      throw new MemberActionError("TARGET_PAGE_MISMATCH", "\uD604\uC7AC \uD398\uC774\uC9C0\uAC00 Weidian Member \uC0C1\uC138 \uD398\uC774\uC9C0\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
    }
    if (!context.shopId) throw new MemberActionError("SHOP_ID_MISSING");
    if (!context.sessionFingerprint) throw new MemberActionError("SESSION_FINGERPRINT_FAILED");
    if (!Number.isInteger(context.currentServerIndex)) throw new MemberActionError("SERVER_INDEX_INVALID");
    if (context.currentServerIndex < 0 || context.currentServerIndex >= context.gradeCount) {
      throw new MemberActionError("SERVER_INDEX_INVALID");
    }
    if (!Array.isArray(context.gradeNames)) throw new MemberActionError("GRADE_NAMES_INVALID");
    if (context.gradeNames.length !== context.gradeCount || context.gradeCount < 1) {
      throw new MemberActionError("GRADE_CATALOG_MISMATCH");
    }
    return {
      ...context,
      origin: pageUrl.origin,
      gradeNames: [...context.gradeNames],
      currentName: context.currentName?.trim().slice(0, 80) || context.gradeNames[context.currentServerIndex],
      remaining: finiteNonNegative(context.remaining),
      originalProgress: finiteNonNegative(context.originalProgress)
    };
  }
  function finiteNonNegative(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
  }

  // extension/src/member/member-command-handler.ts
  var MEMBER_COMMAND_TYPES = /* @__PURE__ */ new Set([
    "sync-vip-grades",
    "refresh-action-token",
    "get-action-token-status",
    "save-vip-settings",
    "reset-vip-settings"
  ]);
  var MemberCommandHandler = class {
    constructor(adapter, tokenManager, now = Date.now) {
      this.adapter = adapter;
      this.tokenManager = tokenManager;
      this.now = now;
    }
    locks = /* @__PURE__ */ new Set();
    processedRequestIds = /* @__PURE__ */ new Map();
    states = /* @__PURE__ */ new Map();
    async execute(command, rawContext) {
      const clientRequestId = optionalString(command.payload?.clientRequestId);
      try {
        if (!MEMBER_COMMAND_TYPES.has(command.type)) {
          throw new MemberActionError("UNKNOWN_MEMBER_ERROR", `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 Member \uBA85\uB839: ${command.type}`);
        }
        if (!clientRequestId) throw new MemberActionError("CLIENT_REQUEST_ID_MISSING");
        this.cleanupProcessed();
        if (clientRequestId && this.processedRequestIds.has(clientRequestId)) {
          throw new MemberActionError("DUPLICATE_CLIENT_REQUEST");
        }
        if (clientRequestId) this.processedRequestIds.set(clientRequestId, this.now());
        const context = validateMemberPageContext(await this.adapter.detectContext(rawContext));
        if (command.type === "sync-vip-grades") {
          return await this.withLock(context.shopId, "sync-vip-grades", async () => {
            validateSyncPayload(command.payload, context);
            return this.success(command, clientRequestId, await this.sync(context, false));
          });
        }
        if (command.type === "get-action-token-status") {
          const action = normalizeRequestedAction(command.payload?.action);
          const state = this.states.get(context.shopId);
          return this.success(command, clientRequestId, state, this.tokenManager.getStatus(context, action));
        }
        if (command.type === "refresh-action-token") {
          const action = normalizeRequestedAction(command.payload?.action);
          if (this.tokenManager.getStatus(context, action).status !== "empty") {
            this.tokenManager.invalidate(context, action, "\uC0AC\uC6A9\uC790\uAC00 actionToken \uC0C8\uB85C\uACE0\uCE68\uC744 \uC694\uCCAD\uD588\uC2B5\uB2C8\uB2E4.");
          }
          const meta = await this.tokenManager.acquire(context, action);
          const state = await this.sync(context, false, meta);
          return this.success(command, clientRequestId, state, meta);
        }
        if (command.type === "save-vip-settings") {
          return await this.withLock(context.shopId, "save-vip-settings", async () => {
            const payload = validateSaveVipSettingsPayload(command.payload);
            this.assertTarget(context, payload.shopId, payload.targetPageUrl);
            const state = await this.save(context, payload);
            return this.success(command, clientRequestId, state, state.actionToken);
          });
        }
        return await this.withLock(context.shopId, "reset-vip-settings", async () => {
          const payload = validateResetVipSettingsPayload(command.payload);
          this.assertTarget(context, payload.shopId, payload.targetPageUrl);
          const state = await this.reset(context, payload);
          return this.success(command, clientRequestId, state, state.actionToken);
        });
      } catch (error) {
        const caught = toMemberActionError(error);
        const context = safeContext(rawContext);
        const action = command.type === "reset-vip-settings" ? "reset-vip-settings" : "save-vip-settings";
        let tokenMeta;
        if (context) {
          if (caught.code === "PERMISSION_DENIED" || caught.code === "SHOP_ID_MISMATCH" || caught.code === "SESSION_CHANGED" || caught.code === "ACTION_TOKEN_SOURCE_NOT_CONFIGURED") {
            this.tokenManager.setFailure(
              context,
              action,
              errorCodeToTokenStatus(caught.code),
              caught.code,
              caught.message
            );
          }
          tokenMeta = this.tokenManager.getStatus(context, action);
        }
        const state = context ? this.states.get(context.shopId) : void 0;
        return {
          commandId: command.id,
          commandType: command.type,
          clientRequestId,
          ok: false,
          completedAtIso: new Date(this.now()).toISOString(),
          errorCode: caught.code,
          errorMessage: sanitizeMemberErrorMessage(caught.message),
          memberServerState: state ? { ...state, actionToken: tokenMeta || state.actionToken } : void 0,
          actionToken: tokenMeta
        };
      }
    }
    clearShop(shopId) {
      this.states.delete(shopId);
      this.tokenManager.clearShop(shopId);
    }
    clearSession(sessionFingerprint) {
      this.tokenManager.clearSession(sessionFingerprint);
    }
    async sync(context, acquireIfEmpty, suppliedMeta) {
      const state = await this.adapter.syncVipGrades(context);
      const effectiveContext = contextFromState(context, state);
      let actionToken = suppliedMeta || this.tokenManager.getStatus(effectiveContext, "save-vip-settings");
      if (acquireIfEmpty && ["empty", "expired", "invalid", "consumed", "error"].includes(actionToken.status)) {
        actionToken = await this.tokenManager.acquire(effectiveContext, "save-vip-settings");
      }
      const next = { ...state, actionToken };
      this.states.set(context.shopId, next);
      return next;
    }
    async save(context, payload) {
      this.adapter.validateWriteConfiguration?.("save-vip-settings");
      const before = await this.adapter.syncVipGrades(context);
      assertPayloadMatchesState(payload, before);
      const effectiveContext = contextFromState(context, before);
      const target = payload.targetIndex;
      let mutationError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.performMutation(
            effectiveContext,
            "save-vip-settings",
            (rawToken) => this.adapter.saveVipSettings(effectiveContext, rawToken, payload)
          );
          mutationError = void 0;
        } catch (error) {
          mutationError = toMemberActionError(error);
        }
        const verified = await this.adapter.syncVipGrades(effectiveContext);
        if (verified.serverIndex === target) {
          const state = {
            ...verified,
            actionToken: this.tokenManager.getStatus(effectiveContext, "save-vip-settings")
          };
          this.states.set(context.shopId, state);
          return state;
        }
        if (!mutationError) {
          throw new MemberActionError(
            "SERVER_STATE_NOT_CHANGED",
            `\uC7AC\uC870\uD68C\uB41C serverIndex ${verified.serverIndex}\uAC00 targetIndex ${target}\uC640 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`
          );
        }
        if (!shouldRetry(mutationError, attempt)) throw mutationError;
        this.tokenManager.invalidate(effectiveContext, "save-vip-settings", mutationError.code);
        await this.tokenManager.acquire(effectiveContext, "save-vip-settings");
      }
      throw mutationError || new MemberActionError("SERVER_STATE_NOT_CHANGED");
    }
    async reset(context, payload) {
      this.adapter.validateWriteConfiguration?.("reset-vip-settings");
      const before = await this.adapter.syncVipGrades(context);
      const effectiveContext = contextFromState(context, before);
      let mutationError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.performMutation(
            effectiveContext,
            "reset-vip-settings",
            (rawToken) => this.adapter.resetVipSettings(effectiveContext, rawToken, payload)
          );
          mutationError = void 0;
        } catch (error) {
          mutationError = toMemberActionError(error);
        }
        const verified = await this.adapter.syncVipGrades(effectiveContext);
        if (verified.serverIndex === 0) {
          const state = {
            ...verified,
            actionToken: this.tokenManager.getStatus(effectiveContext, "reset-vip-settings")
          };
          this.states.set(context.shopId, state);
          return state;
        }
        if (!mutationError) {
          throw new MemberActionError("SERVER_STATE_NOT_CHANGED", `reset \uD6C4 serverIndex\uAC00 ${verified.serverIndex}\uC785\uB2C8\uB2E4.`);
        }
        if (!shouldRetry(mutationError, attempt)) throw mutationError;
        this.tokenManager.invalidate(effectiveContext, "reset-vip-settings", mutationError.code);
        await this.tokenManager.acquire(effectiveContext, "reset-vip-settings");
      }
      throw mutationError || new MemberActionError("SERVER_STATE_NOT_CHANGED");
    }
    async performMutation(context, action, mutate) {
      this.adapter.validateWriteConfiguration?.(action);
      const rawToken = await this.tokenManager.getOrAcquireRawToken(context, action);
      this.tokenManager.markConsuming(context, action);
      try {
        const result = await mutate(rawToken);
        this.tokenManager.markConsumed(context, action);
        if (!result.ok) {
          throw new MemberActionError(
            normalizeMutationErrorCode(result.errorCode),
            result.errorMessage || result.errorCode || "Member \uC800\uC7A5 \uC694\uCCAD\uC774 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.",
            true
          );
        }
      } catch (error) {
        const caught = toMemberActionError(error);
        if (caught.requestStarted) {
          try {
            this.tokenManager.markConsumed(context, action);
          } catch {
          }
        }
        throw caught;
      }
    }
    assertTarget(context, shopId, targetPageUrl) {
      if (context.shopId !== shopId) throw new MemberActionError("SHOP_ID_MISMATCH");
      if (!targetPageUrl) throw new MemberActionError("TARGET_PAGE_URL_MISSING");
      let target;
      try {
        target = new URL(targetPageUrl);
      } catch {
        throw new MemberActionError("TARGET_PAGE_MISMATCH");
      }
      const current = new URL(context.pageUrl);
      if (target.origin !== current.origin || target.pathname !== current.pathname) {
        throw new MemberActionError("TARGET_PAGE_MISMATCH");
      }
    }
    async withLock(shopId, action, task) {
      const key = `${shopId}:${action}`;
      if (this.locks.has(key)) throw new MemberActionError("MEMBER_ACTION_ALREADY_RUNNING");
      this.locks.add(key);
      try {
        return await task();
      } finally {
        this.locks.delete(key);
      }
    }
    success(command, clientRequestId, memberServerState, actionToken) {
      return {
        commandId: command.id,
        commandType: command.type,
        clientRequestId,
        ok: true,
        completedAtIso: new Date(this.now()).toISOString(),
        memberServerState,
        actionToken: actionToken || memberServerState?.actionToken
      };
    }
    cleanupProcessed() {
      const cutoff = this.now() - 5 * 6e4;
      for (const [id, savedAt] of this.processedRequestIds) {
        if (savedAt < cutoff) this.processedRequestIds.delete(id);
      }
    }
  };
  function validateSaveVipSettingsPayload(value) {
    if (!value || typeof value !== "object") throw new MemberActionError("SERVER_RESPONSE_INVALID");
    const payload = value;
    if (!payload.shopId) throw new MemberActionError("SHOP_ID_MISSING");
    if (!Number.isInteger(payload.serverIndex)) throw new MemberActionError("SERVER_INDEX_INVALID");
    if (!Number.isInteger(payload.targetIndex)) throw new MemberActionError("TARGET_INDEX_INVALID");
    if (payload.targetIndex < 0 || payload.targetIndex >= Number(payload.gradeCount)) {
      throw new MemberActionError("TARGET_INDEX_OUT_OF_RANGE");
    }
    if (!Array.isArray(payload.gradeNames)) throw new MemberActionError("GRADE_NAMES_INVALID");
    if (payload.gradeNames.length !== payload.gradeCount) throw new MemberActionError("GRADE_CATALOG_MISMATCH");
    if (!payload.clientRequestId) throw new MemberActionError("CLIENT_REQUEST_ID_MISSING");
    if (!payload.targetPageUrl) throw new MemberActionError("TARGET_PAGE_URL_MISSING");
    return {
      shopId: payload.shopId,
      serverIndex: payload.serverIndex,
      targetIndex: payload.targetIndex,
      gradeCount: payload.gradeCount,
      gradeNames: payload.gradeNames.map(String),
      name: String(payload.name || ""),
      remaining: finiteNumber2(payload.remaining),
      originalProgress: finiteNumber2(payload.originalProgress),
      targetPageUrl: payload.targetPageUrl,
      clientRequestId: payload.clientRequestId
    };
  }
  function validateResetVipSettingsPayload(value) {
    if (!value || typeof value !== "object") throw new MemberActionError("SERVER_RESPONSE_INVALID");
    const payload = value;
    if (!payload.shopId) throw new MemberActionError("SHOP_ID_MISSING");
    if (!payload.targetPageUrl) throw new MemberActionError("TARGET_PAGE_URL_MISSING");
    if (!payload.clientRequestId) throw new MemberActionError("CLIENT_REQUEST_ID_MISSING");
    return {
      shopId: payload.shopId,
      targetPageUrl: payload.targetPageUrl,
      clientRequestId: payload.clientRequestId
    };
  }
  function validateSyncPayload(value, context) {
    if (!value || typeof value !== "object") throw new MemberActionError("SERVER_RESPONSE_INVALID");
    const payload = value;
    if (!payload.shopId) throw new MemberActionError("SHOP_ID_MISSING");
    if (payload.shopId !== context.shopId) throw new MemberActionError("SHOP_ID_MISMATCH");
    if (!payload.targetPageUrl) throw new MemberActionError("TARGET_PAGE_URL_MISSING");
    if (!payload.clientRequestId) throw new MemberActionError("CLIENT_REQUEST_ID_MISSING");
    return payload;
  }
  function assertPayloadMatchesState(payload, state) {
    if (payload.serverIndex !== state.serverIndex) throw new MemberActionError("SERVER_INDEX_MISMATCH");
    if (payload.gradeCount !== state.gradeCount || payload.gradeNames.length !== state.gradeNames.length) {
      throw new MemberActionError("GRADE_CATALOG_MISMATCH");
    }
    if (payload.gradeNames.some((name, index) => name !== state.gradeNames[index])) {
      throw new MemberActionError("GRADE_CATALOG_MISMATCH");
    }
  }
  function contextFromState(context, state) {
    return {
      ...context,
      currentServerIndex: state.serverIndex,
      gradeCount: state.gradeCount,
      gradeNames: [...state.gradeNames]
    };
  }
  function normalizeRequestedAction(value) {
    return value === "reset-vip-settings" ? "reset-vip-settings" : "save-vip-settings";
  }
  function normalizeMutationErrorCode(value) {
    if (value === "ACTION_TOKEN_EXPIRED") return "ACTION_TOKEN_EXPIRED";
    if (value === "ACTION_TOKEN_INVALID") return "ACTION_TOKEN_INVALID";
    if (value === "ACTION_TOKEN_ALREADY_USED") return "ACTION_TOKEN_ALREADY_USED";
    if (value === "PERMISSION_DENIED") return "PERMISSION_DENIED";
    return "NETWORK_ERROR";
  }
  function shouldRetry(error, attempt) {
    return attempt === 0 && [
      "ACTION_TOKEN_EXPIRED",
      "ACTION_TOKEN_INVALID",
      "ACTION_TOKEN_ALREADY_USED",
      "NETWORK_TIMEOUT"
    ].includes(error.code);
  }
  function optionalString(value) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : void 0;
  }
  function finiteNumber2(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  function safeContext(value) {
    try {
      return validateMemberPageContext(value);
    } catch {
      return void 0;
    }
  }

  // extension/src/member/page-action-token-source.ts
  var PageObservedActionTokenSource = class {
    constructor(requestScan, timeoutMs = 3e3) {
      this.requestScan = requestScan;
      this.timeoutMs = timeoutMs;
    }
    pending = /* @__PURE__ */ new Map();
    async acquire(context, action) {
      const key = tokenKey(context, action);
      if (this.pending.has(key)) {
        throw new MemberActionError(
          "ACTION_TOKEN_ALREADY_ACQUIRING",
          "\uB3D9\uC77C\uD55C Member \uCEE8\uD14D\uC2A4\uD2B8\uC5D0\uC11C actionToken \uAC10\uC9C0\uAC00 \uC774\uBBF8 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4."
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(key);
          reject(new MemberActionError(
            "ACTION_TOKEN_NOT_FOUND",
            "\uC2E4\uC81C Weidian Member \uD398\uC774\uC9C0\uC758 bootstrap\xB7\uC694\uCCAD\xB7\uC751\uB2F5\uC5D0\uC11C actionToken\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
          ));
        }, this.timeoutMs);
        this.pending.set(key, { resolve, reject, timer });
        void this.requestScan(context, action).catch((error) => {
          const pending = this.pending.get(key);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(key);
          pending.reject(
            error instanceof MemberActionError ? error : new MemberActionError(
              "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
              error instanceof Error ? error.message : String(error)
            )
          );
        });
      });
    }
    accept(context, action, token) {
      const key = tokenKey(context, action);
      const pending = this.pending.get(key);
      if (!pending) return false;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.resolve(token);
      return true;
    }
    clearContext(context) {
      const prefix = `${context.sessionFingerprint}:${context.origin}:${context.shopId}:`;
      for (const [key, pending] of this.pending) {
        if (!key.startsWith(prefix)) continue;
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(new MemberActionError("SESSION_CHANGED"));
      }
    }
    clearAll() {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new MemberActionError("SESSION_CHANGED"));
      }
      this.pending.clear();
    }
  };
  function tokenKey(context, action) {
    return `${context.sessionFingerprint}:${context.origin}:${context.shopId}:${action}`;
  }

  // extension/src/background.ts
  var BRIDGE_BASE = "http://127.0.0.1:17873";
  var ports = /* @__PURE__ */ new Map();
  var tabContexts = /* @__PURE__ */ new Map();
  var tabActionIntents = /* @__PURE__ */ new Map();
  var pollInFlight = false;
  var fastPollTimer = null;
  var memberLevelCache = /* @__PURE__ */ new Map();
  var memberLevelJobs = /* @__PURE__ */ new Map();
  var memberRequestContracts = /* @__PURE__ */ new Map();
  var memberRequestObservationCount = 0;
  var MAX_MEMBER_REQUEST_OBSERVATIONS = 200;
  var memberAdapter = new AuthorizedMemberActionAdapter(LIVE_PAGE_MEMBER_CONFIG);
  var pageTokenSource = new PageObservedActionTokenSource(requestMemberActionTokenScan);
  var actionTokenManager = new InMemoryActionTokenManager(
    (context, action) => pageTokenSource.acquire(context, action),
    Date.now,
    publishActionTokenState
  );
  var memberCommandHandler = new MemberCommandHandler(memberAdapter, actionTokenManager);
  installMemberApiContractObserver();
  function installMemberApiContractObserver() {
    if (!chrome.webRequest?.onBeforeRequest) return;
    const filter = { urls: ["https://thor.weidian.com/*"] };
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (!isMemberApiUrl(details.url) || memberRequestObservationCount >= MAX_MEMBER_REQUEST_OBSERVATIONS) {
          return;
        }
        const describedUrl = describeContractUrl(details.url);
        memberRequestContracts.set(details.requestId, {
          observerVersion: 1,
          source: "chrome-web-request",
          observedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
          transport: details.type || "unknown",
          tabId: details.tabId,
          method: String(details.method || "GET").toUpperCase(),
          ...describedUrl,
          requestBodyShape: describeWebRequestBody(details.requestBody)
        });
        trimMemberRequestContracts();
      },
      filter,
      ["requestBody"]
    );
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const contract = memberRequestContracts.get(details.requestId);
        if (!contract) return;
        const headerNames = headerNamesOnly(details.requestHeaders);
        contract.requestHeaderNames = headerNames;
        contract.requestHeaderMetadata = safeRequestHeaderMetadata(details.requestHeaders);
        contract.chromeSessionCookie = headerNames.includes("cookie");
        contract.tokenPlacement = detectContractTokenPlacement(
          contract.queryKeys || [],
          headerNames,
          contract.requestBodyShape,
          contract.queryShape
        );
      },
      filter,
      ["requestHeaders", "extraHeaders"]
    );
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const contract = memberRequestContracts.get(details.requestId);
        if (!contract) return;
        contract.status = details.statusCode;
        contract.outcome = details.statusCode >= 200 && details.statusCode < 400 ? "ok" : "http-error";
        contract.responseHeaderNames = headerNamesOnly(details.responseHeaders);
        contract.responseContentType = contentTypeFromHeaders(details.responseHeaders);
        emitMemberRequestContract(details.requestId);
      },
      filter,
      ["responseHeaders", "extraHeaders"]
    );
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        const contract = memberRequestContracts.get(details.requestId);
        if (!contract) return;
        contract.outcome = "network-error";
        contract.errorName = String(details.error || "network-error").slice(0, 120);
        emitMemberRequestContract(details.requestId);
      },
      filter
    );
  }
  function isMemberApiUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.hostname === "thor.weidian.com" && /\/(?:promotion|wdcrm)\//i.test(url.pathname) && /(?:member|customer|material|shopIdentity)/i.test(url.pathname);
    } catch {
      return false;
    }
  }
  function describeContractUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return {
        url: `${url.origin}${url.pathname}`,
        queryKeys: [.../* @__PURE__ */ new Set([...url.searchParams.keys()])].sort(),
        queryShape: describeContractSearchParams(url.searchParams)
      };
    } catch {
      return { url: "invalid", queryKeys: [], queryShape: void 0 };
    }
  }
  function describeContractSearchParams(params) {
    const keys = [.../* @__PURE__ */ new Set([...params.keys()])].sort();
    if (!keys.length) return void 0;
    return Object.fromEntries(keys.map((key) => {
      const values = params.getAll(key);
      const shape = values.length > 1 ? [describeContractEncodedValue(values[0])] : describeContractEncodedValue(values[0]);
      return [key, shape];
    }));
  }
  function describeWebRequestBody(requestBody) {
    if (!requestBody) return void 0;
    if (requestBody.formData) {
      return Object.fromEntries(
        Object.keys(requestBody.formData).sort().map((key) => [
          key,
          requestBody.formData[key]?.length > 1 ? ["string"] : "string"
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
    if (!bytes?.length) return requestBody.error ? "unavailable" : void 0;
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
      return "binary";
    }
  }
  function describeContractEncodedValue(value) {
    const text = String(value || "");
    try {
      return contractShapeOf(JSON.parse(text));
    } catch {
      try {
        const params = new URLSearchParams(text);
        if ([...params.keys()].length) return describeContractSearchParams(params);
      } catch {
      }
      return "string";
    }
  }
  function contractShapeOf(value, depth = 0) {
    if (value === null) return "null";
    if (Array.isArray(value)) return depth >= 3 ? "array" : [value.length ? contractShapeOf(value[0], depth + 1) : "empty"];
    if (typeof value !== "object") return typeof value;
    if (depth >= 3) return "object";
    return Object.fromEntries(
      Object.keys(value).sort().slice(0, 80).map((key) => [key, contractShapeOf(value[key], depth + 1)])
    );
  }
  function headerNamesOnly(headers) {
    return [...new Set((headers || []).map((header) => String(header.name || "").toLowerCase()).filter(Boolean))].sort();
  }
  function safeRequestHeaderMetadata(headers) {
    const result = {};
    for (const header of headers || []) {
      const name = String(header.name || "").toLowerCase();
      const value = String(header.value || "");
      if (name === "content-type") result.contentType = value.split(";")[0].trim().toLowerCase().slice(0, 100);
      if (name === "origin") result.origin = safeContractPage(value, true);
      if (name === "referer") result.referer = safeContractPage(value, false);
    }
    return Object.keys(result).length ? result : void 0;
  }
  function safeContractPage(value, originOnly) {
    try {
      const url = new URL(value);
      if (!/(^|\.)weidian\.com$/i.test(url.hostname)) return "non-weidian";
      return originOnly ? url.origin : `${url.origin}${url.pathname}`;
    } catch {
      return "invalid";
    }
  }
  function contentTypeFromHeaders(headers) {
    const value = (headers || []).find((header) => String(header.name || "").toLowerCase() === "content-type")?.value;
    return String(value || "").split(";")[0].trim().toLowerCase().slice(0, 100);
  }
  function detectContractTokenPlacement(queryKeys, headerNames, bodyShape, queryShape) {
    const isActionTokenKey = (key) => /^(?:x-)?action[-_]?token$/i.test(String(key));
    if (queryKeys.some(isActionTokenKey) || containsContractShapeKey(queryShape, isActionTokenKey)) return "query";
    if (headerNames.some(isActionTokenKey)) return "header";
    if (containsContractShapeKey(bodyShape, isActionTokenKey)) return "body";
    return "not-observed";
  }
  function containsContractShapeKey(value, predicate) {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => containsContractShapeKey(item, predicate));
    return Object.entries(value).some(([key, child]) => predicate(key) || containsContractShapeKey(child, predicate));
  }
  function emitMemberRequestContract(requestId) {
    const contract = memberRequestContracts.get(requestId);
    memberRequestContracts.delete(requestId);
    if (!contract || memberRequestObservationCount >= MAX_MEMBER_REQUEST_OBSERVATIONS) return;
    memberRequestObservationCount += 1;
    const tabId = contract.tabId;
    delete contract.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) return;
    chrome.tabs.sendMessage(tabId, {
      type: "EW_MEMBER_API_CONTRACT_OBSERVATION",
      observation: contract
    }).catch(() => {
    });
  }
  function trimMemberRequestContracts() {
    if (memberRequestContracts.size <= 250) return;
    const oldest = [...memberRequestContracts.keys()].slice(0, memberRequestContracts.size - 200);
    for (const requestId of oldest) memberRequestContracts.delete(requestId);
  }
  async function bridgeFetch(path, init = {}) {
    const response = await fetch(`${BRIDGE_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers || {}
      }
    });
    if (!response.ok) throw new Error(`bridge ${response.status}`);
    return response.json();
  }
  async function requestMemberActionTokenScan(context, action) {
    const tabEntry = [...tabContexts.entries()].find(
      ([, candidate]) => candidate.shopId === context.shopId && candidate.sessionFingerprint === context.sessionFingerprint
    );
    if (!tabEntry) {
      throw memberCommandError(
        "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
        "\uD604\uC7AC \uB85C\uADF8\uC778 \uC138\uC158\uACFC \uC0C1\uC810\uC5D0 \uC5F0\uACB0\uB41C Member \uD0ED\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
      );
    }
    const [tabId] = tabEntry;
    let result;
    try {
      result = await chrome.tabs.sendMessage(tabId, {
        type: "EW_SCAN_MEMBER_ACTION_TOKEN",
        action,
        requestId: crypto.randomUUID()
      });
    } catch {
      throw memberCommandError(
        "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
        "Member \uD398\uC774\uC9C0\uC758 actionToken \uAD00\uCC30\uAE30\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
      );
    }
    if (!result?.ok) {
      throw memberCommandError(
        result?.errorCode || "ACTION_TOKEN_SOURCE_NOT_CONFIGURED",
        result?.errorMessage || "Member \uD398\uC774\uC9C0\uC758 actionToken \uAD00\uCC30\uAE30\uB97C \uC2E4\uD589\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
      );
    }
  }
  function publishActionTokenState(context, actionToken) {
    const safeMeta = {
      ...actionToken,
      tokenFingerprint: actionToken.tokenFingerprint,
      rawToken: void 0
    };
    for (const [tabId, candidate] of tabContexts) {
      if (candidate.shopId !== context.shopId || candidate.sessionFingerprint !== context.sessionFingerprint) {
        continue;
      }
      chrome.tabs.sendMessage(tabId, {
        type: "EW_MEMBER_ACTION_TOKEN_STATE",
        shopId: context.shopId,
        actionToken: safeMeta
      }).catch(() => {
      });
    }
    bridgeFetch("/api/member-token-state", {
      method: "POST",
      body: JSON.stringify({
        shopId: context.shopId,
        actionToken: safeMeta
      })
    }).catch(() => {
    });
  }
  async function pollBridge() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const state = await bridgeFetch("/api/state");
      deliverStateToPorts(state);
      const delivered = await deliverStateToTabsWithoutPorts(state);
      if (delivered.size > 0) await ackCommands([...delivered]);
    } catch {
    } finally {
      pollInFlight = false;
    }
  }
  async function deliverStateToTabsWithoutPorts(state) {
    const tabs = await chrome.tabs.query({ url: ["https://weidian.com/*", "https://*.weidian.com/*"] });
    const connectedTabIds = new Set(
      [...ports.values()].map((entry) => entry.tabId).filter((tabId) => Number.isInteger(tabId))
    );
    const delivered = /* @__PURE__ */ new Set();
    for (const tab of tabs) {
      if (!tab.id || connectedTabIds.has(tab.id)) continue;
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: "EW_BRIDGE_STATE", state });
        for (const id of result?.handledCommandIds || []) delivered.add(id);
      } catch {
      }
    }
    return delivered;
  }
  function deliverStateToPorts(state) {
    for (const [key, entry] of ports) {
      try {
        entry.port.postMessage({ type: "EW_BRIDGE_STATE", state });
      } catch {
        ports.delete(key);
      }
    }
  }
  async function ackCommands(ids) {
    if (!ids.length) return;
    await bridgeFetch("/api/ack", {
      method: "POST",
      body: JSON.stringify({ ids })
    }).catch(() => {
    });
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
    tabContexts.clear();
    chrome.alarms.create("ew-weidian-heartbeat", { delayInMinutes: 0, periodInMinutes: 0.5 });
    void pollBridge();
  });
  chrome.runtime.onStartup.addListener(() => {
    pageTokenSource.clearAll();
    actionTokenManager.clearAll();
    chrome.alarms.create("ew-weidian-heartbeat", { delayInMinutes: 0, periodInMinutes: 0.5 });
    void pollBridge();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "ew-weidian-heartbeat") void pollBridge();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "EW_WEIDIAN_PORT") return;
    const tabId = port.sender?.tab?.id;
    const key = `${tabId ?? "unknown"}-${Date.now()}-${Math.random()}`;
    ports.set(key, { port, tabId });
    ensureFastPoll();
    port.onMessage.addListener((message) => {
      if (message?.type === "EW_ACK" && Array.isArray(message.ids)) void ackCommands(message.ids);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(key);
      stopFastPollIfIdle();
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "EW_OBSERVATION") {
      if (sender.tab && !sender.tab.active) {
        sendResponse({ ok: true, ignored: "inactive-tab" });
        return false;
      }
      bridgeFetch("/api/observation", {
        method: "POST",
        body: JSON.stringify(message.payload)
      }).then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "EW_ACK_COMMANDS") {
      const ids = Array.isArray(message.ids) ? message.ids.filter((id) => typeof id === "string") : [];
      ackCommands(ids).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "EW_MEMBER_ACTION_TOKEN_DETECTED") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId) || !message.context || !message.detection) {
        sendResponse({ ok: false, errorCode: "SESSION_MISSING" });
        return false;
      }
      handleDetectedActionToken(tabId, message.context, message.detection).then((meta) => sendResponse({ ok: true, actionToken: meta })).catch(
        (error) => sendResponse({
          ok: false,
          errorCode: error?.code || "UNKNOWN_MEMBER_ERROR",
          errorMessage: sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
        })
      );
      return true;
    }
    if (message?.type === "EW_RUN_MEMBER_COMMAND") {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId) || !message.command || !message.context) {
        sendResponse({ ok: false, errorCode: "SESSION_MISSING", errorMessage: "Member \uD0ED \uCEE8\uD14D\uC2A4\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
        return false;
      }
      handleMemberCommand(tabId, message.command, message.context).then((result) => sendResponse(result)).catch(
        (error) => sendResponse({
          ok: false,
          errorCode: error?.code || "UNKNOWN_MEMBER_ERROR",
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      );
      return true;
    }
    if (message?.type === "EW_REPORT_MEMBER_COMMAND_ERROR") {
      if (!sender.tab || !message.command) {
        sendResponse({ ok: false });
        return false;
      }
      reportMemberCommandFailure(
        message.command,
        message.errorCode || "UNKNOWN_MEMBER_ERROR",
        message.errorMessage || "Member \uBA85\uB839\uC774 \uC2E4\uD589\uB418\uAE30 \uC804\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4."
      ).then((result) => sendResponse(result)).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === "EW_DOWNLOAD_IMAGES") {
      const urls = Array.isArray(message.urls) ? message.urls.filter((url) => typeof url === "string" && /^https:\/\//i.test(url)).slice(0, 200) : [];
      const folder = sanitizePathPart(message.folder || "images");
      Promise.all(
        urls.map(
          (url, index) => chrome.downloads.download({
            url,
            filename: `\uB178\uBB34\uD604/${folder}/${String(index + 1).padStart(3, "0")}-${fileNameFromUrl(url)}`,
            conflictAction: "uniquify",
            saveAs: false
          })
        )
      ).then((ids) => sendResponse({ ok: true, count: ids.length })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "EW_SAVE_MEMBER_PREVIEW") {
      bridgeFetch("/api/member-preview", {
        method: "POST",
        body: JSON.stringify(message.preview || {})
      }).then((result) => sendResponse({ ok: true, context: result.context })).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "EW_DISCOVER_MEMBER_LEVELS") {
      const shopId = String(message.shopId || "").trim();
      if (!/^\d{6,20}$/.test(shopId)) {
        sendResponse({ ok: false, error: "\uC0C1\uC810 ID \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
        return false;
      }
      discoverMemberLevels(shopId).then((memberLevels) => sendResponse({ ok: memberLevels.length > 0, memberLevels })).catch((error) => sendResponse({ ok: false, error: String(error), memberLevels: [] }));
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
        action: command.type === "reset-vip-settings" || command.type === "refresh-action-token" && command.payload?.action === "reset-vip-settings" ? "reset-vip-settings" : "save-vip-settings",
        savedAtEpochMs: Date.now()
      });
      result = await memberCommandHandler.execute(command, verifiedContext);
    } catch (error) {
      result = memberCommandFailureResult(command, error?.code || "UNKNOWN_MEMBER_ERROR", error);
    }
    await bridgeFetch("/api/command-result", {
      method: "POST",
      body: JSON.stringify(result)
    }).catch(() => {
    });
    return result;
  }
  async function handleDetectedActionToken(tabId, rawContext, detection) {
    const tab = await chrome.tabs.get(tabId);
    const tabUrl = new URL(String(tab.url || ""));
    const pageUrl = new URL(String(rawContext.pageUrl || ""));
    if (tabUrl.origin !== pageUrl.origin || tabUrl.pathname !== pageUrl.pathname || pageUrl.protocol !== "https:" || !/(^|\.)weidian\.com$/i.test(pageUrl.hostname)) {
      throw memberCommandError("TARGET_PAGE_MISMATCH", "\uD1A0\uD070 \uAC10\uC9C0 \uD398\uC774\uC9C0\uC640 Chrome \uD0ED\uC774 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    const shopId = String(rawContext.shopId || "").trim();
    if (!/^\d{6,20}$/.test(shopId)) {
      throw memberCommandError("SHOP_ID_MISSING");
    }
    const rawToken = String(detection.rawToken || "").trim();
    if (!rawToken || rawToken.length > 4096) {
      throw memberCommandError("ACTION_TOKEN_MISSING");
    }
    if (detection.source === "network-request") {
      return {
        status: "consumed",
        shopId,
        action: normalizeDetectedAction(tabId, detection.action),
        oneTime: detection.oneTime !== false,
        source: "network-request"
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
      gradeNames: ["UNKNOWN"]
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
      source: detection.source === "page-bootstrap" ? "page-bootstrap" : "network-response"
    };
    if (pageTokenSource.accept(context, action, acquired)) {
      return {
        status: "acquiring",
        shopId,
        action,
        oneTime: acquired.oneTime,
        source: acquired.source
      };
    }
    return actionTokenManager.ingest(context, action, acquired);
  }
  function normalizeDetectedAction(tabId, action) {
    if (action === "reset-vip-settings" || action === "save-vip-settings") return action;
    const intent = tabActionIntents.get(tabId);
    if (intent && Date.now() - intent.savedAtEpochMs <= 2 * 6e4) return intent.action;
    return "save-vip-settings";
  }
  function finiteEpochOrNow(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : Date.now();
  }
  function finiteEpoch(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : void 0;
  }
  async function reportMemberCommandFailure(command, errorCode, errorMessage) {
    const result = memberCommandFailureResult(command, errorCode, errorMessage);
    await bridgeFetch("/api/command-result", {
      method: "POST",
      body: JSON.stringify(result)
    }).catch(() => {
    });
    return result;
  }
  function memberCommandFailureResult(command, errorCode, errorMessage) {
    return {
      commandId: String(command?.id || "unknown").slice(0, 200),
      commandType: command?.type || "sync-vip-grades",
      clientRequestId: String(command?.payload?.clientRequestId || "").slice(0, 200) || void 0,
      ok: false,
      completedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
      errorCode: String(errorCode || "UNKNOWN_MEMBER_ERROR").slice(0, 100),
      errorMessage: sanitizeErrorMessage(
        errorMessage instanceof Error ? errorMessage.message : String(errorMessage || errorCode || "Member \uBA85\uB839 \uC2E4\uD328")
      )
    };
  }
  chrome.tabs.onRemoved.addListener((tabId) => clearTabContext(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) clearTabContext(tabId);
  });
  chrome.cookies.onChanged.addListener((changeInfo) => {
    const domain = String(changeInfo.cookie?.domain || "").replace(/^\./, "");
    if (!/(^|\.)weidian\.com$/i.test(domain)) return;
    pageTokenSource.clearAll();
    actionTokenManager.clearAll();
    tabContexts.clear();
  });
  function clearTabContext(tabId) {
    const previous = tabContexts.get(tabId);
    if (!previous) return;
    pageTokenSource.clearContext(previous);
    if (previous.sessionFingerprint) memberCommandHandler.clearSession(previous.sessionFingerprint);
    if (previous.shopId) memberCommandHandler.clearShop(previous.shopId);
    tabContexts.delete(tabId);
    tabActionIntents.delete(tabId);
  }
  async function fingerprintChromeSession(context) {
    let url;
    try {
      url = new URL(context.pageUrl);
    } catch {
      throw memberCommandError("TARGET_PAGE_MISMATCH", "Member \uD398\uC774\uC9C0 URL\uC744 \uD574\uC11D\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
    if (url.origin !== context.origin || !/(^|\.)weidian\.com$/i.test(url.hostname)) {
      throw memberCommandError("TARGET_PAGE_MISMATCH", "\uD604\uC7AC Weidian \uD398\uC774\uC9C0 origin\uACFC \uCEE8\uD14D\uC2A4\uD2B8\uAC00 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    const cookies = await chrome.cookies.getAll({ url: context.pageUrl });
    if (!cookies.length) {
      throw memberCommandError("SESSION_MISSING", "\uB85C\uADF8\uC778\uB41C Chrome Weidian \uC138\uC158\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    }
    const ephemeralCookieMaterial = cookies.slice().sort(
      (left, right) => `${left.domain}:${left.path}:${left.name}`.localeCompare(`${right.domain}:${right.path}:${right.name}`)
    ).map((cookie) => `${cookie.domain}	${cookie.path}	${cookie.name}	${cookie.value}`).join("\n");
    const input = new TextEncoder().encode(
      `${context.origin}
${context.sessionFingerprint || ""}
${ephemeralCookieMaterial}`
    );
    const digest = await crypto.subtle.digest("SHA-256", input);
    return [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function memberCommandError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }
  function sanitizeErrorMessage(message) {
    return String(message).replace(
      /\b(actionToken|accessToken|refreshToken|qrCodeStatusKey|authorization|cookie|sessionId|session|token|ct)\b\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]"
    ).slice(0, 400);
  }
  async function discoverMemberLevels(shopId) {
    const cached = memberLevelCache.get(shopId);
    if (cached && Date.now() - cached.savedAt < 10 * 6e4) return cached.memberLevels;
    if (memberLevelJobs.has(shopId)) return memberLevelJobs.get(shopId);
    const job = (async () => {
      let tab;
      try {
        const url = `https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=${encodeURIComponent(shopId)}&ew_discovery=1`;
        tab = await chrome.tabs.create({ url, active: false });
        const memberLevels = await collectMemberLevelsFromTab(tab.id);
        if (memberLevels.length > 0) memberLevelCache.set(shopId, { savedAt: Date.now(), memberLevels });
        return memberLevels;
      } finally {
        if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {
        });
        memberLevelJobs.delete(shopId);
      }
    })();
    memberLevelJobs.set(shopId, job);
    return job;
  }
  async function collectMemberLevelsFromTab(tabId) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await delay(attempt === 0 ? 800 : 500);
      try {
        const result = await chrome.tabs.sendMessage(tabId, { type: "EW_COLLECT_MEMBER_LEVELS" });
        const levels = Array.isArray(result?.memberLevels) ? result.memberLevels : [];
        if (levels.length > 0) return levels;
      } catch {
      }
    }
    return [];
  }
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function sanitizePathPart(value) {
    return String(value).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "images";
  }
  function fileNameFromUrl(value) {
    try {
      const name = new URL(value).pathname.split("/").pop() || "image.jpg";
      return sanitizePathPart(decodeURIComponent(name)).replace(/_+$/g, "") || "image.jpg";
    } catch {
      return "image.jpg";
    }
  }
  chrome.alarms.create("ew-weidian-heartbeat", { delayInMinutes: 0, periodInMinutes: 0.5 });
})();
