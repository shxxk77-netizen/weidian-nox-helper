const WEIDIAN_URL_PATTERN = /https:\/\/[^\s<>"'`]+/i;
const MEMBER_PAGE_PATH = '/m/mkt-h5-member-detail/index.html';
const SHOP_ID_PATTERN = /^\d{6,20}$/;

export function extractWeidianUrl(rawValue: string): URL {
  const raw = String(rawValue || '').trim();
  const candidate = raw.match(WEIDIAN_URL_PATTERN)?.[0] || raw;
  const cleaned = candidate.replace(/[)\]}>，。；、]+$/u, '');
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('입력 내용에서 Weidian 상품 URL을 찾지 못했습니다.');
  }
  if (
    parsed.protocol !== 'https:' ||
    (!/(^|\.)weidian\.com$/i.test(parsed.hostname) && !/^k\.youshop10\.com$/i.test(parsed.hostname))
  ) {
    throw new Error('Weidian HTTPS 주소 또는 k.youshop10.com 공유 주소만 사용할 수 있습니다.');
  }
  return parsed;
}

export function extractShopIdFromWeidianUrl(url: URL): string | undefined {
  const queryShopId =
    url.searchParams.get('shopId') ||
    url.searchParams.get('shopid') ||
    url.searchParams.get('userId') ||
    url.searchParams.get('userid');
  if (queryShopId && SHOP_ID_PATTERN.test(queryShopId)) return queryShopId;
  const hostnameShopId = url.hostname.match(/^shop(\d{6,20})\.v\.weidian\.com$/i)?.[1];
  return hostnameShopId && SHOP_ID_PATTERN.test(hostnameShopId) ? hostnameShopId : undefined;
}

export function isWeidianMemberPage(url: URL): boolean {
  return /\/m\/mkt-h5-member-detail\/index(?:\.html)?\/?$/i.test(url.pathname);
}

export function buildWeidianMemberPageUrl(shopId: string): URL {
  const normalizedShopId = String(shopId || '').trim();
  if (!SHOP_ID_PATTERN.test(normalizedShopId)) {
    throw new Error('Member 페이지를 열려면 6~20자리 shopId가 필요합니다.');
  }
  const memberUrl = new URL(`https://h5.weidian.com${MEMBER_PAGE_PATH}`);
  memberUrl.searchParams.set('shopId', normalizedShopId);
  return memberUrl;
}

export function resolveWeidianMemberPageUrl(
  rawValue: string,
  detectedShopId?: string
): {
  sourceUrl: URL;
  memberUrl?: URL;
  shopId?: string;
} {
  const sourceUrl = extractWeidianUrl(rawValue);
  const urlShopId = extractShopIdFromWeidianUrl(sourceUrl);
  const normalizedDetectedShopId = String(detectedShopId || '').trim();
  const shopId =
    urlShopId ||
    (SHOP_ID_PATTERN.test(normalizedDetectedShopId) ? normalizedDetectedShopId : undefined);

  if (isWeidianMemberPage(sourceUrl) && !shopId) {
    throw new Error('Member 링크에서 shopId를 확인하지 못했습니다.');
  }

  return {
    sourceUrl,
    memberUrl: shopId ? buildWeidianMemberPageUrl(shopId) : undefined,
    shopId
  };
}
