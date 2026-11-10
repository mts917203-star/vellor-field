// Публичная конфигурация. Секретов здесь нет и быть не должно:
// Client ID приложения Яндекс OAuth — публичный идентификатор (как логин),
// токен получает сам пользователь на телефоне и он хранится только на телефоне.

export const APP_VERSION = "0.2.0";
export const BUILD = "10.11 05:29"; // проставляется при публикации (tools/build_pages.py)

export const CONFIG = {
  CLIENT_ID: "c267073e62ae42e498db4f7345baefd6", // заполняется после регистрации приложения на oauth.yandex.ru
  API_BASE: "https://cloud-api.yandex.net",
  SCOPE: "cloud_api:disk.app_folder", // только папка «Приложения/<название>» — минимальный доступ
  INBOX: "app:/INBOX",
  STATUS: "app:/STATUS",
  OBJECTS: "app:/OBJECTS",
  DEFAULT_PROPERTY: "VL-0001",
};

// Режим разработки: только на localhost можно подменить API (локальный имитатор Яндекс.Диска).
export const DEV = ["localhost", "127.0.0.1"].includes(location.hostname);
if (DEV) {
  const p = new URLSearchParams(location.search);
  if (p.get("api")) CONFIG.API_BASE = p.get("api");
}
