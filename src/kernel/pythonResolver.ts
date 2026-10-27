import * as fs from 'node:fs';
import * as vscode from 'vscode';

interface PythonExtensionApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string } | undefined;
    resolveEnvironment(env: { path: string } | string): Promise<{ executable?: { uri?: vscode.Uri } } | undefined>;
  };
}

/**
 * Interpreter selection order:
 * 1. `pylive.pythonPath` setting
 * 2. the Python extension's active interpreter for the resource
 * 3. `python` on PATH
 */
export async function resolvePython(resource: vscode.Uri | undefined, log: (s: string) => void): Promise<string> {
  const configured = vscode.workspace.getConfiguration('pylive', resource).get<string>('pythonPath', '').trim();
  if (configured) return configured;
  try {
    const ext = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
    if (ext) {
      const api = ext.isActive ? ext.exports : await ext.activate();
      const envPath = api?.environments?.getActiveEnvironmentPath(resource);
      if (envPath) {
        const env = await api!.environments!.resolveEnvironment(envPath);
        const exe = env?.executable?.uri?.fsPath;
        if (exe && fs.existsSync(exe)) return exe;
      }
    }
  } catch (err) {
    log(`[pylive] Python extension lookup failed: ${String(err)}\n`);
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
