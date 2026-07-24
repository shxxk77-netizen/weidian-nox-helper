import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'out');
const esbuild = await loadEsbuild(root);

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'extension/src/background.ts')],
    outfile: path.join(root, 'chrome-extension/background.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'extension/src/content.ts')],
    outfile: path.join(root, 'chrome-extension/content.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'extension/src/page-main.ts')],
    outfile: path.join(root, 'chrome-extension/page-main.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(outRoot, 'main/main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src/main/preload.ts')],
    outfile: path.join(outRoot, 'preload/preload.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/main.tsx')],
    outdir: path.join(outRoot, 'renderer/assets'),
    entryNames: 'index',
    assetNames: '[name]',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    alias: {
      'lucide-react': path.join(root, 'node_modules/lucide-react/dist/cjs/lucide-react.js')
    },
    loader: { '.css': 'css' },
    logLevel: 'info'
  })
]);

await fs.promises.mkdir(path.join(outRoot, 'renderer'), { recursive: true });
await fs.promises.writeFile(
  path.join(outRoot, 'renderer/index.html'),
  `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>노무현</title>
    <link rel="stylesheet" href="./assets/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./assets/index.js"></script>
  </body>
</html>
`,
  'utf8'
);

async function loadEsbuild(projectRoot) {
  try {
    return await import('esbuild');
  } catch {
    const pnpmRoot = path.join(projectRoot, 'node_modules/.pnpm');
    const packageDirectory = fs
      .readdirSync(pnpmRoot)
      .filter((name) => name.startsWith('esbuild@'))
      .sort()
      .at(-1);
    if (!packageDirectory) {
      throw new Error('esbuild를 찾을 수 없습니다. 의존성을 먼저 설치하세요.');
    }
    return import(pathToFileURL(path.join(pnpmRoot, packageDirectory, 'node_modules/esbuild/lib/main.js')).href);
  }
}
