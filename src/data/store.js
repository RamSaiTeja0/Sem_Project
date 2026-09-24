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

        // Restore departments/branches
        try {
            const dbDepts = await repository.loadAllDepartments();
            const { registerBranch } = require('./departments');
            for (const dept of dbDepts) {
                registerBranch({
                    code: dept.code,
                    name: dept.name,
                    academicYear: dept.academicYear,
                    semester: dept.semester,
                    totalSemesters: dept.totalSemesters
                });
            }
        } catch (_) {}

        // Restore registered users
        try {
            const dbUsers = await repository.loadAllUsers();
            const usersModule = require('./users');
            if (typeof usersModule.syncFromDatabase === 'function') {
                usersModule.syncFromDatabase(dbUsers);
            }
        } catch (_) {}

        // Restore faculty substitutions
        try {
            const dbSubs = await repository.listFacultySubstitutions();
            const substitutionsModule = require('./substitutions');
            if (typeof substitutionsModule.syncFromDatabase === 'function') {
                substitutionsModule.syncFromDatabase(dbSubs);
            }
        } catch (_) {}

        const source = await repository.loadSource(demoTimetable.meta);
        const counts = await repository.counts();
        if (!source.classes.length || counts.timetable === 0) {
            source.allowEmpty = true;
        }

        state = buildState(source, 'neon-postgres');
        databaseBacked = true;
        databaseError = null;
        return {
            enabled: true,
            seeded: Boolean(seedResult.seeded),
            target: db.describeTarget(),
            counts
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

    try {
        const dbDepts = await repository.loadAllDepartments();
        const { registerBranch } = require('./departments');
        for (const dept of dbDepts) {
            registerBranch({
                code: dept.code,
                name: dept.name,
                academicYear: dept.academicYear,
                semester: dept.semester,
                totalSemesters: dept.totalSemesters
            });
        }
    } catch (_) {}

    try {
        const dbUsers = await repository.loadAllUsers();
        const usersModule = require('./users');
        if (typeof usersModule.syncFromDatabase === 'function') {
            usersModule.syncFromDatabase(dbUsers);
        }
    } catch (_) {}

    try {
        const dbSubs = await repository.listFacultySubstitutions();
        const substitutionsModule = require('./substitutions');
        if (typeof substitutionsModule.syncFromDatabase === 'function') {
            substitutionsModule.syncFromDatabase(dbSubs);
        }
    } catch (_) {}

    const source = await repository.loadSource(demoTimetable.meta);
    const counts = await repository.counts();
    if (!source.classes.length || counts.timetable === 0) source.allowEmpty = true;
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

function updateFacultyInMemory(id, updates = {}) {
    if (!state.source.faculty) state.source.faculty = [];
    const facultyId = String(id).trim();
    const fac = state.source.faculty.find(f =>
        (f.id && String(f.id).toLowerCase() === facultyId.toLowerCase()) ||
        (f.code && String(f.code).toLowerCase() === facultyId.toLowerCase()) ||
        (f.name && f.name.toLowerCase() === facultyId.toLowerCase())
    );
    if (!fac) {
        const err = new Error(`Faculty "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const oldName = fac.name;
    if (updates.name && String(updates.name).trim().length >= 2) {
        fac.name = String(updates.name).trim();
    }
    if (updates.phone !== undefined) {
        fac.phone = updates.phone ? String(updates.phone).trim() : null;
    }
    if (updates.designation !== undefined) {
        fac.designation = updates.designation ? String(updates.designation).trim() : null;
    }
    if (Array.isArray(updates.subjects)) {
        fac.subjects = updates.subjects.map(s => String(s).trim()).filter(Boolean);
    }
    if (updates.maxWeeklyPeriods !== undefined) {
        const mwp = parseInt(updates.maxWeeklyPeriods, 10);
        if (Number.isFinite(mwp)) fac.maxWeeklyPeriods = mwp;
    }

    // Historical timetable slots: preserve ownership under updated name if name changed
    if (oldName && fac.name !== oldName && Array.isArray(state.source.entries)) {
        state.source.entries.forEach(e => {
            if (e.faculty === oldName) e.faculty = fac.name;
        });
    }

    state = buildState({ ...state.source, allowEmpty: true }, 'in-memory');
    return fac;
}

function setFacultyStatusInMemory(id, status) {
    if (!state.source.faculty) state.source.faculty = [];
    const facultyId = String(id).trim();
    const fac = state.source.faculty.find(f =>
        (f.id && String(f.id).toLowerCase() === facultyId.toLowerCase()) ||
        (f.code && String(f.code).toLowerCase() === facultyId.toLowerCase()) ||
        (f.name && f.name.toLowerCase() === facultyId.toLowerCase())
    );
    if (!fac) {
        const err = new Error(`Faculty "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }
    fac.status = status;
    state = buildState({ ...state.source, allowEmpty: true }, 'in-memory');
    return fac;
}

function resetForEmptyInstance(branch = null) {
    try {
        const attendance = require('./attendance');
        if (attendance && typeof attendance.resetForTesting === 'function') {
            attendance.resetForTesting();
        }
        const invigilation = require('./invigilation');
        if (invigilation && typeof invigilation.resetForTesting === 'function') {
            invigilation.resetForTesting();
        }
    } catch (_) {}
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

function parseSemesterNumber(val) {
    if (val == null) return null;
    if (typeof val === 'number' && !isNaN(val)) return val;
    const str = String(val).trim().toUpperCase();
    const semMatch = str.match(/SEM(?:ESTER)?[-_\s]*(\d+)/i);
    if (semMatch) return parseInt(semMatch[1], 10);
    const romanMatch = str.match(/^(VIII|VII|VI|IV|V|III|II|I)$/i);
    if (romanMatch) {
        const map = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
        return map[romanMatch[1].toUpperCase()] || null;
    }
    const num = parseInt(str, 10);
    return isNaN(num) ? null : num;
}

function importStagedTimetableInMemory(arg1, arg2) {
    ensureMemoryEntries();
    let uploadRecord = {};
    let stagedContract = {};
    let resolvedMap = {};
    let userId = null;

    if (arg1 && typeof arg1 === 'object' && arg1.stagedContract) {
        uploadRecord = arg1.uploadRecord || {};
        stagedContract = arg1.stagedContract || {};
        resolvedMap = arg1.resolvedMap || {};
        userId = arg1.userId || null;
    } else if (typeof arg1 === 'string' || (arg2 && typeof arg2 === 'object')) {
        uploadRecord = { uploadId: arg1 };
        stagedContract = arg2 || {};
    } else if (arg1 && typeof arg1 === 'object') {
        stagedContract = arg1;
    }

    const targetClass = (resolvedMap && resolvedMap.class) ? (resolvedMap.class.code || resolvedMap.class.name) : stagedContract.class_name;
    const className = (targetClass || stagedContract.class_name || stagedContract.className || 'GENERAL-A').trim();
    const targetDept = String(uploadRecord.departmentCode || stagedContract.department_code || stagedContract.branch || 'General').toUpperCase();

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
        const facultyName = resolvedFaculty ? (resolvedFaculty.name || resolvedFaculty.code) : (entry.faculty_name || entry.faculty || null);

        const resolvedSubject = (resolvedMap && resolvedMap.subjects && (resolvedMap.subjects[entry.subject_name] || resolvedMap.subjects[entry.subject_code] || (resolvedMap.subjects.get && (resolvedMap.subjects.get(entry.subject_name) || resolvedMap.subjects.get(entry.subject_code)))));
        const subjectName = resolvedSubject ? (resolvedSubject.name || resolvedSubject.code) : (entry.subject_name || entry.subject || 'Activity');

        const resolvedRoom = entry.room_code
            ? (resolvedMap && resolvedMap.rooms && (resolvedMap.rooms[entry.room_code] || (resolvedMap.rooms.get && resolvedMap.rooms.get(entry.room_code))))
            : null;
        const roomCode = resolvedRoom ? (resolvedRoom.code || resolvedRoom.name) : (entry.room_code || entry.room || null);

        for (let p = startP; p <= endP; p++) {
            // Check faculty clash across OTHER classes
            if (facultyName) {
                const clash = existingEntries.find(e =>
                    e.faculty &&
                    e.faculty.toUpperCase() === facultyName.toUpperCase() &&
                    e.day === entry.day &&
                    e.period === p &&
                    e.className !== className &&
                    e.class !== className
                );
                if (clash) {
                    const err = new Error(`Faculty ${facultyName} is already teaching ${clash.className || clash.class} at ${entry.day} P${p}`);
                    err.code = 'SLOT_CONFLICT';
                    err.status = 409;
                    err.details = [{
                        code: 'FACULTY_BUSY',
                        message: err.message,
                        day: entry.day,
                        period: p,
                        faculty: facultyName,
                        conflictingClass: clash.className || clash.class
                    }];
                    throw err;
                }
            }

            // Check room clash across OTHER classes
            if (roomCode) {
                const roomClash = existingEntries.find(e =>
                    e.room &&
                    e.room.toUpperCase() === roomCode.toUpperCase() &&
                    e.day === entry.day &&
                    e.period === p &&
                    e.className !== className &&
                    e.class !== className
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
                type: entry.session_type || entry.type || 'theory'
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
    if (!Number.isFinite(nextId)) nextId = 1000;
    const combinedEntries = remainingEntries.concat(newSlots.map(s => ({
        id: ++nextId,
        ...s
    })));

    // 4. Update source classes metadata if needed
    const stagedSem = parseSemesterNumber(stagedContract.semester) || stagedContract.semester;
    let stagedSec = stagedContract.section ? String(stagedContract.section).trim().toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '') : null;
    if (!stagedSec && className) {
        const m = className.match(/[-_]([A-Za-z0-9])$/);
        if (m) stagedSec = m[1].toUpperCase();
    }

    const updatedClasses = (state.source.classes || []).map(c => {
        const cCode = String(c.code || c.class || '').toUpperCase();
        if (cCode === className.toUpperCase()) {
            return {
                ...c,
                semester: c.semester != null ? c.semester : stagedSem,
                academicYear: c.academicYear || stagedContract.academic_year || stagedContract.academicYear,
                section: c.section || stagedSec,
                department: c.department || targetDept
            };
        }
        return c;
    });

    if (!updatedClasses.some(c => String(c.code || c.class || '').toUpperCase() === className.toUpperCase())) {
        updatedClasses.push({
            id: updatedClasses.length + 1,
            code: className,
            class: className,
            name: className,
            department: targetDept,
            branch: targetDept,
            semester: stagedSem,
            academicYear: stagedContract.academic_year || stagedContract.academicYear,
            section: stagedSec
        });
    }

    // 5. Update source and rebuild state
    const newSource = {
        ...state.source,
        classes: updatedClasses,
        allowEmpty: true,
        entries: combinedEntries
    };

    state = buildState(newSource, 'in-memory-import');
    return { importedCount: newSlots.length };
}

function resolveOrCreateClassInMemory({ branch, academicYear, semester, section }) {
    const branchCode = String(branch || '').trim().toUpperCase();
    const semNum = parseSemesterNumber(semester);
    const semStr = semNum ? `SEM-${semNum}` : (semester ? String(semester).trim().toUpperCase() : null);
    const secStr = section ? String(section).trim().toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '') : null;
    const yrStr = academicYear ? String(academicYear).trim() : null;

    if (!state.source.classes) state.source.classes = [];
    const sourceClasses = state.source.classes;

    // Prioritize classes that have scheduled rows or busy records
    const sortedClasses = sourceClasses.slice().sort((a, b) => {
        const aEntries = (a.rows ? Object.values(a.rows).reduce((acc, r) => acc + (Array.isArray(r) ? r.length : 0), 0) : 0);
        const bEntries = (b.rows ? Object.values(b.rows).reduce((acc, r) => acc + (Array.isArray(r) ? r.length : 0), 0) : 0);
        return bEntries - aEntries;
    });

    // 1. Match by branch + semester + section
    let matched = sortedClasses.find(c => {
        const cDept = String(c.department || c.branch || '').toUpperCase();
        const cSemNum = parseSemesterNumber(c.semester);
        let cSec = c.section ? String(c.section).trim().toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '') : null;
        const cCode = String(c.code || c.class || '').toUpperCase();
        if (!cSec && cCode) {
            const m = cCode.match(/[-_]([A-Za-z0-9])$/);
            if (m) cSec = m[1].toUpperCase();
        }
        const matchesBranch = !branchCode || cDept === branchCode;
        const matchesSem = (semNum != null) ? (cSemNum === semNum) : true;
        const matchesSec = secStr ? cSec === secStr : true;
        return matchesBranch && matchesSem && matchesSec;
    });

    if (!matched && semNum != null) {
        matched = sortedClasses.find(c => {
            const cDept = String(c.department || c.branch || '').toUpperCase();
            const cSemNum = parseSemesterNumber(c.semester);
            const matchesBranch = !branchCode || cDept === branchCode;
            const entries = (c.rows ? Object.values(c.rows).reduce((acc, r) => acc + (Array.isArray(r) ? r.length : 0), 0) : 0);
            return matchesBranch && cSemNum === semNum && entries > 0;
        });
    }

    if (matched) {
        const code = matched.code || matched.class || '';
        let sec = matched.section ? String(matched.section).trim().toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '') : null;
        if (!sec && code) {
            const m = code.match(/[-_]([A-Za-z0-9])$/);
            if (m) sec = m[1].toUpperCase();
        }
        return {
            id: matched.id || code,
            code: code,
            class: code,
            name: matched.name || code,
            department: matched.department || branchCode,
            branch: matched.department || branchCode,
            semester: matched.semester || semNum || semStr,
            academicYear: matched.academicYear || yrStr,
            section: sec || secStr
        };
    }

    // 2. Legacy fallback check (e.g. CME-A) if semStr is null or matches
    if (secStr) {
        const legacyCode = `${branchCode}-${secStr}`;
        matched = sourceClasses.find(c => {
            const cCode = String(c.code || c.class || '').toUpperCase();
            return cCode === legacyCode;
        });
        if (matched) {
            const cSemNum = repository.parseSemesterNumber ? repository.parseSemesterNumber(matched.semester) : null;
            if (semNum == null || cSemNum === semNum) {
                return {
                    id: matched.id || legacyCode,
                    code: legacyCode,
                    class: legacyCode,
                    name: matched.name || legacyCode,
                    department: branchCode,
                    branch: branchCode,
                    semester: matched.semester || semNum || null,
                    academicYear: matched.academicYear || yrStr || null,
                    section: secStr
                };
            }
        }
    }

    // 3. Create new class in memory
    const semClean = semNum ? `SEM${semNum}` : (semStr ? semStr.replace(/[^A-Za-z0-9]/g, '') : '');
    const newCode = `${branchCode}${semClean ? '-' + semClean : ''}${secStr ? '-' + secStr : ''}`;
    const newName = `${branchCode} ${semStr || ''} ${secStr ? 'Sec-' + secStr : ''}`.replace(/\s+/g, ' ').trim();
    const newId = 5000 + sourceClasses.length + 1;

    const newClassObj = {
        id: newId,
        code: newCode,
        class: newCode,
        name: newName,
        department: branchCode,
        branch: branchCode,
        semester: semNum || semStr,
        academicYear: yrStr,
        section: secStr,
        rows: {}
    };

    sourceClasses.push(newClassObj);
    return newClassObj;
}

function clearTimetableInMemory({ classId, className, branchCode }) {
    let targetClassName = className ? String(className).trim().toUpperCase() : null;
    const sourceClasses = state.source.classes || [];

    if (!targetClassName && classId) {
        const c = sourceClasses.find(cls => String(cls.id) === String(classId));
        if (c) targetClassName = String(c.code || c.class).trim().toUpperCase();
    }

    if (!targetClassName) {
        const err = new Error('Class not found for clear timetable.');
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
    }

    // Verify branch isolation
    const matchedClass = sourceClasses.find(c => String(c.code || c.class).toUpperCase() === targetClassName);
    let cDept = matchedClass ? String(matchedClass.department || matchedClass.branch || '').toUpperCase() : null;
    if (!cDept && targetClassName.includes('-')) {
        const prefix = targetClassName.split('-')[0].trim().toUpperCase();
        if (prefix) cDept = prefix;
    }
    if (branchCode && cDept && cDept !== String(branchCode).toUpperCase()) {
        const err = new Error(`Cross-branch timetable management is not allowed. Target class belongs to ${cDept}, but current branch is ${branchCode}.`);
        err.code = 'FORBIDDEN';
        err.status = 403;
        throw err;
    }

    const beforeCount = (state.source.entries || []).length;
    const remainingEntries = (state.source.entries || []).filter(e => {
        const entryClass = String(e.class || e.className || '').trim().toUpperCase();
        return entryClass !== targetClassName;
    });
    const clearedCount = beforeCount - remainingEntries.length;

    const newSource = {
        ...state.source,
        allowEmpty: true,
        entries: remainingEntries
    };

    state = buildState(newSource, 'in-memory-clear');
    return {
        cleared: true,
        className: targetClassName,
        clearedCount
    };
}

const facultyPersonalStore = new Map();

function saveFacultyPersonalTimetableInMemory(facultyNameOrId, slots) {
    const key = String(facultyNameOrId).toUpperCase();
    facultyPersonalStore.set(key, slots || []);
    return { success: true, count: (slots || []).length };
}

function getFacultyPersonalTimetableInMemory(facultyNameOrId) {
    const key = String(facultyNameOrId).toUpperCase();
    return facultyPersonalStore.get(key) || [];
}

function clearFacultyPersonalTimetableInMemory(facultyNameOrId) {
    const key = String(facultyNameOrId).toUpperCase();
    const existed = facultyPersonalStore.has(key);
    facultyPersonalStore.delete(key);
    return { cleared: existed };
}

function saveSlotEntryInMemory({ className, day, period, subject, faculty, room, type }) {
    const existingEntries = state.source.timetable || [];
    const filtered = existingEntries.filter(
        e => !((e.class === className || e.className === className) && e.day === day && e.period === period)
    );

    if (!subject || subject.trim() === '' || subject.trim().toLowerCase() === 'free') {
        state.source.timetable = filtered;
        state = buildState(state.source, state.origin);
        return { deleted: true, day, period, className };
    }

    let nextId = Math.max(1000, ...filtered.map(e => e.id || 0));
    if (!Number.isFinite(nextId)) nextId = 1000;

    const newEntry = {
        id: ++nextId,
        className,
        class: className,
        day,
        period,
        subject,
        faculty: faculty || null,
        room: room || null,
        type: type || 'theory'
    };

    filtered.push(newEntry);
    state.source.timetable = filtered;
    state = buildState(state.source, state.origin);
    return newEntry;
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
    saveSlotEntryInMemory,
    addFacultyInMemory,
    updateFacultyInMemory,
    setFacultyStatusInMemory,
    resolveOrCreateClassInMemory,
    clearTimetableInMemory,
    resetForEmptyInstance,
    importStagedTimetableInMemory,
    saveFacultyPersonalTimetableInMemory,
    getFacultyPersonalTimetableInMemory,
    clearFacultyPersonalTimetableInMemory,
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
