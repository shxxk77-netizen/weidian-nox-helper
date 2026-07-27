import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore, createDefaultSettings } from '../src/common/config';

test('워터마크는 기본으로 꺼져 있고 문구가 비어 있다', () => {
  const settings = createDefaultSettings();

  assert.equal(settings.browserWatermarkEnabled, false);
  assert.equal(settings.browserWatermarkText, '');
});

test('기존 은우짱짱123 워터마크 설정은 자동으로 제거한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-helper-config-'));
  const filePath = path.join(directory, 'config.json');

  try {
    fs.writeFileSync(filePath, JSON.stringify({
      browserWatermarkEnabled: true,
      browserWatermarkText: '은우짱짱123'
    }));

    const settings = new ConfigStore(filePath).get();

    assert.equal(settings.browserWatermarkEnabled, false);
    assert.equal(settings.browserWatermarkText, '');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
      settings
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('이전 앱 이름 워터마크도 자동으로 제거한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-helper-config-'));
  const filePath = path.join(directory, 'config.json');

  try {
    fs.writeFileSync(filePath, JSON.stringify({
      browserWatermarkEnabled: true,
      browserWatermarkText: '노무현'
    }));

    const settings = new ConfigStore(filePath).get();

    assert.equal(settings.browserWatermarkEnabled, false);
    assert.equal(settings.browserWatermarkText, '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Member API URL과 endpoint 설정을 정규화해 저장한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-helper-config-'));
  const filePath = path.join(directory, 'config.json');

  try {
    fs.writeFileSync(filePath, JSON.stringify({
      browserMemberApi: {
        baseUrl: 'http://127.0.0.1:5188/',
        stateEndpoint: '/member/context',
        actionTokenEndpoint: '/member/token',
        saveEndpoint: 'https://thor.weidian.com/member/save',
        resetEndpoint: '/member/reset'
      }
    }));

    const settings = new ConfigStore(filePath).get();

    assert.deepEqual(settings.browserMemberApi, {
      baseUrl: 'https://thor.weidian.com',
      catalogEndpoint: '/wdcrm/trade.searchMemberByShopId/1.0',
      saveEndpoint: '/wdcrm/trade.setMemberLevel/2.0',
      bulkSaveEndpoint: '/wdcrm/trade.setMemberLevelWithSearchCondition/2.0',
      verifyEndpoint: '/wdcrm/customer.summary.pc/1.0'
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
