[CmdletBinding()]
param(
  [string]$Branch = 'agent/member-preview-simulator',
  [string]$FolderName = 'weidian-nox-helper'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoUrl = 'https://github.com/shxxk77-netizen/weidian-nox-helper.git'
$Desktop = [Environment]::GetFolderPath('Desktop')
$Target = Join-Path $Desktop $FolderName

function Require-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "필수 명령을 찾지 못했습니다: $Name"
  }
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  Write-Host "`n==> $Title" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Title 단계가 종료 코드 $LASTEXITCODE 로 실패했습니다."
  }
}

Require-Command git
Require-Command node
Require-Command npm

$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "Node.js 20 이상이 필요합니다. 현재 버전: $nodeVersion"
}

if (Test-Path $Target) {
  if (-not (Test-Path (Join-Path $Target '.git'))) {
    throw "바탕화면의 $Target 폴더가 Git 저장소가 아닙니다. 폴더명을 바꾸거나 비운 뒤 다시 실행하세요."
  }

  Push-Location $Target
  try {
    $dirty = git status --porcelain
    if ($dirty) {
      throw "기존 저장소에 커밋되지 않은 변경이 있습니다. 변경을 정리한 뒤 다시 실행하세요.`n$dirty"
    }
    Invoke-Step '원격 브랜치 갱신' { git fetch origin $Branch }
    Invoke-Step "브랜치 전환: $Branch" { git switch $Branch }
    Invoke-Step '최신 커밋 적용' { git pull --ff-only origin $Branch }
  }
  finally {
    Pop-Location
  }
}
else {
  Invoke-Step "바탕화면에 저장소 복제: $Target" {
    git clone --branch $Branch --single-branch $RepoUrl $Target
  }
}

Push-Location $Target
try {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Require-Command corepack
    Invoke-Step 'Corepack 활성화' { corepack enable }
    Invoke-Step 'pnpm 9 활성화' { corepack prepare pnpm@9.15.5 --activate }
  }

  Require-Command pnpm
  Invoke-Step '의존성 설치' { pnpm install --no-frozen-lockfile }
  Invoke-Step 'TypeScript 검사' { pnpm run typecheck }
  Invoke-Step '테스트 실행' { pnpm test }
  Invoke-Step '소스 번들 빌드' { pnpm run build:source }
  Invoke-Step 'Windows x64 portable 실행 파일 빌드' {
    pnpm exec electron-builder --win portable --x64 --publish never
  }

  $artifact = Get-ChildItem -Path (Join-Path $Target 'release') -Filter '*.exe' -File -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  Write-Host "`n완료" -ForegroundColor Green
  Write-Host "소스: $Target"
  Write-Host "브랜치: $(git branch --show-current)"
  Write-Host "커밋: $(git rev-parse --short HEAD)"

  if ($artifact) {
    Write-Host "실행 파일: $($artifact.FullName)" -ForegroundColor Green
    Start-Process explorer.exe -ArgumentList "/select,`"$($artifact.FullName)`""
  }
  else {
    Write-Host "release 폴더에서 EXE를 찾지 못했습니다." -ForegroundColor Yellow
    Start-Process explorer.exe -ArgumentList "`"$(Join-Path $Target 'release')`""
  }
}
finally {
  Pop-Location
}
