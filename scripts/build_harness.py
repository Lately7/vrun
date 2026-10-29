"""Build dev/harness.html: the real webview bundle fed with real kernel data.

Lets the UI be checked in a normal browser without VS Code. Usage:
    python scripts/build_harness.py    (then open dev/harness.html)
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))
sys.path.insert(0, os.path.join(ROOT, "python", "tests"))

from conftest import KernelProc  # noqa: E402

from pylive_kernel import tracer  # noqa: E402

SETUP = """
import numpy as np, pandas as pd
rng = np.random.default_rng(1)
n = 541_909
df = pd.DataFrame({
    "InvoiceNo": rng.integers(536365, 581587, n),
    "StockCode": rng.choice(["85123A", "71053", "84406B", "22423"], n),
    "Description": np.where(rng.random(n) < 0.003, None, "WHITE HANGING HEART T-LIGHT HOLDER"),
    "Quantity": rng.integers(-10, 50, n),
    "InvoiceDate": pd.date_range("2010-12-01 08:26", periods=n, freq="min"),
    "UnitPrice": np.round(rng.random(n) * 10, 2),
    "CustomerID": np.where(rng.random(n) < 0.25, np.nan, rng.integers(12346, 18287, n).astype(float)),
    "Country": pd.Categorical(rng.choice(["United Kingdom", "France", "Germany", "EIRE"], n)),
})
missing = df.isna().sum()
clean = df.dropna(subset=["CustomerID"])
average_quantity = clean["Quantity"].mean()
arr = [5, 1, 4, 2, 8, 3]
graph = {"A": ["B", "C"], "B": ["D"], "C": [], "D": []}
"""


def cells(path: str) -> dict[str, str]:
    src = open(path, encoding="utf-8").read()
    parts = re.split(r"^# %% ", src, flags=re.M)[1:]
    return {p.splitlines()[0].split(" —")[0].strip(): "\n".join(p.splitlines()[1:]) for p in parts}


def main() -> None:
    k = KernelProc(cwd=ROOT)
    try:
        assert k.run(SETUP)["status"] == "ok"
        variables = k.call("variables.list")["result"]
        meta = k.call("dataframe.metadata", name="df")["result"]
        page = k.call("dataframe.page", name="df", offset=0, limit=50)["result"]
        summary = k.call("dataframe.summary", name="df")["result"]
    finally:
        k.close()
    # Optional argument: another examples file with "# %% " cells.
    source = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "examples", "dsa_demo.py")
    traces = {name: tracer.run_trace(code) for name, code in cells(source).items()}
    data = {"ready": variables, "meta": meta, "page": page, "summary": summary, "traces": traces,
            "session": variables["session"]}
    os.makedirs(os.path.join(ROOT, "dev"), exist_ok=True)
    with open(os.path.join(ROOT, "dev", "harness-data.js"), "w", encoding="utf-8") as f:
        f.write("window.HARNESS = " + json.dumps(data) + ";\n")
    with open(os.path.join(ROOT, "dev", "harness.html"), "w", encoding="utf-8") as f:
        f.write(HTML)
    print("wrote dev/harness.html with", len(traces), "traces:", ", ".join(traces))


HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>vrun webview harness</title>
<link rel="stylesheet" href="../media/webview.css">
<style>
 :root { --vscode-foreground:#cccccc; --vscode-editor-background:#1e1e1e; --vscode-descriptionForeground:#9d9d9d;
  --vscode-focusBorder:#0078d4; --vscode-button-background:#0078d4; --vscode-button-foreground:#fff;
  --vscode-button-secondaryBackground:#313131; --vscode-button-secondaryForeground:#ccc; --vscode-input-background:#313131;
  --vscode-input-foreground:#ccc; --vscode-panel-border:#3c3c3c; --vscode-textCodeBlock-background:#2b2b2b;
  --vscode-editor-stackFrameHighlightBackground:#ffff0033; --vscode-font-family:Segoe UI, sans-serif;
  --vscode-editor-font-family:Consolas, monospace; --vscode-badge-background:#616161; --vscode-badge-foreground:#fff; }
 body.light { --vscode-foreground:#3b3b3b; --vscode-editor-background:#ffffff; --vscode-descriptionForeground:#717171;
  --vscode-button-secondaryBackground:#e5e5e5; --vscode-button-secondaryForeground:#3b3b3b; --vscode-input-background:#fff;
  --vscode-input-foreground:#3b3b3b; --vscode-panel-border:#e5e5e5; --vscode-textCodeBlock-background:#f3f3f3; }
 #harness { position: fixed; bottom: 0; right: 0; background: #444; color: #fff; padding: 4px; font: 12px sans-serif; z-index: 99; }
</style></head>
<body>
<div id="app"></div>
<div id="harness"></div>
<script src="harness-data.js"></script>
<script>
const H = window.HARNESS;
const features = new URLSearchParams(location.search).has('features');
function post(m) { window.postMessage(m, '*'); }
window.acquireVsCodeApi = () => ({
  getState: () => undefined, setState: () => {},
  postMessage(m) {
    const reply = (result) => setTimeout(() => post({ type: 'response', requestId: m.requestId, ok: true, result }), 30);
    if (m.type === 'ready') {
      post({ type: 'features', visualizer: features, dataframe: features });
      post({ type: 'status', status: 'idle', workload: 0 });
      post({ type: 'session', session: H.session, python: { version: '3.15.1' } });
      post({ type: 'variables', list: H.ready });
      // A few runs like a real session: repeated file runs, one error.
      for (let i = 1; i <= 4; i++) {
        post({ type: 'execStart', execId: i, label: '', mode: 'manual', file: 'test.py', docKey: 'test.py' });
        post({ type: 'stream', execId: i, name: 'stdout', text: '30' + String.fromCharCode(10) });
        post({ type: 'execEnd', execId: i, result: { status: 'ok', executionCount: i, elapsedMs: 0.02 } });
      }
      post({ type: 'execStart', execId: 5, label: 'cell · line 3', mode: 'manual', file: 'test.py', docKey: 'test.py' });
      post({ type: 'execEnd', execId: 5, result: { status: 'error', executionCount: 5, elapsedMs: 0.4,
        error: { ename: 'NameError', evalue: "name 'c' is not defined", traceback: ['Traceback (most recent call last):', '  File "test.py", line 4, in <module>', '    print(c)', "NameError: name 'c' is not defined"].join(String.fromCharCode(10)) } } });
      post({ type: 'execStart', execId: 6, label: '', mode: 'manual', file: 'test.py', docKey: 'test.py' });
      post({ type: 'execEnd', execId: 6, result: { status: 'ok', executionCount: 6, elapsedMs: 3.1,
        value: { type: 'int', shortType: 'int', repr: '30' } } });
    } else if (m.type === 'dfMetadata') reply(H.meta);
    else if (m.type === 'dfPage') reply(Object.assign({}, H.page, { offset: m.offset }));
    else if (m.type === 'dfSummary') reply(H.summary);
    else console.log('host <-', JSON.stringify(m));
  },
});
const bar = document.getElementById('harness');
for (const name of Object.keys(H.traces)) {
  const b = document.createElement('button'); b.textContent = name;
  b.onclick = () => post({ type: 'trace', label: name, mode: 'manual', lineOffset: 0, result: Object.assign({ status: 'ok' }, H.traces[name]) });
  bar.appendChild(b);
}
const t = document.createElement('button'); t.textContent = 'theme'; t.onclick = () => document.body.classList.toggle('light'); bar.appendChild(t);
</script>
<script src="../media/webview.js"></script>
</body></html>
"""

if __name__ == "__main__":
    main()
