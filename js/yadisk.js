// Клиент REST API Яндекс.Диска (только папка приложения: app:/).
// Документация: https://yandex.ru/dev/disk-api/doc/ru/

export class NetError extends Error {}  // нет сети / соединение оборвано → повторить позже
export class AuthError extends Error {} // токен недействителен → войти заново
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

  /** PUT файла по ссылке загрузки (через XHR — нужен прогресс). */
  putFile(link, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(link.method || "PUT", link.href);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
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
      xhr.onerror = () => reject(new NetError("загрузка прервана: нет связи или CORS"));
      xhr.ontimeout = () => reject(new NetError("загрузка: таймаут"));
      xhr.send(blob);
    });
  }

  async diskInfo() {
    const r = await this._req("GET", "/v1/disk/", { fields: "user.login,user.display_name,total_space,used_space" });
    if (r.status !== 200) throw new ApiError(r.status, r.data);
    return r.data;
  }
}
