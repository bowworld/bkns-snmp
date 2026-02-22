# TODO — bkns-snmp

## Критические исправления

- [x] **1. Закрыть уязвимость path traversal в `/api/telegraf/save`** ✅
  - Сервер теперь берёт только basename, санитизирует имя файла, пишет строго в `telegraf.d/`
  - Фронтенд отправляет `filename` вместо полного `path`
  - Проверено: `../../../etc/passwd` → rejected, `/etc/evil.conf` → пишет в `telegraf.d/evil.conf`

## Архитектура продукта

- [x] **2. Спроектировать модель данных multi-device + формат слепка** ✅
  - `site.json` — реестр площадки (site info, rooms, devices, polling)
  - `lib/site-manager.js` — CRUD модуль с миграцией из settings.json
  - API: 9 новых эндпоинтов `/api/site/*` + `/api/calculator`
  - Фронтенд: таб Site Setup (формы, таблицы, калькулятор размеров)
  - Автоматическая регистрация устройств при сохранении Telegraf конфига
  - Формат слепка спроектирован: tar.gz (meta.json + data.lp в InfluxDB Line Protocol)
  - Дизайн-документ: `docs/plans/2026-02-22-multi-device-snapshot-design.md`

- [x] **3. Реализовать детекцию инцидентов** ✅
  - Watcher (`lib/watcher.js`) — setInterval проверка InfluxDB каждые 30 сек
  - Два типа правил: discrete (alert_on) и threshold (min/max)
  - State machine: ok→alert = инцидент, alert→alert = ignore, alert→ok = recovery
  - Правила хранятся в site.json при устройстве (поле `rules`)
  - Дизайн: `docs/plans/2026-02-22-watcher-design.md`
  - Тесты: 33 assertions (`test-watcher.js`)

- [x] **4. Генерация слепков (snapshots)** ✅
  - SnapshotGenerator (`lib/snapshot.js`) — tar.gz (meta.json + data.lp)
  - Скоуп слепка: все устройства той же комнаты
  - InfluxDB Client (`lib/influx-client.js`) — Flux запросы, CSV парсер
  - Тесты: 78 assertions (`test-snapshot.js`, `test-influx-client.js`)

- [x] **5. Оповещения** ✅
  - Notifier (`lib/notifier.js`) — nodemailer, локальный SMTP
  - Email: тема с severity и device_sn, тело с деталями, вложение snapshot
  - SMTP конфигурация в site.json (site.smtp: host, port, secure)
  - Тесты: 13 assertions (`test-notifier.js`)

## Качество кода

- [ ] **6. Убрать захардкоженные секреты из docker-compose.yml**
  - Вынести токены, пароли в `.env` файл

- [ ] **7. Добавить аутентификацию на веб-интерфейс**
  - Любой в сети ЦОД может управлять системой

- [ ] **8. Добавить таймаут на SNMP walk**
  - Сейчас `session.subtree()` может висеть бесконечно

- [ ] **9. Улучшить Telegraf management**
  - Watchdog / автоперезапуск при падении
  - Персистентные логи

- [ ] **10. Автоматические тесты**
  - Хотя бы для MibManager и processToTables
  - ✅ SiteManager — 35 assertions (`test-site-manager.js`)
  - ✅ Watcher — 33 assertions (`test-watcher.js`)
  - ✅ InfluxDB Client — 47 assertions (`test-influx-client.js`)
  - ✅ Snapshot Generator — 31 assertions (`test-snapshot.js`)
  - ✅ Notifier — 13 assertions (`test-notifier.js`)
