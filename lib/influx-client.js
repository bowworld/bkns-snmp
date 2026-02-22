const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * InfluxClient — wrapper for InfluxDB v2 Flux queries via HTTP API.
 *
 * Uses only built-in Node.js http/https modules (no external dependencies).
 *
 * Usage:
 *   const client = new InfluxClient({ url, token, org, bucket });
 *   const rows = await client.query('cooling');
 *   // rows = [{ device_sn: 'DEV1', temperature: 25.3, coolStatus: 2 }, ...]
 */
class InfluxClient {
    /**
     * @param {Object} opts
     * @param {string} opts.url    — InfluxDB base URL (e.g. 'http://influxdb:8086')
     * @param {string} opts.token  — InfluxDB API token
     * @param {string} opts.org    — organization name
     * @param {string} opts.bucket — bucket name
     */
    constructor({ url, token, org, bucket }) {
        this.url = url;
        this.token = token;
        this.org = org;
        this.bucket = bucket;
    }

    /**
     * Build Flux query for getting the last values of all devices for a measurement.
     * Returns one row per device_sn with all fields pivoted as columns.
     *
     * @param {string} measurement — e.g. 'cooling', 'ups', 'pdu'
     * @returns {string} Flux query
     */
    buildLastValuesQuery(measurement) {
        return `from(bucket: "${this.bucket}")
  |> range(start: -5m)
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> group(columns: ["device_sn", "_field"])
  |> last()
  |> pivot(rowKey: ["device_sn"], columnKey: ["_field"], valueColumn: "_value")
  |> group()`;
    }

    /**
     * Build Flux query for all data of specific devices over a time range.
     *
     * @param {string[]} deviceSNs — array of device serial numbers
     * @param {number} hours       — time range in hours
     * @returns {string} Flux query
     */
    buildRangeQuery(deviceSNs, hours) {
        const snFilter = deviceSNs
            .map(sn => `r.device_sn == "${sn}"`)
            .join(' or ');

        return `from(bucket: "${this.bucket}")
  |> range(start: -${hours}h)
  |> filter(fn: (r) => ${snFilter})`;
    }

    /**
     * Parse InfluxDB annotated CSV response into array of objects.
     *
     * Handles:
     *   - #group / #datatype / #default annotation lines (skipped)
     *   - Header row (first non-annotation, non-empty line after annotations)
     *   - Data rows: numeric strings converted to numbers
     *   - Internal columns skipped: '', 'result', 'table', '_start', '_stop', '_time', '_measurement'
     *   - Multiple table blocks (re-annotations mid-stream)
     *   - Trailing newlines / empty lines
     *
     * @param {string} csv — raw InfluxDB CSV response
     * @returns {Object[]} — array of { field: value, ... }
     */
    parseCSV(csv) {
        if (!csv || !csv.trim()) return [];

        const lines = csv.split('\n');
        const rows = [];

        // Columns to skip — InfluxDB internal metadata
        const skipColumns = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_measurement']);

        let headers = null;

        for (const line of lines) {
            // Skip annotation lines
            if (line.startsWith('#')) continue;

            // Skip empty lines
            const trimmed = line.trim();
            if (!trimmed) {
                // Empty line between table blocks — reset headers so next block picks up new header
                headers = null;
                continue;
            }

            const cells = trimmed.split(',');

            // First non-annotation, non-empty line is the header
            if (headers === null) {
                headers = cells;
                continue;
            }

            // Data row
            const obj = {};
            for (let i = 0; i < headers.length && i < cells.length; i++) {
                const col = headers[i];
                if (skipColumns.has(col)) continue;

                const raw = cells[i];
                // Try numeric conversion
                if (raw !== '' && !isNaN(raw) && raw.trim() !== '') {
                    obj[col] = Number(raw);
                } else {
                    obj[col] = raw;
                }
            }

            // Only add if we got any useful data
            if (Object.keys(obj).length > 0) {
                rows.push(obj);
            }
        }

        return rows;
    }

    /**
     * Query InfluxDB for last values of a measurement.
     * Returns parsed array of { device_sn, metric1, metric2, ... }.
     *
     * @param {string} measurement
     * @returns {Promise<Object[]>}
     */
    async query(measurement) {
        const flux = this.buildLastValuesQuery(measurement);
        const csv = await this._post(
            `/api/v2/query?org=${encodeURIComponent(this.org)}`,
            JSON.stringify({ query: flux, type: 'flux' })
        );
        return this.parseCSV(csv);
    }

    /**
     * Query InfluxDB for range data of specific devices.
     * Returns raw CSV string (for Line Protocol conversion later).
     *
     * @param {string[]} deviceSNs
     * @param {number} hours
     * @returns {Promise<string>}
     */
    async queryRange(deviceSNs, hours) {
        const flux = this.buildRangeQuery(deviceSNs, hours);
        return this._post(
            `/api/v2/query?org=${encodeURIComponent(this.org)}`,
            JSON.stringify({ query: flux, type: 'flux' })
        );
    }

    /**
     * Internal: send POST request to InfluxDB using built-in http/https.
     *
     * @param {string} path — API path (e.g. '/api/v2/query?org=bkns')
     * @param {string} data — request body (JSON string)
     * @returns {Promise<string>} — response body
     */
    _post(path, data) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(this.url);
            const isHttps = parsed.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/csv',
                    'Authorization': `Token ${this.token}`,
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = transport.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`InfluxDB HTTP ${res.statusCode}: ${body}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`InfluxDB request error: ${err.message}`));
            });

            req.write(data);
            req.end();
        });
    }
}

module.exports = InfluxClient;
