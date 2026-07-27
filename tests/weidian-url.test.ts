import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWeidianMemberPageUrl,
  extractShopIdFromWeidianUrl,
  isWeidianMemberPage,
  resolveWeidianMemberPageUrl
} from '../src/common/weidianUrl';

test('판매 페이지 query의 shopId로 canonical Member 주소를 만든다', () => {
  const resolved = resolveWeidianMemberPageUrl(
    'https://weidian.com/item.html?itemID=987654321&userid=123456789'
  );
  assert.equal(resolved.shopId, '123456789');
  assert.equal(
    resolved.memberUrl?.toString(),
    'https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=123456789'
  );
});

test('shopId가 없는 판매 링크는 페이지 감지 전까지 원본만 반환한다', () => {
  const sourceOnly = resolveWeidianMemberPageUrl(
    'https://weidian.com/item.html?itemID=987654321'
  );
  assert.equal(sourceOnly.memberUrl, undefined);

  const detected = resolveWeidianMemberPageUrl(
    'https://weidian.com/item.html?itemID=987654321',
    '123456789'
  );
  assert.equal(detected.shopId, '123456789');
  assert.equal(
    detected.memberUrl?.toString(),
    'https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=123456789'
  );
});

test('Member index와 index.html 경로를 모두 판별한다', () => {
  const withoutHtml = new URL(
    'https://h5.weidian.com/m/mkt-h5-member-detail/index?shopId=123456789'
  );
  assert.equal(isWeidianMemberPage(withoutHtml), true);
  assert.equal(extractShopIdFromWeidianUrl(withoutHtml), '123456789');
  assert.equal(
    buildWeidianMemberPageUrl('123456789').pathname,
    '/m/mkt-h5-member-detail/index.html'
  );
});
