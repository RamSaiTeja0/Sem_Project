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
const config = require('../config');

const { getBranch } = require('../data/departments');

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

function resolveAbsentFaculty(engine, input, branchCode) {
    const raw = input.absentFaculty || input.absent || input.faculty || input.excludeFaculty;
    if (!raw) return { member: null };

    const roster = engine.getFaculty();
    const needle = String(typeof raw === 'object' ? (raw.name || raw.id) : raw).trim().toUpperCase();
    const found = roster.find(f => {
        const matchesName = f.name && f.name.toUpperCase() === needle;
        const matchesId = f.id && String(f.id).toUpperCase() === needle;
        const matchesBranch = !branchCode || !f.department || f.department.toUpperCase() === branchCode.toUpperCase();
        return (matchesName || matchesId) && matchesBranch;
    });
    if (!found) {
        return {
            error: `Unknown absent faculty "${typeof raw === 'object' ? (raw.name || raw.id) : raw}".`,
            code: 'UNKNOWN_FACULTY'
        };
    }
    return { member: found };
}

function handle(req, input, res, isHOSOnly = false) {
    const engine = store.engine;

    // Role check for HOS-only operations or absent faculty management
    const hasAbsent = Boolean(input.absentFaculty || input.absent);
    if (req && req.session && req.session.role === 'faculty') {
        if (isHOSOnly || hasAbsent) {
            return res.status(403).json({
                error: 'Forbidden: HOS access required for faculty availability management.',
                code: 'FORBIDDEN'
            });
        }
    }

    // Resolve & Validate Slot
    const slot = resolveSlot(engine, input.day, input.period);
    if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });

    // Single Branch Context: derived from authenticated session, or configured environment
    const hasBranchEnv = Boolean(process.env.BRANCH_CODE || process.env.BRANCH_NAME);
    const sessionDept = (req && req.session && req.session.department && req.session.department !== 'Administration')
        ? req.session.department
        : (!config.loadDemoData && hasBranchEnv ? getBranch().code : null);

    // Cross-branch manipulation check
    if (sessionDept) {
        if (input.department && input.department.trim().toUpperCase() !== sessionDept.toUpperCase()) {
            return res.status(403).json({
                error: `Cross-branch queries are not allowed. Current branch is ${sessionDept}.`,
                code: 'FORBIDDEN'
            });
        }
        if (input.branch && input.branch.trim().toUpperCase() !== sessionDept.toUpperCase()) {
            return res.status(403).json({
                error: `Cross-branch queries are not allowed. Current branch is ${sessionDept}.`,
                code: 'FORBIDDEN'
            });
        }
    }
    const branchCode = sessionDept || input.department || null;

    // Resolve & Validate Absent Faculty
    const absentResult = resolveAbsentFaculty(engine, input, branchCode);
    if (absentResult.error) {
        return res.status(400).json({ error: absentResult.error, code: absentResult.code });
    }
    const absentMember = absentResult.member;

    // Calculate Availability
    const result = engine.getAvailability(slot.day, slot.period, {
        exclude: absentMember ? absentMember.name : null,
        department: branchCode,
        search: input.search || null
    });

    const roster = engine.getFaculty().filter(f =>
        !branchCode || (f.department || '').toUpperCase() === branchCode.toUpperCase()
    );
    const totalBranchFaculty = roster.length;

    // Build unified faculty list with status FREE / BUSY
    const facultyList = [
        ...result.available.map(r => ({
            id: r.facultyId || r.id,
            name: r.faculty,
            department: r.department,
            phone: r.phone || null,
            status: 'FREE'
        })),
        ...result.busy.map(r => ({
            id: r.facultyId || r.id,
            name: r.faculty,
            department: r.department,
            phone: r.phone || null,
            subject: r.subject,
            className: r.className,
            room: r.room,
            status: 'BUSY'
        }))
    ];

    let emptyState = null;
    if (totalBranchFaculty === 0) {
        emptyState = 'No faculty has been configured yet.';
    } else if (result.totalAvailable === 0) {
        emptyState = 'No faculty are free during this period.';
    }

    res.json({
        day: result.day,
        period: result.period,
        branch: branchCode,
        department: branchCode,
        absentFaculty: absentMember ? { id: absentMember.id, name: absentMember.name } : null,
        faculty: facultyList,
        subject: input.subject || null,
        class: input.class || input.className || null,
        availableFaculty: result.availableFaculty,
        available: result.available,
        busy: result.busy,
        totalAvailable: result.totalAvailable,
        totalBusy: result.totalBusy,
        totalFaculty: totalBranchFaculty,
        emptyState,
        readOnly: true
    });
}

function requireHOS(req, res, next) {
    if (req.session && req.session.role === 'faculty') {
        return res.status(403).json({
            error: 'Forbidden: HOS access required for faculty availability management.',
            code: 'FORBIDDEN'
        });
    }
    next();
}

router.post('/hos', requireHOS, (req, res) => handle(req, req.body || {}, res, true));
router.get('/hos', requireHOS, (req, res) => handle(req, req.query || {}, res, true));
router.post('/', (req, res) => handle(req, req.body || {}, res));
router.get('/', (req, res) => handle(req, req.query || {}, res));
router.get('/summary', (req, res) => {
    const engine = store.engine;
    const { day, period } = req.query;

    if (day || period) {
        const slot = resolveSlot(engine, day, period);
        if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });
        return res.json(engine.getSummary(slot.day, slot.period));
    }
    res.json(engine.getSummary());
});

// Unknown sub-paths answer in JSON rather than falling through to the SPA.
router.use((req, res) => {
    res.status(404).json({ error: `Unknown availability endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

module.exports = router;
