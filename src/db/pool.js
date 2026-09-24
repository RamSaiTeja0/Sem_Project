/**
 * PostgreSQL connection pool (Neon).
 *
 * The database is OPTIONAL. With no DATABASE_URL the whole module reports
 * `isConfigured() === false` and the application falls back to the bundled
 * in-memory demo dataset, exactly as it behaved before this layer existed.
 *
 * The connection string is read from the environment and never logged: the
 * helpers here only ever expose the host, so a diagnostic can say where it is
 * connecting without printing the password.
 */
const { Pool } = require('pg');
const config = require('../config');

let pool = null;

function isConfigured() {
    return Boolean(config.databaseUrl);
}

/**
 * Neon requires TLS. `sslmode` in the URL is respected when present; otherwise
 * TLS is enabled for any non-local host so a hosted database is never
 * contacted in the clear.
 */
function sslFor(url) {
    if (/sslmode=disable/i.test(url)) return false;
    if (/^postgres(ql)?:\/\/[^/]*@?(localhost|127\.0\.0\.1)/i.test(url)) return false;
    return { rejectUnauthorized: false };
}

function getPool() {
    if (!isConfigured()) return null;
    if (!pool) {
        pool = new Pool({
            connectionString: config.databaseUrl,
            ssl: sslFor(config.databaseUrl),
            max: config.dbPoolMax,
            connectionTimeoutMillis: config.dbConnectTimeoutMs,
            idleTimeoutMillis: 30000
        });
        // An idle client dropped by the server must not take the process down.
        pool.on('error', err => console.error('[db] idle client error:', err.message));
    }
    return pool;
}

function query(text, params) {
    const p = getPool();
    if (!p) throw new Error('DATABASE_URL is not configured');
    return p.query(text, params);
}

/** Run a function inside a transaction, rolling back on any error. */
async function withTransaction(fn) {
    const p = getPool();
    if (!p) throw new Error('DATABASE_URL is not configured');
    const client = await p.connect();
    client.on('error', err => console.error('[db] client socket error:', err.message));
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters more */ }
        throw err;
    } finally {
        client.release();
    }
}

/** Host and database name only — never the user, password or full URL. */
function describeTarget() {
    if (!isConfigured()) return null;
    try {
        const parsed = new URL(config.databaseUrl);
        return `${parsed.hostname}/${parsed.pathname.replace(/^\//, '') || 'postgres'}`;
    } catch (_) {
        return 'configured database';
    }
}

async function close() {
    if (pool) {
        const closing = pool;
        pool = null;
        await closing.end();
    }
}

module.exports = { isConfigured, getPool, query, withTransaction, describeTarget, close };
