/**
 * Exam Invigilation Store & Service (Phase B7.3).
 *
 * Implements:
 *   - Workflow A: Head of Section (HOS) direct invigilation assignment
 *   - Workflow B: Faculty invigilation request submission and HOS approval/rejection
 *   - Invigilation != Absence: faculty with invigilation are PRESENT in college, but BUSY during selected periods
 *   - Dynamic period support: periods validated against configured timetable periods
 *   - Strict conflict gates:
 *       * Reject if timetable teaching class exists at date (day of week) + period (FACULTY_PERIOD_CONFLICT, 409)
 *       * Reject if duplicate invigilation exists at date + period (DUPLICATE_INVIGILATION, 409)
 *       * Timetable is NEVER silently overwritten or altered
 *   - Strict branch-level isolation (HOS can manage only their branch faculty)
 *   - Read-only self-view for faculty members
 *   - Timezone-safe UTC date handling (YYYY-MM-DD)
 *   - Dual-mode: PostgreSQL-backed when configured, in-memory store for standalone/tests
 */
const crypto = require('crypto');
const db = require('../db/pool');
const repository = require('../db/repository');
const store = require('./store');

let inMemoryRequests = [];
let inMemoryActive = [];

function generateId(prefix = 'inv') {
    return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Strict UTC calendar date parser (YYYY-MM-DD).
 * Eliminates timezone conversion errors and date shifting.
 */
function parseDateString(str) {
    if (!str || typeof str !== 'string') return null;
    const trimmed = str.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const [_, yStr, mStr, dStr] = match;
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    const day = parseInt(dStr, 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    const dateObj = new Date(Date.UTC(year, month - 1, day));
    if (dateObj.getUTCFullYear() !== year || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCDate() !== day) {
        return null;
    }

    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
        dateStr: `${yStr}-${mStr}-${dStr}`,
        year,
        month,
        day,
        dayOfWeek: daysOfWeek[dateObj.getUTCDay()]
    };
}

/**
 * Returns currently configured timetable periods dynamically.
 * Never hardcodes [1,2,3,4,5,6,7].
 */
function getConfiguredPeriods() {
    if (store.engine && typeof store.engine.getPeriods === 'function') {
        const p = store.engine.getPeriods();
        if (Array.isArray(p) && p.length > 0) return p.slice();
    }
    if (store.meta && Array.isArray(store.meta.periods) && store.meta.periods.length > 0) {
        return store.meta.periods.slice();
    }
    return [1, 2, 3, 4, 5, 6, 7];
}

/**
 * Validate and normalize period input into a sorted array of unique integers.
 */
function normalizePeriods(rawPeriods) {
    let list = [];
    if (Array.isArray(rawPeriods)) {
        list = rawPeriods;
    } else if (typeof rawPeriods === 'number' || typeof rawPeriods === 'string') {
        list = [rawPeriods];
    } else {
        const err = new Error('Periods must be a period number or array of period numbers.');
        err.status = 400; err.code = 'INVALID_PERIODS';
        throw err;
    }

    if (list.length === 0) {
        const err = new Error('At least one period must be selected.');
        err.status = 400; err.code = 'INVALID_PERIODS';
        throw err;
    }

    const configured = getConfiguredPeriods();
    const parsed = [];
    for (const p of list) {
        const num = parseInt(p, 10);
        if (isNaN(num) || !configured.includes(num)) {
            const err = new Error(`Period "${p}" is invalid. Configured periods are: ${configured.join(', ')}.`);
            err.status = 400; err.code = 'INVALID_PERIOD';
            throw err;
        }
        if (!parsed.includes(num)) {
            parsed.push(num);
        }
    }
    return parsed.sort((a, b) => a - b);
}

/**
 * Find a faculty member by ID, code, or name across the engine roster.
 */
function findFaculty(needle) {
    if (!needle) return null;
    const str = String(needle).trim().toUpperCase();
    const roster = store.engine ? store.engine.getFaculty() : [];
    return roster.find(f =>
        (f.id && String(f.id).toUpperCase() === str) ||
        (f.code && String(f.code).toUpperCase() === str) ||
        (f.name && f.name.toUpperCase() === str)
    ) || null;
}

/**
 * Check if a faculty member has a timetable teaching conflict on a given day of the week and period.
 * Does NOT modify the timetable.
 */
function checkTimetableConflict(faculty, dayOfWeek, period) {
    if (!store.engine || typeof store.engine.getSlot !== 'function') return null;
    const slot = store.engine.getSlot(dayOfWeek, period);
    if (!slot || !Array.isArray(slot.busy)) return null;

    const facName = (faculty.name || '').trim().toUpperCase();
    const facId = faculty.id ? String(faculty.id).trim().toUpperCase() : null;

    const busyClass = slot.busy.find(b => {
        const bName = (b.faculty || '').trim().toUpperCase();
        const bId = b.facultyId ? String(b.facultyId).trim().toUpperCase() : null;
        return (bName && bName === facName) || (bId && facId && bId === facId);
    });

    return busyClass || null;
}

/**
 * Check if a faculty member already has an active invigilation assignment on a given date and period.
 */
async function checkDuplicateInvigilation(faculty, dateStr, period) {
    const facName = (faculty.name || '').trim().toUpperCase();
    const facId = faculty.id ? String(faculty.id).trim().toUpperCase() : null;

    if (db.isConfigured() && store.usingDatabase) {
        let dbFacultyId = faculty.id;
        if (isNaN(parseInt(dbFacultyId, 10))) {
            try {
                const { rows } = await db.query(
                    'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($1)',
                    [faculty.name]
                );
                if (rows.length > 0) dbFacultyId = rows[0].id;
            } catch (_) {}
        }
        const active = await repository.listActiveInvigilation({ examDate: dateStr, period: period, facultyId: dbFacultyId });
        return active.length > 0;
    }

    return inMemoryActive.some(a =>
        a.examDate === dateStr &&
        a.period === period &&
        ((facId && String(a.facultyId).toUpperCase() === facId) ||
         (a.facultyName && a.facultyName.toUpperCase() === facName))
    );
}

/**
 * Workflow A: HOS directly creates active invigilation assignments.
 * Assigned immediately without pending request state.
 */
async function createDirectAssignment({ facultyIdentifier, date, periods, notes, sessionUser }) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role === 'faculty') {
        const err = new Error('Faculty members cannot directly create active invigilation assignments. Submit an invigilation request instead.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const hosBranch = String(sessionUser.department || '').trim().toUpperCase();
    if (!hosBranch) {
        const err = new Error('HOS session does not have an active branch context.');
        err.status = 400; err.code = 'MISSING_BRANCH_CONTEXT';
        throw err;
    }

    const parsedDate = parseDateString(date);
    if (!parsedDate) {
        const err = new Error(`Invalid date format "${date}". Expected YYYY-MM-DD.`);
        err.status = 400; err.code = 'INVALID_DATE';
        throw err;
    }

    const periodList = normalizePeriods(periods);
    const faculty = findFaculty(facultyIdentifier);
    if (!faculty) {
        const err = new Error(`Faculty "${facultyIdentifier}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    if (faculty.status === 'inactive') {
        const err = new Error(`Cannot assign invigilation to inactive faculty member "${faculty.name}".`);
        err.status = 400; err.code = 'FACULTY_INACTIVE';
        throw err;
    }

    const facultyBranch = String(faculty.department || '').trim().toUpperCase();
    if (facultyBranch && facultyBranch !== hosBranch) {
        const err = new Error(`Cross-branch invigilation assignment is forbidden. Faculty belongs to ${facultyBranch}, but your branch is ${hosBranch}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    // Atomic Conflict & Duplicate Checks across ALL requested periods
    for (const p of periodList) {
        // 1. Timetable teaching conflict
        const timetableConflict = checkTimetableConflict(faculty, parsedDate.dayOfWeek, p);
        if (timetableConflict) {
            const err = new Error(
                `FACULTY_PERIOD_CONFLICT: Faculty "${faculty.name}" already has a timetable class on ${parsedDate.dayOfWeek} period ${p} (${timetableConflict.subject || 'Teaching'} for ${timetableConflict.className || 'class'}).`
            );
            err.status = 409;
            err.code = 'FACULTY_PERIOD_CONFLICT';
            err.conflict = {
                dayOfWeek: parsedDate.dayOfWeek,
                period: p,
                subject: timetableConflict.subject,
                className: timetableConflict.className
            };
            throw err;
        }

        // 2. Duplicate active invigilation
        const hasDuplicate = await checkDuplicateInvigilation(faculty, parsedDate.dateStr, p);
        if (hasDuplicate) {
            const err = new Error(
                `DUPLICATE_INVIGILATION: Faculty "${faculty.name}" already has an active invigilation assignment on ${parsedDate.dateStr} period ${p}.`
            );
            err.status = 409;
            err.code = 'DUPLICATE_INVIGILATION';
            throw err;
        }
    }

    const assignedBy = sessionUser.username || sessionUser.name || 'HOS';
    const now = new Date().toISOString();
    const createdAssignments = [];

    // Database mode
    if (db.isConfigured() && store.usingDatabase) {
        let dbFacultyId = faculty.id;
        if (isNaN(parseInt(dbFacultyId, 10))) {
            try {
                const { rows } = await db.query(
                    'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($1)',
                    [faculty.name]
                );
                if (rows.length > 0) dbFacultyId = rows[0].id;
            } catch (_) {}
        }

        for (const p of periodList) {
            const rec = await repository.createActiveInvigilation({
                facultyId: dbFacultyId,
                branchCode: facultyBranch || hosBranch,
                examDate: parsedDate.dateStr,
                period: p,
                source: 'DIRECT',
                requestId: null,
                assignedBy,
                notes: notes || null
            });
            createdAssignments.push({
                id: rec.id,
                facultyId: faculty.id,
                facultyName: faculty.name,
                facultyCode: faculty.code || null,
                branchCode: facultyBranch || hosBranch,
                examDate: parsedDate.dateStr,
                dayOfWeek: parsedDate.dayOfWeek,
                period: p,
                source: 'DIRECT',
                assignedBy,
                notes: notes || null,
                createdAt: rec.createdAt
            });
        }
        return createdAssignments;
    }

    // In-memory mode
    for (const p of periodList) {
        const item = {
            id: generateId('inv_act'),
            facultyId: faculty.id,
            facultyName: faculty.name,
            facultyCode: faculty.code || null,
            branchCode: facultyBranch || hosBranch,
            examDate: parsedDate.dateStr,
            dayOfWeek: parsedDate.dayOfWeek,
            period: p,
            source: 'DIRECT',
            requestId: null,
            assignedBy,
            notes: notes || null,
            createdAt: now,
            updatedAt: now
        };
        inMemoryActive.push(item);
        createdAssignments.push(item);
    }
    return createdAssignments;
}

/**
 * Workflow B: Faculty submits an invigilation request.
 * Starts in PENDING status. Does NOT create active invigilation records.
 */
async function submitInvigilationRequest({ date, periods, reason, sessionUser }) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role !== 'faculty') {
        const err = new Error('Only faculty members can submit invigilation requests. HOS can use direct assignment.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const parsedDate = parseDateString(date);
    if (!parsedDate) {
        const err = new Error(`Invalid date format "${date}". Expected YYYY-MM-DD.`);
        err.status = 400; err.code = 'INVALID_DATE';
        throw err;
    }

    const periodList = normalizePeriods(periods);

    // Identify the authenticated faculty member
    const facultyIdentifier = sessionUser.facultyId || sessionUser.facultyName || sessionUser.name || sessionUser.username;
    const faculty = findFaculty(facultyIdentifier);
    if (!faculty) {
        const err = new Error(`Your faculty profile could not be located in the faculty roster.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    if (faculty.status === 'inactive') {
        const err = new Error(`Inactive faculty accounts cannot submit invigilation requests.`);
        err.status = 403; err.code = 'FACULTY_INACTIVE';
        throw err;
    }

    const facultyBranch = String(faculty.department || sessionUser.department || '').trim().toUpperCase();

    // Early conflict checking for transparent feedback to faculty
    for (const p of periodList) {
        const timetableConflict = checkTimetableConflict(faculty, parsedDate.dayOfWeek, p);
        if (timetableConflict) {
            const err = new Error(
                `FACULTY_PERIOD_CONFLICT: You have a scheduled teaching class on ${parsedDate.dayOfWeek} period ${p} (${timetableConflict.subject || 'Teaching'} for ${timetableConflict.className || 'class'}).`
            );
            err.status = 409;
            err.code = 'FACULTY_PERIOD_CONFLICT';
            err.conflict = {
                dayOfWeek: parsedDate.dayOfWeek,
                period: p,
                subject: timetableConflict.subject,
                className: timetableConflict.className
            };
            throw err;
        }

        const hasDuplicate = await checkDuplicateInvigilation(faculty, parsedDate.dateStr, p);
        if (hasDuplicate) {
            const err = new Error(
                `DUPLICATE_INVIGILATION: You already have an active invigilation assignment on ${parsedDate.dateStr} period ${p}.`
            );
            err.status = 409;
            err.code = 'DUPLICATE_INVIGILATION';
            throw err;
        }
    }

    const now = new Date().toISOString();

    // Database mode
    if (db.isConfigured() && store.usingDatabase) {
        let dbFacultyId = faculty.id;
        if (isNaN(parseInt(dbFacultyId, 10))) {
            try {
                const { rows } = await db.query(
                    'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($1)',
                    [faculty.name]
                );
                if (rows.length > 0) dbFacultyId = rows[0].id;
            } catch (_) {}
        }

        const rec = await repository.createInvigilationRequest({
            facultyId: dbFacultyId,
            branchCode: facultyBranch,
            examDate: parsedDate.dateStr,
            periods: periodList,
            reason: reason || null
        });

        return {
            id: rec.id,
            facultyId: faculty.id,
            facultyName: faculty.name,
            facultyCode: faculty.code || null,
            branchCode: facultyBranch,
            examDate: parsedDate.dateStr,
            dayOfWeek: parsedDate.dayOfWeek,
            periods: periodList,
            reason: reason || null,
            status: 'PENDING',
            reviewedBy: null,
            reviewedAt: null,
            rejectionReason: null,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt
        };
    }

    // In-memory mode
    const request = {
        id: generateId('inv_req'),
        facultyId: faculty.id,
        facultyName: faculty.name,
        facultyCode: faculty.code || null,
        branchCode: facultyBranch,
        examDate: parsedDate.dateStr,
        dayOfWeek: parsedDate.dayOfWeek,
        periods: periodList,
        reason: reason || null,
        status: 'PENDING',
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: now,
        updatedAt: now
    };
    inMemoryRequests.push(request);
    return request;
}

/**
 * List invigilation requests for an HOS's branch.
 * Enforces branch isolation.
 */
async function listBranchRequests(branchCode, status = null) {
    const branch = String(branchCode || '').trim().toUpperCase();
    if (!branch) return [];

    if (db.isConfigured() && store.usingDatabase) {
        const rows = await repository.listInvigilationRequests({ branchCode: branch, status: status ? status.toUpperCase() : null });
        return rows.map(r => {
            const pDate = parseDateString(r.examDate instanceof Date ? r.examDate.toISOString().slice(0, 10) : String(r.examDate));
            return {
                id: r.id,
                facultyId: r.facultyId,
                facultyName: r.facultyName,
                facultyCode: r.facultyCode || null,
                branchCode: r.branchCode,
                examDate: pDate ? pDate.dateStr : r.examDate,
                dayOfWeek: pDate ? pDate.dayOfWeek : null,
                periods: r.periods,
                reason: r.reason,
                status: r.status,
                reviewedBy: r.reviewedBy,
                reviewedAt: r.reviewedAt,
                rejectionReason: r.rejectionReason,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt
            };
        });
    }

    return inMemoryRequests
        .filter(r => r.branchCode.toUpperCase() === branch && (!status || r.status.toUpperCase() === status.toUpperCase()))
        .map(r => ({ ...r }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Approve a pending invigilation request.
 * Creates active invigilation assignments for each period and marks request APPROVED.
 * Enforces HOS branch ownership and prevents duplicate approvals.
 */
async function approveRequest(requestId, sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role === 'faculty') {
        const err = new Error('Faculty members cannot approve invigilation requests. This action requires Head of Section (HOS) role.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const hosBranch = String(sessionUser.department || '').trim().toUpperCase();
    if (!hosBranch) {
        const err = new Error('HOS session does not have an active branch context.');
        err.status = 400; err.code = 'MISSING_BRANCH_CONTEXT';
        throw err;
    }

    let request = null;

    if (db.isConfigured() && store.usingDatabase) {
        request = await repository.getInvigilationRequestById(requestId);
    } else {
        request = inMemoryRequests.find(r => String(r.id) === String(requestId));
    }

    if (!request) {
        const err = new Error(`Invigilation request "${requestId}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    if (String(request.branchCode).toUpperCase() !== hosBranch) {
        const err = new Error(`Cross-branch request review is forbidden. Request belongs to ${request.branchCode}, but your branch is ${hosBranch}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    if (request.status === 'APPROVED') {
        const err = new Error('Request has already been approved.');
        err.status = 400; err.code = 'ALREADY_APPROVED';
        throw err;
    }

    if (request.status === 'REJECTED') {
        const err = new Error('Cannot approve a request that has already been rejected.');
        err.status = 400; err.code = 'INVALID_REQUEST_STATE';
        throw err;
    }

    const faculty = findFaculty(request.facultyId || request.facultyName);
    if (!faculty) {
        const err = new Error(`Associated faculty record could not be found.`);
        err.status = 404; err.code = 'FACULTY_NOT_FOUND';
        throw err;
    }

    const dateStr = request.examDate instanceof Date ? request.examDate.toISOString().slice(0, 10) : String(request.examDate);
    const parsedDate = parseDateString(dateStr);
    const periods = Array.isArray(request.periods) ? request.periods : [];
    const reviewedBy = sessionUser.username || sessionUser.name || 'HOS';
    const now = new Date().toISOString();

    // Check conflicts before approving
    for (const p of periods) {
        const timetableConflict = checkTimetableConflict(faculty, parsedDate.dayOfWeek, p);
        if (timetableConflict) {
            const err = new Error(
                `FACULTY_PERIOD_CONFLICT: Faculty "${faculty.name}" already has a timetable class on ${parsedDate.dayOfWeek} period ${p} (${timetableConflict.subject || 'Teaching'} for ${timetableConflict.className || 'class'}).`
            );
            err.status = 409;
            err.code = 'FACULTY_PERIOD_CONFLICT';
            err.conflict = {
                dayOfWeek: parsedDate.dayOfWeek,
                period: p,
                subject: timetableConflict.subject,
                className: timetableConflict.className
            };
            throw err;
        }

        const hasDuplicate = await checkDuplicateInvigilation(faculty, parsedDate.dateStr, p);
        if (hasDuplicate) {
            const err = new Error(
                `DUPLICATE_INVIGILATION: Faculty "${faculty.name}" already has an active invigilation assignment on ${parsedDate.dateStr} period ${p}.`
            );
            err.status = 409;
            err.code = 'DUPLICATE_INVIGILATION';
            throw err;
        }
    }

    const createdAssignments = [];

    // Database mode
    if (db.isConfigured() && store.usingDatabase) {
        let dbFacultyId = faculty.id;
        if (isNaN(parseInt(dbFacultyId, 10))) {
            try {
                const { rows } = await db.query(
                    'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($1)',
                    [faculty.name]
                );
                if (rows.length > 0) dbFacultyId = rows[0].id;
            } catch (_) {}
        }

        for (const p of periods) {
            const rec = await repository.createActiveInvigilation({
                facultyId: dbFacultyId,
                branchCode: request.branchCode,
                examDate: parsedDate.dateStr,
                period: p,
                source: 'REQUEST',
                requestId: request.id,
                assignedBy: reviewedBy,
                notes: request.reason || null
            });
            createdAssignments.push(rec);
        }

        const updatedReq = await repository.updateInvigilationRequestStatus(request.id, {
            status: 'APPROVED',
            reviewedBy,
            rejectionReason: null
        });

        return {
            success: true,
            request: {
                ...updatedReq,
                facultyName: faculty.name,
                examDate: parsedDate.dateStr,
                dayOfWeek: parsedDate.dayOfWeek
            },
            assignments: createdAssignments
        };
    }

    // In-memory mode
    for (const p of periods) {
        const item = {
            id: generateId('inv_act'),
            facultyId: faculty.id,
            facultyName: faculty.name,
            facultyCode: faculty.code || null,
            branchCode: request.branchCode,
            examDate: parsedDate.dateStr,
            dayOfWeek: parsedDate.dayOfWeek,
            period: p,
            source: 'REQUEST',
            requestId: request.id,
            assignedBy: reviewedBy,
            notes: request.reason || null,
            createdAt: now,
            updatedAt: now
        };
        inMemoryActive.push(item);
        createdAssignments.push(item);
    }

    request.status = 'APPROVED';
    request.reviewedBy = reviewedBy;
    request.reviewedAt = now;
    request.updatedAt = now;

    return {
        success: true,
        request: { ...request },
        assignments: createdAssignments
    };
}

/**
 * Reject a pending invigilation request.
 * Marks request REJECTED without creating active invigilation records.
 * Enforces HOS branch ownership.
 */
async function rejectRequest(requestId, rejectionReason = null, sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role === 'faculty') {
        const err = new Error('Faculty members cannot reject invigilation requests.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const hosBranch = String(sessionUser.department || '').trim().toUpperCase();
    if (!hosBranch) {
        const err = new Error('HOS session does not have an active branch context.');
        err.status = 400; err.code = 'MISSING_BRANCH_CONTEXT';
        throw err;
    }

    let request = null;

    if (db.isConfigured() && store.usingDatabase) {
        request = await repository.getInvigilationRequestById(requestId);
    } else {
        request = inMemoryRequests.find(r => String(r.id) === String(requestId));
    }

    if (!request) {
        const err = new Error(`Invigilation request "${requestId}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    if (String(request.branchCode).toUpperCase() !== hosBranch) {
        const err = new Error(`Cross-branch request review is forbidden. Request belongs to ${request.branchCode}, but your branch is ${hosBranch}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    if (request.status === 'REJECTED') {
        const err = new Error('Request has already been rejected.');
        err.status = 400; err.code = 'ALREADY_REJECTED';
        throw err;
    }

    if (request.status === 'APPROVED') {
        const err = new Error('Cannot reject a request that has already been approved.');
        err.status = 400; err.code = 'ALREADY_APPROVED';
        throw err;
    }

    const reviewedBy = sessionUser.username || sessionUser.name || 'HOS';
    const now = new Date().toISOString();

    if (db.isConfigured() && store.usingDatabase) {
        const updatedReq = await repository.updateInvigilationRequestStatus(request.id, {
            status: 'REJECTED',
            reviewedBy,
            rejectionReason: rejectionReason || null
        });
        return {
            success: true,
            request: updatedReq
        };
    }

    request.status = 'REJECTED';
    request.reviewedBy = reviewedBy;
    request.reviewedAt = now;
    request.rejectionReason = rejectionReason || null;
    request.updatedAt = now;

    return {
        success: true,
        request: { ...request }
    };
}

/**
 * List active invigilation assignments for a branch.
 * Enforces branch isolation for HOS.
 */
async function listBranchAssignments(branchCode, date = null, period = null) {
    const branch = String(branchCode || '').trim().toUpperCase();
    if (!branch) return [];

    let dateStr = null;
    if (date) {
        const pDate = parseDateString(date);
        if (pDate) dateStr = pDate.dateStr;
    }

    const periodNum = period != null && period !== '' ? parseInt(period, 10) : null;

    if (db.isConfigured() && store.usingDatabase) {
        const rows = await repository.listActiveInvigilation({
            branchCode: branch,
            examDate: dateStr,
            period: periodNum
        });
        return rows.map(r => {
            const pDate = parseDateString(r.examDate instanceof Date ? r.examDate.toISOString().slice(0, 10) : String(r.examDate));
            return {
                id: r.id,
                facultyId: r.facultyId,
                facultyName: r.facultyName,
                facultyCode: r.facultyCode || null,
                branchCode: r.branchCode,
                examDate: pDate ? pDate.dateStr : r.examDate,
                dayOfWeek: pDate ? pDate.dayOfWeek : null,
                period: r.period,
                source: r.source,
                requestId: r.requestId,
                assignedBy: r.assignedBy,
                notes: r.notes,
                createdAt: r.createdAt
            };
        });
    }

    return inMemoryActive
        .filter(a => {
            if (a.branchCode.toUpperCase() !== branch) return false;
            if (dateStr && a.examDate !== dateStr) return false;
            if (periodNum != null && a.period !== periodNum) return false;
            return true;
        })
        .map(a => ({ ...a }))
        .sort((a, b) => a.examDate.localeCompare(b.examDate) || a.period - b.period);
}

/**
 * Delete / unassign an active invigilation assignment.
 * HOS only. Enforces branch isolation.
 */
async function deleteAssignment(id, sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role === 'faculty') {
        const err = new Error('Faculty members cannot delete invigilation assignments.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const hosBranch = String(sessionUser.department || '').trim().toUpperCase();

    if (db.isConfigured() && store.usingDatabase) {
        const deleted = await repository.deleteActiveInvigilation(id, hosBranch);
        if (!deleted) {
            const err = new Error(`Invigilation assignment "${id}" not found or unauthorized.`);
            err.status = 404; err.code = 'NOT_FOUND';
            throw err;
        }
        return { success: true, id: deleted.id };
    }

    const idx = inMemoryActive.findIndex(a => String(a.id) === String(id));
    if (idx === -1) {
        const err = new Error(`Invigilation assignment "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const item = inMemoryActive[idx];
    if (item.branchCode.toUpperCase() !== hosBranch) {
        const err = new Error(`Cross-branch assignment deletion is forbidden. Assignment belongs to ${item.branchCode}, but your branch is ${hosBranch}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    inMemoryActive.splice(idx, 1);
    return { success: true, id: item.id };
}

/**
 * Returns read-only invigilation records and requests for the authenticated faculty member.
 */
async function getMyInvigilation(sessionUser) {
    if (!sessionUser) {
        const err = new Error('Sign in to view your invigilation assignments.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const targetName = (sessionUser.facultyName || sessionUser.name || '').trim().toUpperCase();
    const targetId = sessionUser.facultyId ? String(sessionUser.facultyId).trim().toUpperCase() : null;

    if (db.isConfigured() && store.usingDatabase) {
        const faculty = findFaculty(targetId || targetName);
        let dbFacultyId = faculty ? faculty.id : null;
        if (dbFacultyId && isNaN(parseInt(dbFacultyId, 10))) {
            try {
                const { rows } = await db.query(
                    'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($1)',
                    [faculty.name]
                );
                if (rows.length > 0) dbFacultyId = rows[0].id;
            } catch (_) {}
        }

        const assignments = dbFacultyId ? await repository.listActiveInvigilation({ facultyId: dbFacultyId }) : [];
        const requests = dbFacultyId ? await repository.listInvigilationRequests({ facultyId: dbFacultyId }) : [];

        return {
            facultyName: sessionUser.facultyName || sessionUser.name,
            assignments: assignments.map(a => {
                const pDate = parseDateString(a.examDate instanceof Date ? a.examDate.toISOString().slice(0, 10) : String(a.examDate));
                return {
                    id: a.id,
                    examDate: pDate ? pDate.dateStr : a.examDate,
                    dayOfWeek: pDate ? pDate.dayOfWeek : null,
                    period: a.period,
                    source: a.source,
                    assignedBy: a.assignedBy,
                    notes: a.notes,
                    createdAt: a.createdAt
                };
            }),
            requests: requests.map(r => {
                const pDate = parseDateString(r.examDate instanceof Date ? r.examDate.toISOString().slice(0, 10) : String(r.examDate));
                return {
                    id: r.id,
                    examDate: pDate ? pDate.dateStr : r.examDate,
                    dayOfWeek: pDate ? pDate.dayOfWeek : null,
                    periods: r.periods,
                    reason: r.reason,
                    status: r.status,
                    reviewedBy: r.reviewedBy,
                    reviewedAt: r.reviewedAt,
                    rejectionReason: r.rejectionReason,
                    createdAt: r.createdAt
                };
            })
        };
    }

    const myAssignments = inMemoryActive
        .filter(a =>
            (targetId && String(a.facultyId).toUpperCase() === targetId) ||
            (a.facultyName && a.facultyName.toUpperCase() === targetName)
        )
        .map(a => ({
            id: a.id,
            examDate: a.examDate,
            dayOfWeek: a.dayOfWeek,
            period: a.period,
            source: a.source,
            assignedBy: a.assignedBy,
            notes: a.notes,
            createdAt: a.createdAt
        }))
        .sort((a, b) => a.examDate.localeCompare(b.examDate) || a.period - b.period);

    const myRequests = inMemoryRequests
        .filter(r =>
            (targetId && String(r.facultyId).toUpperCase() === targetId) ||
            (r.facultyName && r.facultyName.toUpperCase() === targetName)
        )
        .map(r => ({
            id: r.id,
            examDate: r.examDate,
            dayOfWeek: r.dayOfWeek,
            periods: r.periods,
            reason: r.reason,
            status: r.status,
            reviewedBy: r.reviewedBy,
            reviewedAt: r.reviewedAt,
            rejectionReason: r.rejectionReason,
            createdAt: r.createdAt
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return {
        facultyName: sessionUser.facultyName || sessionUser.name,
        assignments: myAssignments,
        requests: myRequests
    };
}

/**
 * Returns all active invigilations across all branches on a given date and period.
 * Used by the availability engine to mark faculty BUSY for invigilation.
 */
async function getActiveInvigilationsOnDate(date, period = null) {
    if (!date) return [];
    const parsedDate = parseDateString(date);
    if (!parsedDate) return [];

    const dateStr = parsedDate.dateStr;
    const periodNum = period != null ? parseInt(period, 10) : null;

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const rows = await repository.listActiveInvigilation({
                examDate: dateStr,
                period: periodNum
            });
            return rows.map(r => ({
                id: r.id,
                facultyId: r.facultyId,
                name: r.facultyName,
                code: r.facultyCode,
                branchCode: r.branchCode,
                period: r.period,
                notes: r.notes
            }));
        } catch (_) {}
    }

    return inMemoryActive
        .filter(a => a.examDate === dateStr && (periodNum == null || a.period === periodNum))
        .map(a => ({
            id: a.id,
            facultyId: a.facultyId,
            name: a.facultyName,
            code: a.facultyCode,
            branchCode: a.branchCode,
            period: a.period,
            notes: a.notes
        }));
}

/**
 * Resets in-memory invigilation records for clean test isolation.
 */
function resetForTesting() {
    inMemoryRequests = [];
    inMemoryActive = [];
}

module.exports = {
    parseDateString,
    getConfiguredPeriods,
    normalizePeriods,
    findFaculty,
    checkTimetableConflict,
    checkDuplicateInvigilation,
    createDirectAssignment,
    submitInvigilationRequest,
    listBranchRequests,
    approveRequest,
    rejectRequest,
    listBranchAssignments,
    deleteAssignment,
    getMyInvigilation,
    getActiveInvigilationsOnDate,
    resetForTesting
};
