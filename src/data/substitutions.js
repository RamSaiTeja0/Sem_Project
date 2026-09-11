/**
 * Faculty Substitution Store & Service (Phase B7.5).
 *
 * Implements:
 *   - Peer-to-peer faculty-to-faculty substitution workflow
 *   - Absent Faculty A selects FREE substitute candidate (Faculty B)
 *   - Substitution request created in PENDING status
 *   - Faculty B explicitly ACCEPTS or REJECTS
 *   - Critical: Acceptance performs fresh real-time availability revalidation
 *   - Strict double-booking prevention: faculty cannot accept multiple substitutions for the same date + period
 *   - Strict no-HOS-approval: HOS cannot choose, assign, approve, or accept substitutions
 *   - Zero timetable destruction: original timetable entries remain 100% intact
 *   - Standalone in-memory store for standalone/tests (ready for future PostgreSQL integration)
 */
const crypto = require('crypto');
const db = require('../db/pool');
const repository = require('../db/repository');
const store = require('./store');
const attendance = require('./attendance');
const invigilation = require('./invigilation');

// In-memory substitutions store:
// Array of {
//   id, date, dayOfWeek, period, className, subject, room,
//   originalFacultyId, originalFacultyName, originalFacultyBranch,
//   substituteFacultyId, substituteFacultyName, substituteFacultyBranch,
//   requestedBy, status, rejectionReason, createdAt, respondedAt, cancelledAt
// }
let inMemorySubstitutions = [];

function syncFromDatabase(records = []) {
    if (!Array.isArray(records)) return;
    for (const rec of records) {
        const idx = inMemorySubstitutions.findIndex(s => String(s.id) === String(rec.id));
        const item = {
            id: rec.id,
            date: rec.date ? (typeof rec.date === 'string' ? rec.date.slice(0, 10) : rec.date.toISOString().slice(0, 10)) : rec.date,
            dayOfWeek: rec.dayOfWeek || rec.day_of_week,
            period: parseInt(rec.period, 10),
            className: rec.className || rec.class_name || null,
            subject: rec.subject || null,
            room: rec.room || null,
            originalFacultyId: rec.originalFacultyId || rec.original_faculty_id,
            originalFacultyName: rec.originalFacultyName || rec.original_faculty_name,
            originalFacultyBranch: rec.originalFacultyBranch || rec.original_faculty_branch,
            substituteFacultyId: rec.substituteFacultyId || rec.substitute_faculty_id,
            substituteFacultyName: rec.substituteFacultyName || rec.substitute_faculty_name,
            substituteFacultyBranch: rec.substituteFacultyBranch || rec.substitute_faculty_branch,
            requestedBy: rec.requestedBy || rec.requested_by,
            status: rec.status,
            rejectionReason: rec.rejectionReason || rec.rejection_reason || null,
            createdAt: rec.createdAt || rec.created_at,
            respondedAt: rec.respondedAt || rec.responded_at || null,
            cancelledAt: rec.cancelledAt || rec.cancelled_at || null
        };
        if (idx >= 0) inMemorySubstitutions[idx] = item;
        else inMemorySubstitutions.push(item);
    }
}

function generateId() {
    return 'sub_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
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
 * Check if a faculty member has an active teaching timetable conflict for a day of week and period.
 */
function findTeachingClass(faculty, dayOfWeek, period) {
    if (!faculty || !dayOfWeek || period == null) return null;
    const records = store.engine ? store.engine.getRecords() : [];
    const dayStr = dayOfWeek.trim().toUpperCase();
    const periodNum = parseInt(period, 10);
    const facName = faculty.name.trim().toUpperCase();
    const facId = faculty.id ? String(faculty.id).trim().toUpperCase() : null;

    return records.find(r =>
        r.status === 'busy' &&
        r.day && r.day.trim().toUpperCase() === dayStr &&
        r.period === periodNum &&
        ((r.faculty && r.faculty.trim().toUpperCase() === facName) ||
         (r.facultyId && String(r.facultyId).trim().toUpperCase() === facId))
    ) || null;
}

/**
 * Checks whether a faculty member already has an accepted substitution for a specific date and period.
 */
function hasAcceptedSubstitution(faculty, dateStr, period) {
    if (!faculty || !dateStr || period == null) return false;
    const periodNum = parseInt(period, 10);
    const facName = faculty.name.trim().toUpperCase();
    const facId = faculty.id ? String(faculty.id).trim().toUpperCase() : null;

    return inMemorySubstitutions.some(s =>
        s.status === 'ACCEPTED' &&
        s.date === dateStr &&
        s.period === periodNum &&
        ((s.substituteFacultyName && s.substituteFacultyName.trim().toUpperCase() === facName) ||
         (s.substituteFacultyId && String(s.substituteFacultyId).trim().toUpperCase() === facId))
    );
}

/**
 * Faculty A creates a substitution request for one of their vacant periods.
 */
async function createRequest({ date, period, className, subject, substituteFacultyId, substituteFacultyName, sessionUser }) {
    if (!sessionUser) {
        const err = new Error('Authentication required. Please sign in as faculty.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role !== 'faculty') {
        const err = new Error('Only faculty members can create substitution requests. HOS cannot create or assign substitutions.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    // 1. Resolve and validate Faculty A (the requester) strictly from authenticated session
    const facultyA = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    if (!facultyA) {
        const err = new Error('Authenticated user does not have an associated faculty record.');
        err.status = 404; err.code = 'FACULTY_NOT_FOUND';
        throw err;
    }

    if (facultyA.status === 'inactive') {
        const err = new Error('Your faculty account is deactivated.');
        err.status = 403; err.code = 'INACTIVE_FACULTY';
        throw err;
    }

    // 2. Validate date and period
    const parsedDate = attendance.parseDateString(date);
    if (!parsedDate) {
        const err = new Error(`Invalid date format "${date}". Expected YYYY-MM-DD.`);
        err.status = 400; err.code = 'INVALID_DATE';
        throw err;
    }

    const normPeriod = store.engine ? store.engine.normalizePeriod(period) : parseInt(period, 10);
    if (normPeriod == null || isNaN(normPeriod)) {
        const validPeriods = store.engine ? store.engine.getPeriods().join(', ') : '1..7';
        const err = new Error(`Unknown or missing period "${period}". Valid periods: ${validPeriods}`);
        err.status = 400; err.code = 'INVALID_PERIOD';
        throw err;
    }

    // 3. Verify Faculty A is actually marked ABSENT on that date
    const absentRecords = await attendance.getAbsentFacultyOnDate(parsedDate.dateStr);
    const isFacultyAAbsent = absentRecords.some(r =>
        (r.id && String(r.id) === String(facultyA.id)) ||
        (r.name && r.name.toUpperCase() === facultyA.name.toUpperCase())
    );

    if (!isFacultyAAbsent) {
        const err = new Error(`Faculty "${facultyA.name}" is not marked absent on ${parsedDate.dateStr}. Substitution requests can only be created for absent periods.`);
        err.status = 400; err.code = 'FACULTY_NOT_ABSENT';
        throw err;
    }

    // 4. Verify Faculty A actually has a scheduled timetable class during that slot
    const scheduledClass = findTeachingClass(facultyA, parsedDate.dayOfWeek, normPeriod);
    if (!scheduledClass) {
        const err = new Error(`Faculty "${facultyA.name}" has no scheduled class on ${parsedDate.dayOfWeek} period ${normPeriod}.`);
        err.status = 400; err.code = 'NO_SCHEDULED_CLASS';
        throw err;
    }

    if (className && scheduledClass.className && scheduledClass.className.trim().toUpperCase() !== className.trim().toUpperCase()) {
        const err = new Error(`Faculty "${facultyA.name}" teaches "${scheduledClass.className}" on ${parsedDate.dayOfWeek} period ${normPeriod}, not "${className}".`);
        err.status = 400; err.code = 'CLASS_MISMATCH';
        throw err;
    }

    const targetClass = scheduledClass.className;
    const targetSubject = subject || scheduledClass.subject || 'Teaching';
    const targetRoom = scheduledClass.room || null;

    // 5. Resolve and validate substitute candidate (Faculty B)
    const subIdentifier = substituteFacultyId || substituteFacultyName;
    if (!subIdentifier) {
        const err = new Error('Please select a substitute faculty member.');
        err.status = 400; err.code = 'MISSING_SUBSTITUTE';
        throw err;
    }

    const facultyB = findFaculty(subIdentifier);
    if (!facultyB) {
        const err = new Error(`Selected substitute faculty "${subIdentifier}" could not be found.`);
        err.status = 404; err.code = 'SUBSTITUTE_NOT_FOUND';
        throw err;
    }

    // Self-substitution check
    if (String(facultyB.id) === String(facultyA.id) || facultyB.name.toUpperCase() === facultyA.name.toUpperCase()) {
        const err = new Error('You cannot request yourself as a substitute.');
        err.status = 400; err.code = 'CANNOT_SUBSTITUTE_SELF';
        throw err;
    }

    // Faculty B must be ACTIVE
    if (facultyB.status === 'inactive') {
        const err = new Error(`Selected substitute "${facultyB.name}" is inactive.`);
        err.status = 400; err.code = 'SUBSTITUTE_INACTIVE';
        throw err;
    }

    // Faculty B must be PRESENT on this date
    const isFacultyBAbsent = absentRecords.some(r =>
        (r.id && String(r.id) === String(facultyB.id)) ||
        (r.name && r.name.toUpperCase() === facultyB.name.toUpperCase())
    );
    if (isFacultyBAbsent) {
        const err = new Error(`Selected substitute "${facultyB.name}" is marked absent on ${parsedDate.dateStr}.`);
        err.status = 400; err.code = 'SUBSTITUTE_NOT_PRESENT';
        throw err;
    }

    // Faculty B must NOT have a timetable teaching class
    const subTeaching = findTeachingClass(facultyB, parsedDate.dayOfWeek, normPeriod);
    if (subTeaching) {
        const err = new Error(`Selected substitute "${facultyB.name}" is teaching another class (${subTeaching.className} - ${subTeaching.subject}) during period ${normPeriod}.`);
        err.status = 400; err.code = 'SUBSTITUTE_NOT_FREE';
        throw err;
    }

    // Faculty B must NOT have exam invigilation
    const activeInvig = await invigilation.getActiveInvigilationsOnDate(parsedDate.dateStr, normPeriod);
    const hasInvig = activeInvig.some(i =>
        (i.facultyName && i.facultyName.toUpperCase() === facultyB.name.toUpperCase()) ||
        (i.facultyId && String(i.facultyId) === String(facultyB.id))
    );
    if (hasInvig) {
        const err = new Error(`Selected substitute "${facultyB.name}" is assigned to exam invigilation during period ${normPeriod}.`);
        err.status = 400; err.code = 'SUBSTITUTE_NOT_FREE';
        throw err;
    }

    // Faculty B must NOT already have an accepted substitution for this slot
    if (hasAcceptedSubstitution(facultyB, parsedDate.dateStr, normPeriod)) {
        const err = new Error(`Selected substitute "${facultyB.name}" has already accepted another substitution for period ${normPeriod}.`);
        err.status = 400; err.code = 'SUBSTITUTE_NOT_FREE';
        throw err;
    }

    // 6. Prevent duplicate substitution requests for the same slot
    const existingDuplicate = inMemorySubstitutions.find(s =>
        (s.status === 'PENDING' || s.status === 'ACCEPTED') &&
        s.date === parsedDate.dateStr &&
        s.period === normPeriod &&
        s.className.toUpperCase() === targetClass.toUpperCase() &&
        ((s.originalFacultyId && String(s.originalFacultyId) === String(facultyA.id)) ||
         (s.originalFacultyName && s.originalFacultyName.toUpperCase() === facultyA.name.toUpperCase()))
    );

    if (existingDuplicate) {
        const err = new Error(`A substitution request for ${targetClass} on ${parsedDate.dateStr} period ${normPeriod} is already ${existingDuplicate.status.toLowerCase()}.`);
        err.status = 409; err.code = 'DUPLICATE_SUBSTITUTION_REQUEST';
        throw err;
    }

    // 7. Create substitution record in PENDING status
    const newRecord = {
        id: generateId(),
        date: parsedDate.dateStr,
        dayOfWeek: parsedDate.dayOfWeek,
        period: normPeriod,
        className: targetClass,
        subject: targetSubject,
        room: targetRoom,
        originalFacultyId: facultyA.id,
        originalFacultyName: facultyA.name,
        originalFacultyBranch: facultyA.department || sessionUser.department || 'CME',
        substituteFacultyId: facultyB.id,
        substituteFacultyName: facultyB.name,
        substituteFacultyBranch: facultyB.department || 'CME',
        requestedBy: sessionUser.username,
        status: 'PENDING',
        rejectionReason: null,
        createdAt: new Date().toISOString(),
        respondedAt: null,
        cancelledAt: null
    };

    if (db.isConfigured() && store.usingDatabase) {
        try {
            await repository.createFacultySubstitution(newRecord);
        } catch (_) {}
    }

    inMemorySubstitutions.push(newRecord);

    return { ...newRecord };
}

/**
 * Faculty B accepts a substitution request.
 * Strictly performs fresh availability re-validation.
 */
async function acceptRequest(id, sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role !== 'faculty') {
        const err = new Error('HOS cannot accept or approve substitution requests. Only the requested substitute faculty can accept.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const request = inMemorySubstitutions.find(s => String(s.id) === String(id));
    if (!request) {
        const err = new Error(`Substitution request "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    // Resolve caller faculty identity
    const callerFaculty = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    if (!callerFaculty) {
        const err = new Error('Authenticated user does not have an associated faculty record.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    // Prevent requester from accepting their own request
    const isRequester = (String(request.originalFacultyId) === String(callerFaculty.id)) ||
        (request.originalFacultyName.toUpperCase() === callerFaculty.name.toUpperCase()) ||
        (request.requestedBy === sessionUser.username);

    if (isRequester) {
        const err = new Error('You cannot accept your own substitution request.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    // Verify caller is strictly the target substitute (Faculty B)
    const isTargetSubstitute = (String(request.substituteFacultyId) === String(callerFaculty.id)) ||
        (request.substituteFacultyName.toUpperCase() === callerFaculty.name.toUpperCase());

    if (!isTargetSubstitute) {
        const err = new Error('You are not authorized to accept this substitution request. It was requested of another faculty member.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    // State validation
    if (request.status !== 'PENDING') {
        const err = new Error(`Cannot accept request that is already ${request.status.toLowerCase()}.`);
        err.status = 400; err.code = 'REQUEST_NOT_PENDING';
        throw err;
    }

    // ==============================================================
    // CRITICAL: Fresh Real-Time Availability Re-validation
    // ==============================================================
    const facultyB = findFaculty(request.substituteFacultyId || request.substituteFacultyName);
    if (!facultyB || facultyB.status === 'inactive') {
        const err = new Error('FACULTY_NO_LONGER_AVAILABLE: You are no longer active in the faculty roster.');
        err.status = 409; err.code = 'FACULTY_NO_LONGER_AVAILABLE';
        throw err;
    }

    // Fresh attendance check
    const currentAbsentRecords = await attendance.getAbsentFacultyOnDate(request.date);
    const isNowAbsent = currentAbsentRecords.some(r =>
        (r.id && String(r.id) === String(facultyB.id)) ||
        (r.name && r.name.toUpperCase() === facultyB.name.toUpperCase())
    );
    if (isNowAbsent) {
        const err = new Error('FACULTY_NO_LONGER_AVAILABLE: You have been marked absent on this date and cannot accept substitutions.');
        err.status = 409; err.code = 'FACULTY_NO_LONGER_AVAILABLE';
        throw err;
    }

    // Fresh timetable check
    const currentTeaching = findTeachingClass(facultyB, request.dayOfWeek, request.period);
    if (currentTeaching) {
        const err = new Error(`FACULTY_NO_LONGER_AVAILABLE: You now have a scheduled teaching class (${currentTeaching.className} - ${currentTeaching.subject}) during period ${request.period}.`);
        err.status = 409; err.code = 'FACULTY_NO_LONGER_AVAILABLE';
        throw err;
    }

    // Fresh invigilation check
    const currentInvig = await invigilation.getActiveInvigilationsOnDate(request.date, request.period);
    const hasInvigNow = currentInvig.some(i =>
        (i.facultyName && i.facultyName.toUpperCase() === facultyB.name.toUpperCase()) ||
        (i.facultyId && String(i.facultyId) === String(facultyB.id))
    );
    if (hasInvigNow) {
        const err = new Error(`FACULTY_NO_LONGER_AVAILABLE: You have been assigned exam invigilation during period ${request.period}.`);
        err.status = 409; err.code = 'FACULTY_NO_LONGER_AVAILABLE';
        throw err;
    }

    // Fresh double-booking substitution check
    if (hasAcceptedSubstitution(facultyB, request.date, request.period)) {
        const err = new Error(`DOUBLE_BOOKING_CONFLICT: You have already accepted another substitution for ${request.date} period ${request.period}.`);
        err.status = 409; err.code = 'DOUBLE_BOOKING_CONFLICT';
        throw err;
    }

    // Transition state
    const now = new Date().toISOString();
    request.status = 'ACCEPTED';
    request.respondedAt = now;

    if (db.isConfigured() && store.usingDatabase) {
        try {
            await repository.updateFacultySubstitutionStatus(request.id, {
                status: 'ACCEPTED',
                respondedAt: now
            });
        } catch (_) {}
    }

    return { ...request };
}

/**
 * Faculty B rejects a substitution request.
 */
async function rejectRequest(id, reasonOrOpts, maybeSessionUser) {
    let reason = null;
    let sessionUser = null;
    if (maybeSessionUser) {
        reason = reasonOrOpts;
        sessionUser = maybeSessionUser;
    } else if (reasonOrOpts && typeof reasonOrOpts === 'object') {
        reason = reasonOrOpts.reason;
        sessionUser = reasonOrOpts.sessionUser;
    }

    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role !== 'faculty') {
        const err = new Error('HOS cannot reject substitution requests on behalf of faculty.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const request = inMemorySubstitutions.find(s => String(s.id) === String(id));
    if (!request) {
        const err = new Error(`Substitution request "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const callerFaculty = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    if (!callerFaculty) {
        const err = new Error('Authenticated user does not have an associated faculty record.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const isTargetSubstitute = (String(request.substituteFacultyId) === String(callerFaculty.id)) ||
        (request.substituteFacultyName.toUpperCase() === callerFaculty.name.toUpperCase());

    if (!isTargetSubstitute) {
        const err = new Error('You are not authorized to reject this substitution request.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    if (request.status !== 'PENDING') {
        const err = new Error(`Cannot reject a request that is already ${request.status.toLowerCase()}.`);
        err.status = 400; err.code = 'REQUEST_NOT_PENDING';
        throw err;
    }

    const now = new Date().toISOString();
    request.status = 'REJECTED';
    request.rejectionReason = reason ? String(reason).trim() : null;
    request.respondedAt = now;

    if (db.isConfigured() && store.usingDatabase) {
        try {
            await repository.updateFacultySubstitutionStatus(request.id, {
                status: 'REJECTED',
                rejectionReason: request.rejectionReason,
                respondedAt: now
            });
        } catch (_) {}
    }

    return { ...request };
}

/**
 * Faculty A cancels a pending substitution request.
 */
async function cancelRequest(id, sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const request = inMemorySubstitutions.find(s => String(s.id) === String(id));
    if (!request) {
        const err = new Error(`Substitution request "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const callerFaculty = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    const isRequester = (callerFaculty && (
        String(request.originalFacultyId) === String(callerFaculty.id) ||
        request.originalFacultyName.toUpperCase() === callerFaculty.name.toUpperCase()
    )) || request.requestedBy === sessionUser.username;

    if (!isRequester) {
        const err = new Error('Only the requesting faculty member can cancel this substitution request.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    if (request.status !== 'PENDING') {
        const err = new Error(`Cannot cancel a substitution request that is already ${request.status.toLowerCase()}.`);
        err.status = 400; err.code = 'REQUEST_NOT_PENDING';
        throw err;
    }

    const now = new Date().toISOString();
    request.status = 'CANCELLED';
    request.cancelledAt = now;

    if (db.isConfigured() && store.usingDatabase) {
        try {
            await repository.updateFacultySubstitutionStatus(request.id, {
                status: 'CANCELLED',
                cancelledAt: now
            });
        } catch (_) {}
    }

    return { ...request };
}

/**
 * Returns substitution history for the logged-in faculty member.
 * Includes requests created by them, requests directed to them, and past records.
 */
async function getMySubstitutions(sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const fac = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    const facName = fac ? fac.name.toUpperCase() : (sessionUser.name || '').toUpperCase();
    const facId = fac ? String(fac.id) : null;
    const username = sessionUser.username;

    const outgoingRequests = inMemorySubstitutions
        .filter(s => (s.originalFacultyName && s.originalFacultyName.toUpperCase() === facName) ||
                     (facId && String(s.originalFacultyId) === facId) ||
                     (s.requestedBy === username))
        .map(s => ({ ...s }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const incomingRequests = inMemorySubstitutions
        .filter(s => (s.substituteFacultyName && s.substituteFacultyName.toUpperCase() === facName) ||
                     (facId && String(s.substituteFacultyId) === facId))
        .map(s => ({ ...s }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
        facultyName: fac ? fac.name : sessionUser.name,
        outgoingRequests,
        incomingRequests,
        all: [...outgoingRequests, ...incomingRequests]
    };
}

/**
 * Returns incoming requests directed to the logged-in faculty member.
 */
async function getIncomingSubstitutions(sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const fac = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    const facName = fac ? fac.name.toUpperCase() : (sessionUser.name || '').toUpperCase();
    const facId = fac ? String(fac.id) : null;

    const list = inMemorySubstitutions.filter(s =>
        ((s.substituteFacultyName && s.substituteFacultyName.toUpperCase() === facName) ||
         (facId && String(s.substituteFacultyId) === facId))
    );

    const requests = list.map(s => ({ ...s })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
        requests,
        total: requests.length
    };
}

/**
 * Returns branch substitution history for HOS (read-only).
 * Enforces strict branch boundary.
 */
async function getBranchSubstitutions(branchCodeOrOpts, maybeSessionUser) {
    let branchCode = null;
    let sessionUser = null;
    let filterDate = null;
    let filterStatus = null;

    if (maybeSessionUser) {
        branchCode = branchCodeOrOpts;
        sessionUser = maybeSessionUser;
    } else if (branchCodeOrOpts && typeof branchCodeOrOpts === 'object') {
        branchCode = branchCodeOrOpts.branch;
        sessionUser = branchCodeOrOpts.sessionUser;
        filterDate = branchCodeOrOpts.date;
        filterStatus = branchCodeOrOpts.status;
    }

    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const sessionBranch = (sessionUser.department && sessionUser.department !== 'Administration')
        ? sessionUser.department.toUpperCase()
        : null;

    if (sessionBranch) {
        if (branchCode && branchCode.toUpperCase() !== sessionBranch) {
            const err = new Error(`Cross-branch queries are not allowed. Current branch is ${sessionBranch}.`);
            err.status = 403; err.code = 'FORBIDDEN';
            throw err;
        }
    }

    const targetBranch = sessionBranch || (branchCode ? branchCode.toUpperCase() : null);

    let list = inMemorySubstitutions.filter(s => {
        if (!targetBranch) return true;
        return s.originalFacultyBranch && s.originalFacultyBranch.toUpperCase() === targetBranch;
    });

    if (filterDate) {
        list = list.filter(s => s.date === filterDate);
    }
    if (filterStatus) {
        list = list.filter(s => s.status.toUpperCase() === filterStatus.toUpperCase());
    }

    const sorted = list.map(s => ({ ...s })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
        readOnly: true,
        branch: targetBranch,
        substitutions: sorted,
        total: sorted.length
    };
}

/**
 * Returns absent/vacant periods for the logged-in faculty member on a given date.
 */
async function getMyVacantPeriods({ date, sessionUser }) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const facultyA = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    if (!facultyA) {
        return { date, dayOfWeek: null, isAbsent: false, periods: [] };
    }

    const parsedDate = attendance.parseDateString(date);
    if (!parsedDate) {
        const err = new Error(`Invalid date format "${date}". Expected YYYY-MM-DD.`);
        err.status = 400; err.code = 'INVALID_DATE';
        throw err;
    }

    // Check attendance
    const absentRecords = await attendance.getAbsentFacultyOnDate(parsedDate.dateStr);
    const isAbsent = absentRecords.some(r =>
        (r.id && String(r.id) === String(facultyA.id)) ||
        (r.name && r.name.toUpperCase() === facultyA.name.toUpperCase())
    );

    if (!isAbsent) {
        return {
            date: parsedDate.dateStr,
            dayOfWeek: parsedDate.dayOfWeek,
            isAbsent: false,
            message: `You are not marked absent on ${parsedDate.dateStr}.`,
            periods: []
        };
    }

    // Find all teaching timetable slots for Faculty A on this day of week
    const records = store.engine ? store.engine.getRecords() : [];
    const dayStr = parsedDate.dayOfWeek.trim().toUpperCase();
    const facName = facultyA.name.trim().toUpperCase();
    const facId = facultyA.id ? String(facultyA.id).trim().toUpperCase() : null;

    const teachingSlots = records.filter(r =>
        r.status === 'busy' &&
        r.day && r.day.trim().toUpperCase() === dayStr &&
        ((r.faculty && r.faculty.trim().toUpperCase() === facName) ||
         (r.facultyId && String(r.facultyId).trim().toUpperCase() === facId))
    ).sort((a, b) => a.period - b.period);

    const periodsWithStatus = teachingSlots.map(slot => {
        const activeSub = inMemorySubstitutions.find(s =>
            (s.status === 'PENDING' || s.status === 'ACCEPTED') &&
            s.date === parsedDate.dateStr &&
            s.period === slot.period &&
            s.className.toUpperCase() === slot.className.toUpperCase() &&
            ((s.originalFacultyId && String(s.originalFacultyId) === String(facultyA.id)) ||
             (s.originalFacultyName && s.originalFacultyName.toUpperCase() === facultyA.name.toUpperCase()))
        );

        return {
            period: slot.period,
            className: slot.className,
            subject: slot.subject,
            room: slot.room,
            existingRequest: activeSub ? {
                id: activeSub.id,
                substituteFacultyName: activeSub.substituteFacultyName,
                status: activeSub.status,
                createdAt: activeSub.createdAt
            } : null
        };
    });

    return {
        date: parsedDate.dateStr,
        dayOfWeek: parsedDate.dayOfWeek,
        isAbsent: true,
        periods: periodsWithStatus,
        vacantPeriods: periodsWithStatus.map(p => ({
            date: parsedDate.dateStr,
            dayOfWeek: parsedDate.dayOfWeek,
            ...p
        }))
    };
}

/**
 * Returns available FREE candidates for Faculty A to request for a slot.
 * Reuses B7.4 availability calculation with same-branch first ranking.
 */
async function getCandidates({ date, period, className, sessionUser }) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const facultyA = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    if (!facultyA) {
        const err = new Error('Faculty profile not found.');
        err.status = 404; err.code = 'FACULTY_NOT_FOUND';
        throw err;
    }

    const parsedDate = attendance.parseDateString(date);
    if (!parsedDate) {
        const err = new Error(`Invalid date format "${date}". Expected YYYY-MM-DD.`);
        err.status = 400; err.code = 'INVALID_DATE';
        throw err;
    }

    const normPeriod = store.engine ? store.engine.normalizePeriod(period) : parseInt(period, 10);
    if (normPeriod == null || isNaN(normPeriod)) {
        const err = new Error('Invalid or missing period.');
        err.status = 400; err.code = 'INVALID_PERIOD';
        throw err;
    }

    const absentRecords = await attendance.getAbsentFacultyOnDate(parsedDate.dateStr);
    const absentNames = absentRecords.map(r => r.name);
    // Exclude Faculty A
    absentNames.push(facultyA.name);

    // Active invigilations on that slot
    const invigRecords = await invigilation.getActiveInvigilationsOnDate(parsedDate.dateStr, normPeriod);

    // Exclude faculty who already accepted a substitution for this slot
    const alreadySubstituted = inMemorySubstitutions
        .filter(s => s.status === 'ACCEPTED' && s.date === parsedDate.dateStr && s.period === normPeriod)
        .map(s => s.substituteFacultyName);
    alreadySubstituted.forEach(name => {
        if (!absentNames.includes(name)) absentNames.push(name);
    });

    const priorityBranch = facultyA.department || sessionUser.department || 'CME';

    const result = store.engine.getAvailability(parsedDate.dayOfWeek, normPeriod, {
        excludedFaculty: absentNames,
        invigilationFaculty: invigRecords,
        priorityBranch: priorityBranch
    });

    const candidates = (result.available || []).map(r => ({
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

    const sameBranch = (result.sameBranch ? result.sameBranch.available : []).map(r => ({
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

    const otherBranches = (result.otherBranches ? result.otherBranches.available : []).map(r => ({
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

    return {
        date: parsedDate.dateStr,
        day: parsedDate.dayOfWeek,
        period: normPeriod,
        class: className || null,
        priorityBranch: priorityBranch,
        candidates,
        sameBranch: {
            branch: priorityBranch,
            candidates: sameBranch,
            totalCandidates: sameBranch.length
        },
        otherBranches: {
            candidates: otherBranches,
            totalCandidates: otherBranches.length
        },
        totalCandidates: candidates.length,
        totalSameBranch: sameBranch.length,
        totalOtherBranches: otherBranches.length
    };
}

function resetForTesting() {
    inMemorySubstitutions = [];
}

module.exports = {
    createRequest,
    acceptRequest,
    rejectRequest,
    cancelRequest,
    getMySubstitutions,
    getIncomingSubstitutions,
    getBranchSubstitutions,
    getMyVacantPeriods,
    getCandidates,
    hasAcceptedSubstitution,
    findFaculty,
    findTeachingClass,
    syncFromDatabase,
    resetForTesting
};
