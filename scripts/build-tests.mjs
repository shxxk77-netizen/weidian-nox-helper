import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = await loadEsbuild(root);
const outdir = path.join(root, '.test-dist/tests');
const entryPoints = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join(root, 'tests', name));

await fs.promises.rm(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints,
  outdir,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  logLevel: 'info'
});

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
    const entry = path.join(pnpmRoot, packageDirectory, 'node_modules/esbuild/lib/main.js');
    return import(pathToFileURL(entry).href);
  }
}
