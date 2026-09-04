/* Фильтр ранга: порог, три режима для инцидентов без ранга, работа без ранга вообще */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, at, seed } = require('./helpers/load');

function sample(app) {
  return seed(app, [
    { key: 'R-90', rank: 90, created: at(2026, 8, 24) },
    { key: 'R-50', rank: 50, created: at(2026, 8, 24) },
    { key: 'R-20', rank: 20, created: at(2026, 8, 24) },
    { key: 'R-NO', rank: '', created: at(2026, 8, 24) },
  ]);
}
const keys = res => res.list.map(i => i.key).sort();

test('порог 30 отсекает низкий ранг, инциденты без ранга по умолчанию не в статистике', () => {
  const app = loadApp();
  const res = app.Store.applyRankFilter(sample(app), app.Store.settings());
  assert.deepEqual(keys(res), ['R-50', 'R-90']);
  assert.equal(res.noRank, 1, 'счётчик без ранга показывается всегда, что бы ни было выбрано');
  assert.equal(res.dropped, 2);
});

test('режим include возвращает инциденты без ранга в статистику', () => {
  const app = loadApp();
  const sett = app.Store.updateSettings({ rank: Object.assign({}, app.Store.settings().rank, { missing: 'include' }) });
  assert.deepEqual(keys(app.Store.applyRankFilter(sample(app), sett)), ['R-50', 'R-90', 'R-NO']);
});

test('режим only оставляет только неоценённые — чтобы проставить им ранг', () => {
  const app = loadApp();
  const sett = app.Store.updateSettings({ rank: Object.assign({}, app.Store.settings().rank, { missing: 'only' }) });
  assert.deepEqual(keys(app.Store.applyRankFilter(sample(app), sett)), ['R-NO']);
});

test('порог настраивается, null означает «не фильтровать»', () => {
  const app = loadApp();
  const high = app.Store.updateSettings({ rank: Object.assign({}, app.Store.settings().rank, { min: 70 }) });
  assert.deepEqual(keys(app.Store.applyRankFilter(sample(app), high)), ['R-90']);

  const all = app.Store.updateSettings({ rank: Object.assign({}, app.Store.settings().rank, { min: null, missing: 'include' }) });
  assert.equal(app.Store.applyRankFilter(sample(app), all).list.length, 4);
});

test('без ранга вообще: фильтр пропускает всех, полос нет, действует общий SLA', () => {
  const app = loadApp();
  const sett = app.Store.updateSettings({ rank: Object.assign({}, app.Store.settings().rank, { enabled: false }) });
  const list = sample(app);

  const res = app.Store.applyRankFilter(list, sett);
  assert.equal(res.list.length, 4, 'ранг не должен быть условием запуска сервиса');
  assert.equal(res.dropped, 0);
  assert.equal(app.Store.bandOf(list[0], sett), null);
  assert.equal(app.Store.slaOf(list[0], sett).fix, sett.sla.default.fix * app.Store.HOUR);

  const m = app.Metrics.forRange(list, sett, app.Store.periodRange({ mode: 'week', offset: 0 }, new Date(2026, 7, 26)));
  assert.equal(m.openByBand.length, 1);
  assert.equal(m.openByBand[0].label, 'все инциденты');
  assert.equal(m.openByBand[0].count, 4);
});

test('полосы считают только свой диапазон, «без ранга» — отдельная корзина', () => {
  const app = loadApp();
  const sett = app.Store.updateSettings({ rank: Object.assign({}, app.Store.settings().rank, { missing: 'include', min: null }) });
  const m = app.Metrics.forRange(sample(app), sett, app.Store.periodRange({ mode: 'week', offset: 0 }, new Date(2026, 7, 26)));
  const byId = Object.fromEntries(m.openByBand.map(b => [b.id, b]));
  assert.equal(byId.crit.count, 1);
  assert.equal(byId.crit.label, '90+');
  assert.equal(byId.med.count, 1);
  assert.equal(byId.med.label, '50–69');
  assert.equal(byId.low.count, 1, 'ранг 20 ниже последней границы, но это оценённый инцидент — он в нижней полосе');
  assert.equal(byId.none.count, 1);
});
