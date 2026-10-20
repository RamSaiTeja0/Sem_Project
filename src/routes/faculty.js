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

router.get('/', async (req, res, next) => {
    try {
        const engine = store.engine;
        const { department, branch, search, day, period } = req.query;
        const targetDept = department || branch;

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
        const queryDept = targetDept ? String(targetDept).trim().toUpperCase() : null;

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
                (f.id && String(f.id).toUpperCase().includes(needle)) ||
                (f.email || '').toUpperCase().includes(needle) ||
                (f.designation || '').toUpperCase().includes(needle));
        }

        // Relational user account resolution
        let dbUsersMap = new Map();
        if (db.isConfigured()) {
            try {
                const { rows } = await db.query(`
                    SELECT u.id, u.username, u.name, u.role, u.status, u.active, u.phone, u.faculty_id,
                           f.id AS faculty_db_id, f.code AS faculty_code, f.name AS faculty_name,
                           COALESCE(d.code, d_fac.code, '') AS branch
                      FROM users u
                     INNER JOIN faculty f ON f.id = u.faculty_id
                      LEFT JOIN departments d ON d.id = u.department_id
                      LEFT JOIN departments d_fac ON d_fac.id = f.department_id
                     WHERE u.role = 'faculty'
                       AND (u.status IS NULL OR u.status <> 'rejected')
                `);
                for (const u of rows) {
                    if (u.faculty_id != null) {
                        dbUsersMap.set(String(u.faculty_id), u);
                        dbUsersMap.set('id:' + String(u.faculty_id), u);
                    }
                    if (u.faculty_code) {
                        const codeUpper = String(u.faculty_code).trim().toUpperCase();
                        dbUsersMap.set(codeUpper, u);
                        dbUsersMap.set('code:' + codeUpper, u);
                    }
                }
            } catch (_) {}
        }

        const registeredUsers = (typeof users.listRegisteredUsersOnly === 'function'
            ? users.listRegisteredUsersOnly()
            : (typeof users.list === 'function' ? users.list() : [])) || [];

        stats = stats.map(f => {
            let matchedUser = null;
            const facIdStr = f.id != null ? String(f.id).trim() : '';
            const facCodeStr = (f.code != null ? String(f.code).trim().toUpperCase() : '') ||
                (f.id && isNaN(Number(f.id)) ? String(f.id).trim().toUpperCase() : '');
            const facNumericId = f.numeric_id != null
                ? String(f.numeric_id)
                : (/^\d+$/.test(facIdStr) ? facIdStr : null);
            const facBranchStr = (f.department || f.branch || '').trim().toUpperCase();

            // 1. Check DB map using direct relational identifiers
            if (facNumericId && dbUsersMap.has(facNumericId)) {
                matchedUser = dbUsersMap.get(facNumericId);
            } else if (facIdStr && dbUsersMap.has(facIdStr)) {
                matchedUser = dbUsersMap.get(facIdStr);
            } else if (facCodeStr && dbUsersMap.has(facCodeStr)) {
                matchedUser = dbUsersMap.get(facCodeStr);
            }

            // 2. Check in-memory registered users by explicit facultyId / facultyCode (NOT display name)
            if (!matchedUser) {
                matchedUser = registeredUsers.find(u => {
                    if (u.role !== 'faculty' || u.status === 'rejected') return false;
                    const uBranch = (u.department || u.branchName || '').trim().toUpperCase();
                    if (facBranchStr && uBranch && uBranch !== facBranchStr) return false;

                    const uFacId = u.facultyId != null ? String(u.facultyId).trim() : '';
                    const uFacCode = u.facultyCode != null ? String(u.facultyCode).trim().toUpperCase() : '';

                    if (facNumericId && uFacId && uFacId === facNumericId) return true;
                    if (facIdStr && uFacId && uFacId.toUpperCase() === facIdStr.toUpperCase()) return true;
                    if (facCodeStr && uFacCode && uFacCode === facCodeStr) return true;
                    if (facCodeStr && uFacId && uFacId.toUpperCase() === facCodeStr) return true;
                    return false;
                });
            }

            const hasAccount = Boolean(matchedUser);
            const isInactive = (f.status === 'inactive') ||
                (matchedUser && (matchedUser.status === 'inactive' || matchedUser.active === false));

            return {
                ...f,
                hasAccount,
                status: isInactive ? 'inactive' : (f.status || 'active'),
                phone: (matchedUser && matchedUser.phone) ? matchedUser.phone : f.phone,
                dbId: matchedUser ? (matchedUser.faculty_id || matchedUser.faculty_db_id || matchedUser.facultyId || null) : (f.dbId || f.numeric_id || null),
                account: matchedUser ? {
                    id: matchedUser.id,
                    username: matchedUser.username,
                    name: matchedUser.name,
                    role: matchedUser.role || 'faculty',
                    status: matchedUser.status || 'active',
                    phone: matchedUser.phone || null
                } : null,
                username: matchedUser ? matchedUser.username : null
            };
        });

        if (req.query.accountOnly === 'true' || req.query.hasAccount === 'true' || req.query.availability === 'true') {
            stats = stats.filter(f => f.hasAccount && f.account && f.account.role === 'faculty' && f.account.status === 'active' && f.status === 'active');
        }

        res.json({ count: stats.length, faculty: stats, slot: options.day ? options : null });
    } catch (err) {
        next(err);
    }
});

/**
 * Validate a submitted faculty member, reporting every problem at once.
 * @returns {{ member }} or {{ errors: string[] }}
 */
function parseFaculty(body, knownCodes, defaultBranch = null) {
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

    const branch = getBranch(defaultBranch);
    const department = text(body.department || (branch ? branch.code : '')).toUpperCase();
    if (!department) errors.push('Department is required');
    else if (!knownCodes.includes(department) && (!branch || department !== branch.code)) {
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

const delegations = require('../data/delegations');

async function requireHOS(req, res, next) {
    if (!req.session) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in.',
            code: 'UNAUTHENTICATED'
        });
    }
    const isAuthorizedHOS = req.session.role === 'hos' || req.session.role === 'coordinator' || await delegations.isAuthorizedHOS(req.session);
    if (!isAuthorizedHOS) {
        return res.status(403).json({
            error: 'Faculty members cannot register new faculty. This action requires HOS / Administrator role.',
            code: 'FORBIDDEN'
        });
    }
    next();
}

router.post('/', requireDatabase, requireHOS, async (req, res, next) => {
    const sessionBranch = req.session ? (req.session.department || req.session.branchCode) : null;
    const parsed = parseFaculty(req.body || {}, await knownBranchCodes(), sessionBranch);
    if (parsed.errors) {
        return res.status(400).json({
            error: parsed.errors.join('; '), code: 'INVALID_FACULTY', problems: parsed.errors
        });
    }
    if (sessionBranch && req.session.role !== 'admin' && parsed.member) {
        parsed.member.department = sessionBranch;
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
    if (!id) return null;
    const needle = String(id).trim().toUpperCase();
    if (engine && typeof engine.getFaculty === 'function') {
        const roster = engine.getFaculty();
        const found = roster.find(f =>
            (f.id && String(f.id).toUpperCase() === needle) ||
            (f.code && String(f.code).toUpperCase() === needle) ||
            (f.name && f.name.toUpperCase() === needle)
        );
        if (found) return found;
    }
    const allUsers = users.list ? users.list() : [];
    const u = allUsers.find(user => String(user.id) === String(id) || (user.username && String(user.username).toUpperCase() === needle));
    if (u) {
        const fid = u.facultyId || u.faculty_id;
        if (engine && typeof engine.getFaculty === 'function') {
            const match = engine.getFaculty().find(f =>
                (fid && String(f.id).toUpperCase() === String(fid).toUpperCase()) ||
                (f.name && String(f.name).toUpperCase() === String(u.name).toUpperCase())
            );
            if (match) return match;
        }
        return {
            id: fid || u.id,
            name: u.name,
            department: u.department,
            status: u.status || 'active'
        };
    }
    return null;
}

async function requireHOSUser(req, res, next) {
    if (!req.session) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in.',
            code: 'UNAUTHENTICATED'
        });
    }
    const isAuthorizedHOS = req.session.role === 'hos' || req.session.role === 'coordinator' || await delegations.isAuthorizedHOS(req.session);
    if (!isAuthorizedHOS) {
        return res.status(403).json({
            error: 'Faculty members cannot perform HOS faculty-management operations.',
            code: 'FORBIDDEN'
        });
    }
    next();
}

/**
 * GET /api/faculty/departures — audit history of faculty deactivations and departures
 */
router.get('/departures', requireHOSUser, async (req, res, next) => {
    try {
        const sessionDept = req.session && req.session.department ? String(req.session.department).trim().toUpperCase() : (req.query.branch || null);
        let departures = [];
        if (db.isConfigured()) {
            try {
                departures = await repository.listFacultyDepartures(sessionDept);
            } catch (_) {}
        }
        if (!departures || departures.length === 0) {
            departures = users.listFacultyDeparturesInMemory(sessionDept);
        }
        res.json({ success: true, count: departures.length, departures });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/faculty/:id — detailed profile of a single faculty member
 */
router.get('/:id', async (req, res) => {
    const targetId = req.params.id;
    const engine = store.engine;
    let member = null;

    if (db.isConfigured()) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }
    if (!member) {
        member = findFacultyMember(engine, targetId);
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

    let member = null;
    if (db.isConfigured()) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }
    if (!member) {
        member = findFacultyMember(engine, targetId);
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
 * POST /api/faculty/:id/deactivate — HOS safely deactivates faculty / processes faculty leaving college
 */
router.post('/:id/deactivate', requireHOSUser, async (req, res) => {
    const targetId = req.params.id;
    const engine = store.engine;
    const sessionDept = req.session && req.session.department ? String(req.session.department).trim().toUpperCase() : null;

    let member = null;
    if (db.isConfigured()) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }
    if (!member) {
        member = findFacultyMember(engine, targetId);
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

    // Prohibit self-deactivation
    const sessionUsername = req.session ? String(req.session.username || '').toLowerCase() : '';
    const sessionId = req.session ? String(req.session.id || '') : '';
    const sessionFacId = req.session ? String(req.session.facultyId || '') : '';
    const targetIdStr = String(targetId).trim().toLowerCase();
    const memberIdStr = member.id != null ? String(member.id).trim().toLowerCase() : '';
    const memberCodeStr = member.code != null ? String(member.code).trim().toLowerCase() : '';
    const memberUsernameStr = member.username ? String(member.username).trim().toLowerCase() : '';

    if (
        (sessionUsername && (sessionUsername === targetIdStr || sessionUsername === memberUsernameStr)) ||
        (sessionId && (sessionId === targetIdStr || (member.userId && String(member.userId) === sessionId))) ||
        (sessionFacId && (sessionFacId === targetIdStr || sessionFacId === memberIdStr || sessionFacId === memberCodeStr))
    ) {
        return res.status(400).json({
            error: 'You cannot deactivate your own account.',
            code: 'SELF_DEACTIVATION_PROHIBITED'
        });
    }

    // Special Case: Cannot deactivate faculty holding HOD role without role handover
    const allUsers = (typeof users.list === 'function' ? users.list() : []) || [];
    const targetUser = allUsers.find(u =>
        (u.facultyId && (String(u.facultyId).toLowerCase() === targetIdStr || String(u.facultyId).toLowerCase() === memberIdStr || String(u.facultyId).toLowerCase() === memberCodeStr)) ||
        (u.id && String(u.id).toLowerCase() === targetIdStr) ||
        (u.username && (u.username.toLowerCase() === targetIdStr || u.username.toLowerCase() === memberUsernameStr)) ||
        (u.name && u.name.toUpperCase() === member.name.toUpperCase())
    );

    if (targetUser && (targetUser.role === 'hos' || targetUser.role === 'coordinator')) {
        return res.status(400).json({
            error: `Cannot deactivate faculty "${member.name}" because they currently hold the HOD role for branch "${member.department}". HOD authority must be transferred using the HOD Leaving College workflow before deactivation.`,
            code: 'HOD_DEACTIVATION_REQUIRES_HANDOVER'
        });
    }

    const body = req.body || {};
    const effectiveDate = body.effectiveDate ? String(body.effectiveDate).trim() : new Date().toISOString().slice(0, 10);
    const reason = body.reason ? String(body.reason).trim() : null;

    try {
        let deactResult = null;
        if (db.isConfigured()) {
            try {
                deactResult = await repository.deactivateFaculty(member.id || targetId, sessionDept, {
                    effectiveDate,
                    reason,
                    performedByUserId: req.session ? req.session.id : null,
                    performedByName: req.session ? (req.session.name || req.session.username) : 'HOD'
                });
                if (store.usingDatabase) {
                    await store.reloadFromDatabase();
                } else {
                    try { store.setFacultyStatusInMemory(member.id || targetId, 'inactive'); } catch (_) {}
                }
            } catch (dbErr) {
                if (dbErr.code === 'HOD_DEACTIVATION_REQUIRES_HANDOVER' || dbErr.code === 'SELF_DEACTIVATION_PROHIBITED' || dbErr.code === 'FORBIDDEN') {
                    throw dbErr;
                }
                // If not found in DB or DB error, fallback to in-memory
                try { store.setFacultyStatusInMemory(member.id || targetId, 'inactive'); } catch (_) {}
                users.recordFacultyDepartureInMemory({
                    facultyId: member.id || targetId,
                    facultyCode: member.code || String(member.id || targetId),
                    facultyName: member.name,
                    userId: targetUser ? targetUser.id : null,
                    username: targetUser ? targetUser.username : (member.username || null),
                    branchCode: member.department || sessionDept || 'General',
                    effectiveDate,
                    reason,
                    previousStatus: member.status || 'active',
                    deactivatedByUserId: req.session ? req.session.id : null,
                    deactivatedByName: req.session ? (req.session.name || req.session.username) : 'HOD'
                });
            }
        } else {
            try { store.setFacultyStatusInMemory(member.id || targetId, 'inactive'); } catch (_) {}
            users.recordFacultyDepartureInMemory({
                facultyId: member.id || targetId,
                facultyCode: member.code || String(member.id || targetId),
                facultyName: member.name,
                userId: targetUser ? targetUser.id : null,
                username: targetUser ? targetUser.username : (member.username || null),
                branchCode: member.department || sessionDept || 'General',
                effectiveDate,
                reason,
                previousStatus: member.status || 'active',
                deactivatedByUserId: req.session ? req.session.id : null,
                deactivatedByName: req.session ? (req.session.name || req.session.username) : 'HOD'
            });
        }

        if (targetUser && targetUser.username) {
            users.updateFacultyUser(targetUser.username, { status: 'inactive', active: false });
        }
        users.updateFacultyUser(member.id || targetId, { status: 'inactive', active: false });

        res.json({
            success: true,
            message: `Faculty ${member.name} has been safely deactivated.`,
            id: member.id || targetId,
            name: member.name,
            status: 'inactive',
            effectiveDate,
            reason
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

    let member = null;
    if (db.isConfigured()) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (err) {}
    }
    if (!member) {
        member = findFacultyMember(engine, targetId);
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
        } else if (db.isConfigured()) {
            await repository.activateFaculty(member.id || targetId, sessionDept);
            try { store.setFacultyStatusInMemory(member.id || targetId, 'active'); } catch (_) {}
        } else {
            store.setFacultyStatusInMemory(member.id || targetId, 'active');
        }

        const allUsers = (typeof users.list === 'function' ? users.list() : []) || [];
        const targetIdStr = String(targetId).trim().toLowerCase();
        const memberIdStr = member.id != null ? String(member.id).trim().toLowerCase() : '';
        const memberCodeStr = member.code != null ? String(member.code).trim().toLowerCase() : '';
        const memberNumIdStr = member.numeric_id != null ? String(member.numeric_id).trim().toLowerCase() : '';

        const targetUser = allUsers.find(u =>
            (u.facultyId && (String(u.facultyId).toLowerCase() === targetIdStr || String(u.facultyId).toLowerCase() === memberIdStr || String(u.facultyId).toLowerCase() === memberCodeStr || String(u.facultyId).toLowerCase() === memberNumIdStr)) ||
            (u.id && String(u.id).toLowerCase() === targetIdStr) ||
            (u.username && (u.username.toLowerCase() === targetIdStr || (member.username && u.username.toLowerCase() === String(member.username).toLowerCase()))) ||
            (u.name && u.name.toUpperCase() === member.name.toUpperCase())
        );

        if (targetUser && targetUser.username) {
            users.updateFacultyUser(targetUser.username, { status: 'active', active: true });
        }
        users.updateFacultyUser(member.id || targetId, { status: 'active', active: true });
        if (member.numeric_id) users.updateFacultyUser(member.numeric_id, { status: 'active', active: true });
        if (member.code) users.updateFacultyUser(member.code, { status: 'active', active: true });
        if (member.name) users.updateFacultyUser(member.name, { status: 'active', active: true });

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

/**
 * POST /api/faculty/:id/create-account — HOS creates a user login account for an existing faculty record.
 * Preserves the exact existing faculty_id, does NOT duplicate the faculty record,
 * enforces branch isolation, password security policy, and username uniqueness.
 */
router.post('/:id/create-account', requireHOSUser, async (req, res, next) => {
    const targetId = req.params.id;
    const engine = store.engine;
    const sessionDept = req.session && req.session.department ? String(req.session.department).trim().toUpperCase() : null;

    let member = findFacultyMember(engine, targetId);
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbMember = await repository.getFaculty(targetId);
            if (dbMember) member = dbMember;
        } catch (_) {}
    }

    if (!member) {
        return res.status(404).json({ error: `Faculty "${targetId}" not found.`, code: 'NOT_FOUND' });
    }

    // Branch Security: HOS can create accounts only for faculty of their own branch
    if (sessionDept && member.department && member.department.toUpperCase() !== sessionDept) {
        return res.status(403).json({
            error: `Cross-branch faculty management is not allowed. Faculty belongs to ${member.department}, but current branch is ${sessionDept}.`,
            code: 'FORBIDDEN'
        });
    }

    // Check if faculty already has an account
    let existingAccount = null;
    let dbFacId = null;
    if (db.isConfigured() && store.usingDatabase) {
        try {
            dbFacId = await repository.resolveFacultyDbId(null, targetId || (member && member.id), member ? member.name : null);
            if (dbFacId) {
                const { rows } = await db.query(
                    "SELECT id, username FROM users WHERE role = 'faculty' AND faculty_id = $1 LIMIT 1",
                    [dbFacId]
                );
                if (rows.length > 0) existingAccount = rows[0];
            }
        } catch (_) {}
    }

    if (!existingAccount) {
        const registered = (typeof users.list === 'function' ? users.list() : []) || [];
        const targetIdStr = String(targetId).trim().toLowerCase();
        const memberIdStr = member.id != null ? String(member.id).trim().toLowerCase() : '';
        const memberCodeStr = member.code != null ? String(member.code).trim().toLowerCase() : '';
        const dbFacIdStr = dbFacId != null ? String(dbFacId).trim().toLowerCase() : '';

        existingAccount = registered.find(u =>
            u.role === 'faculty' && u.facultyId != null && (
                (targetIdStr && String(u.facultyId).trim().toLowerCase() === targetIdStr) ||
                (memberIdStr && String(u.facultyId).trim().toLowerCase() === memberIdStr) ||
                (memberCodeStr && String(u.facultyId).trim().toLowerCase() === memberCodeStr) ||
                (u.facultyCode && memberCodeStr && String(u.facultyCode).trim().toLowerCase() === memberCodeStr) ||
                (u.facultyCode && targetIdStr && String(u.facultyCode).trim().toLowerCase() === targetIdStr) ||
                (dbFacIdStr && String(u.facultyId).trim().toLowerCase() === dbFacIdStr)
            )
        );
    }

    if (existingAccount) {
        return res.status(409).json({
            error: `This faculty member already has an account (${existingAccount.username}).`,
            code: 'ACCOUNT_EXISTS'
        });
    }

    const body = req.body || {};
    const rawUsername = String(body.username || '').trim();
    if (!rawUsername) {
        return res.status(400).json({ error: 'Username is required.', code: 'INVALID_USERNAME' });
    }

    const password = String(body.password || '');
    if (!password) {
        return res.status(400).json({ error: 'Password is required.', code: 'INVALID_PASSWORD' });
    }

    const phone = String(body.phone || member.phone || '').trim();
    let subjects = body.subjects !== undefined
        ? (Array.isArray(body.subjects) ? body.subjects : String(body.subjects).split(',').map(s => s.trim()).filter(Boolean))
        : ((member.subjects && member.subjects.length > 0) ? member.subjects : ['General']);

    if (!subjects || !subjects.length) {
        subjects = ['General'];
    }

    try {
        const createdUser = await users.createAccountForFaculty({
            facultyId: member.numeric_id || member.id,
            name: body.name || member.name,
            department: member.department,
            designation: member.designation,
            username: rawUsername,
            password: password,
            confirmPassword: body.confirmPassword || password,
            phone: phone || null,
            subjects: subjects
        }, req.session);

        if (db.isConfigured() && store.usingDatabase) {
            await store.reloadFromDatabase();
        }

        res.status(201).json({
            success: true,
            message: `Account created successfully for ${member.name}.`,
            user: createdUser,
            faculty: {
                ...member,
                hasAccount: true,
                account: createdUser,
                username: createdUser.username
            }
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'ACCOUNT_CREATION_FAILED'
        });
    }
});

module.exports = router;

