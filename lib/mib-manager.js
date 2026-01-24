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

        mibFiles.forEach(filename => {
            const filePath = path.join(this.mibsDir, filename);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const match = content.match(/([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/);

                if (match && match[1]) {
                    const moduleName = match[1];
                    results.fileToModule[filename] = moduleName;

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
     * @param {string} oidStr
     * @param {string[]} filterFiles - Optional list of filenames to restrict search to
     */
    lookupOid(oidStr, filterFiles = null) {
        // Normalize OID (remove leading dot)
        const oid = oidStr.startsWith('.') ? oidStr : '.' + oidStr;

        // If filterFiles is provided, we only look in those modules.
        // Otherwise, we look in all loaded modules (fallback).
        let modulesToSearch = Array.from(this.loadedModules);

        if (filterFiles && filterFiles.length > 0) {
            // We need to map filenames to module names again. 
            // We can do this on the fly by reading the definitions or use a persistent map.
            // Let's use a persistent map in the class for efficiency.
            modulesToSearch = [];
            filterFiles.forEach(file => {
                // Find module name for this file. We can cache this in this.fileToModuleMap
                const moduleName = this.getModuleNameAndLoad(file);
                if (moduleName) modulesToSearch.push(moduleName);
            });
        }

        for (const moduleName of modulesToSearch) {
            const providers = this.providersCache[moduleName];
            if (!providers) continue;

            const match = Object.values(providers).find(p => p.oid === oid);
            if (match) {
                return {
                    name: match.name,
                    oid: match.oid,
                    description: match.description
                };
            }
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
                    this.providersCache[moduleName] = this.store.getProvidersForModule(moduleName);
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
