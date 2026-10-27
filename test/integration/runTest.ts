/**
 * Launches VS Code as an Extension Development Host and runs suite.ts in it.
 * Uses the locally installed VS Code when VSCODE_EXECUTABLE is set (or the
 * default Windows install path exists), otherwise downloads a test build.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const localCode = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || (fs.existsSync(localCode) ? localCode : undefined);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pylive-it-'));
  fs.copyFileSync(path.join(root, 'examples', 'dsa_demo.py'), path.join(workspace, 'dsa_demo.py'));
  fs.writeFileSync(
    path.join(workspace, 'pandas_demo.py'),
    'import pandas as pd\nimport numpy as np\ndf = pd.DataFrame({"Quantity": np.arange(500_000) % 50, "UnitPrice": np.linspace(0, 10, 500_000)})\naverage_quantity = df["Quantity"].mean()\n',
  );
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { PYLIVE_PYTHON: process.env.PYLIVE_PYTHON ?? 'python', PYLIVE_IT_WORKSPACE: workspace },
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
