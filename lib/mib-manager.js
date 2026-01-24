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

        // Sort files to handle dependencies better
        const sortedFiles = [...mibFiles].sort((a, b) => {
            if (a.includes('SNMPv2')) return -1;
            if (b.includes('SNMPv2')) return 1;
            return 0;
        });

        sortedFiles.forEach(filename => {
            const filePath = path.join(this.mibsDir, filename);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const match = content.match(/([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/);

                if (match && match[1]) {
                    const moduleName = match[1];
                    results.fileToModule[filename] = moduleName;

                    if (!this.loadedModules.has(moduleName)) {
                        this.store.loadFromFile(filePath);
                        this.store.addTranslationsForModule(moduleName);
                        this.loadedModules.add(moduleName);
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
     * Looks up an OID in the loaded MIBs using built-in store.translate.
     * @param {string} oidStr
     */
    lookupOid(oidStr) {
        if (!oidStr) return null;

        try {
            // translate returns "MODULE-NAME::SymbolName" in 'module' format
            const translated = this.store.translate(oidStr, 'module');
            if (translated && translated.includes('::')) {
                const [module, name] = translated.split('::');
                return {
                    name: name,
                    module: module,
                    oid: oidStr
                };
            }
        } catch (e) {
            // Not found in MIBs
        }
        return null;
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
