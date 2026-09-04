/* ============================================================
   sheets.js — выгрузки Jira в XLSX и XLS.

   Таблицу разбирает SheetJS (js/vendor/xlsx.full.min.js, Apache-2.0).
   Библиотека весит под мегабайт, поэтому подключается лениво — только
   когда пользователь выбрал не-CSV. Дальше файл превращается в CSV-текст
   и идёт по тому же пути, что и обычная выгрузка: распознавание колонок,
   раскладка, предпросмотр. Один конвейер — одни и те же правила.
   ============================================================ */
const Sheets = (() => {
  'use strict';

  const VENDOR = 'js/vendor/xlsx.full.min.js';
  const EXT = /\.(xlsx|xlsm|xls)$/i;
  let loading = null;

  /** Похоже ли имя файла на таблицу Excel. */
  const isSpreadsheet = name => EXT.test(String(name || ''));

  /** Лениво подгружает SheetJS. В тестах глобальный XLSX уже есть — тогда ничего не грузим. */
  function load() {
    if (typeof XLSX !== 'undefined') return Promise.resolve(XLSX);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = VENDOR;
      script.onload = () => (typeof XLSX !== 'undefined' ? resolve(XLSX) : reject(new Error('SheetJS не загрузился')));
      script.onerror = () => reject(new Error(`Не удалось загрузить ${VENDOR}`));
      document.head.appendChild(script);
    });
    return loading;
  }

  /**
   * Лист с данными: Jira кладёт выгрузку на первый лист, но в файле, который
   * кто-то уже трогал руками, первым может оказаться пустой «Sheet1».
   * Берём самый заполненный.
   */
  function pickSheet(wb, X) {
    let best = null, bestRows = -1;
    wb.SheetNames.forEach(name => {
      const ws = wb.Sheets[name];
      const ref = ws && ws['!ref'];
      if (!ref) return;
      const rows = X.utils.decode_range(ref).e.r + 1;
      if (rows > bestRows) { best = name; bestRows = rows; }
    });
    return best;
  }

  const pad = n => String(n).padStart(2, '0');

  /**
   * Дата из ячейки — в локальном ISO-виде без зоны, как пишет сама Jira.
   * Берём объект Date, а не текст ячейки: текст SheetJS считает из числового
   * сериала через свой форматтер, и на некоторых зонах он врёт на секунды.
   */
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const cellText = v => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v) ? '' : fmtDate(v);
    return String(v);
  };

  const quote = s => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  /**
   * ArrayBuffer → CSV-текст. Даты приводятся к одному предсказуемому виду:
   * Excel хранит их числом, а формат ячейки у каждого свой — пусть дальше
   * разбирается тот же парсер дат, что и для CSV.
   */
  async function toCsv(buffer) {
    const X = await load();
    const wb = X.read(buffer, { type: 'array', cellDates: true });
    const name = pickSheet(wb, X);
    if (!name) throw new Error('В файле нет ни одного листа с данными');
    const rows = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
    const csv = rows.map(r => r.map(v => quote(cellText(v))).join(',')).join('\n');
    return { csv, sheet: name, sheets: wb.SheetNames.length };
  }

  return { isSpreadsheet, load, toCsv };
})();
