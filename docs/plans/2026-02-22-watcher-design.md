# Design: Watcher + Snapshot Generation + Email Notification

**Дата**: 2026-02-22
**Статус**: Утверждён

## Контекст

Пункты TODO 3, 4, 5 — связанная цепочка: детекция инцидентов, генерация слепков, email-оповещения. Реализуются как единый блок.

## Решения

- **Подход к порогам**: ручные, определяются инженером заранее
- **Хранение правил**: в site.json при устройстве (подход A)
- **Архитектура Watcher**: внутри Node.js процесса (setInterval)
- **Скоуп слепка**: все устройства той же комнаты
- **Email**: nodemailer, локальный SMTP без авторизации (MVP)

---

## 1. Формат правил в site.json

Каждому устройству добавляется массив `rules`. Два типа правил:

```json
{
  "device_sn": "YK0716110141",
  "model": "ACSC101",
  "type": "cooling",
  "room": "hall1",
  "rules": [
    {
      "id": "r1",
      "metric": "airIRSCUnitStatusCoolOutput",
      "type": "discrete",
      "alert_on": [1],
      "severity": "critical",
      "description": "Cooling unit went offline"
    },
    {
      "id": "r2",
      "metric": "airIRSCUnitStatusCoolTemp",
      "type": "threshold",
      "min": 18,
      "max": 35,
      "severity": "warning",
      "description": "Supply air temperature out of range"
    }
  ]
}
```

**Поля правила:**
- `id` — уникальный в пределах устройства (r1, r2...)
- `metric` — имя метрики (совпадает с field name в Telegraf конфиге)
- `type` — `discrete` или `threshold`
- Для `discrete`: `alert_on` — массив значений-триггеров (например `[1]` = offline)
- Для `threshold`: `min`/`max` — за пределами = алярм (любое из двух опционально)
- `severity` — `critical` или `warning` (для информации в слепке и email)
- `description` — человекочитаемое описание для email

---

## 2. Цикл работы Watcher

Watcher — класс внутри Node.js процесса, запускается/останавливается через API.

**Цикл (каждые 30 секунд):**

```
1. Прочитать rules из site.json (все устройства с rules.length > 0)
2. Для каждого правила — запросить последнее значение метрики из InfluxDB
3. Проверить:
   - discrete: текущее значение ∈ alert_on? → инцидент
   - threshold: значение < min или > max? → инцидент
4. Сравнить с предыдущим состоянием:
   - ok → alert = НОВЫЙ инцидент → триггер слепка
   - alert → alert = уже знаем, игнорируем
   - alert → ok = восстановление (логируем, слепок не делаем)
5. При новом инциденте → Snapshot Generator → Notifier
```

**Частота проверки** — 30 сек по умолчанию, настраивается. Отдельно от polling interval Telegraf.

**Хранение состояния** — в памяти: `{ "deviceSN_metric": "ok"|"alert" }`. При рестарте сервера состояние сбрасывается — первая проверка покажет текущее состояние. Если аномальное — сработает триггер. Лучше лишний слепок чем пропущенный инцидент.

**API управления:**
- `POST /api/watcher/start` — запустить
- `POST /api/watcher/stop` — остановить
- `GET /api/watcher/status` — состояние (running/stopped, последняя проверка, активные алярмы)

---

## 3. Запрос данных из InfluxDB

Flux-запросы к `http://influxdb:8086/api/v2/query`.

**Запрос последних значений (оптимизированный — один на measurement):**

```flux
from(bucket: "snmp-data")
  |> range(start: -5m)
  |> filter(fn: (r) => r["_measurement"] == "cooling")
  |> last()
  |> pivot(rowKey: ["device_sn"], columnKey: ["_field"], valueColumn: "_value")
```

Один запрос — все устройства типа cooling, все метрики. Watcher группирует по measurement и делает по одному запросу на тип. При 50 устройствах — 3-4 запроса вместо 200.

**Запрос данных для слепка (все данные комнаты за snapshotWindow):**

```flux
from(bucket: "snmp-data")
  |> range(start: -48h)
  |> filter(fn: (r) => r["device_sn"] == "YK0716110141" or r["device_sn"] == "YK0716110142")
```

Результат конвертируется в InfluxDB Line Protocol для файла `data.lp`.

**Подключение:** InfluxDB из docker-compose — `http://influxdb:8086`, org `bkns`, bucket `snmp-data`, токен из конфига.

Если данных за 5 минут нет (устройство не отвечает) — для MVP пропускаем, не аллертим.

---

## 4. Веб-интерфейс для правил

Новая секция **Watcher Rules** в табе Site Setup, под Polling Settings.

Для каждого устройства — таблица правил с возможностью добавлять/удалять:

| Metric | Type | Min | Max | Alert On | Severity | |
|--------|------|-----|-----|----------|----------|----|
| coolOutput | discrete | — | — | 1 | critical | [x] |
| coolTemp | threshold | 18 | 35 | — | warning | [x] |

[+ Add Rule] — инлайн-форма: metric name, тип (discrete/threshold), поля зависят от типа.

Внизу секции — статус Watcher, интервал проверки, кнопки Start/Stop.

Правила сохраняются через `PUT /api/site/devices/:id` (поле `rules`).

---

## 5. Flow при инциденте

```
Watcher: coolOutput = 1 (alert_on: [1]), предыдущее = "ok"
  │
  ├─ 1. Обновить состояние: "ok" → "alert"
  │
  ├─ 2. Snapshot Generator:
  │     ├─ Определить комнату устройства (hall1)
  │     ├─ Найти все устройства hall1 в site.json
  │     ├─ Flux-запрос: данные hall1 за snapshotWindow (48ч)
  │     ├─ Сформировать meta.json (инцидент, устройства, период)
  │     ├─ Записать data.lp (InfluxDB Line Protocol)
  │     └─ Упаковать в tar.gz
  │
  ├─ 3. Обновить lastSnapshotTime в site.json
  │
  └─ 4. Email Notifier:
        ├─ Отправить на site.contact
        ├─ Тема: "[BKNS] CRITICAL: YK0716110141 — Cooling unit went offline"
        ├─ Тело: устройство, комната, время, описание
        └─ Вложение: snapshot_*.tar.gz
```

**SMTP конфигурация** в site.json:

```json
"site": {
  "contact": "ivanov@customer.kz",
  "smtp": {
    "host": "mail.customer.kz",
    "port": 25,
    "secure": false
  }
}
```

Для MVP без авторизации SMTP (внутренняя сеть ЦОД, порт 25).

---

## 6. Новые модули

| Модуль | Файл | Назначение |
|--------|------|-----------|
| Watcher | `lib/watcher.js` | Цикл проверки, состояние, детекция переходов ok→alert |
| Snapshot Generator | `lib/snapshot.js` | Flux-запрос данных комнаты, формирование tar.gz |
| Email Notifier | `lib/notifier.js` | nodemailer, отправка email с вложением |

**Зависимости:** `nodemailer` (email), `tar` или встроенный `zlib` + `tar-stream` (архивация).
