/* Русская выгрузка Jira: Код / Тема / Метки / Создали / Дата завершения / Время восстановления */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const CSV = [
  'Код;Метки;Тема;Ранг;Создали;Дата завершения;Статус;Время восстановления;Исполнитель',
  'INC-101;billing prod;Оплата не проходит;92;2026-08-24 09:12;26.08.2026 18:02;Готово;2026-08-25 11:40;Марат',
  'INC-102;;Не грузится отчёт;78;2026-08-25 10:00;;Проектирование;;Аня',
  'INC-106;;Кнопка неактивна;70;2026-08-27 15:45;;Готово к проектированию;;Аня',
  'INC-107;prod;Экспорт падает;88;2026-08-28 09:00;29.08.2026 15:30;Готово;2 ч 15 мин;Тимур',
  'INC-108;;Без ранга;;2026-08-28 11:00;;Ожидает разработки;;',
].join('\n');

function imported() {
  const app = loadApp();
  const res = app.Csv.analyze(CSV, {});
  assert.equal(res.ok, true);
  assert.equal(res.missing.length, 0, 'обязательные колонки узнаны по русским заголовкам');
  app.Store.mergeIncidents(res.records);
  const by = key => app.Store.incidents().find(i => i.key === key);
  return { app, res, by };
}

test('колонки раскладываются сами: Код, Тема, Создали, Дата завершения, Время восстановления, Метки', () => {
  const { res } = imported();
  const names = res.headers;
  assert.equal(names[res.map.key], 'Код');
  assert.equal(names[res.map.summary], 'Тема');
  assert.equal(names[res.map.created], 'Создали');
  assert.equal(names[res.map.resolved], 'Дата завершения');
  assert.equal(names[res.map.fixed], 'Время восстановления');
  assert.equal(names[res.map.labels], 'Метки');
  assert.equal(names[res.map.rank], 'Ранг');
});

test('«Создали» 2026-08-13 11:20 и «Дата завершения» 11.08.2026 13:37 — оба как местное время', () => {
  const { app } = imported();
  const parts = iso => { const d = new Date(iso); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };
  assert.deepEqual(parts(app.Store.parseDateTime('2026-08-13 11:20')), [2026, 8, 13, 11, 20]);
  assert.deepEqual(parts(app.Store.parseDateTime('11.08.2026 13:37')), [2026, 8, 11, 13, 37], 'день идёт первым, а не месяц');
  assert.deepEqual(parts(app.Store.parseDateTime('2026.08.26 18:02')), [2026, 8, 26, 18, 2], 'год впереди с точками — тоже понимаем');
  assert.deepEqual(parts(app.Store.parseDateTime('01.12.2026 09:05')), [2026, 12, 1, 9, 5]);
});

test('дата завершения из выгрузки попадает в закрытие с тем же временем', () => {
  const { by } = imported();
  const d = new Date(by('INC-101').resolvedAt);
  assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [26, 18, 2]);
});

test('«Время восстановления» — дата: она и есть дата исправления', () => {
  const { by } = imported();
  const inc = by('INC-101');
  assert.equal(new Date(inc.fixedAt).getHours(), 11);
  assert.equal(inc.isOpen, false);
  assert.ok(inc.timeToFix < inc.timeToClose, 'блокер снят раньше, чем задача закрыта');
});

test('«Время восстановления» — длительность: считается от даты создания', () => {
  const { by, app } = imported();
  const inc = by('INC-107');
  const fixed = new Date(inc.fixedAt);
  assert.deepEqual([fixed.getDate(), fixed.getHours(), fixed.getMinutes()], [28, 11, 15], '09:00 + 2 ч 15 мин');
  assert.equal(app.Store.parseDuration('1d 4h 30m'), (28 * 3600 + 30 * 60) * 1e3);
  assert.equal(app.Store.parseDuration('02:15'), 2.25 * 3600e3);
  assert.equal(app.Store.parseDuration('3 дн'), 3 * 24 * 3600e3);
  assert.equal(app.Store.parseDuration('15'), null, 'голое число — не длительность, единицу не угадываем');
  assert.equal(app.Store.parseDuration('2 попугая'), null);
});

test('«Готово к проектированию» — не закрыто, «Готово» — закрыто', () => {
  const { by } = imported();
  assert.equal(by('INC-106').statusCategory, 'new');
  assert.equal(by('INC-106').isOpen, true);
  assert.equal(by('INC-101').statusCategory, 'done');
  assert.equal(by('INC-102').statusCategory, 'indeterminate', 'Проектирование — в работе');
});

test('метки разбираются в массив, пустые — в пустой', () => {
  const { by } = imported();
  assert.deepEqual(by('INC-101').labels, ['billing', 'prod']);
  assert.deepEqual(by('INC-102').labels, []);
});

test('закрыто без даты закрытия: берётся дата исправления, а не только «обновлено»', () => {
  const app = loadApp();
  app.Store.mergeIncidents([{ key: 'X-1', summary: 'x', created: '2026-08-24 09:00', fixed: '2026-08-25 09:00', status: 'Готово' }]);
  const inc = app.Store.incidents()[0];
  assert.equal(inc.resolvedInferred, true);
  assert.equal(new Date(inc.resolvedAt).getDate(), 25);
});

test('дата завершения раньше создания: закрыто, но в метрики времени не попадает', () => {
  const app = loadApp();
  app.Store.mergeIncidents([
    { key: 'INC-109', summary: 'Пример из письма', created: '2026-08-13 11:20', resolved: '11.08.2026 13:37', status: 'Готово', rank: 55 },
    { key: 'INC-110', summary: 'Нормальный', created: '2026-08-13 11:20', resolved: '14.08.2026 13:37', status: 'Готово', rank: 55 },
  ]);
  const bad = app.Store.incidents().find(i => i.key === 'INC-109');
  assert.equal(bad.isOpen, false, 'по статусу и дате это закрытый инцидент');
  assert.equal(bad.datesInconsistent, true);
  assert.equal(bad.timeToClose, null, 'отрицательный интервал не считается');
  assert.equal(bad.timeToFix, null);

  const range = app.Store.periodRange({ mode: 'week', offset: 0 }, new Date(2026, 7, 12));
  const m = app.Metrics.forRange(app.Store.incidents(), app.Store.settings(), range, new Date(2026, 7, 16).getTime());
  assert.equal(m.closed, 2, 'оба закрыты в периоде');
  assert.equal(m.ttc.n, 1, 'но время закрытия посчитано только по одному');
  assert.ok(m.ttc.p50 > 0);
});
