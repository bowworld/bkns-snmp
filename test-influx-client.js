function assert(condition, msg) {
    if (!condition) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
}

const InfluxClient = require('./lib/influx-client');

// ============================================================
// Test 1: buildLastValuesQuery — generates correct Flux
// ============================================================
function test1_buildLastValuesQuery() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const query = client.buildLastValuesQuery('cooling');

    assert(typeof query === 'string', 'Test1: query is a string');
    assert(query.includes('snmp-data'), 'Test1: query contains bucket name');
    assert(query.includes('cooling'), 'Test1: query contains measurement');
    assert(query.includes('last()'), 'Test1: query contains last() aggregation');
    assert(query.includes('pivot'), 'Test1: query contains pivot');
    assert(query.includes('-5m'), 'Test1: query contains -5m time range');
    assert(query.includes('_measurement'), 'Test1: query filters by _measurement');
    assert(query.includes('device_sn'), 'Test1: query groups by device_sn');
}

// ============================================================
// Test 2: buildRangeQuery — generates correct Flux
// ============================================================
function test2_buildRangeQuery() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const query = client.buildRangeQuery(['DEV1', 'DEV2'], 48);

    assert(typeof query === 'string', 'Test2: query is a string');
    assert(query.includes('snmp-data'), 'Test2: query contains bucket name');
    assert(query.includes('DEV1'), 'Test2: query contains first device_sn');
    assert(query.includes('DEV2'), 'Test2: query contains second device_sn');
    assert(query.includes('-48h'), 'Test2: query contains -48h time range');
    assert(query.includes('device_sn'), 'Test2: query filters by device_sn');
    assert(query.includes('range'), 'Test2: query contains range function');
}

// ============================================================
// Test 3: buildRangeQuery — single device
// ============================================================
function test3_buildRangeQuerySingleDevice() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const query = client.buildRangeQuery(['YK0716110141'], 24);

    assert(query.includes('YK0716110141'), 'Test3: query contains single device_sn');
    assert(query.includes('-24h'), 'Test3: query contains -24h range');
}

// ============================================================
// Test 4: parseCSV — InfluxDB annotated CSV with data
// ============================================================
function test4_parseCSV() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    // Typical InfluxDB annotated CSV response
    const csv = [
        '#group,false,false,true,true,false,false,true',
        '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,double,string,string',
        '#default,_result,,,,,,',
        ',result,table,_start,_stop,temperature,coolStatus,device_sn',
        ',,0,2026-02-22T00:00:00Z,2026-02-22T01:00:00Z,25.3,2,DEV1',
        ',,1,2026-02-22T00:00:00Z,2026-02-22T01:00:00Z,30.1,2,DEV2'
    ].join('\n');

    const rows = client.parseCSV(csv);

    assert(Array.isArray(rows), 'Test4: result is array');
    assert(rows.length === 2, 'Test4: 2 data rows parsed');

    // Check first row
    assert(rows[0].device_sn === 'DEV1', 'Test4: row 0 device_sn is DEV1');
    assert(rows[0].temperature === 25.3, 'Test4: row 0 temperature is 25.3 (number)');
    assert(rows[0].coolStatus === 2, 'Test4: row 0 coolStatus is 2 (number)');

    // Check second row
    assert(rows[1].device_sn === 'DEV2', 'Test4: row 1 device_sn is DEV2');
    assert(rows[1].temperature === 30.1, 'Test4: row 1 temperature is 30.1 (number)');
}

// ============================================================
// Test 5: parseCSV — skips annotation lines (#group, #datatype, #default)
// ============================================================
function test5_parseCSVSkipsAnnotations() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const csv = [
        '#group,false,false,true',
        '#datatype,string,long,string',
        '#default,_result,,',
        ',result,table,device_sn',
        ',,0,DEV1'
    ].join('\n');

    const rows = client.parseCSV(csv);
    assert(rows.length === 1, 'Test5: only 1 data row (annotations skipped)');
    assert(rows[0].device_sn === 'DEV1', 'Test5: device_sn parsed correctly');
}

// ============================================================
// Test 6: parseCSV — skips internal columns (result, table, empty first column)
// ============================================================
function test6_parseCSVSkipsInternalCols() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const csv = [
        '#group,false,false,true,true,false,false',
        '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,double,string',
        '#default,_result,,,,,',
        ',result,table,_start,_stop,temperature,device_sn',
        ',,0,2026-02-22T00:00:00Z,2026-02-22T01:00:00Z,25.3,DEV1'
    ].join('\n');

    const rows = client.parseCSV(csv);

    assert(rows.length === 1, 'Test6: 1 row');
    assert(rows[0].result === undefined, 'Test6: "result" column skipped');
    assert(rows[0].table === undefined, 'Test6: "table" column skipped');
    assert(rows[0][''] === undefined, 'Test6: empty column skipped');
    assert(rows[0]._start === undefined, 'Test6: _start column skipped');
    assert(rows[0]._stop === undefined, 'Test6: _stop column skipped');
    assert(rows[0].temperature === 25.3, 'Test6: temperature present');
    assert(rows[0].device_sn === 'DEV1', 'Test6: device_sn present');
}

// ============================================================
// Test 7: parseCSV — empty response
// ============================================================
function test7_parseCSVEmpty() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const rows1 = client.parseCSV('');
    assert(Array.isArray(rows1) && rows1.length === 0, 'Test7a: empty string → empty array');

    const rows2 = client.parseCSV('\n\n');
    assert(Array.isArray(rows2) && rows2.length === 0, 'Test7b: whitespace-only → empty array');

    // Only annotations, no data
    const csv3 = [
        '#group,false,false',
        '#datatype,string,long',
        '#default,_result,'
    ].join('\n');
    const rows3 = client.parseCSV(csv3);
    assert(Array.isArray(rows3) && rows3.length === 0, 'Test7c: only annotations → empty array');
}

// ============================================================
// Test 8: parseCSV — numeric conversion
// ============================================================
function test8_parseCSVNumericConversion() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const csv = [
        '#group,false,false,false,false,false',
        '#datatype,string,long,double,long,string',
        '#default,_result,,,,',
        ',result,table,temperature,uptime,device_sn',
        ',,0,25.7,86400,DEV1',
        ',,1,-3.5,0,DEV2'
    ].join('\n');

    const rows = client.parseCSV(csv);

    assert(rows[0].temperature === 25.7, 'Test8: 25.7 is number');
    assert(rows[0].uptime === 86400, 'Test8: 86400 is number');
    assert(rows[1].temperature === -3.5, 'Test8: -3.5 is number');
    assert(rows[1].uptime === 0, 'Test8: 0 is number');
    assert(typeof rows[0].device_sn === 'string', 'Test8: device_sn stays string');
}

// ============================================================
// Test 9: Constructor stores parameters
// ============================================================
function test9_constructorParams() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    assert(client.url === 'http://influxdb:8086', 'Test9: url stored');
    assert(client.token === 'my-token', 'Test9: token stored');
    assert(client.org === 'bkns', 'Test9: org stored');
    assert(client.bucket === 'snmp-data', 'Test9: bucket stored');
}

// ============================================================
// Test 10: parseCSV — multiple tables (InfluxDB returns multiple table IDs)
// ============================================================
function test10_parseCSVMultipleTables() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const csv = [
        '#group,false,false,false,false',
        '#datatype,string,long,double,string',
        '#default,_result,,,',
        ',result,table,temperature,device_sn',
        ',,0,25.3,DEV1',
        ',,0,25.5,DEV1',
        '',
        '#group,false,false,false,false',
        '#datatype,string,long,double,string',
        '#default,_result,,,',
        ',result,table,temperature,device_sn',
        ',,1,30.1,DEV2',
        ',,1,30.3,DEV2'
    ].join('\n');

    const rows = client.parseCSV(csv);
    assert(rows.length === 4, 'Test10: 4 data rows from multiple tables');
}

// ============================================================
// Test 11: parseCSV — handles trailing newline
// ============================================================
function test11_parseCSVTrailingNewline() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    const csv = [
        '#group,false,false,false',
        '#datatype,string,long,string',
        '#default,_result,,',
        ',result,table,device_sn',
        ',,0,DEV1',
        ''  // trailing newline
    ].join('\n');

    const rows = client.parseCSV(csv);
    assert(rows.length === 1, 'Test11: trailing newline does not create extra row');
}

// ============================================================
// Test 12: query and queryRange are async functions
// ============================================================
function test12_asyncMethods() {
    const client = new InfluxClient({
        url: 'http://influxdb:8086',
        token: 'my-super-secret-auth-token',
        org: 'bkns',
        bucket: 'snmp-data'
    });

    assert(typeof client.query === 'function', 'Test12: query is a function');
    assert(typeof client.queryRange === 'function', 'Test12: queryRange is a function');
    assert(typeof client._post === 'function', 'Test12: _post is a function');
}

// ============================================================
// Run all tests
// ============================================================
function runAll() {
    test1_buildLastValuesQuery();
    test2_buildRangeQuery();
    test3_buildRangeQuerySingleDevice();
    test4_parseCSV();
    test5_parseCSVSkipsAnnotations();
    test6_parseCSVSkipsInternalCols();
    test7_parseCSVEmpty();
    test8_parseCSVNumericConversion();
    test9_constructorParams();
    test10_parseCSVMultipleTables();
    test11_parseCSVTrailingNewline();
    test12_asyncMethods();

    console.log('\nAll influx-client tests passed!');
}

runAll();
