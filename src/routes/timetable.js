/**
 * Timetable routes — read-only views of the loaded timetable.
 *
 *   GET /api/timetable                 primary class grid
 *   GET /api/timetable?class=CSE-B     another class grid
 *   GET /api/timetable?faculty=Name    one faculty's own week
 *   GET /api/timetable/meta            days, periods, classes, timings
 *   GET /api/timetable/records         the normalized records themselves
 */
const express = require('express');
const router = express.Router();
const store = require('../data/store');
const branchScope = require('../core/branchScope');

router.get('/meta', branchScope.guard(), (req, res) => {
    const engine = store.engine;
    const scope = req.branchScope;
    const meta = engine.getMeta();

    // The metadata a branch application needs, showing only its own classes —
    // and, unscoped, only the ACTIVE branches' classes.
    const classes = branchScope.visibleClasses(scope);

    res.json({
        ...meta,
        classes,
        primaryClass: classes.includes(meta.primaryClass) ? meta.primaryClass : (classes[0] || null),
        branch: scope.branch || null,
        facultyCount: branchScope.visibleFacultyNames(scope).size,
        origin: store.origin,
        loadedAt: store.loadedAt,
        // A warning that names another branch's class or faculty is that
        // branch's business, not this one's.
        warnings: branchScope.filterWarnings(store.report.warnings, scope.branch)
    });
});

router.get('/records', branchScope.guard(), (req, res) => {
    const engine = store.engine;
    const scope = req.branchScope;
    const { day, period, faculty, status } = req.query;
    let records = engine.getRecords();

    // Only periods this caller may see. For a branch account that is its own
    // classes — a visiting lecturer's periods in their home branch are not this
    // branch's business — and unscoped it excludes every archived branch.
    const pool = branchScope.visibleFacultyNames(scope);
    const classes = new Set(branchScope.visibleClasses(scope));
    records = records
        .filter(r => !r.faculty || pool.has(r.faculty))
        .filter(r => r.status !== 'busy' || classes.has(r.className));
    if (scope.branch) {
        records = records.map(r => branchScope.projectFaculty(r, scope.branch));
    }

    if (day) {
        const resolved = engine.normalizeDay(day);
        if (!resolved) return res.status(400).json({ error: `Unknown day "${day}"`, code: 'INVALID_DAY' });
        records = records.filter(r => r.day === resolved);
    }
    if (period) {
        const resolved = engine.normalizePeriod(period);
        if (resolved == null) return res.status(400).json({ error: `Unknown period "${period}"`, code: 'INVALID_PERIOD' });
        records = records.filter(r => r.period === resolved);
    }
    if (faculty) {
        const needle = String(faculty).trim().toUpperCase();
        records = records.filter(r => r.faculty.toUpperCase().includes(needle));
    }
    if (status) {
        const wanted = String(status).trim().toLowerCase();
        records = records.filter(r => r.status === wanted);
    }

    res.json({ count: records.length, records });
});

router.get('/', branchScope.guard(req => branchScope.branchOfClass(req.query.class)), (req, res) => {
    const engine = store.engine;
    const scope = req.branchScope;

    // Classes this caller may see at all. Everything below is chosen from here,
    // so no branch can read another branch's grid by naming its class, and an
    // archived branch's grid is unreachable to everyone but a coordinator.
    const visibleClasses = branchScope.visibleClasses(scope);

    if (req.query.faculty) {
        // A faculty grid is readable only for someone this branch may see, and
        // it is trimmed to this branch's classes: a visiting lecturer's periods
        // in their home branch stay invisible here.
        if (!branchScope.visibleFacultyNames(scope).has(req.query.faculty)) {
            return res.status(404).json({
                error: `No faculty named "${req.query.faculty}"` +
                    (scope.branch ? ` in ${scope.branch}` : ''),
                code: 'NOT_FOUND'
            });
        }
        const grid = engine.getFacultyGrid(req.query.faculty);
        if (!grid) {
            return res.status(404).json({ error: `No faculty named "${req.query.faculty}"`, code: 'NOT_FOUND' });
        }
        const cells = grid.cells.map(cell => (cell.className && !visibleClasses.includes(cell.className)
                // Occupied, but by another branch's class: report it busy
                // without disclosing whose class it is.
                ? { ...cell, className: null, subject: null, room: null, otherBranch: true }
                : cell));
        return res.json({ ...grid, cells, periodTimings: engine.getMeta().periodTimings,
                          branch: scope.branch || null });
    }

    const meta = engine.getMeta();
    const requested = req.query.class;
    if (requested && !visibleClasses.includes(requested)) {
        return res.status(404).json({
            error: `No class "${requested}". Available: ${visibleClasses.join(', ')}`,
            code: 'NOT_FOUND'
        });
    }

    const target = requested || visibleClasses[0] || meta.primaryClass;

    res.json({
        ...engine.getClassGrid(target),
        periodTimings: meta.periodTimings,
        classes: visibleClasses,
        primaryClass: visibleClasses.includes(meta.primaryClass) ? meta.primaryClass : target,
        branch: scope.branch || null
    });
});

module.exports = router;
