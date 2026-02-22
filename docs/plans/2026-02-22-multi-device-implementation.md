# Multi-Device Model + Calculator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Заменить одноустройственный settings.json на multi-device site.json с комнатами, добавить калькулятор размеров, обновить API и фронтенд.

**Architecture:** Новый модуль `lib/site-manager.js` управляет site.json (CRUD site/rooms/devices). Существующий server.js получает новые эндпоинты. Фронтенд — новый таб Site Setup с калькулятором. Миграция из settings.json автоматическая при первом запуске.

**Tech Stack:** Node.js, Express, vanilla JS/HTML/CSS (существующий стек, без новых зависимостей)

---

### Task 1: SiteManager — базовый модуль

**Files:**
- Create: `snmp-viewer/lib/site-manager.js`
- Create: `snmp-viewer/test-site-manager.js`

**Step 1: Создать test-site-manager.js**

```js
const path = require('path');
const fs = require('fs');
const os = require('os');

// Используем временную директорию для тестов
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkns-test-'));
const siteFile = path.join(testDir, 'site.json');

// Подменяем путь перед загрузкой модуля
const SiteManager = require('./lib/site-manager');

function assert(condition, msg) {
    if (!condition) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
}

// Test 1: Создание нового site.json с дефолтами
const sm = new SiteManager(siteFile);
const site = sm.getSite();
assert(site.site.id === '', 'site.id is empty by default');
assert(Array.isArray(site.rooms), 'rooms is array');
assert(Array.isArray(site.devices), 'devices is array');
assert(site.polling.interval === 5, 'default interval is 5');
assert(site.polling.snapshotWindow === 48, 'default snapshotWindow is 48');

// Test 2: Обновление site info
sm.updateSiteInfo({ id: 'test-dc1', name: 'Test DC', contact: 'test@test.kz' });
const updated = sm.getSite();
assert(updated.site.id === 'test-dc1', 'site.id updated');
assert(updated.site.contact === 'test@test.kz', 'contact updated');

// Test 3: Добавление комнаты
sm.addRoom({ id: 'hall1', name: 'Зал 1' });
sm.addRoom({ id: 'hall2', name: 'Зал 2' });
assert(sm.getSite().rooms.length === 2, '2 rooms added');

// Test 4: Добавление устройства
sm.addDevice({
    device_sn: 'YK0716110141',
    model: 'ACSC101',
    type: 'cooling',
    room: 'hall1',
    ip: '192.168.2.1',
    snmp: { version: '2c', community: 'public' },
    measurement: 'cooling'
});
assert(sm.getSite().devices.length === 1, '1 device added');
assert(sm.getSite().devices[0].id === 'cooling_yk0716110141', 'device id generated');

// Test 5: Получение устройств по комнате
const hall1Devices = sm.getDevicesByRoom('hall1');
assert(hall1Devices.length === 1, '1 device in hall1');
const hall2Devices = sm.getDevicesByRoom('hall2');
assert(hall2Devices.length === 0, '0 devices in hall2');

// Test 6: Удаление комнаты
sm.removeRoom('hall2');
assert(sm.getSite().rooms.length === 1, 'room removed');

// Test 7: Удаление устройства
sm.removeDevice('cooling_yk0716110141');
assert(sm.getSite().devices.length === 0, 'device removed');

// Test 8: Обновление polling
sm.updatePolling({ interval: 1, snapshotWindow: 24 });
assert(sm.getSite().polling.interval === 1, 'interval updated to 1');

// Test 9: Персистентность — перечитываем с диска
const sm2 = new SiteManager(siteFile);
assert(sm2.getSite().site.id === 'test-dc1', 'data persisted to disk');

// Cleanup
fs.rmSync(testDir, { recursive: true });
console.log('\nAll tests passed!');
```

**Step 2: Запустить тест — должен упасть**

Run: `cd snmp-viewer && node test-site-manager.js`
Expected: FAIL — `Cannot find module './lib/site-manager'`

**Step 3: Создать lib/site-manager.js**

```js
const fs = require('fs');
const path = require('path');

const DEFAULT_SITE = {
    site: { id: '', name: '', contact: '' },
    rooms: [],
    devices: [],
    polling: { interval: 5, snapshotWindow: 48 },
    lastSnapshotTime: null
};

class SiteManager {
    constructor(siteFilePath) {
        this.filePath = siteFilePath;
        this.data = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            }
        } catch (e) {
            console.error('Error loading site.json:', e.message);
        }
        return JSON.parse(JSON.stringify(DEFAULT_SITE));
    }

    _save() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    getSite() {
        return this.data;
    }

    updateSiteInfo({ id, name, contact }) {
        if (id !== undefined) this.data.site.id = id;
        if (name !== undefined) this.data.site.name = name;
        if (contact !== undefined) this.data.site.contact = contact;
        this._save();
    }

    // Rooms
    addRoom({ id, name }) {
        if (!id) throw new Error('Room id required');
        if (this.data.rooms.find(r => r.id === id)) throw new Error('Room already exists');
        this.data.rooms.push({ id, name: name || id });
        this._save();
    }

    removeRoom(roomId) {
        // Check no devices in this room
        const devicesInRoom = this.data.devices.filter(d => d.room === roomId);
        if (devicesInRoom.length > 0) {
            throw new Error(`Cannot remove room: ${devicesInRoom.length} devices still assigned`);
        }
        this.data.rooms = this.data.rooms.filter(r => r.id !== roomId);
        this._save();
    }

    // Devices
    addDevice({ device_sn, model, type, room, ip, snmp, measurement }) {
        if (!device_sn) throw new Error('device_sn required');
        const id = `${type || 'device'}_${device_sn.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
        if (this.data.devices.find(d => d.id === id)) throw new Error('Device already exists');
        const configFile = `device_${device_sn.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.conf`;
        this.data.devices.push({
            id, device_sn, model: model || '', type: type || '',
            room: room || '', ip: ip || '',
            snmp: snmp || { version: '2c', community: 'public' },
            measurement: measurement || 'snmp',
            config_file: configFile
        });
        this._save();
    }

    updateDevice(deviceId, updates) {
        const device = this.data.devices.find(d => d.id === deviceId);
        if (!device) throw new Error('Device not found');
        Object.assign(device, updates);
        this._save();
    }

    removeDevice(deviceId) {
        this.data.devices = this.data.devices.filter(d => d.id !== deviceId);
        this._save();
    }

    getDevicesByRoom(roomId) {
        return this.data.devices.filter(d => d.room === roomId);
    }

    // Polling
    updatePolling({ interval, snapshotWindow }) {
        if (interval !== undefined) {
            if (![1, 5, 10].includes(interval)) throw new Error('Interval must be 1, 5, or 10');
            this.data.polling.interval = interval;
        }
        if (snapshotWindow !== undefined) this.data.polling.snapshotWindow = snapshotWindow;
        this._save();
    }
}

module.exports = SiteManager;
```

**Step 4: Запустить тест**

Run: `cd snmp-viewer && node test-site-manager.js`
Expected: `All tests passed!`

**Step 5: Commit**

```bash
git add lib/site-manager.js test-site-manager.js
git commit -m "feat: add SiteManager for multi-device site.json"
```

---

### Task 2: Миграция из settings.json

**Files:**
- Modify: `snmp-viewer/lib/site-manager.js`
- Modify: `snmp-viewer/test-site-manager.js`

**Step 1: Добавить тест миграции в test-site-manager.js**

Добавить перед `// Cleanup`:

```js
// Test 10: Миграция из settings.json
const migrateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkns-migrate-'));
const oldSettings = path.join(migrateDir, 'settings.json');
const newSite = path.join(migrateDir, 'site.json');

fs.writeFileSync(oldSettings, JSON.stringify({
    measurement: 'cooling',
    tags: [
        { key: 'airIRSCUnitIdentModelNumber', value: 'ACSC101' },
        { key: 'device_sn', value: 'YK0716110141' }
    ],
    fields: [
        { key: 'airIRSCUnitStatusCoolOutput', value: '1.3.6.1.4.1.318.1.1.13.3.4.1.2.2.0' }
    ],
    tableMappings: [],
    agentConfig: '[agent]\n  interval = "5s"',
    outputConfig: '[[outputs.influxdb_v2]]\n  urls = ["http://influxdb:8086"]'
}));

const smMigrate = SiteManager.migrateFromSettings(oldSettings, newSite);
const migrated = smMigrate.getSite();
assert(migrated.devices.length === 1, 'migration: 1 device created');
assert(migrated.devices[0].device_sn === 'YK0716110141', 'migration: device_sn preserved');
assert(migrated.devices[0].model === 'ACSC101', 'migration: model preserved');
assert(migrated.devices[0].measurement === 'cooling', 'migration: measurement preserved');
assert(migrated.rooms.length === 1, 'migration: default room created');
assert(migrated.rooms[0].id === 'default', 'migration: room id is default');

fs.rmSync(migrateDir, { recursive: true });
```

**Step 2: Запустить — должен упасть**

Run: `cd snmp-viewer && node test-site-manager.js`
Expected: FAIL — `SiteManager.migrateFromSettings is not a function`

**Step 3: Добавить метод миграции в site-manager.js**

Добавить как статический метод класса SiteManager перед `module.exports`:

```js
    static migrateFromSettings(settingsPath, siteFilePath) {
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch (e) {
            throw new Error('Cannot read settings.json: ' + e.message);
        }

        const sm = new SiteManager(siteFilePath);

        // Create default room
        sm.addRoom({ id: 'default', name: 'Default Room' });

        // Extract device info from tags
        const snTag = (settings.tags || []).find(t =>
            t.key === 'device_sn' || t.key === 'airIRSCUnitIdentSerialNumber'
        );
        const modelTag = (settings.tags || []).find(t =>
            t.key === 'model' || t.key === 'airIRSCUnitIdentModelNumber'
        );

        if (snTag && snTag.value) {
            sm.addDevice({
                device_sn: snTag.value,
                model: modelTag ? modelTag.value : '',
                type: settings.measurement || 'snmp',
                room: 'default',
                ip: '',
                measurement: settings.measurement || 'snmp'
            });
        }

        return sm;
    }
```

**Step 4: Запустить тест**

Run: `cd snmp-viewer && node test-site-manager.js`
Expected: `All tests passed!`

**Step 5: Commit**

```bash
git add lib/site-manager.js test-site-manager.js
git commit -m "feat: add settings.json to site.json migration"
```

---

### Task 3: API-эндпоинты для site management

**Files:**
- Modify: `snmp-viewer/server.js`

**Step 1: Подключить SiteManager в server.js**

Добавить после инициализации MibManager (после строки `const mibManager = new MibManager(mibsDir);`):

```js
const SiteManager = require('./lib/site-manager');
const siteFile = path.join(__dirname, 'site.json');
const oldSettingsFile = path.join(__dirname, 'settings.json');

// Auto-migrate from settings.json if site.json doesn't exist
let siteManager;
if (!fs.existsSync(siteFile) && fs.existsSync(oldSettingsFile)) {
    console.log('Migrating settings.json → site.json...');
    siteManager = SiteManager.migrateFromSettings(oldSettingsFile, siteFile);
    console.log('Migration complete.');
} else {
    siteManager = new SiteManager(siteFile);
}
```

**Step 2: Добавить CRUD эндпоинты**

Добавить после блока `// API: Settings` (после `app.post('/api/settings', ...)`):

```js
// API: Site Management
app.get('/api/site', (req, res) => {
    res.json(siteManager.getSite());
});

app.put('/api/site/info', (req, res) => {
    try {
        siteManager.updateSiteInfo(req.body);
        res.json({ message: 'Site info updated' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/site/rooms', (req, res) => {
    try {
        siteManager.addRoom(req.body);
        res.json({ message: 'Room added' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/site/rooms/:id', (req, res) => {
    try {
        siteManager.removeRoom(req.params.id);
        res.json({ message: 'Room removed' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/site/devices', (req, res) => {
    try {
        siteManager.addDevice(req.body);
        res.json({ message: 'Device added' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/site/devices/:id', (req, res) => {
    try {
        siteManager.updateDevice(req.params.id, req.body);
        res.json({ message: 'Device updated' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/site/devices/:id', (req, res) => {
    try {
        siteManager.removeDevice(req.params.id);
        res.json({ message: 'Device removed' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/site/polling', (req, res) => {
    try {
        siteManager.updatePolling(req.body);
        res.json({ message: 'Polling settings updated' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// API: Calculator
app.post('/api/calculator', (req, res) => {
    const { devices, metrics, interval, retentionDays, snapshotHours } = req.body;
    const d = devices || 10;
    const m = metrics || 12;
    const i = interval || 5;
    const r = retentionDays || 30;
    const s = snapshotHours || 48;
    const bytesPerPoint = 100;

    const pointsPerDay = d * m * (86400 / i);
    const rawPerDay = pointsPerDay * bytesPerPoint;
    const influxPerDay = rawPerDay * 0.15;
    const influxTotal = influxPerDay * r;

    const snapshotPoints = d * m * (s * 3600 / i);
    const snapshotRaw = snapshotPoints * bytesPerPoint;
    const snapshotGzip = snapshotRaw / 15;

    res.json({
        pointsPerDay,
        influxPerDay: Math.round(influxPerDay),
        influxTotal: Math.round(influxTotal),
        snapshotPoints,
        snapshotRaw: Math.round(snapshotRaw),
        snapshotGzip: Math.round(snapshotGzip)
    });
});
```

**Step 3: Проверить API через curl**

Run: `docker compose up -d --build snmp-viewer`

Затем:

```bash
# GET site
curl -s http://localhost:3000/api/site | python3 -m json.tool

# PUT site info
curl -s -X PUT http://localhost:3000/api/site/info \
  -H "Content-Type: application/json" \
  -d '{"id":"test-dc1","name":"Test DC","contact":"test@test.kz"}'

# POST room
curl -s -X POST http://localhost:3000/api/site/rooms \
  -H "Content-Type: application/json" \
  -d '{"id":"hall1","name":"Зал 1"}'

# POST device
curl -s -X POST http://localhost:3000/api/site/devices \
  -H "Content-Type: application/json" \
  -d '{"device_sn":"YK0716110141","model":"ACSC101","type":"cooling","room":"hall1","ip":"192.168.2.1","measurement":"cooling"}'

# Calculator
curl -s -X POST http://localhost:3000/api/calculator \
  -H "Content-Type: application/json" \
  -d '{"devices":10,"metrics":12,"interval":5,"retentionDays":30,"snapshotHours":48}'
```

Expected: все вернут JSON без ошибок.

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add site management and calculator API endpoints"
```

---

### Task 4: Фронтенд — таб Site Setup

**Files:**
- Modify: `snmp-viewer/public/index.html`

**Step 1: Добавить кнопку таба**

Найти блок `<div class="tab-navigation">` и добавить **первой** кнопкой:

```html
<button class="tab-btn" onclick="switchTab('site-tab')">Site Setup</button>
```

**Step 2: Добавить контент таба**

Добавить новый `<div id="site-tab" class="tab-content">` рядом с остальными табами. Содержимое:

- Секция Site Info (id, name, contact) с кнопкой Save
- Секция Rooms (таблица с кнопками Add/Remove)
- Секция Devices (таблица: SN, model, type, room, IP, с кнопками Add/Remove)
- Секция Polling (interval select 1/5/10, snapshotWindow input)
- Секция Calculator (inputs + мгновенный расчёт + цветовая индикация)

Калькулятор вычисляет на клиенте (без API), обновляясь при каждом изменении полей. Формулы:

```js
function updateCalculator() {
    const d = parseInt(calcDevices.value) || 0;
    const m = parseInt(calcMetrics.value) || 0;
    const i = parseInt(calcInterval.value) || 5;
    const r = parseInt(calcRetention.value) || 30;
    const s = parseInt(calcSnapshot.value) || 48;

    const pointsPerDay = d * m * (86400 / i);
    const influxPerDay = pointsPerDay * 100 * 0.15;
    const influxTotal = influxPerDay * r;
    const snapshotGzip = d * m * (s * 3600 / i) * 100 / 15;

    // Отображение с форматированием (MB, GB)
    // Цветовая индикация для snapshotGzip
}
```

**Step 3: Проверить в браузере**

Open: `http://localhost:3000` → кликнуть таб "Site Setup"
Expected: форма заполняется, калькулятор считает, цвета меняются.

**Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add Site Setup tab with calculator"
```

---

### Task 5: Интеграция — Config таб использует site.json

**Files:**
- Modify: `snmp-viewer/public/index.html`

**Step 1: Обновить Config таб**

При сохранении конфига устройства (кнопка Save to Device), автоматически регистрировать устройство в site.json через `POST /api/site/devices`, если его ещё нет.

В обработчике `saveDeviceConfigBtn`:

```js
// После успешного сохранения .conf — добавить в site.json
const siteRes = await fetch('/api/site');
const siteData = await siteRes.json();
const exists = siteData.devices.find(d => d.device_sn === snTag.value);
if (!exists) {
    await fetch('/api/site/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_sn: snTag.value,
            model: modelTag ? modelTag.value : '',
            type: settings.measurement || 'snmp',
            room: 'default',
            measurement: settings.measurement || 'snmp'
        })
    });
}
```

**Step 2: Обновить Dashboard**

Вместо парсинга Telegraf конфигов в `/api/equipment`, Dashboard теперь также читает из `/api/site` для отображения реестра устройств по комнатам.

**Step 3: Проверить в браузере**

1. Открыть Site Setup → добавить комнату
2. Перейти в Scan → просканировать устройство
3. Config → Save to Device
4. Вернуться в Site Setup → устройство появилось в списке

**Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: integrate site.json with config and dashboard"
```

---

### Task 6: Обновить CLAUDE.md и TODO.md

**Files:**
- Modify: `CLAUDE.md` — добавить описание site.json, новые API-эндпоинты
- Modify: `TODO.md` — отметить пункт 2 как выполненный

**Step 1: Обновить файлы**

**Step 2: Commit**

```bash
git add CLAUDE.md TODO.md
git commit -m "docs: update CLAUDE.md and TODO.md for multi-device model"
```
