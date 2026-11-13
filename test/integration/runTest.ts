/**
 * Launches VS Code as an Extension Development Host and runs suite.ts in it.
 * Uses the locally installed VS Code when VSCODE_EXECUTABLE is set (or the
 * default Windows install path exists), otherwise downloads a test build.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const hasSpace = (p: string) => /\s/.test(p);

/**
 * @vscode/test-electron starts VS Code through a shell on Windows without
 * quoting its arguments, so every path we pass must be free of spaces: the
 * repository ("Folder Group") is reached through a junction, and the
 * workspace/profile live in a space-free temp directory.
 */
function spaceFreeTempBase(): string {
  const candidates = [process.env.PYLIVE_IT_TMP, os.tmpdir(), path.join(path.parse(os.tmpdir()).root, 'pylive-it-tmp')];
  for (const c of candidates) {
    if (c && !hasSpace(c)) {
      fs.mkdirSync(c, { recursive: true });
      return c;
    }
  }
  throw new Error('No temp directory without spaces; set PYLIVE_IT_TMP to one.');
}

/** The repository's .venv (as `npm run test:py` uses), else `python` on PATH. */
function defaultPython(root: string): string {
  const venv = process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python';
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const localCode = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || (fs.existsSync(localCode) ? localCode : undefined);
  const base = spaceFreeTempBase();
  let workspace: string | undefined;
  let scratch: string | undefined;
  let junction: string | undefined;
  try {
    workspace = fs.mkdtempSync(path.join(base, 'pylive-it-'));
    fs.copyFileSync(path.join(root, 'examples', 'dsa_demo.py'), path.join(workspace, 'dsa_demo.py'));
    fs.writeFileSync(
      path.join(workspace, 'pandas_demo.py'),
      'import pandas as pd\nimport numpy as np\ndf = pd.DataFrame({"Quantity": np.arange(500_000) % 50, "UnitPrice": np.linspace(0, 10, 500_000)})\naverage_quantity = df["Quantity"].mean()\n',
    );
    scratch = fs.mkdtempSync(path.join(base, 'pylive-it-host-'));
    let devRoot = root;
    if (hasSpace(root)) {
      const link = path.join(scratch, 'repo');
      fs.symlinkSync(root, link, 'junction');
      junction = link;
      devRoot = link;
    }
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: devRoot,
      extensionTestsPath: path.join(devRoot, path.relative(root, path.join(__dirname, 'suite.js'))),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${path.join(scratch, 'user-data')}`,
        `--extensions-dir=${path.join(scratch, 'extensions')}`,
      ],
      extensionTestsEnv: { PYLIVE_PYTHON: process.env.PYLIVE_PYTHON ?? defaultPython(root), PYLIVE_IT_WORKSPACE: workspace },
    });
  } finally {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    // Remove the junction itself (never its target) before the profile dir;
    // if that fails, leave the temp dir rather than risk recursing into it.
    let junctionGone = junction === undefined;
    try {
      if (junction) fs.unlinkSync(junction);
      junctionGone = true;
    } catch (err) {
      console.error(`could not remove junction ${junction}:`, err);
    }
    if (scratch && junctionGone) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
