// Bundles the extension host, the webview and (with --tests) the test files.
import * as esbuild from 'esbuild';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'media/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (tests) {
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)) : []);
  configs.push({
    ...common,
    sourcemap: true,
    minify: false,
    entryPoints: [...list('test/unit'), ...list('test/integration')],
    outdir: 'out/test',
    outbase: 'test',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
  });
}

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
