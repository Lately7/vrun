/**
 * DataFrame viewer. The frame stays in the kernel; this view requests one
 * bounded page at a time. Sort/filter are full-data operations in the kernel.
 */
import { HostError, request, send } from './api';
import { button, clear, formatBytes, h } from './dom';
import { Encoded, fmtNumber, fmtScalar, scalarClass } from './format';

interface Column {
  index: number;
  name: string;
  dtype: string;
  kind: string;
}
interface Metadata {
  name: string;
  isSeries: boolean;
  shape: [number, number];
  columns: Column[];
  columnsTruncated: boolean;
  memory: number;
  memoryIsLowerBound: boolean;
  revision: number;
}
interface Page {
  offset: number;
  total: number;
  rows: Encoded[][];
  index: Encoded[];
  positions: number[];
  colOffset: number;
  columns: string[];
  fullData: boolean;
}
interface Summary {
  rows: number;
  columns: Array<{ index: number; name: string; nulls: number; nullPct: number; stats?: Record<string, Encoded> }>;
}
interface ColumnDetail {
  name: string;
  dtype: string;
  count: number;
  nulls: number;
  unique: number;
  top: Array<[Encoded, number]>;
}

const COL_WINDOW = 50;
const OPS: Array<[string, string]> = [
  ['eq', '='], ['ne', '≠'], ['lt', '<'], ['le', '≤'], ['gt', '>'], ['ge', '≥'], ['contains', 'contains'], ['isnull', 'is missing'], ['notnull', 'is not missing'],
];

export class DataFrameView {
  readonly el = h('div', { class: 'dataframe' });
  private name: string | undefined;
  private meta: Metadata | undefined;
  private page: Page | undefined;
  private offset = 0;
  private colOffset = 0;
  private pageSize = 50;
  private sort: { column: number; ascending: boolean } | undefined;
  private filter: { column: number; op: string; value?: string } | undefined;
  private seq = 0;
  private loading = '';
  private error = '';
  private summary: Summary | undefined;
  private columnDetail: ColumnDetail | undefined;
  private selected: { r: number; c: number } | undefined;

  constructor(private getFrameNames: () => string[]) {
    this.render();
  }

  setPageSize(n: number): void {
    this.pageSize = n;
  }

  invalidate(message: string): void {
    this.seq++;
    this.meta = undefined;
    this.page = undefined;
    this.summary = undefined;
    this.columnDetail = undefined;
    this.loading = '';
    this.error = this.name ? `${message} Re-run your code, then reopen "${this.name}".` : '';
    this.render();
  }

  async open(name: string): Promise<void> {
    this.name = name;
    this.offset = 0;
    this.colOffset = 0;
    this.sort = undefined;
    this.filter = undefined;
    this.summary = undefined;
    this.columnDetail = undefined;
    await this.loadMeta();
  }

  /** Called after any execution: the frame may have changed or vanished. */
  async refreshIfOpen(): Promise<void> {
    if (this.name && this.meta) await this.loadMeta(true);
  }

  private async loadMeta(keepPosition = false): Promise<void> {
    const name = this.name!;
    const my = ++this.seq;
    this.loading = 'Loading metadata…';
    this.error = '';
    this.render();
    try {
      const meta = await request<Metadata>({ type: 'dfMetadata', name });
      if (my !== this.seq) return;
      this.meta = meta;
      if (!keepPosition) this.offset = 0;
      this.summary = keepPosition ? undefined : this.summary;
      await this.loadPage();
    } catch (e) {
      if (my !== this.seq) return;
      this.meta = undefined;
      this.loading = '';
      this.error = (e as HostError).message;
      this.render();
    }
  }

  private async loadPage(): Promise<void> {
    if (!this.meta) return;
    const my = ++this.seq;
    // Selection is a position in the current page; a new page invalidates it
    // (otherwise "Copy cell" would copy whatever now sits at that position).
    this.selected = undefined;
    this.loading = this.sort || this.filter ? 'Sorting / filtering the full DataFrame in the kernel…' : 'Loading rows…';
    this.render();
    try {
      const page = await request<Page>({
        type: 'dfPage',
        name: this.meta.name,
        revision: this.meta.revision,
        offset: this.offset,
        limit: this.pageSize,
        colOffset: this.colOffset,
        colLimit: COL_WINDOW,
        sort: this.sort ?? null,
        filter: this.filter ?? null,
      });
      if (my !== this.seq) return; // a newer navigation superseded this one
      this.page = page;
      this.loading = '';
      this.error = '';
    } catch (e) {
      if (my !== this.seq) return;
      const err = e as HostError;
      if (err.code === 'stale_revision') {
        await this.loadMeta(true);
        return;
      }
      this.loading = '';
      this.error = err.message;
    }
    this.render();
  }

  private go(offset: number): void {
    const total = this.page?.total ?? this.meta?.shape[0] ?? 0;
    const last = Math.max(0, Math.floor((total - 1) / this.pageSize) * this.pageSize);
    this.offset = Math.max(0, Math.min(last, offset));
    void this.loadPage();
  }

  /** True while the frame a detail request was made for is still on screen. */
  private stillShowing(meta: Metadata): boolean {
    return this.meta !== undefined && this.meta.name === meta.name && this.meta.revision === meta.revision;
  }

  private async loadSummary(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    this.loading = 'Computing missing values and statistics over all rows…';
    this.render();
    try {
      const summary = await request<Summary>({ type: 'dfSummary', name: meta.name, revision: meta.revision });
      if (!this.stillShowing(meta)) return; // user switched frames meanwhile
      this.summary = summary;
    } catch (e) {
      if (!this.stillShowing(meta)) return;
      this.error = (e as HostError).message;
    }
    this.loading = '';
    this.render();
  }

  private async loadColumn(col: number): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    this.loading = 'Inspecting column…';
    this.render();
    try {
      const detail = await request<ColumnDetail>({ type: 'dfColumn', name: meta.name, revision: meta.revision, column: col });
      if (!this.stillShowing(meta)) return;
      this.columnDetail = detail;
    } catch (e) {
      if (!this.stillShowing(meta)) return;
      this.error = (e as HostError).message;
    }
    this.loading = '';
    this.render();
  }

  private render(): void {
    clear(this.el);
    if (!this.name) {
      const names = this.getFrameNames();
      this.el.appendChild(h('p', { class: 'muted' }, names.length ? 'Choose a DataFrame:' : 'No DataFrame yet. Create one in your code, run it, then open it here.'));
      if (names.length) this.el.appendChild(h('div', { class: 'toolbar' }, ...names.map((n) => button(n, () => void this.open(n)))));
      return;
    }
    const m = this.meta;
    const header = h('div', { class: 'df-header' }, h('h2', {}, this.name));
    if (m) {
      header.appendChild(h('span', { class: 'muted' }, `${m.shape[0].toLocaleString()} rows × ${m.shape[1]} columns · ${m.memoryIsLowerBound ? '≥ ' : ''}${formatBytes(m.memory)} · revision ${m.revision}`));
    }
    const names = this.getFrameNames().filter((n) => n !== this.name);
    if (names.length) {
      const sel = h('select', { 'aria-label': 'Switch DataFrame' }, h('option', { value: '' }, 'Switch to…'), ...names.map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
      sel.addEventListener('change', () => sel.value && void this.open(sel.value));
      header.appendChild(sel);
    }
    this.el.appendChild(header);
    if (this.error) this.el.appendChild(h('p', { class: 'error-text', role: 'alert' }, this.error));
    if (this.loading) this.el.appendChild(h('p', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), this.loading));
    if (!m) return;

    this.el.appendChild(this.renderFilterBar(m));
    this.el.appendChild(this.renderNav(m));
    if (this.page) this.el.appendChild(this.renderTable(m, this.page));
    this.el.appendChild(this.renderSummary(m));
  }

  private renderFilterBar(m: Metadata): HTMLElement {
    const colSel = h('select', { 'aria-label': 'Filter column' }, ...m.columns.map((c) => h('option', { value: c.index }, c.name))) as HTMLSelectElement;
    const opSel = h('select', { 'aria-label': 'Filter operator' }, ...OPS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    const val = h('input', { type: 'text', placeholder: 'value', 'aria-label': 'Filter value', maxlength: 1000 }) as HTMLInputElement;
    if (this.filter) {
      colSel.value = String(this.filter.column);
      opSel.value = this.filter.op;
      val.value = this.filter.value ?? '';
    }
    const apply = () => {
      const op = opSel.value;
      this.filter = { column: Number(colSel.value), op, ...(op === 'isnull' || op === 'notnull' ? {} : { value: val.value }) };
      this.offset = 0;
      void this.loadPage();
    };
    val.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
    const bar = h('div', { class: 'toolbar' }, h('span', { class: 'label' }, 'Filter (all rows):'), colSel, opSel, val, button('Apply', apply, { cls: 'btn primary' }));
    if (this.filter) bar.appendChild(button('Clear filter', () => {
      this.filter = undefined;
      this.offset = 0;
      void this.loadPage();
    }));
    if (this.sort) bar.appendChild(button(`Clear sort (${m.columns[this.sort.column]?.name} ${this.sort.ascending ? '↑' : '↓'})`, () => {
      this.sort = undefined;
      void this.loadPage();
    }));
    return bar;
  }

  private renderNav(m: Metadata): HTMLElement {
    const total = this.page?.total ?? m.shape[0];
    const from = total ? this.offset + 1 : 0;
    const to = Math.min(this.offset + this.pageSize, total);
    const goto = h('input', { type: 'number', min: 1, max: Math.max(1, total), placeholder: 'row #', 'aria-label': 'Go to row', class: 'narrow' }) as HTMLInputElement;
    goto.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && goto.value) this.go(Math.floor((Number(goto.value) - 1) / this.pageSize) * this.pageSize);
    });
    const size = h('select', { 'aria-label': 'Rows per page' }, ...[25, 50, 100, 200, 500].map((n) => h('option', { value: n }, `${n} / page`))) as HTMLSelectElement;
    size.value = String(this.pageSize);
    size.addEventListener('change', () => {
      this.pageSize = Number(size.value);
      this.offset = Math.floor(this.offset / this.pageSize) * this.pageSize;
      void this.loadPage();
    });
    const nav = h(
      'div',
      { class: 'toolbar' },
      button('⏮', () => this.go(0), { title: 'First page', disabled: this.offset === 0 }),
      button('◀', () => this.go(this.offset - this.pageSize), { title: 'Previous page', disabled: this.offset === 0 }),
      h('span', {}, `Rows ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}${this.page?.fullData ? ' (after full-data sort/filter)' : ''}`),
      button('▶', () => this.go(this.offset + this.pageSize), { title: 'Next page', disabled: to >= total }),
      button('⏭', () => this.go(total), { title: 'Last page', disabled: to >= total }),
      goto,
      size,
    );
    if (m.shape[1] > COL_WINDOW) {
      nav.appendChild(button('◀ cols', () => { this.colOffset = Math.max(0, this.colOffset - COL_WINDOW); void this.loadPage(); }, { disabled: this.colOffset === 0 }));
      nav.appendChild(h('span', { class: 'muted' }, `columns ${this.colOffset + 1}–${Math.min(this.colOffset + COL_WINDOW, m.shape[1])}`));
      nav.appendChild(button('cols ▶', () => { this.colOffset += COL_WINDOW; void this.loadPage(); }, { disabled: this.colOffset + COL_WINDOW >= m.shape[1] }));
    }
    if (this.selected && this.page) {
      const v = this.page.rows[this.selected.r]?.[this.selected.c];
      nav.appendChild(button('Copy cell', () => send({ type: 'copy', text: fmtScalar(v) }), { title: 'Copy selected value' }));
      nav.appendChild(button('Copy row', () => send({ type: 'copy', text: this.page!.rows[this.selected!.r].map((x) => fmtScalar(x)).join('\t') }), { title: 'Copy selected row (tab-separated)' }));
    }
    return nav;
  }

  private renderTable(m: Metadata, p: Page): HTMLElement {
    const cols = m.columns.slice(p.colOffset, p.colOffset + p.columns.length);
    const headRow = h('tr', {}, h('th', { class: 'idx', scope: 'col' }, 'index'));
    for (const c of cols) {
      const sorted = this.sort?.column === c.index ? (this.sort.ascending ? ' ↑' : ' ↓') : '';
      const th = h('th', { scope: 'col', title: `${c.name} (${c.dtype}) — click to sort all rows` },
        h('div', { class: 'col-name' }, c.name + sorted), h('div', { class: `dtype k-${c.kind}` }, c.dtype));
      th.tabIndex = 0;
      const doSort = () => {
        if (this.sort?.column !== c.index) this.sort = { column: c.index, ascending: true };
        else if (this.sort.ascending) this.sort = { column: c.index, ascending: false };
        else this.sort = undefined;
        this.offset = 0;
        void this.loadPage();
      };
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', (e) => e.key === 'Enter' && doSort());
      const info = button('ⓘ', () => void this.loadColumn(c.index), { cls: 'icon-btn', title: 'Inspect this column (full scan)' });
      info.addEventListener('click', (e) => e.stopPropagation());
      th.appendChild(info);
      headRow.appendChild(th);
    }
    const tbody = h('tbody', {});
    p.rows.forEach((row, r) => {
      const tr = h('tr', {}, h('th', { class: 'idx', scope: 'row' }, fmtScalar(p.index[r])));
      row.forEach((v, c) => {
        const sel = this.selected?.r === r && this.selected?.c === c;
        const td = h('td', { class: `${scalarClass(v)} ${sel ? 'sel' : ''}` }, fmtScalar(v));
        td.addEventListener('click', () => {
          this.selected = { r, c };
          this.render();
        });
        td.addEventListener('dblclick', () => send({ type: 'copy', text: fmtScalar(v) }));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    return h('div', { class: 'table-scroll' }, h('table', { class: 'grid df' }, h('thead', {}, headRow), tbody));
  }

  private renderSummary(m: Metadata): HTMLElement {
    const sec = h('section', { class: 'df-summary' });
    if (this.columnDetail) {
      const d = this.columnDetail;
      sec.appendChild(h('h3', {}, `Column "${d.name}" (${d.dtype})`));
      sec.appendChild(h('p', {}, `${d.count.toLocaleString()} values · ${d.nulls.toLocaleString()} missing · ${d.unique.toLocaleString()} unique`));
      const t = h('table', { class: 'kv' }, h('tr', {}, h('th', {}, 'Top values'), h('th', {}, 'count')));
      for (const [k, n] of d.top) t.appendChild(h('tr', {}, h('td', {}, fmtScalar(k)), h('td', { class: 'num' }, n.toLocaleString())));
      sec.appendChild(t);
    }
    if (!this.summary) {
      sec.appendChild(button('Compute missing values & statistics (scans all rows)', () => void this.loadSummary(), { cls: 'btn' }));
      return sec;
    }
    const t = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['Column', 'Missing', 'Missing %', 'mean', 'std', 'min', '50%', 'max'].map((x) => h('th', {}, x)))));
    for (const c of this.summary.columns) {
      const st = c.stats ?? {};
      const bar = h('div', { class: 'nullbar', title: `${c.nullPct.toFixed(2)}% missing` }, h('div', { class: 'nullbar-fill' }));
      (bar.firstChild as HTMLElement).style.width = `${Math.min(100, c.nullPct)}%`;
      t.appendChild(
        h('tr', {},
          h('td', {}, c.name),
          h('td', { class: 'num' }, c.nulls.toLocaleString()),
          h('td', {}, h('div', { class: 'nullcell' }, bar, `${fmtNumber(Number(c.nullPct.toFixed(2)))}%`)),
          ...['mean', 'std', 'min', '50%', 'max'].map((k) => h('td', { class: 'num' }, st[k] === undefined ? '' : fmtScalar(st[k]))),
        ),
      );
    }
    sec.appendChild(h('h3', {}, `Summary of ${m.shape[0].toLocaleString()} rows`));
    sec.appendChild(t);
    return sec;
  }
}
