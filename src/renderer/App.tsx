import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  Clock3,
  Copy,
  ExternalLink,
  FolderOpen,
  Image,
  Link2,
  ListChecks,
  Play,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Square,
  Store,
  Trash2,
  UserRound
} from 'lucide-react';
import type {
  AppSettings,
  BrowserBridgeState,
  BrowserCommandType,
  BrowserMemberApiContractObservation,
  BrowserMemberLevel,
  BrowserMemberPreview,
  BrowserPageSnapshot,
  BrowserReservationStatus,
  LogEntry,
  SavedStore,
  TimeSyncSnapshot
} from '../common/types';
import {
  createMemberSaveCurl,
  createMemberSaveCurlTemplate,
  createMemberSaveRequestJson,
  DEFAULT_MEMBER_API_CONNECTION,
  resolveMemberApiUrl,
  type MemberApiConnectionSettings,
  type MemberSaveRequestBody
} from '../common/memberAnalysisContract';

type MainTab = 'product' | 'reservation' | 'member' | 'settings';

type MemberPreviewWithServerIndex = BrowserMemberPreview;

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>();
  const [bridge, setBridge] = useState<BrowserBridgeState>();
  const [reservation, setReservation] = useState<BrowserReservationStatus>({ running: false, phase: 'idle' });
  const [time, setTime] = useState<TimeSyncSnapshot>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<MainTab>(() => {
    const saved = window.localStorage.getItem('ew-main-tab');
    return saved === 'reservation' || saved === 'member' || saved === 'settings' ? saved : 'product';
  });
  const [memo, setMemo] = useState('');
  const [referer, setReferer] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const saveRevision = useRef(0);
  const saveTail = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void bootstrap();
    const offBridge = window.ewWeidian.onBrowserBridgeState((state) => setBridge(state));
    const offReservation = window.ewWeidian.onBrowserReservation((status) => setReservation(status));
    const offLog = window.ewWeidian.onLog((entry) => setLogs((current) => [...current.slice(-399), entry]));
    return () => {
      offBridge();
      offReservation();
      offLog();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem('ew-main-tab', tab);
  }, [tab]);

  const snapshot = bridge?.snapshot;
  const selectedStore = useMemo(
    () => settings?.savedStores.find((store) => store.id === snapshot?.shopId),
    [settings?.savedStores, snapshot?.shopId]
  );

  useEffect(() => {
    setMemo(selectedStore?.memo ?? '');
    setReferer(selectedStore?.referer ?? '');
  }, [selectedStore?.id]);

  async function bootstrap(): Promise<void> {
    const [config, bridgeState, reservationState, timeState, entries] = await Promise.all([
      window.ewWeidian.getConfig(),
      window.ewWeidian.getBrowserBridgeState(),
      window.ewWeidian.getBrowserReservationStatus(),
      window.ewWeidian.getTimeSnapshot(),
      window.ewWeidian.getLogs()
    ]);
    setSettings(config.settings);
    setBridge(bridgeState);
    setReservation(reservationState);
    setTime(timeState);
    setLogs(entries);
  }

  async function run<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError('');
    try {
      return await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setBusy('');
    }
  }

  async function save(patch: Partial<AppSettings>): Promise<AppSettings | undefined> {
    const revision = ++saveRevision.current;
    setSettings((current) => (current ? { ...current, ...patch } : current));
    const task = saveTail.current.then(() => window.ewWeidian.saveSettings(patch));
    saveTail.current = task.then(
      () => undefined,
      () => undefined
    );
    try {
      const next = await task;
      if (revision === saveRevision.current) setSettings(next);
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    }
  }

  async function queue(type: BrowserCommandType, payload?: Record<string, unknown>): Promise<void> {
    await run('Chrome 명령', () => window.ewWeidian.queueBrowserCommand(type, payload));
  }

  if (!settings) return <div className="loading">weidian 준비 중</div>;

  return (
    <main className="ew-shell">
      <header className="ew-header">
        <div className="brand">
          <span className="brand-mark">店</span>
          <div>
            <h1>weidian</h1>
            <p>Chrome 상품 뷰어 · 예약 주문 도우미</p>
          </div>
        </div>
        <div className="header-status">
          <Status ok={Boolean(bridge?.connected)} icon={<Activity size={13} />}>
            {bridge?.connected ? 'Chrome 연결됨' : '확장 프로그램 대기'}
          </Status>
          <Status ok={Boolean(time)} icon={<Clock3 size={13} />}>
            {time ? `${formatSigned(time.offsetMs)}ms ±${time.uncertaintyMs}ms` : '시간 미동기화'}
          </Status>
          <Status ok={!reservation.running} accent={reservation.running} icon={<ListChecks size={13} />}>
            {reservation.phase}
          </Status>
        </div>
      </header>

      <nav className="main-tabs">
        <button className={tab === 'product' ? 'active' : ''} onClick={() => setTab('product')}>
          <Store size={15} /> 상품
        </button>
        <button className={tab === 'reservation' ? 'active' : ''} onClick={() => setTab('reservation')}>
          <Clock3 size={15} /> 예약
        </button>
        <button className={tab === 'member' ? 'active' : ''} onClick={() => setTab('member')}>
          <UserRound size={15} /> VIP
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <Settings size={15} /> 설정
        </button>
        <span>{busy}</span>
      </nav>

      {error ? <div className="error-bar">{error}</div> : null}

      {tab !== 'reservation' ? (
        <ViewerWorkspace
          section={tab}
          settings={settings}
          bridge={bridge}
          memo={memo}
          referer={referer}
          onMemo={setMemo}
          onReferer={setReferer}
          onSave={save}
          onQueue={queue}
          onOpen={async (url) => {
            await run('Chrome 열기', () => window.ewWeidian.openInChrome(url));
          }}
          onSaveStore={async () => {
            const shopId = snapshot?.shopId;
            if (!shopId) {
              setError('현재 페이지에서 상점 ID를 확인하지 못했습니다.');
              return;
            }
            const store: Omit<SavedStore, 'savedAtIso'> = {
              id: shopId,
              name: snapshot.shopName || `상점 ${shopId}`,
              url: snapshot.pageUrl,
              memo,
              referer,
              pinned: selectedStore?.pinned ?? false
            };
            const result = await run('상점 저장', () => window.ewWeidian.saveCurrentStore(store));
            if (result) setSettings(result);
          }}
          onDeleteStore={async (id) => {
            const result = await run('상점 삭제', () => window.ewWeidian.deleteSavedStore(id));
            if (result) setSettings(result);
          }}
        />
      ) : (
        <ReservationWorkspace
          settings={settings}
          bridge={bridge}
          reservation={reservation}
          time={time}
          onSave={save}
          onSync={async () => {
            const result = await run('시간 동기화', () => window.ewWeidian.syncTime());
            if (result) setTime(result);
          }}
          onStart={async () => {
            const result = await run('예약 시작', () =>
              window.ewWeidian.startBrowserReservation({
                url: settings.browserUrl,
                targetServerTime: settings.targetServerTime,
                optionKeyword: settings.browserReservationOptionKeyword,
                mode: settings.browserReservationMode
              })
            );
            if (result) setReservation(result);
          }}
          onStop={async () => {
            const result = await run('예약 중지', () => window.ewWeidian.stopBrowserReservation());
            if (result) setReservation(result);
          }}
          onQueue={queue}
        />
      )}

      <footer className="ew-footer">
        <span>
          브리지 127.0.0.1:{bridge?.port ?? settings.browserBridgePort} · 최종 결제는 Chrome/휴대전화에서 직접 승인
        </span>
        <div>
          <button onClick={() => window.ewWeidian.showExtensionFolder()}>
            <FolderOpen size={14} /> 확장 폴더
          </button>
          <button onClick={() => window.ewWeidian.openLogFile()}>로그 파일</button>
        </div>
      </footer>

      <LogRail logs={logs} />
    </main>
  );
}

interface ViewerWorkspaceProps {
  section: Exclude<MainTab, 'reservation'>;
  settings: AppSettings;
  bridge?: BrowserBridgeState;
  memo: string;
  referer: string;
  onMemo: (value: string) => void;
  onReferer: (value: string) => void;
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings | undefined>;
  onQueue: (type: BrowserCommandType, payload?: Record<string, unknown>) => Promise<void>;
  onOpen: (url: string) => Promise<void>;
  onSaveStore: () => Promise<void>;
  onDeleteStore: (id: string) => Promise<void>;
}

function ViewerWorkspace(props: ViewerWorkspaceProps): JSX.Element {
  const { section, settings, bridge, onSave, onQueue } = props;
  const snapshot = bridge?.snapshot;
  const [search, setSearch] = useState('');
  const [memberActionBusy, setMemberActionBusy] = useState('');
  const [pendingMemberRequestId, setPendingMemberRequestId] = useState('');
  const [memberActionError, setMemberActionError] = useState('');
  const [memberPagePending, setMemberPagePending] = useState<{
    sourceUrl: string;
    startedAtMs: number;
  }>();
  const [localMemberCheckApplied, setLocalMemberCheckApplied] = useState(false);
  const [memberPostRequestId, setMemberPostRequestId] = useState(() => crypto.randomUUID());
  const [buyerIdsText, setBuyerIdsText] = useState('');
  const stores = settings.savedStores.filter((store) =>
    `${store.name} ${store.memo} ${store.id}`.toLowerCase().includes(search.toLowerCase())
  );
  const memberLevels = useMemo(() => memberLevelsFor(settings, snapshot), [settings, snapshot]);
  const memberPreview = useMemo(() => selectedMemberPreview(settings, snapshot, memberLevels), [settings, snapshot, memberLevels]);
  const memberLevelSource = snapshot?.memberServerState?.gradeNames.length
    ? '승인 서버'
    : snapshot?.memberLevels?.length
      ? '페이지 감지'
    : snapshot?.shopId && settings.browserMemberLevelsByShop[snapshot.shopId]?.length
      ? '저장값'
      : '기본값';
  const memberServerState = snapshot?.memberServerState;
  const memberApiContracts = useMemo(
    () => (bridge?.memberApiContracts || [])
      .filter((contract) => !snapshot?.shopId || !contract.shopId || contract.shopId === snapshot.shopId)
      .slice(0, 24),
    [bridge?.memberApiContracts, snapshot?.shopId]
  );
  const latestWriteContract =
    memberApiContracts.find(
      (contract) =>
        contract.method === 'GET' &&
        /\/wdcrm\/trade\.setMemberLevel\/2\.0$/i.test(contract.url) &&
        contract.source === 'chrome-web-request'
    ) ||
    memberApiContracts.find(
      (contract) =>
        contract.method === 'GET' &&
        /\/wdcrm\/trade\.setMemberLevel\/2\.0$/i.test(contract.url)
    );
  const selectedMemberLevel = memberLevels[memberPreview.targetIndex];
  const buyerIds = parseBuyerIds(
    buyerIdsText || (snapshot?.buyerIds || []).join(',')
  );
  const memberPostPayload = useMemo<MemberSaveRequestBody | undefined>(() => {
    if (!snapshot?.shopId || !memberServerState) return undefined;
    const selectedGradeName =
      memberLevels[memberPreview.targetIndex]?.label ||
      memberPreview.name ||
      memberPreview.levelLabel;
    return {
      shopId: snapshot.shopId,
      buyerIds,
      memberId: selectedMemberLevel?.id || '',
      selectedServerIndex: memberPreview.targetIndex,
      selectedGradeName
    };
  }, [
    buyerIdsText,
    memberLevels,
    memberPreview.levelLabel,
    memberPreview.name,
    memberPreview.targetIndex,
    memberServerState,
    selectedMemberLevel?.id,
    snapshot?.buyerIds,
    snapshot?.shopId
  ]);
  const memberPostJson = memberPostPayload
    ? createMemberSaveRequestJson(memberPostPayload)
    : '';
  const memberSaveEndpoint = resolveMemberApiUrl(
    settings.browserMemberApi.baseUrl,
    settings.browserMemberApi.saveEndpoint
  );
  const memberSaveCurlTemplate = createMemberSaveCurlTemplate(settings.browserMemberApi);
  const memberPostCurl = memberPostPayload
    ? createMemberSaveCurl(memberPostPayload, settings.browserMemberApi)
    : memberSaveCurlTemplate;
  const wdToken = memberServerState?.actionToken;
  const lastMemberResult = bridge?.lastMemberCommandResult;
  const isMemberPage = snapshot?.pageKind === 'member' && /mkt-h5-member-detail/i.test(snapshot.pageUrl);
  const chromeConnected = Boolean(bridge?.connected);
  const hasShopId = Boolean(snapshot?.shopId);
  const hasValidServerIndex =
    Boolean(memberServerState) &&
    Number.isInteger(memberServerState?.serverIndex) &&
    Number.isInteger(memberServerState?.gradeCount) &&
    Number(memberServerState?.serverIndex) >= 0 &&
    Number(memberServerState?.serverIndex) < Number(memberServerState?.gradeCount);
  const hasValidGradeCatalog =
    Boolean(memberServerState?.gradeCount && memberServerState.gradeCount > 0) &&
    memberServerState?.gradeNames.length === memberServerState?.gradeCount;
  const memberReadReady =
    chromeConnected &&
    isMemberPage &&
    hasShopId &&
    Boolean(memberServerState) &&
    hasValidServerIndex &&
    hasValidGradeCatalog;
  const wdTokenReady =
    wdToken?.status === 'ready' &&
    wdToken.shopId === snapshot?.shopId &&
    (wdToken.expiresAtEpochMs === undefined || wdToken.expiresAtEpochMs - Date.now() > 5_000);
  const hasBuyerIds = buyerIds.length > 0;
  const hasMemberLevelId = Boolean(
    memberPostPayload?.memberId &&
    selectedMemberLevel?.rawText === 'Weidian seller member catalog'
  );
  const writeAdapterReady = memberServerState?.writeAdapter.status === 'configured';
  const targetChanged = memberPreview.targetIndex !== memberServerState?.serverIndex;
  const canSaveToServer =
    memberReadReady &&
    Number.isInteger(memberPreview.targetIndex) &&
    wdTokenReady &&
    writeAdapterReady &&
    hasBuyerIds &&
    hasMemberLevelId &&
    !memberActionBusy &&
    targetChanged;
  const saveBlockers = [
    !chromeConnected ? 'CHROME_NOT_CONNECTED' : '',
    !isMemberPage ? 'MEMBER_PAGE_NOT_DETECTED' : '',
    !hasShopId ? 'SHOP_ID_MISSING' : '',
    !hasValidServerIndex || !hasValidGradeCatalog ? 'MEMBER_READ_NOT_READY' : '',
    !wdTokenReady ? `WDTOKEN_${String(wdToken?.status || 'empty').toUpperCase().replace(/-/g, '_')}` : '',
    !hasBuyerIds ? 'BUYER_IDS_MISSING' : '',
    !hasMemberLevelId ? 'SELLER_MEMBER_LEVEL_ID_MISSING' : '',
    !writeAdapterReady
      ? memberServerState?.writeAdapter.errorCode || 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
      : '',
    !targetChanged ? 'TARGET_INDEX_UNCHANGED' : '',
    memberActionBusy ? 'MEMBER_COMMAND_RUNNING' : ''
  ].filter(Boolean);

  useEffect(() => {
    setMemberActionError('');
    setLocalMemberCheckApplied(false);
    setMemberPostRequestId(crypto.randomUUID());
    setBuyerIdsText((snapshot?.buyerIds || []).join(','));
  }, [snapshot?.shopId, snapshot?.buyerIds?.join(',')]);

  useEffect(() => {
    setMemberPostRequestId(crypto.randomUUID());
  }, [memberPreview.targetIndex]);

  useEffect(() => {
    if (!memberPagePending || !snapshot?.shopId) return;
    const observedAtMs = Date.parse(snapshot.observedAtIso);
    if (!Number.isFinite(observedAtMs) || observedAtMs < memberPagePending.startedAtMs) return;
    const pending = memberPagePending;
    setMemberPagePending(undefined);
    setMemberActionBusy('Member 페이지 자동 전환');
    void window.ewWeidian.openMemberInChrome(pending.sourceUrl, snapshot.shopId)
      .catch((caught) => {
        setMemberActionError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setMemberActionBusy(''));
  }, [memberPagePending, snapshot?.observedAtIso, snapshot?.shopId]);

  useEffect(() => {
    if (!pendingMemberRequestId || lastMemberResult?.clientRequestId !== pendingMemberRequestId) return;
    if (!lastMemberResult.ok) {
      setMemberActionError(
        [lastMemberResult.errorCode, lastMemberResult.errorMessage].filter(Boolean).join(': ') ||
          'Member 명령이 실패했습니다.'
      );
    }
    setMemberActionBusy('');
    setPendingMemberRequestId('');
  }, [lastMemberResult, pendingMemberRequestId]);

  useEffect(() => {
    if (!pendingMemberRequestId) return;
    const timeout = window.setTimeout(() => {
      setMemberActionBusy('');
      setPendingMemberRequestId('');
      setMemberActionError('Member 명령 결과를 제한 시간 안에 받지 못했습니다. 서버 상태를 다시 동기화해 주세요.');
    }, 25_000);
    return () => window.clearTimeout(timeout);
  }, [pendingMemberRequestId]);

  async function saveMemberPreview(preview: MemberPreviewWithServerIndex): Promise<void> {
    await onSave({
      browserMemberPreviewRank: preview.rank,
      browserMemberPreviewLevelId: preview.levelId || `level-${preview.rank}`,
      browserMemberPreviewName: preview.name,
      browserMemberNextValue: preview.nextValue,
      browserMemberPreviewByShop: snapshot?.shopId
        ? {
            ...settings.browserMemberPreviewByShop,
            [snapshot.shopId]: { ...preview, shopId: snapshot.shopId }
          }
        : settings.browserMemberPreviewByShop
    });
  }

  function getServerIndex(levelId: string | undefined): number {
    const index = memberLevels.findIndex((level) => level.id === levelId);
    return index >= 0 ? index : 0;
  }

  function previewFromLevelId(levelId: string): MemberPreviewWithServerIndex {
    const selected = memberLevels.find((level) => level.id === levelId) || memberLevels[0] || defaultMemberLevels()[0];
    return {
      ...memberPreview,
      shopId: snapshot?.shopId,
      levelId: selected.id,
      levelLabel: selected.label,
      rank: selected.rank,
      name: selected.label,
      targetIndex: getServerIndex(selected.id)
    };
  }

  async function queueMemberCommand(
    label: string,
    type: BrowserCommandType,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!snapshot?.shopId) {
      setMemberActionError('현재 Member 페이지에서 shopId를 확인하지 못했습니다.');
      return;
    }
    const clientRequestId = typeof payload.clientRequestId === 'string' ? payload.clientRequestId : '';
    if (!clientRequestId) {
      setMemberActionError('Member 명령의 clientRequestId가 비어 있습니다.');
      return;
    }
    setMemberActionBusy(label);
    setPendingMemberRequestId(clientRequestId);
    setMemberActionError('');
    try {
      await onQueue(type, payload);
    } catch (caught) {
      setMemberActionError(caught instanceof Error ? caught.message : String(caught));
      setMemberActionBusy('');
      setPendingMemberRequestId('');
    }
  }

  function requestBase(clientRequestId = crypto.randomUUID()): {
    shopId: string;
    targetPageUrl: string;
    clientRequestId: string;
  } | undefined {
    if (!snapshot?.shopId) return undefined;
    return {
      shopId: snapshot.shopId,
      targetPageUrl: snapshot.pageUrl,
      clientRequestId
    };
  }

  async function syncVipGrades(): Promise<void> {
    const base = requestBase();
    if (base) await queueMemberCommand('등급 동기화 요청', 'sync-vip-grades', base);
  }

  async function refreshWdToken(): Promise<void> {
    const base = requestBase();
    if (base) {
      await queueMemberCommand('wdtoken 감지 요청', 'refresh-action-token', {
        ...base,
        action: 'save-vip-settings'
      });
    }
  }

  async function saveVipSettings(): Promise<void> {
    const base = requestBase(memberPostRequestId);
    if (!base || !memberServerState || !memberPostPayload) return;
    await queueMemberCommand('서버 저장 요청', 'save-vip-settings', {
      ...base,
      buyerIds: memberPostPayload.buyerIds,
      memberId: memberPostPayload.memberId,
      serverIndex: memberServerState.serverIndex,
      targetIndex: Number(memberPostPayload.selectedServerIndex),
      gradeCount: memberServerState.gradeCount,
      gradeNames: [...memberServerState.gradeNames],
      name: memberPostPayload.selectedGradeName,
      remaining: memberServerState.remaining,
      originalProgress: memberServerState.originalProgress
    });
    setMemberPostRequestId(crypto.randomUUID());
  }

  async function openMemberPage(): Promise<void> {
    setMemberActionError('');
    setMemberActionBusy('Member 페이지 판별');
    try {
      const startedAtMs = Date.now();
      const result = await window.ewWeidian.openMemberInChrome(settings.browserUrl);
      if (result.status === 'source-opened') {
        setMemberPagePending({
          sourceUrl: settings.browserUrl,
          startedAtMs
        });
      } else {
        setMemberPagePending(undefined);
      }
    } catch (caught) {
      setMemberActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMemberActionBusy('');
    }
  }

  async function toggleLocalMemberCheck(): Promise<void> {
    if (!snapshot?.shopId || !snapshot.pageUrl) {
      setMemberActionError('먼저 Member 페이지를 열어 shopId를 확인해 주세요.');
      return;
    }
    if (localMemberCheckApplied) {
      await onQueue('restore-member-preview', {
        shopId: snapshot.shopId,
        targetPageUrl: snapshot.pageUrl
      });
      setLocalMemberCheckApplied(false);
      return;
    }
    await onQueue('apply-member-preview', {
      memberPreview,
      shopId: snapshot.shopId,
      serverIndex: memberPreview.serverIndex,
      targetIndex: memberPreview.targetIndex,
      targetPageUrl: snapshot.pageUrl
    });
    setLocalMemberCheckApplied(true);
  }

  return (
    <section className="compact-workspace" data-section={section}>
      <div className="column">
        <Card title="Member 페이지 자동 판별" className="member-only">
          <label>
            상점 판매 페이지 또는 Member 링크
            <input
              value={settings.browserUrl}
              placeholder="Weidian 판매 페이지 링크를 붙여넣으세요"
              onChange={(event) => void onSave({ browserUrl: event.target.value })}
            />
          </label>
          <button
            className="primary full"
            onClick={() => void openMemberPage()}
            disabled={!settings.browserUrl || Boolean(memberActionBusy)}
          >
            <ExternalLink size={14} /> Member 페이지 열기
          </button>
          <p className="subtle">
            {memberPagePending
              ? '판매 페이지에서 shopId를 감지한 뒤 Member 페이지로 자동 전환합니다.'
              : '직접 Member 링크면 즉시 열고, 판매 링크면 shopId 감지 후 Member 주소를 만듭니다.'}
          </p>
        </Card>

        <Card title="상품 열기" className="product-only">
          <label>
            URL
            <input
              value={settings.browserUrl}
              placeholder="Weidian 상품 URL 또는 k.youshop10.com 공유 URL"
              onChange={(event) => void onSave({ browserUrl: event.target.value })}
            />
          </label>
          <div className="two">
            <label>
              실행
              <select value="chrome" disabled>
                <option value="chrome">Google Chrome</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.browserCompactWindow}
                onChange={(event) => void onSave({ browserCompactWindow: event.target.checked })}
              />
              간소화 창
            </label>
          </div>
          <label>
            대상 buyerIds
            <input
              value={buyerIdsText}
              onChange={(event) => setBuyerIdsText(event.target.value)}
              placeholder="구매자 ID를 쉼표로 구분"
              spellCheck={false}
            />
          </label>
          <KeyValue
            label="선택 Member 등급 ID"
            value={selectedMemberLevel?.id || '-'}
            tone={hasMemberLevelId ? 'green' : 'amber'}
          />
          <div className="button-row">
            <button onClick={() => window.ewWeidian.copyText(settings.browserUrl)}>
              <Copy size={14} /> URL 복사
            </button>
            <button className="primary grow" onClick={() => props.onOpen(settings.browserUrl)} disabled={!settings.browserUrl}>
              <ExternalLink size={14} /> Chrome에서 열기
            </button>
            <button onClick={() => onQueue('refresh')}>
              <RefreshCw size={14} />
            </button>
          </div>
        </Card>

        <Card title={`저장 상점 · ${stores.length}/${settings.savedStores.length}`} className="product-only">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="상점명·메모 검색" />
          <div className="store-list">
            {stores.length ? (
              stores.map((store) => (
                <div className={`store-row ${store.id === snapshot?.shopId ? 'selected' : ''}`} key={store.id}>
                  <button className="store-main" onClick={() => props.onOpen(store.url)}>
                    <strong>{store.pinned ? '★ ' : ''}{store.name}</strong>
                    <span>{store.id}</span>
                    <small>{store.memo || '메모 없음'}</small>
                  </button>
                  <button className="icon danger" onClick={() => props.onDeleteStore(store.id)} aria-label="삭제">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            ) : (
              <Empty>저장된 상점이 없습니다.</Empty>
            )}
          </div>
        </Card>
      </div>

      <div className="column">
        <Card title="현재 상품" action={<BridgeBadge connected={Boolean(bridge?.connected)} />} className="product-only">
          {snapshot ? (
            <>
              <h3>{snapshot.productTitle || snapshot.pageTitle || '제목 없음'}</h3>
              <p className="subtle">
                {snapshot.shopName || '상점 미확인'} · 상점 {snapshot.shopId || '-'} · 상품 {snapshot.itemId || '-'}
              </p>
              <div className="metric-grid">
                <Metric label="판매가" value={snapshot.priceText || '-'} />
                <Metric label="재고" value={stockLabel(snapshot)} />
                <Metric label="옵션" value={`${snapshot.options.length}개`} />
                <Metric label="상태" value={saleLabel(snapshot.saleStatus)} tone={snapshot.saleStatus === 'on_sale' ? 'green' : ''} />
              </div>
              <div className="option-list">
                {snapshot.options.length ? (
                  snapshot.options.map((option) => (
                    <div className="option-row" key={option.id}>
                      <div>
                        <strong>{option.name}</strong>
                        <span>{option.priceText || ''}</span>
                      </div>
                      <b>{option.stock === undefined ? '재고 ?' : `${option.stock}개`}</b>
                    </div>
                  ))
                ) : (
                  <Empty>현재 DOM에서 확인 가능한 옵션이 없습니다. 상품의 옵션 선택창을 열어보세요.</Empty>
                )}
              </div>
              <div className="quick-actions">
                <button onClick={() => onQueue('open-options')}>옵션 선택창</button>
                <button onClick={() => onQueue('save-representative-image')}>
                  <Image size={14} /> 대표 이미지
                </button>
                <button onClick={() => onQueue('save-all-images')}>전체 이미지 {snapshot.imageUrls.length}개</button>
              </div>
            </>
          ) : (
            <Empty>Chrome 확장 프로그램을 설치한 뒤 Weidian 페이지를 여세요.</Empty>
          )}
        </Card>

        <Card title="현재 상점" className="settings-only">
          <div className="two">
            <label>
              이름
              <input value={snapshot?.shopName || ''} disabled />
            </label>
            <label>
              상점 ID
              <input value={snapshot?.shopId || ''} disabled />
            </label>
          </div>
          <label>
            상점 URL
            <input value={snapshot?.pageUrl || settings.browserUrl} disabled />
          </label>
          <label>
            메모
            <input value={props.memo} onChange={(event) => props.onMemo(event.target.value)} placeholder="상점 메모" />
          </label>
          <label>
            Referer
            <input value={props.referer} onChange={(event) => props.onReferer(event.target.value)} placeholder="필요할 때만 입력" />
          </label>
          <button className="primary full" onClick={props.onSaveStore} disabled={!snapshot?.shopId}>
            <Save size={14} /> 현재 상점 저장
          </button>
        </Card>
      </div>

      <div className="column">
        <Card title="VIP 로컬 확인" className="member-only">
          <div className="safe-note">
            <ShieldCheck size={15} /> 로컬 화면 표시만 바뀝니다. 서버 회원등급과 실제 주문 가격은 변경되지 않습니다.
          </div>
          <p className="subtle">
            {snapshot?.shopId ? `상점 ${snapshot.shopId}` : '상점 미확인'} · {memberLevelSource} {memberLevels.length}개
          </p>
          <label>
            목표 등급
            <select
              value={memberPreview.levelId || ''}
              onChange={(event) => void saveMemberPreview(previewFromLevelId(event.target.value))}
            >
              {memberLevels.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.label}{level.minAmount === undefined ? '' : ` · ${level.minAmount}`}
                </option>
              ))}
            </select>
          </label>
          <div className="two">
            <label>
              표시 이름
              <input
                value={memberPreview.name}
                onChange={(event) => void saveMemberPreview({ ...memberPreview, name: event.target.value })}
              />
            </label>
            <label>
              다음 등급까지
              <input
                type="number"
                min="0"
                value={memberPreview.nextValue}
                onChange={(event) => void saveMemberPreview({ ...memberPreview, nextValue: Number(event.target.value) })}
              />
            </label>
          </div>
          <KeyValue
            label="현재 serverIndex"
            value={memberServerState ? String(memberServerState.serverIndex) : '-'}
          />
          <KeyValue label="선택 targetIndex" value={String(memberPreview.targetIndex)} tone="green" />
          <button
            className="primary full"
            onClick={() => void toggleLocalMemberCheck()}
            disabled={!isMemberPage}
          >
            <UserRound size={14} /> {localMemberCheckApplied ? '로컬 확인 해제' : '로컬 확인'}
          </button>
        </Card>

        <Card title="실제 판매자 GET 전송 방식" className="member-only">
          <div className="safe-note">
            <ShieldCheck size={15} /> Cookie와 wdtoken 원문은 Renderer·설정·로그에 저장하지 않고 Chrome 확장 메모리에서만 사용합니다.
          </div>
          <KeyValue label="설정된 GET endpoint" value={memberSaveEndpoint} tone="green" />
          <KeyValue label="인증 방식" value="Chrome Cookie + query wdtoken" />
          {memberPostPayload ? (
            <>
              <KeyValue
                label="선택 VIP"
                value={`${memberPostPayload.selectedGradeName} · serverIndex ${memberPostPayload.selectedServerIndex}`}
                tone="green"
              />
              <KeyValue label="param.memberId" value={memberPostPayload.memberId || '-'} tone={hasMemberLevelId ? 'green' : 'amber'} />
              <KeyValue label="param.buyerIds" value={memberPostPayload.buyerIds.join(', ') || '-'} tone={hasBuyerIds ? 'green' : 'amber'} />
              <pre className="curl-template">{memberPostJson}</pre>
              <div className="button-row">
                <button onClick={() => window.ewWeidian.copyText(memberPostJson)}>
                  <Copy size={14} /> JSON 복사
                </button>
                <button onClick={() => window.ewWeidian.copyText(memberPostCurl)}>
                  <Copy size={14} /> cURL 복사
                </button>
              </div>
              <pre className="curl-template">{memberPostCurl}</pre>
              <p className="subtle">
                `_selection`은 화면 확인용이며 실제 GET의 `param`에는 buyerIds와 memberId만 전송됩니다.
              </p>
            </>
          ) : (
            <>
              <pre className="curl-template">{memberSaveCurlTemplate}</pre>
              <button
                className="full"
                onClick={() => window.ewWeidian.copyText(memberSaveCurlTemplate)}
              >
                <Copy size={14} /> 기본 cURL 복사
              </button>
              <p className="subtle">
                Member 동기화가 완료되면 읽어온 VIP 목록과 셀렉박스 선택값으로 JSON이 생성됩니다.
              </p>
            </>
          )}
          {latestWriteContract ? (
            <div className="observed-contract">
              <p className="subtle">Chrome에서 관찰된 최근 실제 쓰기 요청</p>
              <KeyValue label="Method" value={latestWriteContract.method} tone="green" />
              <KeyValue label="Endpoint" value={latestWriteContract.url} />
              <KeyValue
                label="Content-Type"
                value={latestWriteContract.requestHeaderMetadata?.contentType || 'GET query'}
              />
              <KeyValue label="wdtoken 위치" value={latestWriteContract.tokenPlacement} />
              <KeyValue
                label="Chrome 세션"
                value={latestWriteContract.chromeSessionCookie ? 'Cookie 포함 감지' : 'Cookie 미감지'}
              />
              <KeyValue
                label="Query 필드"
                value={latestWriteContract.queryKeys.join(', ') || '-'}
              />
              <KeyValue
                label="응답 필드"
                value={contractShapeKeys(latestWriteContract.responseBodyShape)}
              />
              <button
                className="full"
                onClick={() => window.ewWeidian.copyText(latestWriteContract.curlTemplate)}
              >
                <Copy size={14} /> cURL 템플릿 복사
              </button>
              <p className="subtle">
                최근 관찰 {latestWriteContract.sampleCount}회 · HTTP {latestWriteContract.status || '-'} · {latestWriteContract.source}
              </p>
            </div>
          ) : null}
          {memberApiContracts.length > 1 ? (
            <div className="member-contract-list">
              {memberApiContracts.slice(0, 12).map((contract) => (
                <MemberApiContractRow contract={contract} key={contract.id} />
              ))}
            </div>
          ) : null}
        </Card>

        <Card title="Member 읽기 · wdtoken · GET 전송" className="member-only">
          <div className="safe-note">
            <ShieldCheck size={15} /> 판매자 요청에서 wdtoken과 실제 등급 카탈로그를 감지한 뒤 로그인된 판매자 탭에서 GET을 실행합니다.
          </div>
          <KeyValue label="Chrome 연결" value={chromeConnected ? '완료' : '미연결'} tone={chromeConnected ? 'green' : 'amber'} />
          <KeyValue label="Member 페이지" value={isMemberPage ? '감지 완료' : '미감지'} tone={isMemberPage ? 'green' : 'amber'} />
          <KeyValue label="shopId 감지" value={hasShopId ? '완료' : '미감지'} tone={hasShopId ? 'green' : 'amber'} />
          <KeyValue
            label="등급 동기화"
            value={memberReadReady ? '완료' : '대기'}
            tone={memberReadReady ? 'green' : 'amber'}
          />
          <KeyValue
            label="Member 읽기 소스"
            value={
              memberServerState?.readSource === 'weidian-network'
                ? '실제 Weidian 네트워크'
                : memberServerState?.readSource === 'weidian-page'
                  ? '실제 Weidian 페이지'
                  : memberServerState?.readSource === 'mock-endpoint'
                    ? 'Mock endpoint'
                    : '-'
            }
          />
          <KeyValue label="상점 ID" value={snapshot?.shopId || '-'} />
          <KeyValue label="현재 등급" value={memberServerState?.name || '-'} />
          <KeyValue label="목표 등급" value={memberLevels[memberPreview.targetIndex]?.label || memberPreview.levelLabel} tone="green" />
          <KeyValue label="등급 수" value={memberServerState ? String(memberServerState.gradeCount) : '-'} />
          <KeyValue label="gradeNames" value={memberServerState?.gradeNames.join(', ') || '-'} />
          <KeyValue label="remaining" value={memberServerState ? String(memberServerState.remaining) : '-'} />
          <KeyValue label="originalProgress" value={memberServerState ? `${memberServerState.originalProgress}%` : '-'} />
          <KeyValue
            label="마지막 동기화"
            value={memberServerState ? new Date(memberServerState.syncedAtIso).toLocaleTimeString('ko-KR') : '-'}
          />
          <KeyValue label="wdtoken 상태" value={wdToken?.status || 'empty'} tone={wdTokenReady ? 'green' : 'amber'} />
          <KeyValue label="fingerprint" value={wdToken?.tokenFingerprint || '-'} />
          <KeyValue label="일회성 여부" value={wdToken?.oneTime ? '예' : '아니오 · 세션 토큰'} />
          <KeyValue
            label="감지 시각"
            value={wdToken?.issuedAtEpochMs ? new Date(wdToken.issuedAtEpochMs).toLocaleTimeString('ko-KR') : '-'}
          />
          <KeyValue
            label="예상 만료"
            value={wdToken?.expiresAtEpochMs ? new Date(wdToken.expiresAtEpochMs).toLocaleTimeString('ko-KR') : '응답에 명시되지 않음'}
          />
          <KeyValue label="남은 시간" value={formatTokenRemaining(wdToken?.expiresAtEpochMs)} />
          <KeyValue
            label="GET endpoint"
            value={
              writeAdapterReady
                ? memberSaveEndpoint
                : memberServerState?.writeAdapter.errorCode || 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED'
            }
            tone={writeAdapterReady ? 'green' : 'amber'}
          />
          <KeyValue
            label="저장 버튼"
            value={canSaveToServer ? '활성화' : '비활성화'}
            tone={canSaveToServer ? 'green' : 'amber'}
          />
          <KeyValue label="마지막 오류" value={wdToken?.lastErrorCode || lastMemberResult?.errorCode || '-'} />
          {wdToken?.lastErrorMessage || lastMemberResult?.errorMessage ? (
            <div className="error-bar">{wdToken?.lastErrorMessage || lastMemberResult?.errorMessage}</div>
          ) : null}
          {memberActionError ? <div className="error-bar">{memberActionError}</div> : null}
          <div className="button-row">
            <button onClick={() => void syncVipGrades()} disabled={!isMemberPage || Boolean(memberActionBusy)}>
              <RefreshCw size={14} /> 등급 동기화
            </button>
            <button onClick={() => void refreshWdToken()} disabled={!memberReadReady || Boolean(memberActionBusy)}>
              wdtoken 다시 감지
            </button>
            <button
              className="primary grow"
              onClick={() => void saveVipSettings()}
              disabled={!canSaveToServer}
              title={saveBlockers.join(', ')}
            >
              <Save size={14} /> GET 저장
            </button>
          </div>
          <p className="subtle">
            {memberActionBusy || (
              saveBlockers.length
                ? `저장 차단 사유: ${saveBlockers.join(' · ')}`
                : '읽기·wdtoken·buyerIds·판매자 등급 ID가 모두 준비되었습니다.'
            )}
          </p>
        </Card>

        <Card title="실제 주문 가격 확인" className="member-only">
          <KeyValue label="현재 페이지" value={snapshot?.pageKind || '-'} />
          <KeyValue label="서버 표시 가격" value={snapshot?.priceText || '-'} tone="green" />
          <KeyValue label="적용 VIP" value={memberPreview.levelLabel || `VIP${memberPreview.rank}`} />
          <p className="safety-copy">
            주문 확인 화면의 서버 가격이 최종 기준입니다. VIP 미리보기 값은 주문 요청에 포함되지 않습니다.
          </p>
        </Card>

        <MemberApiSettingsCard settings={settings.browserMemberApi} onSave={onSave} />

        <Card title="워터마크" className="settings-only">
          <label className="check line">
            <input
              type="checkbox"
              checked={settings.browserWatermarkEnabled}
              onChange={(event) => void onSave({ browserWatermarkEnabled: event.target.checked })}
            />
            모든 Weidian 페이지에 표시
          </label>
          <label>
            워터마크 문구
            <input
              value={settings.browserWatermarkText}
              onChange={(event) => void onSave({ browserWatermarkText: event.target.value })}
            />
          </label>
          <button className="full" onClick={() => onQueue('set-watermark')}>설정 적용</button>
        </Card>

        <Card title="연결 상태" className="settings-only">
          <KeyValue label="확장 프로그램" value={bridge?.connected ? '연결됨' : '대기 중'} tone={bridge?.connected ? 'green' : 'amber'} />
          <KeyValue label="마지막 수신" value={bridge?.lastSeenAtIso ? new Date(bridge.lastSeenAtIso).toLocaleTimeString('ko-KR') : '-'} />
          <KeyValue label="페이지 종류" value={snapshot?.pageKind || '-'} />
          <KeyValue label="브리지" value={`127.0.0.1:${bridge?.port ?? settings.browserBridgePort}`} />
          <button className="full" onClick={() => window.ewWeidian.showExtensionFolder()}>
            <FolderOpen size={14} /> Chrome 확장 폴더 열기
          </button>
        </Card>
      </div>
    </section>
  );
}

function MemberApiSettingsCard({
  settings,
  onSave
}: {
  settings: MemberApiConnectionSettings;
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings | undefined>;
}): JSX.Element {
  const [draft, setDraft] = useState<MemberApiConnectionSettings>({ ...settings });
  const [status, setStatus] = useState('');

  useEffect(() => {
    setDraft({ ...settings });
  }, [
    settings.baseUrl,
    settings.bulkSaveEndpoint,
    settings.catalogEndpoint,
    settings.saveEndpoint,
    settings.verifyEndpoint
  ]);

  function update(key: keyof MemberApiConnectionSettings, value: string): void {
    setStatus('');
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function persist(): Promise<void> {
    const validationError = validateMemberApiDraft(draft);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setStatus('저장 중');
    const saved = await onSave({ browserMemberApi: draft });
    if (!saved) {
      setStatus('저장 실패');
      return;
    }
    setDraft({ ...saved.browserMemberApi });
    setStatus('저장 완료 · 확장에 자동 적용');
  }

  return (
    <Card title="Member API 연결" className="settings-only">
      <p className="subtle">
        실제 판매자 페이지에서 확인한 Weidian GET endpoint입니다. 상대 경로나 Weidian HTTPS 전체 URL을 입력할 수 있습니다.
      </p>
      <label>
        API Base URL
        <input
          value={draft.baseUrl}
          onChange={(event) => update('baseUrl', event.target.value)}
          placeholder="https://thor.weidian.com"
          spellCheck={false}
        />
      </label>
      <label>
        판매자 등급 카탈로그 endpoint
        <input
          value={draft.catalogEndpoint}
          onChange={(event) => update('catalogEndpoint', event.target.value)}
          placeholder="/wdcrm/trade.searchMemberByShopId/1.0"
          spellCheck={false}
        />
      </label>
      <label>
        개별 회원 등급 변경 endpoint
        <input
          value={draft.saveEndpoint}
          onChange={(event) => update('saveEndpoint', event.target.value)}
          placeholder="/wdcrm/trade.setMemberLevel/2.0"
          spellCheck={false}
        />
      </label>
      <label>
        검색조건 일괄 변경 endpoint
        <input
          value={draft.bulkSaveEndpoint}
          onChange={(event) => update('bulkSaveEndpoint', event.target.value)}
          placeholder="/wdcrm/trade.setMemberLevelWithSearchCondition/2.0"
          spellCheck={false}
        />
      </label>
      <label>
        저장 후 재조회 endpoint
        <input
          value={draft.verifyEndpoint}
          onChange={(event) => update('verifyEndpoint', event.target.value)}
          placeholder="/wdcrm/customer.summary.pc/1.0"
          spellCheck={false}
        />
      </label>
      <KeyValue
        label="저장 URL 미리보기"
        value={safeMemberApiUrl(draft.baseUrl, draft.saveEndpoint)}
      />
      <div className="button-row">
        <button
          onClick={() => {
            setDraft({ ...DEFAULT_MEMBER_API_CONNECTION });
            setStatus('기본값 입력됨 · 저장 필요');
          }}
        >
          기본값
        </button>
        <button className="primary grow" onClick={() => void persist()}>
          <Save size={14} /> 저장 및 적용
        </button>
      </div>
      {status ? <p className="subtle">{status}</p> : null}
    </Card>
  );
}

function safeMemberApiUrl(baseUrl: string, endpoint: string): string {
  try {
    return resolveMemberApiUrl(baseUrl, endpoint);
  } catch {
    return 'URL 형식을 확인하세요.';
  }
}

function validateMemberApiDraft(value: MemberApiConnectionSettings): string {
  try {
    const base = new URL(value.baseUrl);
    if (base.protocol !== 'https:' || !/(^|\.)weidian\.com$/i.test(base.hostname)) {
      return 'Base URL은 Weidian HTTPS URL이어야 합니다.';
    }
  } catch {
    return 'Base URL 형식을 확인하세요.';
  }
  for (const [label, endpoint] of [
    ['등급 카탈로그', value.catalogEndpoint],
    ['개별 저장', value.saveEndpoint],
    ['검색조건 일괄 저장', value.bulkSaveEndpoint],
    ['저장 후 재조회', value.verifyEndpoint]
  ] as const) {
    if (!endpoint.startsWith('/') && !/^https?:\/\//i.test(endpoint)) {
      return `${label} endpoint는 /로 시작하는 경로나 완전한 URL이어야 합니다.`;
    }
    try {
      resolveMemberApiUrl(value.baseUrl, endpoint);
    } catch {
      return `${label} endpoint 형식을 확인하세요.`;
    }
  }
  return '';
}

interface ReservationWorkspaceProps {
  settings: AppSettings;
  bridge?: BrowserBridgeState;
  reservation: BrowserReservationStatus;
  time?: TimeSyncSnapshot;
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings | undefined>;
  onSync: () => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onQueue: (type: BrowserCommandType, payload?: Record<string, unknown>) => Promise<void>;
}

function ReservationWorkspace(props: ReservationWorkspaceProps): JSX.Element {
  const { settings, bridge, reservation, time, onSave } = props;
  const snapshot = bridge?.snapshot;
  const remaining = reservation.targetServerEpochMs
    ? reservation.targetServerEpochMs - Date.now() - (time?.offsetMs ?? 0)
    : undefined;

  return (
    <section className="compact-workspace reservation-layout">
      <div className="column">
        <Card title="예약 대상">
          <label>
            URL
            <input
              value={settings.browserUrl}
              onChange={(event) => void onSave({ browserUrl: event.target.value })}
              placeholder="Weidian 상품 URL 또는 k.youshop10.com 공유 URL"
            />
          </label>
          <label>
            옵션 키워드
            <input
              value={settings.browserReservationOptionKeyword}
              onChange={(event) => void onSave({ browserReservationOptionKeyword: event.target.value })}
              placeholder="예: 黑色吊带M (선택)"
            />
          </label>
          <label>
            실행 모드
            <select
              value={settings.browserReservationMode}
              onChange={(event) =>
                void onSave({ browserReservationMode: event.target.value === 'checkout' ? 'checkout' : 'preview' })
              }
            >
              <option value="preview">재고·옵션 미리보기</option>
              <option value="checkout">주문 확인 화면까지</option>
            </select>
          </label>
          <div className="safe-note">
            주문 확인 화면 이후의 `주문 생성`은 Chrome 패널에서 다시 직접 확인해야 하며, QR 결제와 최종 승인은 자동화하지 않습니다.
          </div>
        </Card>

        <Card title="실행 시간">
          <label>
            한국 실행시간
            <input
              type="datetime-local"
              step="1"
              value={toDateTimeLocal(settings.targetServerTime)}
              onChange={(event) => void onSave({ targetServerTime: event.target.value })}
            />
          </label>
          <div className="time-grid">
            <Metric label="Offset" value={time ? `${formatSigned(time.offsetMs)}ms` : '-'} />
            <Metric label="불확실성" value={time ? `±${time.uncertaintyMs}ms` : '-'} />
            <Metric label="표본" value={time ? `${time.sampleCount}회` : '-'} />
          </div>
          <div className="button-row">
            <button onClick={props.onSync}>
              <RefreshCw size={14} /> 시간 동기화
            </button>
            {!reservation.running ? (
              <button className="primary grow" onClick={props.onStart} disabled={!settings.browserUrl}>
                <Play size={14} /> 예약 시작
              </button>
            ) : (
              <button className="danger-button grow" onClick={props.onStop}>
                <Square size={14} /> 예약 중지
              </button>
            )}
          </div>
        </Card>
      </div>

      <div className="column">
        <Card title="예약 상태" action={<BridgeBadge connected={Boolean(bridge?.connected)} />}>
          <div className={`reservation-hero ${reservation.running ? 'active' : ''}`}>
            <span>{reservation.phase}</span>
            <strong>{remaining === undefined ? '--:--:--' : formatDuration(Math.max(0, remaining))}</strong>
            <p>{reservation.message || '예약을 시작하지 않았습니다.'}</p>
          </div>
          <KeyValue label="한국 실행시간" value={reservation.targetServerTime ? new Date(reservation.targetServerEpochMs!).toLocaleString('ko-KR') : '-'} />
          <KeyValue label="현재 서버시간" value={time ? new Date(Date.now() + time.offsetMs).toLocaleString('ko-KR') : '-'} />
          <KeyValue label="시간 동기화" value={time ? `정밀 ${formatSigned(time.offsetMs)}ms ±${time.uncertaintyMs}ms · ${time.sampleCount}회` : '-'} tone="green" />
          <KeyValue label="수량 / 모드" value={`${snapshot?.options.length ?? 0}종 · ${settings.browserReservationMode}`} />
        </Card>

        <Card title="옵션 · 재고 · 가격">
          <KeyValue label="현재 표시 재고" value={snapshot ? stockLabel(snapshot) : '-'} tone="green" />
          <div className="option-list tall">
            {snapshot?.options.length ? (
              snapshot.options.map((option) => (
                <div className="option-row detailed" key={option.id}>
                  <div>
                    <strong>{option.name}</strong>
                    <span>{option.priceText || snapshot.priceText || '-'}</span>
                    <small>{option.stock === undefined ? '재고 확인 불가' : `재고 ${option.stock}`}</small>
                  </div>
                  <span className="option-select">{settings.browserReservationOptionKeyword === option.name ? '선택' : '—'}</span>
                </div>
              ))
            ) : (
              <Empty>Chrome에서 상품의 옵션 선택창을 열면 감지된 옵션이 표시됩니다.</Empty>
            )}
          </div>
          <button className="full" onClick={() => props.onQueue('open-options')}>Chrome 옵션 선택창 열기</button>
        </Card>
      </div>

      <div className="column">
        <Card title="실행 점검">
          <Checklist ok={Boolean(bridge?.connected)}>Chrome 확장 프로그램 연결</Checklist>
          <Checklist ok={Boolean(time)}>서버시간 동기화</Checklist>
          <Checklist ok={Boolean(settings.browserUrl)}>상품 URL 입력</Checklist>
          <Checklist ok={settings.browserReservationMode === 'preview' || Boolean(settings.browserReservationOptionKeyword)}>
            옵션 키워드 입력 또는 미리보기
          </Checklist>
          <Checklist ok>최종 결제 수동 승인</Checklist>
        </Card>
        <Card title="안전 경계">
          <p className="safety-copy">
            정상 페이지와 사용자 Chrome 세션만 사용합니다. 구매제한·대기열·캡차·본인인증을 우회하지 않으며, 서버 회원등급은 변경하지 않습니다.
          </p>
          <p className="safety-copy">
            주문 확인 화면에서는 Chrome 패널의 수동 확인 버튼을 눌러야 미결제 주문이 생성됩니다. QR 스캔과 결제 승인은 휴대전화에서 직접 수행합니다.
          </p>
        </Card>
      </div>
    </section>
  );
}

function Card({
  title,
  action,
  className = '',
  children
}: {
  title: string;
  action?: JSX.Element;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

function Status({
  ok,
  accent,
  icon,
  children
}: {
  ok?: boolean;
  accent?: boolean;
  icon: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  return <span className={`status ${ok ? 'ok' : ''} ${accent ? 'accent' : ''}`}>{icon}{children}</span>;
}

function BridgeBadge({ connected }: { connected: boolean }): JSX.Element {
  return <span className={`bridge-badge ${connected ? 'connected' : ''}`}>{connected ? '실행 중' : '대기 중'}</span>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return <div className={`metric ${tone || ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function KeyValue({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'amber' }): JSX.Element {
  return <div className="key-value"><span>{label}</span><strong className={tone || ''}>{value}</strong></div>;
}

function Checklist({ ok, children }: { ok: boolean; children: ReactNode }): JSX.Element {
  return <div className={`checklist ${ok ? 'ok' : ''}`}><span>{ok ? '✓' : '!'}</span>{children}</div>;
}

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}

function MemberApiContractRow({
  contract
}: {
  contract: BrowserMemberApiContractObservation;
}): JSX.Element {
  return (
    <div className="member-contract-row">
      <div>
        <strong>{contract.method} · {contract.status || '-'}</strong>
        <span>{contract.url}</span>
      </div>
      <small>{contract.tokenPlacement} · {contract.sampleCount}회</small>
    </div>
  );
}

function contractShapeKeys(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value : '-';
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length ? keys.slice(0, 24).join(', ') : '-';
}

function LogRail({ logs }: { logs: LogEntry[] }): JSX.Element {
  const latest = logs.at(-1);
  return (
    <div className="log-rail">
      <strong>상태</strong>
      <span>{latest ? `${new Date(latest.at).toLocaleTimeString('ko-KR')} · ${latest.message}` : '로그 없음'}</span>
    </div>
  );
}

function defaultMemberLevels(): BrowserMemberLevel[] {
  return [1, 2, 3, 4, 5, 6].map((rank) => ({
    id: `vip-${rank}`,
    label: `VIP${rank}`,
    rank
  }));
}

function memberLevelsFor(settings: AppSettings, snapshot: BrowserPageSnapshot | undefined): BrowserMemberLevel[] {
  if (snapshot?.memberServerState?.gradeNames.length) {
    return snapshot.memberServerState.gradeNames.map((label, index) => ({
      id:
        snapshot.memberLevels.find((level) => level.label === label)?.id ||
        `server-grade-${index}`,
      label,
      rank: index + 1,
      rawText: snapshot.memberLevels.find((level) => level.label === label)?.rawText
    }));
  }
  const detected = snapshot?.memberLevels || [];
  if (detected.length) {
    return detected;
  }
  const stored = snapshot?.shopId ? settings.browserMemberLevelsByShop[snapshot.shopId] : undefined;
  return stored?.length ? stored : defaultMemberLevels();
}

function parseBuyerIds(value: string): string[] {
  return [...new Set(
    value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z0-9_-]{1,100}$/.test(item))
  )].slice(0, 200);
}

function selectedMemberPreview(
  settings: AppSettings,
  snapshot: BrowserPageSnapshot | undefined,
  levels: BrowserMemberLevel[]
): MemberPreviewWithServerIndex {
  const shopPreview = snapshot?.shopId ? settings.browserMemberPreviewByShop[snapshot.shopId] : undefined;
  const base = shopPreview || {
    shopId: snapshot?.shopId,
    levelId: settings.browserMemberPreviewLevelId,
    levelLabel: `VIP${settings.browserMemberPreviewRank}`,
    rank: settings.browserMemberPreviewRank,
    name: settings.browserMemberPreviewName,
    nextValue: settings.browserMemberNextValue,
    serverIndex: snapshot?.memberServerState?.serverIndex ?? 0,
    targetIndex: snapshot?.memberServerState?.serverIndex ?? 0
  };
  const requestedTargetIndex =
    Number.isInteger(base.targetIndex) && base.targetIndex >= 0 && base.targetIndex < levels.length
      ? base.targetIndex
      : undefined;
  const selected =
    (requestedTargetIndex !== undefined ? levels[requestedTargetIndex] : undefined) ||
    levels.find((level) => level.id === base.levelId) ||
    levels.find((level) => level.rank === base.rank) ||
    levels[0] ||
    defaultMemberLevels()[0];
  const selectedIndex = levels.findIndex((level) => level.id === selected.id);
  return {
    shopId: snapshot?.shopId,
    levelId: selected.id,
    levelLabel: selected.label,
    rank: selected.rank,
    name: base.name || selected.label,
    nextValue: Math.max(0, Number(base.nextValue) || 0),
    serverIndex: snapshot?.memberServerState?.serverIndex ?? base.serverIndex ?? (selectedIndex >= 0 ? selectedIndex : 0),
    targetIndex: requestedTargetIndex ?? (selectedIndex >= 0 ? selectedIndex : 0),
    originalProgress: snapshot?.memberServerState?.originalProgress ?? base.originalProgress
  };
}

function sumStock(options: Array<{ stock?: number }>): string {
  const known = options.filter((option) => option.stock !== undefined);
  return known.length ? `${known.reduce((sum, option) => sum + (option.stock ?? 0), 0)}개` : '확인 불가';
}

function stockLabel(snapshot: BrowserPageSnapshot): string {
  return snapshot.stockTotal === undefined ? sumStock(snapshot.options) : `${snapshot.stockTotal}개`;
}

function saleLabel(status: string | undefined): string {
  return { on_sale: '판매 중', scheduled: '판매 예정', sold_out: '품절', unknown: '확인 불가' }[status || 'unknown'] || '확인 불가';
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${days ? `${days}일 ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatTokenRemaining(expiresAtEpochMs: number | undefined): string {
  if (!expiresAtEpochMs) return '-';
  const totalSeconds = Math.max(0, Math.ceil((expiresAtEpochMs - Date.now()) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function toDateTimeLocal(value: string): string {
  if (!value) return '';
  return value.length >= 19 ? value.slice(0, 19) : value;
}
