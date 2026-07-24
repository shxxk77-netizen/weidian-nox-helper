import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfigPayload,
  AppSettings,
  BrowserBridgeState,
  BrowserCommand,
  BrowserCommandType,
  BrowserReservationRequest,
  BrowserReservationStatus,
  LogEntry,
  RendererApi,
  SavedStore,
  TimeSyncSnapshot
} from '../common/types';

const api: RendererApi = {
  getConfig: (): Promise<AppConfigPayload> => ipcRenderer.invoke('config:get'),
  saveSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:save', settings),
  syncTime: (): Promise<TimeSyncSnapshot> => ipcRenderer.invoke('time:sync'),
  getTimeSnapshot: (): Promise<TimeSyncSnapshot | undefined> => ipcRenderer.invoke('time:get'),
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:get'),
  openLogFile: (): Promise<void> => ipcRenderer.invoke('logs:open-file'),
  onLog: (callback: (entry: LogEntry) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: LogEntry): void => callback(entry);
    ipcRenderer.on('logs:entry', handler);
    return () => ipcRenderer.removeListener('logs:entry', handler);
  },
  getBrowserBridgeState: (): Promise<BrowserBridgeState> => ipcRenderer.invoke('browser:bridge-state'),
  openInChrome: (url: string): Promise<void> => ipcRenderer.invoke('browser:open-url', url),
  showExtensionFolder: (): Promise<void> => ipcRenderer.invoke('browser:show-extension-folder'),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:copy-text', text),
  saveCurrentStore: (store: Omit<SavedStore, 'savedAtIso'>): Promise<AppSettings> =>
    ipcRenderer.invoke('browser:save-store', store),
  deleteSavedStore: (id: string): Promise<AppSettings> => ipcRenderer.invoke('browser:delete-store', id),
  queueBrowserCommand: (
    type: BrowserCommandType,
    payload?: Record<string, unknown>
  ): Promise<BrowserCommand> => ipcRenderer.invoke('browser:queue-command', type, payload),
  startBrowserReservation: (request: BrowserReservationRequest): Promise<BrowserReservationStatus> =>
    ipcRenderer.invoke('browser:reservation-start', request),
  stopBrowserReservation: (): Promise<BrowserReservationStatus> => ipcRenderer.invoke('browser:reservation-stop'),
  getBrowserReservationStatus: (): Promise<BrowserReservationStatus> =>
    ipcRenderer.invoke('browser:reservation-status'),
  onBrowserBridgeState: (callback: (state: BrowserBridgeState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserBridgeState): void => callback(state);
    ipcRenderer.on('browser:bridge-event', handler);
    return () => ipcRenderer.removeListener('browser:bridge-event', handler);
  },
  onBrowserReservation: (callback: (status: BrowserReservationStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: BrowserReservationStatus): void => callback(status);
    ipcRenderer.on('browser:reservation-event', handler);
    return () => ipcRenderer.removeListener('browser:reservation-event', handler);
  }
};

contextBridge.exposeInMainWorld('ewWeidian', api);
