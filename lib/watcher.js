const { EventEmitter } = require('events');

/**
 * Watcher — core incident detection engine.
 *
 * Reads latest data from InfluxDB via injected client,
 * evaluates rules, and emits 'incident' events on ok→alert transitions.
 *
 * Detection types:
 *   - discrete: value ∈ alert_on → alert
 *   - threshold: value < min OR value > max → alert
 *
 * Transition logic:
 *   - ok→alert   → emit 'incident'
 *   - alert→alert → ignore (no duplicate)
 *   - alert→ok    → silent recovery (state resets to ok)
 *   - no data     → skip silently
 */
class Watcher extends EventEmitter {
    /**
     * @param {Object} opts
     * @param {Object} opts.influxClient — { async query(measurement) → [{device_sn, metric1, ...}] }
     * @param {Function} opts.getRules — () → [{ device_sn, measurement, room, rule }]
     *   rule: { id, metric, type, alert_on, min, max, severity, description }
     * @param {number} opts.checkInterval — ms between checks (for setInterval)
     */
    constructor({ influxClient, getRules, checkInterval }) {
        super();
        this.influxClient = influxClient;
        this.getRules = getRules;
        this.checkInterval = checkInterval;

        // State map: "DEV1_metric" → "ok" | "alert"
        this._state = new Map();
        this._timer = null;
        this._lastCheck = null;
    }

    /**
     * Single check cycle: query InfluxDB, evaluate all rules, emit incidents.
     */
    async check() {
        const rules = this.getRules();

        // Group rules by measurement to minimize queries
        const byMeasurement = new Map();
        for (const entry of rules) {
            if (!byMeasurement.has(entry.measurement)) {
                byMeasurement.set(entry.measurement, []);
            }
            byMeasurement.get(entry.measurement).push(entry);
        }

        // Query each measurement once, then evaluate all rules for it
        for (const [measurement, entries] of byMeasurement) {
            let rows;
            try {
                rows = await this.influxClient.query(measurement);
            } catch (err) {
                // Query error — skip this measurement silently
                continue;
            }

            if (!rows || rows.length === 0) continue;

            // Index rows by device_sn for fast lookup
            const rowsBySn = new Map();
            for (const row of rows) {
                if (row.device_sn) {
                    rowsBySn.set(row.device_sn, row);
                }
            }

            for (const entry of entries) {
                const { device_sn, room, rule } = entry;
                const row = rowsBySn.get(device_sn);

                // No data for this device — skip
                if (!row) continue;

                const value = row[rule.metric];

                // Metric not present in row — skip
                if (value === undefined || value === null) continue;

                const stateKey = `${device_sn}_${rule.metric}`;
                const prevState = this._state.get(stateKey) || 'ok';
                const isAlert = this._evaluate(rule, value);

                if (isAlert) {
                    if (prevState === 'ok') {
                        // ok→alert transition — emit incident
                        this._state.set(stateKey, 'alert');
                        this.emit('incident', {
                            device_sn,
                            measurement,
                            room,
                            rule,
                            value,
                            timestamp: new Date()
                        });
                    }
                    // alert→alert — ignore (no duplicate)
                } else {
                    // Value is ok — reset state (silent recovery)
                    this._state.set(stateKey, 'ok');
                }
            }
        }

        this._lastCheck = new Date();
    }

    /**
     * Evaluate whether value triggers an alert for the given rule.
     * @param {Object} rule
     * @param {*} value
     * @returns {boolean}
     */
    _evaluate(rule, value) {
        switch (rule.type) {
            case 'discrete':
                return Array.isArray(rule.alert_on) && rule.alert_on.includes(value);

            case 'threshold': {
                if (rule.min !== undefined && rule.min !== null && value < rule.min) return true;
                if (rule.max !== undefined && rule.max !== null && value > rule.max) return true;
                return false;
            }

            default:
                return false;
        }
    }

    /**
     * Start periodic checking.
     */
    start() {
        if (this._timer) return; // already running
        this._timer = setInterval(() => this.check(), this.checkInterval);
    }

    /**
     * Stop periodic checking.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /**
     * @returns {{ running: boolean, lastCheck: Date|null, activeAlerts: number }}
     */
    getStatus() {
        let activeAlerts = 0;
        for (const state of this._state.values()) {
            if (state === 'alert') activeAlerts++;
        }
        return {
            running: this._timer !== null,
            lastCheck: this._lastCheck,
            activeAlerts
        };
    }
}

module.exports = Watcher;
