/**
 * Availability routes — READ-ONLY.
 *
 *   POST /api/availability          { day, period } -> free faculty
 *   GET  /api/availability          same query over GET, for quick checks
 *   GET  /api/availability/summary  totals for the dashboard
 *
 * Nothing here assigns a substitute, stores a selection, or modifies any
 * timetable. There is deliberately no write path in this file.
 */
const express = require('express');
const router = express.Router();
const store = require('../data/store');
const branchScope = require('../core/branchScope');

function resolveSlot(engine, rawDay, rawPeriod) {
    const day = engine.normalizeDay(rawDay);
    if (!day) {
        return {
            error: `Unknown or missing day "${rawDay == null ? '' : rawDay}". Valid days: ${engine.getDays().join(', ')}`,
            code: 'INVALID_DAY'
        };
    }
    const period = engine.normalizePeriod(rawPeriod);
    if (period == null) {
        return {
            error: `Unknown or missing period "${rawPeriod == null ? '' : rawPeriod}". Valid periods: ${engine.getPeriods().join(', ')}`,
            code: 'INVALID_PERIOD'
        };
    }
    return { day, period };
}

function handle(input, res, scope) {
    const engine = store.engine;
    const slot = resolveSlot(engine, input.day, input.period);
    if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });

    const result = engine.getAvailability(slot.day, slot.period, {
        exclude: input.faculty || input.excludeFaculty || null,
        department: input.department || null,
        search: input.search || null
    });

    // Branch-scope the answer.
    //
    // The pool is everyone this branch may see, which includes a visiting
    // lecturer who teaches one of its classes — their CME commitment counts,
    // so they are correctly BUSY here when they are teaching CME.
    //
    // A visitor busy in their HOME branch is also busy, and must stay excluded
    // from the free list; but this branch is not told which class holds them.
    if (scope && scope.branch) {
        const pool = branchScope.facultyPoolOf(scope.branch);
        const ourClasses = new Set(branchScope.classesOf(scope.branch));

        result.available = branchScope.projectFacultyList(
            result.available.filter(f => pool.has(f.faculty)), scope.branch);
        result.availableFaculty = result.available.map(f => f.faculty);

        result.busy = result.busy
            .filter(f => pool.has(f.faculty))
            .map(entry => {
                const projected = branchScope.projectFaculty(entry, scope.branch);
                if (entry.className && !ourClasses.has(entry.className)) {
                    // Busy elsewhere: report the fact, never the other branch.
                    return { ...projected, className: null, subject: null, room: null,
                             otherBranch: true };
                }
                return projected;
            });

        result.totalAvailable = result.available.length;
        result.totalBusy = result.busy.length;
        result.totalFaculty = result.totalAvailable + result.totalBusy;
    }

    res.json({
        branch: (scope && scope.branch) || null,
        day: result.day,
        period: result.period,
        // Context echoed back from the clicked cell — the engine does not
        // trust it, day + period alone drive the lookup.
        subject: input.subject || null,
        class: input.class || input.className || null,
        availableFaculty: result.availableFaculty,
        totalAvailable: result.totalAvailable,
        available: result.available,
        busy: result.busy,
        totalBusy: result.totalBusy,
        totalFaculty: result.totalFaculty,
        excluded: input.faculty || input.excludeFaculty || null,
        readOnly: true
    });
}

// `branch` in the body or query never widens access: the guard refuses a
// foreign one outright, so a CME user posting {"branch":"EEE"} gets 403.
const scopeGuard = branchScope.guard(req =>
    (req.body && (req.body.branch || req.body.department)) ||
    req.query.branch || req.query.department || null);

router.post('/', scopeGuard, (req, res) => handle(req.body || {}, res, req.branchScope));

router.get('/summary', scopeGuard, (req, res) => {
    const engine = store.engine;
    const scope = req.branchScope;
    const { day, period } = req.query;

    function scoped(summary) {
        if (!scope.branch) return summary;
        const pool = branchScope.facultyPoolOf(scope.branch);
        const classes = new Set(branchScope.classesOf(scope.branch));
        const total = pool.size;

        return {
            ...summary,
            branch: scope.branch,
            totalFaculty: total,
            classes: [...classes],
            slots: (summary.slots || []).map(entry => {
                const slot = engine.getSlot(entry.day, entry.period);
                if (!slot) return entry;
                const busy = slot.busy.filter(r => pool.has(r.faculty)).length;
                return { ...entry, busy, available: total - busy };
            })
        };
    }

    if (day || period) {
        const slot = resolveSlot(engine, day, period);
        if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });
        return res.json(scoped(engine.getSummary(slot.day, slot.period)));
    }
    res.json(scoped(engine.getSummary()));
});

router.get('/', scopeGuard, (req, res) => handle(req.query || {}, res, req.branchScope));

// Unknown sub-paths answer in JSON rather than falling through to the SPA.
router.use((req, res) => {
    res.status(404).json({ error: `Unknown availability endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

module.exports = router;
