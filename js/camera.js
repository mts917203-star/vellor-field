// Видео внутри приложения (Full HD): стандартная камера Safari через <input capture>
// сжимает ролик до 480×360, поэтому снимаем сами — getUserMedia + MediaRecorder.

const pad = (n) => String(n).padStart(2, "0");

export function videoSupport() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return null;
  return ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

/**
 * Открывает полноэкранную камеру. Возвращает Promise<File|null> (null — отмена).
 * Пока идёт запись, экран не гаснет (Wake Lock, если доступен).
 */
export function recordVideo() {
  return new Promise(async (resolve) => {
    const mime = videoSupport();
    if (!mime) return resolve(null);
    const root = document.createElement("div");
    root.className = "cam";
    root.innerHTML = `
      <video class="cam-preview" playsinline muted autoplay></video>
      <div class="cam-top"><span class="cam-res">…</span><span class="cam-timer">00:00</span></div>
      <div class="cam-bottom">
        <button class="cam-btn cam-close" aria-label="Закрыть">✕</button>
        <button class="cam-rec" aria-label="Запись"><i></i></button>
        <span class="cam-spacer"></span>
      </div>`;
    document.body.appendChild(root);
    const $v = root.querySelector("video");
    const $rec = root.querySelector(".cam-rec");
    const $timer = root.querySelector(".cam-timer");
    let stream, rec, chunks = [], started, tick, lock;

    const cleanup = async (file) => {
      clearInterval(tick);
      stream?.getTracks().forEach((t) => t.stop());
      try { await lock?.release(); } catch { /* ок */ }
      root.remove();
      resolve(file);
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (e) {
      alert("Нет доступа к камере: " + e.message);
      return cleanup(null);
    }
    $v.srcObject = stream;
    const s = stream.getVideoTracks()[0].getSettings();
    root.querySelector(".cam-res").textContent = `${s.width || "?"}×${s.height || "?"}`;

    root.querySelector(".cam-close").onclick = () => {
      if (rec && rec.state === "recording" && !confirm("Остановить и не сохранять видео?")) return;
      if (rec && rec.state === "recording") { rec.onstop = null; rec.stop(); }
      cleanup(null);
    };

    $rec.onclick = async () => {
      if (!rec) {
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = () => {
          const type = mime.split(";")[0];
          const ext = type.includes("mp4") ? "mp4" : "webm";
          const name = `Видео_${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}.${ext}`;
          cleanup(new File(chunks, name, { type }));
        };
        rec.start(1000);
        started = new Date();
        root.classList.add("recording");
        tick = setInterval(() => {
          const sec = Math.floor((Date.now() - started) / 1000);
          $timer.textContent = `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
        }, 500);
        try { lock = await navigator.wakeLock?.request("screen"); } catch { /* не критично */ }
      } else if (rec.state === "recording") {
        rec.stop();
      }
    };
  });
}
