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

const { getBranch, getRegisteredBranchCodes } = require('../data/departments');
const attendance = require('../data/attendance');
const invigilation = require('../data/invigilation');

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

async function handle(req, input, res, isHOSOnly = false) {
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

    // Date handling (Phase B7.2): parse UTC calendar date and auto-derive day if omitted
    let requestedDate = null;
    let absentRecords = [];
    if (input.date) {
        const parsedDate = attendance.parseDateString(input.date);
        if (!parsedDate) {
            return res.status(400).json({
                error: `Invalid date format "${input.date}". Expected YYYY-MM-DD.`,
                code: 'INVALID_DATE'
            });
        }
        requestedDate = parsedDate.dateStr;
        if (!input.day) {
            input.day = parsedDate.dayOfWeek;
        }
        absentRecords = await attendance.getAbsentFacultyOnDate(requestedDate);
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

    // Determine priority branch (absent faculty's branch wins, else current branch context)
    const priorityBranch = absentMember
        ? (absentMember.department || branchCode || null)
        : (branchCode || null);

    // Dynamically collect all registered and valid branch codes
    const validBranchCodes = getValidBranchCodes(priorityBranch, engine);

    // Build absent faculty names / codes to exclude from availability
    const absentFacultyList = absentRecords.map(r => r.name);

    let invigilationRecords = [];
    if (requestedDate) {
        invigilationRecords = await invigilation.getActiveInvigilationsOnDate(requestedDate, slot.period);
    }

    // Calculate Availability across all registered branches with priority ordering
    const result = engine.getAvailability(slot.day, slot.period, {
        exclude: absentMember ? absentMember.name : null,
        excludedFaculty: absentFacultyList,
        invigilationFaculty: invigilationRecords,
        search: input.search || null,
        priorityBranch: priorityBranch,
        validBranches: validBranchCodes.size > 0 ? validBranchCodes : null
    });

    const roster = engine.getFaculty().filter(f =>
        !priorityBranch || (f.department || '').toUpperCase() === priorityBranch.toUpperCase()
    );
    const totalBranchFaculty = roster.length;

    // Build unified faculty list with status FREE / BUSY
    const facultyList = [
        ...result.available.map(r => ({
            id: r.facultyId || r.id,
            facultyId: r.facultyId || r.id,
            name: r.faculty,
            facultyName: r.faculty,
            department: r.department,
            branch: r.department,
            phone: r.phone || null,
            status: 'FREE',
            reason: null,
            isSameBranch: r.isSameBranch
        })),
        ...result.busy.map(r => ({
            id: r.facultyId || r.id,
            facultyId: r.facultyId || r.id,
            name: r.faculty,
            facultyName: r.faculty,
            department: r.department,
            branch: r.department,
            phone: r.phone || null,
            subject: r.subject,
            className: r.className,
            room: r.room,
            status: 'BUSY',
            reason: r.reason || (r.isInvigilation ? 'INVIGILATION' : 'TEACHING'),
            isInvigilation: Boolean(r.isInvigilation),
            isSameBranch: r.isSameBranch
        }))
    ];

    if (input.includeAbsent === true || input.includeAbsent === 'true') {
        absentRecords.forEach(ab => {
            facultyList.push({
                id: ab.faculty_id || ab.id,
                facultyId: ab.faculty_id || ab.id,
                name: ab.name,
                facultyName: ab.name,
                department: ab.department,
                branch: ab.department,
                phone: null,
                status: 'ABSENT',
                reason: null,
                isSameBranch: Boolean(priorityBranch && (ab.department || '').toUpperCase() === priorityBranch.toUpperCase())
            });
        });
    }

    // Build allFaculty overview (includes FREE, BUSY, ABSENT)
    const busyMap = new Map();
    result.busy.forEach(b => {
        if (b.faculty) busyMap.set(b.faculty.toUpperCase(), b);
        if (b.facultyId) busyMap.set(String(b.facultyId), b);
    });
    const absentNamesSet = new Set(absentFacultyList.map(n => n.toUpperCase()));
    const absentIdsSet = new Set(absentRecords.map(r => String(r.faculty_id || r.id)).filter(Boolean));
    if (absentMember) {
        if (absentMember.name) absentNamesSet.add(absentMember.name.toUpperCase());
        if (absentMember.id) absentIdsSet.add(String(absentMember.id));
    }

    const activeFaculty = engine.getFaculty().filter(f => f.status !== 'inactive');
    const branchFaculty = activeFaculty.filter(f =>
        !priorityBranch || (f.department || '').toUpperCase() === priorityBranch.toUpperCase()
    );

    const allFaculty = [];
    branchFaculty.forEach(f => {
        const nameUpper = (f.name || '').toUpperCase();
        const idStr = String(f.id || '');
        const isAbsent = absentNamesSet.has(nameUpper) || absentIdsSet.has(idStr);
        if (isAbsent) {
            allFaculty.push({
                id: f.id,
                facultyId: f.id,
                name: f.name,
                facultyName: f.name,
                department: f.department,
                branch: f.department,
                status: 'ABSENT',
                reason: null,
                isSameBranch: true
            });
        } else {
            const bRec = busyMap.get(nameUpper) || busyMap.get(idStr);
            if (bRec) {
                allFaculty.push({
                    id: f.id,
                    facultyId: f.id,
                    name: f.name,
                    facultyName: f.name,
                    department: f.department,
                    branch: f.department,
                    subject: bRec.subject || null,
                    className: bRec.className || null,
                    room: bRec.room || null,
                    status: 'BUSY',
                    reason: bRec.isInvigilation ? 'INVIGILATION' : 'TEACHING',
                    isInvigilation: Boolean(bRec.isInvigilation),
                    isSameBranch: true
                });
            } else {
                allFaculty.push({
                    id: f.id,
                    facultyId: f.id,
                    name: f.name,
                    facultyName: f.name,
                    department: f.department,
                    branch: f.department,
                    status: 'FREE',
                    reason: null,
                    isSameBranch: true
                });
            }
        }
    });

    allFaculty.sort((a, b) => a.facultyName.localeCompare(b.facultyName));

    (result.otherBranches ? result.otherBranches.available : []).forEach(ob => {
        allFaculty.push({
            id: ob.facultyId || ob.id,
            facultyId: ob.facultyId || ob.id,
            name: ob.faculty,
            facultyName: ob.faculty,
            department: ob.department,
            branch: ob.department,
            status: 'FREE',
            reason: null,
            isSameBranch: false
        });
    });

    let emptyState = null;
    if (totalBranchFaculty === 0 && result.totalAvailable === 0) {
        emptyState = 'No faculty has been configured yet.';
    } else if (result.totalAvailable === 0) {
        emptyState = 'No faculty are free during this period.';
    }

    res.json({
        date: requestedDate,
        day: result.day,
        period: result.period,
        branch: branchCode,
        department: branchCode,
        priorityBranch: priorityBranch,
        absentFaculty: absentMember ? { id: absentMember.id, name: absentMember.name, department: absentMember.department } : null,
        absentList: absentFacultyList,
        faculty: facultyList,
        allFaculty: allFaculty,
        subject: input.subject || null,
        class: input.class || input.className || null,
        availableFaculty: result.availableFaculty,
        available: result.available,
        sameBranch: result.sameBranch,
        otherBranches: result.otherBranches,
        busy: result.busy,
        totalAvailable: result.totalAvailable,
        totalBusy: result.totalBusy,
        totalFaculty: totalBranchFaculty,
        emptyState,
        readOnly: true
    });
}

function getValidBranchCodes(priorityBranch, engine) {
    const validBranchCodes = new Set((getRegisteredBranchCodes() || []).map(c => c.toUpperCase()));
    if (priorityBranch) validBranchCodes.add(priorityBranch.toUpperCase());
    try {
        const defaultBranch = getBranch();
        if (defaultBranch && defaultBranch.code) validBranchCodes.add(defaultBranch.code.toUpperCase());
    } catch (e) {}
    if (store.state && store.state.source && Array.isArray(store.state.source.departments)) {
        store.state.source.departments.forEach(d => {
            if (d && d.code) validBranchCodes.add(String(d.code).trim().toUpperCase());
        });
    }
    if (store.state && store.state.source && Array.isArray(store.state.source.faculty)) {
        store.state.source.faculty.forEach(f => {
            if (f && f.department) validBranchCodes.add(String(f.department).trim().toUpperCase());
        });
    }
    if (engine && typeof engine.getFaculty === 'function') {
        engine.getFaculty().forEach(f => {
            if (f && f.department) validBranchCodes.add(String(f.department).trim().toUpperCase());
        });
    }
    if (config.loadDemoData) {
        try {
            const demoTimetable = require('../data/demoTimetable');
            if (Array.isArray(demoTimetable.departments)) {
                demoTimetable.departments.forEach(d => {
                    if (d && d.code) validBranchCodes.add(String(d.code).trim().toUpperCase());
                });
            }
        } catch (e) {}
    }
    return validBranchCodes;
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

function requireHOSCandidateAccess(req, res, next) {
    if (!req.session || !req.session.username) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in as HOS.',
            code: 'UNAUTHENTICATED'
        });
    }
    if (req.session.role === 'faculty') {
        return res.status(403).json({
            error: 'Forbidden: HOS access required for candidate management.',
            code: 'FORBIDDEN'
        });
    }
    if (!['hos', 'coordinator', 'admin'].includes(req.session.role)) {
        return res.status(403).json({
            error: 'Forbidden: HOS access required for candidate management.',
            code: 'FORBIDDEN'
        });
    }
    next();
}

async function handleCandidates(req, input, res) {
    const engine = store.engine;

    // Single Branch Context from HOS session
    const sessionDept = (req && req.session && req.session.department && req.session.department !== 'Administration')
        ? req.session.department
        : null;

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

    const branchCode = sessionDept || input.branch || input.department || (getBranch() ? getBranch().code : null);
    const priorityBranch = branchCode;

    // Date & Day resolution
    let requestedDate = null;
    let dayOfWeek = null;
    let absentRecords = [];

    if (input.date) {
        const parsedDate = attendance.parseDateString(input.date);
        if (!parsedDate) {
            return res.status(400).json({
                error: `Invalid date format "${input.date}". Expected YYYY-MM-DD.`,
                code: 'INVALID_DATE'
            });
        }
        requestedDate = parsedDate.dateStr;
        dayOfWeek = parsedDate.dayOfWeek;
        absentRecords = await attendance.getAbsentFacultyOnDate(requestedDate);
    } else if (input.day) {
        dayOfWeek = input.day;
    } else {
        return res.status(400).json({
            error: 'Date (YYYY-MM-DD) or day is required.',
            code: 'MISSING_DATE'
        });
    }

    // Resolve & Validate Slot
    const slot = resolveSlot(engine, dayOfWeek, input.period);
    if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });

    // Collect absent faculty names & IDs
    const absentFacultyList = absentRecords.map(r => r.name);
    const absentFacultyNamesSet = new Set(absentFacultyList.map(n => n.toUpperCase()));
    const absentFacultyIdsSet = new Set(absentRecords.map(r => String(r.faculty_id || r.id)).filter(Boolean));

    if (input.absentFaculty || input.vacantFaculty || input.excludeFaculty) {
        const extra = resolveAbsentFaculty(engine, input, branchCode);
        if (extra.member && !absentFacultyNamesSet.has(extra.member.name.toUpperCase())) {
            absentFacultyList.push(extra.member.name);
            absentFacultyNamesSet.add(extra.member.name.toUpperCase());
            if (extra.member.id) absentFacultyIdsSet.add(String(extra.member.id));
        }
    }

    // Active invigilation records on that date & period
    let invigilationRecords = [];
    if (requestedDate) {
        invigilationRecords = await invigilation.getActiveInvigilationsOnDate(requestedDate, slot.period);
    }

    // Dynamic branches
    const validBranchCodes = getValidBranchCodes(priorityBranch, engine);

    // Calculate Availability
    const result = engine.getAvailability(slot.day, slot.period, {
        excludedFaculty: absentFacultyList,
        invigilationFaculty: invigilationRecords,
        search: input.search || null,
        priorityBranch: priorityBranch,
        validBranches: validBranchCodes.size > 0 ? validBranchCodes : null
    });

    // Candidates: ONLY FREE faculty
    const candidates = result.available.map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: r.phone || null,
        status: 'FREE',
        reason: null,
        isSameBranch: r.isSameBranch
    }));

    const sameBranchCandidates = (result.sameBranch ? result.sameBranch.available : []).map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: r.phone || null,
        status: 'FREE',
        reason: null,
        isSameBranch: true
    }));

    const otherBranchCandidates = (result.otherBranches ? result.otherBranches.available : []).map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: r.phone || null,
        status: 'FREE',
        reason: null,
        isSameBranch: false
    }));

    // Status Overview table (Same branch all states + Other branch FREE candidates)
    const busyMap = new Map();
    result.busy.forEach(b => {
        if (b.faculty) busyMap.set(b.faculty.toUpperCase(), b);
        if (b.facultyId) busyMap.set(String(b.facultyId), b);
    });

    const activeFaculty = engine.getFaculty().filter(f => f.status !== 'inactive');
    const branchFaculty = activeFaculty.filter(f =>
        !priorityBranch || (f.department || '').toUpperCase() === priorityBranch.toUpperCase()
    );

    const facultyOverview = [];
    branchFaculty.forEach(f => {
        const nameUpper = (f.name || '').toUpperCase();
        const idStr = String(f.id || '');
        const isAbsent = absentFacultyNamesSet.has(nameUpper) || absentFacultyIdsSet.has(idStr);

        if (isAbsent) {
            facultyOverview.push({
                facultyId: f.id,
                id: f.id,
                facultyName: f.name,
                name: f.name,
                department: f.department,
                branch: f.department,
                status: 'ABSENT',
                reason: null,
                isSameBranch: true
            });
        } else {
            const bRec = busyMap.get(nameUpper) || busyMap.get(idStr);
            if (bRec) {
                facultyOverview.push({
                    facultyId: f.id,
                    id: f.id,
                    facultyName: f.name,
                    name: f.name,
                    department: f.department,
                    branch: f.department,
                    subject: bRec.subject || null,
                    className: bRec.className || null,
                    room: bRec.room || null,
                    status: 'BUSY',
                    reason: bRec.isInvigilation ? 'INVIGILATION' : 'TEACHING',
                    isInvigilation: Boolean(bRec.isInvigilation),
                    isSameBranch: true
                });
            } else {
                facultyOverview.push({
                    facultyId: f.id,
                    id: f.id,
                    facultyName: f.name,
                    name: f.name,
                    department: f.department,
                    branch: f.department,
                    status: 'FREE',
                    reason: null,
                    isSameBranch: true
                });
            }
        }
    });

    facultyOverview.sort((a, b) => a.facultyName.localeCompare(b.facultyName));

    const fullFacultyList = [
        ...facultyOverview,
        ...otherBranchCandidates.map(c => ({
            facultyId: c.facultyId,
            id: c.id,
            facultyName: c.facultyName,
            name: c.name,
            department: c.department,
            branch: c.branch,
            status: 'FREE',
            reason: null,
            isSameBranch: false
        }))
    ];

    res.json({
        date: requestedDate,
        day: slot.day,
        period: slot.period,
        branch: branchCode,
        priorityBranch: priorityBranch,
        class: input.class || input.className || null,
        section: input.section || null,
        candidates: candidates,
        sameBranch: {
            branch: priorityBranch,
            candidates: sameBranchCandidates,
            totalCandidates: sameBranchCandidates.length
        },
        otherBranches: {
            candidates: otherBranchCandidates,
            totalCandidates: otherBranchCandidates.length
        },
        faculty: fullFacultyList,
        totalCandidates: candidates.length,
        totalSameBranch: sameBranchCandidates.length,
        totalOtherBranches: otherBranchCandidates.length,
        readOnly: true
    });
}

router.get('/candidates', requireHOSCandidateAccess, (req, res, next) => handleCandidates(req, req.query || {}, res).catch(next));
router.post('/candidates', requireHOSCandidateAccess, (req, res, next) => handleCandidates(req, req.body || {}, res).catch(next));
router.post('/hos', requireHOS, (req, res, next) => handle(req, req.body || {}, res, true).catch(next));
router.get('/hos', requireHOS, (req, res, next) => handle(req, req.query || {}, res, true).catch(next));
router.post('/', (req, res, next) => handle(req, req.body || {}, res).catch(next));
router.get('/', (req, res, next) => handle(req, req.query || {}, res).catch(next));
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
