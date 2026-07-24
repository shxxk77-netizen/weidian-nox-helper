import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions
} from 'electron';
import type {
  AppSettings,
  BrowserCommandType,
  BrowserMemberLevel,
  BrowserMemberPreview,
  BrowserReservationRequest,
  SavedStore
} from '../common/types';
import { ConfigStore } from '../common/config';
import { AppLogger } from './logger';
import { TimeSyncManager } from './timeSync';
import { BrowserBridgeService } from './browserBridge';
import { BrowserReservationRunner } from './browserReservation';
import { extractWeidianUrl } from '../common/weidianUrl';

app.setName('노무현');

let mainWindow: BrowserWindow | undefined;
let configStore: ConfigStore;
let logger: AppLogger;
let timeSync: TimeSyncManager;
let browserBridge: BrowserBridgeService;
let browserReservation: BrowserReservationRunner;
let extensionDir: string;

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') return;
  const template: MenuItemConstructorOptions[] = [
    {
      label: '노무현',
      submenu: [
        { role: 'about', label: '노무현 정보' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: '노무현 가리기' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: '노무현 종료' }
      ]
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    },
    {
      role: 'help',
      submenu: []
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    title: '노무현',
    backgroundColor: '#0b0c0f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => ({
    settings: configStore.get(),
    logFilePath: logger.logFilePath
  }));

  ipcMain.handle('settings:save', (_event, patch: Partial<AppSettings>) => {
    const saved = configStore.save(patch);
    logger.info('설정을 저장했습니다.', 'settings');
    return saved;
  });

  ipcMain.handle('time:sync', async () => {
    const settings = configStore.get();
    return timeSync.sync(settings.timeSyncUrl, settings.timeSyncSampleCount);
  });
  ipcMain.handle('time:get', () => timeSync.getSnapshot());

  ipcMain.handle('logs:get', () => logger.getEntries());
  ipcMain.handle('logs:open-file', () => {
    shell.showItemInFolder(logger.logFilePath);
  });

  ipcMain.handle('browser:bridge-state', () => browserBridge.getState());
  ipcMain.handle('browser:open-url', async (_event, url: string) => {
    const parsed = validateWeidianUrl(url);
    const saved = configStore.save({ browserUrl: parsed.toString() });
    openChrome(parsed.toString(), saved.browserCompactWindow);
    logger.info(`Chrome에서 페이지 열기: ${parsed.toString()}`, 'browser');
  });
  ipcMain.handle('browser:show-extension-folder', () => {
    shell.showItemInFolder(path.join(extensionDir, 'manifest.json'));
  });
  ipcMain.handle('clipboard:copy-text', (_event, text: string) => {
    clipboard.writeText(String(text).slice(0, 20_000));
  });
  ipcMain.handle('browser:save-store', (_event, store: Omit<SavedStore, 'savedAtIso'>) => {
    const current = configStore.get();
    const nextStore = normalizeStore(store);
    const savedStores = [...current.savedStores.filter((item) => item.id !== nextStore.id), nextStore]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
      .slice(0, 15);
    logger.info(`상점 저장: ${nextStore.name}`, 'browser', { id: nextStore.id });
    return configStore.save({ savedStores });
  });
  ipcMain.handle('browser:delete-store', (_event, id: string) => {
    const current = configStore.get();
    logger.warn(`저장 상점 삭제: ${id}`, 'browser');
    return configStore.save({ savedStores: current.savedStores.filter((store) => store.id !== id) });
  });
  ipcMain.handle(
    'browser:queue-command',
    (_event, type: BrowserCommandType, payload?: Record<string, unknown>) => browserBridge.queueCommand(type, payload)
  );
  ipcMain.handle('browser:reservation-start', async (_event, request: BrowserReservationRequest) => {
    const parsed = validateWeidianUrl(request.url);
    const saved = configStore.save({
      browserUrl: parsed.toString(),
      targetServerTime: request.targetServerTime,
      browserReservationOptionKeyword: request.optionKeyword,
      browserReservationMode: request.mode
    });
    await timeSync.sync(saved.timeSyncUrl, saved.timeSyncSampleCount);
    if (!browserBridge.getState().connected) {
      logger.warn('Chrome 확장 프로그램 연결을 기다리고 있습니다.', 'browser-reservation');
    }
    openChrome(parsed.toString(), saved.browserCompactWindow);
    return browserReservation.start({ ...request, url: parsed.toString() });
  });
  ipcMain.handle('browser:reservation-stop', () => browserReservation.stop());
  ipcMain.handle('browser:reservation-status', () => browserReservation.getStatus());
}

function normalizeStore(store: Omit<SavedStore, 'savedAtIso'>): SavedStore {
  const id = store.id.trim();
  const url = store.url.trim();
  if (!id || !url) {
    throw new Error('상점 ID와 URL이 필요합니다.');
  }
  validateWeidianUrl(url);
  return {
    id,
    name: store.name.trim() || id,
    url,
    memo: store.memo.trim(),
    referer: store.referer?.trim() || undefined,
    pinned: Boolean(store.pinned),
    savedAtIso: new Date().toISOString()
  };
}

function validateWeidianUrl(rawUrl: string): URL {
  return extractWeidianUrl(rawUrl);
}

function ensureExtensionFiles(userData: string): string {
  const candidates = [
    path.join(process.resourcesPath, 'chrome-extension'),
    path.join(app.getAppPath(), 'chrome-extension'),
    path.join(process.cwd(), 'chrome-extension')
  ];
  const source = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory() && !candidate.includes('.asar/');
    } catch {
      return false;
    }
  });
  if (!source) {
    throw new Error('Chrome 확장 프로그램 파일을 찾을 수 없습니다.');
  }
  const destination = path.join(userData, 'ew-weidian-chrome-extension');
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
  return destination;
}

function openChrome(url: string, compactWindow: boolean): void {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && fs.existsSync(chromePath)) {
    const args = compactWindow ? [`--app=${url}`, '--window-size=430,900'] : ['--new-window', url];
    const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  void shell.openExternal(url);
}

function defaultMemberLevels(): BrowserMemberLevel[] {
  return [1, 2, 3, 4, 5, 6].map((rank) => ({
    id: `vip-${rank}`,
    label: `VIP${rank}`,
    rank
  }));
}

function currentShopId(): string | undefined {
  return browserBridge?.getState().snapshot?.shopId;
}

function getMemberLevels(settings: AppSettings, shopId: string | undefined): BrowserMemberLevel[] {
  if (shopId && settings.browserMemberLevelsByShop[shopId]?.length) {
    return settings.browserMemberLevelsByShop[shopId];
  }
  return defaultMemberLevels();
}

function getMemberPreview(settings: AppSettings, shopId: string | undefined): BrowserMemberPreview {
  const shopPreview = shopId ? settings.browserMemberPreviewByShop[shopId] : undefined;
  if (shopPreview) {
    return shopPreview;
  }
  const levels = getMemberLevels(settings, shopId);
  const selected =
    levels.find((level) => level.id === settings.browserMemberPreviewLevelId) ||
    levels.find((level) => level.rank === settings.browserMemberPreviewRank) ||
    levels[0];
  const selectedIndex = Math.max(0, levels.findIndex((level) => level.id === selected.id));
  return {
    shopId,
    levelId: selected.id,
    levelLabel: selected.label,
    rank: selected.rank,
    name: settings.browserMemberPreviewName || selected.label,
    nextValue: settings.browserMemberNextValue,
    serverIndex: selectedIndex,
    targetIndex: selectedIndex
  };
}

app.whenReady().then(() => {
  installApplicationMenu();
  const userData = app.getPath('userData');
  extensionDir = ensureExtensionFiles(userData);
  configStore = new ConfigStore(path.join(userData, 'config.json'));
  logger = new AppLogger(path.join(userData, 'logs', 'ew-weidian.log'));
  timeSync = new TimeSyncManager(logger);
  browserReservation = new BrowserReservationRunner(logger, {
    getServerOffsetMs: () => timeSync.getSnapshot()?.offsetMs ?? 0,
    onExecute: (request) => {
      const activePageUrl = browserBridge?.getState().snapshot?.pageUrl;
      const executionKey = `${new Date(request.targetServerTime).getTime()}:${request.mode}:${request.optionKeyword}`;
      browserBridge?.queueCommand('execute-reservation', {
        mode: request.mode,
        optionKeyword: request.optionKeyword,
        targetServerTime: request.targetServerTime,
        targetPageUrl: activePageUrl || request.url,
        executionKey
      });
    },
    onStatus: (status) => mainWindow?.webContents.send('browser:reservation-event', status)
  });
  browserBridge = new BrowserBridgeService(configStore.get().browserBridgePort, logger, {
    extensionPath: extensionDir,
    getContext: () => {
      const settings = configStore.get();
      const shopId = currentShopId();
      const memberLevels = getMemberLevels(settings, shopId);
      const memberPreview = getMemberPreview(settings, shopId);
      return {
        serverOffsetMs: timeSync.getSnapshot()?.offsetMs ?? 0,
        watermark: {
          enabled: settings.browserWatermarkEnabled,
          text: settings.browserWatermarkText
        },
        memberPreview,
        memberLevels,
        reservation: browserReservation.getStatus(),
        reservationOptionKeyword: settings.browserReservationOptionKeyword,
        reservationMode: settings.browserReservationMode
      };
    },
    saveMemberPreview: (preview) => {
      const current = configStore.get();
      const shopId = preview.shopId || currentShopId();
      const browserMemberPreviewByShop =
        shopId
          ? {
              ...current.browserMemberPreviewByShop,
              [shopId]: { ...preview, shopId }
            }
          : current.browserMemberPreviewByShop;
      configStore.save({
        browserMemberPreviewRank: preview.rank,
        browserMemberPreviewLevelId: preview.levelId || `level-${preview.rank}`,
        browserMemberPreviewName: preview.name,
        browserMemberNextValue: preview.nextValue,
        browserMemberPreviewByShop
      });
    },
    saveDetectedMemberLevels: (shopId, levels) => {
      const current = configStore.get();
      const previous = current.browserMemberLevelsByShop[shopId] || [];
      const same =
        previous.length === levels.length &&
        previous.every(
          (level, index) =>
            level.id === levels[index]?.id &&
            level.label === levels[index]?.label &&
            level.rank === levels[index]?.rank &&
            level.minAmount === levels[index]?.minAmount
        );
      if (!same) {
        configStore.save({
          browserMemberLevelsByShop: {
            ...current.browserMemberLevelsByShop,
            [shopId]: levels
          }
        });
        logger.info(`상점 회원등급 감지: ${shopId} ${levels.length}개`, 'browser', levels);
      }
    },
    onState: (state) => {
      browserReservation.handleSnapshot(state.snapshot);
      mainWindow?.webContents.send('browser:bridge-event', state);
    }
  });

  logger.on('entry', (entry) => {
    mainWindow?.webContents.send('logs:entry', entry);
  });

  registerIpc();
  createWindow();
  logger.info('노무현 앱을 시작했습니다.', 'app');
  void browserBridge.start().catch((error) => {
    logger.error(`Chrome 브리지 시작 실패: ${error instanceof Error ? error.message : String(error)}`, 'browser');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  void browserBridge?.stop();
  if (browserReservation?.getStatus().running) {
    browserReservation.stop('앱 종료로 Chrome 예약을 중지했습니다.');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
