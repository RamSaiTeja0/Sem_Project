/**
 * Timetable store — the seam between data storage and the availability engine.
 *
 * Today it keeps one normalized dataset in memory. To move to PostgreSQL/Neon
 * later, replace `loadSource()` with a query that returns the same source shape;
 * the normalizer, validator, engine, API and UI are untouched by that change.
 *
 * Availability reads never mutate anything here. Only an explicit, confirmed
 * import replaces the dataset, and even then nothing is written to disk.
 */
const { normalize } = require('../core/normalizer');
const { validate } = require('../core/validator');
const { createEngine } = require('../core/availabilityEngine');
const demoTimetable = require('./demoTimetable');

let state = null;

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

init();

module.exports = {
    buildState,
    init,
    /** Replace the live dataset. In-memory only; on failure the old one stays. */
    replace(source, origin) {
        state = buildState(source, origin);
        return state;
    },
    get engine() { return state.engine; },
    get report() { return state.report; },
    get origin() { return state.origin; },
    get loadedAt() { return state.loadedAt; },
    get normalized() { return state.normalized; }
};
