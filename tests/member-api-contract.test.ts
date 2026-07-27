import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMemberApiContractObservation } from '../src/common/memberApiContract';

test('실제 값 없이 POST 계약과 cURL 템플릿을 생성한다', () => {
  const contract = normalizeMemberApiContractObservation({
    source: 'page-main',
    pageUrl: 'https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=123456789',
    shopId: '123456789',
    observation: {
      observerVersion: 1,
      observedAtIso: '2026-07-27T01:02:03.000Z',
      transport: 'fetch',
      method: 'POST',
      url: 'https://thor.weidian.com/wdcrm/member/save/1.0?actionToken=raw-secret',
      queryKeys: ['actionToken'],
      queryShape: {
        actionToken: 'raw-secret'
      },
      requestHeaderNames: ['content-type', 'cookie'],
      requestHeaderMetadata: {
        contentType: 'application/json',
        origin: 'https://h5.weidian.com',
        referer: 'https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=123456789'
      },
      requestBodyShape: {
        shopId: 'string',
        targetIndex: 'number'
      },
      tokenPlacement: 'query',
      status: 200,
      responseBodyShape: {
        ok: 'boolean',
        serverIndex: 'number'
      }
    }
  });

  assert.equal(contract.url, 'https://thor.weidian.com/wdcrm/member/save/1.0');
  assert.equal(contract.method, 'POST');
  assert.equal(contract.page, 'https://h5.weidian.com/m/mkt-h5-member-detail/index.html');
  assert.equal(contract.chromeSessionCookie, true);
  assert.equal(contract.tokenPlacement, 'query');
  assert.match(contract.curlTemplate, /curl --request POST/);
  assert.match(contract.curlTemplate, /actionToken=<ACTION_TOKEN>/);
  assert.match(contract.curlTemplate, /<CHROME_SESSION_COOKIE>/);
  assert.match(contract.curlTemplate, /<SHOP_ID>/);
  assert.doesNotMatch(JSON.stringify(contract), /raw-secret/);
});

test('Weidian 외부 endpoint 관찰은 거부한다', () => {
  assert.throws(
    () => normalizeMemberApiContractObservation({
      method: 'POST',
      url: 'https://example.com/member/save'
    }),
    /Weidian HTTPS endpoint/
  );
});
