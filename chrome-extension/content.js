"use strict";
(() => {
  // extension/src/content.ts
  (() => {
    if (window.top !== window || document.documentElement.dataset.ewWeidianLoaded === "1") return;
    document.documentElement.dataset.ewWeidianLoaded = "1";
    document.documentElement.dataset.ewWeidianVersion = "0.4.0";
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "EW_MEMBER_API_CONTRACT_OBSERVATION" || !message.observation) return false;
      console.info(`[EW_MEMBER_API_CONTRACT] ${JSON.stringify(message.observation)}`);
      return false;
    });
    const initialUrl = new URL(location.href);
    if (initialUrl.searchParams.get("ew_discovery") === "1") {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== "EW_COLLECT_MEMBER_LEVELS") return false;
        const bodyText = visibleText(document.body).slice(0, 8e4);
        sendResponse({ memberLevels: collectMemberLevels(bodyText) });
        return false;
      });
      return;
    }
    const state = {
      bridge: null,
      snapshot: null,
      activeTab: "page",
      selected: /* @__PURE__ */ new Map(),
      handledCommands: /* @__PURE__ */ new Set(),
      reservationKey: "",
      reservationTimer: null,
      executedReservations: /* @__PURE__ */ new Set(),
      memberDraft: null,
      memberDraftDirty: false,
      memberPreviewActive: false,
      localPreviewOriginals: /* @__PURE__ */ new Map(),
      discoveredMemberLevels: [],
      memberDiscoveryShopId: "",
      memberDiscoveryRequestedAt: 0,
      memberServerState: null,
      memberCommandRunning: "",
      memberAutoReadKey: ""
    };
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message?.source !== "EW_WEIDIAN_PAGE_MAIN" || message.type !== "EW_MEMBER_ACTION_TOKEN_DETECTED" || !message.context || !message.detection) {
        return;
      }
      chrome.runtime.sendMessage({
        type: "EW_MEMBER_ACTION_TOKEN_DETECTED",
        context: message.context,
        detection: message.detection
      }, () => void chrome.runtime.lastError);
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "EW_MEMBER_ACTION_TOKEN_STATE" && message.actionToken) {
        if (state.memberServerState && state.memberServerState.shopId === String(message.shopId || "")) {
          state.memberServerState = {
            ...state.memberServerState,
            actionToken: message.actionToken
          };
          console.info(`[EW_ACTION_TOKEN_STATE] ${JSON.stringify({
            shopId: message.shopId,
            status: message.actionToken.status,
            fingerprint: message.actionToken.tokenFingerprint,
            source: message.actionToken.source,
            errorCode: message.actionToken.lastErrorCode
          })}`);
          state.snapshot = collectSnapshot();
          render();
          postObservation();
        }
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === "EW_SCAN_MEMBER_ACTION_TOKEN") {
        requestPageMainMemberContext(
          "EW_MEMBER_TOKEN_SCAN",
          message.requestId || crypto.randomUUID()
        ).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({
          ok: false,
          errorCode: error?.code || errorCodeFromMessage(error instanceof Error ? error.message : String(error)),
          errorMessage: error instanceof Error ? error.message : String(error)
        }));
        return true;
      }
      return false;
    });
    const host = document.createElement("div");
    host.id = "ew-weidian-host";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = overlayCss();
    const panel = document.createElement("aside");
    panel.className = "ew-panel";
    shadow.append(style, panel);
    const watermark = document.createElement("div");
    watermark.id = "ew-weidian-watermark";
    const memberPreviewCard = document.createElement("div");
    memberPreviewCard.id = "ew-weidian-member-preview";
    document.documentElement.appendChild(memberPreviewCard);
    panel.addEventListener("input", syncMemberDraftFromControl);
    panel.addEventListener("change", syncMemberDraftFromControl);
    panel.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "tab") {
        state.activeTab = target.dataset.tab;
        render();
        return;
      }
      if (action === "close") {
        host.style.display = "none";
        watermark.remove();
        return;
      }
      if (action === "refresh") {
        location.reload();
        return;
      }
      if (action === "copy-url") {
        await navigator.clipboard.writeText(location.href);
        toast("URL\uC744 \uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4.");
        return;
      }
      if (action === "qty") {
        const id = target.dataset.id;
        const delta = Number(target.dataset.delta);
        state.selected.set(id, Math.max(0, (state.selected.get(id) || 0) + delta));
        render();
        postObservation();
        return;
      }
      if (action === "save-main-image") {
        downloadImages(state.snapshot?.imageUrls?.slice(0, 1) || []);
        return;
      }
      if (action === "save-all-images") {
        downloadImages(state.snapshot?.imageUrls || []);
        return;
      }
      if (action === "apply-member") {
        await applyMemberPreview(readMemberDraftFromPanel(), { persist: true });
        return;
      }
      if (action === "restore-member") {
        restoreMemberPreview();
        return;
      }
      if (action === "confirm-options") {
        toast(`\uC120\uD0DD \uC635\uC158\uC744 \uD655\uC815\uD588\uC2B5\uB2C8\uB2E4. \uCD1D ${selectedTotal()}\uAC1C`);
        return;
      }
      if (action === "manual-submit-order") {
        const ok = window.confirm(
          "\uC2E4\uC81C \uBBF8\uACB0\uC81C \uC8FC\uBB38\uC744 \uC0DD\uC131\uD558\uACE0 QR \uACB0\uC81C \uB300\uAE30 \uD654\uBA74\uC73C\uB85C \uC774\uB3D9\uD569\uB2C8\uB2E4. \uCD5C\uC885 \uACB0\uC81C\uB294 \uD734\uB300\uC804\uD654\uC5D0\uC11C \uC9C1\uC811 \uC2B9\uC778\uD574\uC57C \uD569\uB2C8\uB2E4. \uACC4\uC18D\uD560\uAE4C\uC694?"
        );
        if (!ok) return;
        const submit = findClickable(["\u63D0\u4EA4\u8BA2\u5355", "Submit Order", "\uC8FC\uBB38 \uC81C\uCD9C"]);
        if (!submit) {
          toast("\uC8FC\uBB38 \uC81C\uCD9C \uBC84\uD2BC\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", true);
          return;
        }
        submit.click();
      }
    });
    const bridgePort = chrome.runtime.connect({ name: "EW_WEIDIAN_PORT" });
    bridgePort.onMessage.addListener((message) => {
      if (message?.type !== "EW_BRIDGE_STATE") return;
      const handledCommandIds = handleBridgeState(message.state);
      if (handledCommandIds.length) {
        bridgePort.postMessage({ type: "EW_ACK", ids: handledCommandIds });
      }
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "EW_BRIDGE_STATE") return false;
      sendResponse({ handledCommandIds: handleBridgeState(message.state) });
      return false;
    });
    let observationTimer;
    const observer = new MutationObserver(() => {
      clearTimeout(observationTimer);
      observationTimer = setTimeout(() => {
        state.snapshot = collectSnapshot();
        render();
        postObservation();
      }, 450);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    state.snapshot = collectSnapshot();
    render();
    postObservation();
    requestMemberLevelDiscovery();
    setTimeout(() => void autoSyncMemberRead(), 700);
    setInterval(() => {
      state.snapshot = collectSnapshot();
      if (state.memberPreviewActive) void applyMemberPreview(currentMemberPreview(), { persist: false, silent: true });
      render();
      postObservation();
      requestMemberLevelDiscovery();
      void autoSyncMemberRead();
    }, 4e3);
    function collectSnapshot() {
      const url = new URL(location.href);
      const bodyText = visibleText(document.body).slice(0, 8e4);
      const itemId = url.searchParams.get("itemID") || url.searchParams.get("itemId") || matchFirst(bodyText, /itemID\s*[:：]?\s*(\d{6,})/i);
      const shopId = detectShopId(url, bodyText);
      if (state.memberServerState?.shopId && state.memberServerState.shopId !== shopId) {
        state.memberServerState = null;
      }
      const pageKind = detectPageKind(url, bodyText, itemId);
      const title = document.querySelector('meta[property="og:title"]')?.content || document.querySelector("h1")?.textContent?.trim() || document.title || "";
      const shopName = document.querySelector('[class*="shop-name"], [class*="seller-name"], [class*="store-name"]')?.textContent?.trim() || matchFirst(bodyText, /(?:店铺|상점|Store)\s*[:：]\s*([^\n]{2,50})/i);
      const priceText = document.querySelector('meta[property="product:price:amount"]')?.content || matchFirst(bodyText, /(?:¥|￥|CNY)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
      const imageUrls = [...document.images].map((image) => image.currentSrc || image.src).filter((value) => /^https:\/\//i.test(value)).filter((value, index, all) => all.indexOf(value) === index).slice(0, 200);
      const options = collectOptions();
      const stockTotal = collectStockTotal(bodyText);
      const detectedMemberLevels = state.memberPreviewActive ? [] : collectMemberLevels(bodyText);
      const synchronizedMemberLevels = state.memberServerState?.shopId === shopId ? state.memberServerState.gradeNames.map((label, index) => ({
        id: `server-level-${index}`,
        label,
        rank: index + 1,
        rawText: `Weidian Member API serverIndex=${index}`
      })) : [];
      const memberLevels = synchronizedMemberLevels.length > 0 ? synchronizedMemberLevels : state.memberPreviewActive ? currentMemberLevels() : detectedMemberLevels.length > 0 ? detectedMemberLevels : shopId === state.memberDiscoveryShopId ? state.discoveredMemberLevels : [];
      for (const option of options) option.selectedQuantity = state.selected.get(option.id) || 0;
      return {
        pageUrl: location.href,
        pageTitle: document.title || "",
        pageKind,
        observedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
        itemId: itemId || void 0,
        shopId: shopId || void 0,
        shopName: shopName || void 0,
        productTitle: title,
        priceText: priceText ? /^[0-9]/.test(priceText) ? `\xA5${priceText}` : priceText : void 0,
        stockTotal,
        saleStatus: detectSaleStatus(bodyText),
        saleTimeIso: extractSaleTime(bodyText),
        imageUrls,
        options,
        memberLevels,
        memberServerState: state.memberServerState || void 0
      };
    }
    function detectShopId(url, bodyText) {
      const queryId = url.searchParams.get("userid") || url.searchParams.get("userId") || url.searchParams.get("shopId");
      if (queryId) return queryId;
      const hostnameId = matchFirst(url.hostname, /^shop(\d{6,20})\.v\.weidian\.com$/i);
      if (hostnameId) return hostnameId;
      for (const anchor of document.querySelectorAll('a[href*="userid="], a[href*="shopId="]')) {
        try {
          const linked = new URL(anchor.href, location.href);
          const linkedId = linked.searchParams.get("userid") || linked.searchParams.get("userId") || linked.searchParams.get("shopId");
          if (linkedId) return linkedId;
        } catch {
        }
      }
      return matchFirst(bodyText, /(?:店铺|상점|shop)\s*(?:ID)?\s*[:：]?\s*(\d{6,})/i);
    }
    function requestMemberLevelDiscovery() {
      const shopId = state.snapshot?.shopId;
      if (!shopId || state.snapshot.memberLevels.length > 0) return;
      const now = Date.now();
      if (state.memberDiscoveryShopId === shopId && now - state.memberDiscoveryRequestedAt < 3e4) return;
      state.memberDiscoveryShopId = shopId;
      state.memberDiscoveryRequestedAt = now;
      chrome.runtime.sendMessage({ type: "EW_DISCOVER_MEMBER_LEVELS", shopId }, (result) => {
        if (chrome.runtime.lastError) return;
        const levels = Array.isArray(result?.memberLevels) ? result.memberLevels : [];
        if (levels.length === 0 || state.snapshot?.shopId !== shopId) return;
        state.discoveredMemberLevels = levels;
        state.snapshot = collectSnapshot();
        render();
        postObservation();
      });
    }
    function collectMemberLevels(bodyText) {
      const candidates = [];
      const selectors = [
        '[class*="vip" i]',
        '[class*="member" i]',
        '[class*="level" i]',
        '[class*="grade" i]',
        '[class*="rank" i]',
        '[class*="\u4F1A\u5458"]',
        '[class*="\u6703\u54E1"]',
        '[class*="\u7B49\u7EA7"]',
        '[class*="\u7B49\u7D1A"]',
        '[class*="\u6743\u76CA"]'
      ];
      for (const element of document.querySelectorAll(selectors.join(","))) {
        if (element.closest("#ew-weidian-host, #ew-weidian-member-preview, #ew-weidian-watermark")) continue;
        const text = normalizeLine(visibleText(element));
        if (isMemberLevelLike(text)) candidates.push(text);
      }
      for (const line of bodyText.split(/\n+/).map(normalizeLine)) {
        if (isMemberLevelLike(line)) candidates.push(line);
      }
      const namedLevels = [
        "\u666E\u901A\u4F1A\u5458",
        "\u767D\u94F6\u4F1A\u5458",
        "\u94F6\u5361\u4F1A\u5458",
        "\u9EC4\u91D1\u4F1A\u5458",
        "\u91D1\u5361\u4F1A\u5458",
        "\u94C2\u91D1\u4F1A\u5458",
        "\u94BB\u77F3\u4F1A\u5458",
        "\u9ED1\u5361\u4F1A\u5458",
        "\u81F3\u5C0A\u4F1A\u5458",
        "\u666E\u901A\u6703\u54E1",
        "\u767D\u9280\u6703\u54E1",
        "\u9280\u5361\u6703\u54E1",
        "\u9EC3\u91D1\u6703\u54E1",
        "\u91D1\u5361\u6703\u54E1",
        "\u9251\u91D1\u6703\u54E1",
        "\u947D\u77F3\u6703\u54E1",
        "\u9ED1\u5361\u6703\u54E1",
        "\u81F3\u5C0A\u6703\u54E1",
        "\uC77C\uBC18\uD68C\uC6D0",
        "\uC2E4\uBC84\uD68C\uC6D0",
        "\uACE8\uB4DC\uD68C\uC6D0",
        "\uD50C\uB798\uD2F0\uB118\uD68C\uC6D0",
        "\uB2E4\uC774\uC544\uD68C\uC6D0",
        "\uBE14\uB799\uD68C\uC6D0"
      ];
      for (const label of namedLevels) {
        if (bodyText.includes(label)) candidates.push(label);
      }
      const seen = /* @__PURE__ */ new Set();
      const levels = [];
      for (const text of candidates) {
        const level = parseMemberLevel(text, levels.length + 1);
        if (!level) continue;
        const key = level.label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        levels.push(level);
        if (levels.length >= 30) break;
      }
      if (!levels.length) return [];
      const sorted = levels.sort((a, b) => a.rank - b.rank);
      const numbered = sorted.filter((level) => /^(?:VIP|LV|V)[0-9]{1,2}$/i.test(level.label));
      return numbered.length > 0 ? numbered : sorted;
    }
    function parseMemberLevel(text, fallbackRank) {
      const label = extractMemberLabel(text);
      if (!label) return null;
      const rank = extractMemberRank(text, label, fallbackRank);
      const minAmount = extractAmount(text);
      return {
        id: `${slug(label)}-${rank}`,
        label,
        rank,
        minAmount,
        rawText: text.slice(0, 160)
      };
    }
    function extractMemberLabel(text) {
      const patterns = [
        /\bVIP\s*([0-9]{1,2})\b/i,
        /\bV\s*([0-9]{1,2})\b/i,
        /\bLV\s*([0-9]{1,2})\b/i,
        /([一二三四五六七八九十0-9]{1,3}\s*级会员)/,
        /([\u4e00-\u9fff]{1,8}(?:会员|會員|等级|等級|卡))/,
        /([A-Za-z0-9가-힣]{1,16}(?:회원|멤버|등급|Member|Level))/i
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        if (/VIP/i.test(match[0])) return `VIP${match[1]}`;
        if (/^V/i.test(match[0]) || /^LV/i.test(match[0])) return match[0].replace(/\s+/g, "").toUpperCase();
        return match[1].replace(/\s+/g, "").slice(0, 80);
      }
      return void 0;
    }
    function extractMemberRank(text, label, fallbackRank) {
      const numeric = String(label).match(/(?:VIP|LV|V)\s*([0-9]{1,2})/i)?.[1] || text.match(/([0-9]{1,2})\s*(?:级|등급|level|lv)/i)?.[1];
      if (numeric) return Math.max(1, Math.min(99, Number(numeric)));
      const order = ["\u666E\u901A", "\uC77C\uBC18", "\u767D\u94F6", "\u767D\u9280", "\u94F6\u5361", "\u9280\u5361", "\uC2E4\uBC84", "\u9EC4\u91D1", "\u9EC3\u91D1", "\u91D1\u5361", "\uACE8\uB4DC", "\u94C2\u91D1", "\u9251\u91D1", "\uD50C\uB798\uD2F0\uB118", "\u94BB\u77F3", "\u947D\u77F3", "\uB2E4\uC774\uC544", "\u9ED1\u5361", "\uBE14\uB799", "\u81F3\u5C0A"];
      const index = order.findIndex((token) => label.includes(token));
      return index >= 0 ? index + 1 : fallbackRank;
    }
    function extractAmount(text) {
      const match = text.match(/(?:¥|￥|CNY|RMB|消费|消費|금액|등급까지|next)[^0-9]{0,12}([0-9][0-9,.]*)/i);
      if (!match) return void 0;
      const value = Number(match[1].replace(/,/g, ""));
      return Number.isFinite(value) ? value : void 0;
    }
    function isMemberLevelLike(text) {
      return text.length >= 2 && text.length <= 160 && /VIP\s*[0-9]|LV\s*[0-9]|\bV\s*[0-9]\b|会员|會員|等级|等級|权益|등급|회원|멤버|Member|Level|白银|黄金|金卡|铂金|钻石|黑卡|至尊|실버|골드|플래티넘|다이아|블랙/i.test(text);
    }
    function normalizeLine(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
    function defaultMemberLevels() {
      return [1, 2, 3, 4, 5, 6].map((rank) => ({ id: `vip-${rank}`, label: `VIP${rank}`, rank }));
    }
    function collectOptions() {
      const candidates = [
        ...document.querySelectorAll(
          '[data-sku-id], [data-sku], [class*="sku-item"], [class*="spec-item"], [class*="model-item"]'
        )
      ];
      const seen = /* @__PURE__ */ new Set();
      return candidates.flatMap((element, index) => {
        const name = visibleText(element).replace(/\s+/g, " ").trim().slice(0, 100);
        if (!name || name.length > 100 || seen.has(name)) return [];
        seen.add(name);
        const id = element.getAttribute("data-sku-id") || element.getAttribute("data-sku") || element.getAttribute("data-id") || `option-${index}-${hash(name)}`;
        const stockText = matchFirst(name, /(?:库存|재고|stock)\s*[:：]?\s*(\d+)/i);
        const priceText = matchFirst(name, /(?:¥|￥|CNY)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
        return [{
          id,
          name,
          priceText: priceText ? `CNY ${priceText}` : void 0,
          stock: stockText ? Number(stockText) : void 0,
          selectedQuantity: state.selected.get(id) || 0
        }];
      }).slice(0, 40);
    }
    function collectStockTotal(bodyText) {
      const candidates = [
        ...document.querySelectorAll(
          '.counter-stock, [class*="stock" i], [class*="inventory" i], [class*="quantity-left" i]'
        )
      ].filter(isVisible).map((element) => normalizeLine(visibleText(element)));
      candidates.push(...bodyText.split(/\n+/).map(normalizeLine).filter((line) => /stock|库存|庫存|재고/i.test(line)));
      for (const text of candidates.reverse()) {
        const match = text.match(/([0-9][0-9,]*)\s*(?:pieces?\s+in\s+stock|개\s*(?:재고)?)/i) || text.match(/(?:stock|库存|庫存|재고)[^0-9]{0,16}([0-9][0-9,]*)/i);
        if (!match) continue;
        const value = Number(match[1].replace(/,/g, ""));
        if (Number.isFinite(value)) return Math.max(0, Math.round(value));
      }
      return void 0;
    }
    function detectPageKind(url, bodyText, itemId) {
      if (/d\.weidian\.com$/i.test(url.hostname) || /手机收银台|扫码.*支付|payment/i.test(bodyText)) return "payment";
      if (/确认订单|提交订单|Confirm Order|Submit Order/i.test(bodyText)) return "checkout";
      if (itemId || /Buy Now|立即购买|Add to Cart/i.test(bodyText)) return "product";
      if (/会员|VIP[1-6]|member/i.test(bodyText)) return "member";
      if (url.searchParams.has("userid")) return "store";
      return "unknown";
    }
    function detectSaleStatus(bodyText) {
      if (/未到开售时间|开售时间|판매 예정|coming soon/i.test(bodyText)) return "scheduled";
      if (/售罄|已售罄|품절|sold out/i.test(bodyText)) return "sold_out";
      if (/Buy Now|立即购买|马上抢|Add to Cart/i.test(bodyText)) return "on_sale";
      return "unknown";
    }
    function extractSaleTime(bodyText) {
      const match = bodyText.match(/(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (!match) return void 0;
      const [, year, month, day, hour, minute, second = "00"] = match;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}`;
    }
    function postObservation() {
      if (!state.snapshot) return;
      chrome.runtime.sendMessage({ type: "EW_OBSERVATION", payload: state.snapshot }, (result) => {
        if (chrome.runtime.lastError || !result?.state) return;
        const handledCommandIds = handleBridgeState(result.state);
        if (handledCommandIds.length) {
          chrome.runtime.sendMessage({ type: "EW_ACK_COMMANDS", ids: handledCommandIds }, () => void chrome.runtime.lastError);
        }
      });
    }
    function handleCommand(command) {
      const targetPageUrl = String(command.payload?.targetPageUrl || "").trim();
      if (targetPageUrl && (command.type === "execute-reservation" ? !matchesReservationTarget(targetPageUrl) : targetPageUrl !== location.href)) return false;
      if (command.type === "refresh") {
        location.reload();
        return true;
      }
      if (command.type === "open-options") {
        findOptionLauncher()?.click();
        return true;
      }
      if (command.type === "execute-reservation") {
        const context = {
          ...state.bridge?.context || {},
          reservationMode: command.payload?.mode === "checkout" ? "checkout" : "preview",
          reservationOptionKeyword: String(command.payload?.optionKeyword || ""),
          reservation: {
            ...state.bridge?.context?.reservation || {},
            targetServerTime: String(command.payload?.targetServerTime || ""),
            targetServerEpochMs: Date.now()
          }
        };
        void executeReservation(context, String(command.payload?.executionKey || command.id));
        return true;
      }
      if (command.type === "sync-vip-grades" || command.type === "refresh-action-token" || command.type === "get-action-token-status" || command.type === "save-vip-settings" || command.type === "reset-vip-settings") {
        void executeMemberCommand(command);
        return true;
      }
      if (command.type === "apply-member-preview") {
        void applyMemberPreview(memberPreviewFromCommand(command), { persist: false });
        return true;
      }
      if (command.type === "restore-member-preview") {
        restoreMemberPreview();
        return true;
      }
      if (command.type === "set-watermark") {
        updateWatermark();
        return true;
      }
      if (command.type === "save-representative-image") {
        downloadImages(state.snapshot?.imageUrls?.slice(0, 1) || []);
        return true;
      }
      if (command.type === "save-all-images") {
        downloadImages(state.snapshot?.imageUrls || []);
        return true;
      }
      return false;
    }
    async function autoSyncMemberRead() {
      const snapshot = state.snapshot;
      if (!snapshot || snapshot.pageKind !== "member" || !snapshot.shopId || state.memberCommandRunning || state.memberServerState?.shopId === snapshot.shopId) {
        return;
      }
      const readKey = `${location.origin}${location.pathname}:${snapshot.shopId}`;
      if (state.memberAutoReadKey === readKey) return;
      state.memberAutoReadKey = readKey;
      const commandId = `auto-member-read-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      state.memberCommandRunning = commandId;
      render();
      try {
        const observed = await requestPageMainMemberContext("EW_MEMBER_SYNC", commandId);
        const syncCommand = {
          id: commandId,
          type: "sync-vip-grades",
          createdAtIso: (/* @__PURE__ */ new Date()).toISOString(),
          payload: {
            shopId: observed.context.shopId,
            targetPageUrl: observed.context.pageUrl,
            clientRequestId: commandId
          }
        };
        const result = await sendRuntimeMessage({
          type: "EW_RUN_MEMBER_COMMAND",
          command: syncCommand,
          context: observed.context
        });
        if (!result?.ok || !result.memberServerState) {
          throw new Error(
            `${result?.errorCode || "MEMBER_READ_FAILED"}: ${result?.errorMessage || "Member \uD398\uC774\uC9C0 \uC77D\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4."}`
          );
        }
        state.memberServerState = result.memberServerState;
        state.snapshot = collectSnapshot();
        render();
        postObservation();
        void autoAcquireActionToken(observed.context);
      } catch (error) {
        state.memberAutoReadKey = "";
        console.warn(
          `[EW_MEMBER_READ] ${sanitizeConsoleMessage(error instanceof Error ? error.message : String(error))}`
        );
      } finally {
        state.memberCommandRunning = "";
        render();
      }
    }
    async function autoAcquireActionToken(context) {
      if (!state.memberServerState || state.memberServerState.shopId !== context.shopId || state.memberServerState.actionToken?.status !== "empty") {
        return;
      }
      const commandId = `auto-action-token-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const command = {
        id: commandId,
        type: "refresh-action-token",
        createdAtIso: (/* @__PURE__ */ new Date()).toISOString(),
        payload: {
          shopId: context.shopId,
          targetPageUrl: context.pageUrl,
          clientRequestId: commandId,
          action: "save-vip-settings"
        }
      };
      try {
        const result = await sendRuntimeMessage({
          type: "EW_RUN_MEMBER_COMMAND",
          command,
          context
        });
        if (result?.memberServerState) {
          state.memberServerState = result.memberServerState;
        } else if (result?.actionToken && state.memberServerState) {
          state.memberServerState = {
            ...state.memberServerState,
            actionToken: result.actionToken
          };
        }
        state.snapshot = collectSnapshot();
        render();
        postObservation();
      } catch (error) {
        console.warn(
          `[EW_ACTION_TOKEN_STATE] ${sanitizeConsoleMessage(error instanceof Error ? error.message : String(error))}`
        );
      }
    }
    async function executeMemberCommand(command) {
      if (state.memberCommandRunning) {
        toast("\uB2E4\uB978 Member \uBA85\uB839\uC774 \uC2E4\uD589 \uC911\uC785\uB2C8\uB2E4.", true);
        void reportMemberCommandError(
          command,
          "MEMBER_ACTION_ALREADY_RUNNING",
          "\uB2E4\uB978 Member \uBA85\uB839\uC774 \uC2E4\uD589 \uC911\uC785\uB2C8\uB2E4."
        );
        return;
      }
      state.memberCommandRunning = command.id;
      render();
      try {
        const observed = await requestPageMainMemberContext(memberRequestType(command.type), command.id);
        const result = await sendRuntimeMessage({
          type: "EW_RUN_MEMBER_COMMAND",
          command,
          context: observed.context
        });
        if (result?.memberServerState) {
          state.memberServerState = result.memberServerState;
        } else if (result?.actionToken && state.memberServerState) {
          state.memberServerState = {
            ...state.memberServerState,
            actionToken: result.actionToken
          };
        }
        state.snapshot = collectSnapshot();
        render();
        postObservation();
        if (result?.ok) {
          toast("Member \uBA85\uB839\uC774 \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        } else {
          toast(`${result?.errorCode || "UNKNOWN_MEMBER_ERROR"}: ${result?.errorMessage || "\uBA85\uB839\uC774 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4."}`, true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(message, true);
        await reportMemberCommandError(
          command,
          error?.code || errorCodeFromMessage(message),
          message
        ).catch(() => {
        });
      } finally {
        state.memberCommandRunning = "";
        render();
      }
    }
    function reportMemberCommandError(command, errorCode, errorMessage) {
      return sendRuntimeMessage({
        type: "EW_REPORT_MEMBER_COMMAND_ERROR",
        command,
        errorCode,
        errorMessage
      });
    }
    function errorCodeFromMessage(message) {
      return String(message).match(/^([A-Z][A-Z0-9_]+):/)?.[1] || "UNKNOWN_MEMBER_ERROR";
    }
    function requestPageMainMemberContext(type, requestId) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error("Page Main Script \uC751\uB2F5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."));
        }, 3e3);
        function onMessage(event) {
          if (event.source !== window || event.origin !== location.origin) return;
          const message = event.data;
          if (message?.source !== "EW_WEIDIAN_PAGE_MAIN" || message.requestId !== requestId) return;
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          if (message.type === "EW_MEMBER_RESULT" && message.observed?.context) {
            resolve(message.observed);
          } else {
            reject(new Error(`${message.errorCode || "UNKNOWN_MEMBER_ERROR"}: ${message.errorMessage || "Member \uCEE8\uD14D\uC2A4\uD2B8 \uAC10\uC9C0 \uC2E4\uD328"}`));
          }
        }
        window.addEventListener("message", onMessage);
        window.postMessage({
          source: "EW_WEIDIAN_CONTENT",
          type,
          requestId
        }, location.origin);
      });
    }
    function sendRuntimeMessage(message) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result);
        });
      });
    }
    function memberRequestType(commandType) {
      return {
        "sync-vip-grades": "EW_MEMBER_SYNC",
        "refresh-action-token": "EW_MEMBER_TOKEN_REFRESH",
        "get-action-token-status": "EW_MEMBER_TOKEN_STATUS",
        "save-vip-settings": "EW_MEMBER_SAVE",
        "reset-vip-settings": "EW_MEMBER_RESET"
      }[commandType] || "EW_MEMBER_SYNC";
    }
    function handleBridgeState(nextState) {
      state.bridge = nextState;
      syncMemberDraftFromBridge();
      updateWatermark();
      armReservation();
      const handledCommandIds = [];
      for (const command of nextState?.commands || []) {
        if (state.handledCommands.has(command.id)) {
          handledCommandIds.push(command.id);
          continue;
        }
        if (handleCommand(command)) {
          state.handledCommands.add(command.id);
          handledCommandIds.push(command.id);
        }
      }
      render();
      return handledCommandIds;
    }
    function armReservation() {
      const context = state.bridge?.context;
      const reservation = context?.reservation;
      if (!reservation?.running || !reservation.targetServerEpochMs) {
        clearTimeout(state.reservationTimer);
        state.reservationTimer = null;
        state.reservationKey = "";
        return;
      }
      if (document.visibilityState === "hidden") return;
      if (!matchesReservationTarget(reservation.targetPageUrl)) return;
      const key = `${reservation.targetServerEpochMs}:${context.reservationMode}:${context.reservationOptionKeyword}`;
      if (state.reservationKey === key) return;
      state.reservationKey = key;
      clearTimeout(state.reservationTimer);
      const localTarget = reservation.targetServerEpochMs - Number(context.serverOffsetMs || 0);
      const delay = localTarget - Date.now();
      if (delay < -3e4) return;
      state.reservationTimer = setTimeout(() => executeReservation(context, key), Math.max(0, delay));
    }
    async function executeReservation(context, executionKey = "") {
      const key = executionKey || `${context?.reservation?.targetServerEpochMs || 0}:${context?.reservationMode}:${context?.reservationOptionKeyword}`;
      if (state.executedReservations.has(key)) return;
      state.executedReservations.add(key);
      if (context.reservationMode === "preview") {
        findOptionLauncher()?.click();
        await wait(450);
        state.activeTab = "page";
        toast("\uBBF8\uB9AC\uBCF4\uAE30 \uC2DC\uAC04\uC774 \uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC7AC\uACE0\uC640 \uC635\uC158\uC744 \uC0C8\uB85C \uD655\uC778\uD588\uC2B5\uB2C8\uB2E4.");
        state.snapshot = collectSnapshot();
        render();
        postObservation();
        return;
      }
      const keyword = String(context.reservationOptionKeyword || "").trim();
      findOptionLauncher()?.click();
      await wait(350);
      if (keyword && !selectVisibleOption(keyword)) {
        toast(`\uC635\uC158\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${keyword}`, true);
        return;
      }
      const buy = findClickable(["Pay Now", "Buy Now", "\u7ACB\u5373\u8D2D\u4E70", "\u9A6C\u4E0A\u62A2", "\u7ACB\u5373\u62A2\u8D2D", "\u4E0B\u4E00\u6B65"]);
      if (!buy) {
        toast("\uAD6C\uB9E4 \uBC84\uD2BC\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", true);
        return;
      }
      buy.click();
      await wait(350);
      if (keyword) selectVisibleOption(keyword);
      const confirmBuy = findClickable(["\u786E\u5B9A", "\u786E\u8BA4", "Buy Now", "\u7ACB\u5373\u8D2D\u4E70", "\u4E0B\u4E00\u6B65"]);
      if (confirmBuy && !/提交订单|Submit Order/i.test(visibleText(confirmBuy))) confirmBuy.click();
    }
    function selectVisibleOption(keyword) {
      const normalized = keyword.toLowerCase();
      const element = [...document.querySelectorAll('button, [role="button"], li, [class*="sku"], [class*="spec"]')].filter((candidate) => visibleText(candidate).trim().toLowerCase() === normalized).find((candidate) => isVisible(candidate));
      element?.click();
      return Boolean(element);
    }
    function findOptionLauncher() {
      const skuButton = [...document.querySelectorAll('.sku-button, [class*="sku-button"], [class*="skuButton"]')].find((element) => isVisible(element));
      return skuButton || findClickable(["Please select the model", "\u8BF7\u9009\u62E9", "Select", "Buy Now", "\u7ACB\u5373\u8D2D\u4E70"]);
    }
    function matchesReservationTarget(targetPageUrl) {
      const raw = String(targetPageUrl || "").trim();
      if (!raw) return true;
      try {
        const target = new URL(raw);
        if (target.hostname === "k.youshop10.com") return true;
        const targetItemId = target.searchParams.get("itemID") || target.searchParams.get("itemId");
        return !targetItemId || targetItemId === state.snapshot?.itemId;
      } catch {
        return true;
      }
    }
    function findClickable(labels) {
      const elements = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
      return elements.find((element) => {
        if (!isVisible(element) || element.disabled) return false;
        const text = `${visibleText(element)} ${element.value || ""}`.trim();
        return labels.some((label) => text.toLowerCase().includes(label.toLowerCase()));
      });
    }
    async function applyMemberPreview(preview = currentMemberPreview(), options = {}) {
      const normalized = normalizeMemberPreview(preview);
      const levelLabel = normalized.levelLabel || `VIP${normalized.rank}`;
      state.memberDraft = normalized;
      state.memberDraftDirty = false;
      if (options.persist) {
        const saved = await saveMemberPreview(normalized);
        if (saved?.context) {
          state.bridge = { ...state.bridge || { ok: true }, context: saved.context };
        }
      }
      state.memberPreviewActive = true;
      renderMemberPreviewCard(normalized);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (host.contains(node) || memberPreviewCard.contains(node) || !node.nodeValue?.trim()) continue;
        const original = node.nodeValue;
        let next = original;
        for (const level of currentMemberLevels()) {
          if (level.label && level.label !== levelLabel) {
            next = replaceAllLiteral(next, level.label, levelLabel);
          }
        }
        next = next.replace(/VIP\s*[0-9]{1,2}/gi, levelLabel);
        next = next.replace(/\bV\s*[0-9]{1,2}\b/gi, levelLabel);
        next = next.replace(/\bLV\s*[0-9]{1,2}\b/gi, levelLabel);
        next = next.replace(
          /(?:会员等级|會員等級|회원등급|Member Level)[^\n]{0,30}/gi,
          (value) => value.replace(/VIP\s*[0-9]{1,2}|\bV\s*[0-9]{1,2}\b|\bLV\s*[0-9]{1,2}\b/gi, levelLabel)
        );
        next = next.replace(
          /(?:再消费|还需消费|升级还需|다음 등급까지|Next level)[^0-9\n]*[0-9.,]+/gi,
          (value) => value.replace(/[0-9.,]+/, String(normalized.nextValue))
        );
        if (next !== original) {
          if (!state.localPreviewOriginals.has(node)) state.localPreviewOriginals.set(node, original);
          node.nodeValue = next;
        }
      }
      render();
      if (!options.silent) toast(`${levelLabel} \xB7 ${normalized.name} \uB85C\uCEEC \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uC801\uC6A9\uD588\uC2B5\uB2C8\uB2E4.`);
    }
    function restoreMemberPreview() {
      for (const [node, value] of state.localPreviewOriginals) {
        if (node.isConnected) node.nodeValue = value;
      }
      state.localPreviewOriginals.clear();
      state.memberPreviewActive = false;
      memberPreviewCard.style.display = "none";
      toast("\uD68C\uC6D0\uB4F1\uAE09 \uB85C\uCEEC \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uBCF5\uC6D0\uD588\uC2B5\uB2C8\uB2E4.");
    }
    function updateWatermark() {
      const config = state.bridge?.context?.watermark;
      if (!config?.enabled) {
        watermark.textContent = "";
        watermark.remove();
        return;
      }
      if (!watermark.isConnected) document.documentElement.appendChild(watermark);
      watermark.style.display = "block";
      watermark.textContent = Array(40).fill(config.text || "\uB178\uBB34\uD604").join("   ");
    }
    function downloadImages(urls) {
      if (!urls.length) {
        toast("\uC800\uC7A5\uD560 \uC774\uBBF8\uC9C0\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", true);
        return;
      }
      const folder = `${state.snapshot?.shopName || state.snapshot?.shopId || "store"}-${state.snapshot?.itemId || "page"}`;
      chrome.runtime.sendMessage({ type: "EW_DOWNLOAD_IMAGES", urls, folder }, (result) => {
        if (chrome.runtime.lastError || !result?.ok) {
          toast("\uC774\uBBF8\uC9C0 \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", true);
        } else {
          toast(`\uC774\uBBF8\uC9C0 ${result.count}\uAC1C \uC800\uC7A5\uC744 \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.`);
        }
      });
    }
    function syncMemberDraftFromBridge() {
      if (!state.memberDraftDirty) {
        state.memberDraft = currentMemberPreview();
      }
    }
    function syncMemberDraftFromControl(event) {
      const target = event.target.closest?.("[data-member-field]");
      if (!target) return;
      const current = state.memberDraft || currentMemberPreview();
      const field = target.dataset.memberField;
      if (field === "levelId") {
        state.memberDraft = memberPreviewFromLevelId(target.value, current);
        state.memberDraftDirty = true;
        render();
        return;
      }
      state.memberDraft = normalizeMemberPreview({
        ...current,
        [field]: field === "nextValue" ? Number(target.value) : target.value
      });
      state.memberDraftDirty = true;
    }
    function readMemberDraftFromPanel() {
      const levelId = shadow.querySelector('[data-member-field="levelId"]')?.value;
      const name = shadow.querySelector('[data-member-field="name"]')?.value;
      const nextValue = shadow.querySelector('[data-member-field="nextValue"]')?.value;
      return normalizeMemberPreview({
        ...state.memberDraft || currentMemberPreview(),
        levelId,
        name,
        nextValue
      });
    }
    function memberPreviewFromCommand(command) {
      return normalizeMemberPreview(command.payload?.memberPreview || command.payload || currentMemberPreview());
    }
    function currentMemberPreview() {
      return normalizeMemberPreview(state.memberDraft || state.bridge?.context?.memberPreview || { levelId: "vip-1", levelLabel: "VIP1", rank: 1, name: "VIP1", nextValue: 0 });
    }
    function normalizeMemberPreview(preview) {
      const levels = currentMemberLevels();
      const requestedLevelId = String(preview?.levelId || "").trim();
      const rawRank = Number(preview?.rank);
      const requestedRank = Number.isFinite(rawRank) ? Math.min(99, Math.max(1, Math.round(rawRank))) : void 0;
      const selected = levels.find((level) => level.id === requestedLevelId) || levels.find((level) => level.rank === requestedRank) || levels[0] || { id: "vip-1", label: "VIP1", rank: 1 };
      const rank = requestedRank || selected.rank;
      const levelId = requestedLevelId || selected.id || `level-${rank}`;
      const levelLabel = String(preview?.levelLabel || selected.label || `VIP${rank}`).trim().slice(0, 80) || `VIP${rank}`;
      const name = String(preview?.name || levelLabel).trim().slice(0, 80) || levelLabel;
      const rawNextValue = Number(preview?.nextValue);
      const nextValue = Number.isFinite(rawNextValue) ? Math.max(0, rawNextValue) : 0;
      const shopId = String(preview?.shopId || state.snapshot?.shopId || "").trim() || void 0;
      const selectedIndex = Math.max(0, levels.findIndex((level) => level.id === levelId));
      const rawServerIndex = Number(preview?.serverIndex);
      const rawTargetIndex = Number(preview?.targetIndex);
      const serverIndex = Number.isInteger(rawServerIndex) && rawServerIndex >= 0 ? rawServerIndex : selectedIndex;
      const targetIndex = Number.isInteger(rawTargetIndex) && rawTargetIndex >= 0 ? rawTargetIndex : selectedIndex;
      const rawOriginalProgress = Number(preview?.originalProgress);
      const originalProgress = Number.isFinite(rawOriginalProgress) ? Math.max(0, rawOriginalProgress) : void 0;
      return { shopId, levelId, levelLabel, rank, name, nextValue, serverIndex, targetIndex, originalProgress };
    }
    function currentMemberLevels() {
      const source = (Array.isArray(state.bridge?.context?.memberLevels) && state.bridge.context.memberLevels.length ? state.bridge.context.memberLevels : null) || (Array.isArray(state.snapshot?.memberLevels) && state.snapshot.memberLevels.length ? state.snapshot.memberLevels : null) || defaultMemberLevels();
      const seen = /* @__PURE__ */ new Set();
      return source.flatMap((level, index) => {
        const label = String(level?.label || "").trim().slice(0, 80);
        if (!label) return [];
        const rankValue = Number(level?.rank);
        const rank = Number.isFinite(rankValue) ? Math.max(1, Math.min(99, Math.round(rankValue))) : index + 1;
        const id = String(level?.id || `${slug(label)}-${rank}`).trim() || `level-${rank}`;
        const key = id.toLowerCase();
        if (seen.has(key)) return [];
        seen.add(key);
        const minAmount = Number(level?.minAmount);
        return [{
          id,
          label,
          rank,
          minAmount: Number.isFinite(minAmount) ? Math.max(0, minAmount) : void 0,
          rawText: String(level?.rawText || "").trim().slice(0, 160) || void 0
        }];
      }).slice(0, 30);
    }
    function memberPreviewFromLevelId(levelId, base = currentMemberPreview()) {
      const levels = currentMemberLevels();
      const level = levels.find((item) => item.id === levelId) || levels[0] || { id: "vip-1", label: "VIP1", rank: 1 };
      return memberPreviewFromLevel(level, base);
    }
    function memberPreviewFromLevel(level, base = {}) {
      return normalizeMemberPreview({
        ...base,
        shopId: state.snapshot?.shopId || base.shopId,
        levelId: level.id,
        levelLabel: level.label,
        rank: level.rank,
        name: level.label
      });
    }
    function saveMemberPreview(preview) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "EW_SAVE_MEMBER_PREVIEW", preview }, (result) => {
          if (chrome.runtime.lastError || !result?.ok) {
            toast("\uD68C\uC6D0\uB4F1\uAE09 \uC124\uC815 \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC571 \uBE0C\uB9AC\uC9C0\uB97C \uD655\uC778\uD558\uC138\uC694.", true);
            resolve(null);
            return;
          }
          resolve(result);
        });
      });
    }
    function renderMemberPreviewCard(preview) {
      const normalized = normalizeMemberPreview(preview);
      memberPreviewCard.style.display = "grid";
      memberPreviewCard.innerHTML = `
      <div class="ew-member-card-title">\uB178\uBB34\uD604 \uD68C\uC6D0 \uB4F1\uAE09 \uBBF8\uB9AC\uBCF4\uAE30</div>
      <div class="ew-member-card-rank">${escapeHtml(normalized.levelLabel)}</div>
      <div class="ew-member-card-name">${escapeHtml(normalized.name)}</div>
      <div class="ew-member-card-next">\uB2E4\uC74C \uB4F1\uAE09\uAE4C\uC9C0 ${escapeHtml(String(normalized.nextValue))}</div>
      <div class="ew-member-card-safe">\uB85C\uCEEC \uD654\uBA74 \uD45C\uC2DC \uC804\uC6A9</div>
    `;
    }
    function render() {
      const snapshot = state.snapshot || collectSnapshot();
      const bridgeConnected = Boolean(state.bridge?.ok);
      const reservation = state.bridge?.context?.reservation;
      const options = snapshot.options || [];
      panel.innerHTML = `
      <header>
        <strong><span class="logo">\u5E97</span> \uB178\uBB34\uD604</strong>
        <div class="header-actions">
          <span class="chip ${bridgeConnected ? "ok" : ""}">${bridgeConnected ? "\uC5F0\uACB0\uB428" : "\uC571 \uB300\uAE30"}</span>
          <button data-action="close">\u2212</button>
        </div>
      </header>
      <nav>
        ${tabButton("page", "\uD398\uC774\uC9C0")}
        ${tabButton("all", "\uC804\uCCB4 \uC0C1\uD488")}
        ${tabButton("member", "\uD68C\uC6D0 \uB4F1\uAE09")}
        ${tabButton("watermark", "\uC6CC\uD130\uB9C8\uD06C")}
      </nav>
      <section class="body">
        ${state.activeTab === "page" ? renderPage(snapshot, reservation, options) : ""}
        ${state.activeTab === "all" ? renderAll(snapshot) : ""}
        ${state.activeTab === "member" ? renderMember() : ""}
        ${state.activeTab === "watermark" ? renderWatermark() : ""}
      </section>
    `;
    }
    function renderPage(snapshot, reservation, options) {
      const statusLabel = {
        on_sale: "\uD310\uB9E4 \uC911",
        scheduled: "\uD310\uB9E4 \uC608\uC815",
        sold_out: "\uD488\uC808",
        unknown: "\uD655\uC778 \uBD88\uAC00"
      }[snapshot.saleStatus] || "\uD655\uC778 \uBD88\uAC00";
      return `
      <h2>${escapeHtml(snapshot.productTitle || snapshot.pageTitle || "Weidian \uD398\uC774\uC9C0")}</h2>
      <p class="muted">${escapeHtml(snapshot.shopName || "\uC0C1\uC810 \uBBF8\uD655\uC778")} \xB7 \uC0C1\uD488 ${escapeHtml(snapshot.itemId || "-")}</p>
      <div class="metrics">
        <div><span>\uD310\uB9E4\uAC00</span><b>${escapeHtml(snapshot.priceText || "-")}</b></div>
        <div><span>\uC7AC\uACE0</span><b>${knownStock(snapshot.stockTotal, options)}</b></div>
        <div><span>\uC635\uC158</span><b>${options.length}\uAC1C</b></div>
      </div>
      <div class="sale-line"><span class="chip ok">${statusLabel}</span><span>${escapeHtml(snapshot.saleTimeIso || "")}</span><button data-action="refresh">\uC7AC\uACE0 \uC0C8\uB85C\uACE0\uCE68</button></div>
      ${reservation?.running ? renderReservation(reservation) : ""}
      <div class="option-list">
        ${options.length ? options.map(renderOption).join("") : '<p class="muted">\uD398\uC774\uC9C0\uC5D0\uC11C \uD655\uC778 \uAC00\uB2A5\uD55C \uC635\uC158\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</p>'}
      </div>
      <div class="quick-grid">
        <button data-action="copy-url">URL \uBCF5\uC0AC</button>
        <button data-action="save-main-image">\uB300\uD45C \uC774\uBBF8\uC9C0 \uC800\uC7A5</button>
        <button data-action="save-all-images">\uC804\uCCB4 \uC774\uBBF8\uC9C0 \uC800\uC7A5</button>
        <button data-action="confirm-options">\uC120\uD0DD \uC635\uC158 \uD655\uC815 \xB7 \uCD1D ${selectedTotal()}\uAC1C</button>
      </div>
      ${snapshot.pageKind === "checkout" ? '<button class="danger full" data-action="manual-submit-order">\uC8FC\uBB38 \uC0DD\uC131(\uC218\uB3D9 \uD655\uC778)</button>' : ""}
      ${snapshot.pageKind === "payment" ? '<div class="safe">QR \uC2A4\uCE94\uACFC \uCD5C\uC885 \uACB0\uC81C \uC2B9\uC778\uC740 \uD734\uB300\uC804\uD654\uC5D0\uC11C \uC9C1\uC811 \uC9C4\uD589\uD558\uC138\uC694.</div>' : ""}
    `;
    }
    function renderReservation(reservation) {
      const target = new Date(reservation.targetServerEpochMs).toLocaleString("ko-KR");
      const remaining = Math.max(0, reservation.targetServerEpochMs - Date.now() - Number(state.bridge?.context?.serverOffsetMs || 0));
      return `<div class="reservation"><span>${escapeHtml(reservation.phase)}</span><b>${target}</b><strong>${formatRemaining(remaining)}</strong></div>`;
    }
    function renderOption(option) {
      const quantity = state.selected.get(option.id) || 0;
      return `
      <div class="option">
        <div><b>${escapeHtml(option.name)}</b><small>${escapeHtml(option.priceText || "")} ${option.stock === void 0 ? "" : `\xB7 \uC7AC\uACE0 ${option.stock}`}</small></div>
        <div class="qty">
          <button data-action="qty" data-id="${escapeAttr(option.id)}" data-delta="-1">\u2212</button>
          <span>${quantity}</span>
          <button data-action="qty" data-id="${escapeAttr(option.id)}" data-delta="1">+</button>
        </div>
      </div>
    `;
    }
    function renderAll(snapshot) {
      return `
      <h2>\uD604\uC7AC \uD398\uC774\uC9C0 \uC774\uBBF8\uC9C0</h2>
      <p class="muted">${snapshot.imageUrls.length}\uAC1C\uB97C \uCC3E\uC558\uC2B5\uB2C8\uB2E4.</p>
      <div class="image-grid">${snapshot.imageUrls.slice(0, 12).map((url) => `<img src="${escapeAttr(url)}">`).join("")}</div>
      <button class="full" data-action="save-all-images">\uC804\uCCB4 \uC774\uBBF8\uC9C0 \uC800\uC7A5</button>
    `;
    }
    function renderMember() {
      const preview = currentMemberPreview();
      const levels = currentMemberLevels();
      const server = state.memberServerState;
      const token = server?.actionToken;
      const writeAdapter = server?.writeAdapter;
      return `
      <div class="safe">\uC2E4\uC81C Member \uC77D\uAE30\uC640 actionToken \uAD00\uCC30\uC740 \uD65C\uC131\uD654\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. \uC4F0\uAE30 endpoint\uAC00 \uC5C6\uC73C\uBA74 \uC800\uC7A5 \uB2E8\uACC4\uB9CC \uCC28\uB2E8\uB429\uB2C8\uB2E4.</div>
      <p class="muted">\uD604\uC7AC \uC0C1\uC810\uC5D0\uC11C \uC0AC\uC6A9\uD560 \uB4F1\uAE09 ${levels.length}\uAC1C\uB97C \uD45C\uC2DC\uD569\uB2C8\uB2E4.</p>
      ${server ? `
        <div class="reservation">
          <span>\uC2B9\uC778 Member \uC0C1\uD0DC</span>
          <b>${escapeHtml(server.name)} \xB7 serverIndex ${server.serverIndex}</b>
          <small>${escapeHtml(server.readSource || "weidian-page")} \xB7 gradeNames ${escapeHtml(server.gradeNames.join(", "))}</small>
          <small>actionToken ${escapeHtml(token?.status || "empty")} \xB7 fingerprint ${escapeHtml(token?.tokenFingerprint || "-")}</small>
          <small>\uC4F0\uAE30 API ${escapeHtml(writeAdapter?.errorCode || writeAdapter?.status || "MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED")}</small>
        </div>
      ` : ""}
      ${state.memberCommandRunning ? '<p class="muted">Member \uBA85\uB839 \uC2E4\uD589 \uC911\u2026</p>' : ""}
      <label>\uC801\uC6A9\uD560 \uB4F1\uAE09
        <select data-member-field="levelId">
          ${levels.map((level) => `<option value="${escapeAttr(level.id)}" ${level.id === preview.levelId ? "selected" : ""}>${escapeHtml(level.label)}${level.minAmount === void 0 ? "" : ` \xB7 ${escapeHtml(String(level.minAmount))}`}</option>`).join("")}
        </select>
      </label>
      <label>\uD45C\uC2DC \uC774\uB984<input data-member-field="name" value="${escapeAttr(preview.name)}"></label>
      <label>\uB2E4\uC74C \uB4F1\uAE09\uAE4C\uC9C0<input data-member-field="nextValue" type="number" min="0" value="${preview.nextValue}"></label>
      <div class="quick-grid">
        <button data-action="apply-member">\uC800\uC7A5 \uD6C4 \uC801\uC6A9</button>
        <button data-action="restore-member">\uC6D0\uB798\uB300\uB85C</button>
      </div>
    `;
    }
    function renderWatermark() {
      const config = state.bridge?.context?.watermark || { enabled: false, text: "\uB178\uBB34\uD604" };
      return `
      <h2>\uC6CC\uD130\uB9C8\uD06C</h2>
      <p class="muted">\uB370\uC2A4\uD06C\uD1B1 \uC571\uC5D0\uC11C \uC124\uC815\uD569\uB2C8\uB2E4.</p>
      <label>\uC0C1\uD0DC<input value="${config.enabled ? "\uCF1C\uC9D0" : "\uAEBC\uC9D0"}" disabled></label>
      <label>\uBB38\uAD6C<input value="${escapeAttr(config.text)}" disabled></label>
    `;
    }
    function tabButton(id, label) {
      return `<button class="${state.activeTab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}</button>`;
    }
    function toast(message, error = false) {
      let element = shadow.querySelector(".toast");
      if (!element) {
        element = document.createElement("div");
        element.className = "toast";
        shadow.appendChild(element);
      }
      element.textContent = message;
      element.classList.toggle("error", error);
      element.classList.add("show");
      clearTimeout(element.hideTimer);
      element.hideTimer = setTimeout(() => element.classList.remove("show"), 2800);
    }
    function selectedTotal() {
      return [...state.selected.values()].reduce((sum, value) => sum + value, 0);
    }
    function knownStock(stockTotal, options) {
      if (Number.isFinite(stockTotal)) return String(stockTotal);
      const known = options.filter((option) => Number.isFinite(option.stock));
      if (!known.length) return "\uD655\uC778 \uBD88\uAC00";
      return String(known.reduce((sum, option) => sum + option.stock, 0));
    }
    function visibleText(element) {
      return element?.innerText || element?.textContent || "";
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style2 = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style2.visibility !== "hidden" && style2.display !== "none";
    }
    function matchFirst(value, pattern) {
      return value.match(pattern)?.[1];
    }
    function hash(value) {
      let result = 0;
      for (let index = 0; index < value.length; index++) result = (result << 5) - result + value.charCodeAt(index) | 0;
      return Math.abs(result).toString(36);
    }
    function slug(value) {
      const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9가-힣\u4e00-\u9fff-]+/g, "").slice(0, 40);
      return normalized || `level-${hash(String(value || "level"))}`;
    }
    function replaceAllLiteral(value, needle, replacement) {
      if (!needle || needle === replacement) return value;
      return String(value).split(needle).join(replacement);
    }
    function wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function formatRemaining(ms) {
      const total = Math.ceil(ms / 1e3);
      const days = Math.floor(total / 86400);
      const hours = Math.floor(total % 86400 / 3600);
      const minutes = Math.floor(total % 3600 / 60);
      const seconds = total % 60;
      return `${days ? `${days}\uC77C ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]);
    }
    function escapeAttr(value) {
      return escapeHtml(value);
    }
    function sanitizeConsoleMessage(value) {
      return String(value || "").replace(
        /\b(actionToken|accessToken|refreshToken|cookie|authorization|sessionId|session|token|ct)\b\s*[:=]\s*([^\s,;]+)/gi,
        "$1=[REDACTED]"
      ).slice(0, 400);
    }
    function overlayCss() {
      return `
      :host { all: initial; }
      .ew-panel { position: fixed; z-index: 2147483646; top: 18px; right: 18px; width: 366px; max-height: calc(100vh - 36px); overflow: hidden; color: #f4f6f8; background: #101114; border: 1px solid #353942; border-radius: 12px; box-shadow: 0 16px 42px rgba(0,0,0,.38); font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      header { display:flex; align-items:center; justify-content:space-between; padding:12px 13px; border-bottom:1px solid #2d3037; }
      header strong { display:flex; align-items:center; gap:8px; }
      .logo { display:grid; place-items:center; width:23px; height:23px; border-radius:5px; background:#2675df; font-weight:800; }
      .header-actions { display:flex; gap:7px; align-items:center; }
      button { border:1px solid #3b3f48; border-radius:6px; min-height:30px; padding:0 10px; color:#e8ebef; background:#191b20; cursor:pointer; font:inherit; }
      button:hover { border-color:#667180; background:#21242a; }
      nav { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; padding:8px; border-bottom:1px solid #2d3037; }
      nav button { padding:0 4px; border-color:transparent; background:transparent; }
      nav button.active { border-color:#555b67; background:#24272e; }
      .body { max-height:calc(100vh - 128px); overflow:auto; padding:13px; }
      h2 { margin:0 0 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15px; }
      p { margin:0; }
      .muted { color:#8d949e; font-size:11px; }
      .chip { display:inline-flex; align-items:center; min-height:22px; border:1px solid #555b67; border-radius:5px; padding:0 7px; color:#a7adb6; font-size:10px; font-weight:700; }
      .chip.ok { border-color:#276e4f; color:#78d3a6; background:#10261d; }
      .metrics { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:12px 0; }
      .metrics div { display:grid; gap:3px; padding:9px; border:1px solid #30343b; border-radius:7px; background:#15171b; }
      .metrics span { color:#878e98; font-size:10px; }
      .sale-line { display:flex; align-items:center; gap:7px; margin-bottom:10px; }
      .sale-line > span:nth-child(2) { flex:1; color:#9ba2ac; font-size:10px; }
      .sale-line button { min-height:27px; font-size:10px; }
      .option-list { display:grid; gap:6px; margin:9px 0; }
      .option { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; padding:9px; border:1px solid #343841; border-radius:8px; background:#15171a; }
      .option b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
      .option small { display:block; margin-top:3px; color:#78c99f; font-size:10px; }
      .qty { display:grid; grid-template-columns:28px 28px 28px; align-items:center; text-align:center; }
      .qty button { min-height:28px; padding:0; }
      .quick-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:10px; }
      .quick-grid button:last-child:nth-child(odd) { grid-column:1 / -1; }
      .full { width:100%; margin-top:9px; }
      .danger { border-color:#8d423e; color:#ffd3cf; background:#381a19; }
      .safe { margin:9px 0; border:1px solid #276e4f; border-radius:7px; padding:9px; color:#88d9ad; background:#10261d; font-size:11px; }
      .reservation { display:grid; gap:4px; margin:9px 0; border:1px solid #4b5972; border-radius:8px; padding:10px; background:#151b25; }
      .reservation span { color:#8faee3; font-size:10px; text-transform:uppercase; }
      .reservation strong { color:#fff; font-size:20px; }
      label { display:grid; gap:4px; margin-top:9px; color:#9ba2ac; font-size:11px; }
      input, select { min-height:34px; border:1px solid #383c44; border-radius:6px; padding:0 9px; color:#eef0f3; background:#15171a; }
      .image-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:10px 0; }
      .image-grid img { width:100%; aspect-ratio:1; object-fit:cover; border-radius:6px; background:#222; }
      .toast { position:fixed; z-index:2147483647; right:30px; bottom:28px; max-width:340px; transform:translateY(20px); opacity:0; border:1px solid #34765a; border-radius:7px; padding:10px 12px; color:#dff7ea; background:#143323; box-shadow:0 8px 24px rgba(0,0,0,.3); font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; transition:.18s ease; pointer-events:none; }
      .toast.show { transform:translateY(0); opacity:1; }
      .toast.error { border-color:#8c4642; color:#ffd7d4; background:#351b1a; }
    `;
    }
    const pageWatermarkStyle = document.createElement("style");
    pageWatermarkStyle.textContent = `
    #ew-weidian-watermark {
      position: fixed;
      z-index: 2147483645;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      color: rgba(45, 71, 103, .13);
      font: 15px/120px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      word-spacing: 48px;
      transform: rotate(-18deg) scale(1.25);
      transform-origin: center;
      white-space: pre-wrap;
    }
    #ew-weidian-member-preview {
      position: fixed;
      z-index: 2147483645;
      top: 72px;
      left: 22px;
      display: none;
      gap: 4px;
      min-width: 184px;
      border: 1px solid rgba(58, 191, 124, .55);
      border-radius: 10px;
      padding: 12px 14px;
      color: #ecfff4;
      background: rgba(15, 37, 27, .88);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .24);
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
    #ew-weidian-member-preview .ew-member-card-title {
      color: #8fe7b7;
      font-size: 10px;
      font-weight: 800;
    }
    #ew-weidian-member-preview .ew-member-card-rank {
      color: #ffffff;
      font-size: 28px;
      font-weight: 900;
      letter-spacing: 0;
    }
    #ew-weidian-member-preview .ew-member-card-name {
      color: #d4fce4;
      font-weight: 800;
    }
    #ew-weidian-member-preview .ew-member-card-next,
    #ew-weidian-member-preview .ew-member-card-safe {
      color: #a8d9bd;
      font-size: 11px;
    }
  `;
    document.documentElement.appendChild(pageWatermarkStyle);
  })();
})();
