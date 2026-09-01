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
    demoPassword: process.env.DEMO_PASSWORD || 'tecsub123'
};

module.exports = config;
