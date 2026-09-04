/* ============================================================
   filesync.js — автосохранение состояния в файл на диске.

   Работает через File System Access API: пользователь один раз выбирает
   файл, браузер запоминает доступ, дальше приложение пишет туда при каждом
   изменении. Ни сервера, ни авторизации. Положите файл в синхронизируемую
   папку (iCloud, Яндекс.Диск, Dropbox) — получите доступ с других машин
   и защиту от чистки кеша браузера.

   API есть в Chrome и Edge. Где его нет — модуль молчит, и остаётся
   обычный экспорт/импорт JSON.
   ============================================================ */
const FileSync = (() => {
  'use strict';

  const DB_NAME = 'bug-radar';
  const DB_STORE = 'handles';
  const HANDLE_KEY = 'autosave';
  const WRITE_DELAY = 500;          // не дёргаем диск на каждом клике по фильтру

  /** 'off' | 'on' | 'needs-permission' | 'error' */
  let status = 'off';
  let handle = null;
  let timer = null;
  let onStatusChange = () => {};

  const supported = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

  /* ───────────── Хранение ссылки на файл ───────────── */
  // Сам FileSystemFileHandle нельзя положить в localStorage — только в IndexedDB

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idb(mode, action) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = action(tx.objectStore(DB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  const rememberHandle = value => idb('readwrite', store => store.put(value, HANDLE_KEY));
  const recallHandle = () => idb('readonly', store => store.get(HANDLE_KEY));
  const forgetHandle = () => idb('readwrite', store => store.delete(HANDLE_KEY));

  /* ───────────── Статус ───────────── */

  function setStatus(next) {
    status = next;
    onStatusChange(state());
  }

  function state() {
    return { supported: supported(), status, fileName: handle ? handle.name : '' };
  }

  /* ───────────── Чтение и запись ───────────── */

  async function writeNow() {
    if (!handle || status !== 'on') return;
    try {
      const stream = await handle.createWritable();
      await stream.write(Store.serialize());
      await stream.close();
    } catch (err) {
      console.error('[filesync] не удалось записать файл:', err);
      setStatus('error');
    }
  }

  function scheduleWrite() {
    if (status !== 'on') return;
    clearTimeout(timer);
    timer = setTimeout(writeNow, WRITE_DELAY);
  }

  /** Содержимое выбранного файла, если оно похоже на бэкап. */
  async function readExisting() {
    try {
      const file = await handle.getFile();
      if (!file.size) return null;
      return Store.parseImport(await file.text());
    } catch (err) {
      console.warn('[filesync] файл не похож на бэкап:', err);
      return null;
    }
  }

  /* ───────────── Публичные действия ───────────── */

  /**
   * Выбор файла пользователем. Если в файле уже есть данные, решение
   * «загрузить или перезаписать» принимает вызывающий код.
   *
   * @param {(existing: object) => Promise<boolean>} confirmLoad вернуть true, чтобы загрузить из файла
   */
  async function connect(confirmLoad) {
    if (!supported()) return false;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: 'bug-radar.json',
        types: [{ description: 'Данные Bug Radar', accept: { 'application/json': ['.json'] } }],
      });
    } catch (err) {
      return false;                 // пользователь закрыл диалог — это не ошибка
    }

    const existing = await readExisting();
    if (existing && confirmLoad && await confirmLoad(existing)) {
      Store.replaceState(existing);
    }

    await rememberHandle(handle);
    setStatus('on');
    await writeNow();
    return true;
  }

  /** Восстановление после перезагрузки: разрешение могло не сохраниться. */
  async function restore() {
    if (!supported()) return;
    try {
      const saved = await recallHandle();
      if (!saved) return;
      handle = saved;
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      setStatus(permission === 'granted' ? 'on' : 'needs-permission');
    } catch (err) {
      console.warn('[filesync] не удалось восстановить файл:', err);
    }
  }

  /** Запрос разрешения — только из обработчика клика, иначе браузер откажет. */
  async function grantPermission() {
    if (!handle) return false;
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return false;
    setStatus('on');
    await writeNow();
    return true;
  }

  async function disconnect() {
    clearTimeout(timer);
    handle = null;
    await forgetHandle();
    setStatus('off');
  }

  function init(statusListener) {
    onStatusChange = statusListener || (() => {});
    onStatusChange(state());        // начальное состояние сообщаем всегда, даже когда файла ещё нет
    if (!supported()) return;
    Store.onChange(scheduleWrite);
    restore();
  }

  return { init, connect, restore, grantPermission, disconnect, state, supported, writeNow };
})();
