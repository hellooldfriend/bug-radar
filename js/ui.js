/* ============================================================
   ui.js — рендер интерфейса. Ничего не считает и не хранит:
   получает готовый контекст от app.js и отдаёт разметку.
   ============================================================ */
const UI = (() => {
  'use strict';

  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const el = id => document.getElementById(id);

  /* ─────────── мелкие форматтеры ─────────── */

  function fmtStamp(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${Store.fmtDay(d)} ${time}`;
  }

  /** Подпись дельты к прошлому периоду — цвет по направлению «хорошо/плохо», не по знаку. */
  function deltaFoot(d, unit) {
    if (!d || d.value === null) return `<div class="metric__foot">нет данных за прошлый период</div>`;
    if (d.value === 0) return `<div class="metric__foot">без изменений к прошлому периоду</div>`;
    const sign = d.value > 0 ? '+' : '−';
    const abs = Math.abs(d.value);
    const text = unit === 'dur' ? Store.fmtDuration(abs) : abs;
    const cls = d.tone === 'good' ? ' is-good' : d.tone === 'bad' ? ' is-bad' : '';
    return `<div class="metric__foot${cls}">${sign}${text} к прошлому периоду</div>`;
  }

  function rankChip(inc, sett) {
    const band = Store.bandOf(inc, sett);
    const cls = band ? band.chip : 'rank-chip--none';
    const val = inc.rank === null || inc.rank === undefined ? '—' : inc.rank;
    return `<span class="tag ${cls}">${esc(val)}</span>`;
  }

  const rowState = (inc, sett, refAt) => {
    if (!inc.isOpen) return '';
    const age = refAt - inc.createdMs;
    const sla = Store.slaOf(inc, sett).fix;
    if (age > sla) return 'crit';
    if (age > 0.8 * sla) return 'warn';
    return '';
  };

  const pctOf = (part, total) => (total > 0 ? (part / total) * 100 : 0);

  /* ─────────── тулбар периода и ранга ─────────── */

  function controls(ctx) {
    const { sett, range, cur } = ctx;
    const p = sett.period;

    const modes = Store.PERIOD_MODES.map(m =>
      `<button data-mode="${m.id}" class="${p.mode === m.id ? 'is-active' : ''}">${m.label}</button>`).join('');

    const nav = p.mode === 'custom'
      ? `<div class="period-nav">
           <button class="icon-btn" data-shift="-1" title="Сдвинуть на длину периода назад">‹</button>
           <input class="input input--sm" type="date" id="from" value="${Store.toISODate(range.from)}" style="width:auto">
           <span class="hint">—</span>
           <input class="input input--sm" type="date" id="to" value="${Store.toISODate(range.to)}" style="width:auto">
           <button class="icon-btn" data-shift="1" title="Сдвинуть вперёд">›</button>
           <span class="pill">${range.days} дн</span>
         </div>`
      : `<div class="period-nav">
           <button class="icon-btn" data-shift="-1" title="Предыдущий период">‹</button>
           <span class="now">${esc(range.label)}</span>
           <button class="icon-btn" data-shift="1" title="Следующий период" ${p.offset >= 0 ? 'disabled' : ''}>›</button>
           ${p.offset !== -1 ? '<button class="btn btn--ghost btn--sm" data-shift="last">Прошлый</button>' : ''}
         </div>`;

    const rankOpts = [30, 50, 70].map(v =>
      `<button data-rank="${v}" class="${sett.rank.enabled && sett.rank.min === v ? 'is-active' : ''}">≥${v}</button>`).join('') +
      `<button data-rank="all" class="${!sett.rank.enabled || sett.rank.min === null ? 'is-active' : ''}">все</button>`;

    const noRank = cur.noRank
      ? `<button class="pill" data-drill="norank" title="Показать инциденты без ранга">без ранга: ${cur.noRank}</button>` : '';
    const warn = cur.closedNoDate
      ? `<span class="pill pill--warn" title="У этих инцидентов нет даты закрытия — взята дата обновления">закрыто без даты: ${cur.closedNoDate}</span>` : '';

    return `
      <div class="toolbar__group"><span class="toolbar__label">Период</span>
        <div class="segmented" id="seg-mode" role="group">${modes}</div>
      </div>
      ${nav}
      <span class="spacer"></span>
      <div class="toolbar__group"><span class="toolbar__label">Ранг</span>
        <div class="segmented" id="seg-rank" role="group">${rankOpts}</div>
      </div>
      ${noRank}${warn}`;
  }

  /* ─────────── экран «Обзор» ─────────── */

  function metric({ drill, dot, title, value, unit, foot, muted }) {
    return `<button class="metric${muted ? ' metric--muted' : ''}"${drill ? ` data-drill="${drill}"` : ''}>
      <div class="metric__head"><span class="dot ${dot}"></span>${esc(title)}</div>
      <div class="metric__value"><b>${value}</b>${unit ? `<span>${esc(unit)}</span>` : ''}</div>
      ${foot}
    </button>`;
  }

  function weekly(ctx) {
    const { sett, cur, prev, series, range } = ctx;
    if (!ctx.all.length) return emptyState();

    const d = (a, b, dir) => deltaFoot(Metrics.delta(a, b, dir));

    const timeMetric = (title, drill, dot, s, p, hint) => {
      if (!s.n) return metric({ dot, title, value: '—', foot: `<div class="metric__foot">${esc(hint)}</div>`, muted: true });
      return metric({
        drill, dot, title,
        value: esc(Store.fmtDuration(s.p50)), unit: 'медиана',
        foot: `<div class="metric__foot">p85 · ${esc(Store.fmtDuration(s.p85))} · ${s.n} шт</div>` +
              deltaFoot(Metrics.delta(s.p50, p.p50, 'down'), 'dur'),
      });
    };

    /* Hero: очередь на конец периода с разбивкой по ранговым полосам */
    const total = cur.openAtEnd;
    const heroStats = cur.openByBand.map(b => `
      <button class="hero__stat" data-drill="band:${b.id}">
        <b><span class="dot" style="background:${b.color}"></span>${b.count}</b>
        <span>${esc(b.label)}</span>
      </button>`).join('');
    const segments = cur.openByBand.filter(b => b.count > 0).map(b =>
      `<span class="progress__seg" style="width:${pctOf(b.count, total)}%;background:${b.color}" title="${esc(b.label)} · ${b.count}"></span>`).join('');
    const openDelta = Metrics.delta(cur.openAtEnd, prev.openAtEnd, 'down');
    const openNote = !openDelta || openDelta.value === null ? '' : openDelta.value === 0 ? 'столько же, сколько в прошлом периоде'
      : `${openDelta.value > 0 ? '+' : '−'}${Math.abs(openDelta.value)} к прошлому периоду`;

    const hero = `
      <section class="hero">
        <div class="hero__top">
          <button class="hero__main" data-drill="open">
            <div class="hero__label">Открыто на конец периода · ${esc(range.label)}</div>
            <div class="hero__value"><span class="hero__pct">${total}</span><span class="hero__unit">${esc(openNote)}</span></div>
          </button>
          <div class="hero__side">${heroStats}</div>
        </div>
        <div class="progress">${segments}</div>
        <div class="progress-legend">
          <span>Просрочено по SLA: <b style="color:var(--text)">${cur.overdue}</b></span>
          <span>На грани: <b style="color:var(--text)">${cur.atRisk}</b></span>
          <span>Без исполнителя: <b style="color:var(--text)">${cur.unassigned}</b></span>
          <span>Без движения ${sett.staleDays} дн: <b style="color:var(--text)">${cur.stale}</b></span>
        </div>
      </section>`;

    /* Метрики: сначала «сколько», потом «как долго» */
    const metrics = `
      <section class="metrics">
        ${metric({ drill: 'created', dot: 'dot--red', title: 'Пришло', value: cur.created, unit: 'за период', foot: d(cur.created, prev.created, 'down') })}
        ${metric({ drill: 'fixed', dot: 'dot--green', title: 'Разобрано', value: cur.fixed, unit: 'блокер снят', foot: d(cur.fixed, prev.fixed, 'up') })}
        ${metric({ drill: 'closed', dot: 'dot--teal', title: 'Закрыто', value: cur.closed, unit: 'в Jira', foot: d(cur.closed, prev.closed, 'up') })}
        ${metric({ drill: 'overdue', dot: 'dot--amber', title: 'Просрочено по SLA', value: cur.overdue, unit: 'открытых', foot: d(cur.overdue, prev.overdue, 'down') })}
        ${timeMetric('До взятия в работу', 'started', 'dot--blue', cur.tts, prev.tts, 'нет дат начала работы в выгрузке')}
        ${timeMetric('До исправления', 'fixed', 'dot--indigo', cur.ttf, prev.ttf, 'в периоде никого не разобрали')}
        ${metric({ drill: 'fixedNotClosed', dot: 'dot--cyan', title: 'Исправлено, не закрыто', value: cur.fixedNotClosed, foot: '<div class="metric__foot">блокер снят у клиента, задача ещё висит</div>' })}
        ${metric({ drill: 'aging', dot: 'dot--muted', title: `Висят дольше ${sett.agingDays} дн`, value: cur.aging, unit: 'открытых', foot: d(cur.aging, prev.aging, 'down') })}
      </section>`;

    const flowNote = range.mode === 'month' ? 'по месяцам'
      : range.mode === 'weeks2' ? 'по две недели'
      : range.mode === 'custom' ? `по ${range.days} дней`
      : 'по неделям';

    const chart = `
      <section class="card chart-card">
        <div class="card__head">
          <div>
            <div class="card__title">Поток инцидентов</div>
            <div class="card__sub">8 периодов ${flowNote} · клик по периоду открывает его, назад — кнопкой в шапке или в браузере</div>
          </div>
        </div>
        <div class="chart-wrap">${Charts.flow(series)}</div>
        <div class="chart-legend">
          <span><i style="background:var(--red)"></i>пришло</span>
          <span><i style="background:var(--green)"></i>разобрано</span>
          <span><i style="background:var(--accent)"></i>в очереди на конец периода · правая шкала</span>
          <span style="margin-left:auto">подсвечен выбранный период</span>
        </div>
      </section>`;

    const ratio = cur.flowRatio === null ? '—' : Store.round1(cur.flowRatio);
    const more = `
      <div class="split">
        <section class="card">
          <div class="card__head">
            <div>
              <div class="card__title">Что пришло за период</div>
              <div class="card__sub">когорта ${cur.cohort.n} шт — как далеко дошли</div>
            </div>
          </div>
          ${Charts.funnel(cur.cohort)}
        </section>
        <section class="card">
          <div class="card__head">
            <div>
              <div class="card__title">Ещё по периоду</div>
              <div class="card__sub">${esc(range.label)}</div>
            </div>
          </div>
          <div class="stat-list">
            <div class="stat-list__row"><span>Приток / разбор</span><b>${ratio}</b></div>
            <div class="stat-list__row"><span>SLA соблюдён</span><b>${cur.slaMet === null ? '—' : Math.round(cur.slaMet * 100) + '%'}</b></div>
            <div class="stat-list__row"><span>Возраст открытых, медиана</span><b>${esc(Store.fmtDuration(cur.ageOpen.p50))}</b></div>
            <div class="stat-list__row"><span>Самый старый открытый</span><b>${esc(Store.fmtDuration(cur.ageOpen.max))}</b></div>
            <div class="stat-list__row"><span>В статистике всего</span><b>${cur.total}</b></div>
          </div>
        </section>
      </div>`;

    const rows = Metrics.attention(cur, sett, 8);
    const all = Metrics.attention(cur, sett).length;
    const attention = rows.length
      ? `<div class="inc-list">${rows.map(r => incRow(r, sett)).join('')}</div>`
      : `<p class="hint">Ничего не требует обсуждения: просроченных нет, исполнители расставлены, всё движется.</p>`;
    const attentionCard = `
      <section class="card">
        <div class="card__head">
          <div>
            <div class="card__title">Требуют обсуждения</div>
            <div class="card__sub">просрочены, без исполнителя или без движения — отсортировано по ранг × возраст</div>
          </div>
          ${all > rows.length ? `<button class="btn btn--ghost btn--sm" data-drill="attention">Все ${all}</button>` : ''}
        </div>
        ${attention}
      </section>`;

    return hero + metrics + chart + more + attentionCard;
  }

  function incRow(row, sett) {
    const inc = row.inc;
    const cls = row.reasons.includes('просрочен') ? ' inc--crit' : row.reasons.includes('на грани') ? ' inc--warn' : '';
    return `<button class="inc${cls}" data-key="${esc(inc.key)}">
      <span class="inc__key">${esc(inc.key)}</span>
      ${rankChip(inc, sett)}
      <span class="inc__age">${esc(Store.fmtDuration(row.age))}</span>
      <span class="inc__sum">${esc(inc.summary)}</span>
      <span class="inc__who">${esc(row.reasons.join(' · '))}${inc.assignee ? ` · ${esc(inc.assignee)}` : ''}</span>
    </button>`;
  }

  function emptyState() {
    return `<div class="empty">
      <div class="empty__art" aria-hidden="true">
        <svg viewBox="0 0 120 80" fill="none">
          <circle cx="60" cy="42" r="30" stroke="currentColor" stroke-width="2" opacity=".35"/>
          <circle cx="60" cy="42" r="18" stroke="currentColor" stroke-width="2" opacity=".25"/>
          <circle cx="60" cy="42" r="4" fill="var(--accent)"/>
          <path d="M60 42l22-22" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>
      <h2>Здесь пока пусто</h2>
      <p>Выгрузите инциденты из Jira: поиск по JQL → Export → Export CSV (current fields) — и загрузите файл сюда. Всё считается локально, в браузере.</p>
      <button class="btn btn--primary" id="btn-import-empty">Загрузить CSV</button>
    </div>`;
  }

  /* ─────────── экран «Инциденты» ─────────── */

  const COLUMNS = [
    { id: 'key',      label: 'Key' },
    { id: 'rank',     label: 'Ранг', num: true },
    { id: 'summary',  label: 'Summary', sort: 'key' },
    { id: 'created',  label: 'Создан' },
    { id: 'started',  label: 'В работе' },
    { id: 'fixed',    label: 'Исправлен' },
    { id: 'resolved', label: 'Закрыт' },
    { id: 'tts',      label: 'До работы', num: true },
    { id: 'life',     label: 'Жизнь', num: true },
    { id: 'status',   label: 'Статус' },
    { id: 'assignee', label: 'Исполнитель' },
  ];

  function incidents(ctx) {
    const { sett, view, tableList, cur } = ctx;
    if (!ctx.all.length) return emptyState();

    const options = (values, selected, none) =>
      [`<option value="">${none}</option>`].concat(values.map(v =>
        `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`)).join('');
    const uniq = key => [...new Set(ctx.rankFiltered.map(i => i[key]).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), 'ru'));

    const selChip = view.selection
      ? `<button class="pill pill--live" id="clear-selection" title="Снять выборку">${esc(view.selection.title)} ✕</button>` : '';

    const head = COLUMNS.map(c => {
      const field = c.sort || c.id;
      const active = view.sort.field === field;
      return `<th data-sort="${field}" class="${c.num ? 'num' : ''}">${esc(c.label)}` +
        (active ? `<span class="sort">${view.sort.dir === 'asc' ? '↑' : '↓'}</span>` : '') + `</th>`;
    }).join('');

    const refAt = cur.refAt;
    const body = tableList.map(inc => {
      const state = rowState(inc, sett, refAt);
      const cls = state === 'crit' ? 'row--overdue' : state === 'warn' ? 'row--risk' : (!inc.isOpen ? 'row--fixed' : '');
      const url = Store.issueUrl(inc.key, sett);
      const keyCell = url ? `<a class="key" href="${esc(url)}" target="_blank" rel="noopener">${esc(inc.key)}</a>`
        : `<span class="key">${esc(inc.key)}</span>`;
      const life = inc.timeToFix !== null ? Store.fmtDuration(inc.timeToFix)
        : `<span title="инцидент ещё открыт">${esc(Store.fmtDuration(refAt - inc.createdMs))}…</span>`;
      return `<tr class="${cls}">
        <td>${keyCell}</td>
        <td class="num">${rankChip(inc, sett)}</td>
        <td class="sum">${esc(inc.summary)}</td>
        <td class="num">${esc(fmtStamp(inc.createdAt))}</td>
        <td class="num">${esc(fmtStamp(inc.startedAt))}</td>
        <td class="num">${esc(fmtStamp(inc.fixedAt))}</td>
        <td class="num">${esc(fmtStamp(inc.resolvedAt))}${inc.resolvedInferred ? ' <span title="дата закрытия взята из «обновлено»">≈</span>' : ''}</td>
        <td class="num">${esc(inc.timeToStart === null ? '—' : Store.fmtDuration(inc.timeToStart))}</td>
        <td class="num">${life}</td>
        <td>${esc(inc.status)}</td>
        <td>${esc(inc.assignee || '—')}</td>
      </tr>`;
    }).join('');

    return `
      <div class="toolbar" style="margin-bottom:14px">
        <div class="search">
          <svg class="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <input type="text" id="q" placeholder="Поиск по номеру, названию, исполнителю" value="${esc(view.filters.q || '')}">
        </div>
        <select class="input input--sm" id="f-state" style="width:auto">${options(['open', 'fixed'], view.filters.state, 'Открытые и разобранные')}</select>
        <select class="input input--sm" id="f-status" style="width:auto">${options(uniq('status'), view.filters.status, 'Любой статус')}</select>
        <select class="input input--sm" id="f-assignee" style="width:auto">${options(uniq('assignee'), view.filters.assignee, 'Любой исполнитель')}</select>
        <select class="input input--sm" id="f-type" style="width:auto">${options(uniq('type'), view.filters.type, 'Любой тип')}</select>
        ${selChip}
        <span class="spacer"></span>
        <span class="pill">${tableList.length} шт</span>
        <button class="btn btn--ghost btn--sm" id="btn-export">Экспорт CSV</button>
      </div>
      <div class="table-wrap">
        <table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      </div>`;
  }

  /* ─────────── настройки ─────────── */

  function settingsForm(sett) {
    const band = id => sett.rank.bands.find(b => b.id === id) || { from: 0 };
    const sla = id => sett.sla[id] || { start: 0, fix: 0 };
    const slaRow = (id, label) => `
      <div class="sla-row"><span>${label}</span>
        <input class="input input--mini" type="number" min="0" step="1" data-sla="${id}.start" value="${sla(id).start}">
        <input class="input input--mini" type="number" min="0" step="1" data-sla="${id}.fix" value="${sla(id).fix}">
      </div>`;

    return `
      <fieldset class="full"><legend>Jira</legend>
        <label class="field"><span class="field__label">Адрес для ссылок на задачи</span>
          <input class="input" type="text" id="s-jira" placeholder="jira.company.com/browse" value="${esc(sett.jiraBase)}"></label>
      </fieldset>

      <fieldset><legend>Ранг</legend>
        <label class="check">
          <input type="checkbox" id="s-rank-enabled" ${sett.rank.enabled ? 'checked' : ''}>
          <span>Ранг используется</span></label>
        <label class="field"><span class="field__label">Минимальный ранг в статистике</span>
          <input class="input" type="number" id="s-rank-min" value="${sett.rank.min === null ? '' : sett.rank.min}" placeholder="не фильтровать"></label>
        <label class="field"><span class="field__label">Инциденты без ранга</span>
          <select class="input" id="s-rank-missing">
            <option value="exclude"${sett.rank.missing === 'exclude' ? ' selected' : ''}>не учитывать</option>
            <option value="include"${sett.rank.missing === 'include' ? ' selected' : ''}>учитывать</option>
            <option value="only"${sett.rank.missing === 'only' ? ' selected' : ''}>только они</option>
          </select></label>
        <div class="field"><span class="field__label">Границы полос <em>— критический / высокий / средний / низкий</em></span>
          <div class="four">
            <input class="input input--sm" type="number" data-band="crit" value="${band('crit').from}" title="критический от">
            <input class="input input--sm" type="number" data-band="high" value="${band('high').from}" title="высокий от">
            <input class="input input--sm" type="number" data-band="med" value="${band('med').from}" title="средний от">
            <input class="input input--sm" type="number" data-band="low" value="${band('low').from}" title="низкий от">
          </div>
        </div>
      </fieldset>

      <fieldset><legend>SLA в часах · до работы / до исправления</legend>
        ${slaRow('crit', 'критический')}
        ${slaRow('high', 'высокий')}
        ${slaRow('med', 'средний')}
        ${slaRow('low', 'низкий')}
        ${slaRow('default', 'без ранга')}
      </fieldset>

      <fieldset class="full"><legend>Пороги</legend>
        <div class="two">
          <label class="field"><span class="field__label">«висит дольше», дней</span>
            <input class="input" type="number" id="s-aging" min="1" value="${sett.agingDays}"></label>
          <label class="field"><span class="field__label">«без движения», дней</span>
            <input class="input" type="number" id="s-stale" min="1" value="${sett.staleDays}"></label>
        </div>
      </fieldset>`;
  }

  /* ─────────── автосохранение в сайдбаре ─────────── */

  const FILE_SYNC_LABELS = {
    off: 'Автосохранение в файл',
    on: 'Автосохранение включено',
    'needs-permission': 'Разрешить доступ к файлу',
    error: 'Ошибка записи — повторить',
  };

  function renderFileSync(state) {
    const block = el('fileSync');
    block.hidden = !state.supported;
    // Где API нет, честно оставляем прежнюю подсказку про экспорт
    el('storageHint').hidden = state.supported && state.status === 'on';
    if (!state.supported) return;

    block.className = `filesync filesync--${state.status}`;
    el('fileSyncLabel').textContent = FILE_SYNC_LABELS[state.status];
    el('fileSyncHint').innerHTML = {
      off: 'Состояние будет писаться в файл на диске. Положите его в синхронизируемую папку — получите доступ с других машин.',
      on: `Пишем в <span class="filesync__name">${esc(state.fileName)}</span>`,
      'needs-permission': `Браузер просит подтвердить доступ к <span class="filesync__name">${esc(state.fileName)}</span> после перезагрузки`,
      error: 'Последняя запись не удалась: файл переместили, удалили или отозвали доступ',
    }[state.status];
  }

  /* ─────────── раскладка колонок при импорте ─────────── */

  function mapGrid(headers, map) {
    return Csv.FIELDS.map(f => {
      const opts = [`<option value="">— нет —</option>`].concat(headers.map((h, i) =>
        `<option value="${i}"${map[f.id] === i ? ' selected' : ''}>${esc(h)}</option>`)).join('');
      return `<div class="map-row">
        <span class="map-row__label">${esc(f.label)}${f.required ? ' *' : ''}${f.hint ? `<i>${esc(f.hint)}</i>` : ''}</span>
        <select class="input input--sm" data-field="${f.id}">${opts}</select>
      </div>`;
    }).join('');
  }

  function importStats(res) {
    const parts = [`строк: <b>${res.count}</b>`];
    parts.push(`с датой исправления: <b>${res.records.filter(r => r.fixed).length}</b>`);
    parts.push(`с датой начала работы: <b>${res.records.filter(r => r.started).length}</b>`);
    parts.push(`с рангом: <b>${res.records.filter(r => r.rank !== '').length}</b>`);
    if (res.missing.length) parts.push(`<span style="color:#f87171">не найдено: ${res.missing.map(f => f.label).join(', ')}</span>`);
    return parts.map(p => `<span>${p}</span>`).join('');
  }

  /* ─────────── тосты ─────────── */

  function toast(text, kind) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.innerHTML = `<span class="toast__dot"${kind === 'err' ? ' style="background:var(--red)"' : ''}></span><span></span>`;
    node.lastChild.textContent = text;
    el('toasts').appendChild(node);
    setTimeout(() => { node.classList.add('is-out'); setTimeout(() => node.remove(), 220); }, 2600);
  }

  /* ─────────── сборка экрана ─────────── */

  function render(ctx) {
    const { view, cur, range } = ctx;
    const isWeekly = view.tab === 'weekly';

    el('view-weekly').hidden = !isWeekly;
    el('view-incidents').hidden = isWeekly;
    el('controls').innerHTML = isWeekly ? controls(ctx) : '';
    el('controls-incidents').innerHTML = isWeekly ? '' : controls(ctx);
    el('weeklyBody').innerHTML = isWeekly ? weekly(ctx) : '';
    el('incidentsBody').innerHTML = isWeekly ? '' : incidents(ctx);

    document.querySelectorAll('.nav__item').forEach(n =>
      n.classList.toggle('is-active', n.dataset.tab === view.tab));
    el('btnBack').hidden = !ctx.canGoBack;

    el('topbarTitle').textContent = isWeekly ? 'Обзор' : (view.selection ? view.selection.title : 'Инциденты');
    el('topbarMeta').innerHTML = ctx.all.length
      ? `<span>${esc(range.label)}</span><span class="pill">${cur.total} в статистике</span>` +
        (ctx.importedAt ? `<span>загружено ${esc(fmtStamp(ctx.importedAt))}</span>` : '')
      : '<span>данных пока нет</span>';

    el('datasum').innerHTML = ctx.all.length
      ? `<span class="datasum__num">${ctx.all.length}</span>
         <span class="datasum__sub">инцидентов · ${cur.total} в статистике${ctx.importedAt ? `<br>загружено ${esc(fmtStamp(ctx.importedAt))}` : ''}</span>`
      : `<span class="datasum__num">0</span><span class="datasum__sub">инцидентов пока нет</span>`;
  }

  return { render, settingsForm, renderFileSync, mapGrid, importStats, toast, esc, fmtStamp, COLUMNS };
})();
