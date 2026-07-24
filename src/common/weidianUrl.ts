const WEIDIAN_URL_PATTERN = /https:\/\/[^\s<>"'`]+/i;

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
