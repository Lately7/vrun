// Runs the Python test-suite with PYLIVE_PYTHON (or .venv, or `python`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const venv = process.platform === 'win32' ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');
const python = process.env.PYLIVE_PYTHON || (existsSync(venv) ? venv : 'python');
const r = spawnSync(python, ['-m', 'pytest', 'python', ...process.argv.slice(2)], { stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
