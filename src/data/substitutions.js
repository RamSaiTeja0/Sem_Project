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

function toIsoString(val) {
    if (!val) return null;
    if (typeof val === 'string') return val;
    if (val instanceof Date) return val.toISOString();
    return String(val);
}

function syncFromDatabase(records = []) {
    if (!Array.isArray(records)) return;
    if (db.isConfigured() && store.usingDatabase) {
        const dbIds = new Set(records.map(r => String(r.id)));
        for (let i = inMemorySubstitutions.length - 1; i >= 0; i--) {
            if (!dbIds.has(String(inMemorySubstitutions[i].id))) {
                inMemorySubstitutions.splice(i, 1);
            }
        }
    }
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
            createdAt: toIsoString(rec.createdAt || rec.created_at) || new Date().toISOString(),
            respondedAt: toIsoString(rec.respondedAt || rec.responded_at),
            cancelledAt: toIsoString(rec.cancelledAt || rec.cancelled_at)
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
    const direct = roster.find(f =>
        (f.id && String(f.id).toUpperCase() === str) ||
        (f.code && String(f.code).toUpperCase() === str) ||
        (f.name && f.name.toUpperCase() === str)
    );
    if (direct) return direct;

    try {
        const users = require('./users');
        const u = (typeof users.findById === 'function' ? users.findById(needle) : null) ||
                  (typeof users.findByUsername === 'function' ? users.findByUsername(needle) : null);
        if (u) {
            const fac = roster.find(f =>
                (u.facultyId && f.id && String(f.id).toUpperCase() === String(u.facultyId).toUpperCase()) ||
                (u.facultyName && f.name && f.name.toUpperCase() === u.facultyName.toUpperCase()) ||
                (u.name && f.name && f.name.toUpperCase() === u.name.toUpperCase())
            );
            if (fac) return fac;
            return {
                id: u.facultyId || u.id,
                name: u.facultyName || u.name,
                code: u.username,
                department: u.department,
                status: u.status || 'active'
            };
        }
    } catch (_) {}

    try {
        const { nameTokensMatch } = require('../core/entityResolver');
        const matched = roster.find(f => nameTokensMatch(f.name, str) || (f.code && nameTokensMatch(String(f.code), str)));
        if (matched) return matched;
    } catch (_) {}
    return null;
}

/**
 * Canonicalize day strings (e.g. 'SAT', 'Saturday' -> 'Saturday')
 */
const DAY_CANONICAL = {
    'MON': 'Monday', 'MONDAY': 'Monday', 'M': 'Monday',
    'TUE': 'Tuesday', 'TUES': 'Tuesday', 'TUESDAY': 'Tuesday', 'TU': 'Tuesday',
    'WED': 'Wednesday', 'WEDNESDAY': 'Wednesday', 'W': 'Wednesday',
    'THU': 'Thursday', 'THUR': 'Thursday', 'THURS': 'Thursday', 'THURSDAY': 'Thursday', 'TH': 'Thursday',
    'FRI': 'Friday', 'FRIDAY': 'Friday', 'F': 'Friday',
    'SAT': 'Saturday', 'SATURDAY': 'Saturday', 'S': 'Saturday',
    'SUN': 'Sunday', 'SUNDAY': 'Sunday'
};

function normalizeDayCanonical(d) {
    if (!d) return '';
    const s = String(d).trim().toUpperCase();
    return DAY_CANONICAL[s] || (s.charAt(0) + s.slice(1).toLowerCase());
}

/**
 * Check if a faculty member has an active teaching timetable conflict for a day of week and period.
 * When checkPersonal is true, checks the faculty's personal timetable (isolated schedule) first,
 * falling back to the master timetable.
 */
async function findTeachingClass(faculty, dayOfWeek, period, { checkPersonal = false } = {}) {
    if (!faculty || !dayOfWeek || period == null) return null;
    const targetDay = normalizeDayCanonical(dayOfWeek);
    const dayStr = targetDay.trim().toUpperCase();
    const periodNum = parseInt(period, 10);
    const facName = faculty.name ? faculty.name.trim().toUpperCase() : '';
    const facId = faculty.id ? String(faculty.id).trim().toUpperCase() : null;

    if (checkPersonal) {
        let personalSlots = [];
        try {
            if (db.isConfigured() && store.usingDatabase) {
                personalSlots = await repository.getFacultyPersonalTimetable(faculty.id || faculty.name);
            }
        } catch (_) {}

        if (!personalSlots || personalSlots.length === 0) {
            try {
                if (typeof store.getFacultyPersonalTimetableInMemory === 'function') {
                    personalSlots = (faculty.id ? store.getFacultyPersonalTimetableInMemory(faculty.id) : []) || [];
                    if (!personalSlots.length && faculty.name) {
                        personalSlots = store.getFacultyPersonalTimetableInMemory(faculty.name) || [];
                    }
                }
            } catch (_) {}
        }

        if (personalSlots && personalSlots.length > 0) {
            const match = personalSlots.find(s => {
                const sDay = normalizeDayCanonical(s.day || s.day_of_week);
                if (sDay.toUpperCase() !== dayStr) return false;
                const p = parseInt(s.period != null ? s.period : s.period_number, 10);
                const spanTo = s.spanTo ? parseInt(s.spanTo, 10) : (s.span_to ? parseInt(s.span_to, 10) : null);
                const inPeriod = (p === periodNum) || (spanTo && periodNum >= p && periodNum <= spanTo);
                if (!inPeriod) return false;
                const isFree = s.is_free || s.isFree || !s.subject || s.subject.trim() === '' || s.subject.trim().toLowerCase() === 'free';
                return !isFree;
            });

            if (match) {
                return {
                    className: match.className || match.class_name || null,
                    subject: match.subject || match.rawSubject || 'Teaching',
                    room: match.room || match.room_code || null,
                    day: targetDay,
                    period: periodNum,
                    faculty: faculty.name,
                    facultyId: faculty.id,
                    type: match.type || match.session_type || 'theory',
                    status: 'busy',
                    isPersonal: true
                };
            }
        }
    }

    const records = store.engine ? store.engine.getRecords() : [];
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
async function createRequest({ date, period, className, subject, substituteFacultyId, substituteFacultyName, isAdjustment, sessionUser }) {
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

    // 3. Verify Faculty A is marked ABSENT on that date, unless creating an adjustment request for their own class
    const absentRecords = await attendance.getAbsentFacultyOnDate(parsedDate.dateStr);
    const isFacultyAAbsent = absentRecords.some(r =>
        (r.id && String(r.id) === String(facultyA.id)) ||
        (r.name && r.name.toUpperCase() === facultyA.name.toUpperCase())
    );

    if (!isFacultyAAbsent && !isAdjustment) {
        const err = new Error(`Faculty "${facultyA.name}" is not marked absent on ${parsedDate.dateStr}. Substitution requests can only be created for absent periods.`);
        err.status = 400; err.code = 'FACULTY_NOT_ABSENT';
        throw err;
    }

    // 4. Verify Faculty A actually has a scheduled timetable class during that slot
    const scheduledClass = await findTeachingClass(facultyA, parsedDate.dayOfWeek, normPeriod, { checkPersonal: true });
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

    const targetClass = (className && className.trim()) || scheduledClass.className || (facultyA.department ? `${facultyA.department}-SEM1-A` : null);
    const targetSubject = subject || scheduledClass.subject || 'Teaching';
    const targetRoom = scheduledClass.room || null;

    // 5. Resolve and validate substitute candidate (Faculty B)
    const subIdentifier = substituteFacultyId || substituteFacultyName;
    if (!subIdentifier) {
        const err = new Error('Please select a substitute faculty member.');
        err.status = 400; err.code = 'MISSING_SUBSTITUTE';
        throw err;
    }

    const facultyB = (substituteFacultyId ? findFaculty(substituteFacultyId) : null) ||
                     (substituteFacultyName ? findFaculty(substituteFacultyName) : null);
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
    const subTeaching = await findTeachingClass(facultyB, parsedDate.dayOfWeek, normPeriod, { checkPersonal: false });
    if (subTeaching) {
        const err = new Error(`Selected substitute "${facultyB.name}" is teaching another class (${subTeaching.className ? subTeaching.className + ' - ' : ''}${subTeaching.subject || 'Teaching'}) during period ${normPeriod}.`);
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
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({ branchCode: facultyA.department });
            syncFromDatabase(dbRecords);
        } catch (_) {}
    }

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
        } catch (dbErr) {
            console.error('Failed to persist faculty substitution to database:', dbErr);
            const err = new Error(`Database error saving substitution request: ${dbErr.message}`);
            err.status = 500;
            err.code = 'DATABASE_ERROR';
            throw err;
        }
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

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({});
            syncFromDatabase(dbRecords);
        } catch (_) {}
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
    const facultyB = findFaculty(request.substituteFacultyId) || findFaculty(request.substituteFacultyName);
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
    const currentTeaching = await findTeachingClass(facultyB, request.dayOfWeek, request.period, { checkPersonal: false });
    if (currentTeaching) {
        const err = new Error(`FACULTY_NO_LONGER_AVAILABLE: You now have a scheduled teaching class (${currentTeaching.className ? currentTeaching.className + ' - ' : ''}${currentTeaching.subject || 'Teaching'}) during period ${request.period}.`);
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

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({});
            syncFromDatabase(dbRecords);
        } catch (_) {}
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

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({});
            syncFromDatabase(dbRecords);
        } catch (_) {}
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

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({});
            syncFromDatabase(dbRecords);
        } catch (_) {}
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
        .sort((a, b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()));

    const incomingRequests = inMemorySubstitutions
        .filter(s => (s.substituteFacultyName && s.substituteFacultyName.toUpperCase() === facName) ||
                     (facId && String(s.substituteFacultyId) === facId))
        .map(s => ({ ...s }))
        .sort((a, b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()));

    return {
        facultyName: fac ? fac.name : sessionUser.name,
        outgoingRequests,
        incomingRequests,
        all: [...outgoingRequests, ...incomingRequests]
    };
}

/**
 * Returns incoming requests directed to the logged-in faculty member.
 * By default, returns only PENDING requests requiring action from the faculty member.
 */
async function getIncomingSubstitutions(sessionUser, queryOrOpts = {}) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({});
            syncFromDatabase(dbRecords);
        } catch (_) {}
    }

    const fac = findFaculty(sessionUser.facultyName || sessionUser.name || sessionUser.username);
    const facName = fac ? fac.name.toUpperCase() : (sessionUser.name || '').toUpperCase();
    const facId = fac ? String(fac.id) : null;

    const requestedStatus = queryOrOpts && queryOrOpts.status
        ? String(queryOrOpts.status).trim().toUpperCase()
        : 'PENDING';

    const list = inMemorySubstitutions.filter(s => {
        const matchesFaculty = (s.substituteFacultyName && s.substituteFacultyName.toUpperCase() === facName) ||
                               (facId && String(s.substituteFacultyId) === facId);
        if (!matchesFaculty) return false;
        if (requestedStatus === 'ALL') return true;
        return (s.status || '').toUpperCase() === requestedStatus;
    });

    const requests = list.map(s => ({ ...s })).sort((a, b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()));
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

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const dbRecords = await repository.listFacultySubstitutions({ branchCode: targetBranch });
            syncFromDatabase(dbRecords);
        } catch (_) {}
    }

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

    const sorted = list.map(s => ({ ...s })).sort((a, b) => (new Date(b.createdAt || 0).getTime()) - (new Date(a.createdAt || 0).getTime()));
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

    // Find all teaching timetable slots for Faculty A on this day of week (checking personal timetable first)
    let personalSlots = [];
    try {
        if (db.isConfigured() && store.usingDatabase) {
            personalSlots = await repository.getFacultyPersonalTimetable(facultyA.id || facultyA.name);
        }
    } catch (_) {}

    if (!personalSlots || personalSlots.length === 0) {
        try {
            if (typeof store.getFacultyPersonalTimetableInMemory === 'function') {
                personalSlots = (facultyA.id ? store.getFacultyPersonalTimetableInMemory(facultyA.id) : []) || [];
                if (!personalSlots.length && facultyA.name) {
                    personalSlots = store.getFacultyPersonalTimetableInMemory(facultyA.name) || [];
                }
            }
        } catch (_) {}
    }

    const dayStr = normalizeDayCanonical(parsedDate.dayOfWeek).trim().toUpperCase();
    let teachingSlots = [];

    if (personalSlots && personalSlots.length > 0) {
        teachingSlots = personalSlots.filter(s => {
            const sDay = normalizeDayCanonical(s.day || s.day_of_week);
            if (sDay.toUpperCase() !== dayStr) return false;
            const isFree = s.is_free || s.isFree || !s.subject || s.subject.trim() === '' || s.subject.trim().toLowerCase() === 'free';
            return !isFree;
        }).map(s => {
            const p = parseInt(s.period != null ? s.period : s.period_number, 10);
            return {
                period: p,
                className: s.className || s.class_name || (facultyA.department ? `${facultyA.department}-SEM1-A` : null),
                subject: s.subject || s.rawSubject || 'Teaching',
                room: s.room || s.room_code || null
            };
        }).sort((a, b) => a.period - b.period);
    }

    if (teachingSlots.length === 0) {
        const records = store.engine ? store.engine.getRecords() : [];
        const facName = facultyA.name.trim().toUpperCase();
        const facId = facultyA.id ? String(facultyA.id).trim().toUpperCase() : null;

        teachingSlots = records.filter(r =>
            r.status === 'busy' &&
            r.day && r.day.trim().toUpperCase() === dayStr &&
            ((r.faculty && r.faculty.trim().toUpperCase() === facName) ||
             (r.facultyId && String(r.facultyId).trim().toUpperCase() === facId))
        ).sort((a, b) => a.period - b.period);
    }

    const periodsWithStatus = teachingSlots.map(slot => {
        const activeSub = inMemorySubstitutions.find(s =>
            (s.status === 'PENDING' || s.status === 'ACCEPTED') &&
            s.date === parsedDate.dateStr &&
            s.period === slot.period &&
            (s.className || '').toUpperCase() === (slot.className || '').toUpperCase() &&
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

async function getActiveFacultyWithAccounts() {
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const { rows } = await db.query(`
                SELECT f.id, f.code, f.name, f.department_id, d.code AS branch,
                       u.id AS user_id, u.username, u.role, u.status AS user_status, u.active AS user_active,
                       f.designation,
                       COALESCE(NULLIF(f.phone, ''), NULLIF(u.phone, '')) AS phone
                  FROM faculty f
                 INNER JOIN users u ON u.faculty_id = f.id
                  LEFT JOIN departments d ON d.id = f.department_id
                 WHERE u.role = 'faculty'
                   AND (u.active IS TRUE OR u.active IS NULL)
                   AND (u.status = 'active' OR u.status IS NULL)
                   AND (f.status = 'active' OR f.status IS NULL)
                 ORDER BY f.name
            `);
            return rows;
        } catch (err) {
            return [];
        }
    }

    const usersModule = require('./users');
    const memUsers = (typeof usersModule.list === 'function' ? usersModule.list() : []) || [];
    const validMemUsers = memUsers.filter(u =>
        u.role === 'faculty' &&
        (u.active === true || u.active === undefined) &&
        (u.status === 'active' || u.status === undefined) &&
        u.facultyId != null
    );

    const roster = store.engine ? store.engine.getFaculty() : [];
    const matched = [];
    for (const u of validMemUsers) {
        const fac = roster.find(f =>
            (f.id != null && String(f.id) === String(u.facultyId)) ||
            (f.code != null && String(f.code).toUpperCase() === String(u.facultyId).toUpperCase())
        );
        if (fac && fac.status !== 'inactive') {
            matched.push({
                id: fac.id,
                code: fac.code,
                name: fac.name,
                branch: fac.department || u.department,
                department_id: fac.department_id,
                user_id: u.id,
                username: u.username,
                role: 'faculty',
                user_status: 'active',
                user_active: true,
                designation: fac.designation,
                phone: fac.phone || u.phone
            });
        }
    }
    return matched;
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

    const validFacultyList = await getActiveFacultyWithAccounts();
    const validFacultyIds = new Set(validFacultyList.map(f => String(f.id)));
    const validFacultyNames = new Set(validFacultyList.map(f => (f.name || '').toUpperCase()));

    const isAllowed = r => {
        if (!r) return false;
        const idStr = r.facultyId != null ? String(r.facultyId) : (r.id != null ? String(r.id) : null);
        if (idStr && validFacultyIds.has(idStr)) return true;
        const nameUpper = (r.faculty || r.name || r.facultyName || '').toUpperCase();
        if (nameUpper && validFacultyNames.has(nameUpper)) return true;
        return false;
    };

    const result = store.engine.getAvailability(parsedDate.dayOfWeek, normPeriod, {
        excludedFaculty: absentNames,
        invigilationFaculty: invigRecords,
        priorityBranch: priorityBranch
    });

    const facultyPhoneMap = new Map();
    validFacultyList.forEach(f => {
        const ph = f.phone ? String(f.phone).trim() : null;
        if (ph) {
            if (f.id != null) facultyPhoneMap.set(String(f.id), ph);
            if (f.code != null) facultyPhoneMap.set(String(f.code).toUpperCase(), ph);
            if (f.name != null) facultyPhoneMap.set(String(f.name).trim().toUpperCase(), ph);
        }
    });
    if (store.engine && typeof store.engine.getFaculty === 'function') {
        try {
            store.engine.getFaculty().forEach(f => {
                const ph = f.phone ? String(f.phone).trim() : null;
                if (ph) {
                    if (f.id != null && !facultyPhoneMap.has(String(f.id))) facultyPhoneMap.set(String(f.id), ph);
                    if (f.code != null && !facultyPhoneMap.has(String(f.code).toUpperCase())) facultyPhoneMap.set(String(f.code).toUpperCase(), ph);
                    if (f.name != null && !facultyPhoneMap.has(String(f.name).trim().toUpperCase())) facultyPhoneMap.set(String(f.name).trim().toUpperCase(), ph);
                }
            });
        } catch (_) {}
    }

    const resolveCandidatePhone = r => {
        if (!r) return null;
        const directPhone = r.phone ? String(r.phone).trim() : null;
        if (directPhone) return directPhone;
        const idStr = r.facultyId != null ? String(r.facultyId) : (r.id != null ? String(r.id) : null);
        if (idStr && facultyPhoneMap.has(idStr)) return facultyPhoneMap.get(idStr);
        const codeUpper = r.code ? String(r.code).trim().toUpperCase() : null;
        if (codeUpper && facultyPhoneMap.has(codeUpper)) return facultyPhoneMap.get(codeUpper);
        const nameUpper = (r.faculty || r.name || r.facultyName || '').trim().toUpperCase();
        if (nameUpper && facultyPhoneMap.has(nameUpper)) return facultyPhoneMap.get(nameUpper);
        return null;
    };

    const candidates = (result.available || []).filter(isAllowed).map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: resolveCandidatePhone(r),
        status: 'FREE',
        reason: null,
        isSameBranch: r.isSameBranch
    }));

    const sameBranch = ((result.sameBranch ? result.sameBranch.available : []) || []).filter(isAllowed).map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: resolveCandidatePhone(r),
        status: 'FREE',
        reason: null,
        isSameBranch: true
    }));

    const otherBranches = ((result.otherBranches ? result.otherBranches.available : []) || []).filter(isAllowed).map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: resolveCandidatePhone(r),
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
