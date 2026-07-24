import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, BrowserMemberLevel, BrowserMemberPreview, SavedStore } from './types';

export function createDefaultSettings(): AppSettings {
  return {
    timeSyncUrl: 'https://weidian.com/',
    timeSyncSampleCount: 5,
    targetServerTime: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
    browserUrl: '',
    browserExecutable: 'chrome',
    browserCompactWindow: true,
    browserBridgePort: 17873,
    browserWatermarkEnabled: false,
    browserWatermarkText: '',
    browserMemberPreviewRank: 1,
    browserMemberPreviewLevelId: 'vip-1',
    browserMemberPreviewName: 'VIP1',
    browserMemberNextValue: 0,
    browserMemberLevelsByShop: {},
    browserMemberPreviewByShop: {},
    browserReservationOptionKeyword: '',
    browserReservationMode: 'preview',
    savedStores: []
  };
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  get(): AppSettings {
    const defaults = createDefaultSettings();
    if (!fs.existsSync(this.filePath)) {
      this.write(defaults);
      return defaults;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      const normalized = normalizeSettings(parsed, defaults);
      this.write(normalized);
      return normalized;
    } catch {
      this.write(defaults);
      return defaults;
    }
  }

  save(patch: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const next = normalizeSettings({ ...current, ...patch }, createDefaultSettings());
    this.write(next);
    return next;
  }

  private write(settings: AppSettings): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(settings, null, 2));
  }
}

function normalizeSettings(input: Partial<AppSettings>, defaults: AppSettings): AppSettings {
  return {
    timeSyncUrl: input.timeSyncUrl?.trim() || defaults.timeSyncUrl,
    timeSyncSampleCount: Math.round(clamp(Number(input.timeSyncSampleCount ?? defaults.timeSyncSampleCount), 1, 9)),
    targetServerTime: normalizeTargetTime(input.targetServerTime, defaults.targetServerTime),
    browserUrl: input.browserUrl?.trim() ?? defaults.browserUrl,
    browserExecutable: 'chrome',
    browserCompactWindow: Boolean(input.browserCompactWindow ?? defaults.browserCompactWindow),
    browserBridgePort: Math.round(clamp(Number(input.browserBridgePort ?? defaults.browserBridgePort), 1024, 65_535)),
    browserWatermarkEnabled: isLegacyWatermarkText(input.browserWatermarkText)
      ? false
      : Boolean(input.browserWatermarkEnabled ?? defaults.browserWatermarkEnabled),
    browserWatermarkText: normalizeWatermarkText(input.browserWatermarkText, defaults.browserWatermarkText),
    browserMemberPreviewRank: Math.round(clamp(Number(input.browserMemberPreviewRank ?? defaults.browserMemberPreviewRank), 1, 99)),
    browserMemberPreviewLevelId: input.browserMemberPreviewLevelId?.trim() || defaults.browserMemberPreviewLevelId,
    browserMemberPreviewName: input.browserMemberPreviewName?.trim() || defaults.browserMemberPreviewName,
    browserMemberNextValue: finiteNonNegative(input.browserMemberNextValue ?? defaults.browserMemberNextValue),
    browserMemberLevelsByShop: normalizeLevelsByShop(input.browserMemberLevelsByShop),
    browserMemberPreviewByShop: normalizePreviewByShop(input.browserMemberPreviewByShop),
    browserReservationOptionKeyword: input.browserReservationOptionKeyword?.trim() ?? defaults.browserReservationOptionKeyword,
    browserReservationMode: input.browserReservationMode === 'checkout' ? 'checkout' : 'preview',
    savedStores: normalizeStores(input.savedStores, defaults.savedStores)
  };
}

function normalizeLevelsByShop(input: unknown): Record<string, BrowserMemberLevel[]> {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const result: Record<string, BrowserMemberLevel[]> = {};
  for (const [shopId, value] of Object.entries(input as Record<string, unknown>)) {
    const id = shopId.trim();
    if (!id || !Array.isArray(value)) continue;
    const levels = value
      .flatMap((level, index) => {
        if (!level || typeof level !== 'object') return [];
        const item = level as Partial<BrowserMemberLevel>;
        const label = item.label?.trim();
        if (!label) return [];
        const rank = Math.round(clamp(Number(item.rank ?? index + 1), 1, 99));
        return [{
          id: item.id?.trim() || `level-${rank}`,
          label: label.slice(0, 80),
          rank,
          minAmount: Number.isFinite(Number(item.minAmount)) ? Math.max(0, Number(item.minAmount)) : undefined,
          rawText: item.rawText?.trim().slice(0, 160)
        }];
      })
      .slice(0, 30);
    if (levels.length) result[id] = levels;
  }
  return result;
}

function normalizePreviewByShop(input: unknown): Record<string, BrowserMemberPreview> {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const result: Record<string, BrowserMemberPreview> = {};
  for (const [shopId, value] of Object.entries(input as Record<string, unknown>)) {
    const id = shopId.trim();
    if (!id || !value || typeof value !== 'object') continue;
    const item = value as Partial<BrowserMemberPreview>;
    const rank = Math.round(clamp(Number(item.rank ?? 1), 1, 99));
    const levelLabel = item.levelLabel?.trim() || `VIP${rank}`;
    result[id] = {
      shopId: id,
      levelId: item.levelId?.trim() || `level-${rank}`,
      levelLabel: levelLabel.slice(0, 80),
      rank,
      name: item.name?.trim().slice(0, 80) || levelLabel.slice(0, 80),
      nextValue: finiteNonNegative(item.nextValue),
      serverIndex: finiteIndex(item.serverIndex, rank - 1),
      targetIndex: finiteIndex(item.targetIndex, rank - 1),
      originalProgress: Number.isFinite(Number(item.originalProgress))
        ? Math.max(0, Number(item.originalProgress))
        : undefined
    };
  }
  return result;
}

function normalizeWatermarkText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'EW Weidian' || isLegacyWatermarkText(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function isLegacyWatermarkText(value: string | undefined): boolean {
  return value?.trim() === '은우짱짱123';
}

function normalizeStores(input: unknown, fallback: SavedStore[]): SavedStore[] {
  if (!Array.isArray(input)) {
    return fallback;
  }

  return input
    .filter((store): store is Partial<SavedStore> => Boolean(store) && typeof store === 'object')
    .filter((store) => typeof store.id === 'string' && typeof store.url === 'string')
    .map((store) => ({
      id: store.id!.trim(),
      name: store.name?.trim() || store.id!.trim(),
      url: store.url!.trim(),
      memo: store.memo?.trim() ?? '',
      referer: store.referer?.trim() || undefined,
      pinned: Boolean(store.pinned),
      savedAtIso: store.savedAtIso || new Date().toISOString()
    }))
    .filter((store) => store.id && store.url)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
    .slice(0, 15);
}

function normalizeTargetTime(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const epochMs = new Date(value).getTime();
  return Number.isFinite(epochMs) ? value.slice(0, 19) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function finiteIndex(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : Math.max(0, Math.round(fallback));
}

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}
