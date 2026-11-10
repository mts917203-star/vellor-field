// Клиент REST API Яндекс.Диска (только папка приложения: app:/).
// Документация: https://yandex.ru/dev/disk-api/doc/ru/

export class NetError extends Error {}  // нет сети / соединение оборвано → повторить позже
export class AuthError extends Error {} // токен недействителен → войти заново
export class UnreadableError extends Error {} // файл на телефоне больше не читается → добавить заново
export class ApiError extends Error {
  constructor(status, data) {
    super(`${status} ${data?.error || ""} ${data?.message || data?.description || ""}`.trim());
    this.status = status;
    this.data = data;
  }
}

export class YaDisk {
  constructor({ base, token }) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
  }

  async _req(method, path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    let resp;
    try {
      resp = await fetch(`${this.base}${path}${qs ? "?" + qs : ""}`, {
        method,
        headers: { Authorization: `OAuth ${this.token}`, Accept: "application/json" },
        cache: "no-store",
      });
    } catch (e) {
      throw new NetError(`нет связи с Яндекс.Диском (${e.message})`);
    }
    let data = null;
    const text = await resp.text().catch(() => "");
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; } }
    if (resp.status === 401) throw new AuthError("токен недействителен или отозван");
    return { status: resp.status, data };
  }

  /** Сведения о ресурсе или null, если его нет. */
  async meta(path) {
    const r = await this._req("GET", "/v1/disk/resources", { path, fields: "name,path,type,size,sha256,md5,created,modified" });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new ApiError(r.status, r.data);
    return r.data;
  }

  async list(path) {
    const r = await this._req("GET", "/v1/disk/resources", { path, limit: 1000, fields: "_embedded.items.name,_embedded.items.type" });
    if (r.status === 404) return [];
    if (r.status !== 200) throw new ApiError(r.status, r.data);
    return r.data?._embedded?.items || [];
  }

  /** Создать папку; если уже есть — не ошибка. */
  async mkdir(path) {
    const r = await this._req("PUT", "/v1/disk/resources", { path });
    if (r.status === 201 || r.status === 409) return;
    throw new ApiError(r.status, r.data);
  }

  /** Ссылка для загрузки. Без перезаписи: если файл уже есть — вернёт null. */
  async uploadLink(path) {
    const r = await this._req("GET", "/v1/disk/resources/upload", { path, overwrite: "false" });
    if (r.status === 409) return null;
    if (r.status !== 200) throw new ApiError(r.status, r.data);
    return r.data; // {href, method}
  }

  /**
   * PUT файла по ссылке загрузки (через XHR — нужен прогресс).
   * Тело — ArrayBuffer (файл читается в память): у iOS бывают «битые» Blob из IndexedDB, которые
   * XHR не может отправить и молча обрывает запрос; чтение в память даёт явную ошибку NotReadableError.
   * ArrayBuffer к тому же уходит без Content-Type — его не разрешает CORS сервера загрузки Яндекса.
   * Для очень больших файлов (> MAX_MEM) — Blob без типа (slice не копирует данные).
   */
  async putFile(link, blob, onProgress, onPhase) {
    const MAX_MEM = 300 * 1024 * 1024;
    let body;
    if (blob.size <= MAX_MEM) {
      const t = performance.now();
      try { body = await blob.arrayBuffer(); }
      catch (e) { throw new UnreadableError(`файл на телефоне не читается (${e.name}): iOS удалил его копию — добавьте файл заново`); }
      onPhase?.(`прочитан в память за ${((performance.now() - t) / 1000).toFixed(1)} с`);
    } else {
      body = blob.type ? blob.slice(0, blob.size, "") : blob;
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const t0 = performance.now();
      let sent = 0;
      let lastQuarter = 0;
      xhr.open(link.method || "PUT", link.href);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        sent = e.loaded;
        onProgress?.(e.loaded / e.total);
        const q = Math.floor((e.loaded / e.total) * 4);
        if (q > lastQuarter && q < 4) { lastQuarter = q; onPhase?.(`передано ${q * 25}% за ${((performance.now() - t0) / 1000).toFixed(1)} с`); }
      };
      xhr.upload.onload = () => onPhase?.(`данные переданы за ${((performance.now() - t0) / 1000).toFixed(1)} с, ждём ответ сервера`);
      xhr.onload = () => {
        if (xhr.status === 201 || xhr.status === 202 || xhr.status === 200) resolve(xhr.status);
        // Окончательные отказы: нет места на Диске / файл слишком большой.
        else if (xhr.status === 507 || xhr.status === 413) {
          reject(new ApiError(xhr.status, { message: xhr.status === 507 ? "на Яндекс.Диске нет места" : "файл слишком большой" }));
        }
        // Остальное (в т.ч. 404 по одноразовой ссылке после авто-повтора браузера, 5xx) — временный сбой:
        // при следующей попытке проверим облако и возьмём новую ссылку.
        else reject(new NetError(`сервер загрузки ответил ${xhr.status}`));
      };
      xhr.onerror = () => {
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        const where = sent ? `после ${Math.round((sent / blob.size) * 100)}% данных` : "до начала передачи (вероятно CORS/предзапрос)";
        reject(new NetError(navigator.onLine ? `загрузка прервана ${where}, через ${secs} с` : "нет сети"));
      };
      xhr.ontimeout = () => reject(new NetError("загрузка: таймаут"));
      xhr.send(body);
    });
  }

  async diskInfo() {
    const r = await this._req("GET", "/v1/disk/", { fields: "user.login,user.display_name,total_space,used_space" });
    if (r.status !== 200) throw new ApiError(r.status, r.data);
    return r.data;
  }
}
