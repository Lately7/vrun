// Builds the VSIX and a ready-to-share installer bundle for other machines:
//   dist/vrun-<version>/               vsix + install.cmd / install.ps1 / install.sh + INSTALL.md
//   dist/vrun-<version>-installer.zip  the same folder, zipped
// Usage: npm run dist            (npm run dist -- --no-package reuses an existing VSIX)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = `vrun-${version}.vsix`;
const bundle = `vrun-${version}`;
const outDir = resolve('dist', bundle);
const zipPath = resolve('dist', `${bundle}-installer.zip`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, cwd });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!process.argv.includes('--no-package')) {
  // Same as `npm run package`: vsce runs vscode:prepublish (production build).
  run(process.execPath, [
    join('node_modules', '@vscode', 'vsce', 'vsce'),
    'package', '--no-dependencies', '--allow-missing-repository', '--out', vsix,
  ]);
}
if (!existsSync(vsix)) {
  console.error(`${vsix} not found; run without --no-package.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(vsix, join(outDir, vsix));
for (const f of ['install.cmd', 'install.ps1', 'install.sh', 'INSTALL.md']) {
  copyFileSync(join('install', f), join(outDir, f));
}
copyFileSync('LICENSE', join(outDir, 'LICENSE.txt'));

// All files sit at the zip root, so the backslash entry names that Windows
// PowerShell 5.1's Compress-Archive writes cannot break other unzip tools.
if (process.platform === 'win32') {
  run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${outDir.replaceAll("'", "''")}\\*' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`,
  ]);
} else {
  run('zip', ['-q', '-r', zipPath, '.'], outDir);
}
console.log(`\ninstaller bundle: ${outDir}\nzip:              ${zipPath}`);
