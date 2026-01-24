const express = require('express');
const snmp = require('net-snmp');
const app = express();
const port = 3000;

app.use(express.static('public'));
app.use(express.json());

// Helper to check if a string is a numeric OID
function isOid(s) {
    return /^\d+(\.\d+)*$/.test(s);
}

app.get('/api/snmp-walk', (req, res) => {
    const target = req.query.target || '192.168.2.1';
    const community = req.query.community || 'public';
    const rootOid = req.query.oid || '1.3.6.1.2.1'; // Default IP-MIB

    const session = snmp.createSession(target, community);

    const inputs = [];
    
    // We will store all varbinds here
    const results = [];

    session.subtree(rootOid, function (varbinds) {
        for (let i = 0; i < varbinds.length; i++) {
            if (snmp.isVarbindError(varbinds[i])) {
                console.error(snmp.varbindError(varbinds[i]));
            } else {
                results.push({
                    oid: varbinds[i].oid,
                    value: varbinds[i].value.toString()
                });
            }
        }
    }, function (error) {
        if (error) {
            console.error(error);
            res.status(500).json({ error: error.toString() });
        } else {
            // Process results into tables
            const tables = processToTables(results);
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
function processToTables(results) {
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
        columns[parent].push({ index, value: r.value, fullOid: r.oid });
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
        
        // Check if it looks like a table (more than one column usually, or at least multiple rows)
        // If it's just scalars, they might end up here if we blindly strip last digit.
        // But for scalars, the "index" is usually 0.
        
        // Lets construct rows based on common indices.
        const allIndices = new Set();
        colIds.forEach(cId => {
            cols[cId].forEach(entry => allIndices.add(entry.index));
        });

        const rows = [];
        Array.from(allIndices).sort((a,b) => parseInt(a) - parseInt(b)).forEach(idx => {
            const row = { index: idx };
            colIds.forEach(cId => {
                const entry = cols[cId].find(e => e.index === idx);
                row[cId] = entry ? entry.value : null;
            });
            rows.push(row);
        });

        // Filter out things that don't look like tables (e.g. single row with index 0 might be scalar grouping)
        // But the user WANTS tables. Even a list of scalars can be a 1-column table.
        // Let's refine: A table usually implies multiple columns sharing indices.
        // Or one column with multiple indices.
        
        if (rows.length > 0) {
           finalTables.push({
               oid: tableOid,
               columns: colIds,
               rows: rows
           });
        }
    });

    return finalTables;
}

app.listen(port, () => {
    console.log(`SNMP Viewer listening at http://localhost:${port}`);
});
