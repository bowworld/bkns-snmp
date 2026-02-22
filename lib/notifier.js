const nodemailer = require('nodemailer');
const path = require('path');

/**
 * Notifier — sends incident emails with optional snapshot attachment.
 *
 * Usage:
 *   const notifier = new Notifier({
 *       transport: { host: 'smtp.example.com', port: 587, auth: { user, pass } },
 *       from: 'bkns@vicomplus.kz'
 *   });
 *
 *   await notifier.send({
 *       to: 'admin@customer.kz',
 *       meta: { snapshot_id, created_at, site, incident },
 *       attachmentPath: '/path/to/snapshot.tar.gz'  // or null
 *   });
 */
class Notifier {
    /**
     * @param {Object} opts
     * @param {Object} opts.transport  — nodemailer transport config (SMTP, jsonTransport, etc.)
     * @param {string} opts.from       — sender email address
     */
    constructor({ transport, from }) {
        this.transporter = nodemailer.createTransport(transport);
        this.from = from;
    }

    /**
     * Send incident notification email.
     *
     * @param {Object} params
     * @param {string}      params.to             — recipient email
     * @param {Object}      params.meta           — snapshot/incident metadata
     * @param {string|null} params.attachmentPath  — path to snapshot .tar.gz (null = no attachment)
     * @returns {Promise<Object>} nodemailer sendMail result
     */
    async send({ to, meta, attachmentPath }) {
        const { incident } = meta;

        const subject = `[BKNS] ${incident.severity}: ${incident.device_sn} — ${incident.description}`;

        const body = [
            `Site: ${meta.site.name} (${meta.site.id})`,
            `Snapshot ID: ${meta.snapshot_id}`,
            `Time: ${meta.created_at}`,
            '',
            '--- Incident ---',
            `Device: ${incident.device_sn} (${incident.device_model})`,
            `Room: ${incident.room}`,
            `Severity: ${incident.severity}`,
            `Metric: ${incident.metric}`,
            `Value: ${incident.value}`,
            `Description: ${incident.description}`,
        ].join('\n');

        const mailOptions = {
            from: this.from,
            to,
            subject,
            text: body,
        };

        if (attachmentPath) {
            mailOptions.attachments = [
                {
                    filename: path.basename(attachmentPath),
                    path: attachmentPath,
                }
            ];
        }

        return this.transporter.sendMail(mailOptions);
    }
}

module.exports = Notifier;
