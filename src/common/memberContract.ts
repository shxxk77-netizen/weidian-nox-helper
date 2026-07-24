import type { BrowserCommandAlias, BrowserCommandType } from './types';

export const MEMBER_DETAIL_PAGE_PATH =
  /^\/m\/mkt-h5-member-detail\/index(?:\.html)?\/?$/i;

export interface MemberDetailPageRoute {
  url: URL;
  shopId: string;
}

export function parseMemberDetailPageRoute(value: string | URL): MemberDetailPageRoute | undefined {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== 'https:' ||
    !/(^|\.)weidian\.com$/i.test(url.hostname) ||
    !MEMBER_DETAIL_PAGE_PATH.test(url.pathname)
  ) {
    return undefined;
  }

  const shopId = (url.searchParams.get('shopId') || url.searchParams.get('shopid') || '').trim();
  if (!/^\d{6,20}$/.test(shopId)) return undefined;

  return { url, shopId };
}

export function normalizeBrowserCommandType(
  type: BrowserCommandType | BrowserCommandAlias
): BrowserCommandType {
  return type === 'save_vip_grades' ? 'save-vip-settings' : type;
}
