/* Бэкап и автосохранение: подписка на изменения, разбор файла, замена состояния */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, at, seed } = require('./helpers/load');

function filled(app) {
  seed(app, [
    { key: 'SUP-1', created: at(2026, 8, 24), fixed: at(2026, 8, 26), rank: 80 },
    { key: 'SUP-2', created: at(2026, 8, 25), rank: 40 },
  ]);
  return app;
}

test('подписка срабатывает на каждом изменении состояния', () => {
  const app = loadApp();
  let calls = 0;
  const off = app.Store.onChange(() => calls++);

  app.Store.mergeIncidents([{ key: 'A', summary: 'A', created: at(2026, 8, 24) }]);
  assert.equal(calls, 1);

  app.Store.updateSettings({ agingDays: 10 });
  assert.equal(calls, 2, 'настройки — тоже изменение, файл должен догнать');

  off();
  app.Store.updateSettings({ agingDays: 12 });
  assert.equal(calls, 2, 'после отписки не дёргаем');
});

test('serialize и parseImport дают то же состояние', () => {
  const app = filled(loadApp());
  const text = app.Store.serialize();

  const fresh = loadApp();
  const parsed = fresh.Store.parseImport(text);
  fresh.Store.replaceState(parsed);

  assert.equal(fresh.Store.incidents().length, 2);
  assert.equal(fresh.Store.settings().rank.min, 30);
  const inc = fresh.Store.incidents().find(i => i.key === 'SUP-1');
  assert.equal(inc.isOpen, false, 'производные поля пересчитаны после загрузки');
  assert.ok(inc.timeToFix > 0);
});

test('после загрузки бэкапа метрики считаются, а не падают на сырых данных', () => {
  const app = filled(loadApp());
  const text = app.Store.serialize();

  const fresh = loadApp();
  fresh.Store.replaceState(fresh.Store.parseImport(text));
  const range = fresh.Store.periodRange({ mode: 'week', offset: 0 }, new Date(2026, 7, 26));
  const m = fresh.Metrics.forRange(fresh.Store.incidents(), fresh.Store.settings(), range, new Date(2026, 7, 30).getTime());

  assert.equal(m.created, 2);
  assert.equal(m.fixed, 1);
});

test('чужой json не подменяет состояние молча', () => {
  const app = filled(loadApp());
  assert.throws(() => app.Store.parseImport('{"foo":1}'), /бэкап/);
  assert.throws(() => app.Store.parseImport('не json'));
  assert.equal(app.Store.incidents().length, 2, 'состояние не тронуто');
});

test('загрузка бэкапа сама уведомляет подписчиков — файл получит новое состояние', () => {
  const app = filled(loadApp());
  const text = app.Store.serialize();
  let calls = 0;
  app.Store.onChange(() => calls++);
  app.Store.replaceState(app.Store.parseImport(text));
  assert.equal(calls, 1);
});
