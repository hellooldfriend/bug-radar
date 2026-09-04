/* Русская выгрузка Jira: Код / Тема / Метки / Создали / Дата завершения / Время восстановления */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const CSV = [
  'Код;Метки;Тема;Ранг;Создали;Дата завершения;Статус;Время восстановления;Исполнитель',
  'INC-101;billing prod;Оплата не проходит;92;2026-08-24 09:12;2026.08.26 18:02;Готово;2026-08-25 11:40;Марат',
  'INC-102;;Не грузится отчёт;78;2026-08-25 10:00;;Проектирование;;Аня',
  'INC-106;;Кнопка неактивна;70;2026-08-27 15:45;;Готово к проектированию;;Аня',
  'INC-107;prod;Экспорт падает;88;2026-08-28 09:00;2026.08.29 15:30;Готово;2 ч 15 мин;Тимур',
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

test('дата вида YYYY.MM.DD HH:MM читается как местное время', () => {
  const { by } = imported();
  const d = new Date(by('INC-101').resolvedAt);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 7, 26, 18, 2]);
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
