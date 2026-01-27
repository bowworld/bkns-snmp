const snmp = require('net-snmp');
const path = require('path');
const fs = require('fs');

class MibManager {
    constructor(mibsDir) {
        this.mibsDir = mibsDir;
        this.store = snmp.createModuleStore();
        this.loadedModules = new Set();
        this.providersCache = {}; // moduleName -> providers
        this.moduleToFile = {};  // moduleName -> filename
        this.fileToModule = {};  // filename -> moduleName
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
            const file = fileMap[moduleName];
            if (this.loadedModules.has(moduleName)) {
                if (file) {
                    this.moduleToFile[moduleName] = file;
                    this.fileToModule[file] = moduleName;
                }
                return true;
            }
            if (!file) return false;
            try {
                this.store.loadFromFile(path.join(this.mibsDir, file));

                try {
                    this.store.addTranslationsForModule(moduleName);
                } catch (transErr) {
                    // console.warn(`Silent fail: Could not translate ${moduleName}`);
                }

                this.loadedModules.add(moduleName);
                results.loaded.push(moduleName);

                // Track file mapping
                this.moduleToFile[moduleName] = file;
                this.fileToModule[file] = moduleName;

                return true;
            } catch (e) {
                console.error(`MIB Load Error [${moduleName}]: ${e.message}`);
                return false;
            }
        };

        // 2. Load Core MIBs in strict order
        coreMibsOrder.forEach(m => tryLoad(m));

        // 3. Load everything else in multiple passes
        let lastCount = -1;
        const remainingModules = Object.keys(fileMap).filter(m => !this.loadedModules.has(m));

        while (results.loaded.length !== lastCount && results.loaded.length < remainingModules.length) {
            lastCount = results.loaded.length;
            remainingModules.forEach(m => {
                tryLoad(m);
            });
        }

        // 4. Report final errors
        Object.keys(fileMap).forEach(m => {
            if (!this.loadedModules.has(m)) {
                const file = fileMap[m];
                try {
                    this.store.loadFromFile(path.join(this.mibsDir, file));
                    this.loadedModules.add(m);
                    this.moduleToFile[m] = file;
                    this.fileToModule[file] = m;
                } catch (e) {
                    results.errors.push(`Failed to load ${file} (${m}): ${e.message}`);
                    console.error(`MIB Load Error [${m}]: ${e.message}`);
                }
            }
        });

        return results;
    }

    /**
     * Explicitly loads a single MIB file.
     * @param {string} filename 
     */
    loadMibFile(filename) {
        const filePath = path.join(this.mibsDir, filename);
        if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const match = content.match(/([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/);
            const moduleName = match ? match[1] : null;

            // Load file into store
            this.store.loadFromFile(filePath);

            if (moduleName) {
                // Try to add translations, but don't let internal parser errors crash the whole load
                try {
                    const module = this.store.getModule(moduleName);
                    if (module) {
                        this.store.addTranslationsForModule(moduleName);
                    }
                } catch (transErr) {
                    console.warn(`Warning: Could not add translations for ${moduleName}: ${transErr.message}`);
                    // We continue anyway, as the MIB is partially loaded
                }

                this.loadedModules.add(moduleName);
                this.moduleToFile[moduleName] = filename;
                this.fileToModule[filename] = moduleName;
            } else {
                this.fileToModule[filename] = filename;
            }
            return { success: true, moduleName };
        } catch (e) {
            console.error(`Error loading MIB file ${filename}:`, e);
            // Provide a more user-friendly error if it's a known net-snmp internal issue
            let errorMsg = e.message;
            if (errorMsg.includes('wwpModules')) {
                errorMsg = "MIB Parser Error: This file has complex dependencies or formatting that net-snmp cannot parse automatically. Try loading base MIBs first.";
            }
            return { success: false, error: errorMsg };
        }
    }

    async rebuildStore() {
        const activeFiles = [];
        for (const mod of this.loadedModules) {
            const fileName = this.moduleToFile[mod];
            if (fileName) activeFiles.push(fileName);
        }

        // Re-init state
        this.store = snmp.createModuleStore();
        this.loadedModules.clear();
        this.moduleToFile = {};
        this.fileToModule = {};
        this.providersCache = {};

        // Reload everything that was active
        for (const file of activeFiles) {
            this.loadMibFile(file);
        }
    }

    unloadModule(moduleName) {
        if (!this.loadedModules.has(moduleName)) {
            console.log(`Module ${moduleName} not found in loaded list`);
            return false;
        }

        try {
            // Remove from tracking set
            this.loadedModules.delete(moduleName);

            const fileName = this.moduleToFile[moduleName];
            delete this.moduleToFile[moduleName];
            if (fileName) delete this.fileToModule[fileName];
            delete this.providersCache[moduleName];

            // Truly "unload" by recreating the store without this module
            // We call this sync-ish since reload is fast enough for internal state
            this.rebuildStoreSync();

            return true;
        } catch (e) {
            console.error(`Error unloading module ${moduleName}:`, e);
            return false;
        }
    }

    // Synchronous version for internal use
    rebuildStoreSync() {
        const activeFiles = [];
        for (const mod of this.loadedModules) {
            const fileName = this.moduleToFile[mod];
            if (fileName) activeFiles.push(fileName);
        }

        this.store = snmp.createModuleStore();
        // Clear tracking but preserve loadedModules names to avoid infinite loop
        // Actually, we need to temporarily save them
        const modulesToReload = new Set(this.loadedModules);

        this.loadedModules.clear();
        this.moduleToFile = {};
        this.fileToModule = {};
        this.providersCache = {};

        for (const file of activeFiles) {
            this.loadMibFile(file);
        }
    }

    getLoadedModules() {
        return Array.from(this.loadedModules).map(m => ({
            name: m,
            file: this.moduleToFile[m]
        }));
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

    /**
     * Builds and returns a hierarchical tree structure of all loaded MIB objects.
     */
    getMibTree() {
        const root = { name: 'iso', oid: '1', children: {} };
        const allModules = Array.from(this.loadedModules);

        console.log(`Building MIB tree from ${allModules.length} loaded modules...`);

        // Track what we've seen to avoid redundant processing
        const seenObjects = new Set();

        allModules.forEach(moduleName => {
            const module = this.store.getModule(moduleName);
            if (!module) return;

            // Priority 1: Objects defined in the module object itself
            for (const name in module) {
                if (['name', 'imports', 'exports'].includes(name)) continue;
                const obj = module[name];
                if (!obj) continue;

                const oid = obj.OID || obj.oid;
                if (oid && typeof oid === 'string') {
                    const cleanOid = oid.startsWith('.') ? oid.substring(1) : oid;
                    this._insertIntoTree(root, cleanOid, name, obj.DESCRIPTION || obj.description);
                    seenObjects.add(cleanOid);
                }
            }

            // Priority 2: Providers (often contains what's missing in module object)
            try {
                const providers = this.store.getProvidersForModule(moduleName);
                if (providers) {
                    for (const name in providers) {
                        const p = providers[name];
                        if (p && p.oid) {
                            const cleanOid = p.oid.startsWith('.') ? p.oid.substring(1) : p.oid;
                            // Only insert if not already seen with better data
                            this._insertIntoTree(root, cleanOid, p.name || name, '');
                            seenObjects.add(cleanOid);
                        }
                    }
                }
            } catch (e) { }
        });

        const tree = this._formatTreeNode(root);
        console.log(`MIB tree built. Root children count: ${tree.children ? tree.children.length : 0}`);
        return tree;
    }

    _insertIntoTree(root, oid, name, description) {
        const parts = oid.split('.');
        if (parts[0] !== '1') return; // Only handle iso(1) tree

        let current = root;
        let currentOid = '1';

        for (let i = 1; i < parts.length; i++) {
            currentOid += '.' + parts[i];
            const isLeaf = (i === parts.length - 1);

            if (!current.children[parts[i]]) {
                current.children[parts[i]] = {
                    name: isLeaf ? name : parts[i],
                    oid: currentOid,
                    children: {}
                };
                if (isLeaf && description) {
                    current.children[parts[i]].description = description;
                }
            } else if (isLeaf) {
                // If we found the actual name for a previously created placeholder node
                if (name && isNaN(name)) {
                    current.children[parts[i]].name = name;
                }
                if (description) {
                    current.children[parts[i]].description = description;
                }
            }
            current = current.children[parts[i]];
        }
    }

    _formatTreeNode(node) {
        const result = {
            name: node.name,
            oid: node.oid
        };
        if (node.description) result.description = node.description;

        const childKeys = Object.keys(node.children).sort((a, b) => parseInt(a) - parseInt(b));
        if (childKeys.length > 0) {
            result.children = childKeys.map(k => this._formatTreeNode(node.children[k]));
        }
        return result;
    }
}

module.exports = MibManager;
