# CLAUDE.md — bkns-snmp

## Бизнес-контекст

**Vicom Plus** — сервисная компания, обслуживающая инженерное оборудование дата-центров (кондиционеры, ИБП, PDU, сенсоры).

**Проблема**: Заказчики присылают сервисные заявки без указания конкретной единицы оборудования (серийный номер, порядковый номер). Невозможно определить:
- какое именно устройство требует ремонта
- «историю болезни» устройства — что предшествовало ошибке
- контекст инцидента (состояние соседнего оборудования в момент сбоя)

Единственный источник информации — отчёты инженеров из предыдущих выездов.

**Ограничение**: Security-политики заказчиков запрещают подключение серверов ЦОД к интернету. Софт работает **только локально** в дата-центре.

## Концепция решения

BKNS-сервер устанавливается локально в дата-центре заказчика и выполняет:

1. **Непрерывный сбор данных** — Telegraf опрашивает всё SNMP-оборудование, пишет time series в InfluxDB
2. **Два типа данных**:
   - **Дискретные** — текстовые/enum значения из SNMP OID (пример: кондиционер online=2, offline=1). Позволяют расследовать инциденты, видя состояние всей группы оборудования
   - **Числовые** — температура, влажность, напряжение, наработка и т.д.
3. **Слепки (snapshots)** — при возникновении инцидента система формирует «слепок»:
   - текущее состояние оборудования
   - история работы между предыдущим слепком и текущим
   - данные time series за период
4. **Оповещение** — ответственный представитель заказчика получает email с описанием инцидента и файлом слепка
5. **Анализ в Vicom Plus** — центральный сервер компании получает слепок (вручную или через заказчика), расшифровывает и анализирует, предоставляя инженеру полную картину для решения проблемы

**Итого**: Локальный мониторинг → слепок при инциденте → передача в сервисную компанию → анализ и ремонт.

## Текущее состояние проекта

Реализован **snmp-viewer** — инструмент для сканирования оборудования через SNMP, визуализации OID-деревьев, управления MIB-файлами и генерации TOML-конфигов для Telegraf.

**Реализовано**:
- Multi-device модель (`site.json`) с комнатами, устройствами, polling настройками
- Автоматическая миграция из `settings.json` → `site.json` при первом запуске
- Таб Site Setup с калькулятором размеров хранилища и слепков
- Автоматическая регистрация устройств в site.json при сохранении Telegraf конфига
- Path traversal защита в `/api/telegraf/save`
- **Watcher** — детекция инцидентов (discrete/threshold правила, state machine ok→alert)
- **Snapshot Generator** — tar.gz слепки (meta.json + data.lp) при инцидентах, скоуп: комната
- **Email Notifier** — nodemailer через локальный SMTP, вложение snapshot
- **Watcher Rules UI** — управление правилами, контроль watcher, список слепков

**Ещё не реализовано**: центральный сервер анализа слепков.

**Дизайн-документы**:
- `docs/plans/2026-02-22-multi-device-snapshot-design.md`
- `docs/plans/2026-02-22-watcher-design.md`
- `docs/plans/2026-02-22-watcher-implementation.md`

## Структура проекта

```
bkns-snmp/
├── snmp-viewer/              # Основное веб-приложение
│   ├── server.js             # Express-сервер, SNMP walk, Telegraf management
│   ├── lib/mib-manager.js    # Загрузка/парсинг MIB, трансляция OID → имена
│   ├── public/
│   │   ├── index.html        # SPA (~4000 строк, vanilla JS/HTML/CSS)
│   │   └── fixed-layout.css
│   ├── mibs/                 # Загруженные MIB-файлы
│   ├── telegraf.d/           # Сгенерированные конфиги Telegraf
│   ├── lib/site-manager.js   # CRUD site.json, миграция из settings.json
│   ├── lib/watcher.js        # Watcher — детекция инцидентов (discrete/threshold)
│   ├── lib/influx-client.js  # InfluxDB v2 Flux API клиент + CSV парсер
│   ├── lib/snapshot.js       # Генерация tar.gz слепков (meta.json + data.lp)
│   ├── lib/notifier.js       # Email уведомления через nodemailer
│   ├── site.json             # Реестр площадки (devices, rooms, polling, rules)
│   ├── settings.json         # Legacy настройки (мигрируется в site.json)
│   ├── Dockerfile            # Node.js 20 + Telegraf + snmp-mibs-downloader
│   ├── Dockerfile.telegraf   # Telegraf с MIB-ами (не используется в compose)
│   ├── docker-compose.yml    # snmp-viewer + InfluxDB 2.7 + Grafana
│   ├── test-mib.js           # Тест MIB-менеджера
│   ├── test-parsing.js       # Тест парсинга MIB
│   ├── test-site-manager.js  # Тесты SiteManager (35 assertions)
│   ├── test-watcher.js       # Тесты Watcher (33 assertions)
│   ├── test-influx-client.js # Тесты InfluxDB Client (47 assertions)
│   ├── test-snapshot.js      # Тесты Snapshot Generator (31 assertions)
│   ├── test-notifier.js      # Тесты Notifier (13 assertions)
│   ├── snapshots/            # Сгенерированные слепки (.tar.gz)
│   └── package.json
├── snmp_results/             # Сохранённые результаты SNMP-сканов (txt, xml)
└── tomls/                    # Готовые Telegraf конфиги устройств
    └── device_yk0716110141.conf  # Пример: APC ACSC101 cooling unit
```

## Стек

- **Backend**: Node.js 20, Express 4, net-snmp 3.8, multer 2, nodemailer 8, tar-stream 3
- **Frontend**: Vanilla HTML/CSS/JS (single-page, Inter font, CSS variables)
- **Инфраструктура**: Docker Compose (snmp-viewer:3000, InfluxDB:8086, Grafana:3001)
- **Мониторинг**: Telegraf → InfluxDB v2 → Grafana

## Команды

```bash
cd snmp-viewer

npm install          # Зависимости
npm start            # Продакшен (порт 3000)
npm run dev          # Разработка (--watch)

docker compose up -d --build   # Полный стек
```

## API-эндпоинты (server.js)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/snmp-walk` | SNMP walk (target, oid, version, community, mibs, v3_*) |
| GET | `/api/mibs` | Список MIB-файлов |
| GET | `/api/mib-tree` | Дерево OID из загруженных MIB |
| GET | `/api/mibs/active` | Загруженные модули |
| POST | `/api/mibs/load` | Загрузить MIB в память |
| POST | `/api/mibs/unload` | Выгрузить модуль |
| POST | `/api/upload-mib` | Загрузить MIB-файл (multipart) |
| DELETE | `/api/mibs` | Удалить MIB-файлы |
| GET/POST | `/api/settings` | Чтение/сохранение настроек устройства (legacy) |
| GET | `/api/site` | Полные данные site.json |
| PUT | `/api/site/info` | Обновить site info (id, name, contact) |
| POST | `/api/site/rooms` | Добавить комнату |
| DELETE | `/api/site/rooms/:id` | Удалить комнату |
| POST | `/api/site/devices` | Добавить устройство |
| PUT | `/api/site/devices/:id` | Обновить устройство |
| DELETE | `/api/site/devices/:id` | Удалить устройство |
| PUT | `/api/site/polling` | Обновить polling настройки |
| POST | `/api/calculator` | Расчёт размеров хранилища и слепков |
| POST | `/api/site/devices/:id/rules` | Добавить правило к устройству |
| DELETE | `/api/site/devices/:id/rules/:ruleId` | Удалить правило |
| POST | `/api/watcher/start` | Запустить Watcher |
| POST | `/api/watcher/stop` | Остановить Watcher |
| GET | `/api/watcher/status` | Статус Watcher (running, lastCheck, activeAlerts) |
| GET | `/api/snapshots` | Список слепков |
| GET | `/api/snapshots/:filename` | Скачать слепок |
| GET | `/api/equipment` | Список оборудования из telegraf.d и settings |
| POST | `/api/equipment/status` | Проверка онлайн-статуса по IP (sysUpTime) |
| POST | `/api/telegraf/save` | Сохранить конфиг Telegraf |
| POST | `/api/telegraf/start` | Запустить Telegraf |
| POST | `/api/telegraf/stop` | Остановить Telegraf |
| GET | `/api/telegraf/status` | Статус и логи Telegraf |
| GET | `/api/telegraf/configs` | Список конфигов в telegraf.d |
| GET | `/api/telegraf/configs/:filename` | Содержимое конфига |
| DELETE | `/api/telegraf/configs/:filename` | Удалить конфиг |

## Ключевые модули

### MibManager (lib/mib-manager.js)
- Обёртка над `net-snmp.createModuleStore()`
- Загружает MIB-файлы (.mib, .txt, .my) с разрешением зависимостей
- Трансляция OID ↔ символические имена
- Поддержка enum-маппинга из SYNTAX
- Построение дерева OID (`getMibTree()`)
- Системные MIB-пути: `/usr/share/snmp/mibs`, `/var/lib/mibs/ietf`, `/var/lib/mibs/iana`

### SiteManager (lib/site-manager.js)
- CRUD для site.json: площадка (id, name, contact, smtp), комнаты, устройства, polling
- Управление правилами: `addRule()`, `removeRule()`, `getDevicesWithRules()`
- Автоматическая миграция из legacy `settings.json`
- Валидация: interval ∈ {1, 5, 10}, уникальность room/device/rule id
- Защита: нельзя удалить комнату с привязанными устройствами
- Генерация device id: `${type}_${sn_lowercase}`, config_file: `device_${sn}.conf`

### Watcher (lib/watcher.js)
- Детекция инцидентов через setInterval (по умолчанию 30 сек)
- Читает правила из site.json, запрашивает InfluxDB
- Два типа: discrete (alert_on) и threshold (min/max)
- State machine: ok→alert = incident, alert→alert = ignore, alert→ok = recovery
- EventEmitter: emits 'incident' с device_sn, measurement, room, rule, value

### InfluxClient (lib/influx-client.js)
- Обёртка для InfluxDB v2 Flux API через HTTP
- `buildLastValuesQuery(measurement)` — последние значения, pivot по device_sn
- `buildRangeQuery(deviceSNs, hours)` — данные за период для слепков
- `parseCSV(csv)` — парсинг InfluxDB annotated CSV

### SnapshotGenerator (lib/snapshot.js)
- Генерация tar.gz слепков при инциденте
- Скоуп: все устройства той же комнаты (не весь сайт)
- Формат: meta.json (инцидент, устройства, период) + data.lp (raw CSV от InfluxDB)
- Файлы: `snapshots/snapshot_{siteId}_{timestamp}.tar.gz`

### Notifier (lib/notifier.js)
- Email через nodemailer (локальный SMTP, без авторизации для MVP)
- Тема: `[BKNS] {SEVERITY}: {device_sn} — {description}`
- Вложение: snapshot tar.gz

### processToTables (server.js:565)
- Эвристическая группировка OID в таблицы
- Алгоритм: OID → колонка (parent) → таблица (parent колонки) → строки (по индексу)

### Frontend (public/index.html)
- SPA с табами: Site Setup, Dashboard, Scan, Config, MIBs, Telegraf
- Site Setup: site info, SMTP, rooms, devices, polling, storage calculator
- Watcher Rules UI: таблицы правил per device, inline add/remove
- Watcher Control: статус (running/stopped), Start/Stop, active alerts
- Snapshots: список с download-ссылками
- Поддержка i18n (en/kk)
- MIB Browser (дерево OID с поиском)
- Генерация Telegraf TOML из UI
- Экспорт в CSV/TXT
- Dual scrollbars для широких таблиц

## Формат данных

### site.json (основной реестр площадки)
```json
{
  "site": { "id": "customerX-dc1", "name": "ЦОД Заказчик X", "contact": "admin@customer.kz" },
  "rooms": [{ "id": "hall1", "name": "Зал 1" }],
  "devices": [{
    "id": "cooling_yk0716110141", "device_sn": "YK0716110141", "model": "ACSC101",
    "type": "cooling", "room": "hall1", "ip": "192.168.2.1",
    "snmp": { "version": "2c", "community": "public" },
    "measurement": "cooling", "config_file": "device_yk0716110141.conf"
  }],
  "polling": { "interval": 5, "snapshotWindow": 48 },
  "lastSnapshotTime": null
}
```

### settings.json (legacy, мигрируется в site.json)
```json
{
  "measurement": "cooling",
  "tags": [{ "key": "device_sn", "value": "YK0716110141" }],
  "fields": [{ "key": "airIRSCUnitStatusCoolOutput", "value": "1.3.6.1.4.1.318.1.1.13.3.4.1.2.2.0" }],
  "tableMappings": [],
  "agentConfig": "[agent]\\n  interval = \"5s\"...",
  "outputConfig": "[[outputs.influxdb_v2]]\\n  urls = [\"http://influxdb:8086\"]..."
}
```

### Telegraf TOML (tomls/*.conf)
```toml
[[inputs.snmp]]
  agents = ["192.168.2.1"]
  version = 2
  community = "public"
  name = "cooling"
  [inputs.snmp.tags]
    device_sn = "YK0716110141"
  [[inputs.snmp.field]]
    name = "airIRSCUnitStatusCoolOutput"
    oid = "1.3.6.1.4.1.318.1.1.13.3.4.1.2.2.0"
```

### InfluxDB Line Protocol
```
cooling,device_sn=YK0716110141 airIRSCUnitStatusCoolOutput=value timestamp
```

## Docker Compose

- **snmp-viewer** (порт 3000): Node.js + Telegraf, volumes маппят mibs/, public/, lib/, server.js, settings.json, ../tomls → telegraf.d
- **InfluxDB** (порт 8086): org=bkns, bucket=snmp-data, token=my-super-secret-auth-token
- **Grafana** (порт 3001): admin/admin

## Целевое оборудование

Сейчас настроено для APC InRow Cooling (ACSC101), OID-ветка `1.3.6.1.4.1.318.1.1.13` (APC PowerNet). Поддерживается любое SNMP-оборудование: UPS, PDU, cooling, сенсоры.

## Правила разработки

- Frontend — один файл `index.html`, без билд-процесса
- Стили через CSS variables в `:root`
- Новый функционал по возможности добавлять в существующие файлы
- Конфиги Telegraf — TOML формат, по одному файлу на устройство
- Тег `device_sn` (серийный номер) обязателен для каждого устройства
