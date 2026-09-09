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
const config = require('../config');

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
    const normalized = normalize(source, { allowEmpty: Boolean(source && source.allowEmpty) });
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
    if (config.loadDemoData) {
        return demoTimetable;
    }
    if (process.env.EMPTY_TIMETABLE === 'true') {
        const { getBranch } = require('./departments');
        const branch = getBranch();
        const code = branch.code || 'BRANCH';
        return {
            allowEmpty: true,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            classes: [
                { class: `${code}-A`, department: code, rows: {} },
                { class: `${code}-B`, department: code, rows: {} }
            ],
            faculty: [
                { id: `${code}_F1`, name: 'Dr. A. Sharma', department: code },
                { id: `${code}_F2`, name: 'Prof. B. Patel', department: code },
                { id: `${code}_F3`, name: 'Sri C. Rao', department: code }
            ],
            subjects: [
                { code: `${code}101`, name: 'Foundation Engineering', department: code, type: 'theory' },
                { code: `${code}102`, name: 'Engineering Mechanics', department: code, type: 'theory' }
            ],
            entries: []
        };
    }
    return {
        allowEmpty: true,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        classes: [],
        faculty: [],
        subjects: [],
        rooms: [],
        entries: []
    };
}

function init() {
    const origin = config.loadDemoData ? 'demo-data' : 'fresh-instance';
    state = buildState(loadSource(), origin);
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
            source.allowEmpty = true;
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
    if (!source.classes.length) source.allowEmpty = true;
    state = buildState(source, 'neon-postgres');
    return true;
}

let nextEntryId = 1000;
let allowMemoryWrites = false;

function ensureMemoryEntries() {
    if (!state.source.entries) {
        state.source.entries = (state.normalized.busyRecords || []).map((r, idx) => ({
            id: r.id || (idx + 1),
            className: r.className,
            class: r.className,
            day: r.day,
            period: r.period,
            subject: r.subject,
            faculty: r.faculty,
            room: r.room,
            type: r.type || 'theory'
        }));
        nextEntryId = Math.max(1000, ...state.source.entries.map(e => e.id || 0));
    }
}

function addEntryInMemory(entry) {
    ensureMemoryEntries();
    const id = ++nextEntryId;
    const newEntry = {
        id,
        className: entry.className,
        class: entry.className,
        day: entry.day,
        period: entry.period,
        subject: entry.subject,
        faculty: entry.faculty,
        room: entry.room,
        type: entry.type || 'theory'
    };
    state.source.entries.push(newEntry);
    state = buildState({ ...state.source, allowEmpty: true }, 'in-memory');
    return newEntry;
}

function updateEntryInMemory(id, entry) {
    ensureMemoryEntries();
    const numId = parseInt(id, 10);
    const idx = state.source.entries.findIndex(e => e.id === numId);
    if (idx === -1) {
        const err = new Error(`No timetable entry with id ${id}`);
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
    }
    const updated = {
        ...state.source.entries[idx],
        className: entry.className,
        class: entry.className,
        day: entry.day,
        period: entry.period,
        subject: entry.subject,
        faculty: entry.faculty,
        room: entry.room,
        type: entry.type || 'theory'
    };
    state.source.entries[idx] = updated;
    state = buildState({ ...state.source, allowEmpty: true }, 'in-memory');
    return updated;
}

function deleteEntryInMemory(id) {
    ensureMemoryEntries();
    const numId = parseInt(id, 10);
    const idx = state.source.entries.findIndex(e => e.id === numId);
    if (idx === -1) {
        return false;
    }
    state.source.entries.splice(idx, 1);
    state = buildState({ ...state.source, allowEmpty: true }, 'in-memory');
    return true;
}

function getEntryInMemory(id) {
    ensureMemoryEntries();
    const numId = parseInt(id, 10);
    return state.source.entries.find(e => e.id === numId) || null;
}

function listEntriesInMemory(filters = {}) {
    ensureMemoryEntries();
    let entries = state.source.entries.slice();
    if (filters.className) entries = entries.filter(e => e.className === filters.className || e.class === filters.className);
    if (filters.faculty) entries = entries.filter(e => e.faculty === filters.faculty);
    if (filters.day) entries = entries.filter(e => e.day === filters.day);
    if (filters.period) entries = entries.filter(e => e.period === filters.period);
    if (filters.branch) {
        const bUpper = String(filters.branch).trim().toUpperCase();
        entries = entries.filter(e => {
            const cls = ((state.source && state.source.classes) || []).find(c => (c.class || c.name || c.code) === (e.className || e.class));
            if (cls && cls.department) return cls.department.toUpperCase() === bUpper;
            const fac = ((state.source && state.source.faculty) || []).find(f => f.name === e.faculty);
            if (fac && fac.department) return fac.department.toUpperCase() === bUpper;
            return false;
        });
    }
    return entries;
}

function addFacultyInMemory(member) {
    if (!state.source.faculty) state.source.faculty = [];
    const id = member.id || `FAC_${Date.now()}`;
    const exists = state.source.faculty.find(f =>
        (f.name && member.name && f.name.toLowerCase() === member.name.toLowerCase()) ||
        (f.id && id && String(f.id).toLowerCase() === String(id).toLowerCase())
    );
    if (exists) {
        if (member.phone) exists.phone = member.phone;
        if (member.subjects) exists.subjects = member.subjects;
        return exists;
    }
    const newFaculty = {
        id,
        name: member.name,
        department: member.department,
        designation: member.designation || 'Faculty',
        email: member.email || null,
        phone: member.phone || null,
        subjects: Array.isArray(member.subjects) ? member.subjects : [],
        status: member.status || 'active',
        maxWeeklyPeriods: member.maxWeeklyPeriods || 20
    };
    state.source.faculty.push(newFaculty);
    state = buildState({ ...state.source, allowEmpty: true }, 'in-memory');
    return newFaculty;
}

function resetForEmptyInstance(branch = null) {
    state = buildState({
        allowEmpty: true,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        classes: [],
        faculty: [],
        subjects: [],
        rooms: [],
        entries: []
    }, 'in-memory-empty');
    return state;
}

function importStagedTimetableInMemory({ uploadRecord, stagedContract, resolvedMap, userId }) {
    ensureMemoryEntries();
    const targetClass = (resolvedMap && resolvedMap.class) ? (resolvedMap.class.code || resolvedMap.class.name) : stagedContract.class_name;
    const className = targetClass || stagedContract.class_name;
    const targetDept = String(uploadRecord.departmentCode || '').toUpperCase();

    // 1. Check conflicts against other classes
    const existingEntries = state.source.entries || [];
    const newSlots = [];

    for (const entry of (stagedContract.entries || [])) {
        if (entry.is_free) continue;
        const startP = entry.period;
        const endP = entry.span_to || entry.period;

        // Resolve mapped entity attributes
        const resolvedFaculty = entry.faculty_name
            ? (resolvedMap && resolvedMap.faculty && (resolvedMap.faculty[entry.faculty_name] || (resolvedMap.faculty.get && resolvedMap.faculty.get(entry.faculty_name))))
            : null;
        const facultyName = resolvedFaculty ? (resolvedFaculty.name || resolvedFaculty.code) : (entry.faculty_name || null);

        const resolvedSubject = (resolvedMap && resolvedMap.subjects && (resolvedMap.subjects[entry.subject_name] || resolvedMap.subjects[entry.subject_code] || (resolvedMap.subjects.get && (resolvedMap.subjects.get(entry.subject_name) || resolvedMap.subjects.get(entry.subject_code)))));
        const subjectName = resolvedSubject ? (resolvedSubject.name || resolvedSubject.code) : (entry.subject_name || entry.subject_code);

        const resolvedRoom = entry.room_code
            ? (resolvedMap && resolvedMap.rooms && (resolvedMap.rooms[entry.room_code] || (resolvedMap.rooms.get && resolvedMap.rooms.get(entry.room_code))))
            : null;
        const roomCode = resolvedRoom ? (resolvedRoom.code || resolvedRoom.name) : (entry.room_code || null);

        for (let p = startP; p <= endP; p++) {
            // Check faculty conflict with other classes
            if (facultyName) {
                const facClash = existingEntries.find(e =>
                    e.day === entry.day &&
                    e.period === p &&
                    (e.class !== className && e.className !== className) &&
                    e.faculty && e.faculty.toUpperCase() === facultyName.toUpperCase()
                );
                if (facClash) {
                    const err = new Error(`Faculty ${facultyName} already teaches ${facClash.subject} in class ${facClash.className || facClash.class} at ${entry.day} P${p}`);
                    err.code = 'SLOT_CONFLICT';
                    err.status = 409;
                    err.details = [{
                        code: 'FACULTY_BUSY',
                        message: err.message,
                        day: entry.day,
                        period: p,
                        faculty: facultyName,
                        conflictingClass: facClash.className || facClash.class
                    }];
                    throw err;
                }
            }

            // Check room conflict with other classes
            if (roomCode) {
                const roomClash = existingEntries.find(e =>
                    e.day === entry.day &&
                    e.period === p &&
                    (e.class !== className && e.className !== className) &&
                    e.room && e.room.toUpperCase() === roomCode.toUpperCase()
                );
                if (roomClash) {
                    const err = new Error(`Room ${roomCode} is already used by ${roomClash.className || roomClash.class} at ${entry.day} P${p}`);
                    err.code = 'SLOT_CONFLICT';
                    err.status = 409;
                    err.details = [{
                        code: 'ROOM_BUSY',
                        message: err.message,
                        day: entry.day,
                        period: p,
                        room: roomCode,
                        conflictingClass: roomClash.className || roomClash.class
                    }];
                    throw err;
                }
            }

            newSlots.push({
                className,
                class: className,
                day: entry.day,
                period: p,
                subject: subjectName,
                faculty: facultyName,
                room: roomCode,
                type: entry.session_type || 'theory'
            });
        }
    }

    // 2. Remove previous entries for THIS class only (REPLACE_CLASS)
    const remainingEntries = existingEntries.filter(e =>
        e.class !== className && e.className !== className &&
        e.class !== stagedContract.class_name && e.className !== stagedContract.class_name
    );

    // 3. Assign IDs and combine
    let nextId = Math.max(1000, ...remainingEntries.map(e => e.id || 0));
    const combinedEntries = remainingEntries.concat(newSlots.map(s => ({
        id: ++nextId,
        ...s
    })));

    // 4. Update source and rebuild state
    const newSource = {
        ...state.source,
        allowEmpty: true,
        entries: combinedEntries
    };

    state = buildState(newSource, 'in-memory-import');
    return { importedCount: newSlots.length };
}

module.exports = {
    buildState,
    init,
    initFromDatabase,
    reloadFromDatabase,
    addEntryInMemory,
    updateEntryInMemory,
    deleteEntryInMemory,
    getEntryInMemory,
    listEntriesInMemory,
    addFacultyInMemory,
    resetForEmptyInstance,
    importStagedTimetableInMemory,
    get allowMemoryWrites() { return allowMemoryWrites || process.env.ALLOW_MEMORY_WRITES === 'true'; },
    set allowMemoryWrites(val) { allowMemoryWrites = Boolean(val); },
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
    /** The raw source the live dataset was built from, as loaded. */
    get source() { return state.source; },
    get usingDatabase() { return databaseBacked; },
    get databaseError() { return databaseError; },
    get databaseConfigured() { return db.isConfigured(); }
};
