/**
 * Dashboard client.
 *
 * No framework, by the same reasoning as the stylesheet: this app is the
 * *payload* of a deployment demo, so its own dependencies are noise. It is
 * still real TypeScript compiled against the same `src/lib/types.ts` the server
 * and the generated reports use, so the API contract is checked at build time
 * on both sides of the wire.
 */
import type {
  BuildInfo,
  CohortRow,
  CountryDayMatrix,
  Drilldown,
  FunnelRow,
  Rollup,
  SessionStats,
} from '../lib/types';

type StatsResponse = {
  greeting: string;
  deploymentId: string | null;
  attempt: string | null;
  events: number;
  users: number;
  sessions: number;
  reports: number;
  warmupMs: number;
  checksum: string;
  checksumVerified: boolean;
  node: string;
  pid: number;
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number; arrayBuffersBytes: number };
};

type Dimensions = {
  routes: string[];
  countries: string[];
  devices: string[];
  statuses: number[];
  windows: string[];
};

/** Throws rather than returning null: a missing element is a template bug. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} responded ${String(response.status)}`);
  return (await response.json()) as T;
}

const nf = new Intl.NumberFormat('en-US');

function fmt(n: number): string {
  return nf.format(Math.round(n));
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

function pct(ratio: number, digits = 2): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Clears a node and appends children. `textContent` everywhere — no innerHTML. */
function fill(parent: HTMLElement, children: readonly Node[]): void {
  parent.replaceChildren(...children);
}

function tag<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function kpi(label: string, value: string, sub: string, tone?: 'good' | 'bad'): HTMLElement {
  const card = tag('div', tone ? `kpi ${tone}` : 'kpi');
  card.append(tag('div', 'label', label), tag('div', 'value', value), tag('div', 'sub', sub));
  return card;
}

function barRow(name: string, value: string, fraction: number): HTMLElement {
  const row = tag('div', 'row');
  const track = tag('div', 'track');
  const bar = tag('div', 'fill');
  bar.style.width = `${Math.max(1, Math.min(100, fraction * 100)).toFixed(2)}%`;
  track.append(bar);
  row.append(tag('div', 'name', name), track, tag('div', 'val', value));
  return row;
}

function table(headers: readonly string[], rows: readonly (readonly Node[])[]): HTMLTableElement {
  const node = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) headRow.append(tag('th', undefined, header));
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    tr.append(...cells);
    tbody.append(tr);
  }
  node.append(thead, tbody);
  return node;
}

function td(text: string, className?: string): HTMLTableCellElement {
  return tag('td', className, text);
}

// --------------------------------------------------------------- renderers -

function renderKpis(summary: Rollup, sessions: SessionStats, stats: StatsResponse): void {
  const { totals } = summary;
  fill(el('kpis'), [
    kpi('Requests', compact(totals.requests), `${summary.window.days} day window`),
    kpi(
      'Error rate',
      pct(totals.errorRate),
      `${fmt(totals.errors)} failures`,
      totals.errorRate > 0.05 ? 'bad' : 'good',
    ),
    kpi('p95 latency', `${fmt(totals.p95Ms)}ms`, `p50 ${fmt(totals.p50Ms)}ms · p99 ${fmt(totals.p99Ms)}ms`),
    kpi('Data served', bytes(totals.bytes), `avg ${fmt(totals.avgDurationMs)}ms/request`),
    kpi('Sessions', compact(sessions.sessions), `${pct(sessions.bounceRate, 1)} bounce`),
    kpi('Warm-up', `${fmt(stats.warmupMs)}ms`, `${compact(stats.events)} events resident`),
  ]);
}

function renderDaily(summary: Rollup): void {
  const peak = Math.max(1, ...summary.byDay.map((day) => day.requests));
  const bars = summary.byDay.map((day) => {
    const bar = tag('div', day.errors / Math.max(1, day.requests) > 0.055 ? 'bar err' : 'bar');
    bar.style.height = `${Math.max(2, (day.requests / peak) * 100).toFixed(2)}%`;
    bar.title = `${day.date} — ${fmt(day.requests)} requests, ${fmt(day.errors)} errors, avg ${fmt(day.avgDurationMs)}ms`;
    return bar;
  });
  fill(el('chart-daily'), bars);
}

function renderHourly(hourly: readonly Drilldown[]): void {
  const peak = Math.max(1, ...hourly.map((hour) => hour.totals.requests));
  fill(
    el('chart-hourly'),
    hourly.map((hour) => {
      const bar = tag('div', 'bar');
      bar.style.height = `${Math.max(2, (hour.totals.requests / peak) * 100).toFixed(2)}%`;
      bar.title = `${hour.label} — ${fmt(hour.totals.requests)} requests, p95 ${fmt(hour.totals.p95Ms)}ms`;
      return bar;
    }),
  );
}

function renderStatus(summary: Rollup): void {
  const peak = Math.max(1, ...summary.byStatus.map((status) => status.requests));
  fill(
    el('bars-status'),
    summary.byStatus.map((status) =>
      barRow(String(status.code), fmt(status.requests), status.requests / peak),
    ),
  );
}

function renderRoutes(summary: Rollup): void {
  const rows = summary.byRoute.map((route) => [
    td(route.path),
    td(fmt(route.requests), 'num'),
    td(pct(route.errorRate), route.errorRate > 0.05 ? 'num bad' : 'num'),
    td(`${fmt(route.p50Ms)}ms`, 'num'),
    td(`${fmt(route.p95Ms)}ms`, 'num'),
    td(`${fmt(route.p99Ms)}ms`, 'num'),
    td(bytes(route.bytes), 'num'),
  ]);
  fill(el('table-routes'), [
    table(['Route', 'Requests', 'Errors', 'p50', 'p95', 'p99', 'Bytes'], rows),
  ]);

  const peak = Math.max(1, ...summary.byCountry.map((country) => country.requests));
  fill(
    el('bars-countries'),
    summary.byCountry
      .slice(0, 12)
      .map((country) => barRow(country.code, fmt(country.requests), country.requests / peak)),
  );
}

function renderCohorts(cohorts: readonly CohortRow[]): void {
  const width = Math.max(0, ...cohorts.map((row) => row.retention.length));
  const headers = ['Cohort', 'Users', ...Array.from({ length: width }, (_, i) => `W+${String(i)}`)];
  const rows = cohorts.map((row) => {
    const cells: Node[] = [td(row.cohort), td(fmt(row.users), 'num')];
    for (let i = 0; i < width; i++) {
      const value = row.retention[i];
      const cell = td(value === undefined ? '' : pct(value, 0), 'num');
      if (value !== undefined) {
        cell.style.background = `rgba(76, 141, 255, ${(value * 0.55).toFixed(3)})`;
      }
      cells.push(cell);
    }
    return cells;
  });
  fill(el('table-cohorts'), [table(headers, rows)]);
}

function renderFunnel(steps: readonly FunnelRow[]): void {
  const first = steps[0]?.users ?? 1;
  fill(
    el('funnel'),
    steps.map((step) => {
      const row = tag('div', 'step');
      const bar = tag('div', 'bar');
      bar.style.width = `${Math.max(2, (step.users / Math.max(1, first)) * 100).toFixed(2)}%`;
      row.append(
        tag('div', 'name', step.path),
        bar,
        tag(
          'div',
          'val mono',
          `${fmt(step.users)} · ${pct(step.conversionFromPrevious, 1)} of previous`,
        ),
      );
      return row;
    }),
  );
}

function renderSessions(sessions: SessionStats): void {
  const entries: Array<[string, string, number]> = [
    ['Sessions', fmt(sessions.sessions), 1],
    ['Bounced', fmt(sessions.bouncedSessions), sessions.bounceRate],
    ['Events / session', String(sessions.avgEventsPerSession), sessions.avgEventsPerSession / 10],
    ['Avg duration', `${fmt(sessions.avgSessionSeconds)}s`, sessions.avgSessionSeconds / 3600],
    ['Longest', `${fmt(sessions.longestSessionSeconds)}s`, 1],
  ];
  fill(
    el('session-stats'),
    entries.map(([name, value, fraction]) => barRow(name, value, fraction)),
  );
}

function renderMatrix(matrix: readonly CountryDayMatrix[]): void {
  const peak = Math.max(
    1,
    ...matrix.flatMap((row) => row.cells.map((cell) => cell.requests)),
  );
  fill(
    el('heatmap'),
    matrix.map((row) => {
      const line = tag('div', 'heat-row');
      line.append(tag('div', 'code', row.country));
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        if (!cell) continue;
        const node = tag('div', 'heat-cell');
        const intensity = cell.requests / peak;
        node.style.background =
          cell.errorRate > 0.06
            ? `rgba(248, 81, 73, ${Math.max(0.15, intensity).toFixed(3)})`
            : `rgba(76, 141, 255, ${Math.max(0.06, intensity).toFixed(3)})`;
        node.title = `${row.country} ${row.days[i] ?? ''} — ${fmt(cell.requests)} requests, ${pct(cell.errorRate)} errors, p95 ${fmt(cell.p95Ms)}ms`;
        line.append(node);
      }
      return line;
    }),
  );
}

function renderBuild(info: BuildInfo, stats: StatsResponse): void {
  const slowest = Math.max(1, ...info.stages.map((stage) => stage.ms));
  fill(
    el('build-stages'),
    info.stages.map((stage) => barRow(stage.title, `${fmt(stage.ms)}ms`, stage.ms / slowest)),
  );

  fill(el('runtime-stats'), [
    barRow('RSS', bytes(stats.memory.rssBytes), stats.memory.rssBytes / (512 * 1024 * 1024)),
    barRow('Heap used', bytes(stats.memory.heapUsedBytes), stats.memory.heapUsedBytes / (512 * 1024 * 1024)),
    barRow('ArrayBuffers', bytes(stats.memory.arrayBuffersBytes), stats.memory.arrayBuffersBytes / (512 * 1024 * 1024)),
    barRow('Warm-up', `${fmt(stats.warmupMs)}ms`, Math.min(1, stats.warmupMs / 15000)),
    barRow('Uptime', `${fmt(stats.uptimeSeconds)}s`, Math.min(1, stats.uptimeSeconds / 3600)),
    barRow('Reports', fmt(stats.reports), 1),
  ]);

  const rows = info.assets.map((asset) => [
    td(asset.file),
    td(bytes(asset.bytes), 'num'),
    td(`${asset.sha256.slice(0, 24)}…`, 'num'),
  ]);
  fill(el('table-assets'), [table(['File', 'Size', 'sha256'], rows)]);
}

// -------------------------------------------------------------- live query -

function renderQueryResult(result: Rollup, queryMs: number): void {
  const container = el('query-result');
  const meta = tag(
    'div',
    'meta',
    `${fmt(result.totals.requests)} matching requests · scanned in ${fmt(queryMs)}ms · ` +
      `error rate ${pct(result.totals.errorRate)} · p95 ${fmt(result.totals.p95Ms)}ms`,
  );
  const peak = Math.max(1, ...result.byRoute.map((route) => route.requests));
  const bars = tag('div', 'bars');
  for (const route of result.byRoute.slice(0, 12)) {
    if (route.requests === 0) continue;
    bars.append(barRow(route.path, fmt(route.requests), route.requests / peak));
  }
  fill(container, [meta, bars]);
}

function wireQuery(dimensions: Dimensions): void {
  const country = el<HTMLSelectElement>('q-country');
  const route = el<HTMLSelectElement>('q-route');
  const hour = el<HTMLSelectElement>('q-hour');

  const option = (value: string, label: string): HTMLOptionElement => {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  };

  fill(country, [option('', 'All'), ...dimensions.countries.map((code) => option(code, code))]);
  fill(route, [option('', 'All'), ...dimensions.routes.map((path) => option(path, path))]);
  fill(hour, [
    option('', 'All'),
    ...Array.from({ length: 24 }, (_, h) => option(String(h), `${String(h).padStart(2, '0')}:00`)),
  ]);

  el<HTMLFormElement>('query-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (country.value !== '') params.set('country', country.value);
    if (route.value !== '') params.set('route', route.value);
    if (hour.value !== '') params.set('hour', hour.value);
    params.set('fromDay', el<HTMLInputElement>('q-from').value);
    params.set('toDay', el<HTMLInputElement>('q-to').value);

    el('query-result').textContent = 'querying…';
    getJson<{ queryMs: number; rollup: Rollup }>(`/api/query?${params.toString()}`)
      .then((payload) => renderQueryResult(payload.rollup, payload.queryMs))
      .catch((error: unknown) => {
        el('query-result').textContent = `query failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      });
  });
}

function wireTabs(): void {
  const tabs = el('tabs');
  for (const button of Array.from(tabs.querySelectorAll<HTMLButtonElement>('button'))) {
    button.addEventListener('click', () => {
      const target = button.dataset['tab'];
      if (target === undefined) return;
      for (const other of Array.from(tabs.querySelectorAll<HTMLButtonElement>('button'))) {
        other.classList.toggle('active', other === button);
      }
      for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.panel'))) {
        panel.classList.toggle('hidden', panel.id !== `panel-${target}`);
      }
    });
  }
}

function wireWindowPicker(windows: readonly string[], onPick: (key: string) => void): void {
  const picker = el('window-picker');
  const buttons = windows.map((key) => {
    const button = tag('button', key === '90d' ? 'active' : undefined, key);
    button.addEventListener('click', () => {
      for (const other of buttons) other.classList.toggle('active', other === button);
      onPick(key);
    });
    return button;
  });
  picker.className = 'tabs window-picker';
  fill(picker, buttons);
}

// -------------------------------------------------------------------- boot -

async function boot(): Promise<void> {
  const [stats, info, dimensions, sessions, hourly, cohortRows, funnelRows, matrix] =
    await Promise.all([
      getJson<StatsResponse>('/api/stats'),
      getJson<BuildInfo>('/api/build'),
      getJson<Dimensions>('/api/dimensions'),
      getJson<SessionStats>('/api/sessions'),
      getJson<{ hourly: Drilldown[] }>('/api/hourly'),
      getJson<{ cohorts: CohortRow[] }>('/api/cohorts'),
      getJson<{ funnel: FunnelRow[] }>('/api/funnel'),
      getJson<{ matrix: CountryDayMatrix[] }>('/api/matrix'),
    ]);

  el('greeting').textContent = stats.greeting;
  el('deployment').textContent = stats.deploymentId ?? 'local';

  const showWindow = (key: string): void => {
    void getJson<Rollup>(`/api/summary?window=${encodeURIComponent(key)}`).then((summary) => {
      renderKpis(summary, sessions, stats);
      renderDaily(summary);
      renderStatus(summary);
      renderRoutes(summary);
    });
  };

  wireTabs();
  wireWindowPicker(dimensions.windows, showWindow);
  wireQuery(dimensions);

  showWindow('90d');
  renderHourly(hourly.hourly);
  renderCohorts(cohortRows.cohorts);
  renderFunnel(funnelRows.funnel);
  renderSessions(sessions);
  renderMatrix(matrix.matrix);
  renderBuild(info, stats);

  el('footer-note').textContent =
    `${compact(stats.events)} events · ${compact(stats.users)} users · ` +
    `${fmt(stats.reports)} generated reports · node ${stats.node} · pid ${String(stats.pid)}`;
  el('footer-checksum').textContent = `${stats.checksumVerified ? '✓' : '✗'} ${stats.checksum.slice(0, 32)}…`;
}

boot().catch((error: unknown) => {
  const note = document.getElementById('footer-note');
  if (note) note.textContent = `failed to load: ${error instanceof Error ? error.message : String(error)}`;
});
