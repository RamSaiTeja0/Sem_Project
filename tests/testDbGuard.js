/**
 * Test Database Safety Guard & Isolation Helper
 *
 * Ensures automated test execution NEVER connects to or modifies the
 * real production/development application database (DATABASE_URL).
 *
 * Requirements:
 * 1. TEST_DATABASE_URL must be explicitly configured.
 * 2. TEST_DATABASE_URL must NOT target the same database as DATABASE_URL.
 * 3. Sets process.env.DATABASE_URL = process.env.TEST_DATABASE_URL during test runtime.
 * 4. Refuses destructive operations if pointed at the real database.
 */

require('dotenv').config();
const { URL } = require('url');

function normalizeDbTarget(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
        const parsed = new URL(rawUrl.trim());
        const host = (parsed.hostname || '').toLowerCase();
        const port = parsed.port || '5432';
        const dbName = (parsed.pathname || '').replace(/^\//, '').toLowerCase();
        return { host, port, dbName, full: `${host}:${port}/${dbName}` };
    } catch (_) {
        return null;
    }
}

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function getEnvConfig() {
    const envPath = path.join(__dirname, '..', '.env');
    let parsedEnv = {};
    if (fs.existsSync(envPath)) {
        try {
            parsedEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
        } catch (_) {}
    }
    return parsedEnv;
}

function verifySafetyGuard() {
    const envFile = getEnvConfig();
    const appProdUrl = (process.env.APP_DATABASE_URL || envFile.DATABASE_URL || '').trim();
    const testUrl = (process.env.TEST_DATABASE_URL || envFile.TEST_DATABASE_URL || '').trim();

    if (!testUrl) {
        const err = new Error(
            '[SAFETY GUARD] FATAL: TEST_DATABASE_URL is not configured in .env or environment.\n' +
            'Database tests are strictly forbidden from running against DATABASE_URL to prevent data pollution.'
        );
        err.code = 'TEST_DB_MISSING';
        throw err;
    }

    const parsedTest = normalizeDbTarget(testUrl);
    if (!parsedTest || !parsedTest.dbName) {
        const err = new Error(
            `[SAFETY GUARD] FATAL: TEST_DATABASE_URL is invalid: "${testUrl}". Must be a valid PostgreSQL connection string.`
        );
        err.code = 'TEST_DB_INVALID';
        throw err;
    }

    if (appProdUrl) {
        const parsedProd = normalizeDbTarget(appProdUrl);
        if (parsedProd && parsedTest.full === parsedProd.full) {
            const err = new Error(
                `[SAFETY GUARD] FATAL: TEST_DATABASE_URL points to the SAME database as application DATABASE_URL (${parsedProd.full}).\n` +
                'Automated tests can NEVER run against the production/application database.\n' +
                'Please configure a dedicated test database in .env (e.g., neondb_test).'
            );
            err.code = 'TEST_DB_COLLISION';
            throw err;
        }
    }

    // Isolate process.env.DATABASE_URL to TEST_DATABASE_URL for the duration of this process
    process.env.DATABASE_URL = testUrl;
    process.env.TEST_DATABASE_URL = testUrl;
    process.env.NODE_ENV = 'test';

    return {
        testDatabaseUrl: testUrl,
        parsedTest,
        appProdUrl
    };
}

/**
 * Initializes test environment and applies schema migrations to the test database.
 */
async function initTestDb() {
    const guardResult = verifySafetyGuard();

    const pool = require('../src/db/pool');
    if (typeof pool.resetPool === 'function') {
        await pool.resetPool();
    }

    const seeder = require('../src/db/seed');
    await seeder.migrate();

    return guardResult;
}

module.exports = {
    normalizeDbTarget,
    verifySafetyGuard,
    initTestDb
};
