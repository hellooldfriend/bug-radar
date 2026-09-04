/* Нормализация инцидента: производные поля, дата исправления, слияние */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, at } = require('./helpers/load');

test('момент разблокировки — самая ранняя из даты исправления и закрытия', () => {
  const { Store } = loadApp();
  const inc = Store.normalize({
    key: 'SUP-1', summary: 'A', created: at(2026, 8, 24, 10),
    fixed: at(2026, 8, 26, 18), resolved: at(2026, 8, 30, 9), status: 'Done',
  });
  assert.equal(inc.unblockedMs, Date.parse(at(2026, 8, 26, 18)),
    'для клиента блокер снят в момент исправления, а не закрытия');
  assert.equal(inc.timeToFix, Date.parse(at(2026, 8, 26, 18)) - Date.parse(at(2026, 8, 24, 10)));
  assert.equal(inc.timeToClose, Date.parse(at(2026, 8, 30, 9)) - Date.parse(at(2026, 8, 24, 10)));
  assert.equal(inc.isOpen, false);
});

test('закрытие без даты исправления всё равно считается разбором', () => {
  const { Store } = loadApp();
  const inc = Store.normalize({ key: 'SUP-2', summary: 'B', created: at(2026, 8, 24), resolved: at(2026, 8, 25), status: 'Closed' });
  assert.equal(inc.isOpen, false, 'иначе метрика наказывала бы за незаполненное поле');
  assert.ok(inc.timeToFix > 0);
});

test('исправлен, но не закрыт — уже не открыт', () => {
  const { Store } = loadApp();
  const inc = Store.normalize({ key: 'SUP-3', summary: 'C', created: at(2026, 8, 24), fixed: at(2026, 8, 26), status: 'In Progress' });
  assert.equal(inc.isOpen, false);
  assert.equal(inc.resolvedAt, null);
  assert.equal(inc.statusCategory, 'indeterminate');
});

test('закрытый статус без даты закрытия берёт «обновлено» и помечается', () => {
  const { Store } = loadApp();
  const inc = Store.normalize({ key: 'SUP-4', summary: 'D', created: at(2026, 8, 20), status: 'Готово', updated: at(2026, 8, 22) });
  assert.equal(inc.resolvedInferred, true);
  assert.equal(inc.closedNoDate, true);
  assert.equal(inc.resolvedAt, at(2026, 8, 22));
});

test('ранг разбирается из строки, пустой ранг остаётся null', () => {
  const { Store } = loadApp();
  assert.equal(Store.normalize({ key: 'A', created: at(2026, 8, 1), rank: '78' }).rank, 78);
  assert.equal(Store.normalize({ key: 'B', created: at(2026, 8, 1), rank: '' }).rank, null);
  assert.equal(Store.normalize({ key: 'C', created: at(2026, 8, 1), rank: 'нет' }).rank, null);
});

test('повторная заливка обновляет, а не задваивает, и ничего не удаляет', () => {
  const { Store } = loadApp();
  Store.mergeIncidents([
    { key: 'SUP-1', summary: 'Старое', created: at(2026, 8, 24), status: 'Open' },
    { key: 'SUP-2', summary: 'Второй', created: at(2026, 8, 25), status: 'Open' },
  ]);
  const res = Store.mergeIncidents([
    { key: 'SUP-1', summary: 'Новое', created: at(2026, 8, 24), status: 'Done', resolved: at(2026, 8, 27) },
    { key: 'SUP-3', summary: 'Третий', created: at(2026, 8, 26), status: 'Open' },
  ]);

  assert.equal(res.added, 1);
  assert.equal(res.updated, 1);
  assert.equal(Store.incidents().length, 3, 'SUP-2 не пропал из-за того, что его нет в файле');
  assert.deepEqual(res.missing, ['SUP-2']);
  const first = Store.incidents().find(i => i.key === 'SUP-1');
  assert.equal(first.summary, 'Новое');
  assert.equal(first.isOpen, false);
});

test('полоса ранга и SLA берутся по настройкам, без ранга — общий SLA', () => {
  const { Store } = loadApp();
  const sett = Store.settings();
  const crit = Store.normalize({ key: 'A', created: at(2026, 8, 1), rank: 95 });
  const none = Store.normalize({ key: 'B', created: at(2026, 8, 1), rank: '' });

  assert.equal(Store.bandOf(crit, sett).id, 'crit');
  assert.equal(Store.bandOf(none, sett), null);
  assert.equal(Store.slaOf(crit, sett).fix, 24 * Store.HOUR);
  assert.equal(Store.slaOf(none, sett).fix, 168 * Store.HOUR);
});

test('ссылка на задачу собирается из адреса без схемы и с лишним слэшем', () => {
  const { Store } = loadApp();
  Store.updateSettings({ jiraBase: 'jira.company.com/browse/' });
  assert.equal(Store.issueUrl('SUP-1'), 'https://jira.company.com/browse/SUP-1');
  Store.updateSettings({ jiraBase: '' });
  assert.equal(Store.issueUrl('SUP-1'), null);
});
