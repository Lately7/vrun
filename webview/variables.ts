/** Variables panel: cheap metadata table with click-to-inspect. */
import { HostError, request, send } from './api';
import { button, clear, formatBytes, h, truncateText } from './dom';
import { Encoded, Heap, fmtScalar } from './format';

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
  error?: string;
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

  constructor(
    private openDataFrame: (name: string) => void,
    private visualize: (name: string, root: Encoded, heap: Heap) => void,
  ) {
    this.render();
  }

  setList(list: VariablesList): void {
    this.list = list;
    this.render();
  }

  invalidate(message: string): void {
    this.list = undefined;
    this.expanded.clear();
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
      case 'function':
      case 'class':
        return fmtScalar(v.value);
      case 'dataframe':
        return `${v.shape?.[0].toLocaleString()} rows × ${v.shape?.[1]} cols · ${Object.entries(v.dtypes ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')}`;
      case 'series':
        return `${v.shape?.[0].toLocaleString()} values · ${v.dtype}`;
      case 'ndarray':
        return `${v.shape?.join(' × ')} ${v.dtype}${v.preview ? ` [${v.preview.map((p) => fmtScalar(p)).join(', ')}]` : ''}`;
      case 'estimator':
        return v.fitted ? `fitted (${v.fittedAttrs?.slice(0, 4).join(', ')})` : 'not fitted';
      case 'list':
      case 'tuple':
      case 'set':
      case 'frozenset':
      case 'deque':
      case 'dict': {
        const items = (v.preview ?? []).map((p) => fmtScalar(p)).join(', ');
        const more = (v.len ?? 0) > (v.preview?.length ?? 0) ? ', …' : '';
        const [o, c] = v.kind === 'dict' ? ['{', '}'] : v.kind === 'tuple' ? ['(', ')'] : v.kind === 'list' ? ['[', ']'] : ['{', '}'];
        return `${o}${items}${more}${c}`;
      }
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
    this.el.append(
      h('div', { class: 'toolbar' }, search, button('⟳ Refresh', () => send({ type: 'refreshVariables' }), { title: 'Refresh variables' }),
        this.list ? h('span', { class: 'muted' }, `${this.list.variables.length} variables · revision ${this.list.revision}`) : null),
      tableHost,
    );
    this.renderTable(tableHost);
  }

  private renderTable(host: HTMLElement): void {
    clear(host);
    if (!this.list) {
      host.appendChild(h('p', { class: 'muted' }, this.message));
      return;
    }
    const f = this.filter.toLowerCase();
    const rows = this.list.variables.filter((v) => !f || v.name.toLowerCase().includes(f) || v.type.toLowerCase().includes(f));
    const table = h('table', { class: 'grid vars' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Shape / len'), h('th', {}, 'Value'), h('th', {}, 'Size'), h('th', {}, ''))));
    const tbody = h('tbody', {});
    for (const v of rows) {
      const shape = v.shape ? v.shape.join(' × ') : v.len !== undefined ? String(v.len) : '';
      const actions = h('td', { class: 'actions' });
      if (v.kind === 'dataframe' || v.kind === 'series') actions.appendChild(button('Open', () => this.openDataFrame(v.name), { title: 'Open in DataFrame viewer' }));
      if (v.viz && v.kind !== 'dataframe' && v.kind !== 'series') actions.appendChild(button('Draw', () => void this.draw(v.name), { title: `Visualize as ${v.viz}` }));
      if (!['function', 'class', 'dataframe', 'series', 'estimator'].includes(v.kind)) actions.appendChild(button(this.expanded.has(v.name) ? '▾' : '▸', () => this.toggle(v.name), { title: 'Details' }));
      const tr = h('tr', { tabindex: 0 },
        h('td', { class: 'name' }, v.name),
        h('td', { class: 'type', title: v.type }, truncateText(v.type, 28)),
        h('td', {}, shape),
        h('td', { class: 'value', title: this.summary(v) }, truncateText(this.summary(v), 140)),
        h('td', { class: 'num' }, v.size !== undefined ? `${v.sizeIsLowerBound ? '≥ ' : ''}${formatBytes(v.size)}` : ''),
        actions,
      );
      tr.addEventListener('dblclick', () => (v.kind === 'dataframe' || v.kind === 'series' ? this.openDataFrame(v.name) : this.toggle(v.name)));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') v.kind === 'dataframe' || v.kind === 'series' ? this.openDataFrame(v.name) : this.toggle(v.name);
      });
      tbody.appendChild(tr);
      if (this.expanded.has(v.name)) {
        const detail = h('td', { colspan: 6, class: 'detail' }, h('span', { class: 'muted' }, 'Loading…'));
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

  private async loadDetail(name: string, cell: HTMLElement): Promise<void> {
    try {
      const r = await request<InspectResult>({ type: 'inspectVariable', name });
      clear(cell);
      const heap = r.heap ?? {};
      const root = r.root;
      const node = root && typeof root === 'object' && 'ref' in root ? heap[String(root.ref)] : undefined;
      if (node?.items) {
        cell.appendChild(h('div', { class: 'chips' }, ...node.items.slice(0, 100).map((it, i) => h('span', { class: 'chip', title: `[${i}]` }, fmtScalar(it, heap)))));
        if ((node.len ?? 0) > node.items.length) cell.appendChild(h('span', { class: 'muted' }, ` … ${node.len! - node.items.length} more`));
      } else if (node?.entries) {
        const t = h('table', { class: 'kv' });
        for (const [k, val] of node.entries.slice(0, 100)) t.appendChild(h('tr', {}, h('th', {}, fmtScalar(k, heap)), h('td', {}, fmtScalar(val, heap))));
        cell.appendChild(t);
      } else if (node?.fields) {
        const t = h('table', { class: 'kv' });
        for (const [k, val] of node.fields) t.appendChild(h('tr', {}, h('th', {}, k), h('td', {}, fmtScalar(val, heap))));
        cell.appendChild(t);
      } else {
        cell.appendChild(h('pre', { class: 'console small' }, fmtScalar(r.value ?? root, heap)));
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
