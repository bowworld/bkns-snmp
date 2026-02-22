const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const tar = require('tar-stream');

/**
 * SnapshotGenerator — creates tar.gz snapshots for incident investigation.
 *
 * Each snapshot contains:
 *   - meta.json: version, snapshot_id, timestamps, site info, incident details,
 *                list of devices in the same room as the incident device
 *   - data.lp:   InfluxDB time-series data (CSV) for the snapshot window
 *
 * Usage:
 *   const gen = new SnapshotGenerator({ influxClient, outputDir });
 *   const { filePath, filename, meta } = await gen.generate(incident, siteData);
 */
class SnapshotGenerator {
    /**
     * @param {Object} opts
     * @param {Object} opts.influxClient — { async queryRange(deviceSNs, hours) → csv string }
     * @param {string} opts.outputDir    — directory to write snapshot tar.gz files
     */
    constructor({ influxClient, outputDir }) {
        this.influxClient = influxClient;
        this.outputDir = outputDir;
    }

    /**
     * Generate a snapshot tar.gz for an incident.
     *
     * Steps:
     *   1. Find all devices in the same room as the incident device
     *   2. Query InfluxDB for snapshotWindow hours of data
     *   3. Build meta.json
     *   4. Pack meta.json + data.lp into tar.gz
     *
     * @param {Object} incident — { device_sn, measurement, room, rule, value, timestamp }
     * @param {Object} siteData — { site: {id, name}, devices: [...], rooms: [...], polling: {snapshotWindow} }
     * @returns {Promise<{ filePath: string, filename: string, meta: Object }>}
     */
    async generate(incident, siteData) {
        // 1. Find all devices in the same room as incident device
        const roomDevices = siteData.devices.filter(d => d.room === incident.room);
        const deviceSNs = roomDevices.map(d => d.device_sn);

        // 2. Query InfluxDB for snapshotWindow hours of data
        const hours = siteData.polling.snapshotWindow || 48;
        const csvData = await this.influxClient.queryRange(deviceSNs, hours);

        // 3. Build meta.json
        const now = new Date();
        const meta = {
            version: '1.0',
            snapshot_id: crypto.randomUUID(),
            created_at: now.toISOString(),
            site: {
                id: siteData.site.id,
                name: siteData.site.name
            },
            period: {
                hours: hours,
                from: new Date(now.getTime() - hours * 3600 * 1000).toISOString(),
                to: now.toISOString()
            },
            incident: {
                device_sn: incident.device_sn,
                measurement: incident.measurement,
                room: incident.room,
                rule: incident.rule,
                value: incident.value,
                timestamp: incident.timestamp instanceof Date
                    ? incident.timestamp.toISOString()
                    : incident.timestamp
            },
            devices_included: roomDevices.map(d => ({
                device_sn: d.device_sn,
                model: d.model,
                type: d.type,
                ip: d.ip
            }))
        };

        // 4. Build filename: snapshot_{site.id}_{timestamp}.tar.gz
        //    Replace colons and dots in timestamp with dashes
        const ts = now.toISOString().replace(/[:.]/g, '-');
        const filename = `snapshot_${siteData.site.id}_${ts}.tar.gz`;
        const outputPath = path.join(this.outputDir, filename);

        // Ensure output directory exists
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        // 5. Pack into tar.gz
        await this._packTarGz(outputPath, {
            'meta.json': JSON.stringify(meta, null, 2),
            'data.lp': csvData
        });

        return { filePath: outputPath, filename, meta };
    }

    /**
     * Create a tar.gz archive from a { filename: content } object.
     *
     * @param {string} outputPath — full path for the output .tar.gz file
     * @param {Object} files — { "filename": "content string", ... }
     * @returns {Promise<void>}
     */
    _packTarGz(outputPath, files) {
        return new Promise((resolve, reject) => {
            const pack = tar.pack();
            const gzip = zlib.createGzip();
            const output = fs.createWriteStream(outputPath);

            output.on('finish', resolve);
            output.on('error', reject);
            gzip.on('error', reject);
            pack.on('error', reject);

            pack.pipe(gzip).pipe(output);

            for (const [name, content] of Object.entries(files)) {
                const buf = Buffer.from(content, 'utf8');
                pack.entry({ name, size: buf.length }, buf);
            }

            pack.finalize();
        });
    }
}

module.exports = SnapshotGenerator;
