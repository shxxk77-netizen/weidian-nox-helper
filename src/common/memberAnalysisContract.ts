export const MEMBER_API_BASE_URL = 'https://thor.weidian.com';

export const MEMBER_API_ENDPOINTS = Object.freeze({
  catalog: '/wdcrm/trade.searchMemberByShopId/1.0',
  save: '/wdcrm/trade.setMemberLevel/2.0',
  bulkSave: '/wdcrm/trade.setMemberLevelWithSearchCondition/2.0',
  verify: '/wdcrm/customer.summary.pc/1.0'
});

export interface MemberApiConnectionSettings {
  baseUrl: string;
  catalogEndpoint: string;
  saveEndpoint: string;
  bulkSaveEndpoint: string;
  verifyEndpoint: string;
}

export const DEFAULT_MEMBER_API_CONNECTION: Readonly<MemberApiConnectionSettings> =
  Object.freeze({
    baseUrl: MEMBER_API_BASE_URL,
    catalogEndpoint: MEMBER_API_ENDPOINTS.catalog,
    saveEndpoint: MEMBER_API_ENDPOINTS.save,
    bulkSaveEndpoint: MEMBER_API_ENDPOINTS.bulkSave,
    verifyEndpoint: MEMBER_API_ENDPOINTS.verify
  });

export const MEMBER_API_HEADERS = Object.freeze({
  accept: 'application/json, text/plain, */*'
});

export const MEMBER_SAVE_ENDPOINT =
  resolveMemberApiUrl(DEFAULT_MEMBER_API_CONNECTION.baseUrl, DEFAULT_MEMBER_API_CONNECTION.saveEndpoint);

export interface MemberSaveRequestBody {
  shopId: string;
  buyerIds: string[];
  memberId: string;
  selectedServerIndex: number | string;
  selectedGradeName: string;
}

const MEMBER_SAVE_BODY_TEMPLATE: MemberSaveRequestBody = {
  shopId: '<SHOP_ID>',
  buyerIds: ['<BUYER_ID>'],
  memberId: '<MEMBER_LEVEL_ID>',
  selectedServerIndex: '<SELECTED_INDEX>',
  selectedGradeName: '<SELECTED_GRADE_NAME>'
};

/**
 * UI에서 보여 주는 요청 미리보기다. `_selection`은 사람이 확인하기 위한
 * 메타데이터이며 실제 Weidian 요청의 `param`에는 buyerIds/memberId만 들어간다.
 */
export function createMemberSaveRequestJson(
  payload: MemberSaveRequestBody
): string {
  return JSON.stringify({
    _: '<TIMESTAMP_MS>',
    param: {
      buyerIds: payload.buyerIds,
      memberId: payload.memberId
    },
    wdtoken: '<WDTOKEN>',
    _selection: {
      shopId: payload.shopId,
      serverIndex: payload.selectedServerIndex,
      gradeName: payload.selectedGradeName
    }
  }, null, 2);
}

export function createMemberSaveCurl(
  payload: MemberSaveRequestBody,
  connection: MemberApiConnectionSettings = DEFAULT_MEMBER_API_CONNECTION
): string {
  const saveUrl = resolveMemberApiUrl(connection.baseUrl, connection.saveEndpoint);
  const param = JSON.stringify({
    buyerIds: payload.buyerIds,
    memberId: payload.memberId
  });
  return [
    `curl --get ${shellQuote(saveUrl)}`,
    `  --header ${shellQuote(`Accept: ${MEMBER_API_HEADERS.accept}`)}`,
    `  --header ${shellQuote('Origin: https://h5.weidian.com')}`,
    `  --header ${shellQuote(`Referer: https://h5.weidian.com/m/mkt-h5-member-detail/index?shopId=${payload.shopId}`)}`,
    `  --cookie ${shellQuote('<CHROME_SESSION_COOKIE>')}`,
    `  --data-urlencode ${shellQuote('_=<TIMESTAMP_MS>')}`,
    `  --data-urlencode ${shellQuote(`param=${param}`)}`,
    `  --data-urlencode ${shellQuote('wdtoken=<WDTOKEN>')}`
  ].join(' \\\n');
}

export const MEMBER_SAVE_CURL_TEMPLATE =
  createMemberSaveCurl(MEMBER_SAVE_BODY_TEMPLATE);

export function createMemberSaveCurlTemplate(
  connection: MemberApiConnectionSettings
): string {
  return createMemberSaveCurl(MEMBER_SAVE_BODY_TEMPLATE, connection);
}

export function resolveMemberApiUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
