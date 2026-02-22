const { EventEmitter } = require('events');

function assert(condition, msg) {
    if (!condition) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
}

// Helper: создаёт mock influx client, возвращающий заданные данные по measurement
function createMockInflux(dataByMeasurement) {
    return {
        async query(measurement) {
            return dataByMeasurement[measurement] || [];
        }
    };
}

// Helper: собирает все events 'incident' в массив
function collectIncidents(watcher) {
    const incidents = [];
    watcher.on('incident', (evt) => incidents.push(evt));
    return incidents;
}

const Watcher = require('./lib/watcher');

// ============================================================
// Test 1: Discrete — ok value (no alert), then alert value (incident emitted)
// ============================================================
async function test1_discreteOkThenAlert() {
    let callCount = 0;
    const influx = {
        async query(measurement) {
            callCount++;
            if (callCount === 1) {
                // Первый check: значение 2 (ok) — не входит в alert_on
                return [{ device_sn: 'DEV1', coolStatus: 2 }];
            }
            // Второй check: значение 1 (alert) — входит в alert_on
            return [{ device_sn: 'DEV1', coolStatus: 1 }];
        }
    };

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    // Первый check: ok
    await watcher.check();
    assert(incidents.length === 0, 'Test1: ok value — no incident');

    // Второй check: alert
    await watcher.check();
    assert(incidents.length === 1, 'Test1: alert value — incident emitted');
    assert(incidents[0].device_sn === 'DEV1', 'Test1: device_sn correct');
    assert(incidents[0].measurement === 'cooling', 'Test1: measurement correct');
    assert(incidents[0].room === 'hall1', 'Test1: room correct');
    assert(incidents[0].rule.id === 'r1', 'Test1: rule.id correct');
    assert(incidents[0].value === 1, 'Test1: value correct');
    assert(incidents[0].timestamp instanceof Date, 'Test1: timestamp is Date');
}

// ============================================================
// Test 2: No duplicate incident on repeated alert
// ============================================================
async function test2_noDuplicateOnRepeatedAlert() {
    const influx = createMockInflux({
        cooling: [{ device_sn: 'DEV1', coolStatus: 1 }]
    });

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    await watcher.check(); // ok→alert — incident
    await watcher.check(); // alert→alert — no duplicate
    await watcher.check(); // alert→alert — no duplicate

    assert(incidents.length === 1, 'Test2: only 1 incident despite 3 checks with alert value');
}

// ============================================================
// Test 3: Recovery (alert→ok) without incident
// ============================================================
async function test3_recoveryNoIncident() {
    let callCount = 0;
    const influx = {
        async query() {
            callCount++;
            if (callCount <= 1) {
                return [{ device_sn: 'DEV1', coolStatus: 1 }]; // alert
            }
            return [{ device_sn: 'DEV1', coolStatus: 2 }]; // ok
        }
    };

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    await watcher.check(); // ok→alert
    assert(incidents.length === 1, 'Test3: alert emitted');

    await watcher.check(); // alert→ok (recovery)
    assert(incidents.length === 1, 'Test3: recovery did NOT emit another incident');

    // Проверим что state вернулся в ok — повторный alert должен дать новый incident
    // Для этого вернём данные с alert значением
    callCount = 0; // reset to get alert again
    await watcher.check();
    assert(incidents.length === 2, 'Test3: new ok→alert after recovery emits incident');
}

// ============================================================
// Test 4: Threshold — ok → breach detected
// ============================================================
async function test4_thresholdBreach() {
    let callCount = 0;
    const influx = {
        async query() {
            callCount++;
            if (callCount === 1) {
                return [{ device_sn: 'DEV2', temperature: 25 }]; // ok (within 10..35)
            }
            return [{ device_sn: 'DEV2', temperature: 40 }]; // breach (> max)
        }
    };

    const rules = [
        {
            device_sn: 'DEV2',
            measurement: 'cooling',
            room: 'hall2',
            rule: {
                id: 'r_temp',
                metric: 'temperature',
                type: 'threshold',
                min: 10,
                max: 35,
                severity: 'warning',
                description: 'Temperature out of range'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    await watcher.check(); // ok
    assert(incidents.length === 0, 'Test4: within range — no incident');

    await watcher.check(); // breach
    assert(incidents.length === 1, 'Test4: threshold breach — incident emitted');
    assert(incidents[0].value === 40, 'Test4: value is 40');
    assert(incidents[0].rule.id === 'r_temp', 'Test4: rule.id correct');
}

// ============================================================
// Test 5: Threshold — below min
// ============================================================
async function test5_thresholdBelowMin() {
    let callCount = 0;
    const influx = {
        async query() {
            callCount++;
            if (callCount === 1) {
                return [{ device_sn: 'DEV2', temperature: 20 }]; // ok
            }
            return [{ device_sn: 'DEV2', temperature: 5 }]; // breach (< min)
        }
    };

    const rules = [
        {
            device_sn: 'DEV2',
            measurement: 'cooling',
            room: 'hall2',
            rule: {
                id: 'r_temp_low',
                metric: 'temperature',
                type: 'threshold',
                min: 10,
                max: 35,
                severity: 'warning',
                description: 'Temperature too low'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    await watcher.check();
    assert(incidents.length === 0, 'Test5: within range — no incident');

    await watcher.check();
    assert(incidents.length === 1, 'Test5: below min — incident emitted');
    assert(incidents[0].value === 5, 'Test5: value is 5');
}

// ============================================================
// Test 6: No data — no error, no false alert
// ============================================================
async function test6_noData() {
    const influx = createMockInflux({ cooling: [] }); // empty result

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    // Не должно ни крашнуть, ни создать ложный алерт
    await watcher.check();
    await watcher.check();
    assert(incidents.length === 0, 'Test6: no data — no incidents, no errors');
}

// ============================================================
// Test 7: No data for specific device_sn (device missing from query result)
// ============================================================
async function test7_deviceMissingFromResult() {
    const influx = createMockInflux({
        cooling: [{ device_sn: 'OTHER_DEV', coolStatus: 1 }] // Different device
    });

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    await watcher.check();
    assert(incidents.length === 0, 'Test7: device missing from data — no false alert');
}

// ============================================================
// Test 8: start() / stop() — setInterval management
// ============================================================
async function test8_startStop() {
    const influx = createMockInflux({ cooling: [] });

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => [],
        checkInterval: 100 // 100ms для теста
    });

    assert(!watcher.getStatus().running, 'Test8: not running initially');

    watcher.start();
    assert(watcher.getStatus().running, 'Test8: running after start()');

    watcher.stop();
    assert(!watcher.getStatus().running, 'Test8: not running after stop()');
}

// ============================================================
// Test 9: getStatus() — returns correct info
// ============================================================
async function test9_getStatus() {
    const influx = createMockInflux({
        cooling: [{ device_sn: 'DEV1', coolStatus: 1 }]
    });

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    let status = watcher.getStatus();
    assert(status.running === false, 'Test9: not running');
    assert(status.lastCheck === null, 'Test9: lastCheck is null before first check');
    assert(Array.isArray(status.activeAlerts) && status.activeAlerts.length === 0, 'Test9: 0 active alerts initially');

    await watcher.check();

    status = watcher.getStatus();
    assert(status.lastCheck instanceof Date, 'Test9: lastCheck is Date after check');
    assert(Array.isArray(status.activeAlerts) && status.activeAlerts.length === 1, 'Test9: 1 active alert after incident');
    assert(status.activeAlerts[0] === 'DEV1_coolStatus', 'Test9: active alert key correct');
}

// ============================================================
// Test 10: Watcher extends EventEmitter
// ============================================================
async function test10_isEventEmitter() {
    const watcher = new Watcher({
        influxClient: createMockInflux({}),
        getRules: () => [],
        checkInterval: 60000
    });

    assert(watcher instanceof EventEmitter, 'Test10: Watcher extends EventEmitter');
}

// ============================================================
// Test 11: Multiple rules, multiple devices
// ============================================================
async function test11_multipleRulesAndDevices() {
    const influx = createMockInflux({
        cooling: [
            { device_sn: 'DEV1', coolStatus: 1, temperature: 25 },
            { device_sn: 'DEV2', coolStatus: 2, temperature: 40 }
        ]
    });

    const rules = [
        {
            device_sn: 'DEV1',
            measurement: 'cooling',
            room: 'hall1',
            rule: {
                id: 'r1',
                metric: 'coolStatus',
                type: 'discrete',
                alert_on: [1],
                severity: 'critical',
                description: 'Cooling offline'
            }
        },
        {
            device_sn: 'DEV2',
            measurement: 'cooling',
            room: 'hall2',
            rule: {
                id: 'r2',
                metric: 'temperature',
                type: 'threshold',
                min: 10,
                max: 35,
                severity: 'warning',
                description: 'Temperature out of range'
            }
        }
    ];

    const watcher = new Watcher({
        influxClient: influx,
        getRules: () => rules,
        checkInterval: 60000
    });

    const incidents = collectIncidents(watcher);

    await watcher.check();
    assert(incidents.length === 2, 'Test11: 2 incidents from 2 different devices/rules');

    const devSns = incidents.map(i => i.device_sn).sort();
    assert(devSns[0] === 'DEV1' && devSns[1] === 'DEV2', 'Test11: both devices reported');
}

// ============================================================
// Run all tests
// ============================================================
async function runAll() {
    await test1_discreteOkThenAlert();
    await test2_noDuplicateOnRepeatedAlert();
    await test3_recoveryNoIncident();
    await test4_thresholdBreach();
    await test5_thresholdBelowMin();
    await test6_noData();
    await test7_deviceMissingFromResult();
    await test8_startStop();
    await test9_getStatus();
    await test10_isEventEmitter();
    await test11_multipleRulesAndDevices();

    console.log('\nAll watcher tests passed!');
}

runAll().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
