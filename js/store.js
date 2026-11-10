// Локальное хранилище на телефоне (IndexedDB).
//
// ВАЖНО (WebKit/iOS): Blob, сохранённый в IndexedDB, Safari держит отдельным файлом на диске.
// При перезаписи записи (put) старый файл удаляется, и все ранее прочитанные ссылки на Blob
// становятся недействительными (NotFoundError). Поэтому байты файлов лежат в отдельном
// хранилище "blobs": записываются ОДИН раз и больше не перезаписываются, а статусы и прочие
// метаданные живут в "files" и меняются сколько угодно. Перед чтением Blob всегда берётся заново.

const DB_NAME = "vellor-field";
const DB_VERSION = 3;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const t = req.transaction;
        if (ev.oldVersion < 1) {
          db.createObjectStore("kv");
          db.createObjectStore("visits", { keyPath: "id" });
          const fs = db.createObjectStore("files", { keyPath: "id" });
          fs.createIndex("visit", "visit_id");
          db.createObjectStore("log", { autoIncrement: true });
        }
        if (ev.oldVersion < 2) {
          const blobs = db.createObjectStore("blobs");
          // Перенос: Blob из старых записей — в отдельное хранилище (могут быть уже недоступны).
          t.objectStore("files").openCursor().onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) return;
            const rec = cur.value;
            if (rec.blob) {
              blobs.put(rec.blob, rec.id);
              delete rec.blob;
              rec.migrated = true;
              cur.update(rec);
            }
            cur.continue();
          };
        }
        if (ev.oldVersion < 3) {
          // Реестр объектов: с ПК (по списку OBJECTS) и созданные на телефоне (id = UUID).
          db.createObjectStore("props", { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Если открылась новая версия приложения (обновление схемы) — эта копия отпускает базу.
        db.onversionchange = () => { db.close(); dbPromise = null; location.reload(); };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // Обновление схемы ждёт, пока старая копия приложения (другая вкладка) закроет базу.
      req.onblocked = () => {
        const t = document.getElementById("toast");
        if (t) { t.textContent = "Закройте другие окна VELLOR — идёт обновление хранилища"; t.hidden = false; }
      };
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("transaction aborted"));
      })
  );
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const kv = {
  get: (k) => tx("kv", "readonly", (s) => wrap(s.get(k))),
  set: (k, v) => tx("kv", "readwrite", (s) => { s.put(v, k); }),
  del: (k) => tx("kv", "readwrite", (s) => { s.delete(k); }),
};

export const visits = {
  all: () => tx("visits", "readonly", (s) => wrap(s.getAll())).then((a) => a.sort((x, y) => y.created_at.localeCompare(x.created_at))),
  get: (id) => tx("visits", "readonly", (s) => wrap(s.get(id))),
  put: (v) => tx("visits", "readwrite", (s) => { s.put(v); }),
};

/** Объекты: {id, code|null, title, address, source: "pc"|"phone", created_at}. */
export const props = {
  all: () => tx("props", "readonly", (s) => wrap(s.getAll())).then((a) =>
    a.sort((x, y) => (y.code || "~").localeCompare(x.code || "~") || (y.created_at || "").localeCompare(x.created_at || ""))),
  get: (id) => tx("props", "readonly", (s) => wrap(s.get(id))),
  put: (p) => tx("props", "readwrite", (s) => { s.put(p); }),
};

/** Байты файлов: запись один раз, без перезаписи. */
export const blobs = {
  get: (id) => tx("blobs", "readonly", (s) => wrap(s.get(id))),
  /** Только добавление: если запись уже есть — ошибка (защита от перезаписи). */
  add: (id, blob) => tx("blobs", "readwrite", (s) => { s.add(blob, id); }),
  del: (id) => tx("blobs", "readwrite", (s) => { s.delete(id); }),
};

/** Метаданные файлов (статусы, хэши, ошибки) — без Blob. */
export const files = {
  byVisit: (vid) => tx("files", "readonly", (s) => wrap(s.index("visit").getAll(vid))).then((a) => a.sort((x, y) => x.idx - y.idx)),
  get: (id) => tx("files", "readonly", (s) => wrap(s.get(id))),
  put: (f) => {
    if (f.blob) throw new Error("Blob нельзя хранить в метаданных файла");
    return tx("files", "readwrite", (s) => { s.put(f); });
  },
  del: async (id) => { await tx("files", "readwrite", (s) => { s.delete(id); }); await blobs.del(id); },
  patch: async (id, fields) => {
    const f = await files.get(id);
    if (!f) return null;
    Object.assign(f, fields);
    delete f.blob;
    await files.put(f);
    return f;
  },
};

export async function log(level, msg) {
  const entry = { t: new Date().toISOString(), level, msg };
  try { await tx("log", "readwrite", (s) => { s.add(entry); }); } catch { /* журнал не критичен */ }
  (level === "error" ? console.error : console.log)(`[${level}] ${msg}`);
}

export async function recentLog(n = 60) {
  const all = await tx("log", "readonly", (s) => wrap(s.getAll()));
  return all.slice(-n).reverse();
}
