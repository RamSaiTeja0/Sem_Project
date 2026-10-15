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
const db = require('../db/pool');
const config = require('../config');

const { getBranch, getRegisteredBranchCodes } = require('../data/departments');
const attendance = require('../data/attendance');
const invigilation = require('../data/invigilation');
const { AUTHORITATIVE_PERIOD_TIMINGS } = require('../core/normalizer');

/**
 * Returns active faculty who have valid active faculty login accounts (role = 'faculty').
 * Relational join: faculty.id = users.faculty_id
 */
async function getActiveFacultyWithAccounts(branchCode = null) {
    const bUpper = branchCode ? String(branchCode).trim().toUpperCase() : null;
    if (db.isConfigured() && store.usingDatabase) {
        try {
            let query = `
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
            `;
            const params = [];
            if (bUpper) {
                params.push(bUpper);
                query += ` AND UPPER(d.code) = $${params.length}`;
            }
            query += ` ORDER BY f.name`;
            const { rows } = await db.query(query, params);
            if (rows.length > 0) return rows;

            let fallbackQuery = `
                SELECT f.id, f.code, f.name, f.department_id, d.code AS branch,
                       f.designation,
                       COALESCE(
                           NULLIF(f.phone, ''),
                           (SELECT NULLIF(u.phone, '') FROM users u WHERE (u.faculty_id = f.id OR UPPER(u.username) = UPPER(f.code)) AND u.phone IS NOT NULL AND u.phone <> '' LIMIT 1)
                       ) AS phone
                  FROM faculty f
                  LEFT JOIN departments d ON d.id = f.department_id
                 WHERE (f.status = 'active' OR f.status IS NULL)
            `;
            const fallbackParams = [];
            if (bUpper) {
                fallbackParams.push(bUpper);
                fallbackQuery += ` AND UPPER(d.code) = $${fallbackParams.length}`;
            }
            fallbackQuery += ` ORDER BY f.name`;
            const fallback = await db.query(fallbackQuery, fallbackParams);
            return fallback.rows;
        } catch (err) {
            console.error('[db] Error loading active faculty with accounts:', err.message);
            return [];
        }
    }

    const usersModule = require('../data/users');
    const memUsers = (typeof usersModule.list === 'function' ? usersModule.list() : []) || [];
    const validMemUsers = memUsers.filter(u =>
        u.role === 'faculty' &&
        (!bUpper || (u.department || '').trim().toUpperCase() === bUpper) &&
        (u.active === true || u.active === undefined) &&
        (u.status === 'active' || u.status === undefined)
    );

    const roster = store.engine ? store.engine.getFaculty() : [];
    const filteredRoster = bUpper
        ? roster.filter(f => (f.department || '').trim().toUpperCase() === bUpper)
        : roster;
    const matched = [];
    for (const u of validMemUsers) {
        const uFacId = u.facultyId || u.faculty_id;
        const uName = u.name || u.facultyName;
        const fac = filteredRoster.find(f =>
            (uFacId != null && f.id != null && String(f.id).toUpperCase() === String(uFacId).toUpperCase()) ||
            (uFacId != null && f.code != null && String(f.code).toUpperCase() === String(uFacId).toUpperCase()) ||
            (uName != null && f.name != null && String(f.name).trim().toUpperCase() === String(uName).trim().toUpperCase())
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
    if (matched.length === 0 && filteredRoster.length > 0) {
        return filteredRoster.filter(f => f.status !== 'inactive').map(fac => ({
            id: fac.id,
            code: fac.code,
            name: fac.name,
            branch: fac.department || fac.branch,
            department_id: fac.department_id,
            role: 'faculty',
            user_status: 'active',
            user_active: true,
            designation: fac.designation || 'Faculty',
            phone: fac.phone || null
        }));
    }
    return matched;
}

function buildFacultyPhoneResolver(validFacultyList) {
    const facultyPhoneMap = new Map();
    if (Array.isArray(validFacultyList)) {
        validFacultyList.forEach(f => {
            const ph = f.phone ? String(f.phone).trim() : null;
            if (ph) {
                if (f.id != null) facultyPhoneMap.set(String(f.id), ph);
                if (f.code != null) facultyPhoneMap.set(String(f.code).toUpperCase(), ph);
                if (f.name != null) facultyPhoneMap.set(String(f.name).trim().toUpperCase(), ph);
                if (f.facultyName != null) facultyPhoneMap.set(String(f.facultyName).trim().toUpperCase(), ph);
            }
        });
    }
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

    return function resolvePhone(r) {
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
}

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

function resolveAbsentFaculty(validFacultyList, input, branchCode) {
    const raw = input.absentFaculty || input.absent || input.faculty || input.excludeFaculty;
    if (!raw) return { member: null };

    const needle = String(typeof raw === 'object' ? (raw.name || raw.id || raw.code) : raw).trim().toUpperCase();
    const found = (validFacultyList || []).find(f => {
        const matchesName = f.name && f.name.toUpperCase() === needle;
        const matchesId = f.id != null && String(f.id).toUpperCase() === needle;
        const matchesCode = f.code && String(f.code).toUpperCase() === needle;
        const matchesBranch = !branchCode || !f.branch || f.branch.toUpperCase() === branchCode.toUpperCase();
        return (matchesName || matchesId || matchesCode) && matchesBranch;
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

    // Date handling: parse UTC calendar date and auto-derive day if omitted
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

    // Load active faculty who have valid active login accounts
    const validFacultyList = await getActiveFacultyWithAccounts();
    const validFacultyIds = new Set(validFacultyList.map(f => String(f.id)));
    const validFacultyNames = new Set(validFacultyList.map(f => (f.name || '').toUpperCase()));

    // Resolve & Validate Absent Faculty
    const absentResult = resolveAbsentFaculty(validFacultyList, input, branchCode);
    if (absentResult.error) {
        return res.status(400).json({ error: absentResult.error, code: absentResult.code });
    }
    const absentMember = absentResult.member;

    // Determine priority branch (absent faculty's branch wins, else current branch context)
    const priorityBranch = absentMember
        ? (absentMember.branch || branchCode || null)
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

    const isAllowed = r => {
        if (!r) return false;
        const idStr = r.facultyId != null ? String(r.facultyId) : (r.id != null ? String(r.id) : null);
        if (idStr && validFacultyIds.has(idStr)) return true;
        const nameUpper = (r.faculty || r.name || r.facultyName || '').toUpperCase();
        if (nameUpper && validFacultyNames.has(nameUpper)) return true;
        return false;
    };

    const resolvePhone = buildFacultyPhoneResolver(validFacultyList);
    const enrichPhone = r => {
        if (!r) return r;
        return {
            ...r,
            phone: resolvePhone(r)
        };
    };

    const filteredAvailable = (result.available || []).filter(isAllowed).map(enrichPhone);
    const filteredBusy = (result.busy || []).filter(isAllowed).map(enrichPhone);
    const filteredSameBranchAvailable = (result.sameBranch ? result.sameBranch.available : []).filter(isAllowed).map(enrichPhone);
    const filteredOtherBranchesAvailable = (result.otherBranches ? result.otherBranches.available : []).filter(isAllowed).map(enrichPhone);

    const branchFaculty = validFacultyList.filter(f =>
        !priorityBranch || (f.branch || '').toUpperCase() === priorityBranch.toUpperCase()
    );
    const totalBranchFaculty = branchFaculty.length;

    // Build unified faculty list with status FREE / BUSY
    const facultyList = [
        ...filteredAvailable.map(r => ({
            id: r.facultyId || r.id,
            facultyId: r.facultyId || r.id,
            name: r.faculty,
            facultyName: r.faculty,
            department: r.department,
            branch: r.department,
            phone: resolvePhone(r),
            status: 'FREE',
            reason: null,
            isSameBranch: r.isSameBranch
        })),
        ...filteredBusy.map(r => ({
            id: r.facultyId || r.id,
            facultyId: r.facultyId || r.id,
            name: r.faculty,
            facultyName: r.faculty,
            department: r.department,
            branch: r.department,
            phone: resolvePhone(r),
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
            const abIdStr = String(ab.faculty_id || ab.id);
            const abNameUpper = (ab.name || '').toUpperCase();
            if (validFacultyIds.has(abIdStr) || validFacultyNames.has(abNameUpper)) {
                facultyList.push({
                    id: ab.faculty_id || ab.id,
                    facultyId: ab.faculty_id || ab.id,
                    name: ab.name,
                    facultyName: ab.name,
                    department: ab.department,
                    branch: ab.department,
                    phone: resolvePhone(ab),
                    status: 'ABSENT',
                    reason: null,
                    isSameBranch: Boolean(priorityBranch && (ab.department || '').toUpperCase() === priorityBranch.toUpperCase())
                });
            }
        });
    }

    // Build allFaculty overview (includes FREE, BUSY, ABSENT)
    const busyMap = new Map();
    filteredBusy.forEach(b => {
        if (b.faculty) busyMap.set(b.faculty.toUpperCase(), b);
        if (b.facultyId) busyMap.set(String(b.facultyId), b);
    });
    const absentNamesSet = new Set(absentFacultyList.map(n => n.toUpperCase()));
    const absentIdsSet = new Set(absentRecords.map(r => String(r.faculty_id || r.id)).filter(Boolean));
    if (absentMember) {
        if (absentMember.name) absentNamesSet.add(absentMember.name.toUpperCase());
        if (absentMember.id) absentIdsSet.add(String(absentMember.id));
    }

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
                department: f.branch || f.department,
                branch: f.branch || f.department,
                phone: resolvePhone(f),
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
                    department: f.branch || f.department,
                    branch: f.branch || f.department,
                    phone: resolvePhone(f),
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
                    department: f.branch || f.department,
                    branch: f.branch || f.department,
                    phone: resolvePhone(f),
                    status: 'FREE',
                    reason: null,
                    isSameBranch: true
                });
            }
        }
    });

    allFaculty.sort((a, b) => a.facultyName.localeCompare(b.facultyName));

    filteredOtherBranchesAvailable.forEach(ob => {
        allFaculty.push({
            id: ob.facultyId || ob.id,
            facultyId: ob.facultyId || ob.id,
            name: ob.faculty,
            facultyName: ob.faculty,
            department: ob.department,
            branch: ob.department,
            phone: resolvePhone(ob),
            status: 'FREE',
            reason: null,
            isSameBranch: false
        });
    });

    let emptyState = null;
    if (validFacultyList.length === 0) {
        emptyState = 'No faculty accounts available.';
    } else if (totalBranchFaculty === 0 && filteredAvailable.length === 0) {
        emptyState = 'No faculty accounts available for this branch.';
    } else if (filteredAvailable.length === 0) {
        emptyState = 'No faculty accounts are free during this period.';
    }

    res.json({
        date: requestedDate,
        day: result.day,
        period: result.period,
        branch: branchCode,
        department: branchCode,
        priorityBranch: priorityBranch,
        absentFaculty: absentMember ? { id: absentMember.id, name: absentMember.name, department: absentMember.branch || absentMember.department, phone: resolvePhone(absentMember) } : null,
        absentList: absentFacultyList,
        faculty: facultyList,
        allFaculty: allFaculty,
        subject: input.subject || null,
        class: input.class || input.className || null,
        availableFaculty: filteredAvailable.map(r => r.faculty),
        available: filteredAvailable,
        sameBranch: {
            branch: priorityBranch,
            available: filteredSameBranchAvailable,
            total: filteredSameBranchAvailable.length,
            totalAvailable: filteredSameBranchAvailable.length
        },
        otherBranches: {
            available: filteredOtherBranchesAvailable,
            total: filteredOtherBranchesAvailable.length,
            totalAvailable: filteredOtherBranchesAvailable.length
        },
        busy: filteredBusy,
        totalAvailable: filteredAvailable.length,
        totalBusy: filteredBusy.length,
        totalFaculty: totalBranchFaculty,
        periodTimings: (engine && engine.getMeta && engine.getMeta().periodTimings && Object.keys(engine.getMeta().periodTimings).length > 0)
            ? engine.getMeta().periodTimings
            : AUTHORITATIVE_PERIOD_TIMINGS,
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

    // Load active faculty with valid active login accounts
    const validFacultyList = await getActiveFacultyWithAccounts();
    const validFacultyIds = new Set(validFacultyList.map(f => String(f.id)));
    const validFacultyNames = new Set(validFacultyList.map(f => (f.name || '').toUpperCase()));

    // Collect absent faculty names & IDs
    const absentFacultyList = absentRecords.map(r => r.name);
    const absentFacultyNamesSet = new Set(absentFacultyList.map(n => n.toUpperCase()));
    const absentFacultyIdsSet = new Set(absentRecords.map(r => String(r.faculty_id || r.id)).filter(Boolean));

    if (input.absentFaculty || input.vacantFaculty || input.excludeFaculty) {
        const extra = resolveAbsentFaculty(validFacultyList, input, branchCode);
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

    const isAllowed = r => {
        if (!r) return false;
        const idStr = r.facultyId != null ? String(r.facultyId) : (r.id != null ? String(r.id) : null);
        if (idStr && validFacultyIds.has(idStr)) return true;
        const nameUpper = (r.faculty || r.name || r.facultyName || '').toUpperCase();
        if (nameUpper && validFacultyNames.has(nameUpper)) return true;
        return false;
    };

    const resolveHOSPhone = buildFacultyPhoneResolver(validFacultyList);
    const enrichHOSPhone = r => {
        if (!r) return r;
        return {
            ...r,
            phone: resolveHOSPhone(r)
        };
    };

    const filteredAvailable = (result.available || []).filter(isAllowed).map(enrichHOSPhone);
    const filteredBusy = (result.busy || []).filter(isAllowed).map(enrichHOSPhone);
    const filteredSameBranch = (result.sameBranch ? result.sameBranch.available : []).filter(isAllowed).map(enrichHOSPhone);
    const filteredOtherBranches = (result.otherBranches ? result.otherBranches.available : []).filter(isAllowed).map(enrichHOSPhone);

    // Candidates: ONLY FREE faculty with active accounts
    const candidates = filteredAvailable.map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: resolveHOSPhone(r),
        status: 'FREE',
        reason: null,
        isSameBranch: r.isSameBranch
    }));

    const sameBranchCandidates = filteredSameBranch.map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: resolveHOSPhone(r),
        status: 'FREE',
        reason: null,
        isSameBranch: true
    }));

    const otherBranchCandidates = filteredOtherBranches.map(r => ({
        facultyId: r.facultyId || r.id,
        id: r.facultyId || r.id,
        facultyName: r.faculty,
        name: r.faculty,
        department: r.department,
        branch: r.department,
        phone: resolveHOSPhone(r),
        status: 'FREE',
        reason: null,
        isSameBranch: false
    }));

    // Status Overview table (Same branch all states + Other branch FREE candidates)
    const busyMap = new Map();
    filteredBusy.forEach(b => {
        if (b.faculty) busyMap.set(b.faculty.toUpperCase(), b);
        if (b.facultyId) busyMap.set(String(b.facultyId), b);
    });

    const branchFaculty = validFacultyList.filter(f =>
        !priorityBranch || (f.branch || '').toUpperCase() === priorityBranch.toUpperCase()
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
                department: f.branch || f.department,
                branch: f.branch || f.department,
                phone: resolveHOSPhone(f),
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
                    department: f.branch || f.department,
                    branch: f.branch || f.department,
                    phone: resolveHOSPhone(f),
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
                    department: f.branch || f.department,
                    branch: f.branch || f.department,
                    phone: resolveHOSPhone(f),
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
            phone: resolveHOSPhone(c),
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
        periodTimings: (engine && engine.getMeta && engine.getMeta().periodTimings && Object.keys(engine.getMeta().periodTimings).length > 0)
            ? engine.getMeta().periodTimings
            : AUTHORITATIVE_PERIOD_TIMINGS,
        readOnly: true
    });
}

router.get('/candidates', requireHOSCandidateAccess, (req, res, next) => handleCandidates(req, req.query || {}, res).catch(next));
router.post('/candidates', requireHOSCandidateAccess, (req, res, next) => handleCandidates(req, req.body || {}, res).catch(next));
router.post('/hos', requireHOS, (req, res, next) => handle(req, req.body || {}, res, true).catch(next));
router.get('/hos', requireHOS, (req, res, next) => handle(req, req.query || {}, res, true).catch(next));
router.post('/', (req, res, next) => handle(req, req.body || {}, res).catch(next));
router.get('/', (req, res, next) => handle(req, req.query || {}, res).catch(next));
router.get('/summary', async (req, res, next) => {
    try {
        const engine = store.engine;
        const { day, period } = req.query;
        const branchCode = req.query.branch || req.query.department || (req.session && req.session.department) || null;

        const timings = (engine && engine.getMeta && engine.getMeta().periodTimings && Object.keys(engine.getMeta().periodTimings).length > 0)
            ? engine.getMeta().periodTimings
            : AUTHORITATIVE_PERIOD_TIMINGS;

        const validFacultyList = await getActiveFacultyWithAccounts(branchCode);
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

        if (day || period) {
            const slot = resolveSlot(engine, day, period);
            if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });
            const rawSummary = engine.getSummary(slot.day, slot.period, branchCode);
            const slotAvailable = (rawSummary.selected && rawSummary.selected.available != null) ? rawSummary.selected.available : 0;
            const slotBusy = (rawSummary.selected && rawSummary.selected.busy != null) ? rawSummary.selected.busy : 0;
            return res.json({
                ...rawSummary,
                totalFaculty: validFacultyList.length > 0 ? validFacultyList.length : rawSummary.totalFaculty,
                totalAvailable: slotAvailable,
                totalBusy: slotBusy,
                periodTimings: timings
            });
        }

        const rawSummary = engine.getSummary(null, null, branchCode);
        res.json({
            ...rawSummary,
            totalFaculty: validFacultyList.length > 0 ? validFacultyList.length : rawSummary.totalFaculty,
            periodTimings: timings
        });
    } catch (err) {
        next(err);
    }
});

// Unknown sub-paths answer in JSON rather than falling through to the SPA.
router.use((req, res) => {
    res.status(404).json({ error: `Unknown availability endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

module.exports = router;
