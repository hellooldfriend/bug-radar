/* Разбор дат Jira и границы периодов */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

test('разбирает форматы дат, которые отдаёт Jira', () => {
  const { Store } = loadApp();
  const jira = new Date(Store.parseDateTime('13/Aug/26 3:04 PM'));
  assert.equal(jira.getFullYear(), 2026);
  assert.equal(jira.getMonth(), 7);
  assert.equal(jira.getDate(), 13);
  assert.equal(jira.getHours(), 15);

  const ru = new Date(Store.parseDateTime('13.08.2026 15:04'));
  assert.equal(ru.getHours(), 15);
  assert.equal(ru.getDate(), 13);

  const iso = new Date(Store.parseDateTime('2026-08-13T15:04:00+05:00'));
  assert.equal(iso.getTime(), Date.parse('2026-08-13T10:04:00Z'));

  assert.equal(Store.parseDateTime(''), null);
  assert.equal(Store.parseDateTime('не дата'), null);
});

test('дата без времени становится полднем, а не полуночью', () => {
  const { Store } = loadApp();
  const d = new Date(Store.parseDateTime('2026-08-13'));
  assert.equal(d.getHours(), 12, 'полночь прыгала бы через границу суток при смене таймзоны');
  assert.equal(d.getDate(), 13);
});

test('неделя начинается в понедельник и заканчивается воскресеньем', () => {
  const { Store } = loadApp();
  const thursday = new Date(2026, 8, 3, 15, 0, 0);      // 3 сентября 2026 — четверг
  const range = Store.periodRange({ mode: 'week', offset: 0 }, thursday);
  assert.equal(Store.toISODate(range.from), '2026-08-31');
  assert.equal(Store.toISODate(range.to), '2026-09-06');
  assert.equal(range.from.getHours(), 0);
  assert.equal(range.to.getHours(), 23);
  assert.equal(range.days, 7);
});

test('offset −1 даёт прошлую неделю, previousRange — позапрошлую', () => {
  const { Store } = loadApp();
  const thursday = new Date(2026, 8, 3);
  const last = Store.periodRange({ mode: 'week', offset: -1 }, thursday);
  assert.equal(Store.toISODate(last.from), '2026-08-24');
  assert.equal(Store.toISODate(last.to), '2026-08-30');

  const before = Store.previousRange(last);
  assert.equal(Store.toISODate(before.from), '2026-08-17');
  assert.equal(Store.toISODate(before.to), '2026-08-23');
  assert.equal(before.days, 7);
});

test('две недели — 14 дней подряд, месяц — календарный', () => {
  const { Store } = loadApp();
  const day = new Date(2026, 8, 3);

  const two = Store.periodRange({ mode: 'weeks2', offset: 0 }, day);
  assert.equal(two.days, 14);
  assert.equal(Store.toISODate(two.from), '2026-08-24');
  assert.equal(Store.toISODate(two.to), '2026-09-06');

  const month = Store.periodRange({ mode: 'month', offset: 0 }, day);
  assert.equal(Store.toISODate(month.from), '2026-09-01');
  assert.equal(Store.toISODate(month.to), '2026-09-30');

  const prevMonth = Store.previousRange(month);
  assert.equal(Store.toISODate(prevMonth.from), '2026-08-01');
  assert.equal(Store.toISODate(prevMonth.to), '2026-08-31');
  assert.equal(prevMonth.label, 'Август 2026');
});

test('произвольный период сдвигается на свою длину', () => {
  const { Store } = loadApp();
  const range = Store.periodRange({ mode: 'custom', from: '2026-08-10', to: '2026-08-19' });
  assert.equal(range.days, 10);
  const prev = Store.previousRange(range);
  assert.equal(Store.toISODate(prev.from), '2026-07-31');
  assert.equal(Store.toISODate(prev.to), '2026-08-09');
});

test('ряд для графика — N периодов, последний совпадает с текущим', () => {
  const { Store } = loadApp();
  const range = Store.periodRange({ mode: 'week', offset: -1 }, new Date(2026, 8, 3));
  const series = Store.seriesRanges(range, 8);
  assert.equal(series.length, 8);
  assert.equal(Store.toISODate(series[7].from), Store.toISODate(range.from));
  assert.equal(Store.toISODate(series[0].from), '2026-07-06');
});
