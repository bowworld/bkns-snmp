const path = require('path');
const fs = require('fs');
const os = require('os');

function assert(condition, msg) {
    if (!condition) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
}

// Используем временную директорию для тестов
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkns-test-'));
const siteFile = path.join(testDir, 'site.json');

const SiteManager = require('./lib/site-manager');

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

// Test 6: Удаление комнаты (пустой)
sm.removeRoom('hall2');
assert(sm.getSite().rooms.length === 1, 'empty room removed');

// Test 7: Удаление комнаты с устройствами — должна ошибка
let errorCaught = false;
try { sm.removeRoom('hall1'); } catch (e) { errorCaught = true; }
assert(errorCaught, 'cannot remove room with devices');

// Test 8: Удаление устройства
sm.removeDevice('cooling_yk0716110141');
assert(sm.getSite().devices.length === 0, 'device removed');

// Test 9: Обновление polling
sm.updatePolling({ interval: 1, snapshotWindow: 24 });
assert(sm.getSite().polling.interval === 1, 'interval updated to 1');

// Test 10: Невалидный interval
let intervalError = false;
try { sm.updatePolling({ interval: 3 }); } catch (e) { intervalError = true; }
assert(intervalError, 'invalid interval rejected');

// Test 11: Персистентность — перечитываем с диска
const sm2 = new SiteManager(siteFile);
assert(sm2.getSite().site.id === 'test-dc1', 'data persisted to disk');

// Test 12: Миграция из settings.json
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

// Test 13: Добавление устройства для тестов правил
sm.addDevice({
    device_sn: 'RULE_TEST_001',
    model: 'ACSC101',
    type: 'cooling',
    room: 'hall1',
    ip: '192.168.2.10',
    measurement: 'cooling'
});
const ruleDeviceId = 'cooling_ruletest001';
assert(sm.getSite().devices.find(d => d.id === ruleDeviceId), 'rule test device created');

// Test 14: Добавление правила к устройству
sm.addRule(ruleDeviceId, {
    id: 'r1',
    metric: 'airIRSCUnitStatusCoolOutput',
    type: 'discrete',
    alert_on: [1],
    severity: 'critical',
    description: 'Cooling unit went offline'
});
const ruleDevice = sm.getSite().devices.find(d => d.id === ruleDeviceId);
assert(ruleDevice.rules.length === 1, 'rule added to device');
assert(ruleDevice.rules[0].id === 'r1', 'rule id is r1');

// Test 15: Добавление второго правила
sm.addRule(ruleDeviceId, {
    id: 'r2',
    metric: 'airIRSCUnitStatusTemp',
    type: 'threshold',
    severity: 'warning',
    description: 'Temperature too high'
});
assert(sm.getSite().devices.find(d => d.id === ruleDeviceId).rules.length === 2, 'second rule added');

// Test 16: Дублирующий rule id отклоняется
let ruleError = false;
try {
    sm.addRule(ruleDeviceId, {
        id: 'r1',
        metric: 'duplicate',
        type: 'discrete'
    });
} catch (e) { ruleError = true; }
assert(ruleError, 'duplicate rule id rejected');

// Test 17: Удаление правила
sm.removeRule(ruleDeviceId, 'r1');
const afterRemove = sm.getSite().devices.find(d => d.id === ruleDeviceId);
assert(afterRemove.rules.length === 1, 'rule removed');
assert(afterRemove.rules[0].id === 'r2', 'remaining rule is r2');

// Test 18: getDevicesWithRules возвращает правильные устройства
const devicesWithRules = sm.getDevicesWithRules();
assert(devicesWithRules.length === 1, 'getDevicesWithRules returns 1 device');
assert(devicesWithRules[0].id === ruleDeviceId, 'correct device returned');

// Test 19: Устройство без правил не попадает в getDevicesWithRules
sm.removeRule(ruleDeviceId, 'r2');
assert(sm.getDevicesWithRules().length === 0, 'no devices with rules after removing all');

// Test 20: SMTP конфигурация через updateSiteInfo
sm.updateSiteInfo({ smtp: { host: 'smtp.example.com', port: 587, secure: true } });
const siteWithSmtp = sm.getSite();
assert(siteWithSmtp.site.smtp.host === 'smtp.example.com', 'smtp host saved');
assert(siteWithSmtp.site.smtp.port === 587, 'smtp port saved');
assert(siteWithSmtp.site.smtp.secure === true, 'smtp secure saved');

// Cleanup
fs.rmSync(testDir, { recursive: true });
console.log('\nAll tests passed!');
