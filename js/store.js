/* ============================================================
   store.js — модель инцидента, настройки, персистентность, периоды.
   Единственный модуль, который знает про localStorage.

   Форма состояния:
   {
     version: 1,
     settings: { ... см. DEFAULT_SETTINGS },
     incidents: [ Incident ],
     importedAt: ISO|null
   }

   Incident — нормализованная запись; из какого источника она приехала
   (CSV или API), остальному приложению не важно.
   ============================================================ */
const Store = (() => {
  'use strict';

  const KEY = 'bug-radar:v1';
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;

  /**
   * Ранговые полосы. from — нижняя граница включительно, полосы идут сверху вниз.
   * Границы редактируются в настройках: у каждой команды своя шкала.
   */
  const DEFAULT_BANDS = [
    { id: 'crit', from: 90, label: 'критический', chip: 'rank-chip--crit', color: 'var(--rank-crit)' },
    { id: 'high', from: 70, label: 'высокий',     chip: 'rank-chip--high', color: 'var(--rank-high)' },
    { id: 'med',  from: 50, label: 'средний',     chip: 'rank-chip--med',  color: 'var(--rank-med)' },
    { id: 'low',  from: 30, label: 'низкий',      chip: 'rank-chip--low',  color: 'var(--rank-low)' },
  ];

  /** SLA в часах: до взятия в работу и до снятия блокера. */
  const DEFAULT_SLA = {
    crit:    { start: 1,  fix: 24 },
    high:    { start: 4,  fix: 72 },
    med:     { start: 24, fix: 168 },
    low:     { start: 48, fix: 336 },
    default: { start: 24, fix: 168 },   // действует, когда ранга нет
  };

  const DEFAULT_SETTINGS = {
    jiraBase: '',                 // https://jira.company.com/browse — номера станут ссылками
    rank: {
      enabled: true,              // false — в проекте ранга нет, работаем без него
      min: 30,                    // порог; null — не фильтруем
      missing: 'exclude',         // exclude | include | only
      bands: DEFAULT_BANDS,
    },
    sla: DEFAULT_SLA,
    agingDays: 7,                 // «висит дольше X дней»
    staleDays: 5,                 // «без движения N дней»
    period: { mode: 'week', offset: -1, from: null, to: null },  // по умолчанию — прошедшая неделя
    mapping: {},                  // поле модели → заголовок колонки CSV, запоминается между импортами
    theme: 'dark',
  };

  /** Статусы, которые означают «в Jira закрыто». Всё остальное — открыто. */
  const DONE_STATUSES = [
    'done', 'closed', 'resolved', 'complete', 'completed', 'cancelled', 'canceled', 'rejected',
    'готово', 'закрыто', 'закрыта', 'выполнено', 'выполнена', 'решено', 'решена', 'отклонено',
    'отклонена', 'отменено', 'отменена',
  ];
  /** Статусы «в работе»: по ним восстанавливается startedAt, когда changelog недоступен. */
  const PROGRESS_STATUSES = [
    'in progress', 'in development', 'development', 'doing', 'review', 'in review', 'code review',
    'testing', 'qa', 'ready to test', 'ready for test', 'deploy', 'release',
    'в работе', 'в процессе', 'разработка', 'ревью', 'на ревью', 'на проверке',
    'тестирование', 'на тестировании', 'деплой', 'релиз', 'выкатка',
  ];

  const MONTHS_GEN = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август',
                      'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MONTH_ABBR_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  let state = null;
  const listeners = [];          // кто хочет знать, что состояние изменилось (автосохранение в файл)

  /* ─────────── персистентность ─────────── */

  function blank() {
    return { version: 1, settings: clone(DEFAULT_SETTINGS), incidents: [], importedAt: null };
  }

  const clone = obj => JSON.parse(JSON.stringify(obj));

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      state = raw ? migrate(JSON.parse(raw)) : blank();
    } catch (e) {
      state = blank();
    }
    return state;
  }

  /** Настройки дополняются значениями по умолчанию: новые поля не ломают старое состояние. */
  function migrate(loaded) {
    const s = blank();
    s.incidents = Array.isArray(loaded.incidents) ? loaded.incidents.map(decorate) : [];
    s.importedAt = loaded.importedAt || null;
    s.settings = deepDefaults(loaded.settings || {}, DEFAULT_SETTINGS);
    return s;
  }

  function deepDefaults(value, defaults) {
    if (Array.isArray(defaults)) return Array.isArray(value) && value.length ? value : clone(defaults);
    if (defaults && typeof defaults === 'object') {
      const out = {};
      Object.keys(defaults).forEach(k => { out[k] = deepDefaults(value ? value[k] : undefined, defaults[k]); });
      Object.keys(value || {}).forEach(k => { if (!(k in out)) out[k] = value[k]; });
      return out;
    }
    // null — осмысленное значение (например, «порог ранга не задан»), подменяем только undefined
    return value === undefined ? clone(defaults) : value;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* приватный режим */ }
    listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });
    return state;
  }

  /** Подписка на любое изменение состояния. Возвращает функцию отписки. */
  function onChange(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /**
   * Разбор бэкапа. Бросает, если это не наш файл: молча подменять состояние
   * содержимым случайного json нельзя.
   */
  function parseImport(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.incidents)) {
      throw new Error('Не похоже на бэкап Bug Radar');
    }
    return migrate(data);
  }

  /** Замена состояния целиком — загрузка бэкапа или файла автосохранения. */
  function replaceState(next) {
    state = migrate(next);
    return save();
  }

  const serialize = () => JSON.stringify(getState(), null, 2);

  const getState = () => state || load();
  const settings = () => getState().settings;
  const incidents = () => getState().incidents;

  function updateSettings(patch) {
    getState().settings = deepDefaults(Object.assign({}, settings(), patch), DEFAULT_SETTINGS);
    return save().settings;
  }

  function reset() { state = blank(); return save(); }

  /* ─────────── даты ─────────── */

  /**
   * Разбор дат во всех формах, в которых их отдаёт Jira:
   *   13/Aug/26 3:04 PM · 13/Aug/2026 15:04 · 2026-08-13T15:04:00+05:00 · 13.08.2026 15:04
   * Возвращает ISO-строку или null. Даты без времени считаются полуднем локального дня:
   * так они не перепрыгивают через границу суток при смене таймзоны.
   */
  function parseDateTime(input) {
    if (!input) return null;
    if (input instanceof Date) return isNaN(input) ? null : input.toISOString();
    const raw = String(input).trim();
    if (!raw) return null;

    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)) {
        const d = new Date(raw);
        return isNaN(d) ? null : d.toISOString();
      }
      return localDate(+m[1], +m[2] - 1, +m[3], m[4] === undefined ? 12 : +m[4], +(m[5] || 0), +(m[6] || 0));
    }

    m = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return localDate(fullYear(+m[3]), +m[2] - 1, +m[1], m[4] === undefined ? 12 : +m[4], +(m[5] || 0), +(m[6] || 0));

    m = raw.match(/^(\d{1,2})[/\-\s]([A-Za-zА-Яа-я]{3,})[/\-\s](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
    if (m) {
      const mon = monthIndex(m[2]);
      if (mon < 0) return null;
      let hour = m[4] === undefined ? 12 : +m[4];
      const ampm = (m[7] || '').toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return localDate(fullYear(+m[3]), mon, +m[1], hour, +(m[5] || 0), +(m[6] || 0));
    }

    const d = new Date(raw);
    return isNaN(d) ? null : d.toISOString();
  }

  function localDate(y, mon, day, h, min, sec) {
    const d = new Date(y, mon, day, h, min, sec, 0);
    return isNaN(d) ? null : d.toISOString();
  }
  const fullYear = y => (y < 100 ? 2000 + y : y);

  function monthIndex(name) {
    const n = String(name).toLowerCase().slice(0, 3);
    let i = MONTH_ABBR_EN.indexOf(n);
    if (i >= 0) return i;
    i = MONTHS_GEN.indexOf(n);
    if (i >= 0) return i;
    return MONTHS_NOM.findIndex(m => m.slice(0, 3) === n);
  }

  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  /** Понедельник недели, в которую попадает дата. */
  const startOfWeek = d => { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; return addDays(x, -dow); };
  const toISODate = d => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const parseISODate = s => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };

  const fmtDay = d => `${new Date(d).getDate()} ${MONTHS_GEN[new Date(d).getMonth()]}`;
  const fmtDayYear = d => `${fmtDay(d)} ${new Date(d).getFullYear()}`;

  /**
   * Длительность в человекочитаемом виде. До суток — часы, дальше дни:
   * на разборе никого не интересует «38.4 часа».
   */
  function fmtDuration(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '—';
    if (ms < 0) ms = 0;
    if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60e3))} мин`;
    if (ms < DAY) return `${round1(ms / HOUR)} ч`;
    return `${round1(ms / DAY)} дн`;
  }
  const round1 = n => Math.round(n * 10) / 10;

  /* ─────────── периоды ─────────── */

  const PERIOD_MODES = [
    { id: 'week',    label: 'Неделя',    days: 7 },
    { id: 'weeks2',  label: '2 недели',  days: 14 },
    { id: 'month',   label: 'Месяц',     days: null },
    { id: 'custom',  label: 'Период',    days: null },
  ];

  /**
   * Границы периода по настройке. offset сдвигает окно назад (−1 — предыдущее).
   * Возвращает { from, to, label, mode, days } — from/to это Date с точными границами суток.
   */
  function periodRange(period, now = new Date()) {
    const p = Object.assign({ mode: 'week', offset: 0 }, period || {});
    if (p.mode === 'custom') {
      const from = parseISODate(p.from) || startOfWeek(now);
      const to = parseISODate(p.to) || addDays(from, 6);
      return finish(from, to, 'custom');
    }
    if (p.mode === 'month') {
      const base = new Date(now.getFullYear(), now.getMonth() + p.offset, 1);
      const from = base;
      const to = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return finish(from, to, 'month');
    }
    const days = p.mode === 'weeks2' ? 14 : 7;
    const anchor = startOfWeek(now);
    const from = addDays(anchor, (days === 14 ? -7 : 0) + p.offset * days);
    return finish(from, addDays(from, days - 1), p.mode);

    function finish(fromD, toD, mode) {
      const from = startOfDay(fromD);
      const to = endOfDay(toD);
      const days = Math.round((endOfDay(toD) - startOfDay(fromD)) / DAY) || 1;
      return { from, to, mode, days, label: periodLabel(from, to, mode) };
    }
  }

  function periodLabel(from, to, mode) {
    if (mode === 'month') {
      const name = MONTHS_NOM[from.getMonth()];
      return `${name[0].toUpperCase()}${name.slice(1)} ${from.getFullYear()}`;
    }
    const sameYear = from.getFullYear() === to.getFullYear();
    const thisYear = from.getFullYear() === new Date().getFullYear();
    const left = fmtDay(from);
    const right = sameYear && thisYear ? fmtDay(to) : fmtDayYear(to);
    return `${left} — ${right}`;
  }

  /** Предыдущий период той же длины, вплотную. Для месяца — предыдущий календарный месяц. */
  function previousRange(range) {
    if (range.mode === 'month') {
      const base = new Date(range.from.getFullYear(), range.from.getMonth() - 1, 1);
      return {
        from: startOfDay(base),
        to: endOfDay(new Date(base.getFullYear(), base.getMonth() + 1, 0)),
        mode: 'month', days: range.days,
        label: periodLabel(base, new Date(base.getFullYear(), base.getMonth() + 1, 0), 'month'),
      };
    }
    const len = range.days;
    const from = startOfDay(addDays(range.from, -len));
    const to = endOfDay(addDays(range.from, -1));
    return { from, to, mode: range.mode, days: len, label: periodLabel(from, to, range.mode) };
  }

  /** N последних периодов того же вида, старые слева. Для графика потока. */
  function seriesRanges(range, count) {
    const out = [];
    let cur = range;
    for (let i = 0; i < count; i++) { out.unshift(cur); cur = previousRange(cur); }
    return out;
  }

  /* ─────────── модель инцидента ─────────── */

  const norm = s => String(s === null || s === undefined ? '' : s).trim();
  const lower = s => norm(s).toLowerCase();

  const isDoneStatus = status => DONE_STATUSES.includes(lower(status));
  const isProgressStatus = status => PROGRESS_STATUSES.includes(lower(status));

  /**
   * Сырая запись из источника → нормализованный инцидент.
   * Всё, что источник не дал, остаётся null: догадки здесь недопустимы,
   * иначе метрика показывает уверенное число там, где данных нет.
   */
  function normalize(raw) {
    const inc = {
      key: norm(raw.key),
      summary: norm(raw.summary),
      type: norm(raw.type),
      status: norm(raw.status),
      resolution: norm(raw.resolution),
      assignee: norm(raw.assignee),
      components: Array.isArray(raw.components) ? raw.components.filter(Boolean)
        : norm(raw.components) ? norm(raw.components).split(/\s*[;,]\s*/).filter(Boolean) : [],
      customer: norm(raw.customer),
      rank: rankValue(raw.rank),
      createdAt: parseDateTime(raw.created),
      startedAt: parseDateTime(raw.started),
      fixedAt: parseDateTime(raw.fixed),
      resolvedAt: parseDateTime(raw.resolved),
      updatedAt: parseDateTime(raw.updated),
      resolvedInferred: false,
    };
    inc.statusCategory = isDoneStatus(inc.status) ? 'done'
      : isProgressStatus(inc.status) ? 'indeterminate' : 'new';

    // Задача закрыта, а даты закрытия в выгрузке нет: берём updated и честно это помечаем.
    if (!inc.resolvedAt && inc.statusCategory === 'done' && inc.updatedAt) {
      inc.resolvedAt = inc.updatedAt;
      inc.resolvedInferred = true;
    }
    // Статус «в работе» без даты старта: точного времени нет, метрика TTS его не получит.
    if (!inc.startedAt && inc.statusCategory !== 'new') inc.startedAt = null;

    return decorate(inc);
  }

  function rankValue(v) {
    if (v === null || v === undefined || v === '') return null;
    const cleaned = String(v).replace(',', '.').replace(/[^\d.\-]/g, '');
    if (!/\d/.test(cleaned)) return null;      // «нет», «—» и прочий текст это отсутствие ранга, а не 0
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  }

  /** Производные поля. Считаются один раз при загрузке и после каждого импорта. */
  function decorate(inc) {
    const created = inc.createdAt ? Date.parse(inc.createdAt) : null;
    const started = inc.startedAt ? Date.parse(inc.startedAt) : null;
    const fixed = inc.fixedAt ? Date.parse(inc.fixedAt) : null;
    const resolved = inc.resolvedAt ? Date.parse(inc.resolvedAt) : null;

    const unblocked = fixed !== null && resolved !== null ? Math.min(fixed, resolved)
      : fixed !== null ? fixed
      : resolved !== null ? resolved : null;

    inc.createdMs = created;
    inc.updatedMs = inc.updatedAt ? Date.parse(inc.updatedAt) : null;
    inc.startedMs = started;
    inc.fixedMs = fixed;
    inc.resolvedMs = resolved;
    inc.unblockedMs = unblocked;
    inc.timeToStart = created !== null && started !== null ? started - created : null;
    inc.timeToFix = created !== null && unblocked !== null ? unblocked - created : null;
    inc.timeToClose = created !== null && resolved !== null ? resolved - created : null;
    inc.isOpen = unblocked === null;
    inc.closedNoDate = inc.statusCategory === 'done' && inc.resolvedInferred;
    return inc;
  }

  const ageOf = (inc, now = Date.now()) => (inc.createdMs === null ? null : now - inc.createdMs);

  /** Полоса ранга. null — ранга нет или полосы отключены. */
  function bandOf(inc, sett = settings()) {
    if (!sett.rank.enabled || inc.rank === null || inc.rank === undefined) return null;
    const bands = sett.rank.bands;
    // Ранг ниже последней границы — всё ещё ранг: такой инцидент относится к нижней
    // полосе, а не к корзине «без ранга», иначе оценённое смешивается с неоценённым.
    return bands.find(b => inc.rank >= b.from) || bands[bands.length - 1] || null;
  }

  /** SLA в миллисекундах для инцидента: по полосе, иначе общий. */
  function slaOf(inc, sett = settings()) {
    const band = bandOf(inc, sett);
    const row = (band && sett.sla[band.id]) || sett.sla.default;
    return { start: row.start * HOUR, fix: row.fix * HOUR };
  }

  const isOverdue = (inc, sett = settings(), now = Date.now()) =>
    inc.isOpen && ageOf(inc, now) > slaOf(inc, sett).fix;
  const isAtRisk = (inc, sett = settings(), now = Date.now()) =>
    inc.isOpen && !isOverdue(inc, sett, now) && ageOf(inc, now) > 0.8 * slaOf(inc, sett).fix;

  /**
   * Фильтр ранга. Возвращает и отобранное, и счётчик инцидентов без ранга:
   * тихо терять часть выборки нельзя, счётчик всегда показан рядом с фильтром.
   */
  function applyRankFilter(list, sett = settings()) {
    const r = sett.rank;
    const noRank = list.filter(i => i.rank === null || i.rank === undefined);
    if (!r.enabled) return { list: list.slice(), noRank: noRank.length, dropped: 0 };
    const kept = list.filter(i => {
      const missing = i.rank === null || i.rank === undefined;
      if (r.missing === 'only') return missing;
      if (missing) return r.missing === 'include';
      return r.min === null || r.min === undefined ? true : i.rank >= r.min;
    });
    return { list: kept, noRank: noRank.length, dropped: list.length - kept.length };
  }

  /* ─────────── импорт ─────────── */

  /**
   * Слияние по номеру: повторная заливка обновляет, а не задваивает.
   * Ничего не удаляет — если инцидент пропал из выгрузки, он остаётся здесь,
   * и об этом сообщает предупреждение.
   */
  function mergeIncidents(records) {
    const st = getState();
    const byKey = new Map(st.incidents.map(i => [i.key, i]));
    let added = 0, updated = 0;

    records.forEach(raw => {
      const inc = normalize(raw);
      if (!inc.key) return;
      const prev = byKey.get(inc.key);
      if (prev) {
        Object.assign(prev, inc);
        decorate(prev);
        updated++;
      } else {
        byKey.set(inc.key, inc);
        added++;
      }
    });

    st.incidents = [...byKey.values()];
    st.importedAt = new Date().toISOString();
    save();

    const missing = st.incidents.filter(i => !records.some(r => norm(r.key) === i.key));
    return {
      added, updated, total: st.incidents.length,
      missing: missing.map(i => i.key),
      noCreated: st.incidents.filter(i => !i.createdAt).length,
      inferredClose: st.incidents.filter(i => i.closedNoDate).length,
    };
  }

  function issueUrl(key, sett = settings()) {
    const base = norm(sett.jiraBase);
    if (!base || !key) return null;
    let url = base.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return `${url}/${key}`;
  }

  return {
    KEY, HOUR, DAY, DEFAULT_SETTINGS, DEFAULT_BANDS, PERIOD_MODES, MONTHS_GEN,
    load, save, reset, getState, settings, incidents, updateSettings,
    onChange, parseImport, replaceState, serialize,
    parseDateTime, startOfDay, endOfDay, addDays, startOfWeek, toISODate, parseISODate,
    fmtDay, fmtDayYear, fmtDuration, round1,
    periodRange, previousRange, seriesRanges, periodLabel,
    normalize, decorate, mergeIncidents, ageOf, bandOf, slaOf, isOverdue, isAtRisk,
    applyRankFilter, isDoneStatus, isProgressStatus, issueUrl,
  };
})();
