const fs = require('fs');
const path = require('path');

const DEFAULT_SITE = {
    site: { id: '', name: '', contact: '' },
    rooms: [],
    devices: [],
    polling: { interval: 5, snapshotWindow: 48 },
    lastSnapshotTime: null
};

class SiteManager {
    constructor(siteFilePath) {
        this.filePath = siteFilePath;
        this.data = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            }
        } catch (e) {
            console.error('Error loading site.json:', e.message);
        }
        return JSON.parse(JSON.stringify(DEFAULT_SITE));
    }

    _save() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    getSite() {
        return this.data;
    }

    updateSiteInfo({ id, name, contact, smtp }) {
        if (id !== undefined) this.data.site.id = id;
        if (name !== undefined) this.data.site.name = name;
        if (contact !== undefined) this.data.site.contact = contact;
        if (smtp !== undefined) this.data.smtp = smtp;
        this._save();
    }

    // Rooms
    addRoom({ id, name }) {
        if (!id) throw new Error('Room id required');
        if (this.data.rooms.find(r => r.id === id)) throw new Error('Room already exists');
        this.data.rooms.push({ id, name: name || id });
        this._save();
    }

    removeRoom(roomId) {
        const devicesInRoom = this.data.devices.filter(d => d.room === roomId);
        if (devicesInRoom.length > 0) {
            throw new Error(`Cannot remove room: ${devicesInRoom.length} devices still assigned`);
        }
        this.data.rooms = this.data.rooms.filter(r => r.id !== roomId);
        this._save();
    }

    // Devices
    addDevice({ device_sn, model, type, room, ip, snmp, measurement }) {
        if (!device_sn) throw new Error('device_sn required');
        const id = `${type || 'device'}_${device_sn.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
        if (this.data.devices.find(d => d.id === id)) throw new Error('Device already exists');
        const configFile = `device_${device_sn.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.conf`;
        this.data.devices.push({
            id, device_sn, model: model || '', type: type || '',
            room: room || '', ip: ip || '',
            snmp: snmp || { version: '2c', community: 'public' },
            measurement: measurement || 'snmp',
            config_file: configFile
        });
        this._save();
    }

    updateDevice(deviceId, updates) {
        const device = this.data.devices.find(d => d.id === deviceId);
        if (!device) throw new Error('Device not found');
        Object.assign(device, updates);
        this._save();
    }

    removeDevice(deviceId) {
        this.data.devices = this.data.devices.filter(d => d.id !== deviceId);
        this._save();
    }

    getDevicesByRoom(roomId) {
        return this.data.devices.filter(d => d.room === roomId);
    }

    // Rules
    addRule(deviceId, rule) {
        const device = this.data.devices.find(d => d.id === deviceId);
        if (!device) throw new Error('Device not found');
        if (!rule.id || !rule.metric || !rule.type) throw new Error('Rule requires id, metric, type');
        if (!device.rules) device.rules = [];
        if (device.rules.find(r => r.id === rule.id)) throw new Error('Rule id already exists');
        device.rules.push(rule);
        this._save();
    }

    removeRule(deviceId, ruleId) {
        const device = this.data.devices.find(d => d.id === deviceId);
        if (!device) throw new Error('Device not found');
        if (!device.rules) device.rules = [];
        device.rules = device.rules.filter(r => r.id !== ruleId);
        this._save();
    }

    getDevicesWithRules() {
        return this.data.devices.filter(d => Array.isArray(d.rules) && d.rules.length > 0);
    }

    // Polling
    updatePolling({ interval, snapshotWindow }) {
        if (interval !== undefined) {
            if (![1, 5, 10].includes(interval)) throw new Error('Interval must be 1, 5, or 10');
            this.data.polling.interval = interval;
        }
        if (snapshotWindow !== undefined) this.data.polling.snapshotWindow = snapshotWindow;
        this._save();
    }

    // Migration from legacy settings.json
    static migrateFromSettings(settingsPath, siteFilePath) {
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch (e) {
            throw new Error('Cannot read settings.json: ' + e.message);
        }

        const sm = new SiteManager(siteFilePath);

        // Create default room
        sm.addRoom({ id: 'default', name: 'Default Room' });

        // Extract device info from tags
        const snTag = (settings.tags || []).find(t =>
            t.key === 'device_sn' || t.key === 'airIRSCUnitIdentSerialNumber'
        );
        const modelTag = (settings.tags || []).find(t =>
            t.key === 'model' || t.key === 'airIRSCUnitIdentModelNumber'
        );

        if (snTag && snTag.value) {
            sm.addDevice({
                device_sn: snTag.value,
                model: modelTag ? modelTag.value : '',
                type: settings.measurement || 'snmp',
                room: 'default',
                ip: '',
                measurement: settings.measurement || 'snmp'
            });
        }

        return sm;
    }
}

module.exports = SiteManager;
