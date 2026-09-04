/* Метрики периода: когорты, backlog на дату, времена, дельты */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, at, seed } = require('./helpers/load');

const NOW = new Date(2026, 8, 3, 12).getTime();          // 3 сентября 2026, 12:00
const week = (app, offset = -1) => app.Store.periodRange({ mode: 'week', offset }, new Date(NOW));

/**
 * Неделя 24–30 августа:
 *   A — пришёл и разобран внутри недели
 *   B — пришёл раньше, разобран внутри недели
 *   C — пришёл внутри недели, всё ещё открыт
 *   D — пришёл и закрыт после недели (для прошлой недели он открыт)
 */
function fixture(app) {
  return seed(app, [
    { key: 'A', created: at(2026, 8, 25, 9), fixed: at(2026, 8, 26, 9), resolved: at(2026, 8, 27, 9), status: 'Done', rank: 90 },
    { key: 'B', created: at(2026, 8, 10, 9), fixed: at(2026, 8, 28, 9), status: 'In Progress', rank: 60 },
    { key: 'C', created: at(2026, 8, 26, 9), status: 'Open', rank: 75, assignee: '' },
    { key: 'D', created: at(2026, 8, 31, 9), resolved: at(2026, 9, 2, 9), status: 'Done', rank: 50 },
  ]);
}

test('счётные метрики считают три разные когорты', () => {
  const app = loadApp();
  const m = app.Metrics.forRange(fixture(app), app.Store.settings(), week(app), NOW);

  assert.equal(m.created, 2, 'A и C созданы на этой неделе');
  assert.equal(m.fixed, 2, 'A и B разблокированы на этой неделе');
  assert.equal(m.closed, 1, 'закрыт в Jira только A');
  assert.equal(m.fixedNotClosed, 1, 'B исправлен, но висит открытым');
  assert.equal(m.netFlow, 0);
  assert.equal(m.flowRatio, 1);
});

test('открытые на конец периода считаются на дату, а не на сейчас', () => {
  const app = loadApp();
  const m = app.Metrics.forRange(fixture(app), app.Store.settings(), week(app), NOW);
  assert.equal(m.openAtEnd, 1, 'на 30 августа открыт только C: D ещё не создан');

  const thisWeek = app.Metrics.forRange(fixture(app), app.Store.settings(), week(app, 0), NOW);
  assert.equal(thisWeek.openAtEnd, 1, 'на текущей неделе D уже закрыт, C всё ещё открыт');
});

test('время жизни считается только по разобранным в периоде', () => {
  const app = loadApp();
  const m = app.Metrics.forRange(fixture(app), app.Store.settings(), week(app), NOW);
  assert.equal(m.ttf.n, 2, 'C открыт и в расчёт не идёт — иначе среднее занижено');
  assert.equal(m.ttf.p50, 24 * 3600e3, 'медиана из 1 дня (A) и 18 дней (B) — ближайший ранг берёт меньшее');
  assert.equal(m.ttf.p85, Date.parse(at(2026, 8, 28, 9)) - Date.parse(at(2026, 8, 10, 9)));
  assert.equal(m.ageOpen.n, 1, 'возраст открытых — отдельная метрика');
});

test('нет дат начала работы — метрика пустая, а не нулевая', () => {
  const app = loadApp();
  const m = app.Metrics.forRange(fixture(app), app.Store.settings(), week(app), NOW);
  assert.equal(m.tts.n, 0);
  assert.equal(m.tts.p50, null, 'нулём это показывать нельзя: данных нет, а не «мгновенно»');
});

test('когорта отвечает, что стало с пришедшим за период', () => {
  const app = loadApp();
  const m = app.Metrics.forRange(fixture(app), app.Store.settings(), week(app), NOW);
  assert.equal(m.cohort.n, 2);
  assert.equal(m.cohort.fixed, 1, 'из A и C разобран только A');
  assert.equal(m.cohort.closed, 1);
  assert.equal(m.cohort.rate, 0.5);
});

test('перцентиль берёт реальное значение, без интерполяции', () => {
  const { Metrics } = loadApp();
  const values = [1, 2, 3, 4, 10];
  assert.equal(Metrics.percentile(values, 0.5), 3);
  assert.equal(Metrics.percentile(values, 0.85), 10);
  assert.equal(Metrics.percentile([], 0.5), null);
  assert.equal(Metrics.stats([]).p50, null);
});

test('дельта различает знак и «хорошо/плохо», мелкие изменения — шум', () => {
  const { Metrics } = loadApp();
  assert.equal(Metrics.delta(14, 11, 'down').tone, 'bad', 'рост притока — плохо');
  assert.equal(Metrics.delta(14, 11, 'up').tone, 'good', 'рост разбора — хорошо');
  assert.equal(Metrics.delta(12, 11, 'down').tone, 'flat', '+1 на недельных числах — шум');
  assert.equal(Metrics.delta(11, 11, 'down').value, 0);
  assert.equal(Metrics.delta(5, null, 'down').value, null);
});

test('просрочка и повестка считаются на конец периода', () => {
  const app = loadApp();
  const sett = app.Store.settings();
  const m = app.Metrics.forRange(fixture(app), sett, week(app), NOW);

  assert.equal(m.overdue, 1, 'C висит открытым 111 часов при SLA высокого ранга 72 часа');
  assert.equal(m.atRisk, 0);
  assert.equal(m.unassigned, 1);

  const rows = app.Metrics.attention(m, sett);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inc.key, 'C');
  assert.deepEqual(rows[0].reasons, ['просрочен', 'без исполнителя']);
});

test('ряд для графика — 8 периодов, последний совпадает с выбранным', () => {
  const app = loadApp();
  const range = week(app);
  const series = app.Metrics.flowSeries(fixture(app), app.Store.settings(), range, 8, NOW);
  assert.equal(series.length, 8);
  assert.equal(series[7].created, 2);
  assert.equal(series[7].openAtEnd, 1);
  assert.equal(series[0].created, 0);
});

test('фильтры и сортировка таблицы', () => {
  const app = loadApp();
  const list = fixture(app);
  const sett = app.Store.settings();

  assert.equal(app.Metrics.filterList(list, { state: 'open' }, sett).length, 1);
  assert.equal(app.Metrics.filterList(list, { q: 'sup' }, sett).length, 0);
  assert.equal(app.Metrics.filterList(list, { band: 'crit' }, sett).length, 1);
  assert.equal(app.Metrics.filterList(list, { assignee: 'Марат' }, sett).length, 3);

  const sorted = app.Metrics.sortList(list, 'rank', 'desc').map(i => i.key);
  assert.deepEqual(sorted, ['A', 'C', 'B', 'D']);
});
