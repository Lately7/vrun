/** Variables panel: cheap metadata table with click-to-inspect. */
import { HostError, request, send } from './api';
import { button, clear, formatBytes, h, truncateText } from './dom';
import { Encoded, Heap, HeapNode, fmtPreview, fmtPy, fmtScalar, shadowsBuiltin } from './format';
import { Series, renderLineChart } from './viz/lineChart';

export interface VariableInfo {
  name: string;
  type: string;
  kind: string;
  value?: Encoded;
  len?: number;
  shape?: number[];
  dtype?: string;
  dtypes?: Record<string, number>;
  size?: number | null;
  sizeIsLowerBound?: boolean;
  preview?: Encoded[];
  viz?: string | null;
  fitted?: boolean;
  fittedAttrs?: string[];
  /** Tensors (torch / TensorFlow). */
  device?: string;
  requiresGrad?: boolean;
  hasGradFn?: boolean;
  trainable?: boolean;
  /** Networks (torch nn.Module, Keras Model). */
  paramCount?: number;
  trainableParams?: number;
  layers?: number;
  training?: boolean;
  built?: boolean;
  /** scikit-learn: hyperparameters that differ from the defaults, pipeline steps, results. */
  params?: Record<string, Encoded>;
  steps?: Array<[string, string]>;
  facts?: Record<string, Encoded | Encoded[] | Record<string, Encoded>>;
  /** Arrays / tensors that hold pictures: the image button. */
  image?: { count: number; layout: string };
  /** Numbers over epochs (losses, history dicts, Keras History): the chart button. */
  chart?: boolean;
  keys?: string[];
  epochs?: number;
  /** Values of a dict's first keys when they are plain scalars (metrics). */
  previewValues?: Encoded[];
  categories?: number;
  /** Sparse matrices. */
  nnz?: number;
  density?: number;
  format?: string;
  /** Optimizers / data loaders. */
  groups?: number;
  tensors?: number;
  stepped?: boolean;
  dataset?: string;
  samples?: number;
  shuffle?: boolean;
  lazyParams?: number;
  /** Opens in the DataFrame tab although it is not a DataFrame (2-D arrays). */
  table?: boolean;
  error?: string;
}

interface SeriesResult {
  series: Series[];
  downsampled: boolean;
  notes: string[];
}

interface ImagePreview {
  png: string;
  width: number;
  height: number;
  tile: [number, number];
  columns: number;
  start: number;
  shown: number;
  count: number;
  channels: number;
  layout: string;
  dtype: string;
  shape: number[];
  /** Pixel step of a downscaled preview (a photo is sent at 1/scale). */
  scale?: number;
}

const IMAGES_PER_PAGE = 16;

function fmtCount(n: number | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}
export interface VariablesList {
  variables: VariableInfo[];
  omitted: number;
  session: string;
  revision: number;
}

interface InspectResult extends VariableInfo {
  root?: Encoded;
  heap?: Heap;
  truncated?: boolean;
}

export class VariablesView {
  readonly el = h('div', { class: 'variables' });
  private list: VariablesList | undefined;
  private filter = '';
  private message = 'Run some code to see variables here.';
  private expanded = new Set<string>();
  /** Variables whose image preview is open, with the first image shown. */
  private images = new Map<string, number>();
  private charts = new Set<string>();

  constructor(
    private openDataFrame: (name: string) => void,
    private visualize: (name: string, root: Encoded, heap: Heap) => void,
    private features: () => { dataframe: boolean; visualizer: boolean },
  ) {
    this.render();
  }

  /** Re-render, e.g. after optional features were switched on or off. */
  refresh(): void {
    this.render();
  }

  setList(list: VariablesList): void {
    this.list = list;
    // An open chart / image of a variable that no longer has one (losses = [],
    // X now a DataFrame) stayed as an error row with no button to close it.
    const info = new Map(list.variables.map((v) => [v.name, v]));
    for (const name of [...this.charts]) if (!info.get(name)?.chart) this.charts.delete(name);
    for (const name of [...this.images.keys()]) if (!info.get(name)?.image) this.images.delete(name);
    this.render();
  }

  invalidate(message: string): void {
    this.list = undefined;
    this.expanded.clear();
    this.images.clear();
    this.charts.clear();
    this.message = message;
    this.render();
  }

  error(message: string): void {
    this.message = message;
    this.render();
  }

  private summary(v: VariableInfo): string {
    if (v.error) return `⚠ ${v.error}`;
    switch (v.kind) {
      case 'number':
      case 'bool':
      case 'str':
      case 'scalar':
      case 'function':
      case 'class':
        // Quoted, with \n shown: 'abba\n' is not abba, and '10' is not 10.
        return fmtPy(v.value);
      case 'sparse': {
        const pct = v.density !== undefined ? ` (${(v.density * 100).toFixed(v.density < 0.01 ? 2 : 1)}%)` : '';
        return `${v.shape?.join(' × ')} sparse ${v.format ?? ''} · ${fmtCount(v.nnz)} non-zeros${pct} · ${v.dtype ?? ''}`;
      }
      case 'optimizer': {
        const hp = Object.entries(v.params ?? {}).map(([k, x]) => `${k}=${fmtScalar(x)}`).join(', ');
        const short = v.type.split('.').pop() ?? v.type;
        return `${short}(${hp}) · ${fmtCount(v.tensors)} tensors${v.stepped === undefined ? '' : v.stepped ? ' · stepped' : ' · not stepped yet'}`;
      }
      case 'dataloader': {
        const p = v.params ?? {};
        const parts = [`batch_size=${fmtScalar(p.batch_size)}`];
        if (v.shuffle) parts.push('shuffle');
        if (p.num_workers) parts.push(`num_workers=${fmtScalar(p.num_workers)}`);
        if (v.dataset) parts.push(`${v.dataset}${v.samples !== undefined ? ` (${fmtCount(v.samples)} samples)` : ''}`);
        return parts.join(' · ');
      }
      case 'torchinfo':
        return fmtScalar(v.value);
      case 'history':
        return `${(v.keys ?? []).join(', ')}${v.epochs !== undefined ? ` · ${v.epochs} epochs` : ''}`;
      case 'pandas':
        if (v.value !== undefined) return fmtScalar(v.value);
        if (v.preview) {
          const more = (v.len ?? 0) > v.preview.length ? ', …' : '';
          const cats = v.categories !== undefined ? ` · ${v.categories} categories` : '';
          return `[${v.preview.map((p) => fmtPy(p)).join(', ')}${more}]${v.dtype ? ` ${v.dtype}` : ''}${cats}`;
        }
        return `<${v.type}>`;
      case 'dataframe':
        return `${v.shape?.[0].toLocaleString()} rows × ${v.shape?.[1]} cols · ${Object.entries(v.dtypes ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')}`;
      case 'series':
        return `${v.shape?.[0].toLocaleString()} values · ${v.dtype}`;
      case 'ndarray':
        if (v.value !== undefined) return `${fmtScalar(v.value)} · 0-d ${v.dtype}`;
        return `${v.shape?.join(' × ')} ${v.dtype}${v.preview ? ` [${v.preview.map((p) => fmtPy(p)).join(', ')}]` : ''}`;
      case 'estimator': {
        // As scikit-learn prints it: SVC(kernel='rbf').
        const params = Object.entries(v.params ?? {}).map(([k, x]) => `${k}=${fmtPy(x)}`).join(', ');
        const short = v.type.split('.').pop() ?? v.type;
        const head = v.steps?.length ? v.steps.map((st) => st[1]).join(' → ') : `${short}(${params})`;
        const best = v.facts?.best_score_ !== undefined ? ` · best score ${fmtScalar(v.facts.best_score_ as Encoded)}` : '';
        return `${head} · ${v.fitted ? 'fitted' : 'not fitted'}${best}`;
      }
      case 'tensor': {
        const shape = v.shape?.length ? `${v.shape.join(' × ')} ` : 'scalar ';
        const value = v.value !== undefined ? `${fmtScalar(v.value)}  ·  ` : '';
        const preview = v.preview ? ` [${v.preview.map((p) => fmtScalar(p)).join(', ')}]` : '';
        const grad = v.requiresGrad ? ' · requires_grad' : v.hasGradFn ? ' · grad_fn' : '';
        return `${value}${shape}${v.dtype ?? ''} · ${v.device ?? ''}${grad}${preview}`;
      }
      case 'model': {
        if (v.built === false) return 'not built yet: call it on data (or model.build) to create its weights';
        const trainable = v.trainableParams !== undefined && v.trainableParams !== v.paramCount ? ` (${fmtCount(v.trainableParams)} trainable)` : '';
        const lazy = v.lazyParams ? ` + ${v.lazyParams} lazy (sized on the first forward pass)` : '';
        const parts = v.paramCount === undefined ? [] : [`${fmtCount(v.paramCount)} parameters${trainable}${lazy}`];
        if (v.layers) parts.push(`${v.layers} layers`);
        if (v.device) parts.push(v.device);
        if (v.training === false) parts.push('eval mode');
        return parts.join(' · ') || 'model';
      }
      case 'list':
      case 'tuple':
      case 'set':
      case 'frozenset':
      case 'deque':
      case 'dict':
        // Metrics read as "'accuracy': 0.95, 'f1': 0.91", not just their keys.
        return fmtPreview(v.kind, v.preview ?? [], v.len, v.kind === 'dict' ? v.previewValues : undefined, v.type);
      default:
        return `<${v.type}>`;
    }
  }

  private render(): void {
    clear(this.el);
    const search = h('input', { type: 'search', placeholder: 'Filter variables', 'aria-label': 'Filter variables', value: this.filter }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.filter = search.value;
      this.renderTable(tableHost);
    });
    const tableHost = h('div', {});
    // The filter only appears once there is enough to filter.
    const showSearch = (this.list?.variables.length ?? 0) > 12 || this.filter !== '';
    this.el.append(
      h('div', { class: 'toolbar quiet' }, showSearch ? search : null,
        button('Refresh', () => send({ type: 'refreshVariables' }), { cls: 'link-btn', title: 'Refresh variables' })),
      tableHost,
    );
    this.renderTable(tableHost);
  }

  private meta(v: VariableInfo): string {
    const shape = v.shape ? v.shape.join('×') : v.len !== undefined ? `len ${v.len}` : '';
    const size = v.size !== undefined && v.size !== null && v.size >= 1024 ? `${v.sizeIsLowerBound ? '≥' : ''}${formatBytes(v.size)}` : '';
    const type = v.type.split('.').pop() ?? v.type;
    return [type, shape, size].filter(Boolean).join(' · ');
  }

  private renderTable(host: HTMLElement): void {
    clear(host);
    if (!this.list) {
      host.appendChild(h('p', { class: 'muted' }, this.message));
      return;
    }
    const f = this.filter.toLowerCase();
    const rows = this.list.variables.filter((v) => !f || v.name.toLowerCase().includes(f) || v.type.toLowerCase().includes(f));
    if (rows.length === 0) {
      host.appendChild(h('p', { class: 'muted empty-hint' }, f ? 'No variable matches the filter.' : 'No variables yet. Run some code.'));
      return;
    }
    const { dataframe, visualizer } = this.features();
    const table = h('table', { class: 'vars' });
    const tbody = h('tbody', {});
    for (const v of rows) {
      // 2-D arrays / tensors open in the DataFrame tab too (when pandas is loaded).
      const isFrame = v.kind === 'dataframe' || v.kind === 'series' || v.table === true;
      const expandable = !['function', 'class', 'dataframe', 'series', 'number', 'bool', 'scalar', 'history', 'sparse', 'optimizer', 'dataloader', 'torchinfo'].includes(v.kind);
      const actions = h('td', { class: 'actions' });
      if (isFrame && dataframe) actions.appendChild(button('open', () => this.openDataFrame(v.name), { cls: 'link-btn', title: 'Open in the DataFrame tab' }));
      if (v.image) {
        const what = v.image.count > 1 ? `${fmtCount(v.image.count)} images` : 'the image';
        actions.appendChild(button('image', () => this.toggleImage(v.name), { cls: 'link-btn', title: `Show ${what}`, pressed: this.images.has(v.name) }));
      }
      if (v.chart) actions.appendChild(button('chart', () => this.toggleChart(v.name), { cls: 'link-btn', title: 'Plot the values as a curve (epochs / steps)', pressed: this.charts.has(v.name) }));
      if (v.viz && v.viz !== 'series' && !isFrame && visualizer) actions.appendChild(button('draw', () => void this.draw(v.name), { cls: 'link-btn', title: `Draw as ${v.viz}` }));
      const nameCell = h('td', { class: 'name' }, expandable ? h('span', { class: 'chev', 'aria-hidden': 'true' }, this.expanded.has(v.name) ? '▾' : '▸') : h('span', { class: 'chev' }, ''), v.name);
      // One kernel serves every file of the window: `max = 0` left by an
      // earlier file makes max(a) fail in this one, with no hint why.
      if (shadowsBuiltin(v.name, v.value, v.type)) {
        nameCell.appendChild(
          h('span', {
            class: 'badge warn',
            title: `This variable hides Python's built-in ${v.name}(). Code run later in this kernel (other files too) gets this value when it calls ${v.name}(...). Rename it, or run: del ${v.name}`,
          }, 'shadows built-in'),
        );
      }
      const tr = h('tr', { tabindex: 0, class: expandable ? 'expandable' : '' },
        nameCell,
        h('td', { class: 'value', title: this.summary(v) }, truncateText(this.summary(v), 120)),
        h('td', { class: 'meta', title: v.type }, this.meta(v)),
        actions,
      );
      // With the DataFrame tab turned off, ask the host: it offers to turn
      // it on and then opens this frame.
      const activate = () =>
        isFrame ? (dataframe ? this.openDataFrame(v.name) : send({ type: 'openDataFrame', name: v.name })) : expandable && this.toggle(v.name);
      tr.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('button')) activate();
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') activate();
      });
      tbody.appendChild(tr);
      if (this.charts.has(v.name)) {
        const cell = h('td', { colspan: 4, class: 'detail' }, h('span', { class: 'muted' }, 'Loading…'));
        tbody.appendChild(h('tr', {}, cell));
        void this.loadChart(v.name, cell);
      }
      if (this.images.has(v.name)) {
        const cell = h('td', { colspan: 4, class: 'detail' }, h('span', { class: 'muted' }, 'Loading…'));
        tbody.appendChild(h('tr', {}, cell));
        void this.loadImage(v.name, this.images.get(v.name) ?? 0, cell);
      }
      if (this.expanded.has(v.name)) {
        const detail = h('td', { colspan: 4, class: 'detail' }, h('span', { class: 'muted' }, 'Loading…'));
        tbody.appendChild(h('tr', {}, detail));
        void this.loadDetail(v.name, detail);
      }
    }
    table.appendChild(tbody);
    host.appendChild(table);
    if (this.list.omitted) host.appendChild(h('p', { class: 'muted' }, `${this.list.omitted} more variables not shown.`));
  }

  private toggle(name: string): void {
    if (this.expanded.has(name)) this.expanded.delete(name);
    else this.expanded.add(name);
    this.render();
  }

  private toggleChart(name: string): void {
    if (this.charts.has(name)) this.charts.delete(name);
    else this.charts.add(name);
    this.render();
  }

  private async loadChart(name: string, cell: HTMLElement): Promise<void> {
    try {
      const r = await request<SeriesResult>({ type: 'seriesVariable', name, maxPoints: 800 });
      clear(cell);
      const width = Math.max(280, Math.min(720, (cell.closest('table')?.clientWidth ?? 560) - 24));
      cell.appendChild(renderLineChart(r.series, `${name} curve`, width, 220));
      const legend = h('div', { class: 'chart-legend small' });
      r.series.forEach((sr, k) => {
        const last = [...sr.y].reverse().find((y) => y !== null);
        legend.appendChild(h('span', { class: `legend-item series-${k % 6}` }, h('span', { class: 'swatch' }), `${sr.name}${last !== undefined && last !== null ? ` ${fmtScalar(last)}` : ''}`));
      });
      const len = Math.max(...r.series.map((sr) => sr.len));
      legend.appendChild(h('span', { class: 'muted' }, `${len.toLocaleString('en-US')} points${r.downsampled ? ' (downsampled, peaks kept)' : ''} · ● best`));
      cell.appendChild(legend);
      for (const note of r.notes) cell.appendChild(h('p', { class: 'hint small' }, note));
    } catch (e) {
      clear(cell);
      cell.appendChild(h('span', { class: 'error-text' }, (e as HostError).message));
    }
  }

  private toggleImage(name: string): void {
    if (this.images.has(name)) this.images.delete(name);
    else this.images.set(name, 0);
    this.render();
  }

  private async loadImage(name: string, start: number, cell: HTMLElement): Promise<void> {
    try {
      const r = await request<ImagePreview>({ type: 'imageVariable', name, start, count: IMAGES_PER_PAGE });
      clear(cell);
      // Small images (8 x 8 digits, 28 x 28 MNIST) are scaled up with crisp
      // pixels; the panel width caps the scale.
      const avail = Math.max(120, (cell.closest('table')?.clientWidth ?? 480) - 24);
      const scale = Math.max(1, Math.min(Math.floor(avail / r.width), Math.floor(320 / Math.max(r.tile[0], 1)), 12));
      const img = h('img', {
        class: 'array-image',
        src: `data:image/png;base64,${r.png}`,
        width: r.width * scale,
        height: r.height * scale,
        alt: `${name}: ${r.shown} image(s) of ${r.tile[0]} x ${r.tile[1]} pixels`,
      });
      const [th, tw] = r.tile;
      const colour = r.channels === 1 ? 'gray' : r.channels === 3 ? 'RGB' : 'RGBA';
      const to = r.start + r.shown;
      const range = r.count > 1 ? `images ${fmtCount(r.start + 1)}–${fmtCount(to)} of ${fmtCount(r.count)}  ·  ` : '';
      const layout = r.layout === 'flat' ? `  ·  each row reshaped to ${th} × ${tw}` : r.layout === 'chw' ? '  ·  channels first (C, H, W)' : '';
      const shrunk = r.scale !== undefined && r.scale > 1 ? `  ·  shown at 1/${r.scale}` : '';
      const bar = h('div', { class: 'image-bar muted small' }, `${range}${th} × ${tw} px ${colour}${layout}${shrunk}`);
      if (r.count > r.shown || r.start > 0) {
        const go = (next: number) => {
          this.images.set(name, next);
          void this.loadImage(name, next, cell);
        };
        bar.prepend(
          button('◀', () => go(Math.max(0, r.start - IMAGES_PER_PAGE)), { cls: 'link-btn', title: 'Previous images', disabled: r.start === 0 }),
          button('▶', () => go(r.start + IMAGES_PER_PAGE), { cls: 'link-btn', title: 'Next images', disabled: to >= r.count }),
          ' ',
        );
      }
      cell.append(img, bar);
    } catch (e) {
      clear(cell);
      cell.appendChild(h('span', { class: 'error-text' }, (e as HostError).message));
    }
  }

  /** A 2-D array window (or a 0-d value): the first rows and columns. */
  private arrayDetail(node: HeapNode, cell: HTMLElement): void {
    if (node.value !== undefined) {
      cell.appendChild(h('pre', { class: 'console small' }, fmtPy(node.value)));
      return;
    }
    const rows = node.rows ?? [];
    const shape = node.shape ?? [];
    const maxRows = 20;
    const maxCols = 12;
    const t = h('table', { class: 'array-grid' });
    const head = h('tr', {}, h('th', {}, ''));
    const cols = Math.min(maxCols, rows[0]?.length ?? 0);
    for (let c = 0; c < cols; c++) head.appendChild(h('th', {}, String(c)));
    t.appendChild(head);
    rows.slice(0, maxRows).forEach((r, i) => {
      const tr = h('tr', {}, h('th', {}, String(i)));
      for (const x of r.slice(0, maxCols)) tr.appendChild(h('td', {}, fmtPy(x)));
      t.appendChild(tr);
    });
    cell.appendChild(t);
    const [nr, nc] = [shape[0] ?? rows.length, shape[1] ?? cols];
    if (nr > maxRows || nc > maxCols) {
      cell.appendChild(h('p', { class: 'muted small' }, `rows 0–${Math.min(nr, maxRows) - 1} of ${nr.toLocaleString('en-US')}, columns 0–${cols - 1} of ${nc.toLocaleString('en-US')}`));
    }
  }

  /** Details of a model / estimator / tensor as a small key-value table. */
  private mlDetail(r: InspectResult, cell: HTMLElement): void {
    const t = h('table', { class: 'kv' });
    const row = (k: string, val: string) => t.appendChild(h('tr', {}, h('th', {}, k), h('td', {}, val)));
    const show = (x: Encoded | Encoded[] | Record<string, Encoded>): string => {
      if (Array.isArray(x)) return x.map((y) => fmtPy(y)).join(', ');
      if (x !== null && typeof x === 'object' && !('$t' in x) && !('ref' in x)) {
        return Object.entries(x as Record<string, Encoded>).map(([k, y]) => `${k}=${fmtPy(y)}`).join(', ');
      }
      return fmtPy(x as Encoded);
    };
    if (r.kind === 'estimator') {
      if (r.steps?.length) row('steps', r.steps.map(([n, cls]) => `${n}: ${cls}`).join('  →  '));
      const params = Object.entries(r.params ?? {});
      row('parameters', params.length ? params.map(([k, x]) => `${k}=${fmtPy(x)}`).join(', ') : 'all defaults');
      for (const [k, x] of Object.entries(r.facts ?? {})) row(k, show(x));
      row('fitted', r.fitted ? (r.fittedAttrs?.length ? r.fittedAttrs.join(', ') : 'yes') : 'no: call .fit(X, y) first');
    } else if (r.kind === 'model') {
      if (r.built === false) row('weights', 'not built yet');
      else {
        if (r.paramCount !== undefined) row('parameters', fmtCount(r.paramCount));
        if (r.trainableParams !== undefined) row('trainable', fmtCount(r.trainableParams));
      }
      if (r.layers) row('layers', String(r.layers));
      if (r.device) row('device', r.device);
      if (r.training !== undefined) row('mode', r.training ? 'train (dropout / batch norm active)' : 'eval');
    } else {
      row('shape', r.shape?.length ? `(${r.shape.join(', ')})` : '() scalar');
      row('dtype', r.dtype ?? '');
      row('device', r.device ?? '');
      if (r.requiresGrad !== undefined) row('requires_grad', String(r.requiresGrad));
      if (r.hasGradFn) row('grad_fn', 'yes: part of an autograd graph');
      if (r.size) row('memory', formatBytes(r.size));
    }
    cell.appendChild(t);
  }

  private async loadDetail(name: string, cell: HTMLElement): Promise<void> {
    try {
      const r = await request<InspectResult>({ type: 'inspectVariable', name });
      clear(cell);
      if (r.kind === 'estimator' || r.kind === 'model' || r.kind === 'tensor') {
        this.mlDetail(r, cell);
        return;
      }
      const heap = r.heap ?? {};
      const root = r.root;
      const node = root && typeof root === 'object' && 'ref' in root ? heap[String(root.ref)] : undefined;
      if (node?.kind === 'ndarray' && (node.rows || node.value !== undefined)) {
        this.arrayDetail(node, cell);
      } else if (node?.items) {
        cell.appendChild(h('div', { class: 'chips' }, ...node.items.slice(0, 100).map((it, i) => h('span', { class: 'chip', title: `[${i}]` }, fmtPy(it, heap)))));
        if ((node.len ?? 0) > node.items.length) cell.appendChild(h('span', { class: 'muted' }, ` … ${node.len! - node.items.length} more`));
      } else if (node?.entries) {
        const t = h('table', { class: 'kv' });
        for (const [k, val] of node.entries.slice(0, 100)) t.appendChild(h('tr', {}, h('th', {}, fmtPy(k, heap)), h('td', {}, fmtPy(val, heap))));
        cell.appendChild(t);
        if ((node.len ?? 0) > node.entries.length) cell.appendChild(h('span', { class: 'muted' }, `… ${node.len! - node.entries.length} more keys`));
      } else if (node?.fields) {
        const t = h('table', { class: 'kv' });
        for (const [k, val] of node.fields) t.appendChild(h('tr', {}, h('th', {}, k), h('td', {}, fmtPy(val, heap))));
        cell.appendChild(t);
      } else {
        cell.appendChild(h('pre', { class: 'console small' }, fmtPy(r.value ?? root, heap)));
      }
      if (r.truncated) cell.appendChild(h('p', { class: 'muted' }, 'Large structure: only part of it is shown.'));
    } catch (e) {
      clear(cell);
      cell.appendChild(h('span', { class: 'error-text' }, (e as HostError).message));
    }
  }

  private async draw(name: string): Promise<void> {
    try {
      const r = await request<InspectResult>({ type: 'inspectVariable', name });
      this.visualize(name, r.root ?? r.value ?? null, r.heap ?? {});
    } catch (e) {
      this.error((e as HostError).message);
    }
  }
}
