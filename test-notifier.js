const nodemailer = require('nodemailer');

function assert(condition, msg) {
    if (!condition) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
}

const Notifier = require('./lib/notifier');

// ============================================================
// Test fixtures
// ============================================================

function createMeta() {
    return {
        snapshot_id: 'snap-abc-123',
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
}

function createNotifier() {
    // jsonTransport — nodemailer test transport, no SMTP needed
    return new Notifier({
        transport: { jsonTransport: true },
        from: 'bkns@vicomplus.kz'
    });
}

// ============================================================
// Test 1: Email sent with correct subject (has severity, device_sn)
// ============================================================
async function test1_correctSubject() {
    const notifier = createNotifier();
    const meta = createMeta();

    const result = await notifier.send({
        to: 'admin@customer.kz',
        meta,
        attachmentPath: null
    });

    // jsonTransport returns message as JSON string in result.message
    const message = JSON.parse(result.message);

    assert(
        message.subject.includes('critical'),
        'Test1: subject contains severity'
    );
    assert(
        message.subject.includes('DEV1'),
        'Test1: subject contains device_sn'
    );
    assert(
        message.subject.includes('Cooling unit went offline'),
        'Test1: subject contains description'
    );
    assert(
        message.subject.startsWith('[BKNS]'),
        'Test1: subject starts with [BKNS]'
    );
}

// ============================================================
// Test 2: Correct recipient
// ============================================================
async function test2_correctRecipient() {
    const notifier = createNotifier();
    const meta = createMeta();

    const result = await notifier.send({
        to: 'admin@customer.kz',
        meta,
        attachmentPath: null
    });

    const message = JSON.parse(result.message);
    const toHeader = message.to;

    // nodemailer jsonTransport returns to as array of {address, name}
    const addresses = toHeader.map(t => t.address);
    assert(
        addresses.includes('admin@customer.kz'),
        'Test2: recipient is admin@customer.kz'
    );
}

// ============================================================
// Test 3: Body contains device info
// ============================================================
async function test3_bodyContainsDeviceInfo() {
    const notifier = createNotifier();
    const meta = createMeta();

    const result = await notifier.send({
        to: 'admin@customer.kz',
        meta,
        attachmentPath: null
    });

    const message = JSON.parse(result.message);
    const body = message.text;

    assert(body.includes('DEV1'), 'Test3: body contains device_sn');
    assert(body.includes('ACSC101'), 'Test3: body contains device_model');
    assert(body.includes('hall1'), 'Test3: body contains room');
    assert(body.includes('status'), 'Test3: body contains metric');
    assert(body.includes('critical'), 'Test3: body contains severity');
    assert(body.includes('snap-abc-123'), 'Test3: body contains snapshot_id');
    assert(body.includes('Test DC'), 'Test3: body contains site name');
}

// ============================================================
// Test 4: When attachmentPath is null, no attachments
// ============================================================
async function test4_noAttachmentWhenNull() {
    const notifier = createNotifier();
    const meta = createMeta();

    const result = await notifier.send({
        to: 'admin@customer.kz',
        meta,
        attachmentPath: null
    });

    const message = JSON.parse(result.message);

    // jsonTransport: no attachments means no 'attachments' key or empty array
    const hasAttachments = message.attachments && message.attachments.length > 0;
    assert(!hasAttachments, 'Test4: no attachments when attachmentPath is null');
}

// ============================================================
// Run all tests
// ============================================================
async function runAll() {
    await test1_correctSubject();
    await test2_correctRecipient();
    await test3_bodyContainsDeviceInfo();
    await test4_noAttachmentWhenNull();

    console.log('\nAll notifier tests passed!');
}

runAll().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
