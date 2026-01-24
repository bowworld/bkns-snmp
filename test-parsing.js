const snmp = require('net-snmp');
const path = require('path');

try {
    if (typeof snmp.createModuleStore !== 'function') {
        console.error('snmp.createModuleStore is NOT a function. It seems this version of net-snmp does not support MIB parsing natively or it is not exposed.');
        process.exit(1);
    }

    const store = snmp.createModuleStore();
    const mibPath = path.join(__dirname, 'mibs', 'TEST-MIB.txt');
    
    console.log(`Loading MIB from: ${mibPath}`);
    store.loadFromFile(mibPath);

    const moduleName = "TEST-MIB";
    console.log(`Getting providers for module: ${moduleName}`);
    const providers = store.getProvidersForModule(moduleName);
    
    console.log("Providers found:", JSON.stringify(providers, null, 2));

} catch (err) {
    console.error("Error during MIB test:", err);
}
