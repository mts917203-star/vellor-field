// Очередь передачи: телефон → Яндекс.Диск (с проверкой SHA-256) → подтверждение с ПК.
//
// Статусы файла:   local (на телефоне) → uploading → cloud (в облаке, SHA-256 совпал) | error
// Статусы осмотра: draft → queued (нажато «Отправить») → cloud (все файлы и манифест в облаке) → pc
//
// Защита от дублей: имя файла в облаке детерминировано (<пакет>__<NN>_<имя>), загрузка идёт
// без перезаписи. Перед загрузкой проверяется, нет ли файла уже в облаке с тем же SHA-256 —
// так повтор после обрыва связи не создаёт копию, даже если ответ сервера был потерян.

import { APP_VERSION, CONFIG } from "./config.js";
import { sha256Blob } from "./hash.js";
import { files, kv, log, visits } from "./store.js";
import { ApiError, AuthError, NetError, YaDisk } from "./yadisk.js";

export class IntegrityError extends Error {}
export class ConflictError extends Error {}

const listeners = new Set();
export const onSyncEvent = (fn) => listeners.add(fn);
const emit = (e) => listeners.forEach((fn) => { try { fn(e); } catch (err) { console.error(err); } });

let running = false;
export const isSyncing = () => running;

export async function getClient() {
  const t = await kv.get("token");
  return t?.access_token ? new YaDisk({ base: CONFIG.API_BASE, token: t.access_token }) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждём, пока Яндекс обработает файл и отдаст его SHA-256. */
async function waitMeta(yd, path, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const m = await yd.meta(path);
    if (m?.sha256) return m;
    await sleep(Math.min(500 * 2 ** i, 4000));
  }
  return null;
}

/**
 * Загружает blob в path без перезаписи и проверяет SHA-256 в облаке.
 * Возвращает "uploaded" | "already" (файл уже был в облаке с тем же хэшем).
 */
export async function uploadVerified(yd, path, blob, sha256, onProgress) {
  const existing = await yd.meta(path);
  if (existing) {
    if (existing.sha256 === sha256) return "already";
    if (!existing.sha256) {
      const m = await waitMeta(yd, path);
      if (m?.sha256 === sha256) return "already";
    }
    throw new ConflictError(`в облаке уже есть другой файл ${path.split("/").pop()}`);
  }
  const link = await yd.uploadLink(path);
  if (!link) return uploadVerified(yd, path, blob, sha256, onProgress); // появился между запросами
  await yd.putFile(link, blob, onProgress);
  const m = await waitMeta(yd, path);
  if (!m) throw new NetError("файл загружен, но Яндекс ещё не подтвердил его — проверим позже");
  if (m.sha256 !== sha256) throw new IntegrityError(`SHA-256 в облаке не совпал: ${path.split("/").pop()}`);
  if (m.size !== blob.size) throw new IntegrityError(`размер в облаке не совпал: ${m.size} ≠ ${blob.size}`);
  return "uploaded";
}

export function remotePath(name) {
  return `${CONFIG.INBOX}/${name}`;
}

async function ensureHashed(f) {
  if (f.sha256) return f;
  emit({ type: "file", id: f.id, phase: "hashing", progress: 0 });
  const sha = await sha256Blob(f.blob, (p) => emit({ type: "file", id: f.id, phase: "hashing", progress: p }));
  return files.patch(f.id, { sha256: sha });
}

async function uploadFile(yd, f) {
  f = await ensureHashed(f);
  await files.patch(f.id, { status: "uploading", error: null, attempts: (f.attempts || 0) + 1 });
  emit({ type: "file", id: f.id, phase: "uploading", progress: 0 });
  try {
    const res = await uploadVerified(yd, remotePath(f.remote_name), f.blob, f.sha256, (p) =>
      emit({ type: "file", id: f.id, phase: "uploading", progress: p })
    );
    await files.patch(f.id, { status: "cloud", error: null, verified_at: new Date().toISOString(), dedup: res === "already" });
    await log("info", `${f.remote_name}: ${res === "already" ? "уже был в облаке (дубликат не создан)" : "загружен, SHA-256 совпал"}`);
  } catch (e) {
    if (e instanceof NetError || e instanceof AuthError) {
      await files.patch(f.id, { status: "local", error: `${e.message} (попытка ${(f.attempts || 0) + 1}, повторим автоматически)` });
      throw e; // прерываем весь цикл — повторим, когда появится связь
    }
    const kind = e instanceof IntegrityError ? "integrity" : e instanceof ConflictError ? "conflict" : "api";
    await files.patch(f.id, { status: "error", error: e.message, error_kind: kind });
    await log("error", `${f.remote_name}: ${e.message}`);
  } finally {
    emit({ type: "file", id: f.id, phase: "done" });
  }
}

function buildManifest(v, list) {
  return {
    format: "vellor-1",
    source: "vellor-pwa",
    app_version: APP_VERSION,
    package: v.id,
    property_code: v.property_code || CONFIG.DEFAULT_PROPERTY,
    address: v.address || "",
    visit_at: v.visit_at,
    visit_type: v.visit_type || "Тест прототипа",
    notes: v.notes || "",
    latitude: v.gps?.lat ?? "",
    longitude: v.gps?.lon ?? "",
    gps_accuracy_m: v.gps?.acc ?? "",
    files_count: list.length,
    files: list.map((f) => ({ name: f.remote_name.split("__").slice(1).join("__"), sha256: f.sha256, size: f.size, type: f.type })),
    // копии, отбракованные при проверке (повреждены/конфликт) — остаются в облаке, ПК их пропускает
    superseded_files: list.flatMap((f) => (f.superseded || []).map((n) => n.split("__").slice(1).join("__"))),
    device: navigator.userAgent,
  };
}

async function syncVisit(yd, v) {
  for (const f of await files.byVisit(v.id)) {
    if (f.status === "cloud" || f.status === "error") continue;
    await uploadFile(yd, f);
  }
  const list = await files.byVisit(v.id);
  if (!list.length || !list.every((f) => f.status === "cloud")) return;

  // Манифест — последним и неизменным между повторами (иначе хэш разойдётся).
  if (!v.manifest_json) {
    v.manifest_json = JSON.stringify(buildManifest(v, list), null, 2);
    v.manifest_sha = await sha256Blob(new Blob([v.manifest_json]));
    await visits.put(v);
  }
  const blob = new Blob([v.manifest_json], { type: "application/json" });
  try {
    const res = await uploadVerified(yd, remotePath(`${v.id}__manifest.json`), blob, v.manifest_sha);
    v.status = "cloud";
    v.cloud_at = new Date().toISOString();
    await visits.put(v);
    await log("info", `Осмотр ${v.id}: все файлы в облаке, манифест ${res === "already" ? "уже был" : "загружен"}`);
  } catch (e) {
    if (e instanceof NetError || e instanceof AuthError) throw e;
    v.manifest_error = e.message;
    await visits.put(v);
    await log("error", `Манифест ${v.id}: ${e.message}`);
  }
  emit({ type: "visit", id: v.id });
}

/** Подтверждения с ПК: файлы STATUS/<пакет>.ok.json или .error.json. */
async function checkPc(yd) {
  const pending = (await visits.all()).filter((v) => v.status === "cloud");
  if (!pending.length) return;
  const names = new Set((await yd.list(CONFIG.STATUS)).map((i) => i.name));
  for (const v of pending) {
    if (names.has(`${v.id}.ok.json`)) {
      v.status = "pc";
      v.pc_at = new Date().toISOString();
      v.pc_error = null;
      await visits.put(v);
      await log("info", `Осмотр ${v.id}: получен и проверен на ПК`);
      emit({ type: "visit", id: v.id });
    } else if (names.has(`${v.id}.error.json`) && !v.pc_error) {
      v.pc_error = "ПК сообщил об ошибке проверки — см. журнал на компьютере";
      await visits.put(v);
      emit({ type: "visit", id: v.id });
    }
  }
}

/** Один проход синхронизации. Безопасно вызывать сколько угодно раз. */
export async function syncAll(reason = "") {
  if (running) return;
  running = true;
  emit({ type: "sync", running: true });
  try {
    const yd = await getClient();
    if (!yd) return;
    const queue = (await visits.all()).filter((v) => v.status === "queued");
    if (queue.length) {
      await yd.mkdir(CONFIG.INBOX);
      for (const v of queue) await syncVisit(yd, v);
    }
    await checkPc(yd);
    await kv.set("last_sync", { at: new Date().toISOString(), ok: true, reason });
  } catch (e) {
    const msg = e instanceof NetError ? `Нет связи: ${e.message}` : e.message;
    await kv.set("last_sync", { at: new Date().toISOString(), ok: false, error: msg, auth: e instanceof AuthError });
    await log(e instanceof NetError ? "warn" : "error", `Синхронизация (${reason}): ${msg}`);
  } finally {
    running = false;
    emit({ type: "sync", running: false });
  }
}

/** Повторить файлы с ошибкой. При конфликте/несовпадении — под новым именем (старое в облаке не трогаем). */
export async function retryErrors(visitId) {
  for (const f of await files.byVisit(visitId)) {
    if (f.status !== "error") continue;
    const patch = { status: "local", error: null };
    if (f.error_kind === "integrity" || f.error_kind === "conflict") {
      const n = (f.rename_n || 1) + 1;
      const base = f.base_remote_name || f.remote_name;
      const dot = base.lastIndexOf(".");
      patch.base_remote_name = base;
      patch.rename_n = n;
      patch.superseded = [...(f.superseded || []), f.remote_name];
      patch.remote_name = dot > 0 ? `${base.slice(0, dot)}_r${n}${base.slice(dot)}` : `${base}_r${n}`;
    }
    await files.patch(f.id, patch);
  }
}

export { ApiError, AuthError, NetError };
