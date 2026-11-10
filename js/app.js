// VELLOR FIELD — прототип мобильного приложения (PWA).

import { APP_VERSION, CONFIG, DEV } from "./config.js";
import { Sha256, sha256Blob } from "./hash.js";
import { files, kv, log, recentLog, visits } from "./store.js";
import { getClient, isSyncing, onSyncEvent, retryErrors, syncAll, uploadVerified } from "./sync.js";
import { AuthError, YaDisk } from "./yadisk.js";

const $view = document.getElementById("view");
const $net = document.getElementById("net-pill");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (b) => (b < 1024 ? `${b} Б` : b < 1048576 ? `${(b / 1024).toFixed(0)} КБ` : `${(b / 1048576).toFixed(1)} МБ`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const pad = (n) => String(n).padStart(2, "0");

let route = { name: "home" };
let recorder = null;
const objectUrls = new Map();

// ---------- утилиты ----------

function toast(msg, ms = 2600) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function newPackageId(d = new Date()) {
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${rnd}`;
}

function safeName(name) {
  const s = String(name || "file").normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return s.slice(-80) || "file";
}

function kindOf(type, name) {
  if (type?.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp|dng)$/i.test(name)) return "photo";
  if (type?.startsWith("video/") || /\.(mov|mp4|m4v)$/i.test(name)) return "video";
  if (type?.startsWith("audio/") || /\.(m4a|mp3|wav|aac|caf|webm)$/i.test(name)) return "audio";
  return "other";
}
const KIND_ICON = { photo: "▣", video: "▶", audio: "◉", other: "◇" };

function fileStatusChip(f) {
  if (f.status === "cloud") return `<span class="st st-cloud">${f.dedup ? "В облаке (повтор)" : "В облаке ✓"}</span>`;
  if (f.status === "uploading") return `<span class="st st-warn">Загрузка…</span>`;
  if (f.status === "error") return `<span class="st st-err">Ошибка</span>`;
  return `<span class="st st-phone">На телефоне</span>`;
}

function visitChips(v, list) {
  const n = list.length;
  const cloud = list.filter((f) => f.status === "cloud").length;
  const err = list.filter((f) => f.status === "error").length;
  const out = [];
  if (v.status === "pc") out.push(`<span class="st st-pc">Обработано на ПК ✓</span>`);
  else if (v.status === "cloud") out.push(`<span class="st st-cloud">Загружено в облако ✓</span>`, `<span class="st st-phone">Ждём ПК</span>`);
  else {
    out.push(`<span class="st st-phone">На телефоне: ${n - cloud}</span>`);
    if (cloud) out.push(`<span class="st st-cloud">В облаке: ${cloud}/${n}</span>`);
    if (v.status === "draft") out.push(`<span class="st st-warn">Не отправлен</span>`);
  }
  if (err) out.push(`<span class="st st-err">Ошибок: ${err}</span>`);
  if (v.pc_error) out.push(`<span class="st st-err">ПК: ошибка</span>`);
  return out.join("");
}

async function updateNet() {
  const last = await kv.get("last_sync");
  if (isSyncing()) { $net.className = "pill sync"; $net.textContent = "Синхронизация"; return; }
  if (!navigator.onLine) { $net.className = "pill off"; $net.textContent = "Офлайн"; return; }
  if (last && !last.ok) { $net.className = "pill off"; $net.textContent = last.auth ? "Нужен вход" : "Нет связи с Диском"; return; }
  $net.className = "pill on"; $net.textContent = "Онлайн";
}

// ---------- авторизация ----------

async function clientId() {
  return CONFIG.CLIENT_ID || (await kv.get("client_id")) || "";
}

async function startLogin() {
  const id = await clientId();
  if (!id) return toast("Сначала укажите Client ID");
  const state = crypto.randomUUID();
  await kv.set("oauth_state", state);
  const redirect = location.origin + location.pathname;
  const q = new URLSearchParams({ response_type: "token", client_id: id, redirect_uri: redirect, scope: CONFIG.SCOPE, state, force_confirm: "yes" });
  location.href = `https://oauth.yandex.ru/authorize?${q}`;
}

/** Обработка возврата из Яндекс OAuth: токен приходит во фрагменте URL (#access_token=…), на сервер не попадает. */
async function handleOAuthReturn() {
  if (!location.hash.includes("access_token") && !location.hash.includes("error=")) return;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search); // убрать токен из адресной строки
  const expected = await kv.get("oauth_state");
  await kv.del("oauth_state");
  if (p.get("error")) return toast(`Вход отменён: ${p.get("error_description") || p.get("error")}`, 5000);
  if (!expected || p.get("state") !== expected) {
    await log("error", "OAuth: state не совпал — ответ отклонён");
    return toast("Ошибка безопасности входа (state). Попробуйте ещё раз.", 5000);
  }
  await saveToken(p.get("access_token"), Number(p.get("expires_in")) || null, "redirect");
}

async function saveToken(token, expiresIn, how) {
  token = (token || "").trim();
  if (!/^[\w.-]{20,}$/.test(token)) return toast("Это не похоже на токен");
  const yd = new YaDisk({ base: CONFIG.API_BASE, token });
  try {
    await yd.meta("app:/"); // 200 или 404 — токен рабочий; 401 — нет
  } catch (e) {
    if (e instanceof AuthError) return toast("Яндекс отклонил токен", 4000);
    await log("warn", `Проверка токена без сети: ${e.message}`);
  }
  await kv.set("token", { access_token: token, obtained_at: new Date().toISOString(), expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null, how });
  await kv.del("last_sync");
  await log("info", `Вход выполнен (${how}), доступ: ${CONFIG.SCOPE}`);
  toast("Вход выполнен");
  go({ name: "home" });
  syncAll("login");
}

async function logout() {
  if (!confirm("Выйти? Токен будет удалён с телефона. Неотправленные материалы останутся.")) return;
  await kv.del("token");
  await log("info", "Выход: токен удалён");
  go({ name: "home" });
}

// ---------- экраны ----------

function go(r) {
  route = r;
  render();
  window.scrollTo(0, 0);
}

async function render() {
  updateNet();
  const token = await kv.get("token");
  if (route.name === "diag") return renderDiag(token);
  if (!token) return renderLogin();
  if (route.name === "visit") return renderVisit(route.id);
  return renderHome();
}

async function renderLogin() {
  const id = await clientId();
  $view.innerHTML = `
    <h1>Вход</h1>
    <p class="lead">VELLOR FIELD получает доступ <b>только к своей папке</b> на вашем Яндекс.Диске
      (<span class="mono">Приложения/…</span>). Остальные файлы Диска приложению недоступны.</p>
    ${CONFIG.CLIENT_ID ? "" : `
    <label class="field"><span>Client ID приложения Яндекс OAuth (публичный, не секрет)</span>
      <input id="cid" class="input mono" value="${esc(id)}" placeholder="например 1a2b3c…" autocapitalize="off" autocomplete="off"></label>
    <button id="cid-save" class="btn" style="margin-bottom:12px">Сохранить Client ID</button>`}
    <button id="login" class="btn btn-gold" ${id ? "" : "disabled"}>Войти через Яндекс</button>
    <h2>Если вход не возвращает в приложение</h2>
    <div class="card small">
      <p class="muted" style="margin-top:0">Откройте ссылку, войдите, скопируйте показанный код доступа и вставьте сюда:</p>
      <a class="btn btn-ghost" id="manual-link" target="_blank" rel="noopener" ${id ? "" : "hidden"}>Получить код доступа</a>
      <label class="field" style="margin-top:12px"><span>Токен доступа</span>
        <input id="manual" class="input mono" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <button id="manual-save" class="btn">Сохранить токен</button>
    </div>`;
  document.getElementById("login").onclick = startLogin;
  const cidSave = document.getElementById("cid-save");
  if (cidSave) cidSave.onclick = async () => { await kv.set("client_id", document.getElementById("cid").value.trim()); render(); };
  const ml = document.getElementById("manual-link");
  if (id) ml.href = `https://oauth.yandex.ru/authorize?${new URLSearchParams({ response_type: "token", client_id: id, scope: CONFIG.SCOPE, redirect_uri: "https://oauth.yandex.ru/verification_code", force_confirm: "yes" })}`;
  document.getElementById("manual-save").onclick = () => saveToken(document.getElementById("manual").value, null, "manual");
}

async function renderHome() {
  const all = await visits.all();
  const rows = await Promise.all(all.map(async (v) => [v, await files.byVisit(v.id)]));
  $view.innerHTML = `
    <h1>Осмотры</h1>
    <p class="lead small">Прототип ${esc(APP_VERSION)} · передача в Яндекс.Диск</p>
    ${rows.length ? rows.map(([v, list]) => `
      <div class="card link" data-visit="${esc(v.id)}">
        <div class="card-row">
          <div><div class="card-title">${esc(v.property_code)} · ${esc(v.address || "без адреса")}</div>
          <div class="card-sub">${fmtDate(v.created_at)} · файлов: ${list.length} · ${esc(v.id)}</div></div>
        </div>
        <div class="chips">${visitChips(v, list)}</div>
      </div>`).join("") : `<div class="card muted">Осмотров пока нет.</div>`}
    <div class="bottom-bar"><div class="inner">
      <button id="new" class="btn btn-gold">＋ Новый осмотр</button>
    </div></div>`;
  document.getElementById("new").onclick = newVisit;
  $view.querySelectorAll("[data-visit]").forEach((el) => (el.onclick = () => go({ name: "visit", id: el.dataset.visit })));
}

async function newVisit() {
  const now = new Date();
  const v = {
    id: newPackageId(now), created_at: now.toISOString(), visit_at: localIso(now), status: "draft",
    property_code: CONFIG.DEFAULT_PROPERTY, address: "", notes: "", visit_type: "Тест прототипа", gps: null,
  };
  await visits.put(v);
  await log("info", `Создан осмотр ${v.id}`);
  go({ name: "visit", id: v.id });
  captureGps(v.id);
}

function captureGps(id) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const v = await visits.get(id);
      if (!v || v.status !== "draft") return;
      v.gps = { lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6), acc: Math.round(pos.coords.accuracy), at: new Date(pos.timestamp).toISOString() };
      await visits.put(v);
      if (route.name === "visit" && route.id === id) render();
    },
    async (err) => { await log("warn", `GPS: ${err.message}`); if (route.name === "visit") toast("GPS недоступен: " + err.message); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
  );
}

function thumb(f) {
  const heic = /heic|heif/i.test(f.type + f.name);
  if (f.kind === "photo" && (!heic || /Apple/.test(navigator.vendor))) { // HEIC показывает только Safari
    if (!objectUrls.has(f.id)) objectUrls.set(f.id, URL.createObjectURL(f.blob));
    return `<img class="thumb" src="${objectUrls.get(f.id)}" alt="">`;
  }
  return `<div class="thumb">${KIND_ICON[f.kind] || "◇"}</div>`;
}

async function renderVisit(id) {
  const v = await visits.get(id);
  if (!v) return go({ name: "home" });
  const list = await files.byVisit(id);
  const editable = v.status === "draft";
  const hasErr = list.some((f) => f.status === "error");
  $view.innerHTML = `
    <button class="btn btn-back" id="back">‹ Осмотры</button>
    <h1>${esc(v.property_code)} · осмотр</h1>
    <p class="lead small mono">${esc(v.id)}</p>
    <div class="chips visit-chips">${visitChips(v, list)}</div>

    <label class="field"><span>Объект (код)</span>
      <input id="f-code" class="input" value="${esc(v.property_code)}" ${editable ? "" : "disabled"}></label>
    <label class="field"><span>Адрес</span>
      <input id="f-addr" class="input" value="${esc(v.address)}" placeholder="улица, дом, квартира" ${editable ? "" : "disabled"}></label>
    <label class="field"><span>Комментарий</span>
      <textarea id="f-notes" class="input" ${editable ? "" : "disabled"}>${esc(v.notes)}</textarea></label>
    <div class="card small"><div class="card-row">
      <div><span class="muted">GPS:</span> ${v.gps ? `${v.gps.lat}, ${v.gps.lon} <span class="muted">±${v.gps.acc} м</span>` : `<span class='muted'>${editable ? "определяется…" : "не определён"}</span>`}</div>
      <div class="muted">${esc(v.visit_at.replace("T", " ").slice(0, 16))}</div>
    </div></div>

    ${editable ? `
    <h2>Материалы</h2>
    <div class="grid3">
      <button class="btn tile" id="b-photo"><span class="ico">▣</span>Фото</button>
      <button class="btn tile" id="b-video"><span class="ico">▶</span>Видео</button>
      <button class="btn tile ${recorder ? "btn-rec" : ""}" id="b-voice"><span class="ico">${recorder ? '<span class="rec-dot"></span>' : "◉"}</span>${recorder ? "Стоп" : "Голос"}</button>
    </div>
    <button class="btn btn-ghost" id="b-lib" style="margin-top:10px">Выбрать из галереи / файлов</button>
    <input type="file" id="in-photo" class="hidden-input" accept="image/*" capture="environment">
    <input type="file" id="in-video" class="hidden-input" accept="video/*" capture="environment">
    <input type="file" id="in-lib" class="hidden-input" accept="image/*,image/heic,image/heif,video/*,audio/*" multiple>` : ""}

    <h2>Файлы (${list.length})</h2>
    <div class="card">${list.length ? list.map((f) => `
      <div class="file ${f.status === "cloud" ? "done" : ""}" id="file-${esc(f.id.replace("/", "-"))}">
        ${thumb(f)}
        <div style="min-width:0">
          <div class="file-name">${esc(f.name)}</div>
          <div class="file-meta">${esc(f.type || "?")} · ${fmtSize(f.size)}${f.sha256 ? ` · <span class="mono">${f.sha256.slice(0, 10)}…</span>` : ""}</div>
          ${f.error ? `<div class="file-meta bad">${esc(f.error)}</div>` : ""}
          <div class="bar"><i></i></div>
        </div>
        ${fileStatusChip(f)}
      </div>`).join("") : `<div class="muted small">Добавьте фото, видео или голосовую заметку.</div>`}
    </div>
    ${v.manifest_error ? `<div class="card bad small">Манифест: ${esc(v.manifest_error)}</div>` : ""}
    ${v.pc_error ? `<div class="card bad small">${esc(v.pc_error)}</div>` : ""}

    <div class="bottom-bar"><div class="inner">
      ${editable ? `<button id="send" class="btn btn-gold" ${list.length && !recorder ? "" : "disabled"}>Отправить в VELLOR</button>` : ""}
      ${!editable && v.status !== "pc" ? `<button id="sync" class="btn">${hasErr ? "Повторить отправку" : "Проверить сейчас"}</button>` : ""}
    </div></div>`;

  document.getElementById("back").onclick = () => go({ name: "home" });
  if (editable) {
    const save = async () => {
      const cur = await visits.get(id);
      cur.property_code = document.getElementById("f-code").value.trim() || CONFIG.DEFAULT_PROPERTY;
      cur.address = document.getElementById("f-addr").value.trim();
      cur.notes = document.getElementById("f-notes").value.trim();
      await visits.put(cur);
    };
    ["f-code", "f-addr", "f-notes"].forEach((i) => (document.getElementById(i).onchange = save));
    const pick = (inp) => { document.getElementById(inp).value = ""; document.getElementById(inp).click(); };
    document.getElementById("b-photo").onclick = () => pick("in-photo");
    document.getElementById("b-video").onclick = () => pick("in-video");
    document.getElementById("b-lib").onclick = () => pick("in-lib");
    ["in-photo", "in-video", "in-lib"].forEach((i) => (document.getElementById(i).onchange = async (e) => {
      for (const file of e.target.files) await addFile(id, file);
      render();
    }));
    document.getElementById("b-voice").onclick = () => toggleVoice(id);
    const send = document.getElementById("send");
    if (send) send.onclick = async () => {
      await save();
      const cur = await visits.get(id);
      cur.status = "queued";
      cur.sent_at = new Date().toISOString();
      await visits.put(cur);
      await log("info", `Осмотр ${id} поставлен в очередь (${list.length} файлов)`);
      toast(navigator.onLine ? "Отправка…" : "Нет сети — отправим автоматически, когда появится связь");
      render();
      syncAll("send");
    };
  }
  const syncBtn = document.getElementById("sync");
  if (syncBtn) syncBtn.onclick = async () => { await retryErrors(id); render(); syncAll("manual"); };
}

/** Добавить файл в осмотр: сохраняется на телефоне сразу, SHA-256 считается в фоне. */
export async function addFile(visitId, file) {
  const existing = await files.byVisit(visitId);
  const idx = existing.length ? Math.max(...existing.map((f) => f.idx)) + 1 : 1;
  const name = file.name || `file_${idx}`;
  const rec = {
    id: `${visitId}/${idx}`, visit_id: visitId, idx, name, type: file.type || "", size: file.size,
    kind: kindOf(file.type, name), blob: file, status: "local", sha256: null, added_at: new Date().toISOString(),
    remote_name: `${visitId}__${pad(idx)}_${safeName(name)}`,
  };
  await files.put(rec);
  await log("info", `Добавлен ${name} (${file.type || "?"}, ${fmtSize(file.size)})`);
  sha256Blob(file).then((sha) => files.patch(rec.id, { sha256: sha })).then(() => route.name === "visit" && render())
    .catch((e) => log("error", `SHA-256 ${name}: ${e.message}`));
  return rec;
}

async function toggleVoice(visitId) {
  if (recorder) { recorder.stop(); return; }
  if (!window.MediaRecorder) return toast("Запись звука не поддерживается этим браузером");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return toast("Нет доступа к микрофону: " + e.message, 4000); }
  const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const chunks = [];
  const started = new Date();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = (recorder.mimeType || mime || "audio/mp4").split(";")[0];
    const ext = type.includes("mp4") ? "m4a" : type.includes("webm") ? "webm" : "audio";
    const blob = new Blob(chunks, { type });
    recorder = null;
    const name = `Голос_${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}.${ext}`;
    await addFile(visitId, new File([blob], name, { type }));
    render();
  };
  recorder.start(1000);
  render();
}

// ---------- диагностика ----------

async function renderDiag(token) {
  const checks = [];
  const add = (ok, title, detail = "") => checks.push({ ok, title, detail });
  add(isSecureContext, "Защищённое соединение (HTTPS)", location.origin);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  add(standalone ? true : null, "Запущено как приложение с экрана «Домой»", standalone ? "да" : "нет — откройте через «Поделиться → На экран Домой»");
  add(!!navigator.serviceWorker?.controller ? true : null, "Офлайн-режим (Service Worker)", navigator.serviceWorker?.controller ? "активен" : "активируется после перезапуска");
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    add(persisted ? true : null, "Хранилище защищено от очистки", `${persisted ? "да" : "нет"} · занято ${fmtSize(est?.usage || 0)} из ~${fmtSize(est?.quota || 0)}`);
  } catch (e) { add(false, "Хранилище", e.message); }
  const rec = window.MediaRecorder ? ["audio/mp4", "audio/webm"].filter((m) => MediaRecorder.isTypeSupported(m)).join(", ") : "";
  add(!!rec, "Запись голоса", rec || "не поддерживается");
  add(!!navigator.geolocation, "Геолокация", navigator.geolocation ? "доступна (разрешение запросится при осмотре)" : "нет");
  add(navigator.onLine, "Сеть", navigator.onLine ? "онлайн" : "офлайн");
  const t = token ? `есть · получен ${fmtDate(token.obtained_at)} (${token.how})${token.expires_at ? " · до " + new Date(token.expires_at).toLocaleDateString("ru-RU") : ""}` : "нет";
  add(!!token, "Вход в Яндекс", t);
  const last = await kv.get("last_sync");
  if (last) add(last.ok, "Последняя синхронизация", `${fmtDate(last.at)} · ${last.ok ? "успешно" : last.error}`);
  const logEntries = await recentLog(80);

  $view.innerHTML = `
    <button class="btn btn-back" id="back">‹ Назад</button>
    <h1>Диагностика</h1>
    <p class="lead small">Версия ${esc(APP_VERSION)} · API: <span class="mono">${esc(CONFIG.API_BASE)}</span>${DEV ? " · режим разработки" : ""}</p>
    <div class="card">${checks.map((c) => `
      <div class="check"><div class="${c.ok === true ? "ok" : c.ok === null ? "warn" : "bad"}">${c.ok === true ? "✓" : c.ok === null ? "•" : "✕"}</div>
      <div><div>${esc(c.title)}</div><div class="small muted">${esc(c.detail)}</div></div></div>`).join("")}
    </div>
    <div class="grid2">
      <button class="btn" id="t-hash">Тест SHA-256</button>
      <button class="btn" id="t-persist">Защитить хранилище</button>
    </div>
    <button class="btn btn-gold" id="t-upload" style="margin-top:10px" ${token ? "" : "disabled"}>Тест загрузки в Яндекс.Диск</button>
    <div id="t-out" class="card small mono" style="margin-top:10px" hidden></div>
    <h2>Журнал</h2>
    <div class="card log">${logEntries.map((l) => `<div><span class="${l.level === "error" ? "bad" : l.level === "warn" ? "warn" : "muted"}">${esc(new Date(l.t).toLocaleTimeString("ru-RU"))}</span> ${esc(l.msg)}</div>`).join("") || "<div class='muted'>пусто</div>"}</div>
    ${token ? `<button class="btn btn-ghost btn-danger" id="logout" style="margin-top:14px">Выйти из Яндекса</button>` : ""}`;
  document.getElementById("back").onclick = () => go({ name: "home" });
  const out = document.getElementById("t-out");
  const print = (s) => { out.hidden = false; out.textContent += s + "\n"; };
  document.getElementById("t-hash").onclick = async () => {
    out.textContent = "";
    print(`abc → ${(() => { const s = new Sha256(); s.update(new TextEncoder().encode("abc")); return s.hex(); })()}`);
    const data = crypto.getRandomValues(new Uint8Array(65536 * 3 + 17));
    const big = new Blob([data, data, data, data, data]);
    const mine = await sha256Blob(big);
    const ref = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await big.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("") : "нет crypto.subtle";
    print(`${fmtSize(big.size)}: ${mine === ref ? "совпадает с crypto.subtle ✓" : "НЕ СОВПАДАЕТ ✕"}`);
  };
  document.getElementById("t-persist").onclick = async () => {
    const r = await navigator.storage?.persist?.();
    toast(r ? "Хранилище защищено" : "iOS не дал защиту — добавьте приложение на экран «Домой»");
    render();
  };
  const up = document.getElementById("t-upload");
  if (up) up.onclick = () => uploadTest(print, out);
  const lo = document.getElementById("logout");
  if (lo) lo.onclick = logout;
}

/** Проверка всей цепочки: CORS API → ссылка загрузки → PUT на сервер загрузки → SHA-256 в облаке → повтор без дубля. */
async function uploadTest(print, out) {
  out.textContent = "";
  const yd = await getClient();
  const t0 = performance.now();
  try {
    print("1. API Яндекс.Диска (CORS)…");
    const root = await yd.meta("app:/");
    print(`   ✓ ответ получен, папка приложения ${root ? "есть: " + root.path : "будет создана"}`);
    await yd.mkdir("app:/DIAG");
    const body = new Blob([`VELLOR FIELD upload test ${new Date().toISOString()} ${navigator.userAgent}\n`], { type: "text/plain" });
    const sha = await sha256Blob(body);
    const path = `app:/DIAG/test_${newPackageId()}.txt`;
    print(`2. Загрузка ${path.split("/").pop()} (${body.size} Б)…`);
    const r1 = await uploadVerified(yd, path, body, sha);
    print(`   ✓ ${r1}: SHA-256 в облаке совпал (${sha.slice(0, 12)}…)`);
    print("3. Повторная отправка того же файла…");
    const r2 = await uploadVerified(yd, path, body, sha);
    print(`   ✓ ${r2 === "already" ? "распознан как уже загруженный — дубликат не создан" : r2}`);
    print(`Готово за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
    await log("info", `Тест загрузки успешен: ${path}`);
  } catch (e) {
    print(`✕ ${e.constructor.name}: ${e.message}`);
    if (/CORS|прервана/.test(e.message)) print("   Возможна блокировка CORS на сервере загрузки Яндекса.");
    await log("error", `Тест загрузки: ${e.message}`);
  }
}

// ---------- события ----------

onSyncEvent((e) => {
  if (e.type === "file" && route.name === "visit") {
    const el = document.getElementById(`file-${e.id.replace("/", "-")}`);
    const bar = el?.querySelector(".bar > i");
    if (bar && e.progress != null) bar.style.width = `${Math.round(e.progress * 100)}%`;
    if (e.phase === "done") render();
  } else if (e.type === "visit" || (e.type === "sync" && !e.running)) {
    if (!recorder && route.name !== "diag") render(); // не стирать результаты тестов на экране диагностики
    else updateNet();
  } else updateNet();
});

window.addEventListener("online", () => { updateNet(); syncAll("online"); });
window.addEventListener("offline", updateNet);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && syncAll("resume"));
setInterval(() => document.visibilityState === "visible" && syncAll("timer"), 30000);
document.getElementById("diag-btn").onclick = () => go({ name: route.name === "diag" ? "home" : "diag" });

if ("serviceWorker" in navigator && isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch((e) => log("warn", `Service Worker: ${e.message}`));
}

// Тестовый доступ для автоматических проверок на компьютере (только localhost).
if (DEV) window.__vellor = { addFile, syncAll, visits, files, kv, newVisit, go, retryErrors };

(async () => {
  await handleOAuthReturn();
  if (DEV) {
    const t = new URLSearchParams(location.search).get("dev_token");
    if (t && !(await kv.get("token"))) await kv.set("token", { access_token: t, obtained_at: new Date().toISOString(), how: "dev" });
  }
  render();
  syncAll("start");
})();
