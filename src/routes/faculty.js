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
const { DEPARTMENTS, getBranch, find: findDepartment } = require('../data/departments');

const DESIGNATIONS = [
    'Professor', 'Associate Professor', 'Assistant Professor',
    'Senior Lecturer', 'Lecturer', 'Visiting Faculty'
];
const STATUSES = ['active', 'on_leave', 'inactive'];

/** Deliberately permissive: enough to catch a typo, not to police addresses. */
/**
 * Branch codes that currently exist — from the database when one is serving,
 * otherwise the bundled list plus anything already on the roster. Read live so
 * a branch created through /api/branches is usable immediately, with no code
 * change and no restart.
 */
async function knownBranchCodes() {
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const rows = await repository.listDepartments();
            if (rows.length) return rows.map(r => String(r.code).toUpperCase());
        } catch (err) {
            // Fall through to the bundled list rather than blocking the write.
        }
    }
    const codes = new Set(DEPARTMENTS.map(d => d.code.toUpperCase()));
    store.engine.getFaculty().forEach(f => {
        if (f.department) codes.add(String(f.department).toUpperCase());
    });
    return [...codes];
}

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
        const branchCode = req.session ? req.session.department : null;
        const branch = getBranch(branchCode);
        if (!branch || !branch.configured || !branch.code) {
            return res.json({ count: 0, departments: [], details: [] });
        }
        const stats = store.engine ? store.engine.getFacultyStats() : [];
        const count = stats.filter(f => !f.department || String(f.department).toUpperCase() === branch.code).length;

        const details = [{
            code: branch.code,
            name: branch.name,
            facultyCount: count
        }];

        res.json({ count: details.length, departments: [branch.code], details });
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

    const sessionDept = req.session && req.session.department ? String(req.session.department).trim().toUpperCase() : null;
    const queryDept = department ? String(department).trim().toUpperCase() : null;

    if (sessionDept) {
        if (queryDept && queryDept !== sessionDept) {
            return res.status(403).json({
                error: `Cross-branch queries are not allowed. Current branch is ${sessionDept}.`,
                code: 'FORBIDDEN'
            });
        }
        stats = stats.filter(f => (f.department || '').toUpperCase() === sessionDept);
    } else if (queryDept) {
        stats = stats.filter(f => (f.department || '').toUpperCase() === queryDept);
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
function parseFaculty(body, knownCodes) {
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

    const branch = getBranch();
    const department = text(body.department || branch.code).toUpperCase();
    if (!department) errors.push('Department is required');
    else if (!knownCodes.includes(department) && department !== branch.code) {
        errors.push(`Unknown department "${department}". Valid: ${knownCodes.join(', ')}`);
    }

    const email = text(body.email);
    if (email && !EMAIL_PATTERN.test(email)) errors.push(`"${email}" is not a valid email address`);

    const designation = text(body.designation) || null;
    const phone = text(body.phone) || null;
    if (phone && !/^[+0-9\s\-()]{7,25}$/.test(phone)) {
        errors.push(`"${phone}" is not a valid phone number`);
    }

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

function requireHOS(req, res, next) {
    if (req.session && req.session.role === 'faculty') {
        return res.status(403).json({
            error: 'Faculty members cannot register new faculty. This action requires HOS / Administrator role.',
            code: 'FORBIDDEN'
        });
    }
    next();
}

router.post('/', requireHOS, requireDatabase, async (req, res, next) => {
    const parsed = parseFaculty(req.body || {}, await knownBranchCodes());
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
