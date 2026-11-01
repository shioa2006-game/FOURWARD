// Bundles the game into ONE self-contained file: dist/index.html
// (works by double-clicking it — no server needed).
//   node tools/build.mjs            production build
//   node tools/build.mjs --watch    rebuild on change
//   node tools/build.mjs --watch --serve   + static server (see serve.mjs)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const serve = args.includes('--serve');

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

function writeHtml(js) {
  const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
  const tpl = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const html = tpl.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => safeJs);
  fs.writeFileSync(path.join(distDir, 'index.html'), html);
  return html.length;
}

const options = {
  entryPoints: [path.join(root, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'chrome90', 'safari15', 'firefox90'],
  minify: !watch,
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: { __DEV__: watch ? 'true' : 'false' },
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: 'inline-html',
        setup(build) {
          build.onEnd((res) => {
            if (res.errors.length) return;
            const size = writeHtml(res.outputFiles[0].text);
            console.log(`[build] dist/index.html ${(size / 1024).toFixed(0)} KB`);
          });
        },
      },
    ],
  });
  await ctx.watch();
  // CSS / HTML template changes also trigger a rebuild
  for (const f of ['src/style.css', 'src/index.html']) {
    fs.watch(path.join(root, f), () => ctx.rebuild().catch(() => {}));
  }
  if (serve) await import('./serve.mjs');
} else {
  const res = await esbuild.build(options);
  const size = writeHtml(res.outputFiles[0].text);
  console.log(`dist/index.html  ${(size / 1024).toFixed(0)} KB`);
}
