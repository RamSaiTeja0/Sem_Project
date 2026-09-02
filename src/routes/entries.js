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
 * Writes require a configured database: an edit that vanished on restart would
 * be worse than refusing it, so with no DATABASE_URL these endpoints answer 503
 * and say what is missing. The read paths and the availability engine keep
 * working on the demo dataset regardless.
 *
 * Every write is validated twice — once here against the live timetable (so all
 * conflicts can be reported together) and once by the UNIQUE constraints in
 * schema.sql, which are what actually guarantee no double-booking.
 */
const express = require('express');
const router = express.Router();

const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const { DEPARTMENTS, nameFor: departmentName } = require('../data/departments');

const TYPES = ['theory', 'lab'];

/**
 * Class records from the live dataset, used when no database is serving.
 * The source keeps each class's department, semester and academic year, so the
 * form can show and filter on them either way.
 */
function classesFromDataset() {
    const declared = (store.source && store.source.classes) || [];
    return store.engine.getMeta().classes.map(code => {
        const match = declared.find(c => (c.class || c.name) === code) || {};
        return {
            code,
            department: match.department || null,
            semester: match.semester || null,
            academicYear: match.academicYear || null,
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

/** Writes need a database; reads of reference data do not. */
function requireDatabase(req, res, next) {
    if (db.isConfigured() && store.usingDatabase) return next();
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

    const faculty = text(body.faculty);
    if (!faculty) errors.push('Faculty is required');

    const room = text(body.room) || null;

    let type = text(body.type).toLowerCase();
    if (!type) type = /\b(lab|laboratory|practical)\b/i.test(subject) ? 'lab' : 'theory';
    if (!TYPES.includes(type)) errors.push(`Type must be one of: ${TYPES.join(', ')}`);

    if (errors.length) return { errors };
    return { entry: { day, period, className, subject, faculty, room, type } };
}

/** Map a repository error onto an HTTP response. */
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
    const meta = engine.getMeta();
    try {
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

        const deptCodes = [...new Set([
            ...DEPARTMENTS.map(d => d.code),
            ...withNames.map(c => c.department).filter(Boolean),
            ...subjects.map(s => s.department).filter(Boolean)
        ])].sort();

        res.json({
            days: engine.getDays(),
            periods: engine.getPeriods(),
            types: TYPES,
            classes: withNames,
            departments: deptCodes.map(code => ({ code, name: departmentName(code) })),
            subjects,
            rooms,
            faculty: engine.getFaculty(),
            editable: fromDatabase,
            source: fromDatabase ? 'database' : 'in-memory demo dataset'
        });
    } catch (err) { next(err); }
});

router.get('/', requireDatabase, async (req, res, next) => {
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
        const entries = await repository.listEntries(filters);
        res.json({ count: entries.length, entries });
    } catch (err) { next(err); }
});

router.get('/:id(\\d+)', requireDatabase, async (req, res, next) => {
    try {
        const entry = await repository.getEntry(parseInt(req.params.id, 10));
        if (!entry) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
        res.json({ entry });
    } catch (err) { next(err); }
});

router.post('/', requireDatabase, async (req, res, next) => {
    const parsed = parseEntry(req.body || {});
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_ENTRY', problems: parsed.errors
        });
    }
    try {
        const entry = await repository.addEntry(parsed.entry);
        await store.reloadFromDatabase();
        res.status(201).json({ entry, saved: true });
    } catch (err) { fail(res, err); void next; }
});

router.put('/:id(\\d+)', requireDatabase, async (req, res, next) => {
    const parsed = parseEntry(req.body || {});
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_ENTRY', problems: parsed.errors
        });
    }
    try {
        const entry = await repository.updateEntry(parseInt(req.params.id, 10), parsed.entry);
        await store.reloadFromDatabase();
        res.json({ entry, saved: true });
    } catch (err) { fail(res, err); void next; }
});

router.delete('/:id(\\d+)', requireDatabase, async (req, res, next) => {
    try {
        const removed = await repository.deleteEntry(parseInt(req.params.id, 10));
        if (!removed) return res.status(404).json({ error: 'No such timetable entry', code: 'NOT_FOUND' });
        await store.reloadFromDatabase();
        res.json({ deleted: true, id: parseInt(req.params.id, 10) });
    } catch (err) { next(err); }
});

router.use((req, res) => {
    res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

module.exports = router;
