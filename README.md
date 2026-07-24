# 노무현

Chrome과 Weidian 모바일 웹을 제어하는 macOS Electron 앱입니다. 첨부 영상처럼 데스크톱 앱은 `상점 뷰어`와 `예약 주문` 탭을 제공하고, Chrome 페이지 오른쪽에는 `노무현` 확장 패널을 주입합니다.

최종 결제, QR 스캔, 결제 비밀번호, 로그인, 본인인증, 캡차는 사용자가 직접 처리해야 합니다. 구매제한 해제, 대기열/선착순 우회, 인증 우회, 결제 자동 승인은 구현하지 않습니다.

## 기능

- Weidian HTTPS 상품/상점 URL을 Chrome에서 열기
- Chrome 확장 프로그램과 로컬 브리지 연결
- 현재 페이지 상품명, 상점 ID, 상품 ID, 가격, 판매 상태, 판매 예정 시간 추출
- 옵션 후보, 가격, 재고, SKU, 수량 표시
- 대표 이미지 또는 전체 이미지 다운로드
- 상점 최대 15개 저장, 메모, referer, 고정 표시
- 페이지 워터마크 표시
- VIP1~VIP6 회원등급 로컬 화면 미리보기와 복구
- 앱 또는 Chrome 패널에서 회원등급, 표시 이름, 다음 등급 금액 직접 세팅
- HTTP `Date` 헤더 기반 서버시간 동기화
- 목표 서버시간에 맞춘 옵션창/주문확인 화면 진입
- 주문 생성 전 Chrome 패널에서 사용자 수동 확인
- 결제 대기/QR 화면 도착 감지
- Member 상세 페이지의 `serverIndex`, `targetIndex`, 등급 카탈로그 동기화
- 실제 Member 응답(`memberIdentityCenter/1.0`) 관찰 기반 등급·진행도 읽기
- 페이지 bootstrap·fetch·XHR의 actionToken 감지와 `empty → acquiring → ready/not-found` 상태 전이
- Chrome 확장 메모리 전용 actionToken 수명주기와 fingerprint 표시
- 실제 쓰기 endpoint 미설정 상태를 읽기·토큰 상태와 분리
- 소유·승인된 `127.0.0.1:4173` Mock 서버를 통한 저장·초기화·재조회 테스트

## Member actionToken 보안 경계

`actionToken` 원문은 Chrome 확장 service worker 메모리에서만 관리합니다. Electron Renderer,
AppSettings, 브리지 Snapshot, 로그에는 원문이 전달되지 않습니다. UI에는 상태, 12자리 SHA-256
fingerprint, 발급·만료·소비 시각만 표시됩니다.

로그인 세션은 Chrome `cookies` API로 읽은 Weidian 쿠키를 service worker 안에서 즉시
SHA-256 해시해 구분합니다. 쿠키 원문은 저장하거나 외부로 전달하지 않으며, Weidian 쿠키 변경,
탭 이동·종료, 상점 변경, 확장 재시작 때 기존 토큰을 폐기합니다.

Member 서버 저장은 다음 흐름을 사용합니다.

```text
VIP targetIndex 선택
→ sync-vip-grades
→ actionToken 준비
→ save-vip-settings
→ 토큰 즉시 소비
→ Member 상태 재조회
→ 실제 serverIndex === targetIndex일 때만 성공
```

`apply-member-preview`와 `restore-member-preview`는 로컬 DOM 표시만 바꾸며 서버 요청을 하지
않습니다. `reset-vip-settings`는 승인 서버 초기화 명령이므로 로컬 원복과 별개입니다.

## 실행

```bash
cd /Users/cool/Documents/Codex/weidian-nox-helper
npm install
npm run dev
```

이 저장소는 `pnpm-lock.yaml`을 사용합니다. 번들 Node 환경에서는 다음처럼 직접 실행할 수도
있습니다.

```bash
pnpm install
pnpm run build:source
```

## 로컬 Member 취약점 재현 랩

이 랩은 작성자가 주장한 접근제어 취약점 클래스를 로컬 메모리 서버에서 재현하고 수정 전후
동작을 비교하기 위한 것입니다. 실제 Weidian 운영 endpoint를 사용하지 않습니다. 두 모드의
`GET /health`는 항상 실제 쓰기 어댑터를 다음 상태로 보고합니다.

```text
disabled / MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED
```

수정 모드는 기본값입니다.

```bash
npm run lab:member:fixed
```

의도적으로 취약한 비교 서버는 별도로 실행합니다.

```bash
npm run lab:member:vulnerable
```

두 명령은 기본적으로 `http://127.0.0.1:4173`을 사용하므로 동시에 실행하려면 두 번째
프로세스에 다른 `MEMBER_LAB_PORT`를 지정합니다.

```bash
MEMBER_LAB_PORT=4174 npm run lab:member:vulnerable
```

자동 재현 검증:

```bash
npm run lab:member:verify
```

현재 Codex 번들 Node만 있고 `node`/`npm`이 PATH에 없는 환경에서는 다음처럼 직접 실행할 수
있습니다.

```bash
MEMBER_LAB_MODE=fixed /Users/cool/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/mock-member-server.mjs
/Users/cool/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/build-tests.mjs
/Users/cool/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test .test-dist/tests/member-security-lab.test.js
```

검증 범위:

- HttpOnly, SameSite=Strict 세션 쿠키 발급·검증·만료·로그아웃
- 상점·세션·명령에 귀속된 120초 일회성 actionToken
- 토큰 만료, 재발급, 이미 사용됨, 동시 중복 요청 하나만 허용
- `shopId`, `serverIndex`, `targetIndex`, `remaining`, `originalProgress` 저장 전후 재조회
- 취약 모드에서 일반 회원의 무권한 `serverIndex` 변경 재현
- 수정 모드에서 역할, 상점 권한, 허용 필드, stale 상태, 등급 산정 규칙 재검증
- 감사 로그에는 쿠키와 토큰 원문 대신 12자리 SHA-256 fingerprint만 기록

지원 경로:

```text
POST /api/lab/login
POST /api/lab/logout
GET  /api/lab/config
GET  /api/lab/audit
POST /api/member/context
POST /api/member/action-token
POST /api/member/save
POST /api/member/reset
GET  /health
```

로컬 계정은 서버 코드에 고정된 테스트 fixture이며 요청에서 role을 받지 않습니다.

| 계정 | 테스트 비밀번호 | 서버 역할 | 허용 상점 |
| --- | --- | --- | --- |
| `member` | `member-test` | `member` | 없음 |
| `shop-admin-a` | `shop-admin-a-test` | `shop-admin` | `1680489787` |
| `shop-admin-b` | `shop-admin-b-test` | `shop-admin` | `2098765432` |
| `platform-admin` | `platform-admin-test` | `platform-admin` | 전체 |

취약 모드는 유효한 로그인 세션과 해당 세션에 발급된 actionToken만 검사합니다. 일반 회원도
`targetIndex`를 서버의 `serverIndex`로 저장할 수 있고, 클라이언트가 보낸 `remaining`과
`originalProgress`도 신뢰합니다.

수정 모드는 actionToken을 소비한 뒤에도 다음 조건을 서버에서 모두 다시 검사합니다.

1. 역할이 `shop-admin` 또는 `platform-admin`인지
2. 해당 `shopId`에 쓰기 권한이 있는지
3. payload가 명시된 allowlist 필드만 포함하는지
4. 읽었던 `serverIndex`와 등급 카탈로그가 아직 같은지
5. 서버가 보관한 누적금액과 등급 임계값으로 계산한 등급이 `targetIndex`와 같은지

기본 상점의 서버 보관 누적금액은 `12,000`이고 임계값은
`[0, 3000, 7000, 11000, 16000, 30000]`입니다. 따라서 서버 산정 `targetIndex`는 `3`,
`remaining`은 `4,000`, `originalProgress`는 `20`입니다. 클라이언트가 이 계산값을 바꿔
보내도 수정 모드에서는 저장하지 않습니다.

상태, 세션, actionToken, 감사 로그는 모두 메모리에만 존재하며 서버 종료 시 삭제됩니다.

## Member 페이지 접속

로그인된 Chrome에서 본인 소유 또는 테스트 상점의 Member 상세 페이지를 엽니다.

```text
https://h5.weidian.com/m/mkt-h5-member-detail/index.html?shopId=상점ID
```

VIP 탭에서 다음 순서로 확인합니다.

1. 페이지를 열면 자동으로 실행되는 `등급 동기화` 결과 확인
2. 현재 `serverIndex`, `gradeNames`, actionToken 상태 확인
3. 목표 등급 선택
4. 필요하면 `미리보기 적용`
5. `서버 저장`
6. 재조회된 `serverIndex`가 `targetIndex`와 같은지 확인

## actionToken source 설정

실제 확장 런타임 기본값은
[`extension/src/member/member-action-adapter.ts`](extension/src/member/member-action-adapter.ts)의
`LIVE_PAGE_MEMBER_CONFIG`입니다. Member 상태는 실제 페이지 컨텍스트에서 읽고 actionToken은
Page Main 관찰기로 찾으며, 쓰기 endpoint만 `not-configured` 상태로 둡니다.

`DEFAULT_AUTHORIZED_MEMBER_CONFIG`는 `127.0.0.1:4173` Mock 전체 저장 테스트에 사용합니다.

actionToken은 API 주소나 payload를 대신하지 않습니다. 승인된 실제 관리자 API를 연결하려면
다음 세 계약을 각각 공식 API 문서 또는 본인 소유 테스트 환경의 정상 네트워크 흐름으로
확인해야 합니다.

1. `tokenSource`: 토큰 발급 URL, Method, JSON 경로, 만료 필드
2. `stateSource`: 저장 전·후 Member 조회 URL, Method, 응답의 등급 필드
3. `writeEndpoint`: 저장/reset URL, Method, actionToken 위치, shopId·targetIndex 필드,
   현재 로그인 사용자 적용인지 explicit memberId가 필요한지 여부

Origin, Referer, Content-Type, Chrome 쿠키 전달 방식과 성공·실패 응답 구조도 계약에 포함됩니다.
현재 설정 타입은 이 계약을 선언하기 위한 것이며, 실제 쓰기 필드 매핑이 확인되면
`LIVE_PAGE_MEMBER_CONFIG.writeEndpoint`에 정확한 Weidian HTTPS endpoint와 필드 계약을
설정합니다. 라이브 모드는 `*.weidian.com` HTTPS만 허용하고 Mock 모드는
`127.0.0.1:4173`만 허용합니다.

미설정 상태에서는 네트워크 요청 전에 다음 오류를 반환합니다.

```text
ACTION_TOKEN_SOURCE_NOT_CONFIGURED
ACTION_TOKEN_NOT_FOUND
MEMBER_STATE_ENDPOINT_NOT_CONFIGURED
MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED
```

`save_vip_settings`, `sync_vip_grades`, `reset_vip_settings`는 앱 내부 명령명이며 실제 Weidian
API 경로로 취급하지 않습니다. 페이지의 정상 저장 버튼이나 내부 함수를 재사용하는 방식도
실제 기능과 권한이 확인된 경우에만 별도 Page Main adapter로 구현해야 합니다.

확인되지 않은 Weidian 엔드포인트, 결제용 `ct`/`token`, Cookie 또는 Authorization 값을 Member
요청에 재사용하지 않습니다.

## 배포 빌드

```bash
npm run build:source
npm run package:local
```

결과:

```text
release/mac-arm64-v0.4/노무현.app
release/mac-arm64-v0.4/노무현-v0.4.0-mac-arm64.zip
```

배포 기준은 ZIP입니다. 스크립트는 임시 경로에서 앱을 서명하고 ZIP 추출본까지 검증합니다.

## Chrome 확장 설치

1. `노무현` 앱을 실행합니다.
2. 앱의 `확장 폴더` 버튼을 누릅니다.
3. Chrome에서 `chrome://extensions`를 엽니다.
4. `개발자 모드`를 켭니다.
5. `압축해제된 확장 프로그램을 로드`를 누릅니다.
6. 앱이 열어준 `ew-weidian-chrome-extension` 폴더를 선택합니다.
7. Weidian 상품 URL을 열고 로그인은 직접 완료합니다.

정상 연결되면 앱의 브리지 상태가 `연결됨`으로 바뀌고, Weidian 페이지 오른쪽에 어두운 `노무현` 패널이 나타납니다.

## 테스트

```bash
npm run typecheck
npm test
npm run build:source
npm run package:local
```

테스트 범위:

- 서버시간 오차 계산과 표본 선택
- Chrome 확장 Origin 제한
- Weidian 관측 데이터 정규화
- 예약 상태 전이
- 메인/프리로드/렌더러 번들 생성
- ASAR 무결성 해시 갱신과 ZIP 재검증
- actionToken fingerprint·만료·소비 상태
- 세션·상점 변경 시 토큰 폐기
- 중복 requestId와 저장 더블클릭 차단
- 저장 후 서버 상태 재조회 검증
- Timeout 후 동일 토큰 미사용 및 최대 1회 재시도

## 지원 Member 오류코드

주요 오류:

```text
ACTION_TOKEN_MISSING
ACTION_TOKEN_NOT_FOUND
ACTION_TOKEN_EXPIRED
ACTION_TOKEN_INVALID
ACTION_TOKEN_ALREADY_USED
ACTION_TOKEN_ALREADY_ACQUIRING
ACTION_TOKEN_ALREADY_CONSUMING
ACTION_TOKEN_ALREADY_CONSUMED
ACTION_TOKEN_CONTEXT_MISMATCH
ACTION_TOKEN_SOURCE_NOT_CONFIGURED
MEMBER_STATE_ENDPOINT_NOT_CONFIGURED
MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED
SESSION_MISSING
SESSION_CHANGED
SESSION_EXPIRED
SESSION_FINGERPRINT_FAILED
SHOP_ID_MISSING
SHOP_ID_MISMATCH
SERVER_INDEX_INVALID
SERVER_INDEX_MISMATCH
TARGET_INDEX_INVALID
TARGET_INDEX_OUT_OF_RANGE
GRADE_NAMES_INVALID
GRADE_CATALOG_MISMATCH
PERMISSION_DENIED
MEMBER_ACTION_ALREADY_RUNNING
DUPLICATE_CLIENT_REQUEST
CLIENT_REQUEST_ID_MISSING
TARGET_PAGE_URL_MISSING
TARGET_PAGE_MISMATCH
NETWORK_TIMEOUT
NETWORK_ERROR
SERVER_RESPONSE_INVALID
SERVER_STATE_NOT_CHANGED
```

endpoint 미설정, 권한 거부와 컨텍스트 불일치는 자동 재시도하지 않습니다. 만료·이미 사용된
토큰과 네트워크 Timeout은 상태를 먼저 재조회하고, 미반영일 때 새 토큰으로 최대 한 번만
재시도합니다.

## 토큰 보관·로그 정책

허용:

- Chrome 확장 service worker 메모리
- 필요 시 Chrome 종료 시 폐기되는 `chrome.storage.session`
- UI/로그의 token fingerprint와 만료 metadata

금지:

- `localStorage`, `sessionStorage`, `chrome.storage.local`
- AppSettings, JSON 설정 파일, SQLite
- Electron IPC payload와 React state
- 로그·오류 메시지·Crash dump

앱 로그는 macOS Electron `userData/logs/ew-weidian.log`에 기록됩니다. `actionToken`, `token`,
`ct`, `cookie`, `authorization`, `qrCodeStatusKey`, session 관련 키는 중앙 Logger에서
`[REDACTED]` 처리됩니다.

## 구조

```text
weidian-nox-helper/
  chrome-extension/
    manifest.json
    background.js
    content.js
    page-main.js
  extension/
    src/
      background.ts
      content.ts
      page-main.ts
      member/
        action-token-manager.ts
        member-action-adapter.ts
        member-command-handler.ts
        member-context.ts
        member-errors.ts
        member-types.ts
  src/
    main/
      browserBridge.ts
      browserReservation.ts
      main.ts
      timeSync.ts
      logger.ts
    preload/
      preload.ts
    renderer/
      App.tsx
      styles.css
    common/
      config.ts
      types.ts
      timeSyncCore.ts
  tests/
    action-token-manager.test.ts
    browserBridge.test.ts
    member-adapter-contract.test.ts
    member-command-handler.test.ts
    member-save-flow.test.ts
    member-security-lab.test.ts
    member-session-change.test.ts
    member-timeout-retry.test.ts
    timeSyncCore.test.ts
  scripts/
    build-source.mjs
    build-tests.mjs
    member-security-lab-core.mjs
    mock-member-server.mjs
    package-local.mjs
```
