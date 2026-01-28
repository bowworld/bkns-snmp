const snmp = require('net-snmp');
const path = require('path');
const fs = require('fs');

class MibManager {
    constructor(mibsDir) {
        this.mibsDir = mibsDir;
        this.store = snmp.createModuleStore();
        this.loadedModules = new Set();
        this.moduleToFile = {};
        this.fileToModule = {};
        this.trackedFiles = new Set();
        this.providersCache = {};

        this.systemMibPaths = [
            '/usr/share/snmp/mibs',
            '/var/lib/mibs/ietf',
            '/var/lib/mibs/iana',
            path.join(__dirname, '../node_modules/net-snmp/lib/mibs')
        ];
    }

    _getModuleName(content) {
        if (!content) return null;
        const match = content.match(/^\s*([a-zA-Z0-9-]+)\s+DEFINITIONS\s+::=\s+BEGIN/im);
        return match ? match[1] : null;
    }

    _findMibPath(identifier) {
        if (!identifier) return null;
        // Search user dir
        let p = path.join(this.mibsDir, identifier);
        if (fs.existsSync(p)) return p;

        const exts = ['.mib', '.txt', '.my'];
        for (const ext of exts) {
            p = path.join(this.mibsDir, identifier + ext);
            if (fs.existsSync(p)) return p;
        }

        // Search system paths
        for (const sysPath of this.systemMibPaths) {
            if (!fs.existsSync(sysPath)) continue;
            p = path.join(sysPath, identifier);
            if (fs.existsSync(p)) return p;
            for (const ext of exts) {
                p = path.join(sysPath, identifier + ext);
                if (fs.existsSync(p)) return p;
            }
        }
        return null;
    }

    getMibFiles() {
        if (!fs.existsSync(this.mibsDir)) return [];
        return fs.readdirSync(this.mibsDir).filter(f => f.endsWith('.mib') || f.endsWith('.txt') || f.endsWith('.my'));
    }

    loadMibs(mibFiles = []) {
        // IMPORTANT: Initialize results immediately
        const results = { loaded: [], errors: [] };

        try {
            // 1. Pre-load built-ins
            const builtinDir = path.join(__dirname, '../node_modules/net-snmp/lib/mibs');
            if (fs.existsSync(builtinDir)) {
                const bFiles = fs.readdirSync(builtinDir).filter(f => f.endsWith('.mib') || f.endsWith('.my') || f.endsWith('.txt'));
                for (const f of bFiles) {
                    try {
                        const fp = path.join(builtinDir, f);
                        this.store.loadFromFile(fp);
                        const modName = this._getModuleName(fs.readFileSync(fp, 'utf8'));
                        if (modName) this.loadedModules.add(modName);
                    } catch (e) { }
                }
            }

            // 2. Identify tracked files
            mibFiles.forEach(f => { if (f) this.trackedFiles.add(f); });
            const fileMap = {};
            const untyped = [];

            this.trackedFiles.forEach(filename => {
                const abs = path.join(this.mibsDir, filename);
                if (!fs.existsSync(abs)) return;
                try {
                    const content = fs.readFileSync(abs, 'utf8');
                    const modName = this._getModuleName(content);
                    if (modName) fileMap[modName] = abs;
                    else untyped.push(abs);
                } catch (e) { }
            });

            // 3. Core Loading Order
            const coreOrder = ['SNMPv2-SMI', 'RFC1155-SMI', 'RFC-1212', 'RFC-1215', 'SNMPv2-TC', 'SNMPv2-CONF', 'SNMPv2-MIB', 'RFC1213-MIB', 'IF-MIB', 'IP-MIB'];

            const tryLoad = (mName, cPath) => {
                if (mName && this.loadedModules.has(mName)) return true;
                const target = cPath || (mName ? fileMap[mName] : null);
                if (!target) return false;

                try {
                    this.store.loadFromFile(target);
                    if (mName) {
                        this.loadedModules.add(mName);
                        const base = path.basename(target);
                        this.moduleToFile[mName] = base;
                        if (target.startsWith(this.mibsDir)) this.fileToModule[base] = mName;
                        try { this.store.addTranslationsForModule(mName); } catch (e) { }
                        try { this.providersCache[mName] = this.store.getProvidersForModule(mName); } catch (e) { }
                        results.loaded.push(mName);
                    }
                    return true;
                } catch (e) {
                    const base = path.basename(target);
                    let msg = e.message;
                    if (msg.includes('TYPE NOTATION')) msg = "Parser Limitation: MIB too complex or missing dependencies.";
                    results.errors.push(`Error ${base}: ${msg}`);
                    return false;
                }
            };

            // Load cores
            coreOrder.forEach(m => {
                if (fileMap[m]) tryLoad(m);
                else {
                    const p = this._findMibPath(m);
                    if (p) tryLoad(m, p);
                }
            });

            // Load untyped
            untyped.forEach(p => tryLoad(null, p));

            // Iterative load for dependencies
            let lastLen = -1;
            const remaining = Object.keys(fileMap).filter(m => !this.loadedModules.has(m));
            while (results.loaded.length !== lastLen && results.loaded.length < remaining.length) {
                lastLen = results.loaded.length;
                remaining.forEach(m => { if (!this.loadedModules.has(m)) tryLoad(m); });
            }

            // Final fallback
            remaining.forEach(m => { if (!this.loadedModules.has(m)) tryLoad(m); });

        } catch (globalErr) {
            console.error("Critical error in loadMibs:", globalErr);
            results.errors.push("Internal Loader Error: " + globalErr.message);
        }

        return results;
    }

    rebuildStoreSync() {
        this.store = snmp.createModuleStore();
        this.loadedModules.clear();
        this.moduleToFile = {};
        this.fileToModule = {};
        this.providersCache = {};
        const res = this.loadMibs(Array.from(this.trackedFiles));
        if (!res) return { loaded: [], errors: ["Internal error: loadMibs returned nothing"] };
        return res;
    }

    loadMibFile(filename) {
        if (!filename) return { success: false, error: "No filename provided" };
        this.trackedFiles.add(filename);

        try {
            const results = this.rebuildStoreSync();
            // results is guaranteed to be an object by rebuildStoreSync

            const filePath = path.join(this.mibsDir, filename);
            if (!fs.existsSync(filePath)) return { success: false, error: "File not found on disk" };

            const content = fs.readFileSync(filePath, 'utf8');
            const modName = this._getModuleName(content);

            if (modName && this.loadedModules.has(modName)) {
                // If it's already loaded, it might have been loaded as a dependency or core MIB.
                // We should ensure it's mapped to the file the user just clicked if it matches.
                const userFileBase = path.basename(filename);

                // If the module points to a different file (e.g. system path), update it to user's file preference
                // But only if they are the same module
                this.moduleToFile[modName] = userFileBase;
                this.fileToModule[userFileBase] = modName;

                return { success: true, moduleName: modName };
            } else {
                // Check for errors related to this file
                const myErr = results.errors.find(e => e.includes(filename));
                if (myErr) return { success: false, error: myErr };

                if (!modName) return { success: true, moduleName: filename }; // Fallback for files without ID
                return { success: false, error: `Could not load module ${modName}. Check for missing dependencies.` };
            }
        } catch (e) {
            console.error(`Exception in loadMibFile (${filename}):`, e);
            return { success: false, error: "Critical error: " + e.message };
        }
    }

    unloadModule(moduleName) {
        // If it's a file name passed by mistake, handle it
        if (moduleName.endsWith('.mib') || moduleName.endsWith('.txt') || moduleName.endsWith('.my')) {
            if (this.trackedFiles.has(moduleName)) {
                this.trackedFiles.delete(moduleName);
                this.rebuildStoreSync();
                return true;
            }
        }

        if (!this.loadedModules.has(moduleName)) {
            // It might be tracked but not successfully loaded, so we should try to remove the file anyway
            const file = this.moduleToFile[moduleName];
            if (file && this.trackedFiles.has(file)) {
                this.trackedFiles.delete(file);
                this.rebuildStoreSync();
                return true;
            }
            return false;
        }

        const file = this.moduleToFile[moduleName];

        // Remove from tracking set FIRST
        if (file) {
            this.trackedFiles.delete(file);
        }

        // We don't need to manually update moduleToFile or fileToModule 
        // because rebuildStoreSync() clears and rebuilds them from scratch.

        this.rebuildStoreSync();
        return true;
    }

    getLoadedModules() {
        return Array.from(this.loadedModules).map(m => ({
            name: m,
            file: this.moduleToFile[m]
        }));
    }

    lookupOid(oidStr) {
        if (!oidStr) return null;
        try {
            const translated = this.store.translate(oidStr, 'module');
            if (translated && translated.includes('::')) {
                const [mod, full] = translated.split('::');
                const name = full.split('.')[0];
                const res = { name, module: mod, oid: oidStr };
                const module = this.store.getModule(mod);
                if (module && module[name]) {
                    const obj = module[name];
                    res.description = obj.DESCRIPTION;
                    if (obj.SYNTAX) {
                        if (obj.SYNTAX.INTEGER) res.enums = obj.SYNTAX.INTEGER;
                        else if (typeof obj.SYNTAX === 'object' && !obj.SYNTAX.OCTETString) {
                            for (const k in obj.SYNTAX) {
                                if (typeof obj.SYNTAX[k] === 'object') { res.enums = obj.SYNTAX[k]; break; }
                            }
                        }
                    }
                }
                return res;
            }
        } catch (e) { }
        return null;
    }

    resolveSymbol(symbol) {
        if (!symbol) return null;
        if (/^\d+(\.\d+)*$/.test(symbol)) return symbol;
        try {
            const numeric = this.store.translate(symbol, 'numeric');
            if (numeric && /^\d+(\.\d+)*$/.test(numeric)) return numeric;
        } catch (e) { }
        return symbol;
    }

    getAllOidMappings() {
        const mapping = {};
        for (const mod of this.loadedModules) {
            let providers = this.providersCache[mod];
            if (!providers) {
                try { providers = this.store.getProvidersForModule(mod); } catch (e) { }
            }
            if (providers) {
                Object.values(providers).forEach(p => { mapping[p.oid] = p.name; });
            }
        }
        return mapping;
    }

    getMibTree() {
        const root = { name: 'iso', oid: '1', children: {} };
        const mods = Array.from(this.loadedModules);
        mods.forEach(mod => {
            const module = this.store.getModule(mod);
            if (!module) return;
            for (const name in module) {
                if (['name', 'imports', 'exports'].includes(name)) continue;
                const obj = module[name];
                if (obj && (obj.OID || obj.oid)) {
                    const oid = (obj.OID || obj.oid).startsWith('.') ? (obj.OID || obj.oid).substring(1) : (obj.OID || obj.oid);
                    this._insertIntoTree(root, oid, name, obj.DESCRIPTION || '');
                }
            }
            try {
                const providers = this.providersCache[mod] || this.store.getProvidersForModule(mod);
                if (providers) {
                    for (const name in providers) {
                        const p = providers[name];
                        if (p && p.oid) {
                            const oid = p.oid.startsWith('.') ? p.oid.substring(1) : p.oid;
                            this._insertIntoTree(root, oid, p.name || name, '');
                        }
                    }
                }
            } catch (e) { }
        });
        return this._formatTreeNode(root);
    }

    _insertIntoTree(root, oid, name, desc) {
        const parts = oid.split('.');
        if (parts[0] !== '1') return;
        let curr = root;
        let currOid = '1';
        for (let i = 1; i < parts.length; i++) {
            currOid += '.' + parts[i];
            const leaf = (i === parts.length - 1);
            if (!curr.children[parts[i]]) {
                curr.children[parts[i]] = { name: leaf ? name : parts[i], oid: currOid, children: {} };
                if (leaf && desc) curr.children[parts[i]].description = desc;
            } else if (leaf) {
                if (name && isNaN(name)) curr.children[parts[i]].name = name;
                if (desc) curr.children[parts[i]].description = desc;
            }
            curr = curr.children[parts[i]];
        }
    }

    _formatTreeNode(node) {
        const res = { name: node.name, oid: node.oid };
        if (node.description) res.description = node.description;
        const keys = Object.keys(node.children).sort((a, b) => parseInt(a) - parseInt(b));
        if (keys.length > 0) res.children = keys.map(k => this._formatTreeNode(node.children[k]));
        return res;
    }
}

module.exports = MibManager;
