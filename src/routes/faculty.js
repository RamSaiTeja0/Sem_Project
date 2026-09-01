/**
 * Faculty routes — roster, per-faculty load, and adding a faculty member.
 *
 *   GET  /api/faculty                       all faculty with free/busy counts
 *   GET  /api/faculty?department=CSE        filter by department
 *   GET  /api/faculty?search=rao            filter by name
 *   GET  /api/faculty?day=Monday&period=2   adds availability at that slot
 *   GET  /api/faculty/departments           branch list with roster counts
 *   POST /api/faculty                       add a faculty member
 *
 * The read paths work on whichever backing is live, database or demo dataset.
 * The write path needs a database, for the same reason timetable edits do: a
 * faculty member who disappeared on the next restart would mislead.
 */
const express = require('express');
const router = express.Router();

const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const { DEPARTMENTS, find: findDepartment } = require('../data/departments');

const DESIGNATIONS = [
    'Professor', 'Associate Professor', 'Assistant Professor',
    'Senior Lecturer', 'Lecturer', 'Visiting Faculty'
];
const STATUSES = ['active', 'on_leave', 'inactive'];

/** Deliberately permissive: enough to catch a typo, not to police addresses. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireDatabase(req, res, next) {
    if (db.isConfigured() && store.usingDatabase) return next();
    return res.status(503).json({
        error: db.isConfigured()
            ? 'The database is configured but not currently serving the roster' +
              (store.databaseError ? ` (${store.databaseError})` : '') + '.'
            : 'Adding a faculty member needs a database. Set DATABASE_URL to your Neon ' +
              'connection string and restart. Browsing the roster still works without it.',
        code: 'DATABASE_REQUIRED'
    });
}

/**
 * The branch list. Every canonical branch is reported even when no faculty
 * belong to it yet, so a filter never hides a department that exists.
 */
router.get('/departments', async (req, res, next) => {
    try {
        const stats = store.engine.getFacultyStats();
        const counted = new Map();
        stats.forEach(f => counted.set(f.department, (counted.get(f.department) || 0) + 1));

        let details;
        if (db.isConfigured() && store.usingDatabase) {
            const rows = await repository.listDepartments();
            details = rows.map(row => ({
                code: row.code,
                name: row.name,
                // The live roster is the authority on how many are loaded now.
                facultyCount: counted.has(row.code) ? counted.get(row.code) : row.facultyCount
            }));
        } else {
            details = DEPARTMENTS.map(d => ({
                code: d.code, name: d.name, facultyCount: counted.get(d.code) || 0
            }));
        }

        // Anything on the roster that is not a known branch is still listed,
        // rather than being silently unfilterable.
        counted.forEach((facultyCount, code) => {
            if (!details.some(d => d.code === code)) {
                details.push({ code, name: code, facultyCount });
            }
        });
        details.sort((a, b) => a.code.localeCompare(b.code));

        res.json({ departments: details.map(d => d.code), details });
    } catch (err) { next(err); }
});

router.get('/designations', (req, res) => {
    res.json({ designations: DESIGNATIONS, statuses: STATUSES });
});

router.get('/', (req, res) => {
    const engine = store.engine;
    const { department, search, day, period } = req.query;

    const options = {};
    if (day || period) {
        const resolvedDay = engine.normalizeDay(day);
        if (!resolvedDay) {
            return res.status(400).json({ error: `Unknown day "${day}"`, code: 'INVALID_DAY' });
        }
        const resolvedPeriod = engine.normalizePeriod(period);
        if (resolvedPeriod == null) {
            return res.status(400).json({ error: `Unknown period "${period}"`, code: 'INVALID_PERIOD' });
        }
        options.day = resolvedDay;
        options.period = resolvedPeriod;
    }

    let stats = engine.getFacultyStats(options);

    if (department) {
        const wanted = String(department).trim().toUpperCase();
        stats = stats.filter(f => (f.department || '').toUpperCase() === wanted);
    }
    if (search) {
        const needle = String(search).trim().toUpperCase();
        stats = stats.filter(f =>
            f.name.toUpperCase().includes(needle) ||
            f.id.toUpperCase().includes(needle) ||
            (f.email || '').toUpperCase().includes(needle) ||
            (f.designation || '').toUpperCase().includes(needle));
    }

    res.json({ count: stats.length, faculty: stats, slot: options.day ? options : null });
});

/**
 * Validate a submitted faculty member, reporting every problem at once.
 * @returns {{ member }} or {{ errors: string[] }}
 */
function parseFaculty(body) {
    const text = value => (value == null ? '' : String(value).trim());
    const errors = [];

    const id = text(body.id || body.facultyId);
    if (!id) errors.push('Faculty ID is required');
    else if (!/^[A-Za-z0-9._-]{2,20}$/.test(id)) {
        errors.push('Faculty ID may use letters, digits, dot, dash and underscore (2–20 characters)');
    }

    const name = text(body.name);
    if (!name) errors.push('Faculty name is required');
    else if (name.length < 3) errors.push('Faculty name is too short');

    const department = text(body.department).toUpperCase();
    if (!department) errors.push('Department is required');
    else if (!findDepartment(department)) {
        errors.push(`Unknown department "${department}". Valid: ${DEPARTMENTS.map(d => d.code).join(', ')}`);
    }

    const email = text(body.email);
    if (email && !EMAIL_PATTERN.test(email)) errors.push(`"${email}" is not a valid email address`);

    const designation = text(body.designation) || null;
    const phone = text(body.phone) || null;

    let maxWeeklyPeriods = null;
    if (text(body.maxWeeklyPeriods)) {
        maxWeeklyPeriods = parseInt(body.maxWeeklyPeriods, 10);
        if (!Number.isFinite(maxWeeklyPeriods) || maxWeeklyPeriods < 1 || maxWeeklyPeriods > 60) {
            errors.push('Maximum weekly periods must be a number between 1 and 60');
        }
    }

    const status = text(body.status).toLowerCase() || 'active';
    if (!STATUSES.includes(status)) errors.push(`Status must be one of: ${STATUSES.join(', ')}`);

    if (errors.length) return { errors };
    return {
        member: { id, name, department, designation, email: email || null, phone, maxWeeklyPeriods, status }
    };
}

router.post('/', requireDatabase, async (req, res, next) => {
    const parsed = parseFaculty(req.body || {});
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_FACULTY', problems: parsed.errors
        });
    }
    try {
        const created = await repository.addFaculty(parsed.member);
        // Rebuild the live dataset so the new member is immediately visible to
        // the roster, the availability engine and the timetable form.
        await store.reloadFromDatabase();
        res.status(201).json({ faculty: created, saved: true });
    } catch (err) {
        if (err.status) {
            return res.status(err.status).json({
                error: err.message, code: err.code, problems: err.details || undefined
            });
        }
        next(err);
    }
});

module.exports = router;
