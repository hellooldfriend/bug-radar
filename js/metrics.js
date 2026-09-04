/* ============================================================
   metrics.js — весь счёт в одном месте. Чистые функции:
   ничего не рендерят и не трогают хранилище.

   Общее правило: время жизни считается только по завершённым инцидентам,
   возраст открытых — отдельная метрика. Смешивать их нельзя: чем дольше
   живёт инцидент, тем меньше шансов, что он уже попал в среднее.
   ============================================================ */
const Metrics = (() => {
  'use strict';

  const DAY = 24 * 3600e3;

  /** Перцентиль методом ближайшего ранга: результат всегда совпадает с реальным инцидентом. */
  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return null;
    const idx = Math.ceil(p * sortedAsc.length) - 1;
    return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
  }

  /** Сводка по набору длительностей. Медиана — главное число, среднее — справочное. */
  function stats(values) {
    const clean = values.filter(v => v !== null && v !== undefined && !isNaN(v)).sort((a, b) => a - b);
    if (!clean.length) return { n: 0, p50: null, p85: null, avg: null, max: null };
    const sum = clean.reduce((a, b) => a + b, 0);
    return {
      n: clean.length,
      p50: percentile(clean, 0.5),
      p85: percentile(clean, 0.85),
      avg: Math.round(sum / clean.length),
      max: clean[clean.length - 1],
    };
  }

  const inRange = (ms, range) =>
    ms !== null && ms !== undefined && ms >= range.from.getTime() && ms <= range.to.getTime();

  /**
   * Полный набор метрик периода.
   *
   * Всё, что зависит от «сейчас» — возраст, просрочка, застой — считается
   * на момент refAt = конец периода, но не позже текущего времени. Поэтому
   * прошлая неделя показывает то, что было тогда, а не то, что стало сейчас.
   */
  function forRange(all, sett, range, now = Date.now()) {
    const filtered = Store.applyRankFilter(all, sett);
    const list = filtered.list;
    const to = range.to.getTime();
    const refAt = Math.min(to, now);

    const created = list.filter(i => inRange(i.createdMs, range));
    const fixed = list.filter(i => inRange(i.unblockedMs, range));
    const closed = list.filter(i => inRange(i.resolvedMs, range));
    const fixedNotClosed = list.filter(i => inRange(i.fixedMs, range) && i.resolvedMs === null);

    // Открытые на конец периода: созданы не позже конца и не разблокированы к этому моменту.
    // Считается по всей выборке, а не по инцидентам периода — иначе backlog врёт.
    const open = list.filter(i =>
      i.createdMs !== null && i.createdMs <= to && (i.unblockedMs === null || i.unblockedMs > to));

    const ageAt = inc => (inc.createdMs === null ? null : refAt - inc.createdMs);
    const slaFix = inc => Store.slaOf(inc, sett).fix;
    const overdue = open.filter(i => ageAt(i) > slaFix(i));
    const atRisk = open.filter(i => ageAt(i) <= slaFix(i) && ageAt(i) > 0.8 * slaFix(i));
    const aging = open.filter(i => ageAt(i) > sett.agingDays * DAY);
    const stale = open.filter(i => i.updatedMs !== null && refAt - i.updatedMs > sett.staleDays * DAY);
    const unassigned = open.filter(i => !i.assignee);

    const openByBand = bandBuckets(open, sett);

    const cohort = {
      n: created.length,
      started: created.filter(i => i.startedMs !== null).length,
      fixed: created.filter(i => i.unblockedMs !== null).length,
      closed: created.filter(i => i.resolvedMs !== null).length,
    };
    cohort.rate = cohort.n ? cohort.fixed / cohort.n : null;

    return {
      range, refAt,
      total: list.length,
      noRank: filtered.noRank,
      droppedByRank: filtered.dropped,

      created: created.length,
      fixed: fixed.length,
      closed: closed.length,
      fixedNotClosed: fixedNotClosed.length,
      netFlow: created.length - fixed.length,
      flowRatio: created.length ? fixed.length / created.length : null,

      openAtEnd: open.length,
      openByBand,
      aging: aging.length,
      overdue: overdue.length,
      atRisk: atRisk.length,
      stale: stale.length,
      unassigned: unassigned.length,

      // время до взятия в работу считается по инцидентам, начатым в периоде
      tts: stats(list.filter(i => inRange(i.startedMs, range)).map(i => i.timeToStart)),
      ttf: stats(fixed.map(i => i.timeToFix)),
      ttc: stats(closed.map(i => i.timeToClose)),
      ageOpen: stats(open.map(ageAt)),
      slaMet: fixed.length
        ? fixed.filter(i => i.timeToFix !== null && i.timeToFix <= slaFix(i)).length / fixed.length
        : null,
      closedNoDate: list.filter(i => i.closedNoDate).length,

      cohort,
      lists: { created, fixed, closed, fixedNotClosed, open, overdue, atRisk, aging, stale, unassigned },
    };
  }

  /** Разбивка по ранговым полосам плюс отдельная корзина «без ранга». */
  function bandBuckets(list, sett) {
    const out = [];
    if (sett.rank.enabled) {
      sett.rank.bands.forEach(b => {
        const items = list.filter(i => Store.bandOf(i, sett) === b);
        out.push({ id: b.id, label: rangeLabel(b, sett.rank.bands), color: b.color, chip: b.chip, count: items.length, items });
      });
    }
    const none = list.filter(i => i.rank === null || i.rank === undefined);
    if (none.length || !sett.rank.enabled) {
      out.push({ id: 'none', label: sett.rank.enabled ? 'без ранга' : 'все инциденты',
        color: 'var(--ink-3)', chip: 'rank-chip--none',
        count: sett.rank.enabled ? none.length : list.length,
        items: sett.rank.enabled ? none : list });
    }
    return out;
  }

  function rangeLabel(band, bands) {
    const above = bands.filter(b => b.from > band.from).sort((a, b) => a.from - b.from)[0];
    return above ? `${band.from}–${above.from - 1}` : `${band.from}+`;
  }

  /**
   * Дельта к предыдущему периоду. Знак и «хорошо/плохо» — разные вещи:
   * рост притока плохо, рост разбора хорошо. Мелкие изменения помечены
   * как шум, чтобы «+1» не подсвечивалось красным на недельных числах.
   */
  function delta(current, previous, goodDirection) {
    if (current === null || previous === null || current === undefined || previous === undefined) {
      return { value: null, pct: null, tone: 'flat', noise: true };
    }
    const value = current - previous;
    const pct = previous > 0 ? value / previous : null;
    const noise = Math.abs(value) < 2 || (pct !== null && Math.abs(pct) < 0.05);
    const good = goodDirection === 'up' ? value > 0 : value < 0;
    return { value, pct, noise, tone: value === 0 || noise ? 'flat' : (good ? 'good' : 'bad') };
  }

  /** Метрики предыдущего периода той же длины. */
  function compare(all, sett, range, now = Date.now()) {
    return forRange(all, sett, Store.previousRange(range), now);
  }

  /**
   * Ряд для графика потока: N последних периодов того же вида.
   * Каждая точка — приток, разбор и backlog на конец периода.
   */
  function flowSeries(all, sett, range, count = 8, now = Date.now()) {
    return Store.seriesRanges(range, count).map(r => {
      const m = forRange(all, sett, r, now);
      return { range: r, label: shortLabel(r), created: m.created, fixed: m.fixed, openAtEnd: m.openAtEnd };
    });
  }

  function shortLabel(range) {
    if (range.mode === 'month') return `${Store.MONTHS_GEN[range.from.getMonth()]}`;
    return Store.fmtDay(range.from);
  }

  /**
   * Повестка встречи: открытые, которые нельзя не обсудить.
   * Причина у каждого своя, сортировка — по «стоимости» ранг × возраст;
   * без ранга вес считается средним, чтобы такие инциденты не тонули.
   */
  function attention(metrics, sett, limit = 0) {
    const refAt = metrics.refAt;
    const rows = metrics.lists.open.map(inc => {
      const age = refAt - inc.createdMs;
      const sla = Store.slaOf(inc, sett).fix;
      const reasons = [];
      if (age > sla) reasons.push('просрочен');
      else if (age > 0.8 * sla) reasons.push('на грани');
      if (!inc.assignee) reasons.push('без исполнителя');
      if (inc.updatedMs !== null && refAt - inc.updatedMs > sett.staleDays * DAY) reasons.push('без движения');
      return { inc, age, reasons, cost: (inc.rank === null || inc.rank === undefined ? 50 : inc.rank) * age };
    }).filter(r => r.reasons.length)
      .sort((a, b) => b.cost - a.cost);
    return limit ? rows.slice(0, limit) : rows;
  }

  /** Фильтры таблицы. Пустое значение — фильтр не применяется. */
  function filterList(list, f, sett) {
    const q = String(f.q || '').trim().toLowerCase();
    return list.filter(inc => {
      if (f.status && inc.status !== f.status) return false;
      if (f.assignee && (inc.assignee || '—') !== f.assignee) return false;
      if (f.type && inc.type !== f.type) return false;
      if (f.band) {
        const b = Store.bandOf(inc, sett);
        if (f.band === 'none' ? b !== null : (!b || b.id !== f.band)) return false;
      }
      if (f.state === 'open' && !inc.isOpen) return false;
      if (f.state === 'fixed' && inc.isOpen) return false;
      if (q && !(`${inc.key} ${inc.summary} ${inc.assignee}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  const SORTERS = {
    key: i => i.key,
    rank: i => (i.rank === null || i.rank === undefined ? -1 : i.rank),
    created: i => i.createdMs || 0,
    started: i => i.startedMs || 0,
    fixed: i => i.fixedMs || 0,
    resolved: i => i.resolvedMs || 0,
    tts: i => (i.timeToStart === null ? -1 : i.timeToStart),
    life: i => (i.timeToFix === null ? Date.now() - (i.createdMs || Date.now()) : i.timeToFix),
    status: i => i.status,
    assignee: i => i.assignee || '',
  };

  function sortList(list, field, dir) {
    const get = SORTERS[field] || SORTERS.created;
    const k = dir === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y), 'ru') * k;
      return (x - y) * k;
    });
  }

  return { percentile, stats, forRange, compare, delta, flowSeries, attention, filterList, sortList, bandBuckets, inRange };
})();
