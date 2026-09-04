/* ============================================================
   app.js — состояние экрана, события, импорт, бутстрап.
   Всё, что считается, живёт в metrics.js; всё, что рисуется, — в ui.js.
   ============================================================ */
(() => {
  'use strict';

  /** Состояние интерфейса: не сохраняется, кроме периода и фильтра ранга (они в настройках). */
  const view = {
    tab: 'weekly',
    selection: null,                       // { title, keys: [] } — результат drill-down
    filters: { q: '', state: '', status: '', assignee: '', type: '' },
    sort: { field: 'created', dir: 'desc' },
  };

  let pending = null;                      // разобранная выгрузка до подтверждения импорта

  /* ─────────── контекст рендера ─────────── */

  function context() {
    const sett = Store.settings();
    const all = Store.incidents();
    const range = Store.periodRange(sett.period);
    const cur = Metrics.forRange(all, sett, range);
    const prev = Metrics.forRange(all, sett, Store.previousRange(range));
    const series = Metrics.flowSeries(all, sett, range, 8);
    const rankFiltered = Store.applyRankFilter(all, sett).list;

    const base = view.selection
      ? all.filter(i => view.selection.keys.includes(i.key))
      : rankFiltered;
    const tableList = Metrics.sortList(
      Metrics.filterList(base, view.filters, sett), view.sort.field, view.sort.dir);

    return { sett, all, range, cur, prev, series, rankFiltered, tableList, view,
             importedAt: Store.getState().importedAt };
  }

  const render = () => UI.render(Object.assign(context(), { canGoBack: navDepth > 0 }));

  /* ─────────── история переходов ───────────
     Каждый переход — вкладка, drill-down, смена периода кликом по графику —
     кладётся в history браузера. Назад работает и кнопкой в шапке,
     и Backspace, и системной кнопкой браузера: провалиться в период
     и не найти выход — худшее, что может случиться на встрече. */
  let navDepth = 0;
  let restoring = false;

  const snapshot = depth => ({
    depth,
    tab: view.tab,
    selection: view.selection ? { title: view.selection.title, keys: view.selection.keys.slice() } : null,
    period: Object.assign({}, Store.settings().period),
  });

  function pushNav() {
    if (restoring) return;
    navDepth += 1;
    try { history.pushState(snapshot(navDepth), ''); } catch (e) { /* file:// в некоторых браузерах */ }
    // render() уже прошёл до этого вызова — кнопку «назад» показываем сразу, без перерисовки
    document.getElementById('btnBack').hidden = false;
  }

  function goBack() {
    if (navDepth > 0) history.back();
  }

  function onPopState(e) {
    const st = e.state;
    if (!st || typeof st.depth !== 'number') return;
    restoring = true;
    navDepth = st.depth;
    view.tab = st.tab;
    view.selection = st.selection;
    Store.updateSettings({ period: st.period });
    restoring = false;
    render();
  }

  /* ─────────── drill-down ─────────── */

  const DRILL_TITLES = {
    created: 'Пришло за период', fixed: 'Разобрано за период', closed: 'Закрыто за период',
    fixedNotClosed: 'Исправлено, но не закрыто', open: 'Открыто на конец периода',
    overdue: 'Просрочено по SLA', aging: 'Висят дольше порога', stale: 'Без движения',
    unassigned: 'Без исполнителя', attention: 'Требуют обсуждения', norank: 'Без ранга',
    started: 'Взято в работу за период',
  };

  function drill(kind) {
    const ctx = context();
    let list = [], title = DRILL_TITLES[kind] || kind;

    if (kind.startsWith('band:')) {
      const id = kind.slice(5);
      const bucket = ctx.cur.openByBand.find(b => b.id === id);
      if (!bucket) return;
      list = bucket.items;
      title = `Открытые · ранг ${bucket.label}`;
    } else if (kind === 'norank') {
      list = ctx.all.filter(i => i.rank === null || i.rank === undefined);
    } else if (kind === 'attention') {
      list = Metrics.attention(ctx.cur, ctx.sett).map(r => r.inc);
    } else if (kind === 'started') {
      list = ctx.rankFiltered.filter(i => Metrics.inRange(i.startedMs, ctx.range));
    } else if (ctx.cur.lists[kind]) {
      list = ctx.cur.lists[kind];
    } else return;

    view.selection = { title: `${title} · ${ctx.range.label}`, keys: list.map(i => i.key) };
    view.tab = 'incidents';
    view.filters = { q: '', state: '', status: '', assignee: '', type: '' };
    render();
    pushNav();
  }

  /* ─────────── период и ранг ─────────── */

  function setPeriod(patch) {
    const p = Object.assign({}, Store.settings().period, patch);
    Store.updateSettings({ period: p });
    view.selection = null;
    render();
    pushNav();
  }

  /** «Сегодня»: текущий период того же вида; для произвольного — тот же отрезок, но до сегодня. */
  function goToday() {
    const p = Store.settings().period;
    if (p.mode === 'custom') {
      const len = Store.periodRange(p).days;
      const to = new Date();
      const from = Store.addDays(to, -(len - 1));
      setPeriod({ from: Store.toISODate(from), to: Store.toISODate(to) });
      return;
    }
    setPeriod({ offset: 0 });
  }

  function shiftPeriod(by) {
    const p = Store.settings().period;
    if (p.mode === 'custom') {
      const range = Store.periodRange(p);
      const len = range.days;
      const from = Store.addDays(range.from, by * len);
      setPeriod({ from: Store.toISODate(from), to: Store.toISODate(Store.addDays(from, len - 1)) });
      return;
    }
    setPeriod({ offset: p.offset + by });
  }

  function setMode(mode) {
    const range = Store.periodRange(Store.settings().period);
    if (mode === 'custom') {
      setPeriod({ mode, from: Store.toISODate(range.from), to: Store.toISODate(range.to) });
    } else {
      setPeriod({ mode, offset: -1 });
    }
  }

  function setRank(value) {
    const rank = Object.assign({}, Store.settings().rank);
    if (value === 'all') { rank.enabled = true; rank.min = null; }
    else { rank.enabled = true; rank.min = Number(value); }
    Store.updateSettings({ rank });
    view.selection = null;
    render();
  }

  /* ─────────── модалки ─────────── */

  const openModal = id => { document.getElementById(id).hidden = false; };
  const closeModals = () => document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });

  function openSettings() {
    document.getElementById('settings-body').innerHTML = UI.settingsForm(Store.settings());
    openModal('modal-settings');
  }

  /* ─────────── автосохранение и бэкап ─────────── */

  /**
   * В выбранном файле уже есть данные: спрашиваем, что важнее — они или то,
   * что сейчас в браузере. Молча перетирать нельзя ни в одну сторону.
   */
  function confirmLoad(existing) {
    const count = existing.incidents.length;
    const mine = Store.incidents().length;
    return confirm(
      `В файле уже есть данные: ${count} инцидентов.\n` +
      `Сейчас в браузере: ${mine}.\n\n` +
      'ОК — загрузить данные из файла (текущие будут заменены).\n' +
      'Отмена — оставить текущие и перезаписать файл ими.');
  }

  async function connectFile() {
    const ok = await FileSync.connect(confirmLoad);
    if (ok) { view.selection = null; render(); UI.toast('Автосохранение включено'); }
  }

  /** Одна кнопка в сайдбаре, поведение по статусу: подключить, разрешить, отключить. */
  async function fileSyncAction() {
    const { status } = FileSync.state();
    if (status === 'on') {
      if (confirm('Отключить автосохранение?\nФайл останется на диске со всеми данными, но обновляться перестанет.')) {
        await FileSync.disconnect();
        UI.toast('Автосохранение выключено');
      }
      return;
    }
    if (status === 'needs-permission' || status === 'error') {
      const granted = await FileSync.grantPermission();
      UI.toast(granted ? 'Доступ к файлу подтверждён' : 'Доступ не получен', granted ? '' : 'err');
      return;
    }
    connectFile();
  }

  /* ─────────── боковая панель ─────────── */

  const SIDEBAR_KEY = 'bug-radar:sidebar';
  const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

  function toggleSidebar() {
    if (isNarrow()) { document.body.classList.toggle('nav-open'); return; }
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) { /* приватный режим */ }
    document.getElementById('btnMenu').setAttribute('aria-label', collapsed ? 'Показать боковую панель' : 'Скрыть боковую панель');
  }

  function restoreSidebar() {
    try {
      if (localStorage.getItem(SIDEBAR_KEY) === '1') document.body.classList.add('sidebar-collapsed');
    } catch (e) { /* приватный режим */ }
  }

  function exportJson() {
    const blob = new Blob([Store.serialize()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bug-radar-${Store.toISODate(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        Store.replaceState(Store.parseImport(String(reader.result)));
        view.selection = null;
        closeModals();
        render();
        UI.toast(`Загружено ${Store.incidents().length} инцидентов`);
      } catch (err) {
        UI.toast(err.message || 'Не удалось прочитать файл');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function saveSettings() {
    const val = id => document.getElementById(id);
    const sett = Store.settings();
    const bands = sett.rank.bands.map(b => {
      const input = document.querySelector(`[data-band="${b.id}"]`);
      return Object.assign({}, b, { from: input ? Number(input.value) : b.from });
    }).sort((a, b) => b.from - a.from);

    const sla = Object.assign({}, sett.sla);
    document.querySelectorAll('[data-sla]').forEach(input => {
      const [id, field] = input.dataset.sla.split('.');
      sla[id] = Object.assign({}, sla[id], { [field]: Number(input.value) || 0 });
    });

    const minRaw = val('s-rank-min').value.trim();
    Store.updateSettings({
      jiraBase: val('s-jira').value.trim(),
      rank: {
        enabled: val('s-rank-enabled').checked,
        min: minRaw === '' ? null : Number(minRaw),
        missing: val('s-rank-missing').value,
        bands,
      },
      sla,
      agingDays: Math.max(1, Number(val('s-aging').value) || 7),
      staleDays: Math.max(1, Number(val('s-stale').value) || 5),
    });
    closeModals();
    render();
    UI.toast('Настройки сохранены');
  }

  /* ─────────── импорт ─────────── */

  function analyze(text) {
    const res = Csv.analyze(text, Store.settings().mapping);
    if (!res.ok) { UI.toast(res.error); return; }
    pending = res;
    document.getElementById('import-preview').hidden = false;
    document.getElementById('import-stats').innerHTML = UI.importStats(res, Store.settings());
    document.getElementById('map-grid').innerHTML = UI.mapGrid(res.headers, res.map);
    document.getElementById('btn-do-import').disabled = res.missing.length > 0;
    document.getElementById('btn-do-import').textContent = `Импортировать ${res.count}`;
  }

  function remap(field, value) {
    if (!pending) return;
    pending.map[field] = value === '' ? null : Number(value);
    pending.records = Csv.toRecords(pending.rows, pending.map);
    pending.count = pending.records.length;
    pending.missing = Csv.FIELDS.filter(f => f.required && (pending.map[f.id] === null || pending.map[f.id] === undefined));
    document.getElementById('import-stats').innerHTML = UI.importStats(pending, Store.settings());
    document.getElementById('btn-do-import').disabled = pending.missing.length > 0;
    document.getElementById('btn-do-import').textContent = `Импортировать ${pending.count}`;
  }

  function doImport() {
    if (!pending) return;
    const res = Store.mergeIncidents(pending.records);
    Store.updateSettings({ mapping: Csv.mapToNames(pending.map, pending.headers) });
    pending = null;
    closeModals();
    document.getElementById('import-preview').hidden = true;
    document.getElementById('paste').value = '';
    render();

    const parts = [`Добавлено ${res.added}`, `обновлено ${res.updated}`];
    if (res.missing.length) parts.push(`${res.missing.length} нет в файле — оставлены`);
    UI.toast(parts.join(', '));
  }

  function readFile(file) {
    const reader = new FileReader();
    if (Sheets.isSpreadsheet(file.name)) {
      reader.onload = async () => {
        try {
          const res = await Sheets.toCsv(reader.result);
          analyze(res.csv);
          if (res.sheets > 1) UI.toast(`Взят лист «${res.sheet}» — самый заполненный из ${res.sheets}`);
        } catch (err) {
          UI.toast(err.message || 'Не удалось прочитать таблицу', 'err');
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    reader.onload = () => analyze(String(reader.result));
    reader.readAsText(file, 'utf-8');
  }

  /* ─────────── экспорт ─────────── */

  function exportCsv() {
    const ctx = context();
    const headers = ['Key', 'Rank', 'Summary', 'Created', 'Started', 'Fixed', 'Resolved',
                     'TimeToStart', 'Lifetime', 'Status', 'Assignee'];
    const rows = ctx.tableList.map(i => [
      i.key, i.rank === null ? '' : i.rank, i.summary,
      i.createdAt || '', i.startedAt || '', i.fixedAt || '', i.resolvedAt || '',
      i.timeToStart === null ? '' : Store.fmtDuration(i.timeToStart),
      i.timeToFix === null ? Store.fmtDuration(ctx.cur.refAt - i.createdMs) : Store.fmtDuration(i.timeToFix),
      i.status, i.assignee,
    ]);
    const blob = new Blob(['﻿' + Csv.toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bug-radar-${Store.toISODate(ctx.range.from)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ─────────── события ─────────── */

  function onClick(e) {
    const t = e.target;
    const closest = sel => t.closest(sel);

    if (closest('[data-close]')) { closeModals(); return; }
    if (t.classList.contains('modal')) { closeModals(); return; }

    const tab = closest('[data-tab]');
    if (tab) {
      if (tab.dataset.tab === view.tab) return;
      view.tab = tab.dataset.tab;
      if (view.tab === 'weekly') view.selection = null;
      document.body.classList.remove('nav-open');
      render();
      pushNav();
      return;
    }

    const drillEl = closest('[data-drill]');
    if (drillEl) { drill(drillEl.dataset.drill); return; }

    const mode = closest('[data-mode]');
    if (mode) { setMode(mode.dataset.mode); return; }

    const shift = closest('[data-shift]');
    if (shift) {
      if (shift.dataset.shift === 'today') goToday();
      else shiftPeriod(Number(shift.dataset.shift));
      return;
    }

    const rank = closest('[data-rank]');
    if (rank) { setRank(rank.dataset.rank); return; }

    const flow = closest('[data-flow]');
    if (flow) {
      const idx = Number(flow.dataset.flow);
      shiftPeriod(idx - 7);                        // ряд всегда из 8 периодов, последний — текущий
      return;
    }

    const sortEl = closest('[data-sort]');
    if (sortEl) {
      const field = sortEl.dataset.sort;
      view.sort = view.sort.field === field
        ? { field, dir: view.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'desc' };
      render();
      return;
    }

    const incBtn = closest('.inc[data-key]');
    if (incBtn) {
      const url = Store.issueUrl(incBtn.dataset.key);
      if (url) window.open(url, '_blank', 'noopener');
      else UI.toast('Укажите адрес Jira в настройках — номера станут ссылками');
      return;
    }

    if (t.id === 'clear-selection') { view.selection = null; render(); pushNav(); return; }
    if (closest('#btnBack')) { goBack(); return; }
    if (closest('#btn-import') || t.id === 'btn-import-empty') { openModal('modal-import'); return; }
    if (closest('#btn-settings')) { openSettings(); return; }
    if (t.id === 'btn-save-settings') { saveSettings(); return; }
    if (t.id === 'btn-export') { exportCsv(); return; }
    if (t.id === 'btn-file') { document.getElementById('file').click(); return; }
    if (t.id === 'btn-paste') { analyze(document.getElementById('paste').value); return; }
    if (t.id === 'btn-do-import') { doImport(); return; }
    if (closest('#btnFileSync')) { fileSyncAction(); return; }
    if (closest('#btnMenu')) { toggleSidebar(); return; }
    if (t.id === 'scrim') { document.body.classList.remove('nav-open'); return; }
    if (closest('#btn-export-json')) { exportJson(); return; }
    if (closest('#btn-import-json')) { document.getElementById('file-json').click(); return; }
    if (t.id === 'btn-reset') {
      if (confirm('Удалить все загруженные инциденты и настройки?')) {
        Store.reset(); view.selection = null; closeModals(); render();
      }
      return;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset && t.dataset.field) { remap(t.dataset.field, t.value); return; }
    if (t.id === 'file' && t.files && t.files[0]) { readFile(t.files[0]); return; }
    if (t.id === 'file-json' && t.files && t.files[0]) { importJson(t.files[0]); t.value = ''; return; }
    if (t.id === 'from') { setPeriod({ from: t.value }); return; }
    if (t.id === 'to') { setPeriod({ to: t.value }); return; }
    if (['f-state', 'f-status', 'f-assignee', 'f-type'].includes(t.id)) {
      view.filters[t.id.slice(2)] = t.value;
      render();
      return;
    }
  }

  function onInput(e) {
    if (e.target.id !== 'q') return;
    view.filters.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const next = document.getElementById('q');
    if (next) { next.focus(); next.setSelectionRange(pos, pos); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { closeModals(); return; }
    if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
    if (e.key === '/') {
      e.preventDefault();
      view.tab = 'incidents';
      render();
      const q = document.getElementById('q');
      if (q) q.focus();
    }
    if (e.key === 'i') { openModal('modal-import'); }
    if (e.key === 'b') { toggleSidebar(); }
    if (e.key === 'Backspace') { e.preventDefault(); goBack(); }
  }

  function setupDrop() {
    const drop = document.getElementById('drop');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove('is-over');
    }));
    drop.addEventListener('drop', e => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) readFile(file);
    });
  }

  /* ─────────── старт ─────────── */

  Store.load();
  restoreSidebar();
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPopState);
  try { history.replaceState(snapshot(0), ''); } catch (e) { /* file:// */ }
  setupDrop();
  render();
  FileSync.init(UI.renderFileSync);
})();
