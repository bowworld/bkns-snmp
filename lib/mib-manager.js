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
        const results = { loaded: [], errors: [], fileToModule: {} };
        const coreMibsOrder = [
            'SNMPv2-SMI',
            'RFC1155-SMI',
            'RFC-1212',
            'RFC-1215',
            'SNMPv2-TC',
            'SNMPv2-MIB',
            'RFC1213-MIB',
            'SNMP-FRAMEWORK-MIB',
            'IF-MIB',
            'IP-MIB',
            'HOST-RESOURCES-MIB',
            'IANAifType-MIB',
            'IANA-ADDRESS-FAMILY-NUMBERS-MIB',
            'IANA-RTPROTO-MIB'
        ];

        // 1. Map files to modules
        const fileMap = {};
        mibFiles.forEach(f => {
            try {
                const content = fs.readFileSync(path.join(this.mibsDir, f), 'utf8');
                const match = content.match(/([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/);
                if (match) fileMap[match[1]] = f;
            } catch (e) { }
        });

        const tryLoad = (moduleName) => {
            if (this.loadedModules.has(moduleName)) return true;
            const file = fileMap[moduleName];
            if (!file) return false;
            try {
                this.store.loadFromFile(path.join(this.mibsDir, file));
                this.store.addTranslationsForModule(moduleName);
                this.loadedModules.add(moduleName);
                results.loaded.push(moduleName);
                return true;
            } catch (e) {
                // console.error(`Failed to load ${moduleName}: ${e.message}`);
                return false;
            }
        };

        // 2. Load Core MIBs in strict order
        coreMibsOrder.forEach(m => tryLoad(m));

        // 3. Load everything else in multiple passes
        let lastCount = -1;
        const remainingModules = Object.keys(fileMap).filter(m => !this.loadedModules.has(m));

        while (results.loaded.length !== lastCount && results.loaded.length < Object.keys(fileMap).length) {
            lastCount = results.loaded.length;
            remainingModules.forEach(m => {
                if (!this.loadedModules.has(m)) tryLoad(m);
            });
        }

        // 4. Report final errors
        Object.keys(fileMap).forEach(m => {
            if (!this.loadedModules.has(m)) {
                const file = fileMap[m];
                try {
                    this.store.loadFromFile(path.join(this.mibsDir, file));
                } catch (e) {
                    results.errors.push(`Failed to load ${file} (${m}): ${e.message}`);
                    console.error(`MIB Load Error [${m}]: ${e.message}`);
                }
            }
        });

        return results;
    }

    /**
     * Looks up an OID in the loaded MIBs using built-in store.translate.
     * @param {string} oidStr
     */
    lookupOid(oidStr) {
        if (!oidStr) return null;

        try {
            // translate returns "MODULE-NAME::SymbolName" in 'module' format
            const translated = this.store.translate(oidStr, 'module');
            if (translated && translated.includes('::')) {
                const [moduleName, fullName] = translated.split('::');
                // Strip index if present (e.g., "sysDescr.0" -> "sysDescr")
                const name = fullName.split('.')[0];
                const result = {
                    name: name,
                    module: moduleName,
                    oid: oidStr
                };

                // Get more details from the module store
                const module = this.store.getModule(moduleName);
                if (module && module[name]) {
                    const obj = module[name];
                    result.description = obj.DESCRIPTION;

                    // Handle enums
                    if (obj.SYNTAX) {
                        // Sometimes it's direct, sometimes nested under INTEGER, etc.
                        if (obj.SYNTAX.INTEGER) {
                            result.enums = obj.SYNTAX.INTEGER;
                        } else if (typeof obj.SYNTAX === 'object' && !obj.SYNTAX.OCTETString) {
                            // Check for any other mapped types that might be enums
                            for (const type in obj.SYNTAX) {
                                if (typeof obj.SYNTAX[type] === 'object') {
                                    result.enums = obj.SYNTAX[type];
                                    break;
                                }
                            }
                        }
                    }
                }

                return result;
            }
        } catch (e) {
            // Not found in MIBs
        }
        return null;
    }

    /**
     * Resolves a symbolic OID (e.g. "IF-MIB::ifTable") to numeric OID (e.g. "1.3.6.1.2.1.2.2")
     * @param {string} symbol 
     */
    resolveSymbol(symbol) {
        if (!symbol) return null;
        if (/^\d+(\.\d+)*$/.test(symbol)) return symbol; // Already numeric

        try {
            const numeric = this.store.translate(symbol, 'numeric');
            if (numeric && /^\d+(\.\d+)*$/.test(numeric)) {
                return numeric;
            }
        } catch (e) {
            // Could not resolve
        }
        return symbol;
    }

    // Helper to get module name from file (and load it if needed)
    getModuleNameAndLoad(filename) {
        const filePath = path.join(this.mibsDir, filename);
        if (!fs.existsSync(filePath)) return null;

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const match = content.match(/([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/);
            if (match && match[1]) {
                const moduleName = match[1];
                if (!this.loadedModules.has(moduleName)) {
                    this.store.loadFromFile(filePath);
                    this.loadedModules.add(moduleName);

                    const module = this.store.getModule(moduleName);
                    if (module && module.objects) {
                        this.providersCache[moduleName] = module.objects;
                    } else {
                        this.providersCache[moduleName] = this.store.getProvidersForModule(moduleName);
                    }
                }
                return moduleName;
            }
        } catch (e) {
            console.error(`Error reading ${filename}`, e);
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
