const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const tar = require('tar-stream');

function assert(condition, msg) {
    if (!condition) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
}

const SnapshotGenerator = require('./lib/snapshot');

// ============================================================
// Test fixtures
// ============================================================

const MOCK_CSV_DATA = [
    '#group,false,false,true,true,false,false,true',
    '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,double,string,string',
    '#default,_result,,,,,,',
    ',result,table,_start,_stop,temperature,coolStatus,device_sn',
    ',,0,2026-02-22T00:00:00Z,2026-02-22T01:00:00Z,25.3,2,DEV1',
    ',,1,2026-02-22T00:00:00Z,2026-02-22T01:00:00Z,30.1,2,DEV2'
].join('\n');

function createMockInflux() {
    return {
        async queryRange(deviceSNs, hours) {
            return MOCK_CSV_DATA;
        }
    };
}

function createSiteData() {
    return {
        site: { id: 'customerX-dc1', name: 'ЦОД Заказчик X' },
        rooms: [
            { id: 'hall1', name: 'Зал 1' },
            { id: 'hall2', name: 'Зал 2' }
        ],
        devices: [
            { id: 'cooling_dev1', device_sn: 'DEV1', model: 'ACSC101', type: 'cooling', room: 'hall1', ip: '192.168.2.1', measurement: 'cooling' },
            { id: 'cooling_dev2', device_sn: 'DEV2', model: 'ACSC102', type: 'cooling', room: 'hall1', ip: '192.168.2.2', measurement: 'cooling' },
            { id: 'ups_dev3', device_sn: 'DEV3', model: 'UPS3000', type: 'ups', room: 'hall2', ip: '192.168.2.3', measurement: 'ups' }
        ],
        polling: { interval: 5, snapshotWindow: 48 }
    };
}

function createIncident() {
    return {
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
        },
        value: 1,
        timestamp: new Date('2026-02-22T10:30:00Z')
    };
}

/**
 * Extract files from a tar.gz buffer.
 * Returns Map<filename, contentString>.
 */
function extractTarGz(buffer) {
    return new Promise((resolve, reject) => {
        const extract = tar.extract();
        const files = new Map();

        extract.on('entry', (header, stream, next) => {
            let data = '';
            stream.on('data', (chunk) => { data += chunk.toString(); });
            stream.on('end', () => {
                files.set(header.name, data);
                next();
            });
            stream.resume();
        });

        extract.on('finish', () => resolve(files));
        extract.on('error', reject);

        const gunzip = zlib.createGunzip();
        gunzip.on('error', reject);
        gunzip.pipe(extract);
        gunzip.end(buffer);
    });
}

// ============================================================
// Test 1: Snapshot file created (tar.gz exists)
// ============================================================
async function test1_snapshotFileCreated() {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const gen = new SnapshotGenerator({
        influxClient: createMockInflux(),
        outputDir
    });

    const result = await gen.generate(createIncident(), createSiteData());

    assert(fs.existsSync(result.filePath), 'Test1: snapshot file exists on disk');
    assert(result.filePath.endsWith('.tar.gz'), 'Test1: file has .tar.gz extension');
    assert(result.filename.length > 0, 'Test1: filename is non-empty');
    assert(result.meta !== undefined, 'Test1: meta returned');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
}

// ============================================================
// Test 2: Filename format correct (has site id, .tar.gz extension)
// ============================================================
async function test2_filenameFormat() {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const gen = new SnapshotGenerator({
        influxClient: createMockInflux(),
        outputDir
    });

    const result = await gen.generate(createIncident(), createSiteData());

    assert(result.filename.startsWith('snapshot_customerX-dc1_'), 'Test2: filename starts with snapshot_{site.id}_');
    assert(result.filename.endsWith('.tar.gz'), 'Test2: filename ends with .tar.gz');
    // No colons or dots in timestamp part (before .tar.gz)
    const timestampPart = result.filename.replace('snapshot_customerX-dc1_', '').replace('.tar.gz', '');
    assert(!timestampPart.includes(':'), 'Test2: no colons in timestamp');
    assert(!timestampPart.includes('.'), 'Test2: no dots in timestamp');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
}

// ============================================================
// Test 3: meta.json has correct scope (only room devices included)
// ============================================================
async function test3_metaRoomScope() {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const gen = new SnapshotGenerator({
        influxClient: createMockInflux(),
        outputDir
    });

    const result = await gen.generate(createIncident(), createSiteData());

    // Incident is in hall1 — devices DEV1, DEV2 are in hall1; DEV3 is in hall2
    const meta = result.meta;
    assert(meta.devices_included.length === 2, 'Test3: 2 devices included (hall1 only)');

    const sns = meta.devices_included.map(d => d.device_sn).sort();
    assert(sns[0] === 'DEV1' && sns[1] === 'DEV2', 'Test3: DEV1 and DEV2 included (same room)');

    // DEV3 (hall2) should NOT be included
    const hasDev3 = meta.devices_included.some(d => d.device_sn === 'DEV3');
    assert(!hasDev3, 'Test3: DEV3 (different room) NOT included');

    // Also verify from tar.gz contents
    const buffer = fs.readFileSync(result.filePath);
    const files = await extractTarGz(buffer);
    const metaFromTar = JSON.parse(files.get('meta.json'));

    assert(metaFromTar.devices_included.length === 2, 'Test3: meta.json in tar has 2 devices');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
}

// ============================================================
// Test 4: Incident info preserved in meta
// ============================================================
async function test4_incidentInfoInMeta() {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const gen = new SnapshotGenerator({
        influxClient: createMockInflux(),
        outputDir
    });

    const incident = createIncident();
    const result = await gen.generate(incident, createSiteData());
    const meta = result.meta;

    assert(meta.incident !== undefined, 'Test4: meta has incident field');
    assert(meta.incident.device_sn === 'DEV1', 'Test4: incident device_sn preserved');
    assert(meta.incident.measurement === 'cooling', 'Test4: incident measurement preserved');
    assert(meta.incident.room === 'hall1', 'Test4: incident room preserved');
    assert(meta.incident.rule.id === 'r1', 'Test4: incident rule.id preserved');
    assert(meta.incident.value === 1, 'Test4: incident value preserved');
    assert(meta.incident.timestamp !== undefined, 'Test4: incident timestamp preserved');

    // Verify site info in meta
    assert(meta.site.id === 'customerX-dc1', 'Test4: site id in meta');
    assert(meta.site.name === 'ЦОД Заказчик X', 'Test4: site name in meta');

    // Verify version and snapshot_id
    assert(typeof meta.version === 'string', 'Test4: meta has version');
    assert(typeof meta.snapshot_id === 'string', 'Test4: meta has snapshot_id (UUID)');
    assert(meta.snapshot_id.length === 36, 'Test4: snapshot_id is UUID format (36 chars)');
    assert(typeof meta.created_at === 'string', 'Test4: meta has created_at');

    // Verify period
    assert(meta.period !== undefined, 'Test4: meta has period');
    assert(meta.period.hours === 48, 'Test4: period hours matches snapshotWindow');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
}

// ============================================================
// Test 5: File is valid gzip (can decompress without error)
// ============================================================
async function test5_validGzip() {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const gen = new SnapshotGenerator({
        influxClient: createMockInflux(),
        outputDir
    });

    const result = await gen.generate(createIncident(), createSiteData());
    const buffer = fs.readFileSync(result.filePath);

    // Verify gzip magic bytes (1f 8b)
    assert(buffer[0] === 0x1f && buffer[1] === 0x8b, 'Test5: file starts with gzip magic bytes');

    // Decompress and extract — should not throw
    let extractedOk = false;
    try {
        const files = await extractTarGz(buffer);
        assert(files.has('meta.json'), 'Test5: tar contains meta.json');
        assert(files.has('data.lp'), 'Test5: tar contains data.lp');
        extractedOk = true;
    } catch (err) {
        extractedOk = false;
    }
    assert(extractedOk, 'Test5: tar.gz decompresses and extracts without error');

    // Verify data.lp content matches mock CSV
    const files = await extractTarGz(buffer);
    const dataLp = files.get('data.lp');
    assert(dataLp === MOCK_CSV_DATA, 'Test5: data.lp contains the InfluxDB CSV data');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
}

// ============================================================
// Run all tests
// ============================================================
async function runAll() {
    await test1_snapshotFileCreated();
    await test2_filenameFormat();
    await test3_metaRoomScope();
    await test4_incidentInfoInMeta();
    await test5_validGzip();

    console.log('\nAll snapshot tests passed!');
}

runAll().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
