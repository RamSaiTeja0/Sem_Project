/**
 * Faculty Attendance / Absence Store & Service (Phase B7.2).
 *
 * Implements:
 *   - Date-specific faculty attendance tracking
 *   - Default status: PRESENT for all active faculty
 *   - Explicit ABSENT / PRESENT marking by branch Head of Section (HOS)
 *   - Strict branch-level isolation (HOS can manage only their branch faculty)
 *   - Read-only self-view for faculty members
 *   - Timezone-safe UTC date handling (YYYY-MM-DD)
 *   - Dual-mode: PostgreSQL-backed when configured, in-memory store for standalone/tests
 */
const crypto = require('crypto');
const db = require('../db/pool');
const repository = require('../db/repository');
const store = require('./store');

// In-memory attendance records: array of { id, facultyId, facultyName, facultyCode, branchCode, date, status, markedBy, createdAt, updatedAt }
let inMemoryAttendance = [];

function generateAttendanceId() {
    return 'att_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
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
 * Marks attendance for a faculty member on a specific date.
 * HOS only. Strictly enforces branch isolation.
 */
async function markAttendance({ facultyIdentifier, date, status, sessionUser }) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role === 'faculty') {
        const err = new Error('Faculty members cannot mark or modify attendance. This action requires Head of Section (HOS) role.');
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

    const upperStatus = String(status || '').trim().toUpperCase();
    if (!['PRESENT', 'ABSENT'].includes(upperStatus)) {
        const err = new Error(`Invalid attendance status "${status}". Must be PRESENT or ABSENT.`);
        err.status = 400; err.code = 'INVALID_STATUS';
        throw err;
    }

    const faculty = findFaculty(facultyIdentifier);
    if (!faculty) {
        const err = new Error(`Faculty "${facultyIdentifier}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const facultyBranch = String(faculty.department || '').trim().toUpperCase();
    if (facultyBranch && facultyBranch !== hosBranch) {
        const err = new Error(`Cross-branch attendance modification is forbidden. Faculty belongs to ${facultyBranch}, but your branch is ${hosBranch}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const markedBy = sessionUser.username || sessionUser.name || 'HOS';
    const dateStr = parsedDate.dateStr;

    // Database mode
    if (db.isConfigured() && store.usingDatabase) {
        let dbFacultyId = faculty.id;
        // If faculty.id is non-numeric, look up numeric faculty ID from database
        if (isNaN(parseInt(dbFacultyId, 10))) {
            try {
                const { rows } = await db.query(
                    'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($1)',
                    [faculty.name]
                );
                if (rows.length > 0) dbFacultyId = rows[0].id;
            } catch (_) {}
        }

        const rec = await repository.markFacultyAttendance({
            facultyId: dbFacultyId,
            date: dateStr,
            status: upperStatus,
            markedBy
        });
        return {
            id: rec.id,
            facultyId: faculty.id,
            facultyName: faculty.name,
            facultyCode: faculty.code || null,
            branchCode: facultyBranch || hosBranch,
            date: dateStr,
            dayOfWeek: parsedDate.dayOfWeek,
            status: rec.status,
            markedBy: rec.markedBy,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt
        };
    }

    // In-memory mode (standalone / unit test execution)
    const existingIndex = inMemoryAttendance.findIndex(r =>
        (String(r.facultyId).toUpperCase() === String(faculty.id).toUpperCase() ||
         r.facultyName.toUpperCase() === faculty.name.toUpperCase()) &&
        r.date === dateStr
    );

    const now = new Date().toISOString();
    if (existingIndex >= 0) {
        inMemoryAttendance[existingIndex].status = upperStatus;
        inMemoryAttendance[existingIndex].markedBy = markedBy;
        inMemoryAttendance[existingIndex].updatedAt = now;
        return { ...inMemoryAttendance[existingIndex], dayOfWeek: parsedDate.dayOfWeek };
    }

    const newRecord = {
        id: generateAttendanceId(),
        facultyId: faculty.id,
        facultyName: faculty.name,
        facultyCode: faculty.code || null,
        branchCode: facultyBranch || hosBranch,
        date: dateStr,
        dayOfWeek: parsedDate.dayOfWeek,
        status: upperStatus,
        markedBy,
        createdAt: now,
        updatedAt: now
    };
    inMemoryAttendance.push(newRecord);
    return newRecord;
}

/**
 * Delete / unmark an explicit attendance record (reverts faculty to default PRESENT).
 * HOS only. Strictly enforces branch isolation.
 */
async function deleteAttendance(id, sessionUser) {
    if (!sessionUser) {
        const err = new Error('Authentication required.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role === 'faculty') {
        const err = new Error('Faculty members cannot modify attendance.');
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    const hosBranch = String(sessionUser.department || '').trim().toUpperCase();

    if (db.isConfigured() && store.usingDatabase) {
        const deleted = await repository.deleteFacultyAttendance(id, hosBranch);
        if (!deleted) {
            const err = new Error(`Attendance record "${id}" not found or unauthorized.`);
            err.status = 404; err.code = 'NOT_FOUND';
            throw err;
        }
        return { success: true, id: deleted.id, status: 'PRESENT' };
    }

    const idx = inMemoryAttendance.findIndex(r => String(r.id) === String(id));
    if (idx === -1) {
        const err = new Error(`Attendance record "${id}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const record = inMemoryAttendance[idx];
    if (hosBranch && record.branchCode && record.branchCode.toUpperCase() !== hosBranch) {
        const err = new Error(`Cross-branch attendance deletion forbidden. Record belongs to ${record.branchCode}, but your branch is ${hosBranch}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    inMemoryAttendance.splice(idx, 1);
    return { success: true, id, status: 'PRESENT' };
}

/**
 * Lists attendance for all active faculty in a branch for a given date.
 * Active faculty are PRESENT by default unless explicitly marked ABSENT.
 */
async function listBranchAttendance(branchCode, date) {
    const parsedDate = parseDateString(date);
    if (!parsedDate) {
        const err = new Error(`Invalid date format "${date}". Expected YYYY-MM-DD.`);
        err.status = 400; err.code = 'INVALID_DATE';
        throw err;
    }

    const bCode = String(branchCode || '').trim().toUpperCase();
    const dateStr = parsedDate.dateStr;

    if (db.isConfigured() && store.usingDatabase) {
        const dbRows = await repository.listFacultyAttendanceForDate(bCode, dateStr);
        return dbRows.map(r => ({
            id: r.id,
            facultyId: r.id,
            name: r.name,
            code: r.code,
            department: r.department,
            designation: r.designation,
            phone: r.phone,
            status: r.status, // 'PRESENT' or 'ABSENT'
            attendanceId: r.attendanceId || null,
            markedBy: r.markedBy || null,
            updatedAt: r.updatedAt || null,
            date: dateStr,
            dayOfWeek: parsedDate.dayOfWeek
        }));
    }

    const roster = (store.engine ? store.engine.getFaculty() : []).filter(f =>
        (!bCode || !f.department || f.department.toUpperCase() === bCode) &&
        f.status !== 'inactive'
    );

    return roster.map(f => {
        const rec = inMemoryAttendance.find(r =>
            (String(r.facultyId).toUpperCase() === String(f.id).toUpperCase() ||
             r.facultyName.toUpperCase() === f.name.toUpperCase()) &&
            r.date === dateStr
        );

        return {
            id: f.id,
            facultyId: f.id,
            name: f.name,
            code: f.code || f.id,
            department: f.department || bCode,
            designation: f.designation || null,
            phone: f.phone || null,
            status: rec ? rec.status : 'PRESENT', // PRESENT by default
            attendanceId: rec ? rec.id : null,
            markedBy: rec ? rec.markedBy : null,
            updatedAt: rec ? rec.updatedAt : null,
            date: dateStr,
            dayOfWeek: parsedDate.dayOfWeek
        };
    });
}

/**
 * Returns a list of faculty names, IDs and codes who are marked ABSENT on a date.
 * Used by the availability engine to exclude absent faculty.
 */
async function getAbsentFacultyOnDate(date) {
    if (!date) return [];
    const parsedDate = parseDateString(date);
    if (!parsedDate) return [];

    const dateStr = parsedDate.dateStr;

    if (db.isConfigured() && store.usingDatabase) {
        try {
            const rows = await repository.getAbsentFacultyForDate(dateStr);
            return rows.map(r => ({
                id: r.facultyId,
                name: r.facultyName,
                code: r.facultyCode,
                department: r.department,
                status: 'ABSENT'
            }));
        } catch (_) {}
    }

    return inMemoryAttendance
        .filter(r => r.date === dateStr && r.status === 'ABSENT')
        .map(r => ({
            id: r.facultyId,
            name: r.facultyName,
            code: r.facultyCode,
            department: r.branchCode,
            status: 'ABSENT'
        }));
}

/**
 * Returns the attendance history for the authenticated faculty member.
 * Read-only self-view.
 */
async function getMyAttendance(sessionUser) {
    if (!sessionUser) {
        const err = new Error('Sign in to view your attendance.');
        err.status = 401; err.code = 'UNAUTHENTICATED';
        throw err;
    }

    const targetName = (sessionUser.facultyName || sessionUser.name || '').trim().toUpperCase();
    const targetId = sessionUser.facultyId ? String(sessionUser.facultyId).toUpperCase() : null;

    if (!targetName && !targetId) {
        return {
            facultyName: sessionUser.name,
            records: []
        };
    }

    if (db.isConfigured() && store.usingDatabase && targetId && !isNaN(parseInt(targetId, 10))) {
        try {
            const dbRecords = await repository.getFacultyAttendanceHistory(parseInt(targetId, 10));
            return {
                facultyName: sessionUser.facultyName || sessionUser.name,
                records: dbRecords.map(r => {
                    const parsed = parseDateString(r.date ? r.date.toISOString().slice(0, 10) : '');
                    return {
                        id: r.id,
                        date: parsed ? parsed.dateStr : r.date,
                        dayOfWeek: parsed ? parsed.dayOfWeek : null,
                        status: r.status,
                        markedBy: r.markedBy,
                        createdAt: r.createdAt
                    };
                })
            };
        } catch (_) {}
    }

    const myRecords = inMemoryAttendance
        .filter(r =>
            (targetId && String(r.facultyId).toUpperCase() === targetId) ||
            r.facultyName.toUpperCase() === targetName
        )
        .map(r => ({
            id: r.id,
            date: r.date,
            dayOfWeek: r.dayOfWeek,
            status: r.status,
            markedBy: r.markedBy,
            createdAt: r.createdAt
        }))
        .sort((a, b) => b.date.localeCompare(a.date));

    return {
        facultyName: sessionUser.facultyName || sessionUser.name,
        records: myRecords
    };
}

/**
 * Resets in-memory attendance records for clean test isolation.
 */
function resetForTesting() {
    inMemoryAttendance = [];
}

module.exports = {
    parseDateString,
    findFaculty,
    markAttendance,
    deleteAttendance,
    listBranchAttendance,
    getAbsentFacultyOnDate,
    getMyAttendance,
    resetForTesting
};
