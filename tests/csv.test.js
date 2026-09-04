/* Разбор выгрузки Jira: кавычки, разделители, автораскладка колонок */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const JIRA = [
  'Issue key,Summary,Issue Type,Status,Assignee,Created,Resolved,Custom field (Дата исправления),Custom field (Ранг)',
  'SUP-1,"Не грузится отчёт, совсем",Defect,In Progress,Марат,24/Aug/26 9:12 AM,,26/Aug/26 6:02 PM,78',
  'SUP-2,Дубли уведомлений,Defect,Done,Аня,20/Aug/26 10:00 AM,29/Aug/26 12:00 PM,,55',
].join('\n');

test('разбирает кавычки, запятые внутри значений и BOM', () => {
  const { Csv } = loadApp();
  const rows = Csv.parse('﻿' + JIRA);
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], 'Issue key');
  assert.equal(rows[1][1], 'Не грузится отчёт, совсем');
});

test('локализованная выгрузка с ; распознаётся по первой строке', () => {
  const { Csv } = loadApp();
  const text = 'Ключ задачи;Тема;Создано\nSUP-9;Тест;13.08.2026 15:04';
  assert.equal(Csv.detectDelimiter(text), ';');
  const res = Csv.analyze(text);
  assert.equal(res.records[0].key, 'SUP-9');
  assert.equal(res.records[0].created, '13.08.2026 15:04');
});

test('колонки узнаются сами, включая кастомные поля', () => {
  const { Csv } = loadApp();
  const res = Csv.analyze(JIRA);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.equal(res.headers[res.map.key], 'Issue key');
  assert.equal(res.headers[res.map.fixed], 'Custom field (Дата исправления)');
  assert.equal(res.headers[res.map.rank], 'Custom field (Ранг)');
  assert.equal(res.count, 2);
});

test('сохранённая раскладка главнее догадок и переживает смену порядка колонок', () => {
  const { Csv } = loadApp();
  const saved = { key: 'Issue key', summary: 'Summary', created: 'Created', fixed: 'Дата разблокировки' };
  const text = 'Summary,Дата разблокировки,Issue key,Created\nA,26/Aug/26,SUP-3,24/Aug/26';
  const res = Csv.analyze(text, saved);
  assert.equal(res.map.key, 2);
  assert.equal(res.headers[res.map.fixed], 'Дата разблокировки');
});

test('нет обязательной колонки — импорт не предлагается', () => {
  const { Csv } = loadApp();
  const res = Csv.analyze('Что-то,Ещё\n1,2');
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing.map(f => f.id), ['key', 'summary', 'created']);
});

test('записи из выгрузки доезжают до модели вместе с датой исправления', () => {
  const app = loadApp();
  const res = app.Csv.analyze(JIRA);
  app.Store.mergeIncidents(res.records);

  const first = app.Store.incidents().find(i => i.key === 'SUP-1');
  assert.equal(first.rank, 78);
  assert.equal(first.isOpen, false, 'дата исправления снимает блокер, даже если задача открыта');
  assert.equal(first.resolvedAt, null);
  assert.equal(new Date(first.fixedAt).getHours(), 18, '6:02 PM — это 18 часов');

  const second = app.Store.incidents().find(i => i.key === 'SUP-2');
  assert.equal(second.statusCategory, 'done');
  assert.ok(second.timeToClose > 0);
});

test('экспорт экранирует кавычки и разделители', () => {
  const { Csv } = loadApp();
  const out = Csv.toCsv(['a', 'b'], [['простой', 'с "кавычкой", и запятой']]);
  assert.equal(out.split('\n')[1], 'простой,"с ""кавычкой"", и запятой"');
});
