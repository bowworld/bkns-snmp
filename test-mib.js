const snmp = require('net-snmp');
const path = require('path');
const fs = require('fs');
const MibManager = require('./lib/mib-manager');

const mibsDir = path.join(__dirname, 'mibs');
const mibManager = new MibManager(mibsDir);

const mibFiles = ['powernet458.mib'];
const loadResult = mibManager.loadMibs(mibFiles);
console.log('Load Result:', JSON.stringify(loadResult, null, 2));

// Test translation of a known APC OID
// airIRStatusStatus (1.3.6.1.4.1.318.1.1.13.3.1)
const testOid = '1.3.6.1.4.1.318.1.1.13.3.1';
const lookup = mibManager.lookupOid(testOid);
console.log('Lookup for ' + testOid + ':', JSON.stringify(lookup, null, 2));

// Test translation of a system OID
const sysOid = '1.3.6.1.2.1.1.1.0';
const sysLookup = mibManager.lookupOid(sysOid);
console.log('Lookup for ' + sysOid + ':', JSON.stringify(sysLookup, null, 2));
