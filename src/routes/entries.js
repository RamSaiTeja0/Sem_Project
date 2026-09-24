/**
 * Timetable entry management — the WRITE path.
 *
 *   GET    /api/timetable/entries          list entries (filterable)
 *   GET    /api/timetable/entries/reference form options: classes, subjects, …
 *   GET    /api/timetable/entries/:id      one entry
 *   POST   /api/timetable/entries          add
 *   PUT    /api/timetable/entries/:id      edit
 *   DELETE /api/timetable/entries/:id      delete
 *
 * Writes require a configured database or explicit memory writes mode.
 * All writes are validated against branch context, double booking, and reference integrity.
 */
const express = require('express');
const router = express.Router();

const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const { DEPARTMENTS, nameFor: departmentName, getBranch } = require('../data/departments');

const TYPES = ['theory', 'lab'];
const NON_FACULTY_PATTERN = /\b(library|counselling|counseling|tpc|placement|training|sports|games|seminar|mentoring|assembly|activity|break|lunch)\b/i;

function isNonFacultyActivity(subject, type) {
    return type === 'activity' || NON_FACULTY_PATTERN.test(subject || '');
}

/**
 * Class records from the live dataset, used when no database is serving.
 * The source keeps each class's department, semester and academic year, so the
 * form can show and filter on them either way.
 */
function classesFromDataset() {
    const declared = (store.source && store.source.classes) || [];
    return store.engine.getMeta().classes.map(code => {
        const match = declared.find(c => (c.class || c.name || c.code) === code) || {};
        const derivedSection = match.section || (code.includes('-') ? code.split('-').pop() : 'A');
        return {
            id: match.id || code,
            code,
            department: match.department || null,
            semester: match.semester || null,
            academicYear: match.academicYear || null,
            section: derivedSection,
            room: match.room || null
        };
    });
}

/**
 * Subject records from the live dataset, used when no database is serving.
 * Retains the department code and theory/lab type so the form can filter
 * subjects by branch.
 */
function subjectsFromDataset() {
    const declared = (store.source && store.source.subjects) || [];
    if (declared.length) {
        return declared.map(s => ({
            code: s.code || null,
            name: s.name,
            department: s.department || null,
            type: s.type || (/lab/i.test(s.name) ? 'lab' : 'theory')
        }));
    }
    const busy = (store.normalized && store.normalized.busyRecords) || [];
    const subjectsMap = new Map();
    busy.forEach(r => {
        if (r.subject && !subjectsMap.has(r.subject)) {
            let dept = null;
            if (r.className) {
                const cls = ((store.source && store.source.classes) || []).find(c => (c.class || c.name) === r.className);
                if (cls && cls.department) dept = cls.department;
            }
            if (!dept && r.faculty) {
                const fac = ((store.normalized && store.normalized.faculty) || []).find(f => f.name === r.faculty);
                if (fac && fac.department) dept = fac.department;
            }
            subjectsMap.set(r.subject, {
                code: null,
                name: r.subject,
                department: dept,
                type: r.type || (/lab/i.test(r.subject) ? 'lab' : 'theory')
            });
        }
    });
    return Array.from(subjectsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Storage guard for timetable writes */
function requireStorage(req, res, next) {
    if (db.isConfigured() && store.usingDatabase) return next();
    if (store.allowMemoryWrites) return next();
    return res.status(503).json({
        error: db.isConfigured()
            ? 'The database is configured but not currently serving the timetable' +
              (store.databaseError ? ` (${store.databaseError})` : '') + '.'
            : 'Saving a timetable entry needs a database. Set DATABASE_URL to your Neon ' +
              'connection string and restart. Reading and availability still work without it.',
        code: 'DATABASE_REQUIRED'
    });
}

/**
 * Validate and canonicalize the submitted fields. Returns either
 * `{ entry }` or `{ errors: [...] }` — all problems at once, not just the first.
 */
function parseEntry(body) {
    const engine = store.engine;
    const errors = [];
    const text = value => (value == null ? '' : String(value).trim());

    const day = engine.normalizeDay(body.day);
    if (!day) errors.push(`Day is missing or invalid. Valid days: ${engine.getDays().join(', ')}`);

    const period = engine.normalizePeriod(body.period);
    if (period == null) errors.push(`Period is missing or invalid. Valid periods: ${engine.getPeriods().join(', ')}`);

    const className = text(body.class || body.className);
    if (!className) errors.push('Class is required');

    const subject = text(body.subject);
    if (!subject) errors.push('Subject is required');

    let faculty = text(body.faculty);
    let type = text(body.type).toLowerCase();
    if (!type) type = /\b(lab|laboratory|practical)\b/i.test(subject) ? 'lab' : 'theory';

    if (isNonFacultyActivity(subject, type)) {
        if (!faculty || /^(none|nil|na|n\/a|-)$/i.test(faculty)) {
            faculty = null;
        }
        if (!['theory', 'lab', 'activity'].includes(type)) {
            type = 'activity';
        }
    } else {
        if (!faculty) errors.push('Faculty is required');
        if (!TYPES.includes(type)) errors.push(`Type must be one of: ${TYPES.join(', ')}`);
    }

    if (errors.length) return { errors };
    return { entry: { day, period, className, subject, faculty, room: text(body.room) || null, type } };
}

/** Validate references against branch context in-memory when not running against DB */
function validateEntryReferences(entry) {
    const meta = store.engine.getMeta();
    const knownClasses = meta.classes || [];
    const knownFaculty = store.engine.getFaculty() || [];
    const declaredSubjects = subjectsFromDataset();

    const missing = [];
    if (knownClasses.length && !knownClasses.some(c => c.toUpperCase() === entry.className.toUpperCase())) {
        missing.push(`class "${entry.className}"`);
    }

    if (!isNonFacultyActivity(entry.subject) && declaredSubjects.length && !declaredSubjects.some(s => s.name.toUpperCase() === entry.subject.toUpperCase())) {
        missing.push(`subject "${entry.subject}"`);
    }

    if (entry.faculty && knownFaculty.length && !knownFaculty.some(f => f.name.toUpperCase() === entry.faculty.toUpperCase())) {
        missing.push(`faculty "${entry.faculty}"`);
    }

    if (missing.length) {
        const err = new Error(`Unknown ${missing.join(', ')}`);
        err.code = 'UNKNOWN_REFERENCE';
        err.status = 400;
        err.details = missing;
        throw err;
    }
}

/** Check slot conflicts against in-memory records */
function checkMemoryConflicts(entry, excludeId = null) {
    const records = (store.normalized && store.normalized.busyRecords) || [];
    const conflicts = [];
    records.forEach(r => {
        if (r.day === entry.day && r.period === entry.period && r.id !== excludeId) {
            if (r.className && r.className.toUpperCase() === entry.className.toUpperCase()) {
                conflicts.push({
                    code: 'CLASS_BUSY',
                    message: `${entry.className} already has ${r.subject} at ${entry.day} P${entry.period}`
                });
            }
            if (entry.faculty && r.faculty && r.faculty.toUpperCase() === entry.faculty.toUpperCase()) {
                conflicts.push({
                    code: 'FACULTY_BUSY',
                    message: `${entry.faculty} already teaches ${r.subject} (${r.className}) at ${entry.day} P${entry.period}`
                });
            }
            if (entry.room && r.room && r.room.toUpperCase() === entry.room.toUpperCase()) {
                conflicts.push({
                    code: 'ROOM_BUSY',
                    message: `Room ${entry.room} is already used by ${r.className} at ${entry.day} P${entry.period}`
                });
            }
        }
    });
    if (conflicts.length) {
        const err = new Error(conflicts.map(c => c.message).join('; '));
        err.code = 'SLOT_CONFLICT';
        err.status = 400;
        err.details = conflicts;
        throw err;
    }
}

/** Map an error onto an HTTP response. */
function fail(res, err) {
    const status = err.status || 500;
    res.status(status).json({
        error: err.message,
        code: err.code || 'SERVER_ERROR',
        conflicts: err.code === 'SLOT_CONFLICT' ? err.details : undefined,
        missing: err.code === 'UNKNOWN_REFERENCE' ? err.details : undefined
    });
}

/**
 * Options for the Add Timetable form. Served from the database when it is in
 * use and from the live dataset otherwise, so the form is always populated.
 */
router.get('/reference', async (req, res, next) => {
    const engine = store.engine;
    try {
        const branchCode = req.session ? req.session.department : null;
        const branch = getBranch(branchCode);
        const fromDatabase = db.isConfigured() && store.usingDatabase;
        const [classes, subjects, rooms] = fromDatabase
            ? await Promise.all([repository.listClasses(), repository.listSubjects(), repository.listRooms()])
            : [
                classesFromDataset(),
                subjectsFromDataset(),
                [...new Set(store.normalized.busyRecords.map(r => r.room).filter(Boolean))]
                    .sort().map(code => ({ code, type: /lab/i.test(code) ? 'lab' : 'classroom' }))
            ];

        const withNames = classes.map(cls => ({
            ...cls,
            departmentName: cls.department ? departmentName(cls.department) : null
        }));

        if (branchCode && req.query.branch && req.query.branch.trim().toUpperCase() !== branchCode.toUpperCase()) {
            return res.status(403).json({ error: 'Cross-branch access is not allowed.', code: 'FORBIDDEN' });
        }

        const filterBranch = branchCode || req.query.branch || (process.env.EMPTY_TIMETABLE === 'true' ? branch.code : null);
        const branchClasses = filterBranch
            ? withNames.filter(cls => !cls.department || cls.department.toUpperCase() === filterBranch.toUpperCase())
            : withNames;
        const branchSubjects = filterBranch
            ? subjects.filter(s => !s.department || s.department.toUpperCase() === filterBranch.toUpperCase())
            : subjects;
        const branchFaculty = filterBranch
            ? engine.getFaculty().filter(f => !f.department || f.department.toUpperCase() === filterBranch.toUpperCase())
            : engine.getFaculty();

        const deptCodes = [...new Set(branchClasses.map(c => c.department).concat(branch.code).filter(Boolean))].sort();
        const branchDepts = deptCodes.map(code => ({ code, name: departmentName(code) }));

        res.json({
            days: engine.getDays(),
            periods: engine.getPeriods(),
            types: TYPES,
            classes: branchClasses,
            departments: branchDepts,
            subjects: branchSubjects,
            rooms,
            faculty: branchFaculty,
            editable: fromDatabase || store.allowMemoryWrites,
            source: fromDatabase ? 'database' : (store.allowMemoryWrites ? 'in-memory' : 'in-memory demo dataset')
        });
    } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
    try {
        const engine = store.engine;
        const filters = {};
        if (req.query.class) filters.className = String(req.query.class);
        if (req.query.faculty) filters.faculty = String(req.query.faculty);
        if (req.query.day) {
            const day = engine.normalizeDay(req.query.day);
            if (!day) return res.status(400).json({ error: `Unknown day "${req.query.day}"`, code: 'INVALID_DAY' });
            filters.day = day;
        }
        if (req.query.period) {
            const period = engine.normalizePeriod(req.query.period);
            if (period == null) {
                return res.status(400).json({ error: `Unknown period "${req.query.period}"`, code: 'INVALID_PERIOD' });
            }
            filters.period = period;
        }

        // Enforce Read Isolation for faculty
        if (req.session && req.session.role === 'faculty') {
            const sessionFaculty = req.session.facultyName || req.session.name;
            if (req.query.faculty && String(req.query.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
                return res.status(403).json({
                    error: 'Forbidden: Faculty members can only access their own timetable entries.',
                    code: 'FORBIDDEN'
                });
            }
            if (req.query.faculty_id && req.session.facultyId && String(req.query.faculty_id) !== String(req.session.facultyId)) {
                return res.status(403).json({
                    error: 'Forbidden: You cannot query another faculty_id.',
                    code: 'FORBIDDEN'
                });
            }
            if (req.query.facultyName && String(req.query.facultyName).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
                return res.status(403).json({
                    error: 'Forbidden: You cannot query another facultyName.',
                    code: 'FORBIDDEN'
                });
            }
            filters.faculty = sessionFaculty;
        }

        const sessionBranch = req.session && req.session.department ? req.session.department.toUpperCase() : null;
        if (sessionBranch) {
            filters.branch = sessionBranch;
        }

        if (db.isConfigured() && store.usingDatabase) {
            const entries = await repository.listEntries(filters);
            res.json({ count: entries.length, entries });
        } else {
            const entries = store.listEntriesInMemory(filters);
            res.json({ count: entries.length, entries });
        }
    } catch (err) { next(err); }
});

// --- /mine dedicated endpoints for faculty self-management ---
router.get('/mine', async (req, res, next) => {
    if (!req.session || req.session.role !== 'faculty') {
        return res.status(401).json({ error: 'Faculty sign-in required', code: 'UNAUTHORIZED' });
    }
    const sessionFaculty = req.session.facultyName || req.session.name;
    try {
        let entries = [];
        if (db.isConfigured() && store.usingDatabase) {
            entries = await repository.listEntries({ faculty: sessionFaculty });
        } else {
            entries = store.listEntriesInMemory({ faculty: sessionFaculty });
        }
        res.json({
            count: entries.length,
            entries,
            faculty: sessionFaculty,
            branch: req.session.department
        });
    } catch (err) { next(err); }
});

router.post('/mine', checkPostOwnership, async (req, res, next) => {
    if (!req.session || req.session.role !== 'faculty') {
        return res.status(401).json({ error: 'Faculty sign-in required', code: 'UNAUTHORIZED' });
    }
    const sessionFaculty = req.session.facultyName || req.session.name;
    const body = { ...req.body, faculty: sessionFaculty };
    const parsed = parseEntry(body);
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_ENTRY', problems: parsed.errors
        });
    }
    try {
        validateEntryReferences(parsed.entry);
        if (!db.isConfigured() || !store.usingDatabase) {
            checkMemoryConflicts(parsed.entry);
        }
    } catch (err) {
        return fail(res, err);
    }

    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const entry = await repository.addEntry(parsed.entry);
                await store.reloadFromDatabase();
                res.status(201).json({ entry, saved: true });
            } else {
                const entry = store.addEntryInMemory(parsed.entry);
                res.status(201).json({ entry, saved: true });
            }
        } catch (err) { fail(res, err); void next; }
    });
});

router.put('/mine/:id(\\d+)', checkModifyOwnership, async (req, res, next) => {
    if (!req.session || req.session.role !== 'faculty') {
        return res.status(401).json({ error: 'Faculty sign-in required', code: 'UNAUTHORIZED' });
    }
    const sessionFaculty = req.session.facultyName || req.session.name;
    const entryId = parseInt(req.params.id, 10);
    const body = { ...req.body, faculty: sessionFaculty };
    const parsed = parseEntry(body);
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_ENTRY', problems: parsed.errors
        });
    }
    try {
        validateEntryReferences(parsed.entry);
        if (!db.isConfigured() || !store.usingDatabase) {
            checkMemoryConflicts(parsed.entry, entryId);
        }
    } catch (err) {
        return fail(res, err);
    }

    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const entry = await repository.updateEntry(entryId, parsed.entry);
                await store.reloadFromDatabase();
                res.json({ entry, saved: true });
            } else {
                const entry = store.updateEntryInMemory(entryId, parsed.entry);
                res.json({ entry, saved: true });
            }
        } catch (err) { fail(res, err); void next; }
    });
});

router.delete('/mine/:id(\\d+)', checkDeleteOwnership, async (req, res, next) => {
    if (!req.session || req.session.role !== 'faculty') {
        return res.status(401).json({ error: 'Faculty sign-in required', code: 'UNAUTHORIZED' });
    }
    const entryId = parseInt(req.params.id, 10);
    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const removed = await repository.deleteEntry(entryId);
                if (!removed) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
                await store.reloadFromDatabase();
                res.json({ deleted: true, id: entryId });
            } else {
                const removed = store.deleteEntryInMemory(entryId);
                if (!removed) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
                res.json({ deleted: true, id: entryId });
            }
        } catch (err) { next(err); }
    });
});

router.get('/:id(\\d+)', async (req, res, next) => {
    try {
        const entryId = parseInt(req.params.id, 10);
        let entry = null;
        if (db.isConfigured() && store.usingDatabase) {
            entry = await repository.getEntry(entryId);
        } else {
            entry = store.getEntryInMemory(entryId);
        }
        if (!entry) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });

        if (req.session && req.session.role === 'faculty') {
            const sessionFaculty = req.session.facultyName || req.session.name;
            if (!entry.faculty || String(entry.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
                return res.status(403).json({
                    error: 'Forbidden: Faculty members can only view their own timetable entries.',
                    code: 'FORBIDDEN'
                });
            }
        }

        res.json({ entry });
    } catch (err) { next(err); }
});

function checkPostOwnership(req, res, next) {
    if (req.session && req.session.role === 'faculty') {
        const sessionFaculty = req.session.facultyName || req.session.name;
        const sessionFacId = req.session.facultyId || req.session.id;
        if (req.body && req.body.faculty && String(req.body.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Faculty members cannot create master timetable entries for another faculty.',
                code: 'FORBIDDEN'
            });
        }
        if (req.body && req.body.faculty_id && (!sessionFacId || String(req.body.faculty_id) !== String(sessionFacId))) {
            return res.status(403).json({
                error: 'Faculty members cannot create master timetable entries for another faculty.',
                code: 'FORBIDDEN'
            });
        }
        if (req.body && req.body.facultyName && String(req.body.facultyName).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Faculty members cannot create master timetable entries for another faculty.',
                code: 'FORBIDDEN'
            });
        }
        req.body.faculty = sessionFaculty;
    }
    next();
}

async function checkModifyOwnership(req, res, next) {
    if (req.session && req.session.role === 'faculty') {
        const sessionFaculty = req.session.facultyName || req.session.name;
        const sessionFacId = req.session.facultyId || req.session.id;
        const entryId = parseInt(req.params.id, 10);
        let existing = null;
        if (db.isConfigured() && store.usingDatabase) {
            existing = await repository.getEntry(entryId);
        } else {
            existing = store.getEntryInMemory(entryId);
        }
        if (!existing) {
            return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
        }
        if (!existing.faculty || String(existing.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Faculty members cannot modify another faculty member\'s master timetable entry.',
                code: 'FORBIDDEN'
            });
        }
        if (req.body && req.body.faculty && String(req.body.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Faculty members cannot reassign an entry to another faculty member.',
                code: 'FORBIDDEN'
            });
        }
        if (req.body && req.body.faculty_id && (!sessionFacId || String(req.body.faculty_id) !== String(sessionFacId))) {
            return res.status(403).json({
                error: 'Faculty members cannot reassign an entry to another faculty member.',
                code: 'FORBIDDEN'
            });
        }
        if (req.body && req.body.facultyName && String(req.body.facultyName).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Faculty members cannot reassign an entry to another faculty member.',
                code: 'FORBIDDEN'
            });
        }
        req.body.faculty = sessionFaculty;
    }
    next();
}

async function checkDeleteOwnership(req, res, next) {
    if (req.session && req.session.role === 'faculty') {
        const sessionFaculty = req.session.facultyName || req.session.name;
        const entryId = parseInt(req.params.id, 10);
        let existing = null;
        if (db.isConfigured() && store.usingDatabase) {
            existing = await repository.getEntry(entryId);
        } else {
            existing = store.getEntryInMemory(entryId);
        }
        if (!existing) {
            return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
        }
        if (!existing.faculty || String(existing.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Faculty members cannot delete another faculty member\'s master timetable entry.',
                code: 'FORBIDDEN'
            });
        }
    }
    next();
}

router.post('/slot', async (req, res, next) => {
    if (!req.session || (req.session.role !== 'hos' && req.session.role !== 'coordinator' && req.session.role !== 'admin')) {
        return res.status(403).json({
            error: 'Forbidden: Only Head of Section (HOD) can edit the official Master Timetable.',
            code: 'FORBIDDEN'
        });
    }

    const { className, day, period, subject, faculty, room, type } = req.body || {};
    if (!className || !day || period == null) {
        return res.status(400).json({
            error: 'Class, day, and period are required.',
            code: 'INVALID_SLOT'
        });
    }

    const sessionBranch = req.session && req.session.department;
    if (sessionBranch) {
        const branchClass = (store.source && store.source.classes || []).find(
            c => (c.code || c.class || '').toUpperCase() === String(className).toUpperCase()
        );
        if (branchClass && branchClass.department && branchClass.department.toUpperCase() !== sessionBranch.toUpperCase()) {
            return res.status(403).json({
                error: 'Cross-branch master timetable modification is not allowed.',
                code: 'FORBIDDEN'
            });
        }
    }

    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const result = await repository.saveSlotEntry({ className, day, period: Number(period), subject, faculty, room, type });
                await store.reloadFromDatabase();
                res.json({ success: true, ...result });
            } else {
                const result = store.saveSlotEntryInMemory({ className, day, period: Number(period), subject, faculty, room, type });
                res.json({ success: true, ...result });
            }
        } catch (err) { fail(res, err); void next; }
    });
});

router.post('/', checkPostOwnership, async (req, res, next) => {
    const parsed = parseEntry(req.body || {});
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_ENTRY', problems: parsed.errors
        });
    }
    if (req.session && req.session.role === 'faculty') {
        parsed.entry.faculty = req.session.facultyName || req.session.name;
    }
    try {
        validateEntryReferences(parsed.entry);
        if (!db.isConfigured() || !store.usingDatabase) {
            checkMemoryConflicts(parsed.entry);
        }
    } catch (err) {
        return fail(res, err);
    }

    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const entry = await repository.addEntry(parsed.entry);
                await store.reloadFromDatabase();
                res.status(201).json({ entry, saved: true });
            } else {
                const entry = store.addEntryInMemory(parsed.entry);
                res.status(201).json({ entry, saved: true });
            }
        } catch (err) { fail(res, err); void next; }
    });
});

router.put('/:id(\\d+)', checkModifyOwnership, async (req, res, next) => {
    const entryId = parseInt(req.params.id, 10);
    const parsed = parseEntry(req.body || {});
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_ENTRY', problems: parsed.errors
        });
    }
    if (req.session && req.session.role === 'faculty') {
        parsed.entry.faculty = req.session.facultyName || req.session.name;
    }
    try {
        validateEntryReferences(parsed.entry);
        if (!db.isConfigured() || !store.usingDatabase) {
            checkMemoryConflicts(parsed.entry, entryId);
        }
    } catch (err) {
        return fail(res, err);
    }

    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const entry = await repository.updateEntry(entryId, parsed.entry);
                await store.reloadFromDatabase();
                res.json({ entry, saved: true });
            } else {
                const entry = store.updateEntryInMemory(entryId, parsed.entry);
                res.json({ entry, saved: true });
            }
        } catch (err) { fail(res, err); void next; }
    });
});

router.delete('/:id(\\d+)', checkDeleteOwnership, async (req, res, next) => {
    const entryId = parseInt(req.params.id, 10);
    requireStorage(req, res, async () => {
        try {
            if (db.isConfigured() && store.usingDatabase) {
                const removed = await repository.deleteEntry(entryId);
                if (!removed) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
                await store.reloadFromDatabase();
                res.json({ deleted: true, id: entryId });
            } else {
                const removed = store.deleteEntryInMemory(entryId);
                if (!removed) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
                res.json({ deleted: true, id: entryId });
            }
        } catch (err) { next(err); }
    });
});

router.use((req, res) => {
    res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

module.exports = router;

