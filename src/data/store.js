/**
 * Timetable store — the seam between data storage and the availability engine.
 *
 * Two backings, one shape:
 *   - PostgreSQL/Neon, when DATABASE_URL is set. Tables are created if absent
 *     and seeded with the demo dataset if the timetable is empty.
 *   - the bundled in-memory demo dataset otherwise, exactly as before.
 *
 * Either way `loadSource()` yields the same source shape, so the normalizer,
 * validator, engine, API and UI are untouched by the choice. The fallback is
 * never removed: if the database is unreachable at startup the app still comes
 * up on demo data and says so, rather than failing to boot.
 *
 * Availability reads never mutate anything here. The dataset changes only on a
 * confirmed import or an explicit timetable edit.
 */
const { normalize } = require('../core/normalizer');
const { validate } = require('../core/validator');
const { createEngine } = require('../core/availabilityEngine');
const demoTimetable = require('./demoTimetable');
const db = require('../db/pool');

let state = null;
/** Set once the database has successfully supplied the live dataset. */
let databaseBacked = false;
/** Why the database is not in use, when it isn't. Shown on the About screen. */
let databaseError = null;

/**
 * Normalize + validate a source and build an engine over it.
 * Throws if validation fails, so a broken timetable never becomes live.
 */
function buildState(source, origin) {
    const normalized = normalize(source);
    const report = validate(normalized);

    if (!report.ok) {
        const error = new Error(
            'Timetable validation failed:\n  - ' + report.errors.map(e => e.message).join('\n  - '));
        error.code = 'VALIDATION_FAILED';
        error.report = report;
        throw error;
    }

    return {
        source,
        origin: origin || 'demo',
        loadedAt: new Date().toISOString(),
        normalized,
        report,
        engine: createEngine(normalized)
    };
}

function loadSource() {
    return demoTimetable;
}

function init() {
    state = buildState(loadSource(), 'demo-data');
    return state;
}

// The in-memory dataset is loaded synchronously at require time so the app is
// answering requests before any database round-trip has happened.
init();

/**
 * Bring the database online: create tables, seed when empty, then serve the
 * timetable from it. Falls back to the demo dataset already in memory if
 * anything goes wrong, and never throws.
 *
 * @returns {Promise<{ enabled: boolean, seeded?: boolean, error?: string }>}
 */
async function initFromDatabase(options = {}) {
    if (!db.isConfigured()) {
        return { enabled: false, reason: 'DATABASE_URL is not set — using the bundled demo dataset' };
    }
    const seeder = require('../db/seed');
    const repository = require('../db/repository');
    try {
        await seeder.migrate();
        const seedResult = options.seed === false
            ? { seeded: false, reason: 'seeding skipped' }
            : await seeder.seed();

        const source = await repository.loadSource(demoTimetable.meta);
        if (!source.classes.length) {
            // An empty database is not an error, but there is nothing to serve
            // from it — keep the demo data rather than blanking the dashboard.
            databaseError = 'the database holds no timetable rows';
            return { enabled: false, reason: databaseError, seeded: seedResult.seeded };
        }

        state = buildState(source, 'neon-postgres');
        databaseBacked = true;
        databaseError = null;
        return {
            enabled: true,
            seeded: Boolean(seedResult.seeded),
            target: db.describeTarget(),
            counts: await repository.counts()
        };
    } catch (err) {
        databaseBacked = false;
        databaseError = err.message;
        return { enabled: false, error: err.message };
    }
}

/** Re-read the timetable from the database after a write. */
async function reloadFromDatabase() {
    if (!databaseBacked) return false;
    const repository = require('../db/repository');
    const source = await repository.loadSource(demoTimetable.meta);
    state = buildState(source, 'neon-postgres');
    return true;
}

module.exports = {
    buildState,
    init,
    initFromDatabase,
    reloadFromDatabase,
    /** Replace the live dataset. In-memory only; on failure the old one stays. */
    replace(source, origin) {
        state = buildState(source, origin);
        // An import supersedes the database as the live view until the next
        // reload; the database itself is left untouched.
        databaseBacked = false;
        return state;
    },
    get engine() { return state.engine; },
    get report() { return state.report; },
    get origin() { return state.origin; },
    get loadedAt() { return state.loadedAt; },
    get normalized() { return state.normalized; },
    get usingDatabase() { return databaseBacked; },
    get databaseError() { return databaseError; },
    get databaseConfigured() { return db.isConfigured(); }
};
