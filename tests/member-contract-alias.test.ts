import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBrowserCommandType,
  parseMemberDetailPageRoute
} from '../src/common/memberContract';
import { validateMemberPageContext } from '../extension/src/member/member-context';

const shopId = '1680489787';

test('Member 상세 index 및 index.html 경로에서 shopId를 읽는다', () => {
  assert.equal(
    parseMemberDetailPageRoute(`https://h5.weidian.com/m/mkt-h5-member-detail/index?shopId=${shopId}`)?.shopId,
    shopId
  );
  assert.equal(
    parseMemberDetailPageRoute(`https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=${shopId}`)?.shopId,
    shopId
  );
});

test('유사 경로, shopId 누락 및 비 Weidian origin은 거부한다', () => {
  assert.equal(
    parseMemberDetailPageRoute(`https://h5.weidian.com/m/mkt-h5-member-detail/other?shopId=${shopId}`),
    undefined
  );
  assert.equal(
    parseMemberDetailPageRoute('https://h5.weidian.com/m/mkt-h5-member-detail/index'),
    undefined
  );
  assert.equal(
    parseMemberDetailPageRoute(`https://example.com/m/mkt-h5-member-detail/index?shopId=${shopId}`),
    undefined
  );
});

test('save_vip_grades 별칭은 기존 save-vip-settings 명령으로 정규화한다', () => {
  assert.equal(normalizeBrowserCommandType('save_vip_grades'), 'save-vip-settings');
  assert.equal(normalizeBrowserCommandType('sync-vip-grades'), 'sync-vip-grades');
});

test('Member context의 shopId는 페이지 query와 일치해야 한다', () => {
  const valid = validateMemberPageContext({
    origin: 'https://h5.weidian.com',
    pageUrl: `https://h5.weidian.com/m/mkt-h5-member-detail/index?shopId=${shopId}`,
    shopId,
    sessionFingerprint: 'session-a',
    currentServerIndex: 2,
    gradeCount: 3,
    gradeNames: ['VIP1', 'VIP2', 'VIP3']
  });
  assert.equal(valid.shopId, shopId);
  assert.throws(
    () => validateMemberPageContext({ ...valid, shopId: '2098765432' }),
    /Member 상세 페이지/
  );
});
