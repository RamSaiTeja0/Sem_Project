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
    /** Create tables and insert the demo rows on startup when the DB is empty (default false). */
    dbAutoSeed: boolOr(process.env.DB_AUTO_SEED, false),

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
    pdfcoTimeoutMs: intOr(process.env.PDFCO_TIMEOUT_MS, 120000),

    /**
     * Service-to-service internal authentication secret (for n8n and automation).
     * Must be passed via X-Internal-Secret header.
     */
    internalApiSecret: (process.env.INTERNAL_API_SECRET || '').trim() || null,

    /**
     * Google Gemini AI — Multimodal LLM/Vision provider for timetable extraction.
     * Secret key is read from environment only, never exposed to client or logs.
     */
    geminiApiKey: (process.env.GEMINI_API_KEY || '').trim() || null,
    geminiModel: (process.env.GEMINI_MODEL || 'gemini-3-flash-preview').trim(),
    geminiBaseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    geminiTimeoutMs: intOr(process.env.GEMINI_TIMEOUT_MS, 120000),

    /**
     * n8n Webhook URL for asynchronous notification when timetable is uploaded.
     */
    n8nWebhookUrl: (process.env.N8N_WEBHOOK_URL || '').trim() || null,

    /**
     * Single-branch configuration.
     * Each deployment instance represents exactly one academic branch.
     * In a fresh installation, branchName and branchCode are null until configured by initial HOS.
     */
    branchName: (process.env.BRANCH_NAME || '').trim() || null,
    branchCode: (process.env.BRANCH_CODE || '').trim().toUpperCase() || null,
    academicYear: (process.env.ACADEMIC_YEAR || '').trim() || null,
    semester: process.env.SEMESTER ? intOr(process.env.SEMESTER, null) : null,
    /** Whether to seed legacy multi-branch demo data (defaults to false). */
    dbSeedDemo: boolOr(process.env.DB_SEED_DEMO, false),
    /** Whether to load demo dataset into memory (defaults to false for fresh instances). */
    loadDemoData: boolOr(process.env.LOAD_DEMO_DATA, false)
};

module.exports = config;
