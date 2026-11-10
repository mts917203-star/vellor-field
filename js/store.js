// Локальное хранилище на телефоне (IndexedDB). Файлы хранятся как Blob до подтверждения на ПК.

const DB_NAME = "vellor-field";
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("kv");
        db.createObjectStore("visits", { keyPath: "id" });
        const files = db.createObjectStore("files", { keyPath: "id" });
        files.createIndex("visit", "visit_id");
        db.createObjectStore("log", { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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

export const files = {
  byVisit: (vid) => tx("files", "readonly", (s) => wrap(s.index("visit").getAll(vid))).then((a) => a.sort((x, y) => x.idx - y.idx)),
  get: (id) => tx("files", "readonly", (s) => wrap(s.get(id))),
  put: (f) => tx("files", "readwrite", (s) => { s.put(f); }),
  del: (id) => tx("files", "readwrite", (s) => { s.delete(id); }),
  /** Обновить поля без перезаписи Blob вручную. */
  patch: async (id, fields) => {
    const f = await files.get(id);
    if (!f) return null;
    Object.assign(f, fields);
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
