/* ============================================================
   csv.js — разбор выгрузки Jira и раскладка колонок по полям модели.
   Понимает то, что реально отдаёт Jira: BOM, кавычки внутри значений,
   переводы строк в ячейке, разделитель ';' в локализованных выгрузках.
   Ничего не знает про DOM и хранилище.
   ============================================================ */
const Csv = (() => {
  'use strict';

  /**
   * Поля модели, которые умеем брать из выгрузки.
   * synonyms — заголовки, по которым колонка узнаётся сама (сравнение
   * без регистра, по вхождению). Порядок полей задаёт порядок в UI маппинга.
   */
  const FIELDS = [
    { id: 'key',        label: 'Номер',              required: true,
      synonyms: ['issue key', 'key', 'ключ задачи', 'ключ', 'код'] },
    { id: 'summary',    label: 'Название',           required: true,
      synonyms: ['summary', 'тема', 'название', 'заголовок'] },
    { id: 'created',    label: 'Дата создания',      required: true,
      synonyms: ['created', 'создано', 'создали', 'дата создания'] },
    { id: 'rank',       label: 'Ранг',               hint: 'число 0–100',
      synonyms: ['ранг', 'rank', 'priority score', 'приоритет клиента', 'вес'] },
    { id: 'started',    label: 'Взят в работу',      hint: 'дата начала работы',
      synonyms: ['start date', 'дата начала', 'взят в работу', 'дата взятия в работу', 'in progress date'] },
    { id: 'fixed',      label: 'Дата исправления',   hint: 'блокер снят у клиента: дата или длительность от создания',
      synonyms: ['дата исправления', 'fix date', 'fixed date', 'дата фикса', 'дата устранения',
                 'время восстановления', 'recovery time', 'time to recover'] },
    { id: 'resolved',   label: 'Дата закрытия',
      synonyms: ['resolved', 'дата решения', 'дата закрытия', 'дата завершения', 'resolution date', 'completed'] },
    { id: 'status',     label: 'Статус',             synonyms: ['status', 'статус'] },
    { id: 'assignee',   label: 'Исполнитель',        synonyms: ['assignee', 'исполнитель'] },
    { id: 'type',       label: 'Тип',                synonyms: ['issue type', 'тип задачи', 'тип'] },
    { id: 'resolution', label: 'Резолюция',          synonyms: ['resolution', 'резолюция'] },
    { id: 'components', label: 'Компоненты',         synonyms: ['component', 'компонент'] },
    { id: 'labels',     label: 'Метки',              synonyms: ['labels', 'label', 'метки', 'метка'] },
    { id: 'customer',   label: 'Клиент',             synonyms: ['customer', 'клиент', 'организация', 'organization'] },
    { id: 'updated',    label: 'Обновлено',          hint: 'запасная дата закрытия',
      synonyms: ['updated', 'обновлено', 'дата обновления'] },
  ];

  const FIELD_IDS = FIELDS.map(f => f.id);

  /** Разделитель: тот из ',' и ';', которого больше в первой строке вне кавычек. */
  function detectDelimiter(text) {
    const line = firstLine(text);
    let commas = 0, semis = 0, inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === ',') commas++;
      else if (!inQ && ch === ';') semis++;
    }
    return semis > commas ? ';' : ',';
  }

  function firstLine(text) {
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && (ch === '\n' || ch === '\r')) return text.slice(0, i);
    }
    return text;
  }

  /** CSV → массив массивов. Кавычки, удвоенные кавычки и переводы строк в ячейке. */
  function parse(text, delimiter) {
    const src = String(text).replace(/^﻿/, '');
    const delim = delimiter || detectDelimiter(src);
    const rows = [];
    let row = [], cell = '', inQ = false;

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQ) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; }
          else inQ = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"') { inQ = true; continue; }
      if (ch === delim) { row.push(cell); cell = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += ch;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  /**
   * Автоматическая раскладка: поле модели → индекс колонки.
   * saved — маппинг с прошлого импорта (по имени заголовка), он главнее догадок.
   */
  function autoMap(headers, saved) {
    const cleaned = headers.map(h => String(h || '').trim());
    const lower = cleaned.map(h => h.toLowerCase());
    const map = {};

    FIELDS.forEach(f => {
      if (saved && saved[f.id]) {
        const idx = cleaned.findIndex(h => h === saved[f.id]);
        if (idx >= 0) { map[f.id] = idx; return; }
      }
      let idx = lower.findIndex(h => f.synonyms.includes(h));
      if (idx < 0) idx = lower.findIndex(h => f.synonyms.some(s => h.includes(s)));
      // «Custom field (Дата исправления)» — обычная форма кастомного поля в выгрузке
      if (idx < 0) idx = lower.findIndex(h => /custom field/.test(h) && f.synonyms.some(s => h.includes(s)));
      map[f.id] = idx >= 0 ? idx : null;
    });
    return map;
  }

  /** Строки + маппинг → сырые записи для Store.normalize. */
  function toRecords(rows, map) {
    if (!rows.length) return [];
    const body = rows.slice(1);
    return body.map(cells => {
      const rec = {};
      FIELD_IDS.forEach(id => {
        const idx = map[id];
        rec[id] = idx === null || idx === undefined ? '' : String(cells[idx] === undefined ? '' : cells[idx]).trim();
      });
      return rec;
    }).filter(r => r.key || r.summary);
  }

  /**
   * Полный разбор текста выгрузки: заголовки, предпросмотр и раскладка.
   * Ничего не сохраняет — решение об импорте принимает вызывающий код.
   */
  function analyze(text, saved) {
    const rows = parse(text);
    if (!rows.length) return { ok: false, error: 'Файл пустой или это не CSV' };
    const headers = rows[0].map(h => String(h || '').trim());
    const map = autoMap(headers, saved);
    const records = toRecords(rows, map);
    const missing = FIELDS.filter(f => f.required && (map[f.id] === null || map[f.id] === undefined));
    return { ok: true, headers, rows, map, records, missing, count: records.length };
  }

  /** Маппинг «поле → индекс» в «поле → имя заголовка»: имена переживают смену порядка колонок. */
  function mapToNames(map, headers) {
    const out = {};
    Object.keys(map).forEach(id => {
      const idx = map[id];
      if (idx !== null && idx !== undefined && headers[idx]) out[id] = headers[idx];
    });
    return out;
  }

  /** Экспорт таблицы обратно в CSV. */
  function toCsv(headers, rows) {
    const esc = v => {
      const s = String(v === null || v === undefined ? '' : v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  }

  return { FIELDS, FIELD_IDS, parse, detectDelimiter, autoMap, toRecords, analyze, mapToNames, toCsv };
})();
