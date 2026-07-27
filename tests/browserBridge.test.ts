import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserBridgeService,
  isAllowedExtensionOrigin,
  normalizeBrowserObservation
} from '../src/main/browserBridge';
import { BrowserReservationRunner } from '../src/main/browserReservation';
import { extractWeidianUrl } from '../src/common/weidianUrl';
import type { AppLogger } from '../src/main/logger';
import { redactMessage, redactSensitiveData } from '../src/main/logger';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as AppLogger;

test('Chrome 확장 프로그램 origin만 로컬 브리지에 허용한다', () => {
  assert.equal(isAllowedExtensionOrigin('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef'), true);
  assert.equal(isAllowedExtensionOrigin('https://weidian.com'), false);
  assert.equal(isAllowedExtensionOrigin('null'), false);
  assert.equal(isAllowedExtensionOrigin(undefined), false);
});

test('Electron 명령 payload는 actionToken 계열 민감 필드를 재귀적으로 차단한다', () => {
  const bridge = new BrowserBridgeService(0, logger, {
    extensionPath: '/tmp/extension',
    getContext: () => ({
      serverOffsetMs: 0,
      watermark: { enabled: false, text: '' },
      memberPreview: {
        levelId: 'level-1',
        levelLabel: 'VIP1',
        rank: 1,
        name: 'VIP1',
        nextValue: 0,
        serverIndex: 0,
        targetIndex: 0
      },
      memberLevels: [],
      memberApi: {
        baseUrl: 'http://127.0.0.1:4173',
        stateEndpoint: '/api/member/context',
        actionTokenEndpoint: '/api/member/action-token',
        saveEndpoint: '/api/member/save',
        resetEndpoint: '/api/member/reset'
      },
      reservation: { running: false, phase: 'idle', message: '' },
      reservationOptionKeyword: '',
      reservationMode: 'preview'
    })
  });

  assert.throws(
    () => bridge.queueCommand('save-vip-settings', {
      shopId: 'shop-1',
      nested: { actionToken: 'raw-secret' }
    }),
    /민감정보 actionToken/
  );
  assert.equal(
    bridge.queueCommand('save-vip-settings', {
      shopId: 'shop-1',
      tokenFingerprint: 'sha256:1234'
    }).type,
    'save-vip-settings'
  );
});

test('중앙 로그 마스킹은 객체와 문자열의 토큰·세션 원문을 제거한다', () => {
  assert.deepEqual(
    redactSensitiveData({
      actionToken: 'raw-secret',
      nested: { cookie: 'sid=secret', tokenFingerprint: 'sha256:1234' }
    }),
    {
      actionToken: '[REDACTED]',
      nested: { cookie: '[REDACTED]', tokenFingerprint: 'sha256:1234' }
    }
  );
  const redacted = redactMessage('actionToken=raw-secret cookie: sid=secret 정상');
  assert.equal(redacted.includes('raw-secret'), false);
  assert.equal(redacted.includes('sid=secret'), false);
});

test('Weidian 페이지 관찰 데이터를 정규화하고 다른 호스트를 거부한다', () => {
  const snapshot = normalizeBrowserObservation({
    pageUrl: 'https://weidian.com/item.html?itemID=123456789',
    pageTitle: 'Sample',
    pageKind: 'product',
    itemId: '123456789',
    stockTotal: 17647,
    imageUrls: ['https://si.geilicdn.com/sample.jpg', 'javascript:alert(1)'],
    options: [
      { id: 'sku-1', name: 'black M', stock: 12, selectedQuantity: 1 },
      { name: '' }
    ],
    memberLevels: [
      { id: 'gold-3', label: '黄金会员', rank: 3, minAmount: 500 },
      { id: 'bad', label: '', rank: 9 }
    ]
  });

  assert.equal(snapshot.pageKind, 'product');
  assert.equal(snapshot.itemId, '123456789');
  assert.equal(snapshot.stockTotal, 17647);
  assert.deepEqual(snapshot.imageUrls, ['https://si.geilicdn.com/sample.jpg']);
  assert.equal(snapshot.options.length, 1);
  assert.equal(snapshot.options[0].stock, 12);
  assert.deepEqual(snapshot.memberLevels, [{ id: 'gold-3', label: '黄金会员', rank: 3, minAmount: 500, rawText: undefined }]);

  assert.throws(
    () => normalizeBrowserObservation({ pageUrl: 'https://example.com/item.html', pageKind: 'product' }),
    /Weidian HTTPS/
  );
});

test('브라우저 예약은 주문 확인과 결제 대기 상태를 구분한다', () => {
  const events: string[] = [];
  const runner = new BrowserReservationRunner(logger, {
    getServerOffsetMs: () => 1_000,
    onStatus: (status) => events.push(status.phase)
  });
  const target = new Date(Date.now() + 500).toISOString();
  const started = runner.start({
    url: 'https://weidian.com/item.html?itemID=123456789',
    targetServerTime: target,
    optionKeyword: 'black M',
    mode: 'checkout'
  });
  assert.equal(started.phase, 'armed');

  runner.handleSnapshot({
    pageUrl: 'https://weidian.com/order/confirm',
    pageTitle: '确认订单',
    pageKind: 'checkout',
    observedAtIso: new Date().toISOString(),
    imageUrls: [],
    options: [],
    memberLevels: []
  });
  assert.equal(runner.getStatus().phase, 'checkout');
  assert.equal(runner.getStatus().running, true);

  runner.handleSnapshot({
    pageUrl: 'https://d.weidian.com/payment',
    pageTitle: '收银台',
    pageKind: 'payment',
    observedAtIso: new Date().toISOString(),
    imageUrls: [],
    options: [],
    memberLevels: []
  });
  assert.equal(runner.getStatus().phase, 'completed');
  assert.equal(runner.getStatus().running, false);
  assert.deepEqual(events, ['armed', 'checkout', 'completed']);
});

test('브라우저 예약은 k.youshop10.com 공유 주소를 허용한다', () => {
  const runner = new BrowserReservationRunner(logger, {
    getServerOffsetMs: () => 0
  });
  const started = runner.start({
    url: 'https://k.youshop10.com/afclDVRc?a=b&p=iphone',
    targetServerTime: new Date(Date.now() + 60_000).toISOString(),
    optionKeyword: '',
    mode: 'preview'
  });
  assert.equal(started.phase, 'armed');
  runner.stop();
});

test('예약 시각 전에는 이미 열려 있던 주문 확인 탭을 결과로 오인하지 않는다', () => {
  const runner = new BrowserReservationRunner(logger, {
    getServerOffsetMs: () => 0
  });
  runner.start({
    url: 'https://weidian.com/item.html?itemID=123456789',
    targetServerTime: new Date(Date.now() + 60_000).toISOString(),
    optionKeyword: '',
    mode: 'checkout'
  });
  runner.handleSnapshot({
    pageUrl: 'https://weidian.com/buy/add-order/index.php?items=999_1_1_',
    pageTitle: '确认订单',
    pageKind: 'checkout',
    observedAtIso: new Date().toISOString(),
    imageUrls: [],
    options: [],
    memberLevels: []
  });
  assert.equal(runner.getStatus().phase, 'armed');
  runner.stop();
});

test('설명문과 함께 붙여넣은 Weidian 공유 주소를 추출한다', () => {
  const parsed = extractWeidianUrl(
    '（所有人可购买）socho ATom AR棉服 https://k.youshop10.com/afclDVRc?a=b&p=iphone&wfr=BuyercopyURL'
  );
  assert.equal(
    parsed.toString(),
    'https://k.youshop10.com/afclDVRc?a=b&p=iphone&wfr=BuyercopyURL'
  );
  assert.throws(() => extractWeidianUrl('상품명만 있고 주소는 없음'), /URL을 찾지 못했습니다/);
  assert.throws(() => extractWeidianUrl('https://example.com/item/1'), /Weidian HTTPS/);
});

test('예약 시각이 되면 브라우저 실행 훅을 정확히 한 번 호출한다', async () => {
  const executed: string[] = [];
  const runner = new BrowserReservationRunner(logger, {
    getServerOffsetMs: () => 0,
    onExecute: (request) => executed.push(request.mode)
  });
  runner.start({
    url: 'https://weidian.com/item.html?itemID=123456789',
    targetServerTime: new Date(Date.now() + 35).toISOString(),
    optionKeyword: '',
    mode: 'preview'
  });
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(runner.getStatus().phase, 'opening');
  assert.deepEqual(executed, ['preview']);
  runner.stop();
});
