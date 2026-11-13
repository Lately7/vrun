# AGENTS.md — rules for humans and coding agents

## Layout

| Path                    | Owner (default)  | Contents                                   |
|-------------------------|------------------|--------------------------------------------|
| `src/`                  | Claude           | VS Code extension host (TypeScript)        |
| `webview/`              | Claude           | Webview UI (TypeScript, SVG), bundled to `media/` |
| `python/pylive_kernel/` | Claude           | Python worker                              |
| `python/tests/`         | Claude + Codex   | pytest suite (Codex owns files it creates) |
| `benchmarks/`           | Codex            | benchmark scripts and raw results          |
| `test/`                 | Claude           | Node unit tests and VS Code integration tests |
| `*.md`                  | Claude           | documentation (Codex may review)           |

Two agents never edit the same file at the same time. A Codex task names the
files it may create or change; everything else is read-only for that task.

## Conventions

* TypeScript `strict`; no `any` in protocol code; small modules.
* Python 3.12+ compatible, type-annotated, stdlib-only inside
  `pylive_kernel` (NumPy/Pandas imported lazily and only if already loaded
  by user code, so the kernel starts fast and works without them).
* Never call `repr()`/`str()` on objects of unknown types in inspection code.
* Every message from the webview is validated in `src/ui/validate.ts`.
* No shell strings: spawn with argv arrays and `shell: false`.
* Comments explain *why*, not what.

## Commands

```powershell
npm run setup:dev        # first time: npm ci, .venv (python/requirements-dev.txt), checks
npm install
npm run build            # esbuild: extension + webview
npm run typecheck        # tsc --noEmit
npm test                 # node unit tests (protocol, kernel client against real Python)
npm run test:py          # pytest python/tests
npm run test:vscode      # integration tests in an Extension Development Host
npm run package          # produces vrun-<version>.vsix
npm run dist             # VSIX + dist/vrun-<version>-installer.zip (install/ scripts)
python benchmarks/run_benchmarks.py   # see BENCHMARKS.md
```

Tests use `.venv` when it exists; set `PYLIVE_PYTHON` to choose another
interpreter (it needs pandas). Keep `install/*.ps1` and `scripts/*.ps1`
ASCII-only: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.

## Review process

1. Each milestone has acceptance criteria in `TASKS.md`.
2. Codex tasks are bounded; results are summarised in `TASKS.md` (Codex log).
3. Claude reviews every Codex diff before committing it.
4. Tests must pass before a milestone is marked complete. Never record a
   result that was not produced by running the command.
