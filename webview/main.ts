/**
 * Webview entry: a quiet header (kernel state + a few text buttons), tabs and
 * message routing. The DataFrame and Visualizer tabs only exist when enabled
 * in Settings (pylive.features.*), so the default panel is just
 * Variables + Output.
 */
import { handleResponse, rejectAll, send, vscode } from './api';
import { DataFrameView } from './dataframe';
import { button, clear, h } from './dom';
import { OutputView } from './output';
import { VariablesList, VariablesView } from './variables';
import { Visualizer } from './visualizer';

type Tab = 'variables' | 'output' | 'dataframe' | 'visualizer';
const ALL_TABS: Array<[Tab, string]> = [
  ['variables', 'Variables'],
  ['output', 'Output'],
  ['dataframe', 'DataFrame'],
  ['visualizer', 'Visualizer'],
];

const features = { dataframe: false, visualizer: false };
const enabledTabs = () => ALL_TABS.filter(([id]) => (id === 'dataframe' ? features.dataframe : id === 'visualizer' ? features.visualizer : true));

// Persisted state may come from an older version: validate before use.
const saved = vscode.getState() as { tab?: unknown } | undefined;
let tab: Tab = ALL_TABS.some(([id]) => id === saved?.tab) ? (saved!.tab as Tab) : 'variables';
let status = 'stopped';
let python = '';
let frames: string[] = [];
let live = false;

const app = document.getElementById('app')!;
const statusEl = h('span', { class: 'kstatus', role: 'status' });
const controls = h('div', { class: 'controls' });
const tabBar = h('div', { class: 'tabs', role: 'tablist' });
const content = h('main', { class: 'content' });

const output = new OutputView((name) => openDataFrame(name), () => features.dataframe);
const dataframe = new DataFrameView(() => frames);
const visualizer = new Visualizer();
const variables = new VariablesView(
  (name) => openDataFrame(name),
  (name, root, heap) => {
    visualizer.showSnapshot(name, root, heap);
    showTab('visualizer');
  },
  () => features,
);
const views: Record<Tab, HTMLElement> = {
  variables: variables.el,
  dataframe: dataframe.el,
  output: output.el,
  visualizer: visualizer.el,
};
let errorBadge = 0;
output.onError = (n) => {
  errorBadge = n;
  renderTabs();
};

function openDataFrame(name: string): void {
  if (!features.dataframe) return;
  showTab('dataframe');
  void dataframe.open(name);
}

function showTab(t: Tab): void {
  // A tab that was turned off in Settings falls back to Variables.
  tab = enabledTabs().some(([id]) => id === t) ? t : 'variables';
  vscode.setState({ tab });
  renderTabs();
  clear(content);
  content.appendChild(views[tab]);
  if (tab === 'output') errorBadge = 0;
}

function renderTabs(): void {
  clear(tabBar);
  const tabs = enabledTabs();
  tabs.forEach(([id, label], i) => {
    const b = h('button', {
      type: 'button',
      role: 'tab',
      id: `tab-${id}`,
      class: `tab ${tab === id ? 'active' : ''}`,
      'aria-selected': String(tab === id),
      tabindex: tab === id ? 0 : -1,
    }, label, id === 'output' && errorBadge && tab !== 'output' ? h('span', { class: 'err-dot', title: `${errorBadge} error(s)` }) : null);
    b.addEventListener('click', () => showTab(id));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
        showTab(next);
        (document.getElementById(`tab-${next}`) as HTMLElement | null)?.focus();
      }
    });
    tabBar.appendChild(b);
  });
}

function renderHeader(): void {
  clear(statusEl);
  statusEl.className = `kstatus s-${status}`;
  statusEl.title = python ? `Python ${python}` : '';
  statusEl.append(h('span', { class: 'dot', 'aria-hidden': 'true' }), status === 'idle' ? 'ready' : status);
  clear(controls);
  const running = status !== 'stopped' && status !== 'crashed';
  const busy = status === 'busy' || status === 'interrupting';
  const cmd = (command: string) => () => send({ type: 'command', command });
  controls.append(
    ...(running ? [] : [button('Start', cmd('start'), { cls: 'hbtn', title: 'Start the Python kernel' })]),
    button('Run cell', cmd('runCell'), { cls: 'hbtn', title: 'Run the cell at the cursor (Ctrl+Alt+C)' }),
    button('Run file', cmd('runFile'), { cls: 'hbtn', title: 'Run the whole file' }),
    // Only offered while something runs.
    ...(busy ? [button('Stop', cmd('interrupt'), { cls: 'hbtn warn', title: 'Interrupt (Ctrl+Alt+I)' })] : []),
    button(live ? 'Live on' : 'Live off', cmd('toggleLive'), {
      cls: `hbtn ${live ? 'on' : ''}`,
      pressed: live,
      title: 'Re-run the current cell while you type (this file only)',
    }),
    ...(running ? [button('↻', cmd('restart'), { cls: 'hbtn icon', title: 'Restart kernel (clears all variables)' })] : []),
  );
}

app.append(h('header', { class: 'top' }, statusEl, controls), tabBar, content);
renderHeader();
showTab(tab);

window.addEventListener('message', (ev: MessageEvent) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = ev.data as Record<string, any>;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'response':
      handleResponse(msg as never);
      break;
    case 'features':
      features.dataframe = !!msg.dataframe;
      features.visualizer = !!msg.visualizer;
      showTab(tab);
      variables.refresh();
      break;
    case 'status':
      status = msg.status;
      renderHeader();
      break;
    case 'session':
      if (msg.session) {
        python = msg.python?.version ?? '';
        variables.invalidate('Kernel ready. Run some code to see variables.');
      } else {
        // Kernel stopped/restarted/crashed: every handle in the UI is invalid now.
        python = '';
        frames = [];
        rejectAll({ code: 'stale_handle', message: 'The kernel was restarted; this view is no longer valid.' });
        variables.invalidate(msg.restarting ? 'Kernel restarting — all variables were cleared.' : 'Kernel is not running. Previous variables are gone.');
        dataframe.invalidate('The kernel was restarted or stopped, so this DataFrame no longer exists.');
      }
      renderHeader();
      break;
    case 'variables': {
      const list = msg.list as VariablesList;
      frames = list.variables.filter((v) => v.kind === 'dataframe' || v.kind === 'series').map((v) => v.name);
      variables.setList(list);
      if (features.dataframe) void dataframe.refreshIfOpen();
      break;
    }
    case 'variablesError':
      variables.error(msg.message);
      break;
    case 'execStart':
      output.start(msg.execId, msg.label, msg.mode, msg.file, msg.docKey);
      break;
    case 'execEnd':
      output.end(msg.execId, msg.result, msg.failure, msg.cancelled, msg.superseded);
      if (msg.result?.status === 'error' && tab !== 'output' && msg.result?.error && !msg.result.interrupted) showTab('output');
      break;
    case 'stream':
      output.stream(msg.execId, msg.name, msg.text);
      break;
    case 'showTab':
      if (ALL_TABS.some(([id]) => id === msg.tab)) showTab(msg.tab);
      break;
    case 'openDataFrame':
      openDataFrame(msg.name);
      break;
    case 'traceStart':
      visualizer.started(msg.execId, msg.label, msg.mode);
      break;
    case 'traceSuperseded':
      visualizer.superseded(msg.execId);
      break;
    case 'trace':
      visualizer.setTrace(msg.execId, msg.result, msg.label, msg.mode, msg.lineOffset);
      if (msg.mode === 'manual') showTab('visualizer');
      break;
    case 'traceFailed':
      visualizer.failed(msg.execId, `${msg.code}: ${msg.message}`);
      break;
    case 'liveState':
      live = !!msg.live;
      visualizer.setLiveViz(!!msg.liveViz);
      renderHeader();
      break;
  }
});

send({ type: 'ready' });
