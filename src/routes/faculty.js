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
const { DEPARTMENTS, getBranch, find: findDepartment, list: listBranches } = require('../data/departments');
const users = require('../data/users');
const { validatePhone } = require('../core/authSecurity');

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
            const valid = rows.map(r => r.code ? String(r.code).toUpperCase() : null).filter(Boolean);
            if (valid.length) return valid;
        } catch (err) {
            // Fall through to the bundled list rather than blocking the write.
        }
    }
    const codes = new Set(DEPARTMENTS.map(d => d.code ? String(d.code).toUpperCase() : null).filter(Boolean));
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
        if (branch && branch.configured && branch.code) {
            const stats = store.engine ? store.engine.getFacultyStats() : [];
            const count = stats.filter(f => !f.department || String(f.department).toUpperCase() === branch.code).length;

            const details = [{
                code: branch.code,
                name: branch.name,
                facultyCount: count
            }];

            return res.json({ count: details.length, departments: [branch.code], details });
        }

        const stats = store.engine ? store.engine.getFacultyStats() : [];
        const counted = new Map();
        stats.forEach(f => {
            if (f.department) {
                counted.set(String(f.department).toUpperCase(), (counted.get(String(f.department).toUpperCase()) || 0) + 1);
            }
        });

        const registered = listBranches ? listBranches() : [];
        let details = [];
        if (registered.length > 0) {
            details = registered.map(b => ({
                code: b.code,
                name: b.name,
                facultyCount: counted.get(b.code) || 0
            }));
        } else if (db.isConfigured && db.isConfigured() && store.usingDatabase) {
            const rows = await repository.listDepartments();
            details = rows.map(row => ({
                code: row.code,
                name: row.name,
                facultyCount: counted.has(row.code) ? counted.get(row.code) : (row.facultyCount || 0)
            }));
        }

        counted.forEach((facultyCount, code) => {
            if (code && !details.some(d => d.code === code)) {
                details.push({ code, name: code, facultyCount });
            }
        });

        res.json({ count: details.length, departments: details.map(d => d.code), details });
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

function findFacultyMember(engine, id) {
    if (!engine || !id) return null;
    const needle = String(id).trim().toUpperCase();
    const roster = engine.getFaculty();
    return roster.find(f =>
        (f.id && String(f.id).toUpperCase() === needle) ||
        (f.code && String(f.code).toUpperCase() === needle) ||
        (f.name && f.name.toUpperCase() === needle)
    );
}

function requireHOSUser(req, res, next) {
    if (!req.session) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in.',
            code: 'UNAUTHENTICATED'
        });
    }
    if (req.session.role === 'faculty') {
        return res.status(403).json({
            error: 'Faculty members cannot perform HOS faculty-management operations.',
            code: 'FORBIDDEN'
        });
    }
    if (!['hos', 'coordinator', 'admin'].includes(req.session.role)) {
        return res.status(403).json({
            error: 'This action requires HOS or Administrator role.',
            code: 'FORBIDDEN'
        });
    }
    next();
}

/**
 * GET /api/faculty/:id — detailed profile of a single faculty member
 */
router.get('/:id', async (req, res) => {
    const targetId = req.params.id;
    const engine = store.engine;
    let member = findFacultyMember(engine, targetId);

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }

    if (!member) {
        return res.status(404).json({ error: `Faculty "${targetId}" not found.`, code: 'NOT_FOUND' });
    }

    const sessionDept = req.session && req.session.department ? String(req.session.department).trim().toUpperCase() : null;
    if (sessionDept && member.department && member.department.toUpperCase() !== sessionDept) {
        return res.status(403).json({
            error: `Cross-branch queries are not allowed. Faculty belongs to ${member.department}, but current branch is ${sessionDept}.`,
            code: 'FORBIDDEN'
        });
    }

    res.json({ faculty: member });
});

/**
 * PUT /api/faculty/:id — HOS edits faculty belonging to their branch
 * Editable: Name, Phone, Designation, Subjects
 * Protected: ID, Branch, Username, Password
 */
router.put('/:id', requireHOSUser, async (req, res) => {
    const targetId = req.params.id;
    const engine = store.engine;
    const sessionDept = req.session.department ? String(req.session.department).trim().toUpperCase() : null;

    let member = findFacultyMember(engine, targetId);
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }

    if (!member) {
        return res.status(404).json({ error: `Faculty "${targetId}" not found.`, code: 'NOT_FOUND' });
    }

    // Branch Security: HOS can manage only their own branch faculty
    if (sessionDept && member.department && member.department.toUpperCase() !== sessionDept) {
        return res.status(403).json({
            error: `Cross-branch faculty management is not allowed. Faculty belongs to ${member.department}, but current branch is ${sessionDept}.`,
            code: 'FORBIDDEN'
        });
    }

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (name.length < 2) {
            return res.status(400).json({ error: 'Faculty name must be at least 2 characters.', code: 'INVALID_NAME' });
        }
        updates.name = name;
    }

    if (body.phone !== undefined) {
        const phone = String(body.phone || '').trim();
        if (phone && !validatePhone(phone)) {
            return res.status(400).json({ error: 'A valid phone number is required.', code: 'INVALID_PHONE' });
        }
        updates.phone = phone || null;
    }

    if (body.designation !== undefined) {
        updates.designation = String(body.designation || '').trim() || null;
    }

    if (body.subjects !== undefined) {
        const rawSubjects = Array.isArray(body.subjects)
            ? body.subjects
            : String(body.subjects || '').split(',').map(s => s.trim()).filter(Boolean);
        const cleaned = rawSubjects.map(s => String(s).trim()).filter(Boolean);
        if (cleaned.length === 0) {
            return res.status(400).json({ error: 'At least one subject or area of expertise is required.', code: 'SUBJECTS_REQUIRED' });
        }
        updates.subjects = cleaned;
    }

    if (body.maxWeeklyPeriods !== undefined) {
        const mwp = parseInt(body.maxWeeklyPeriods, 10);
        if (!Number.isFinite(mwp) || mwp < 1 || mwp > 60) {
            return res.status(400).json({ error: 'Maximum weekly periods must be between 1 and 60.', code: 'INVALID_MAX_PERIODS' });
        }
        updates.maxWeeklyPeriods = mwp;
    }

    try {
        let updated = null;
        if (db.isConfigured() && store.usingDatabase) {
            updated = await repository.updateFaculty(member.id || targetId, sessionDept, updates);
            await store.reloadFromDatabase();
        } else {
            updated = store.updateFacultyInMemory(member.id || targetId, updates);
        }

        // Sync with registered users account
        users.updateFacultyUser(member.id || targetId, updates);

        res.json({
            success: true,
            faculty: {
                id: updated.id || member.id,
                name: updated.name,
                department: updated.department || member.department,
                designation: updated.designation,
                phone: updated.phone,
                email: updated.email,
                subjects: updated.subjects || updates.subjects || [],
                status: updated.status || member.status || 'active',
                maxWeeklyPeriods: updated.maxWeeklyPeriods
            }
        });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message, code: err.code || 'UPDATE_FAILED' });
    }
});

/**
 * POST /api/faculty/:id/deactivate — HOS safely deactivates faculty
 */
router.post('/:id/deactivate', requireHOSUser, async (req, res) => {
    const targetId = req.params.id;
    const engine = store.engine;
    const sessionDept = req.session.department ? String(req.session.department).trim().toUpperCase() : null;

    let member = findFacultyMember(engine, targetId);
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }

    if (!member) {
        return res.status(404).json({ error: `Faculty "${targetId}" not found.`, code: 'NOT_FOUND' });
    }

    if (sessionDept && member.department && member.department.toUpperCase() !== sessionDept) {
        return res.status(403).json({
            error: `Cross-branch faculty management is not allowed. Faculty belongs to ${member.department}, but current branch is ${sessionDept}.`,
            code: 'FORBIDDEN'
        });
    }

    try {
        if (db.isConfigured() && store.usingDatabase) {
            await repository.deactivateFaculty(member.id || targetId, sessionDept);
            await store.reloadFromDatabase();
        } else {
            store.setFacultyStatusInMemory(member.id || targetId, 'inactive');
        }

        users.updateFacultyUser(member.id || targetId, { status: 'inactive' });

        res.json({
            success: true,
            message: `Faculty ${member.name} has been safely deactivated.`,
            id: member.id || targetId,
            name: member.name,
            status: 'inactive'
        });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message, code: err.code || 'DEACTIVATION_FAILED' });
    }
});

/**
 * POST /api/faculty/:id/activate — HOS reactivates inactive faculty
 */
router.post('/:id/activate', requireHOSUser, async (req, res) => {
    const targetId = req.params.id;
    const engine = store.engine;
    const sessionDept = req.session.department ? String(req.session.department).trim().toUpperCase() : null;

    let member = findFacultyMember(engine, targetId);
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }

    if (!member) {
        return res.status(404).json({ error: `Faculty "${targetId}" not found.`, code: 'NOT_FOUND' });
    }

    if (sessionDept && member.department && member.department.toUpperCase() !== sessionDept) {
        return res.status(403).json({
            error: `Cross-branch faculty management is not allowed. Faculty belongs to ${member.department}, but current branch is ${sessionDept}.`,
            code: 'FORBIDDEN'
        });
    }

    try {
        if (db.isConfigured() && store.usingDatabase) {
            await repository.activateFaculty(member.id || targetId, sessionDept);
            await store.reloadFromDatabase();
        } else {
            store.setFacultyStatusInMemory(member.id || targetId, 'active');
        }

        users.updateFacultyUser(member.id || targetId, { status: 'active' });

        res.json({
            success: true,
            message: `Faculty ${member.name} has been reactivated.`,
            id: member.id || targetId,
            name: member.name,
            status: 'active'
        });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message, code: err.code || 'ACTIVATION_FAILED' });
    }
});

module.exports = router;

