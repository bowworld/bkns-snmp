const express = require('express');
const snmp = require('net-snmp');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const MibManager = require('./lib/mib-manager');

const app = express();
const port = 3000;

// Set up MIB storage
const mibsDir = path.join(__dirname, 'mibs');
if (!fs.existsSync(mibsDir)) {
    fs.mkdirSync(mibsDir, { recursive: true });
}

// Settings storage
const settingsFile = path.join(__dirname, 'settings.json');
if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
        measurement: 'snmp',
        tags: [
            { key: 'device', value: 'ups_1' },
            { key: 'zone', value: 'ups_room' }
        ],
        fields: [
            { key: 'temp_c', value: '1.3.6.1.4.1.999.1.1' },
            { key: 'load_pct', value: '1.3.6.1.4.1.999.1.2' }
        ]
    }));
}

function getSettings() {
    try {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (!settings.fields) {
            settings.fields = [
                { key: 'temp_c', value: '42.3' },
                { key: 'load_pct', value: '73.2' }
            ];
        }
        return settings;
    } catch (e) {
        return {
            measurement: 'snmp',
            tags: [
                { key: 'device', value: 'ups_1' },
                { key: 'zone', value: 'ups_room' }
            ],
            fields: [
                { key: 'temp_c', value: '42.3' },
                { key: 'load_pct', value: '73.2' }
            ]
        };
    }
}

function saveSettings(settings) {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// Initialize MIB library
const mibManager = new MibManager(mibsDir);

// Pre-load all available MIBs so they are available for translation immediately
const availableMibs = mibManager.getMibFiles();
if (availableMibs.length > 0) {
    console.log(`Pre-loading ${availableMibs.length} MIB files...`);
    mibManager.loadMibs(availableMibs);
}

// Configure multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, mibsDir)
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname)
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// Helper to check if a string is a numeric OID
function isOid(s) {
    return /^\d+(\.\d+)*$/.test(s);
}

// API: Get available MIBs
app.get('/api/mibs', (req, res) => {
    try {
        const files = mibManager.getMibFiles();
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Upload MIB
app.post('/api/upload-mib', upload.array('mibFiles'), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }
    const filenames = req.files.map(f => f.filename);
    res.json({ message: `${filenames.length} files uploaded successfully`, filenames });
});

// API: Delete MIBs
app.delete('/api/mibs', (req, res) => {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Invalid files list' });
    }

    const results = { deleted: [], errors: [] };
    files.forEach(filename => {
        const filePath = path.join(mibsDir, filename);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                results.deleted.push(filename);
            } else {
                results.errors.push(`${filename} not found`);
            }
        } catch (err) {
            results.errors.push(`Failed to delete ${filename}: ${err.message}`);
        }
    });

    res.json(results);
});

// API: Settings
app.get('/api/settings', (req, res) => {
    res.json(getSettings());
});

app.post('/api/settings', (req, res) => {
    const settings = getSettings();
    if (req.body.measurement) {
        settings.measurement = req.body.measurement;
    }
    if (req.body.tags && Array.isArray(req.body.tags)) {
        settings.tags = req.body.tags;
    }
    if (req.body.fields && Array.isArray(req.body.fields)) {
        settings.fields = req.body.fields;
    }
    if (req.body.tableMappings && Array.isArray(req.body.tableMappings)) {
        settings.tableMappings = req.body.tableMappings;
    }
    saveSettings(settings);
    res.json({ message: 'Settings saved' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        // A Multer error occurred when uploading.
        return res.status(400).json({ error: 'Upload error: ' + err.message });
    } else if (err) {
        // An unknown error occurred.
        return res.status(500).json({ error: err.message });
    }
    next();
});

app.get('/api/snmp-walk', (req, res) => {
    const target = req.query.target || '192.168.2.1';
    let rootOid = req.query.oid || '1.3.6'; // Default to Internet branch (includes MIB-2 and Enterprises)
    const selectedMibs = req.query.mibs ? req.query.mibs.split(',') : [];

    // Sanitize OID (remove leading/trailing dots and spaces)
    rootOid = rootOid.trim().replace(/^\./, '').replace(/\.$/, '');

    // Load selected MIBs
    if (selectedMibs.length > 0) {
        const loadResult = mibManager.loadMibs(selectedMibs);
        console.log('MIB Load Result:', loadResult);

        // Try to resolve symbolic name if provided
        const originalOid = rootOid;
        rootOid = mibManager.resolveSymbol(rootOid);
        console.log(`Resolved OID: ${originalOid} -> ${rootOid}`);
    }

    // SNMP Version and Parameters
    const versionStr = req.query.version || '1';
    let version = snmp.Version1;
    if (versionStr === '2c') version = snmp.Version2c;

    console.log(`Starting walk for ${target} with rootOid: ${rootOid}, version: ${versionStr}`);

    let session;
    try {
        if (versionStr === '3') {
            const user = {
                name: req.query.v3_user || 'user',
                level: snmp.SecurityLevel.noAuthNoPriv
            };

            // Authentication settings
            if (req.query.v3_auth_proto && req.query.v3_auth_proto !== 'none') {
                user.authProtocol = snmp.AuthProtocols[req.query.v3_auth_proto];
                user.authPassword = req.query.v3_auth_pwd;
                user.level = snmp.SecurityLevel.authNoPriv;
            }

            // Privacy settings
            if (req.query.v3_priv_proto && req.query.v3_priv_proto !== 'none') {
                user.privProtocol = snmp.PrivProtocols[req.query.v3_priv_proto];
                user.privPassword = req.query.v3_priv_pwd;
                user.level = snmp.SecurityLevel.authPriv;
            }

            session = snmp.createV3Session(target, user);
        } else {
            const community = req.query.community || 'public';
            session = snmp.createSession(target, community, { version: version });
        }
    } catch (err) {
        console.error("Session creation error:", err);
        return res.status(400).json({ error: "Failed to create SNMP session: " + err.message });
    }

    // We will store all varbinds here
    const results = [];

    session.subtree(rootOid, function (varbinds) {
        for (let i = 0; i < varbinds.length; i++) {
            if (snmp.isVarbindError(varbinds[i])) {
                console.error(snmp.varbindError(varbinds[i]));
            } else {
                const vb = {
                    oid: varbinds[i].oid,
                    value: varbinds[i].value.toString()
                };

                // Enrich with MIB data if available - try raw OID and with .0 for scalars
                let mibInfo = mibManager.lookupOid(vb.oid);
                if (!mibInfo) {
                    mibInfo = mibManager.lookupOid(vb.oid + '.0');
                }

                if (mibInfo) {
                    vb.name = mibInfo.name;
                    vb.description = mibInfo.description;
                    vb.enums = mibInfo.enums;

                    // If it's an enum, map the value
                    if (vb.enums && vb.enums[vb.value]) {
                        vb.value = `${vb.value} (${vb.enums[vb.value]})`;
                    }
                }

                results.push(vb);
            }
        }
    }, function (error) {
        if (error) {
            console.error(error);
            res.status(500).json({ error: error.toString() });
        } else {
            // Process results into tables
            const tables = processToTables(results, mibManager, selectedMibs);
            res.json({ raw: results, tables: tables });
        }
        session.close();
    });
});

/**
 * Heuristic to group OIDs into tables.
 * Tables usually have OIDs like: Prefix.Column.Index
 * We look for OIDs that share the same Prefix and Column but have different Indices,
 * and then group them by Index across different Columns.
 */
function processToTables(results, mibManager, selectedMibs) {
    // 1. Organize by potential "row index" (last part of OID)
    // This is a naive first pass. Better: Group by potential "Table Entry" prefix.

    // Algorithm:
    // Identify common prefixes. 
    // If we have 1.3.6.1.2.1.2.2.1.1.1 and 1.3.6.1.2.1.2.2.1.1.2 -> same column (1.3.6.1.2.1.2.2.1.1)
    // If we have 1.3.6.1.2.1.2.2.1.2.1 and 1.3.6.1.2.1.2.2.1.2.2 -> same column (1.3.6.1.2.1.2.2.1.2)
    // These two columns share the same parent (1.3.6.1.2.1.2.2.1) -> potential table.

    // Step 1: Group by potential column (parent OID)
    const columns = {};
    results.forEach(r => {
        const parts = r.oid.split('.');
        const index = parts.pop(); // The last number is often the index (or part of it)
        const parent = parts.join('.');

        if (!columns[parent]) {
            columns[parent] = [];
        }
        // Store name if we have it from the first entry of this column? 
        // Or store it with the entry.
        columns[parent].push({ index, value: r.value, fullOid: r.oid, name: r.name });
    });

    // Step 2: Group columns by THEIR parent to find tables
    const potentialTables = {};

    Object.keys(columns).forEach(colOid => {
        const parts = colOid.split('.');
        const colId = parts.pop(); // The column ID
        const tableEntryOid = parts.join('.'); // The table entry OID

        if (!potentialTables[tableEntryOid]) {
            potentialTables[tableEntryOid] = {};
        }
        potentialTables[tableEntryOid][colId] = columns[colOid];
    });

    // Step 3: Format for frontend
    // We want to return a list of tables. Each table has a name (OID) and rows.
    const finalTables = [];

    Object.keys(potentialTables).forEach(tableOid => {
        const cols = potentialTables[tableOid];
        const colIds = Object.keys(cols);

        // Try to find a human readable name for the table if possible
        // Usually table entry name. 
        // e.g. if sysDescr is 1.3.6.1.2.1.1.1, the table usually doesn't apply.
        // If ifTable is 1.3.6.1.2.1.2.2, ifEntry is .1. 
        // Our 'tableOid' is likely the ifEntry OID.

        let tableName = tableOid;
        // Check if we have a name for this table OID from MIB lookup
        const tableMibInfo = mibManager.lookupOid(tableOid, selectedMibs);
        if (tableMibInfo) {
            tableName = `${tableMibInfo.name} (${tableOid})`;
        }

        // Build column names and descriptions map
        const columnNames = {};
        const columnDescriptions = {};
        colIds.forEach(cId => {
            // Reconstruct the full OID for the column definition (parent + colId)
            const fullColOid = `${tableOid}.${cId}`;
            const colMibInfo = mibManager.lookupOid(fullColOid, selectedMibs);
            columnNames[cId] = colMibInfo ? colMibInfo.name : cId;
            columnDescriptions[cId] = colMibInfo ? colMibInfo.description : '';
        });

        const allIndices = new Set();
        colIds.forEach(cId => {
            cols[cId].forEach(entry => allIndices.add(entry.index));
        });

        const rows = [];
        Array.from(allIndices).sort((a, b) => parseInt(a) - parseInt(b)).forEach(idx => {
            const row = { index: idx };
            colIds.forEach(cId => {
                const entry = cols[cId].find(e => e.index === idx);
                row[cId] = entry ? entry.value : null;
            });
            rows.push(row);
        });

        if (rows.length > 0) {
            finalTables.push({
                oid: tableName,
                tableOid: tableOid,
                columns: colIds,
                columnNames: columnNames,
                columnDescriptions: columnDescriptions,
                rows: rows
            });
        }
    });

    return finalTables;
}

app.listen(port, () => {
    console.log(`SNMP Viewer listening at http://localhost:${port}`);
});
