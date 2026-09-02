/**
 * Catalog management — branches, subjects and classes.
 *
 *   GET/POST/PUT/DELETE  /api/branches[/:code]
 *   GET/POST/PUT/DELETE  /api/subjects[/:code]   (?branch=CSE to filter)
 *   GET/POST/PUT/DELETE  /api/classes[/:code]    (?branch=CSE to filter)
 *
 * A BRANCH is an academic programme (CSE). A CLASS is a section inside one
 * (CSE-A). They are different records; creating CSE-A does not create a branch.
 *
 * Reads work with or without a database — without one they report the branches,
 * subjects and classes present in the loaded demo dataset, so every dropdown in
 * the UI still populates.
 *
 * Writes need a configured database, for the same reason timetable entries do:
 * a branch that disappeared on restart would be worse than refusing to create
 * it. With no DATABASE_URL these endpoints answer 503 and say what is missing.
 */
const express = require('express');
const router = express.Router();

const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const { DEPARTMENTS, nameFor: departmentName } = require('../data/departments');
const branchScope = require('../core/branchScope');

const SUBJECT_TYPES = ['theory', 'lab'];

/**
 * Refuse a write that would touch another branch.
 *
 * Writes are guarded the same way reads are: the branch comes from the signed
 * session, so a CME account cannot create, rename or delete an EEE subject,
 * class or branch even by naming it directly in the URL or the body.
 * Returns true when the write may proceed; it has already answered otherwise.
 */
function allowBranchWrite(req, res, ...branches) {
    const scope = branchScope.resolve(req, null);
    if (scope.error || !scope.branch) return true;   // coordinator, or unscoped demo
    const foreign = branches
        .map(b => branchScope.code(b))
        .find(b => b && b !== scope.branch);
    if (foreign) {
        res.status(403).json({
            error: `This account belongs to ${scope.branch}. It cannot change ${foreign} records.`,
            code: 'BRANCH_FORBIDDEN'
        });
        return false;
    }
    return true;
}

/** The branch an existing subject or class belongs to, or null when unknown. */
async function branchOfRecord(kind, code) {
    const wanted = String(code || '').trim().toUpperCase();
    const rows = db.isConfigured()
        ? await (kind === 'subject' ? repository.listSubjects() : repository.listClasses())
        : (kind === 'subject' ? subjectsFromDataset() : classesFromDataset());
    const match = rows.find(r => String(r.code || '').toUpperCase() === wanted);
    return match ? branchScope.code(match.department) : null;
}

function requireDatabase(res, action) {
    if (db.isConfigured()) return true;
    res.status(503).json({
        error: `${action} needs a configured database. Set DATABASE_URL (Neon or any PostgreSQL) and restart. ` +
               'Reading branches, subjects and classes works without one.',
        code: 'DATABASE_REQUIRED'
    });
    return false;
}

function fail(res, err) {
    const status = err.status || 500;
    res.status(status).json({
        error: err.message,
        code: err.code || 'REQUEST_FAILED',
        details: err.details || null
    });
}

function text(value) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed.length ? trimmed : null;
}

// ----------------------------------------------------------------- branches

/** Branches from the loaded dataset, used when no database is serving. */
function branchesFromDataset() {
    const roster = store.engine.getFaculty();
    const counts = new Map();
    roster.forEach(f => {
        const key = String(f.department || 'General').toUpperCase();
        counts.set(key, (counts.get(key) || 0) + 1);
    });

    // Every declared branch is listed even with no faculty: dropping an empty
    // one would make a newly created branch look as though it never existed.
    const seen = new Map();
    DEPARTMENTS.forEach(d => seen.set(d.code.toUpperCase(), {
        code: d.code, name: d.name, active: d.active !== false,
        facultyCount: counts.get(d.code.toUpperCase()) || 0
    }));
    counts.forEach((n, code) => {
        if (!seen.has(code)) {
            seen.set(code, { code, name: departmentName(code), active: true, facultyCount: n });
        }
    });

    return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

router.get('/branches', branchScope.guard(), async (req, res) => {
    try {
        let branches = db.isConfigured()
            ? await repository.listDepartments()
            : branchesFromDataset();
        // A branch-scoped account sees only its own branch listed: the branch
        // list is what a selector would be built from, and there must not be
        // one. Coordinators still see every branch.
        const scope = req.branchScope;
        if (scope.branch) {
            branches = branches.filter(b => branchScope.code(b.code) === scope.branch);
        } else if (!scope.includeArchived) {
            // An archived branch is not an application: it is listed only to a
            // coordinator, who is the one role that can bring it back.
            branches = branches.filter(b => branchScope.isActiveBranch(b.code));
        }
        // `active` says whether a branch is an application. It is always
        // reported so a caller can tell an archived branch from a missing one.
        branches = branches.map(b => ({ ...b, active: b.active !== false }));
        res.json({ count: branches.length, branches, writable: db.isConfigured(),
                   activeBranches: branches.filter(b => b.active).map(b => b.code),
                   branch: scope.branch || null });
    } catch (err) { fail(res, err); }
});

router.post('/branches', async (req, res) => {
    if (!requireDatabase(res, 'Creating a branch')) return;
    if (!allowBranchWrite(req, res, req.body && (req.body.code || req.body.branch))) return;

    const code = text(req.body && req.body.code);
    const name = text(req.body && req.body.name);

    const problems = [];
    if (!code) problems.push('Branch code is required');
    else if (!/^[A-Za-z][A-Za-z0-9-]{1,15}$/.test(code)) {
        problems.push('Branch code must be 2–16 letters, digits or hyphens and start with a letter');
    }
    if (!name) problems.push('Branch name is required');
    if (problems.length) {
        return res.status(400).json({ error: problems.join('; '), code: 'INVALID_BRANCH', details: problems });
    }

    try {
        const branch = await repository.addDepartment({ code, name });
        await store.initFromDatabase();
        res.status(201).json({ message: `Branch "${branch.code}" created`, branch });
    } catch (err) { fail(res, err); }
});

router.put('/branches/:code', async (req, res) => {
    if (!requireDatabase(res, 'Editing a branch')) return;
    if (!allowBranchWrite(req, res, req.params.code)) return;
    const name = text(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'Branch name is required', code: 'INVALID_BRANCH' });
    try {
        const branch = await repository.updateDepartment(req.params.code, { name });
        await store.initFromDatabase();
        res.json({ message: `Branch "${branch.code}" updated`, branch });
    } catch (err) { fail(res, err); }
});

router.delete('/branches/:code', async (req, res) => {
    if (!requireDatabase(res, 'Deleting a branch')) return;
    if (!allowBranchWrite(req, res, req.params.code)) return;
    try {
        const removed = await repository.deleteDepartment(req.params.code);
        await store.initFromDatabase();
        res.json({ message: `Branch "${removed.code}" deleted`, branch: removed });
    } catch (err) { fail(res, err); }
});

// ----------------------------------------------------------------- subjects

function subjectsFromDataset() {
    const declared = (store.source && store.source.subjects) || [];
    if (declared.length) {
        return declared.map(s => ({
            code: s.code || null, name: s.name,
            department: s.department || 'General', type: s.type || 'theory'
        }));
    }
    // No subject catalog in the source: derive the names actually taught.
    const seen = new Map();
    store.engine.getRecords().filter(r => r.status === 'busy').forEach(r => {
        if (r.subject && !seen.has(r.subject)) {
            seen.set(r.subject, { code: null, name: r.subject, department: 'General', type: 'theory' });
        }
    });
    return [...seen.values()];
}

function byBranch(list, branch) {
    if (!branch) return list;
    const wanted = String(branch).trim().toUpperCase();
    return list.filter(item => String(item.department || '').toUpperCase() === wanted);
}

router.get('/subjects', branchScope.guard(req => req.query.branch), async (req, res) => {
    try {
        const scope = req.branchScope;
        const all = (db.isConfigured() ? await repository.listSubjects() : subjectsFromDataset())
            .filter(item => branchScope.allows(scope, item.department));
        const subjects = byBranch(all, scope.branch || req.query.branch);
        res.json({ count: subjects.length, subjects, writable: db.isConfigured(),
                   branch: scope.branch || null });
    } catch (err) { fail(res, err); }
});

router.post('/subjects', async (req, res) => {
    if (!requireDatabase(res, 'Adding a subject')) return;
    if (!allowBranchWrite(req, res, req.body && (req.body.department || req.body.branch))) return;

    const body = req.body || {};
    const code = text(body.code);
    const name = text(body.name);
    const department = text(body.department || body.branch);
    const type = text(body.type) || 'theory';

    const problems = [];
    if (!code) problems.push('Subject code is required');
    if (!name) problems.push('Subject name is required');
    if (!department) problems.push('Branch is required');
    if (!SUBJECT_TYPES.includes(type)) problems.push(`Subject type must be one of: ${SUBJECT_TYPES.join(', ')}`);
    if (problems.length) {
        return res.status(400).json({ error: problems.join('; '), code: 'INVALID_SUBJECT', details: problems });
    }

    try {
        const subject = await repository.addSubject({ code, name, department, type });
        await store.initFromDatabase();
        res.status(201).json({ message: `Subject "${subject.code}" added to ${subject.department}`, subject });
    } catch (err) { fail(res, err); }
});

router.put('/subjects/:code', async (req, res) => {
    if (!requireDatabase(res, 'Editing a subject')) return;
    const body = req.body || {};
    // Both sides are checked, so a subject cannot be moved across branches.
    if (!allowBranchWrite(req, res, await branchOfRecord('subject', req.params.code),
        body.department || body.branch)) return;
    const type = text(body.type);
    if (type && !SUBJECT_TYPES.includes(type)) {
        return res.status(400).json({ error: `Subject type must be one of: ${SUBJECT_TYPES.join(', ')}`,
            code: 'INVALID_SUBJECT' });
    }
    try {
        const subject = await repository.updateSubject(req.params.code, {
            name: text(body.name), type, department: text(body.department || body.branch)
        });
        await store.initFromDatabase();
        res.json({ message: `Subject "${subject.code}" updated`, subject });
    } catch (err) { fail(res, err); }
});

router.delete('/subjects/:code', async (req, res) => {
    if (!requireDatabase(res, 'Deleting a subject')) return;
    if (!allowBranchWrite(req, res, await branchOfRecord('subject', req.params.code))) return;
    try {
        const removed = await repository.deleteSubject(req.params.code);
        await store.initFromDatabase();
        res.json({ message: `Subject "${removed.code}" deleted`, subject: removed });
    } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------------ classes

function classesFromDataset() {
    const declared = (store.source && store.source.classes) || [];
    return store.engine.getMeta().classes.map(code => {
        const match = declared.find(c => (c.class || c.name) === code) || {};
        return {
            code,
            department: match.department || 'General',
            semester: match.semester || null,
            academicYear: match.academicYear || null,
            room: match.room || null
        };
    });
}

router.get('/classes', branchScope.guard(req => req.query.branch), async (req, res) => {
    try {
        const scope = req.branchScope;
        const all = (db.isConfigured() ? await repository.listClasses() : classesFromDataset())
            .filter(item => branchScope.allows(scope, item.department));
        const classes = byBranch(all, scope.branch || req.query.branch);
        res.json({ count: classes.length, classes, writable: db.isConfigured(),
                   branch: scope.branch || null });
    } catch (err) { fail(res, err); }
});

router.post('/classes', async (req, res) => {
    if (!requireDatabase(res, 'Adding a class')) return;
    if (!allowBranchWrite(req, res, req.body && (req.body.department || req.body.branch))) return;

    const body = req.body || {};
    const code = text(body.code);
    const department = text(body.department || body.branch);
    const semester = body.semester == null || body.semester === '' ? null : parseInt(body.semester, 10);

    const problems = [];
    if (!code) problems.push('Class code is required');
    if (!department) problems.push('Branch is required');
    if (semester != null && (isNaN(semester) || semester < 1 || semester > 12)) {
        problems.push('Semester must be a number between 1 and 12');
    }
    if (problems.length) {
        return res.status(400).json({ error: problems.join('; '), code: 'INVALID_CLASS', details: problems });
    }

    try {
        const created = await repository.addClass({
            code, department, semester,
            academicYear: text(body.academicYear), room: text(body.room)
        });
        await store.initFromDatabase();
        res.status(201).json({ message: `Class "${created.code}" added to ${created.department}`, class: created });
    } catch (err) { fail(res, err); }
});

router.put('/classes/:code', async (req, res) => {
    if (!requireDatabase(res, 'Editing a class')) return;
    const body = req.body || {};
    if (!allowBranchWrite(req, res, await branchOfRecord('class', req.params.code),
        body.department || body.branch)) return;
    const semester = body.semester == null || body.semester === '' ? null : parseInt(body.semester, 10);
    if (semester != null && (isNaN(semester) || semester < 1 || semester > 12)) {
        return res.status(400).json({ error: 'Semester must be a number between 1 and 12', code: 'INVALID_CLASS' });
    }
    try {
        const updated = await repository.updateClass(req.params.code, {
            department: text(body.department || body.branch),
            semester, academicYear: text(body.academicYear)
        });
        await store.initFromDatabase();
        res.json({ message: `Class "${updated.code}" updated`, class: updated });
    } catch (err) { fail(res, err); }
});

router.delete('/classes/:code', async (req, res) => {
    if (!requireDatabase(res, 'Deleting a class')) return;
    if (!allowBranchWrite(req, res, await branchOfRecord('class', req.params.code))) return;
    try {
        const removed = await repository.deleteClass(req.params.code);
        await store.initFromDatabase();
        res.json({ message: `Class "${removed.code}" deleted`, class: removed });
    } catch (err) { fail(res, err); }
});

module.exports = router;
