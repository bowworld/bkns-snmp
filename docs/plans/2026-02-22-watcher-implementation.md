# Watcher + Snapshot + Notifier Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Реализовать детекцию инцидентов (Watcher), генерацию слепков (Snapshot), email-оповещения (Notifier) — пункты TODO 3, 4, 5.

**Architecture:** Watcher работает как setInterval внутри Node.js. Читает правила из site.json (поле `rules` в устройствах), запрашивает последние значения из InfluxDB через Flux API, детектирует переходы ok→alert. При инциденте Snapshot Generator запрашивает данные всей комнаты за snapshotWindow, пакует tar.gz. Notifier отправляет email через nodemailer.

**Tech Stack:** Node.js 20, Express 4, InfluxDB 2.7 (Flux API), nodemailer (email), tar-stream (архивация), vanilla JS frontend.

**Design doc:** `docs/plans/2026-02-22-watcher-design.md`

---

### Task 1: Расширить SiteManager — поддержка rules и smtp

**Files:**
- Modify: `lib/site-manager.js`
- Modify: `test-site-manager.js`

**Step 1: Написать тесты для rules**

Добавить в `test-site-manager.js`:

```js
// === Rules tests ===
const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkns-rules-'));
const rulesFile = path.join(rulesDir, 'site.json');
const smr = new SiteManager(rulesFile);
smr.addRoom({ id: 'hall1', name: 'Hall 1' });
smr.addDevice({ device_sn: 'TEST001', model: 'TestModel', type: 'cooling', room: 'hall1', measurement: 'cooling' });

const deviceId = 'cooling_test001';

// Add rule
smr.addRule(deviceId, { id: 'r1', metric: 'temp', type: 'threshold', min: 18, max: 35, severity: 'warning', description: 'Temp range' });
const dev1 = smr.getSite().devices.find(d => d.id === deviceId);
assert(dev1.rules.length === 1, 'FAIL: 1 rule added');
console.log('PASS: rule added');

// Add second rule
smr.addRule(deviceId, { id: 'r2', metric: 'status', type: 'discrete', alert_on: [1], severity: 'critical', description: 'Offline' });
assert(smr.getSite().devices.find(d => d.id === deviceId).rules.length === 2, 'FAIL: 2 rules');
console.log('PASS: second rule added');

// Duplicate id rejected
try { smr.addRule(deviceId, { id: 'r1', metric: 'x', type: 'discrete', alert_on: [0] }); assert(false); } catch(e) {}
console.log('PASS: duplicate rule id rejected');

// Remove rule
smr.removeRule(deviceId, 'r1');
assert(smr.getSite().devices.find(d => d.id === deviceId).rules.length === 1, 'FAIL: 1 rule after remove');
console.log('PASS: rule removed');

// Get all devices with rules
const devicesWithRules = smr.getDevicesWithRules();
assert(devicesWithRules.length === 1, 'FAIL: 1 device with rules');
assert(devicesWithRules[0].rules.length === 1, 'FAIL: device has 1 rule');
console.log('PASS: getDevicesWithRules works');

// SMTP config
smr.updateSiteInfo({ contact: 'test@test.kz', smtp: { host: 'mail.test.kz', port: 25, secure: false } });
const site = smr.getSite();
assert(site.site.smtp.host === 'mail.test.kz', 'FAIL: smtp host');
assert(site.site.smtp.port === 25, 'FAIL: smtp port');
console.log('PASS: smtp config saved');

fs.rmSync(rulesDir, { recursive: true });
```

**Step 2: Запустить тесты — должны упасть**

Run: `node test-site-manager.js`
Expected: FAIL — `smr.addRule is not a function`

**Step 3: Реализовать в site-manager.js**

Добавить методы в класс SiteManager:

```js
// Rules
addRule(deviceId, rule) {
    const device = this.data.devices.find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found');
    if (!device.rules) device.rules = [];
    if (!rule.id || !rule.metric || !rule.type) throw new Error('Rule requires id, metric, type');
    if (device.rules.find(r => r.id === rule.id)) throw new Error('Rule id already exists');
    device.rules.push(rule);
    this._save();
}

removeRule(deviceId, ruleId) {
    const device = this.data.devices.find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found');
    if (!device.rules) device.rules = [];
    device.rules = device.rules.filter(r => r.id !== ruleId);
    this._save();
}

getDevicesWithRules() {
    return this.data.devices.filter(d => d.rules && d.rules.length > 0);
}
```

Обновить `updateSiteInfo` — добавить поддержку smtp:

```js
updateSiteInfo({ id, name, contact, smtp }) {
    if (id !== undefined) this.data.site.id = id;
    if (name !== undefined) this.data.site.name = name;
    if (contact !== undefined) this.data.site.contact = contact;
    if (smtp !== undefined) this.data.site.smtp = smtp;
    this._save();
}
```

**Step 4: Запустить тесты — все должны пройти**

Run: `node test-site-manager.js`
Expected: All tests passed!

**Step 5: Коммит**

```bash
git add lib/site-manager.js test-site-manager.js
git commit -m "feat: add rules and smtp support to SiteManager"
```

---

### Task 2: Watcher — ядро детекции инцидентов

**Files:**
- Create: `lib/watcher.js`
- Create: `test-watcher.js`

**Step 1: Написать тесты**

```js
const assert = require('assert');
const EventEmitter = require('events');

// Mock InfluxDB client
class MockInfluxClient {
    constructor(responses) {
        this.responses = responses;
        this.queryCount = 0;
    }
    async query(fluxQuery) {
        return this.responses[this.queryCount++] || [];
    }
}

// Load Watcher after mocks are set up
const Watcher = require('./lib/watcher');

// Test 1: discrete rule detection
(async () => {
    const influx = new MockInfluxClient([
        // First check: value 2 (ok)
        [{ device_sn: 'DEV1', status: 2 }],
        // Second check: value 1 (alert_on)
        [{ device_sn: 'DEV1', status: 1 }],
    ]);

    const rules = [{
        device_sn: 'DEV1',
        measurement: 'cooling',
        room: 'hall1',
        rule: { id: 'r1', metric: 'status', type: 'discrete', alert_on: [1], severity: 'critical', description: 'Offline' }
    }];

    const watcher = new Watcher({ influxClient: influx, getRules: () => rules });
    const incidents = [];
    watcher.on('incident', (inc) => incidents.push(inc));

    await watcher.check();
    assert(incidents.length === 0, 'FAIL: no incident on first check (value 2)');
    console.log('PASS: no false alert on ok value');

    await watcher.check();
    assert(incidents.length === 1, 'FAIL: incident on second check (value 1)');
    assert(incidents[0].rule.id === 'r1');
    assert(incidents[0].device_sn === 'DEV1');
    console.log('PASS: discrete incident detected');

    // Third check: still 1 — no duplicate
    influx.responses.push([{ device_sn: 'DEV1', status: 1 }]);
    await watcher.check();
    assert(incidents.length === 1, 'FAIL: no duplicate incident');
    console.log('PASS: no duplicate incident');

    // Fourth check: back to 2 — recovery
    influx.responses.push([{ device_sn: 'DEV1', status: 2 }]);
    await watcher.check();
    assert(incidents.length === 1, 'FAIL: no incident on recovery');
    console.log('PASS: recovery detected without incident');
})();

// Test 2: threshold rule detection
(async () => {
    const influx = new MockInfluxClient([
        [{ device_sn: 'DEV2', temp: 22 }],  // ok
        [{ device_sn: 'DEV2', temp: 38 }],  // over max
    ]);

    const rules = [{
        device_sn: 'DEV2',
        measurement: 'cooling',
        room: 'hall1',
        rule: { id: 'r2', metric: 'temp', type: 'threshold', min: 18, max: 35, severity: 'warning', description: 'Temp' }
    }];

    const watcher = new Watcher({ influxClient: influx, getRules: () => rules });
    const incidents = [];
    watcher.on('incident', (inc) => incidents.push(inc));

    await watcher.check();
    assert(incidents.length === 0);
    console.log('PASS: threshold ok (22)');

    await watcher.check();
    assert(incidents.length === 1);
    assert(incidents[0].device_sn === 'DEV2');
    console.log('PASS: threshold breach detected (38 > 35)');
})();

// Test 3: no data — skip without error
(async () => {
    const influx = new MockInfluxClient([[]]);
    const rules = [{
        device_sn: 'DEV3',
        measurement: 'ups',
        room: 'hall1',
        rule: { id: 'r3', metric: 'load', type: 'threshold', max: 80, severity: 'warning', description: 'Load' }
    }];

    const watcher = new Watcher({ influxClient: influx, getRules: () => rules });
    const incidents = [];
    watcher.on('incident', (inc) => incidents.push(inc));

    await watcher.check();
    assert(incidents.length === 0);
    console.log('PASS: no data — no error, no false alert');
})();

console.log('\nAll watcher tests passed!');
```

**Step 2: Запустить — должен упасть**

Run: `node test-watcher.js`
Expected: FAIL — `Cannot find module './lib/watcher'`

**Step 3: Реализовать lib/watcher.js**

```js
const EventEmitter = require('events');

class Watcher extends EventEmitter {
    constructor({ influxClient, getRules, checkInterval = 30000 }) {
        super();
        this.influx = influxClient;
        this.getRules = getRules;
        this.checkInterval = checkInterval;
        this.state = {};  // "DEV1_status": "ok" | "alert"
        this.timer = null;
        this.lastCheck = null;
        this.running = false;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.timer = setInterval(() => this.check().catch(e => this.emit('error', e)), this.checkInterval);
        this.check().catch(e => this.emit('error', e));
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.running = false;
    }

    getStatus() {
        return {
            running: this.running,
            lastCheck: this.lastCheck,
            activeAlerts: Object.entries(this.state)
                .filter(([, v]) => v === 'alert')
                .map(([k]) => k)
        };
    }

    async check() {
        const rules = this.getRules();
        if (!rules || rules.length === 0) return;

        // Group rules by measurement for batch queries
        const byMeasurement = {};
        for (const r of rules) {
            if (!byMeasurement[r.measurement]) byMeasurement[r.measurement] = [];
            byMeasurement[r.measurement].push(r);
        }

        for (const [measurement, measurementRules] of Object.entries(byMeasurement)) {
            let rows;
            try {
                rows = await this.influx.query(measurement);
            } catch (e) {
                this.emit('error', e);
                continue;
            }

            if (!rows || rows.length === 0) continue;

            for (const ruleEntry of measurementRules) {
                const { device_sn, rule, room } = ruleEntry;
                const row = rows.find(r => r.device_sn === device_sn);
                if (!row) continue;

                const value = row[rule.metric];
                if (value === undefined || value === null) continue;

                const stateKey = `${device_sn}_${rule.metric}`;
                const prevState = this.state[stateKey] || 'ok';
                let isAlert = false;

                if (rule.type === 'discrete') {
                    isAlert = (rule.alert_on || []).includes(value);
                } else if (rule.type === 'threshold') {
                    if (rule.min !== undefined && value < rule.min) isAlert = true;
                    if (rule.max !== undefined && value > rule.max) isAlert = true;
                }

                const newState = isAlert ? 'alert' : 'ok';
                this.state[stateKey] = newState;

                // Only emit on transition ok → alert
                if (prevState === 'ok' && newState === 'alert') {
                    this.emit('incident', {
                        device_sn,
                        measurement,
                        room,
                        rule,
                        value,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }

        this.lastCheck = new Date().toISOString();
    }
}

module.exports = Watcher;
```

**Step 4: Запустить тесты — все должны пройти**

Run: `node test-watcher.js`
Expected: All watcher tests passed!

**Step 5: Коммит**

```bash
git add lib/watcher.js test-watcher.js
git commit -m "feat: implement Watcher with discrete and threshold detection"
```

---

### Task 3: InfluxDB Client — обёртка для Flux-запросов

**Files:**
- Create: `lib/influx-client.js`
- Create: `test-influx-client.js`

**Step 1: Написать тест**

```js
const assert = require('assert');
const InfluxClient = require('./lib/influx-client');

// Test: buildFluxQuery generates correct Flux
const client = new InfluxClient({
    url: 'http://influxdb:8086',
    token: 'test-token',
    org: 'bkns',
    bucket: 'snmp-data'
});

const query = client.buildLastValuesQuery('cooling');
assert(query.includes('from(bucket: "snmp-data")'), 'FAIL: bucket');
assert(query.includes('_measurement') && query.includes('cooling'), 'FAIL: measurement filter');
assert(query.includes('last()'), 'FAIL: last()');
assert(query.includes('pivot'), 'FAIL: pivot');
console.log('PASS: Flux query built correctly');

// Test: parseCSV parses InfluxDB CSV response
const csv = `#group,false,false,false,false,false
#datatype,string,string,string,double,double
#default,_result,,,,
,result,table,device_sn,temp,status
,,0,DEV1,22.5,2
,,1,DEV2,25.0,2`;

const rows = client.parseCSV(csv);
assert(rows.length === 2, 'FAIL: 2 rows parsed');
assert(rows[0].device_sn === 'DEV1', 'FAIL: device_sn');
assert(rows[0].temp === 22.5, 'FAIL: temp is number');
assert(rows[0].status === 2, 'FAIL: status is number');
console.log('PASS: CSV parsed correctly');

console.log('\nAll influx-client tests passed!');
```

**Step 2: Запустить — должен упасть**

Run: `node test-influx-client.js`
Expected: FAIL — `Cannot find module './lib/influx-client'`

**Step 3: Реализовать lib/influx-client.js**

```js
const http = require('http');
const https = require('https');

class InfluxClient {
    constructor({ url, token, org, bucket }) {
        this.url = url;
        this.token = token;
        this.org = org;
        this.bucket = bucket;
    }

    buildLastValuesQuery(measurement) {
        return `from(bucket: "${this.bucket}")
  |> range(start: -5m)
  |> filter(fn: (r) => r["_measurement"] == "${measurement}")
  |> last()
  |> pivot(rowKey: ["device_sn"], columnKey: ["_field"], valueColumn: "_value")`;
    }

    buildRangeQuery(deviceSNs, hours) {
        const snFilter = deviceSNs.map(sn => `r["device_sn"] == "${sn}"`).join(' or ');
        return `from(bucket: "${this.bucket}")
  |> range(start: -${hours}h)
  |> filter(fn: (r) => ${snFilter})`;
    }

    parseCSV(csv) {
        const lines = csv.trim().split('\n');
        // Skip annotation lines (#group, #datatype, #default)
        const dataLines = lines.filter(l => !l.startsWith('#'));
        if (dataLines.length < 2) return [];

        const headers = dataLines[0].split(',');
        const rows = [];

        for (let i = 1; i < dataLines.length; i++) {
            const values = dataLines[i].split(',');
            const row = {};
            for (let j = 0; j < headers.length; j++) {
                const key = headers[j].trim();
                const val = (values[j] || '').trim();
                // Skip InfluxDB internal columns
                if (key === '' || key === 'result' || key === 'table') continue;
                // Try to parse as number
                const num = Number(val);
                row[key] = val !== '' && !isNaN(num) ? num : val;
            }
            if (Object.keys(row).length > 0) rows.push(row);
        }
        return rows;
    }

    async query(measurement) {
        const flux = this.buildLastValuesQuery(measurement);
        const body = await this._post('/api/v2/query', {
            query: flux,
            type: 'flux'
        });
        return this.parseCSV(body);
    }

    async queryRange(deviceSNs, hours) {
        const flux = this.buildRangeQuery(deviceSNs, hours);
        const body = await this._post('/api/v2/query', {
            query: flux,
            type: 'flux'
        });
        return body; // raw CSV for Line Protocol conversion
    }

    _post(path, data) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.url);
            const options = {
                hostname: url.hostname,
                port: url.port,
                path: `${path}?org=${encodeURIComponent(this.org)}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Token ${this.token}`,
                    'Accept': 'application/csv'
                }
            };

            const client = url.protocol === 'https:' ? https : http;
            const req = client.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        reject(new Error(`InfluxDB ${res.statusCode}: ${body}`));
                    } else {
                        resolve(body);
                    }
                });
            });
            req.on('error', reject);
            req.write(JSON.stringify(data));
            req.end();
        });
    }
}

module.exports = InfluxClient;
```

**Step 4: Запустить тесты**

Run: `node test-influx-client.js`
Expected: All influx-client tests passed!

**Step 5: Коммит**

```bash
git add lib/influx-client.js test-influx-client.js
git commit -m "feat: InfluxDB client with Flux query builder and CSV parser"
```

---

### Task 4: Snapshot Generator

**Files:**
- Create: `lib/snapshot.js`
- Create: `test-snapshot.js`

**Step 1: Установить зависимости**

```bash
npm install tar-stream --save
```

**Step 2: Написать тест**

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar-stream');

const SnapshotGenerator = require('./lib/snapshot');

(async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkns-snap-'));

    const mockInflux = {
        async queryRange(deviceSNs, hours) {
            // Return raw CSV like InfluxDB would
            return `#group,false,false,false,false,false,false
#datatype,string,long,dateTime:RFC3339,string,string,double
#default,_result,,,,,
,result,table,_time,_measurement,device_sn,_field,_value
,,0,2026-02-22T10:00:00Z,cooling,DEV1,temp,22.5
,,0,2026-02-22T10:00:05Z,cooling,DEV1,temp,23.0`;
        }
    };

    const gen = new SnapshotGenerator({ influxClient: mockInflux, outputDir: outDir });

    const incident = {
        device_sn: 'DEV1',
        measurement: 'cooling',
        room: 'hall1',
        rule: { id: 'r1', metric: 'temp', type: 'threshold', max: 35, severity: 'warning', description: 'Temp' },
        value: 38,
        timestamp: '2026-02-22T12:30:00Z'
    };

    const siteData = {
        site: { id: 'test-dc1', name: 'Test DC' },
        devices: [
            { device_sn: 'DEV1', model: 'TestModel', type: 'cooling', room: 'hall1' },
            { device_sn: 'DEV2', model: 'TestModel2', type: 'cooling', room: 'hall1' },
            { device_sn: 'DEV3', model: 'UPS1', type: 'ups', room: 'hall2' }
        ],
        polling: { snapshotWindow: 48 }
    };

    const result = await gen.generate(incident, siteData);

    // Check file exists
    assert(fs.existsSync(result.filePath), 'FAIL: tar.gz file created');
    console.log('PASS: snapshot file created');

    // Check filename format
    assert(result.filePath.includes('snapshot_test-dc1_'), 'FAIL: filename has site id');
    assert(result.filePath.endsWith('.tar.gz'), 'FAIL: .tar.gz extension');
    console.log('PASS: filename format correct');

    // Check meta has correct devices (only hall1)
    assert(result.meta.devices_included.length === 2, 'FAIL: only hall1 devices');
    assert(result.meta.incident.device_sn === 'DEV1', 'FAIL: incident device');
    console.log('PASS: meta.json has correct scope (room only)');

    // Cleanup
    fs.rmSync(outDir, { recursive: true });

    console.log('\nAll snapshot tests passed!');
})();
```

**Step 3: Запустить — должен упасть**

Run: `node test-snapshot.js`
Expected: FAIL — `Cannot find module './lib/snapshot'`

**Step 4: Реализовать lib/snapshot.js**

```js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar-stream');
const { v4: uuidv4 } = require('crypto');

class SnapshotGenerator {
    constructor({ influxClient, outputDir }) {
        this.influx = influxClient;
        this.outputDir = outputDir;
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    }

    async generate(incident, siteData) {
        const { device_sn, measurement, room, rule, value, timestamp } = incident;

        // Get all devices in the same room
        const roomDevices = siteData.devices.filter(d => d.room === room);
        const deviceSNs = roomDevices.map(d => d.device_sn);
        const snapshotWindow = siteData.polling.snapshotWindow || 48;

        // Query data from InfluxDB
        let rawData = '';
        try {
            rawData = await this.influx.queryRange(deviceSNs, snapshotWindow);
        } catch (e) {
            rawData = `# Error querying InfluxDB: ${e.message}`;
        }

        // Build meta.json
        const snapshotId = require('crypto').randomUUID();
        const now = new Date(timestamp);
        const from = new Date(now.getTime() - snapshotWindow * 3600 * 1000);

        const meta = {
            version: 1,
            snapshot_id: snapshotId,
            created_at: timestamp,
            site: {
                id: siteData.site.id,
                name: siteData.site.name
            },
            period: {
                from: from.toISOString(),
                to: timestamp
            },
            incident: {
                device_sn,
                device_model: (roomDevices.find(d => d.device_sn === device_sn) || {}).model || '',
                room,
                trigger: rule.type === 'discrete' ? 'discrete_change' : 'threshold_breach',
                severity: rule.severity || 'warning',
                metric: rule.metric,
                value,
                description: rule.description || ''
            },
            devices_included: roomDevices.map(d => ({
                device_sn: d.device_sn,
                model: d.model,
                type: d.type
            }))
        };

        // Generate filename
        const safeTimestamp = timestamp.replace(/[:.]/g, '-');
        const filename = `snapshot_${siteData.site.id || 'site'}_${safeTimestamp}.tar.gz`;
        const filePath = path.join(this.outputDir, filename);

        // Pack tar.gz
        await this._packTarGz(filePath, {
            'meta.json': JSON.stringify(meta, null, 2),
            'data.lp': rawData
        });

        return { filePath, filename, meta };
    }

    _packTarGz(outputPath, files) {
        return new Promise((resolve, reject) => {
            const pack = tar();
            const gzip = zlib.createGzip();
            const output = fs.createWriteStream(outputPath);

            pack.pipe(gzip).pipe(output);

            for (const [name, content] of Object.entries(files)) {
                const buf = Buffer.from(content, 'utf8');
                pack.entry({ name, size: buf.length }, buf);
            }

            pack.finalize();
            output.on('finish', resolve);
            output.on('error', reject);
        });
    }
}

module.exports = SnapshotGenerator;
```

**Step 5: Запустить тесты**

Run: `node test-snapshot.js`
Expected: All snapshot tests passed!

**Step 6: Коммит**

```bash
git add lib/snapshot.js test-snapshot.js package.json package-lock.json
git commit -m "feat: Snapshot Generator — tar.gz with meta.json + data.lp"
```

---

### Task 5: Email Notifier

**Files:**
- Create: `lib/notifier.js`
- Create: `test-notifier.js`

**Step 1: Установить nodemailer**

```bash
npm install nodemailer --save
```

**Step 2: Написать тест (с mock transport)**

```js
const assert = require('assert');
const Notifier = require('./lib/notifier');

(async () => {
    // Test with mock transport (nodemailer supports jsonTransport)
    const notifier = new Notifier({
        transport: { jsonTransport: true },
        from: 'bkns@vicomplus.kz'
    });

    const meta = {
        snapshot_id: 'test-uuid',
        created_at: '2026-02-22T12:30:00Z',
        site: { id: 'test-dc1', name: 'Test DC' },
        incident: {
            device_sn: 'DEV1',
            device_model: 'ACSC101',
            room: 'hall1',
            severity: 'critical',
            metric: 'status',
            value: 1,
            description: 'Cooling unit went offline'
        }
    };

    const result = await notifier.send({
        to: 'admin@customer.kz',
        meta,
        attachmentPath: null  // skip attachment in test
    });

    assert(result.envelope.to.includes('admin@customer.kz'), 'FAIL: recipient');
    const msg = JSON.parse(result.message);
    assert(msg.subject.includes('CRITICAL'), 'FAIL: subject has severity');
    assert(msg.subject.includes('DEV1'), 'FAIL: subject has device');
    console.log('PASS: email sent with correct subject');
    console.log('PASS: recipient correct');

    console.log('\nAll notifier tests passed!');
})();
```

**Step 3: Запустить — должен упасть**

Run: `node test-notifier.js`
Expected: FAIL — `Cannot find module './lib/notifier'`

**Step 4: Реализовать lib/notifier.js**

```js
const nodemailer = require('nodemailer');
const path = require('path');

class Notifier {
    constructor({ transport, from }) {
        this.transporter = nodemailer.createTransport(transport);
        this.from = from || 'bkns@localhost';
    }

    async send({ to, meta, attachmentPath }) {
        const severity = (meta.incident.severity || 'warning').toUpperCase();
        const subject = `[BKNS] ${severity}: ${meta.incident.device_sn} — ${meta.incident.description}`;

        const text = [
            `Incident detected at ${meta.site.name || meta.site.id}`,
            ``,
            `Device: ${meta.incident.device_sn} (${meta.incident.device_model})`,
            `Room: ${meta.incident.room}`,
            `Metric: ${meta.incident.metric} = ${meta.incident.value}`,
            `Severity: ${severity}`,
            `Description: ${meta.incident.description}`,
            `Time: ${meta.created_at}`,
            ``,
            `Snapshot ID: ${meta.snapshot_id}`,
            attachmentPath ? `Snapshot file attached.` : `No snapshot file attached.`
        ].join('\n');

        const mailOptions = {
            from: this.from,
            to,
            subject,
            text,
        };

        if (attachmentPath) {
            mailOptions.attachments = [{
                filename: path.basename(attachmentPath),
                path: attachmentPath
            }];
        }

        return this.transporter.sendMail(mailOptions);
    }
}

module.exports = Notifier;
```

**Step 5: Запустить тесты**

Run: `node test-notifier.js`
Expected: All notifier tests passed!

**Step 6: Коммит**

```bash
git add lib/notifier.js test-notifier.js package.json package-lock.json
git commit -m "feat: Email Notifier with nodemailer"
```

---

### Task 6: Интеграция в server.js — API endpoints + wiring

**Files:**
- Modify: `server.js`

**Step 1: Добавить require и инициализацию**

После `const siteManager = ...`:

```js
const InfluxClient = require('./lib/influx-client');
const Watcher = require('./lib/watcher');
const SnapshotGenerator = require('./lib/snapshot');
const Notifier = require('./lib/notifier');

// InfluxDB connection
const influxClient = new InfluxClient({
    url: process.env.INFLUX_URL || 'http://influxdb:8086',
    token: process.env.INFLUX_TOKEN || 'my-super-secret-auth-token',
    org: process.env.INFLUX_ORG || 'bkns',
    bucket: process.env.INFLUX_BUCKET || 'snmp-data'
});

// Snapshot output directory
const snapshotDir = path.join(__dirname, 'snapshots');

// Snapshot Generator
const snapshotGenerator = new SnapshotGenerator({ influxClient, outputDir: snapshotDir });

// Watcher
function getRulesForWatcher() {
    const site = siteManager.getSite();
    const rules = [];
    for (const device of site.devices) {
        if (!device.rules || device.rules.length === 0) continue;
        for (const rule of device.rules) {
            rules.push({
                device_sn: device.device_sn,
                measurement: device.measurement,
                room: device.room,
                rule
            });
        }
    }
    return rules;
}

const watcher = new Watcher({
    influxClient,
    getRules: getRulesForWatcher,
    checkInterval: 30000
});

// Handle incidents
watcher.on('incident', async (incident) => {
    console.log(`[INCIDENT] ${incident.device_sn}: ${incident.rule.description} (value=${incident.value})`);
    try {
        const siteData = siteManager.getSite();
        const result = await snapshotGenerator.generate(incident, siteData);
        console.log(`[SNAPSHOT] Generated: ${result.filename}`);

        // Update lastSnapshotTime
        siteManager.data.lastSnapshotTime = incident.timestamp;
        siteManager._save();

        // Send email if SMTP configured
        if (siteData.site.contact && siteData.site.smtp && siteData.site.smtp.host) {
            const notifier = new Notifier({
                transport: siteData.site.smtp,
                from: `bkns@${siteData.site.smtp.host}`
            });
            await notifier.send({
                to: siteData.site.contact,
                meta: result.meta,
                attachmentPath: result.filePath
            });
            console.log(`[EMAIL] Sent to ${siteData.site.contact}`);
        }
    } catch (e) {
        console.error('[INCIDENT ERROR]', e.message);
    }
});

watcher.on('error', (e) => console.error('[WATCHER ERROR]', e.message));
```

**Step 2: Добавить API endpoints для rules**

После site API endpoints:

```js
// === Watcher Rules API ===
app.post('/api/site/devices/:id/rules', (req, res) => {
    try {
        siteManager.addRule(req.params.id, req.body);
        res.json({ message: 'Rule added' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/site/devices/:id/rules/:ruleId', (req, res) => {
    try {
        siteManager.removeRule(req.params.id, req.params.ruleId);
        res.json({ message: 'Rule removed' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// === Watcher API ===
app.post('/api/watcher/start', (req, res) => {
    watcher.start();
    res.json({ message: 'Watcher started' });
});

app.post('/api/watcher/stop', (req, res) => {
    watcher.stop();
    res.json({ message: 'Watcher stopped' });
});

app.get('/api/watcher/status', (req, res) => {
    res.json(watcher.getStatus());
});

// === Snapshots API ===
app.get('/api/snapshots', (req, res) => {
    try {
        if (!fs.existsSync(snapshotDir)) return res.json([]);
        const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.tar.gz')).sort().reverse();
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snapshots/:filename', (req, res) => {
    const safeName = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(snapshotDir, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.download(filePath);
});
```

**Step 3: Тест API через curl**

```bash
# Rules API
curl -s -X POST http://localhost:3000/api/site/devices/cooling_yk0716110141/rules \
  -H 'Content-Type: application/json' \
  -d '{"id":"r1","metric":"coolOutput","type":"discrete","alert_on":[1],"severity":"critical","description":"Cooling offline"}'

# Watcher API
curl -s http://localhost:3000/api/watcher/status
curl -s -X POST http://localhost:3000/api/watcher/start
curl -s http://localhost:3000/api/watcher/status
curl -s -X POST http://localhost:3000/api/watcher/stop

# Snapshots API
curl -s http://localhost:3000/api/snapshots
```

**Step 4: Коммит**

```bash
git add server.js
git commit -m "feat: integrate Watcher, Snapshot, Notifier into server.js"
```

---

### Task 7: Фронтенд — Watcher Rules UI

**Files:**
- Modify: `public/index.html`

**Step 1: Добавить секцию Watcher Rules в Site Setup таб**

После секции Polling Settings, добавить HTML:
- Для каждого устройства: таблица правил, кнопка + Add Rule
- Инлайн-форма добавления правила (metric, type, min/max/alert_on, severity)
- Внизу: статус Watcher, кнопки Start/Stop, интервал

**Step 2: Добавить JavaScript функции**

- `renderWatcherRules()` — рендер таблиц правил из siteData
- `addRule(deviceId)` — POST /api/site/devices/:id/rules
- `removeRule(deviceId, ruleId)` — DELETE
- `startWatcher()` / `stopWatcher()` — POST /api/watcher/start|stop
- `loadWatcherStatus()` — GET /api/watcher/status, обновить UI

**Step 3: Проверить в браузере**

Перейти в Site Setup → Watcher Rules → добавить правило → Start Watcher → проверить статус.

**Step 4: Коммит**

```bash
git add public/index.html
git commit -m "feat: Watcher Rules UI in Site Setup tab"
```

---

### Task 8: Обновить docker-compose, CLAUDE.md, TODO.md

**Files:**
- Modify: `docker-compose.yml` — добавить volume для snapshots/
- Modify: `CLAUDE.md` — добавить новые модули и API
- Modify: `TODO.md` — отметить пункты 3, 4, 5 как выполненные

**Step 1: docker-compose.yml**

Добавить в volumes snmp-viewer:
```yaml
- ./snapshots:/usr/src/app/snapshots
```

**Step 2: Обновить CLAUDE.md и TODO.md**

**Step 3: Коммит и push**

```bash
git add docker-compose.yml CLAUDE.md TODO.md
git commit -m "docs: update for Watcher, Snapshot, Notifier"
git push origin main
```
