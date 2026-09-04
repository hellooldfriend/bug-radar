/* ============================================================
   Загрузчик приложения для тестов.

   Исходники — обычные скрипты для браузера, без экспортов: сборки в проекте
   нет и заводить её ради тестов не хочется. Склеиваем модули в тело одной
   функции и возвращаем их наружу. Каждый вызов loadApp() создаёт свежее
   состояние — тесты не протекают друг в друга.
   ============================================================ */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCES = ['js/store.js', 'js/csv.js', 'js/sheets.js', 'js/metrics.js', 'js/charts.js'];

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

let factorySource = null;
function buildFactorySource() {
  if (factorySource) return factorySource;
  const parts = SOURCES.map(file => `// ── ${file}\n` + fs.readFileSync(path.join(ROOT, file), 'utf8'));
  factorySource = '(function (localStorage) {\n' + parts.join('\n') +
    '\nreturn { Store, Csv, Sheets, Metrics, Charts };\n})';
  return factorySource;
}

function loadApp() {
  const storage = memoryStorage();
  const app = vm.runInThisContext(buildFactorySource(), { filename: 'app-bundle.js' })(storage);
  app.Store.load();
  return Object.assign({}, app, { storage });
}

/** Локальная ISO-метка: тесты пишут «26 августа 10:00» и получают то же, что браузер. */
function at(y, m, d, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

/**
 * Инциденты из компактного описания, чтобы тесты читались.
 * Даты передаются как [y, m, d, h] или ISO-строкой.
 */
function seed(app, rows) {
  const records = rows.map((r, i) => ({
    key: r.key || `SUP-${i + 1}`,
    summary: r.summary || `Инцидент ${i + 1}`,
    status: r.status || 'Open',
    type: r.type || 'Defect',
    assignee: r.assignee === undefined ? 'Марат' : r.assignee,
    rank: r.rank === undefined ? 70 : r.rank,
    created: r.created,
    started: r.started,
    fixed: r.fixed,
    resolved: r.resolved,
    updated: r.updated,
  }));
  app.Store.mergeIncidents(records);
  return app.Store.incidents();
}

module.exports = { loadApp, at, seed };
