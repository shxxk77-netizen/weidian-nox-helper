// @ts-nocheck
(() => {
  if (window.top !== window || document.documentElement.dataset.ewMemberSimulatorLoaded === '1') return;
  document.documentElement.dataset.ewMemberSimulatorLoaded = '1';

  const STORAGE_KEY = 'ewMemberPreviewSimulationByShop';
  const SIMULATOR_ID = 'ew-member-preview-simulator-badge';
  const CARD_SELECTOR = [
    '[class*="member-card" i]',
    '[class*="memberCard" i]',
    '[class*="vip-card" i]',
    '[class*="vipCard" i]',
    '[class*="card-info" i]',
    '[class*="member-info" i]',
    '[class*="level-card" i]',
    '[class*="levelCard" i]'
  ].join(',');

  const RANK_PROFILES = new Map([
    [1, { discountRate: 1, gradient: 'linear-gradient(135deg, #f7f7f7, #dedede)', foreground: '#242424', accent: '#777777' }],
    [2, { discountRate: 0.98, gradient: 'linear-gradient(135deg, #edf1f5, #bcc8d4)', foreground: '#24303b', accent: '#7d8d9c' }],
    [3, { discountRate: 0.95, gradient: 'linear-gradient(135deg, #ffe9aa, #f6ba56)', foreground: '#4c3510', accent: '#c98c25' }],
    [4, { discountRate: 0.89, gradient: 'linear-gradient(135deg, #d7ebff, #79b4f5)', foreground: '#173556', accent: '#3b82c4' }],
    [5, { discountRate: 0.86, gradient: 'linear-gradient(135deg, #ddd3ff, #8d75df)', foreground: '#24194d', accent: '#6549bd' }],
    [6, { discountRate: 0.82, gradient: 'linear-gradient(135deg, #383b43, #101116)', foreground: '#f7f0dc', accent: '#c7a86b' }]
  ]);

  const state = {
    bridge: null,
    active: false,
    preview: null,
    shopId: '',
    processedCommands: new Set(),
    originalText: new Map(),
    originalStyle: new Map(),
    originalDataset: new Map(),
    baseDiscountRate: undefined,
    ownsMemberText: false,
    applying: false,
    scheduledTimer: null,
    lastHref: location.href
  };

  installSimulatorStyle();

  const port = chrome.runtime.connect({ name: 'EW_WEIDIAN_PORT' });
  port.onMessage.addListener((message) => {
    if (message?.type === 'EW_BRIDGE_STATE') handleBridgeState(message.state);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'EW_BRIDGE_STATE') return false;
    handleBridgeState(message.state);
    sendResponse({ ok: true });
    return false;
  });

  document.addEventListener('click', handleCompanionPanelClick, true);
  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('hashchange', handleNavigation);

  const observer = new MutationObserver(() => {
    if (location.href !== state.lastHref) handleNavigation();
    if (state.active && !state.applying) scheduleApply(100);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  setInterval(() => {
    if (state.active) scheduleApply(0);
    else void restoreStoredPreview();
  }, 1_500);

  void restoreStoredPreview();

  function handleBridgeState(nextState) {
    state.bridge = nextState;
    for (const command of nextState?.commands || []) {
      if (!command?.id || state.processedCommands.has(command.id)) continue;
      if (command.type === 'apply-member-preview') {
        state.processedCommands.add(command.id);
        const preview = command.payload?.memberPreview || command.payload || nextState?.context?.memberPreview;
        void activatePreview(preview, { remember: true, ownsMemberText: state.ownsMemberText });
      } else if (command.type === 'restore-member-preview') {
        state.processedCommands.add(command.id);
        void deactivatePreview({ forget: true });
      }
    }
    if (!state.active) void restoreStoredPreview(nextState?.context?.memberPreview?.shopId);
  }

  function handleCompanionPanelClick(event) {
    const actionElement = (event.composedPath?.() || []).find((entry) => entry?.dataset?.action);
    const action = actionElement?.dataset?.action;
    if (action !== 'apply-member' && action !== 'restore-member') return;
    setTimeout(() => {
      if (action === 'restore-member') {
        void deactivatePreview({ forget: true });
        return;
      }
      const host = document.getElementById('ew-weidian-host');
      const root = host?.shadowRoot;
      if (!root) return;
      const levelSelect = root.querySelector('[data-member-field="levelId"]');
      const selectedText = String(levelSelect?.selectedOptions?.[0]?.textContent || '').split('·')[0].trim();
      const rank = rankFromText(selectedText) || Number(String(levelSelect?.value || '').match(/(\d{1,2})/)?.[1]) || 1;
      const preview = {
        shopId: resolveShopId(),
        levelId: String(levelSelect?.value || `vip-${rank}`),
        levelLabel: selectedText || `VIP${rank}`,
        rank,
        name: String(root.querySelector('[data-member-field="name"]')?.value || selectedText || `VIP${rank}`),
        nextValue: Number(root.querySelector('[data-member-field="nextValue"]')?.value || 0),
        serverIndex: rank - 1,
        targetIndex: rank - 1
      };
      void activatePreview(preview, { remember: true, ownsMemberText: state.ownsMemberText });
    }, 0);
  }

  async function activatePreview(rawPreview, options = {}) {
    const preview = normalizePreview(rawPreview);
    const shopId = resolveShopId(preview.shopId);
    if (!shopId) return;
    preview.shopId = shopId;
    state.preview = preview;
    state.shopId = shopId;
    state.active = true;
    state.ownsMemberText = Boolean(options.ownsMemberText);
    if (options.remember) await saveStoredPreview(shopId, preview);
    scheduleApply(0);
  }

  async function deactivatePreview(options = {}) {
    restoreOriginalDom();
    const shopId = state.shopId || resolveShopId();
    state.active = false;
    state.preview = null;
    state.shopId = '';
    state.baseDiscountRate = undefined;
    state.ownsMemberText = false;
    removeBadge();
    if (options.forget && shopId) await deleteStoredPreview(shopId);
  }

  async function restoreStoredPreview(preferredShopId = '') {
    if (state.active) return;
    const shopId = resolveShopId(preferredShopId);
    if (!shopId) return;
    const stored = await readStoredPreviews();
    const entry = stored[shopId];
    if (!entry?.enabled || !entry.preview) return;
    await activatePreview(entry.preview, { remember: false, ownsMemberText: true });
  }

  function scheduleApply(delayMs) {
    clearTimeout(state.scheduledTimer);
    state.scheduledTimer = setTimeout(applySimulation, delayMs);
  }

  function applySimulation() {
    if (!state.active || !state.preview || state.applying || !document.body) return;
    state.applying = true;
    try {
      if (!isSimulationEligiblePage()) {
        restoreOriginalDom();
        removeBadge();
        return;
      }
      pruneDisconnectedOriginals();
      const preview = state.preview;
      const targetProfile = profileForRank(preview.rank);
      const baseDiscountRate = getBaseDiscountRate(preview);
      const priceRatio = baseDiscountRate > 0 ? targetProfile.discountRate / baseDiscountRate : 1;
      const targetDiscountText = formatDiscount(targetProfile.discountRate);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue?.trim() || isSimulatorNode(node)) continue;
        const source = state.originalText.get(node) ?? node.nodeValue;
        let next = source;
        if (/\d+(?:\.\d+)?\s*折/.test(source)) {
          next = replaceDiscounts(next, targetDiscountText);
        }
        if (containsCurrency(source) && isLikelyPriceNode(node, source)) {
          next = replaceCurrencyAmounts(next, priceRatio);
        }
        if (state.ownsMemberText) {
          next = replaceMemberText(next, preview, baseDiscountRate);
        }
        if (next !== node.nodeValue) {
          if (!state.originalText.has(node)) state.originalText.set(node, source);
          node.nodeValue = next;
        }
      }
      applyCardTheme(preview, targetProfile);
      renderBadge(preview, targetDiscountText);
    } finally {
      state.applying = false;
    }
  }

  function replaceMemberText(text, preview, baseDiscountRate) {
    let next = text;
    next = next.replace(/VIP\s*[0-9]{1,2}/gi, preview.levelLabel);
    next = next.replace(/\bV\s*[0-9]{1,2}\b/gi, preview.levelLabel);
    next = next.replace(/\bLV\s*[0-9]{1,2}\b/gi, preview.levelLabel);
    next = next.replace(/(?:再消费|还需消费|升级还需|다음 등급까지|Next level)[^0-9\n]*[0-9.,]+/gi, (value) =>
      value.replace(/[0-9.,]+/, formatNumber(preview.nextValue))
    );
    const baseRank = rankForDiscount(baseDiscountRate);
    if (baseRank && baseRank !== preview.rank && next.trim() === String(baseRank)) {
      next = next.replace(String(baseRank), String(preview.rank));
    }
    return next;
  }

  function applyCardTheme(preview, profile) {
    const candidates = collectCardCandidates(preview);
    for (const element of candidates.slice(0, 4)) {
      if (!state.originalStyle.has(element)) state.originalStyle.set(element, element.getAttribute('style'));
      if (!state.originalDataset.has(element)) {
        state.originalDataset.set(element, {
          card: element.dataset.ewSimCard,
          rank: element.dataset.ewSimRank
        });
      }
      element.dataset.ewSimCard = '1';
      element.dataset.ewSimRank = String(preview.rank);
      element.style.backgroundImage = profile.gradient;
      element.style.color = profile.foreground;
      element.style.borderColor = profile.accent;
      element.style.boxShadow = `0 12px 30px color-mix(in srgb, ${profile.accent} 28%, transparent)`;
      if (getComputedStyle(element).position === 'static') element.style.position = 'relative';
    }
  }

  function collectCardCandidates(preview) {
    const direct = [...document.querySelectorAll(CARD_SELECTOR)].filter(isVisibleCard);
    const labelled = [...document.querySelectorAll('div, section, article, li')].filter((element) => {
      if (!isVisibleCard(element)) return false;
      const text = String(element.textContent || '').slice(0, 800);
      if (!/(会员|會員|VIP|member|등급)/i.test(text)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 180 && rect.height >= 70 && rect.height <= 420;
    });
    const preferred = [...direct, ...labelled].filter((element, index, all) => all.indexOf(element) === index);
    return preferred.sort((left, right) => {
      const leftText = String(left.textContent || '');
      const rightText = String(right.textContent || '');
      const leftScore = Number(leftText.includes(preview.levelLabel)) + Number(/当前|현재|current/i.test(leftText));
      const rightScore = Number(rightText.includes(preview.levelLabel)) + Number(/当前|현재|current/i.test(rightText));
      return rightScore - leftScore;
    });
  }

  function restoreOriginalDom() {
    state.applying = true;
    try {
      for (const [node, original] of state.originalText) {
        if (node.isConnected) node.nodeValue = original;
      }
      for (const [element, original] of state.originalStyle) {
        if (!element.isConnected) continue;
        if (original === null) element.removeAttribute('style');
        else element.setAttribute('style', original);
      }
      for (const [element, original] of state.originalDataset) {
        if (!element.isConnected) continue;
        if (original.card === undefined) delete element.dataset.ewSimCard;
        else element.dataset.ewSimCard = original.card;
        if (original.rank === undefined) delete element.dataset.ewSimRank;
        else element.dataset.ewSimRank = original.rank;
      }
      state.originalText.clear();
      state.originalStyle.clear();
      state.originalDataset.clear();
    } finally {
      state.applying = false;
    }
  }

  function handleNavigation() {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;
    restoreOriginalDom();
    state.baseDiscountRate = undefined;
    if (state.active) scheduleApply(350);
    else void restoreStoredPreview();
  }

  function getBaseDiscountRate(preview) {
    if (Number.isFinite(state.baseDiscountRate)) return state.baseDiscountRate;
    state.baseDiscountRate = detectDiscountRate();
    if (!Number.isFinite(state.baseDiscountRate)) {
      const serverIndex = Number(preview.serverIndex);
      const baseRank = Number.isInteger(serverIndex) && serverIndex >= 0 ? serverIndex + 1 : detectCurrentRank();
      state.baseDiscountRate = profileForRank(baseRank || preview.rank).discountRate;
    }
    return state.baseDiscountRate;
  }

  function detectDiscountRate() {
    const matches = String(document.body?.innerText || '').matchAll(/(\d+(?:\.\d+)?)\s*折/g);
    for (const match of matches) {
      const numeric = Number(match[1]);
      if (numeric >= 5 && numeric <= 10) return numeric / 10;
    }
    return undefined;
  }

  function detectCurrentRank() {
    const text = String(document.body?.innerText || '');
    return rankFromText(text.match(/VIP\s*([0-9]{1,2})/i)?.[0] || '');
  }

  function profileForRank(rawRank) {
    const rank = Math.max(1, Math.min(99, Math.round(Number(rawRank) || 1)));
    if (RANK_PROFILES.has(rank)) return RANK_PROFILES.get(rank);
    const discountRate = Math.max(0.7, 1 - (rank - 1) * 0.03);
    return {
      discountRate,
      gradient: 'linear-gradient(135deg, #ececec, #bdbdbd)',
      foreground: '#202020',
      accent: '#777777'
    };
  }

  function rankForDiscount(rate) {
    if (!Number.isFinite(rate)) return undefined;
    let best;
    for (const [rank, profile] of RANK_PROFILES) {
      const distance = Math.abs(profile.discountRate - rate);
      if (!best || distance < best.distance) best = { rank, distance };
    }
    return best?.distance <= 0.015 ? best.rank : undefined;
  }

  function replaceDiscounts(text, targetDiscountText) {
    return text.replace(/(\d+(?:\.\d+)?)\s*折/g, (whole, raw) => {
      const numeric = Number(raw);
      return numeric >= 5 && numeric <= 10 ? targetDiscountText : whole;
    });
  }

  function replaceCurrencyAmounts(text, ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return text;
    return text
      .replace(/([¥￥]\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g, (_whole, prefix, raw) =>
        `${prefix}${formatPrice(raw, ratio)}`
      )
      .replace(/\b(CNY|RMB)(\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi, (_whole, currency, gap, raw) =>
        `${currency}${gap}${formatPrice(raw, ratio)}`
      );
  }

  function formatPrice(raw, ratio) {
    const numeric = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(numeric)) return raw;
    const originalDecimals = String(raw).split('.')[1]?.length || 0;
    const decimals = Math.max(originalDecimals, 2);
    return trimTrailingZeros((numeric * ratio).toFixed(decimals));
  }

  function formatDiscount(rate) {
    return `${trimTrailingZeros((rate * 10).toFixed(2))}折`;
  }

  function trimTrailingZeros(value) {
    return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }

  function formatNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? trimTrailingZeros(numeric.toFixed(2)) : '0';
  }

  function isSimulationEligiblePage() {
    const url = new URL(location.href);
    if (/(?:cashier|confirm-order|create-order|payment|pay-h5)/i.test(`${url.hostname}${url.pathname}`)) return false;
    const bodyText = String(document.body?.innerText || document.body?.textContent || '').slice(0, 80_000);
    return /(?:member|mkt-h5-member-detail|decoration\/uni-mine)/i.test(url.pathname) ||
      /(?:会员卡详情|会员尊享|会员等级|会员权益|會員等級|VIP[0-9]|회원등급)/i.test(bodyText);
  }

  function containsCurrency(text) {
    return /[¥￥]|\b(?:CNY|RMB)\b/i.test(text);
  }

  function isLikelyPriceNode(node, source) {
    const parent = node.parentElement;
    if (!parent || source.length > 120) return false;
    const context = `${parent.id || ''} ${parent.className || ''} ${parent.parentElement?.className || ''}`;
    if (/(progress|growth|remaining|threshold|shipping|postage|stock|inventory|成长|进度|消费|包邮|库存)/i.test(context)) {
      return false;
    }
    return /(price|amount|pay|total|sale|discount|coupon|member|vip|benefit|sku|item)/i.test(context) || source.trim().length <= 24;
  }

  function isSimulatorNode(node) {
    const element = node.parentElement;
    return Boolean(element?.closest(`#${SIMULATOR_ID}, #ew-weidian-host, #ew-weidian-member-preview`));
  }

  function isVisibleCard(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function normalizePreview(rawPreview) {
    const rank = Math.max(1, Math.min(99, Math.round(Number(rawPreview?.rank) || rankFromText(rawPreview?.levelLabel) || 1)));
    const levelLabel = String(rawPreview?.levelLabel || `VIP${rank}`).trim().slice(0, 80) || `VIP${rank}`;
    return {
      shopId: String(rawPreview?.shopId || '').trim() || undefined,
      levelId: String(rawPreview?.levelId || `vip-${rank}`).trim() || `vip-${rank}`,
      levelLabel,
      rank,
      name: String(rawPreview?.name || levelLabel).trim().slice(0, 80) || levelLabel,
      nextValue: Math.max(0, Number(rawPreview?.nextValue) || 0),
      serverIndex: Number.isInteger(Number(rawPreview?.serverIndex)) ? Number(rawPreview.serverIndex) : rank - 1,
      targetIndex: Number.isInteger(Number(rawPreview?.targetIndex)) ? Number(rawPreview.targetIndex) : rank - 1
    };
  }

  function rankFromText(value) {
    const numeric = String(value || '').match(/(?:VIP|LV|V)?\s*([0-9]{1,2})/i)?.[1];
    return numeric ? Number(numeric) : undefined;
  }

  function resolveShopId(preferred = '') {
    const direct = String(preferred || state.preview?.shopId || state.bridge?.context?.memberPreview?.shopId || '').trim();
    if (/^\d{6,20}$/.test(direct)) return direct;
    const url = new URL(location.href);
    const query = url.searchParams.get('shopId') || url.searchParams.get('shopid') || url.searchParams.get('userid') || url.searchParams.get('userId');
    if (/^\d{6,20}$/.test(String(query || ''))) return String(query);
    const bodyText = String(document.body?.innerText || document.body?.textContent || '').slice(0, 100_000);
    return bodyText.match(/(?:shop|店铺|상점)\s*(?:ID)?\s*[:：]?\s*(\d{6,20})/i)?.[1] || '';
  }

  async function readStoredPreviews() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const value = result?.[STORAGE_KEY];
    return value && typeof value === 'object' ? value : {};
  }

  async function saveStoredPreview(shopId, preview) {
    const stored = await readStoredPreviews();
    stored[shopId] = {
      enabled: true,
      savedAtEpochMs: Date.now(),
      preview: normalizePreview({ ...preview, shopId })
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: stored });
  }

  async function deleteStoredPreview(shopId) {
    const stored = await readStoredPreviews();
    delete stored[shopId];
    await chrome.storage.local.set({ [STORAGE_KEY]: stored });
  }

  function pruneDisconnectedOriginals() {
    for (const node of state.originalText.keys()) if (!node.isConnected) state.originalText.delete(node);
    for (const element of state.originalStyle.keys()) if (!element.isConnected) state.originalStyle.delete(element);
    for (const element of state.originalDataset.keys()) if (!element.isConnected) state.originalDataset.delete(element);
  }

  function renderBadge(preview, discountText) {
    let badge = document.getElementById(SIMULATOR_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = SIMULATOR_ID;
      document.documentElement.appendChild(badge);
    }
    badge.textContent = `${preview.levelLabel} · ${discountText} · LOCAL SIM`;
  }

  function removeBadge() {
    document.getElementById(SIMULATOR_ID)?.remove();
  }

  function installSimulatorStyle() {
    if (document.getElementById('ew-member-preview-simulator-style')) return;
    const style = document.createElement('style');
    style.id = 'ew-member-preview-simulator-style';
    style.textContent = `
      #${SIMULATOR_ID} {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483646;
        padding: 7px 10px;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 999px;
        background: rgba(12,13,17,.86);
        color: #fff;
        font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.28);
        backdrop-filter: blur(10px);
        pointer-events: none;
      }
      [data-ew-sim-card="1"] { overflow: hidden !important; }
      [data-ew-sim-card="1"]::after {
        content: attr(data-ew-sim-rank);
        position: absolute;
        right: 18px;
        top: 50%;
        transform: translateY(-50%);
        font: 800 86px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: rgba(255,255,255,.28);
        text-shadow: 0 1px 0 rgba(0,0,0,.08);
        pointer-events: none;
      }
    `;
    document.documentElement.appendChild(style);
  }
})();
