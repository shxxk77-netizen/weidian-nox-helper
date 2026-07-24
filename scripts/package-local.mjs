import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceApp = findSourceApp(path.join(root, 'release/mac-arm64'));
const targetRoot = path.join(root, 'release/mac-arm64-v0.4');
const targetApp = path.join(targetRoot, '노무현.app');
const targetArchive = path.join(targetRoot, '노무현-v0.4.0-mac-arm64.zip');

if (!fs.existsSync(sourceApp)) {
  throw new Error('기존 Electron 앱 셸을 찾을 수 없습니다. 먼저 electron-builder 패키지를 한 번 생성하세요.');
}

const workRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'weidian-helper-package-'));
const workApp = path.join(workRoot, '노무현.app');
const workArchive = path.join(workRoot, '노무현-v0.4.0-mac-arm64.zip');
const stage = path.join(workRoot, 'asar');
const verificationRoot = path.join(workRoot, 'verify');
try {
  console.log('Electron 앱 셸 복사 중...');
  await execFileAsync('/usr/bin/ditto', ['--norsrc', '--noextattr', sourceApp, workApp]);
  console.log('Electron 앱 셸 복사 완료');

  await fs.promises.mkdir(stage, { recursive: true });
  await fs.promises.cp(path.join(root, 'out'), path.join(stage, 'out'), { recursive: true });
  await fs.promises.cp(path.join(root, 'chrome-extension'), path.join(stage, 'chrome-extension'), { recursive: true });
  await fs.promises.copyFile(path.join(root, 'package.json'), path.join(stage, 'package.json'));
  await fs.promises.cp(
    path.join(root, 'chrome-extension'),
    path.join(workApp, 'Contents/Resources/chrome-extension'),
    { recursive: true }
  );

  console.log('app.asar 생성 중...');
  const asar = await loadAsar(root);
  const asarPath = path.join(workApp, 'Contents/Resources/app.asar');
  await asar.createPackage(stage, asarPath);
  console.log('app.asar 생성 완료');

  const asarHash = createHash('sha256').update(await fs.promises.readFile(asarPath)).digest('hex');
  const infoPlist = path.join(workApp, 'Contents/Info.plist');
  const { stdout: originalBundleNameOutput } = await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleName',
    infoPlist
  ]);
  const originalBundleName = originalBundleNameOutput.trim();
  const brandedBundleName = '노무현';
  await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarHash}`,
    infoPlist
  ]);

  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'CFBundleShortVersionString',
    '-string',
    '0.4.0',
    infoPlist
  ]);
  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'CFBundleVersion',
    '-string',
    '3',
    infoPlist
  ]);
  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'CFBundleDisplayName',
    '-string',
    '노무현',
    infoPlist
  ]);
  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'CFBundleName',
    '-string',
    originalBundleName,
    infoPlist
  ]);
  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    'local.ew.weidian',
    infoPlist
  ]);
  const localizedInfo = [
    `"CFBundleDisplayName" = "${brandedBundleName}";`,
    `"CFBundleName" = "${brandedBundleName}";`,
    ''
  ].join('\n');
  for (const locale of ['ko', 'en']) {
    const localizationDirectory = path.join(workApp, 'Contents/Resources', `${locale}.lproj`);
    await fs.promises.mkdir(localizationDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(localizationDirectory, 'InfoPlist.strings'), localizedInfo, 'utf8');
  }

  console.log('로컬 실행용 임시 서명 중...');
  await execFileAsync('/usr/bin/xattr', ['-cr', workApp]);
  await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', workApp]);
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', workApp]);

  console.log('검증 가능한 배포 ZIP 생성 중...');
  await execFileAsync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--norsrc',
    '--noextattr',
    '--keepParent',
    workApp,
    workArchive
  ]);
  await fs.promises.mkdir(verificationRoot, { recursive: true });
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', workArchive, verificationRoot]);
  const extractedApp = path.join(verificationRoot, '노무현.app');
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);

  await fs.promises.rm(targetRoot, { recursive: true, force: true });
  await fs.promises.mkdir(targetRoot, { recursive: true });
  await execFileAsync('/usr/bin/ditto', ['--norsrc', '--noextattr', workApp, targetApp]);
  await fs.promises.copyFile(workArchive, targetArchive);
  console.log('앱 패키지, 무결성 해시 및 ZIP 서명 검증 완료');
} finally {
  await fs.promises.rm(workRoot, { recursive: true, force: true });
}

console.log(targetApp);
console.log(targetArchive);

async function loadAsar(projectRoot) {
  try {
    return await import('@electron/asar');
  } catch {
    const pnpmRoot = path.join(projectRoot, 'node_modules/.pnpm');
    const packageDirectory = fs
      .readdirSync(pnpmRoot)
      .filter((name) => name.startsWith('@electron+asar@'))
      .sort()
      .at(-1);
    if (!packageDirectory) {
      throw new Error('@electron/asar를 찾을 수 없습니다.');
    }
    return import(pathToFileURL(path.join(pnpmRoot, packageDirectory, 'node_modules/@electron/asar/lib/asar.js')).href);
  }
}

function findSourceApp(directory) {
  if (!fs.existsSync(directory)) {
    return path.join(directory, 'Weidian Nox Helper.app');
  }
  const candidates = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.app'))
    .sort((a, b) =>
      a === 'Weidian Nox Helper.app' ? -1 : b === 'Weidian Nox Helper.app' ? 1 : a.localeCompare(b)
    );
  return candidates.length > 0 ? path.join(directory, candidates[0]) : path.join(directory, 'Weidian Nox Helper.app');
}
