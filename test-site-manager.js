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

// Cleanup
fs.rmSync(testDir, { recursive: true });
console.log('\nAll tests passed!');
