# Design: Multi-Device Model + Snapshot Format

**Дата**: 2026-02-22
**Статус**: Утверждён

## Контекст

Текущий `settings.json` хранит конфиг одного устройства. Нужна модель для десятков устройств, сгруппированных по комнатам, и формат слепка для передачи данных инцидента в Vicom Plus.

## Решения

- **Формат слепка**: InfluxDB Line Protocol в tar.gz (подход A)
- **Анализ**: импорт в InfluxDB → Grafana на центральном сервере Vicom Plus
- **Доставка**: email от представителя заказчика
- **Масштаб**: от 5 до 100+ устройств на площадке

---

## 1. Модель данных: site.json

Заменяет `settings.json`. Реестр всей площадки.

```json
{
  "site": {
    "id": "customerX-dc1",
    "name": "ЦОД Заказчик X — Площадка 1",
    "contact": "ivanov@customer.kz"
  },
  "rooms": [
    { "id": "hall1", "name": "Зал 1" },
    { "id": "hall2", "name": "Зал 2" }
  ],
  "devices": [
    {
      "id": "cooling_yk0716110141",
      "device_sn": "YK0716110141",
      "model": "ACSC101",
      "type": "cooling",
      "room": "hall1",
      "ip": "192.168.2.1",
      "snmp": { "version": "2c", "community": "public" },
      "measurement": "cooling",
      "config_file": "device_yk0716110141.conf"
    }
  ],
  "polling": {
    "interval": 5,
    "snapshotWindow": 48
  },
  "lastSnapshotTime": null
}
```

**Ключевые поля:**
- `site.contact` — email для оповещений
- `rooms` — логическая группировка по залам/комнатам
- `devices[].room` — привязка устройства к комнате
- `polling.interval` — частота опроса (1, 5, 10 сек)
- `polling.snapshotWindow` — часы данных вокруг инцидента в слепке
- `lastSnapshotTime` — метка последнего слепка (определяет период следующего)

**Миграция:** при первом запуске, если есть старый `settings.json`, автоматически создаётся `site.json` с одним device и room `default`.

---

## 2. Формат слепка (snapshot)

tar.gz архив с двумя файлами:

```
snapshot_customerX-dc1_2026-02-22T12-30-00Z.tar.gz
├── meta.json     # Метаданные инцидента (~1-5 KB)
└── data.lp       # Time series в InfluxDB Line Protocol
```

### meta.json

```json
{
  "version": 1,
  "snapshot_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-02-22T12:30:00Z",
  "site": {
    "id": "customerX-dc1",
    "name": "ЦОД Заказчик X — Площадка 1"
  },
  "period": {
    "from": "2026-02-15T00:00:00Z",
    "to": "2026-02-22T12:30:00Z"
  },
  "incident": {
    "device_sn": "YK0716110141",
    "device_model": "ACSC101",
    "room": "hall1",
    "trigger": "discrete_change",
    "description": "airIRSCUnitStatusCoolOutput changed from 2 (online) to 1 (offline)"
  },
  "devices_included": [
    { "device_sn": "YK0716110141", "model": "ACSC101", "type": "cooling" },
    { "device_sn": "YK0716110142", "model": "ACSC101", "type": "cooling" },
    { "device_sn": "ABC123", "model": "Smart-UPS 3000", "type": "ups" }
  ]
}
```

`devices_included` — все устройства той же комнаты (контекст инцидента).

### data.lp

Стандартный InfluxDB Line Protocol:

```
cooling,device_sn=YK0716110141,room=hall1,site=customerX-dc1 airIRSCUnitStatusCoolOutput=2i 1708000000000000000
cooling,device_sn=YK0716110141,room=hall1,site=customerX-dc1 airIRSCUnitStatusCoolOutput=1i 1708007200000000000
ups,device_sn=ABC123,room=hall1,site=customerX-dc1 upsOutputLoad=45.2 1708007200000000000
```

### Импорт на центральном сервере

```bash
tar -xzf snapshot_*.tar.gz
influx write --bucket snapshots --file data.lp
```

---

## 3. Калькулятор размеров

Веб-интерфейс: секция на Dashboard для оценки дискового пространства и размера слепка.

### Входные параметры

| Параметр | Ввод | По умолчанию |
|----------|------|-------------|
| Количество устройств | числовое поле | 10 |
| Среднее кол-во метрик на устройство | числовое поле | 12 |
| Интервал опроса | select: 1с / 5с / 10с | 5с |
| Период хранения в InfluxDB | select: 7д / 30д / 90д / 365д | 30д |
| Окно слепка (часов) | числовое поле | 48 |

### Формулы

```
points_per_day = devices * metrics * (86400 / interval)
bytes_per_point = 100
raw_per_day = points_per_day * bytes_per_point
influx_per_day = raw_per_day * 0.15          // InfluxDB ~6-7x compression
influx_total = influx_per_day * retention_days

snapshot_points = devices * metrics * (snapshot_hours * 3600 / interval)
snapshot_raw = snapshot_points * bytes_per_point
snapshot_gzip = snapshot_raw / 15             // gzip ~15x compression
```

### Индикация размера слепка

- Зелёный (< 10 MB) — отлично для email
- Жёлтый (10-25 MB) — допустимо для email
- Красный (> 25 MB) — рекомендуется уменьшить окно или интервал

---

## 4. Сквозной Data Flow

### Фаза 1: Настройка на объекте (инженер Vicom Plus)

1. Заполняет Site Info (название, контакт)
2. Создаёт комнаты
3. Сканирует устройства через SNMP
4. Для каждого: выбирает метрики, указывает комнату, сохраняет .conf
5. Запускает Калькулятор → проверяет размеры
6. Запускает Telegraf → данные текут в InfluxDB

### Фаза 2: Штатная работа (автоматически)

Telegraf опрашивает все устройства → пишет в InfluxDB.

### Фаза 3: Инцидент

Watcher периодически запрашивает InfluxDB, сравнивает дискретные значения. При изменении (online → offline) → триггер.

### Фаза 4: Генерация слепка

Запрашивает данные всех устройств комнаты за период. Формирует meta.json + data.lp → tar.gz. Обновляет lastSnapshotTime.

### Фаза 5: Оповещение

Email представителю заказчика: описание инцидента + snapshot.tar.gz во вложении. Отправка через локальный SMTP.

### Фаза 6: Анализ в Vicom Plus

Инженер получает файл → `influx write` → смотрит в Grafana.

---

## 5. Новые модули

| Модуль | Файл | Назначение |
|--------|------|-----------|
| Site Manager | `lib/site-manager.js` | CRUD site.json, миграция из settings.json |
| Watcher | `lib/watcher.js` | Мониторинг InfluxDB, детекция инцидентов |
| Snapshot Generator | `lib/snapshot.js` | Запрос данных, формирование tar.gz |
| Email Notifier | `lib/notifier.js` | Отправка email с вложением |
| Calculator API | в `server.js` | Эндпоинт для расчёта размеров |
