/**
 * HOD Delegation / Acting HOD Data Service (Phase B9).
 *
 * Implements:
 *   - Dedicated HOD delegation management (separate from faculty attendance)
 *   - Only current permanent HOD of branch can assign or cancel delegations
 *   - Strict same-branch active faculty validation
 *   - Date range validation (startDate <= endDate) and overlap prevention
 *   - Single active Acting HOD per branch at any date
 *   - Automatic expiration when currentDate > endDate
 *   - Dual-mode support: PostgreSQL database when configured, in-memory store for standalone/tests
 */
const crypto = require('crypto');
const db = require('../db/pool');
const repository = require('../db/repository');
const store = require('./store');

// In-memory store for standalone/testing
let inMemoryDelegations = [];

function generateDelegationId() {
    return 'del_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Strict UTC calendar date parser (YYYY-MM-DD).
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

    return `${yStr}-${mStr}-${dStr}`;
}

function getTodayDateString() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve faculty record within branch.
 */
async function findBranchFaculty(needle, branchCode) {
    if (!needle || !branchCode) return null;
    const normBranch = String(branchCode).trim().toUpperCase();
    const needleStr = String(needle).trim().toUpperCase();

    // 1. Check in-memory engine faculty roster
    const roster = store.engine ? store.engine.getFaculty() : [];
    const fromRoster = roster.find(f => {
        const facBranch = f.department ? String(f.department).trim().toUpperCase() : '';
        if (facBranch && facBranch !== normBranch) return false;
        return (
            (f.id && String(f.id).toUpperCase() === needleStr) ||
            (f.code && String(f.code).toUpperCase() === needleStr) ||
            (f.name && f.name.toUpperCase() === needleStr)
        );
    });
    if (fromRoster) {
        return {
            id: fromRoster.id || null,
            code: fromRoster.code || null,
            name: fromRoster.name,
            department: normBranch,
            designation: fromRoster.designation || null,
            status: fromRoster.status || 'active'
        };
    }

    // 2. Check Database if configured
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const isNum = !isNaN(parseInt(needle, 10));
            let query = `
                SELECT f.id, f.code, f.name, f.designation, f.status, d.code AS department, d.id AS department_id
                  FROM faculty f
                  LEFT JOIN departments d ON d.id = f.department_id
                 WHERE UPPER(d.code) = $1
                   AND (
            `;
            let params = [normBranch];
            if (isNum) {
                query += `f.id = $2 OR UPPER(f.code) = UPPER($3) OR UPPER(f.name) = UPPER($3))`;
                params.push(parseInt(needle, 10), String(needle).trim());
            } else {
                query += `UPPER(f.code) = UPPER($2) OR UPPER(f.name) = UPPER($2))`;
                params.push(String(needle).trim());
            }
            const { rows } = await db.query(query, params);
            if (rows.length > 0) {
                return {
                    id: rows[0].id,
                    code: rows[0].code,
                    name: rows[0].name,
                    designation: rows[0].designation || null,
                    department: rows[0].department,
                    departmentId: rows[0].department_id,
                    status: rows[0].status || 'active'
                };
            }
        } catch (_) {}
    }

    // 3. Check registered users
    try {
        const users = require('./users');
        const userList = (typeof users.list === 'function' ? users.list(normBranch) : []) || [];
        const u = userList.find(usr =>
            usr.role === 'faculty' && (
                (usr.id && String(usr.id).toUpperCase() === needleStr) ||
                (usr.facultyId && String(usr.facultyId).toUpperCase() === needleStr) ||
                (usr.facultyCode && usr.facultyCode.toUpperCase() === needleStr) ||
                (usr.name && usr.name.toUpperCase() === needleStr) ||
                (usr.username && usr.username.toUpperCase() === needleStr)
            )
        );
        if (u) {
            return {
                id: u.facultyId || u.id,
                userId: u.id,
                username: u.username,
                code: u.facultyCode || null,
                name: u.name,
                department: normBranch,
                status: u.status || 'active'
            };
        }
    } catch (_) {}

    return null;
}

/**
 * Format and sanitize delegation record with dynamic status.
 */
function sanitizeDelegation(d, todayStr = getTodayDateString()) {
    if (!d) return null;
    const startDate = d.startDate || d.start_date;
    const endDate = d.endDate || d.end_date;
    let storedStatus = String(d.status || 'ACTIVE').toUpperCase();

    // If stored as ACTIVE, check if past end date
    let effectiveStatus = storedStatus;
    if (storedStatus === 'ACTIVE') {
        if (todayStr > endDate) {
            effectiveStatus = 'EXPIRED';
        }
    }

    const isCurrentActive = effectiveStatus === 'ACTIVE' && startDate <= todayStr && todayStr <= endDate;

    return {
        id: d.id,
        hodUserId: d.hodUserId || d.hod_user_id || null,
        hodName: d.hodName || null,
        hodUsername: d.hodUsername || null,
        branchCode: d.branchCode || d.branch_code,
        actingFacultyId: d.actingFacultyId || d.acting_faculty_id,
        actingFacultyName: d.actingFacultyName || d.acting_faculty_name || null,
        actingFacultyCode: d.actingFacultyCode || d.acting_faculty_code || null,
        actingFacultyDesignation: d.actingFacultyDesignation || d.acting_faculty_designation || null,
        actingUserId: d.actingUserId || d.acting_user_id || null,
        actingUsername: d.actingUsername || d.acting_username || null,
        startDate,
        endDate,
        status: effectiveStatus,
        isCurrentActive,
        notes: d.notes || null,
        createdAt: d.createdAt || d.created_at,
        updatedAt: d.updatedAt || d.updated_at
    };
}

/**
 * Authoritative list of eligible Acting HOD candidates for the HOD's branch.
 *
 * Enforces:
 *   1. Faculty must belong to the same branch as the current HOD.
 *   2. Faculty must be active (status === 'active').
 *   3. Faculty must have a valid linked user account that can log in (role === 'faculty', status === 'active').
 *   4. Exclude faculty records without an account.
 *   5. Exclude inactive/deactivated accounts.
 *   6. Exclude the current HOD.
 */
async function listActingHODCandidates(sessionUser) {
    if (!sessionUser || !sessionUser.department) return [];
    const branchCode = String(sessionUser.department).trim().toUpperCase();

    const hodName = sessionUser.name ? sessionUser.name.trim().toUpperCase() : '';
    const hodUser = sessionUser.username ? sessionUser.username.trim().toUpperCase() : '';
    const hodFacId = sessionUser.facultyId != null ? String(sessionUser.facultyId).trim().toUpperCase() : '';
    const hodId = sessionUser.id != null ? String(sessionUser.id).trim().toUpperCase() : '';

    const candidateMap = new Map();
    const seenFacultyIds = new Set();
    const seenFacultyCodes = new Set();
    const seenFacultyNames = new Set();
    const seenUserIds = new Set();
    const seenUsernames = new Set();

    // 1. Authoritative PostgreSQL candidate loading when database is configured and active
    if (db.isConfigured() && store.usingDatabase) {
        try {
            const { rows } = await db.query(`
                SELECT f.id AS faculty_id,
                       f.code AS faculty_code,
                       f.name AS faculty_name,
                       f.designation AS faculty_designation,
                       f.status AS faculty_status,
                       d.code AS department_code,
                       u.id AS user_id,
                       u.username,
                       u.name AS user_name,
                       u.status AS user_status,
                       u.role AS user_role
                  FROM faculty f
                  JOIN departments d ON d.id = f.department_id
                  JOIN users u ON (
                      u.faculty_id = f.id
                      OR (u.faculty_id IS NULL AND LOWER(TRIM(u.name)) = LOWER(TRIM(f.name)) AND u.department_id = d.id)
                  )
                 WHERE UPPER(d.code) = $1
                   AND f.status = 'active'
                   AND u.role = 'faculty'
                   AND u.status = 'active'
                 ORDER BY f.name ASC, u.id ASC
            `, [branchCode]);

            for (const r of rows) {
                const facIdStr = String(r.faculty_id).trim();
                const facCodeUpper = r.faculty_code ? String(r.faculty_code).trim().toUpperCase() : '';
                const facNameUpper = String(r.faculty_name).trim().toUpperCase();
                const usernameUpper = String(r.username).trim().toUpperCase();
                const userIdStr = String(r.user_id).trim();

                // Rule 6: Exclude the current HOD
                if (hodName && (facNameUpper === hodName || (r.user_name && r.user_name.trim().toUpperCase() === hodName))) continue;
                if (hodUser && usernameUpper === hodUser) continue;
                if (hodFacId && (facIdStr.toUpperCase() === hodFacId || facCodeUpper === hodFacId)) continue;
                if (hodId && userIdStr.toUpperCase() === hodId) continue;

                // Business Rule: ONE faculty member = ONE dropdown candidate
                // Deduplicate by faculty ID, faculty code, faculty name, user ID, and username
                if (
                    seenFacultyIds.has(facIdStr) ||
                    (facCodeUpper && seenFacultyCodes.has(facCodeUpper)) ||
                    seenFacultyNames.has(facNameUpper) ||
                    seenUserIds.has(userIdStr) ||
                    seenUsernames.has(usernameUpper)
                ) {
                    continue;
                }

                seenFacultyIds.add(facIdStr);
                if (facCodeUpper) seenFacultyCodes.add(facCodeUpper);
                seenFacultyNames.add(facNameUpper);
                seenUserIds.add(userIdStr);
                seenUsernames.add(usernameUpper);

                candidateMap.set(facIdStr, {
                    id: r.faculty_id,
                    facultyId: r.faculty_id,
                    code: r.faculty_code || null,
                    name: r.faculty_name,
                    designation: r.faculty_designation || 'Faculty',
                    department: branchCode,
                    userId: r.user_id,
                    username: r.username,
                    status: 'active',
                    hasAccount: true
                });
            }
        } catch (_) {}
    }

    // 2. In-memory / engine roster resolution for standalone / test mode or non-database fallback
    if (candidateMap.size === 0) {
        let roster = [];
        if (store.engine && typeof store.engine.getFaculty === 'function') {
            roster = store.engine.getFaculty().filter(f => {
                const b = f.department ? String(f.department).trim().toUpperCase() : '';
                return !b || b === branchCode;
            });
        }

        const users = require('./users');
        const registeredUsers = (typeof users.list === 'function' ? users.list(branchCode) : []) || [];

        for (const f of roster) {
            if (f.status === 'inactive') continue;

            const facIdStr = f.id != null ? String(f.id).trim() : '';
            const facCodeStr = f.code != null ? String(f.code).trim() : '';
            const facNameStr = f.name != null ? String(f.name).trim() : '';
            const facNameUpper = facNameStr.toUpperCase();
            const facCodeUpper = facCodeStr.toUpperCase();

            // Match user account using authoritative resolution
            let matchedUser = registeredUsers.find(u =>
                u.role === 'faculty' &&
                u.status !== 'inactive' &&
                u.status !== 'deactivated' && (
                    (facIdStr && u.facultyId != null && String(u.facultyId).trim().toLowerCase() === facIdStr.toLowerCase()) ||
                    (facCodeStr && u.facultyId != null && String(u.facultyId).trim().toLowerCase() === facCodeStr.toLowerCase()) ||
                    (facCodeStr && u.username && String(u.username).trim().toLowerCase() === facCodeStr.toLowerCase()) ||
                    (u.facultyCode && facCodeStr && String(u.facultyCode).trim().toLowerCase() === facCodeStr.toLowerCase()) ||
                    (u.facultyCode && facIdStr && String(u.facultyCode).trim().toLowerCase() === facIdStr.toLowerCase()) ||
                    (facNameStr && u.name && String(u.name).trim().toLowerCase() === facNameStr.toLowerCase()) ||
                    (facNameStr && u.facultyName && String(u.facultyName).trim().toLowerCase() === facNameStr.toLowerCase()) ||
                    (/^\d+$/.test(facIdStr) && u.facultyId != null && parseInt(u.facultyId, 10) === parseInt(facIdStr, 10))
                )
            );

            // Rule 4: Exclude faculty records without an account
            if (!matchedUser) continue;

            // Rule 5: Exclude inactive/deactivated accounts
            if (matchedUser.status === 'inactive' || matchedUser.status === 'deactivated') continue;

            const usernameUpper = matchedUser.username ? String(matchedUser.username).trim().toUpperCase() : '';
            const userIdStr = matchedUser.id != null ? String(matchedUser.id).trim() : '';

            // Rule 6: Exclude the current HOD
            if (hodName && (facNameUpper === hodName || (matchedUser.name && matchedUser.name.trim().toUpperCase() === hodName))) continue;
            if (hodUser && usernameUpper === hodUser) continue;
            if (hodFacId && (facIdStr.toUpperCase() === hodFacId || facCodeUpper === hodFacId)) continue;
            if (hodId && userIdStr.toUpperCase() === hodId) continue;

            // Business Rule: ONE faculty member = ONE candidate
            if (
                (facIdStr && seenFacultyIds.has(facIdStr)) ||
                (facCodeUpper && seenFacultyCodes.has(facCodeUpper)) ||
                (facNameUpper && seenFacultyNames.has(facNameUpper)) ||
                (userIdStr && seenUserIds.has(userIdStr)) ||
                (usernameUpper && seenUsernames.has(usernameUpper))
            ) {
                continue;
            }

            if (facIdStr) seenFacultyIds.add(facIdStr);
            if (facCodeUpper) seenFacultyCodes.add(facCodeUpper);
            if (facNameUpper) seenFacultyNames.add(facNameUpper);
            if (userIdStr) seenUserIds.add(userIdStr);
            if (usernameUpper) seenUsernames.add(usernameUpper);

            const key = facIdStr || userIdStr || facNameUpper;
            candidateMap.set(key, {
                id: f.id || matchedUser.facultyId || matchedUser.id,
                facultyId: f.id || matchedUser.facultyId || null,
                code: f.code || matchedUser.facultyCode || null,
                name: f.name || matchedUser.name,
                designation: f.designation || 'Faculty',
                department: branchCode,
                userId: matchedUser.id || null,
                username: matchedUser.username,
                status: 'active',
                hasAccount: true
            });
        }

        // Also check registered faculty users belonging to the branch if not in roster
        for (const u of registeredUsers) {
            if (u.role !== 'faculty' || u.status === 'inactive' || u.status === 'deactivated') continue;
            const facNameUpper = u.name ? String(u.name).trim().toUpperCase() : '';
            const usernameUpper = u.username ? String(u.username).trim().toUpperCase() : '';
            const userIdStr = u.id != null ? String(u.id).trim() : '';
            const facIdStr = u.facultyId != null ? String(u.facultyId).trim() : '';
            const facCodeUpper = u.facultyCode ? String(u.facultyCode).trim().toUpperCase() : '';

            // Rule 6: Exclude the current HOD
            if (hodName && facNameUpper === hodName) continue;
            if (hodUser && usernameUpper === hodUser) continue;
            if (hodFacId && facIdStr && facIdStr.toUpperCase() === hodFacId) continue;
            if (hodId && userIdStr.toUpperCase() === hodId) continue;

            // Business Rule: ONE faculty member = ONE candidate
            if (
                (facIdStr && seenFacultyIds.has(facIdStr)) ||
                (facCodeUpper && seenFacultyCodes.has(facCodeUpper)) ||
                (facNameUpper && seenFacultyNames.has(facNameUpper)) ||
                (userIdStr && seenUserIds.has(userIdStr)) ||
                (usernameUpper && seenUsernames.has(usernameUpper))
            ) {
                continue;
            }

            if (facIdStr) seenFacultyIds.add(facIdStr);
            if (facCodeUpper) seenFacultyCodes.add(facCodeUpper);
            if (facNameUpper) seenFacultyNames.add(facNameUpper);
            if (userIdStr) seenUserIds.add(userIdStr);
            if (usernameUpper) seenUsernames.add(usernameUpper);

            const key = facIdStr || userIdStr || facNameUpper;
            candidateMap.set(key, {
                id: u.facultyId || u.id,
                facultyId: u.facultyId || u.id,
                code: u.facultyCode || null,
                name: u.name,
                designation: u.designation || 'Faculty',
                department: branchCode,
                userId: u.id,
                username: u.username,
                status: 'active',
                hasAccount: true
            });
        }
    }

    return Array.from(candidateMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a new HOD delegation.
 * Only permanent HOD of the branch can create a delegation.
 */
async function createDelegation(data = {}, sessionUser = null) {
    if (!sessionUser || !sessionUser.username) {
        const err = new Error('Authentication required.');
        err.status = 401;
        err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role !== 'hos' && sessionUser.role !== 'coordinator') {
        const err = new Error('Only the permanent Head of Department (HOD) can assign an Acting HOD.');
        err.status = 403;
        err.code = 'FORBIDDEN';
        throw err;
    }

    const branchCode = String(sessionUser.department || '').trim().toUpperCase();
    if (!branchCode) {
        const err = new Error('HOD session has no associated branch.');
        err.status = 400;
        err.code = 'NO_BRANCH';
        throw err;
    }

    // Validate dates
    const startDate = parseDateString(data.startDate || data.start_date || data.from);
    const endDate = parseDateString(data.endDate || data.end_date || data.to);

    if (!startDate || !endDate) {
        const err = new Error('Start date and end date are required (format: YYYY-MM-DD).');
        err.status = 400;
        err.code = 'INVALID_DATES';
        throw err;
    }

    if (startDate > endDate) {
        const err = new Error('Start date cannot be after end date.');
        err.status = 400;
        err.code = 'INVALID_DATE_RANGE';
        throw err;
    }

    // Target faculty validation
    const facultyNeedle = data.facultyId || data.faculty_id || data.actingFacultyId || data.facultyName || data.name;
    if (!facultyNeedle) {
        const err = new Error('Please select an active faculty member to act as Acting HOD.');
        err.status = 400;
        err.code = 'MISSING_FACULTY';
        throw err;
    }

    const needleStr = String(facultyNeedle).trim().toUpperCase();
    if (
        (sessionUser.id && String(sessionUser.id).toUpperCase() === needleStr) ||
        (sessionUser.username && sessionUser.username.toUpperCase() === needleStr) ||
        (sessionUser.name && sessionUser.name.toUpperCase() === needleStr) ||
        (sessionUser.facultyId && String(sessionUser.facultyId).toUpperCase() === needleStr)
    ) {
        const err = new Error('Current HOD cannot assign themselves as Acting HOD.');
        err.status = 400;
        err.code = 'SELF_DELEGATION_PROHIBITED';
        throw err;
    }

    // Verify candidate from authoritative active account candidates list
    const candidates = await listActingHODCandidates(sessionUser);
    const candidate = candidates.find(c =>
        (c.id != null && String(c.id).toUpperCase() === needleStr) ||
        (c.facultyId != null && String(c.facultyId).toUpperCase() === needleStr) ||
        (c.userId != null && String(c.userId).toUpperCase() === needleStr) ||
        (c.code && c.code.toUpperCase() === needleStr) ||
        (c.name && c.name.toUpperCase() === needleStr) ||
        (c.username && c.username.toUpperCase() === needleStr)
    );

    if (!candidate) {
        const rawFaculty = await findBranchFaculty(facultyNeedle, branchCode);
        if (!rawFaculty) {
            const err = new Error(`Selected faculty was not found in branch ${branchCode}. Only active faculty from the same branch can be designated as Acting HOD.`);
            err.status = 400;
            err.code = 'FACULTY_NOT_IN_BRANCH';
            throw err;
        }
        if (rawFaculty.status === 'inactive') {
            const err = new Error('Cannot assign an inactive faculty member as Acting HOD.');
            err.status = 400;
            err.code = 'INACTIVE_FACULTY';
            throw err;
        }
        const err = new Error(`Selected faculty member (${rawFaculty.name}) does not have an active login account. Only faculty members with active login accounts can be designated as Acting HOD.`);
        err.status = 400;
        err.code = 'ACCOUNT_REQUIRED';
        throw err;
    }

    const faculty = candidate;

    // Ensure faculty DB ID
    let facultyDbId = faculty.facultyId || faculty.id;
    let actingUserId = faculty.userId || null;
    let deptDbId = null;

    if (db.isConfigured() && store.usingDatabase) {
        try {
            facultyDbId = await repository.ensureFacultyDbRecord(faculty.name, branchCode);
            // Resolve acting user account ID if exists
            const { rows: uRows } = await db.query(
                `SELECT id, username FROM users WHERE faculty_id = $1 OR (LOWER(name) = LOWER($2) AND role = 'faculty') LIMIT 1`,
                [facultyDbId, faculty.name]
            );
            if (uRows.length > 0) {
                actingUserId = uRows[0].id;
            }
            const { rows: dRows } = await db.query(
                `SELECT id FROM departments WHERE UPPER(code) = $1 LIMIT 1`,
                [branchCode]
            );
            if (dRows.length > 0) {
                deptDbId = dRows[0].id;
            }
        } catch (_) {}
    }

    // Check overlapping active delegations for this branch
    if (db.isConfigured() && store.usingDatabase) {
        const overlaps = await repository.getOverlappingHODDelegations(branchCode, startDate, endDate);
        if (overlaps.length > 0) {
            const existing = overlaps[0];
            const err = new Error(`An active delegation already exists for branch ${branchCode} (${existing.actingFacultyName}, from ${existing.startDate} to ${existing.endDate}). Only one Acting HOD can be active at a time.`);
            err.status = 409;
            err.code = 'OVERLAPPING_DELEGATION';
            throw err;
        }
    } else {
        const overlap = inMemoryDelegations.find(d =>
            d.branchCode.toUpperCase() === branchCode &&
            d.status === 'ACTIVE' &&
            d.startDate <= endDate &&
            d.endDate >= startDate
        );
        if (overlap) {
            const err = new Error(`An active delegation already exists for branch ${branchCode} (${overlap.actingFacultyName}, from ${overlap.startDate} to ${overlap.endDate}). Only one Acting HOD can be active at a time.`);
            err.status = 409;
            err.code = 'OVERLAPPING_DELEGATION';
            throw err;
        }
    }

    // Persist delegation
    let saved;
    const notes = data.notes ? String(data.notes).trim() : null;

    if (db.isConfigured() && store.usingDatabase) {
        saved = await repository.createHODDelegation({
            hodUserId: sessionUser.id || null,
            departmentId: deptDbId,
            branchCode,
            actingFacultyId: facultyDbId,
            actingUserId,
            startDate,
            endDate,
            notes
        });
        saved.actingFacultyName = faculty.name;
        saved.actingFacultyCode = faculty.code || null;
        saved.hodName = sessionUser.name;
        saved.hodUsername = sessionUser.username;
    } else {
        const newRecord = {
            id: generateDelegationId(),
            hodUserId: sessionUser.id || null,
            hodName: sessionUser.name,
            hodUsername: sessionUser.username,
            departmentId: null,
            branchCode,
            actingFacultyId: faculty.id || facultyDbId || generateDelegationId(),
            actingFacultyName: faculty.name,
            actingFacultyCode: faculty.code || null,
            actingFacultyDesignation: faculty.designation || null,
            actingUserId: faculty.userId || actingUserId || null,
            actingUsername: faculty.username || null,
            startDate,
            endDate,
            status: 'ACTIVE',
            notes,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        inMemoryDelegations.unshift(newRecord);
        saved = newRecord;
    }

    return sanitizeDelegation(saved);
}

/**
 * List delegations for a branch.
 */
async function listDelegations(branchCode, sessionUser = null) {
    const normBranch = branchCode ? String(branchCode).trim().toUpperCase() : (sessionUser && sessionUser.department ? String(sessionUser.department).trim().toUpperCase() : null);
    if (!normBranch) return [];

    let rows = [];
    if (db.isConfigured() && store.usingDatabase) {
        rows = await repository.listHODDelegations(normBranch);
    } else {
        rows = inMemoryDelegations.filter(d => d.branchCode.toUpperCase() === normBranch);
    }

    return rows.map(r => sanitizeDelegation(r));
}

/**
 * Cancel an existing or future delegation.
 * Only permanent HOD of the branch can cancel delegations.
 */
async function cancelDelegation(delegationId, sessionUser = null) {
    if (!sessionUser || !sessionUser.username) {
        const err = new Error('Authentication required.');
        err.status = 401;
        err.code = 'UNAUTHENTICATED';
        throw err;
    }

    if (sessionUser.role !== 'hos' && sessionUser.role !== 'coordinator') {
        const err = new Error('Only the permanent Head of Department (HOD) can cancel a delegation.');
        err.status = 403;
        err.code = 'FORBIDDEN';
        throw err;
    }

    const branchCode = String(sessionUser.department || '').trim().toUpperCase();

    if (db.isConfigured() && store.usingDatabase) {
        const numId = parseInt(delegationId, 10);
        if (isNaN(numId)) {
            const err = new Error('Invalid delegation ID.');
            err.status = 400;
            err.code = 'INVALID_ID';
            throw err;
        }
        const existing = await repository.getHODDelegationById(numId);
        if (!existing) {
            const err = new Error('Delegation not found.');
            err.status = 404;
            err.code = 'NOT_FOUND';
            throw err;
        }
        if (existing.branchCode.toUpperCase() !== branchCode) {
            const err = new Error(`Cross-branch delegation cancellation is forbidden. Current branch is ${branchCode}.`);
            err.status = 403;
            err.code = 'BRANCH_FORBIDDEN';
            throw err;
        }

        const cancelled = await repository.cancelHODDelegation(numId, branchCode);
        return { success: true, delegationId: numId, status: 'CANCELLED' };
    } else {
        const match = inMemoryDelegations.find(d => String(d.id) === String(delegationId));
        if (!match) {
            const err = new Error('Delegation not found.');
            err.status = 404;
            err.code = 'NOT_FOUND';
            throw err;
        }
        if (match.branchCode.toUpperCase() !== branchCode) {
            const err = new Error(`Cross-branch delegation cancellation is forbidden. Current branch is ${branchCode}.`);
            err.status = 403;
            err.code = 'BRANCH_FORBIDDEN';
            throw err;
        }

        match.status = 'CANCELLED';
        match.updatedAt = new Date().toISOString();
        return { success: true, delegationId: match.id, status: 'CANCELLED' };
    }
}

/**
 * Check if a faculty member has an active delegation on targetDate (default today).
 */
async function getActiveDelegationForFaculty(sessionUser, targetDate = null) {
    if (!sessionUser || !sessionUser.department) return null;
    const dateStr = parseDateString(targetDate) || getTodayDateString();
    const branchCode = String(sessionUser.department).trim().toUpperCase();
    const userRole = sessionUser.role ? String(sessionUser.role).toLowerCase() : '';

    // Only faculty accounts can be Acting HOD
    if (userRole !== 'faculty') return null;

    let activeList = [];
    if (db.isConfigured() && store.usingDatabase) {
        activeList = await repository.getActiveHODDelegations(branchCode, dateStr);
    } else {
        activeList = inMemoryDelegations.filter(d =>
            d.branchCode.toUpperCase() === branchCode &&
            d.status === 'ACTIVE' &&
            d.startDate <= dateStr &&
            d.endDate >= dateStr
        );
    }

    const facIdStr = sessionUser.facultyId != null ? String(sessionUser.facultyId).toUpperCase() : '';
    const userIdStr = sessionUser.id != null ? String(sessionUser.id).toUpperCase() : '';
    const nameStr = sessionUser.name ? String(sessionUser.name).trim().toUpperCase() : '';
    const facultyNameStr = sessionUser.facultyName ? String(sessionUser.facultyName).trim().toUpperCase() : '';
    const usernameStr = sessionUser.username ? String(sessionUser.username).trim().toUpperCase() : '';

    const matched = activeList.find(d => {
        const dFacId = d.actingFacultyId != null ? String(d.actingFacultyId).toUpperCase() : (d.acting_faculty_id != null ? String(d.acting_faculty_id).toUpperCase() : '');
        const dUserId = d.actingUserId != null ? String(d.actingUserId).toUpperCase() : (d.acting_user_id != null ? String(d.acting_user_id).toUpperCase() : '');
        const dFacName = d.actingFacultyName ? String(d.actingFacultyName).trim().toUpperCase() : (d.acting_faculty_name ? String(d.acting_faculty_name).trim().toUpperCase() : '');
        const dUsername = d.actingUsername ? String(d.actingUsername).trim().toUpperCase() : (d.acting_username ? String(d.acting_username).trim().toUpperCase() : '');

        if (facIdStr && dFacId && facIdStr === dFacId) return true;
        if (userIdStr && dUserId && userIdStr === dUserId) return true;
        if (usernameStr && dUsername && usernameStr === dUsername) return true;
        if (nameStr && dFacName && nameStr === dFacName) return true;
        if (facultyNameStr && dFacName && facultyNameStr === dFacName) return true;

        return false;
    });

    return matched ? sanitizeDelegation(matched, dateStr) : null;
}

/**
 * Check if the branch has an active delegation on targetDate.
 */
async function getActiveDelegationForBranch(branchCode, targetDate = null) {
    if (!branchCode) return null;
    const dateStr = parseDateString(targetDate) || getTodayDateString();
    const normBranch = String(branchCode).trim().toUpperCase();

    let activeList = [];
    if (db.isConfigured() && store.usingDatabase) {
        activeList = await repository.getActiveHODDelegations(normBranch, dateStr);
    } else {
        activeList = inMemoryDelegations.filter(d =>
            d.branchCode.toUpperCase() === normBranch &&
            d.status === 'ACTIVE' &&
            d.startDate <= dateStr &&
            d.endDate >= dateStr
        );
    }

    return activeList.length > 0 ? sanitizeDelegation(activeList[0], dateStr) : null;
}

/**
 * Check whether a session is authorized as HOS (permanent HOS OR active Acting HOD).
 */
async function isAuthorizedHOS(sessionUser, targetDate = null) {
    if (!sessionUser || !sessionUser.username) return false;
    const role = String(sessionUser.role || '').toLowerCase();

    // 1. Permanent HOS / coordinator / admin
    if (role === 'hos' || role === 'coordinator' || role === 'admin') {
        return true;
    }

    // 2. Faculty with active delegation
    if (role === 'faculty') {
        const activeDelegation = await getActiveDelegationForFaculty(sessionUser, targetDate);
        return Boolean(activeDelegation);
    }

    return false;
}

function wipeInMemoryStore() {
    inMemoryDelegations = [];
}

module.exports = {
    createDelegation,
    listDelegations,
    cancelDelegation,
    getActiveDelegationForFaculty,
    getActiveDelegationForBranch,
    isAuthorizedHOS,
    listActingHODCandidates,
    parseDateString,
    getTodayDateString,
    wipeInMemoryStore
};
