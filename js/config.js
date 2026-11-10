// Публичная конфигурация. Секретов здесь нет и быть не должно:
// Client ID приложения Яндекс OAuth — публичный идентификатор (как логин),
// токен получает сам пользователь на телефоне и он хранится только на телефоне.

export const APP_VERSION = "0.1.0-proto";

export const CONFIG = {
  CLIENT_ID: "", // заполняется после регистрации приложения на oauth.yandex.ru
  API_BASE: "https://cloud-api.yandex.net",
  SCOPE: "cloud_api:disk.app_folder", // только папка «Приложения/<название>» — минимальный доступ
  INBOX: "app:/INBOX",
  STATUS: "app:/STATUS",
  DEFAULT_PROPERTY: "VL-0001",
};

// Режим разработки: только на localhost можно подменить API (локальный имитатор Яндекс.Диска).
export const DEV = ["localhost", "127.0.0.1"].includes(location.hostname);
if (DEV) {
  const p = new URLSearchParams(location.search);
  if (p.get("api")) CONFIG.API_BASE = p.get("api");
}
