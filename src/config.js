/**
 * Application configuration, resolved from the environment with safe defaults.
 * No secrets live in source — copy .env.example to .env to override.
 */
require('dotenv').config();

function intOr(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOr(value, fallback) {
    if (value == null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const port = intOr(process.env.PORT, 3001);

const config = {
    port,
    /**
     * Ports tried in order when the configured one is already in use, so a
     * stale server from another project cannot block a fresh start.
     */
    fallbackPorts: String(process.env.FALLBACK_PORTS || `${port + 1},${port + 2},${port + 3}`)
        .split(',')
        .map(p => intOr(p, null))
        .filter(p => p && p !== port),
    env: process.env.NODE_ENV || 'development',
    maxUploadBytes: intOr(process.env.MAX_UPLOAD_MB, 10) * 1024 * 1024,

    /**
     * Authentication. Sessions are always available (the dashboard shows who is
     * signed in); `authRequired` decides whether an anonymous visitor is turned
     * away. It defaults to off so the demo dataset stays browsable, exactly as
     * before this feature existed.
     */
    authRequired: boolOr(process.env.AUTH_REQUIRED, false),
    sessionSecret: process.env.SESSION_SECRET || 'tecsubstitution-dev-secret',
    sessionHours: intOr(process.env.SESSION_HOURS, 12),
    /** Password every demo account signs in with. Override in .env. */
    demoPassword: process.env.DEMO_PASSWORD || 'tecsub123',

    /**
     * PostgreSQL (Neon). Entirely optional: with no DATABASE_URL the app runs
     * on the bundled demo dataset held in memory, exactly as before. The value
     * is a secret — it is never logged, and .env is git-ignored.
     */
    databaseUrl: (process.env.DATABASE_URL || '').trim() || null,
    dbPoolMax: intOr(process.env.DB_POOL_MAX, 5),
    dbConnectTimeoutMs: intOr(process.env.DB_CONNECT_TIMEOUT_MS, 10000),
    /** Create tables and insert the demo rows on startup when the DB is empty. */
    dbAutoSeed: boolOr(process.env.DB_AUTO_SEED, true),

    /**
     * PDF.co — the document (PDF / image) table-extraction provider.
     *
     * Optional: with no key, PDF and image upload reports that extraction is
     * not configured and Excel, CSV, Quick Paste and manual entry all keep
     * working. The key is a secret: it is read from the environment only, is
     * never sent to the browser and never appears in an API response.
     */
    pdfcoApiKey: (process.env.PDFCO_API_KEY || '').trim() || null,
    pdfcoBaseUrl: (process.env.PDFCO_BASE_URL || 'https://api.pdf.co/v1').replace(/\/$/, ''),
    pdfcoTimeoutMs: intOr(process.env.PDFCO_TIMEOUT_MS, 120000)
};

module.exports = config;
