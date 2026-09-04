/* Выгрузка в XLSX/XLS: та же раскладка колонок и те же даты, что из CSV */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadApp } = require('./helpers/load');

// В браузере SheetJS подгружается лениво; в тестах кладём его в глобал заранее
global.XLSX = require(path.join(__dirname, '..', 'js', 'vendor', 'xlsx.full.min.js'));

const HEADERS = ['Issue key', 'Summary', 'Status', 'Created', 'Resolved', 'Custom field (Дата исправления)', 'Custom field (Ранг)', 'Assignee'];

/** Книга с листом инцидентов: даты — настоящие даты Excel, а не строки. */
function workbook(rows, extraSheets = []) {
  const X = global.XLSX;
  const wb = X.utils.book_new();
  extraSheets.forEach(([name, aoa]) => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), name));
  const ws = X.utils.aoa_to_sheet([HEADERS, ...rows], { cellDates: true });
  X.utils.book_append_sheet(wb, ws, 'Incidents');
  return wb;
}

const toBuffer = (wb, bookType) => global.XLSX.write(wb, { type: 'array', bookType, cellDates: true });

test('распознаёт имя файла таблицы, а csv оставляет старому пути', () => {
  const { Sheets } = loadApp();
  assert.equal(Sheets.isSpreadsheet('export.xlsx'), true);
  assert.equal(Sheets.isSpreadsheet('Jira.XLS'), true);
  assert.equal(Sheets.isSpreadsheet('export.csv'), false);
  assert.equal(Sheets.isSpreadsheet(''), false);
});

test('xlsx превращается в csv с теми же колонками и датами в ISO', async () => {
  const app = loadApp();
  const wb = workbook([
    ['SUP-1', 'Не грузится отчёт', 'In Progress', new Date(2026, 7, 24, 9, 12), '', new Date(2026, 7, 26, 18, 2), 78, 'Марат'],
    ['SUP-2', 'Дубли уведомлений', 'Done', new Date(2026, 7, 25, 10, 0), new Date(2026, 7, 27, 12, 30), '', 40, ''],
  ]);
  const res = await app.Sheets.toCsv(toBuffer(wb, 'xlsx'));
  assert.equal(res.sheet, 'Incidents');
  assert.match(res.csv.split('\n')[0], /^Issue key,Summary,Status,Created/);

  const parsed = app.Csv.analyze(res.csv, {});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.missing.length, 0, 'все обязательные колонки нашлись автоматически');

  app.Store.mergeIncidents(parsed.records);
  const one = app.Store.incidents().find(i => i.key === 'SUP-1');
  assert.equal(new Date(one.createdAt).getHours(), 9, 'дата из ячейки Excel пришла тем же местным временем');
  assert.equal(one.rank, 78);
  assert.ok(one.fixedAt, 'дата исправления из xlsx распознана');
  assert.equal(one.isOpen, false);
});

test('xls (BIFF8) читается так же, как xlsx', async () => {
  const app = loadApp();
  const wb = workbook([['SUP-9', 'Оплата не проходит', 'Open', new Date(2026, 7, 20, 8, 0), '', '', 92, 'Аня']]);
  const res = await app.Sheets.toCsv(toBuffer(wb, 'biff8'));
  const parsed = app.Csv.analyze(res.csv, {});
  assert.equal(parsed.count, 1);
  assert.equal(parsed.records[0].key, 'SUP-9');
  assert.equal(String(parsed.records[0].rank), '92');
});

test('из нескольких листов берётся самый заполненный, а не первый', async () => {
  const app = loadApp();
  const wb = workbook(
    [['SUP-1', 'A', 'Open', new Date(2026, 7, 24), '', '', 50, ''], ['SUP-2', 'B', 'Open', new Date(2026, 7, 25), '', '', 50, '']],
    [['Sheet1', [['Пусто']]]],
  );
  const res = await app.Sheets.toCsv(toBuffer(wb, 'xlsx'));
  assert.equal(res.sheet, 'Incidents');
  assert.equal(res.sheets, 2);
});

test('книга без данных — понятная ошибка, а не пустой импорт', async () => {
  const app = loadApp();
  const X = global.XLSX;
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([]), 'Empty');
  await assert.rejects(app.Sheets.toCsv(toBuffer(wb, 'xlsx')), /нет ни одного листа/);
});
