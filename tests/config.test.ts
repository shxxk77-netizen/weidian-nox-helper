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
