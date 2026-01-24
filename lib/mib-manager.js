const snmp = require('net-snmp');
const path = require('path');
const fs = require('fs');

class MibManager {
    constructor(mibsDir) {
        this.mibsDir = mibsDir;
        this.store = snmp.createModuleStore();
        this.loadedModules = new Set();
        this.providersCache = {}; // moduleName -> providers
    }

    getMibFiles() {
        if (!fs.existsSync(this.mibsDir)) {
            return [];
        }
        return fs.readdirSync(this.mibsDir).filter(file => file.endsWith('.txt') || file.endsWith('.mib') || file.endsWith('.my'));
    }

    loadMibs(mibFiles) {
        // Clear cache if reloading (or simplified: just load new ones)
        // For this simple implementation, we append to the store. 
        // net-snmp store might throw if module already loaded, or just ignore.

        const results = { loaded: [], errors: [] };

        mibFiles.forEach(filename => {
            const filePath = path.join(this.mibsDir, filename);
            try {
                // We crudely try to extract module name from filename or just load it
                // loadFromFile returns the module name usually? No, it returns void usually or throws.

                // net-snmp loadFromFile typically just parses.
                // We need to know the module name to get providers. 
                // A robust parser reads the MODULE-IDENTITY. 
                // For now, we assume standard naming or we inspect the file content briefly if needed, 
                // OR we just iterate all known modules if possible. 
                // Actually, store doesn't expose "listModules". 

                // Workaround: We will use a regex to find "X DEFINITIONS ::= BEGIN" to guess module name.
                const content = fs.readFileSync(filePath, 'utf8');
                const match = content.match(/([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/);

                if (match && match[1]) {
                    const moduleName = match[1];
                    if (!this.loadedModules.has(moduleName)) {
                        this.store.loadFromFile(filePath);
                        this.loadedModules.add(moduleName);

                        // Cache providers for lookups
                        this.providersCache[moduleName] = this.store.getProvidersForModule(moduleName);
                        results.loaded.push(moduleName);
                    }
                } else {
                    results.errors.push(`Could not determine module name for ${filename}`);
                }

            } catch (err) {
                results.errors.push(`Failed to load ${filename}: ${err.message}`);
            }
        });

        return results;
    }

    /**
     * Looks up an OID in the loaded MIBs.
     * Returns { name, description, ... } or null.
     */
    lookupOid(oidStr) {
        // Normalize OID (remove leading dot)
        const oid = oidStr.startsWith('.') ? oidStr : '.' + oidStr;

        // Iterate all loaded providers to find a match.
        // This is O(N*M) where N=Modules, M=Entries. Not super efficient but fine for SNMP Viewer.
        // Reverse lookup map would be better.

        for (const moduleName of this.loadedModules) {
            const providers = this.providersCache[moduleName];
            if (!providers) continue;

            // net-snmp providers usually have { name, oid, ... }
            const match = Object.values(providers).find(p => p.oid === oid);
            if (match) {
                return {
                    name: match.name,
                    oid: match.oid,
                    description: match.description // net-snmp might not parse description by default without specific flags? 
                    // The parser in net-snmp is basic. It might just give name/type/oid.
                };
            }
        }
        return null;
    }

    /**
     * Returns a map of OID -> Name for all loaded modules
     */
    getAllOidMappings() {
        const mapping = {};
        for (const moduleName of this.loadedModules) {
            const providers = this.providersCache[moduleName];
            if (providers) {
                Object.values(providers).forEach(p => {
                    mapping[p.oid] = p.name;
                });
            }
        }
        return mapping;
    }
}

module.exports = MibManager;
