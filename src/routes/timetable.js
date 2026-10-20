/**
 * Timetable routes — read-only views and scoped management of the loaded timetable.
 *
 *   GET /api/timetable/scopes          academic years, dynamic semesters (SEM-1..SEM-N), sections
 *   GET /api/timetable                 primary class grid
 *   GET /api/timetable?class=CSE-B     another class grid
 *   GET /api/timetable?semester=SEM-1&section=A  dynamic scoped class grid
 *   GET /api/timetable?faculty=Name    one faculty's own week
 *   GET /api/timetable/meta            days, periods, classes, timings
 *   GET /api/timetable/records         the normalized records themselves
 *   POST /api/timetable/clear          HOS clear timetable for selected class scope
 */
const express = require('express');
const router = express.Router();
const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const { getBranch, getBranchSemesters, normalizeDepartmentCode } = require('../data/departments');
const { AUTHORITATIVE_PERIOD_TIMINGS } = require('../core/normalizer');
const { resolveFullSubjectName, formatTimetableGridSubjects } = require('../core/subjectResolver');

async function getClassesList() {
    if (db.isConfigured() && store.usingDatabase) {
        return repository.listClasses();
    }
    const raw = store.source && store.source.classes ? store.source.classes : [];
    return raw.map((c, i) => {
        const code = typeof c === 'string' ? c : (c.code || c.class || c.name || '');
        const dept = (c && (c.department || c.branch)) || '';
        let sec = c && c.section;
        if (!sec && code) {
            const m = code.match(/-([A-Za-z0-9])$/);
            if (m) sec = m[1].toUpperCase();
        }
        return {
            id: c.id || (i + 1),
            code,
            name: (c && c.name) || code,
            department: dept,
            branch: dept,
            semester: (c && c.semester) || null,
            academicYear: (c && (c.academicYear || c.academic_year)) || null,
            section: sec || null,
            room: (c && c.room) || null
        };
    });
}

router.get('/meta', (req, res) => {
    const engine = store.engine;
    res.json({
        ...engine.getMeta(),
        origin: store.origin,
        loadedAt: store.loadedAt,
        warnings: store.report.warnings
    });
});

const delegations = require('../data/delegations');

router.get('/scopes', async (req, res) => {
    try {
        const rawSessionDept = req.session && req.session.department ? String(req.session.department).trim() : null;
        const sessionDept = rawSessionDept ? normalizeDepartmentCode(rawSessionDept) : null;
        const rawQueryDept = req.query.branch ? String(req.query.branch).trim() : null;
        const queryDept = rawQueryDept ? normalizeDepartmentCode(rawQueryDept) : null;

        if (sessionDept && queryDept && queryDept !== sessionDept) {
            return res.status(403).json({
                error: `Cross-branch timetable queries are not allowed. Current branch is ${rawSessionDept || sessionDept}.`,
                code: 'FORBIDDEN'
            });
        }

        const effectiveBranch = sessionDept || queryDept || getBranch().code;
        const branchConfig = getBranch(effectiveBranch);
        const totalSemesters = branchConfig.totalSemesters || 6;
        const semesters = getBranchSemesters(effectiveBranch);

        const allClasses = await getClassesList();
        const branchClasses = allClasses.filter(c => {
            const dept = normalizeDepartmentCode(String(c.department || c.branch || ''));
            return !effectiveBranch || dept === effectiveBranch;
        });

        branchClasses.forEach(c => {
            if (c.semester) {
                const sNum = repository.parseSemesterNumber(c.semester);
                if (sNum && !semesters.includes(`SEM-${sNum}`)) {
                    semesters.push(`SEM-${sNum}`);
                }
            }
        });
        semesters.sort((a, b) => {
            const numA = repository.parseSemesterNumber(a) || 0;
            const numB = repository.parseSemesterNumber(b) || 0;
            return numA - numB;
        });

        const secSet = new Set(['A', 'B', 'C']);
        branchClasses.forEach(c => {
            if (c.section) {
                const cleanSec = String(c.section).trim().toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '');
                if (cleanSec) secSet.add(cleanSec);
            } else if (c.code) {
                const m = c.code.match(/[-_]([A-Za-z0-9])$/);
                if (m) secSet.add(m[1].toUpperCase());
            }
        });
        const sections = Array.from(secSet).sort();

        const defaultYear = branchConfig.academicYear || '2026-27';
        const yearSet = new Set([defaultYear, '2025-26']);
        branchClasses.forEach(c => {
            if (c.academicYear) yearSet.add(c.academicYear);
        });
        const academicYears = Array.from(yearSet).sort().reverse();

        res.json({
            branch: effectiveBranch,
            totalSemesters,
            semesters,
            academicYears,
            sections,
            classes: branchClasses
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load timetable scopes.', code: 'SERVER_ERROR' });
    }
});

router.get('/records', (req, res) => {
    const engine = store.engine;
    const { day, period, faculty, status } = req.query;

    if (req.session && req.session.role === 'faculty') {
        const sessionFaculty = req.session.facultyName || req.session.name;
        if (faculty && String(faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Forbidden: Faculty members can only access their own timetable records.',
                code: 'FORBIDDEN'
            });
        }
    }

    let records = engine.getRecords();

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

async function getFacultyGridForSession(session) {
    const facultyName = session.facultyName || session.name || session.username;
    const facultyId = session.facultyId || facultyName;
    const engine = store.engine;
    const meta = engine.getMeta();
    const defaultDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let engineDays = engine.getDays ? engine.getDays() : [];
    const days = (engineDays && engineDays.length >= 5) ? [...engineDays] : [...defaultDays];
    const periods = (engine.getPeriods && engine.getPeriods().length >= 7) ? engine.getPeriods() : [1, 2, 3, 4, 5, 6, 7];

    let personalSlots = [];
    try {
        if (db.isConfigured() && store.usingDatabase) {
            personalSlots = await repository.getFacultyPersonalTimetable(facultyId);
        } else if (typeof store.getFacultyPersonalTimetableInMemory === 'function') {
            personalSlots = store.getFacultyPersonalTimetableInMemory(facultyName);
        }
    } catch (_) {}

    if (personalSlots && personalSlots.length > 0) {
        const DAY_CANONICAL = {
            'MON': 'Monday', 'MONDAY': 'Monday', 'M': 'Monday',
            'TUE': 'Tuesday', 'TUES': 'Tuesday', 'TUESDAY': 'Tuesday', 'TU': 'Tuesday',
            'WED': 'Wednesday', 'WEDNESDAY': 'Wednesday', 'W': 'Wednesday',
            'THU': 'Thursday', 'THUR': 'Thursday', 'THURS': 'Thursday', 'THURSDAY': 'Thursday', 'TH': 'Thursday',
            'FRI': 'Friday', 'FRIDAY': 'Friday', 'F': 'Friday',
            'SAT': 'Saturday', 'SATURDAY': 'Saturday', 'S': 'Saturday',
            'SUN': 'Sunday', 'SUNDAY': 'Sunday'
        };

        const normDay = (d) => {
            if (!d) return '';
            const s = String(d).trim().toUpperCase();
            return DAY_CANONICAL[s] || (s.charAt(0) + s.slice(1).toLowerCase());
        };

        const normPeriod = (p) => {
            if (p == null) return null;
            const m = String(p).trim().match(/(\d+)/);
            return m ? parseInt(m[1], 10) : null;
        };

function normalizeClassName(className) {
    if (!className) return null;
    const s = String(className).trim();
    if (!s) return null;
    const direct = normalizeDepartmentCode(s);
    if (direct !== s) return direct;
    return s.replace(/^DCME([-_ \t]|$)/i, 'CME$1')
            .replace(/^DCSE([-_ \t]|$)/i, 'CME$1')
            .replace(/^DEEE([-_ \t]|$)/i, 'EEE$1')
            .replace(/^DMEC([-_ \t]|$)/i, 'MEC$1')
            .replace(/^DECE([-_ \t]|$)/i, 'ECE$1')
            .replace(/^DCIVIL([-_ \t]|$)/i, 'CIVIL$1');
}

        personalSlots.forEach(s => {
            const canonicalD = normDay(s.day);
            if (canonicalD && !days.includes(canonicalD)) {
                days.push(canonicalD);
            }
        });

        // Pre-calculate consecutive lab spans if not explicitly stored
        const labSpans = new Map();
        const slotsByDay = {};
        personalSlots.forEach(s => {
            const dKey = normDay(s.day);
            if (!slotsByDay[dKey]) slotsByDay[dKey] = [];
            slotsByDay[dKey].push(s);
        });
        Object.keys(slotsByDay).forEach(dKey => {
            const daySlots = slotsByDay[dKey].sort((a, b) => parseInt(a.period, 10) - parseInt(b.period, 10));
            for (let i = 0; i < daySlots.length; i++) {
                const cur = daySlots[i];
                const curType = cur.type || cur.session_type;
                const curP = parseInt(cur.period, 10);
                if (curType === 'lab' && cur.subject && !cur.spanTo && !cur.span_to) {
                    let lastP = curP;
                    let j = i + 1;
                    while (j < daySlots.length) {
                        const next = daySlots[j];
                        const nextType = next.type || next.session_type;
                        const nextP = parseInt(next.period, 10);
                        if (nextP === lastP + 1 && nextType === 'lab' && (next.subject || '').trim().toUpperCase() === (cur.subject || '').trim().toUpperCase()) {
                            lastP = nextP;
                            j++;
                        } else {
                            break;
                        }
                    }
                    if (lastP > curP) {
                        labSpans.set(`${dKey}|${curP}`, lastP);
                    }
                }
            }
        });

        const slotMap = new Map();
        personalSlots.forEach(s => {
            const dKey = normDay(s.day);
            const pKey = normPeriod(s.period != null ? s.period : s.period_number);
            if (dKey && pKey != null) {
                slotMap.set(`${dKey}|${pKey}`, s);
            }
        });

        const cells = [];
        days.forEach(day => {
            periods.forEach(period => {
                const dKey = normDay(day);
                const pKey = normPeriod(period) || (parseInt(period, 10) || 1);
                const match = slotMap.get(`${dKey}|${pKey}`);
                if (match) {
                    cells.push({
                        day,
                        period: pKey,
                        subject: resolveFullSubjectName(match.subject, { type: match.type || match.session_type, department: session.department }),
                        rawSubject: match.subject,
                        faculty: facultyName,
                        facultyId,
                        className: normalizeClassName(match.className || match.class_name),
                        room: match.room || match.room_code || null,
                        type: match.type || match.session_type || 'theory',
                        spanTo: match.spanTo || match.span_to || labSpans.get(`${dKey}|${pKey}`) || null,
                        status: 'busy',
                        isPersonal: true
                    });
                } else {
                    cells.push({
                        day,
                        period: pKey,
                        subject: null,
                        faculty: facultyName,
                        facultyId,
                        className: null,
                        room: null,
                        status: 'free',
                        isPersonal: true
                    });
                }
            });
        });

        let personalTimings = (meta && meta.periodTimings && Object.keys(meta.periodTimings).length > 0)
            ? meta.periodTimings
            : AUTHORITATIVE_PERIOD_TIMINGS;

        return {
            view: 'faculty',
            name: facultyName,
            faculty: facultyName,
            branch: session.department,
            days,
            periods,
            cells,
            periodTimings: personalTimings,
            isCustomPersonal: true
        };
    }

    let grid = engine.getFacultyGrid(facultyName);
    if (!grid) {
        const cells = [];
        days.forEach(day => periods.forEach(period => {
            cells.push({
                day, period,
                subject: null, faculty: facultyName, facultyId,
                phone: null, className: null, room: null, status: 'free'
            });
        }));
        grid = { view: 'faculty', name: facultyName, days, periods, cells };
    } else {
        grid = formatTimetableGridSubjects(grid, session.department);
    }
    let personalTimings = (meta && meta.periodTimings && Object.keys(meta.periodTimings).length > 0)
        ? meta.periodTimings
        : AUTHORITATIVE_PERIOD_TIMINGS;
    return {
        ...grid,
        faculty: facultyName,
        branch: session.department,
        periodTimings: personalTimings,
        isCustomPersonal: false
    };
}

router.get('/mine', async (req, res) => {
    if (!req.session || req.session.role !== 'faculty') {
        return res.status(401).json({ error: 'Faculty sign-in required', code: 'UNAUTHORIZED' });
    }
    const result = await getFacultyGridForSession(req.session);
    return res.json(result);
});

router.get('/', async (req, res) => {
    const engine = store.engine;

    // Faculty query parameter isolation
    if (req.session && req.session.role === 'faculty') {
        const sessionFaculty = req.session.facultyName || req.session.name;
        if (req.query.faculty && String(req.query.faculty).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Forbidden: Faculty members can only view their own timetable.',
                code: 'FORBIDDEN'
            });
        }
        if (req.query.faculty_id && req.session.facultyId && String(req.query.faculty_id) !== String(req.session.facultyId)) {
            return res.status(403).json({
                error: 'Forbidden: You cannot query another faculty_id.',
                code: 'FORBIDDEN'
            });
        }
        if (req.query.facultyName && String(req.query.facultyName).trim().toUpperCase() !== sessionFaculty.toUpperCase()) {
            return res.status(403).json({
                error: 'Forbidden: You cannot query another facultyName.',
                code: 'FORBIDDEN'
            });
        }
        if (req.query.faculty) {
            const facultyGrid = await getFacultyGridForSession(req.session);
            return res.json(facultyGrid);
        }
    }

    if (req.query.faculty) {
        let grid = engine.getFacultyGrid(req.query.faculty);
        if (!grid) {
            return res.status(404).json({ error: `No faculty named "${req.query.faculty}"`, code: 'NOT_FOUND' });
        }
        grid = formatTimetableGridSubjects(grid, effectiveBranch);
        return res.json({ ...grid, periodTimings: engine.getMeta().periodTimings });
    }

    // Branch isolation for authenticated users (HOS or Faculty)
    const sessionDept = req.session && req.session.department ? String(req.session.department || '').trim().toUpperCase() : null;

    if (sessionDept && req.query.branch) {
        const qBranch = String(req.query.branch).trim().toUpperCase();
        if (qBranch !== sessionDept) {
            return res.status(403).json({
                error: `Cross-branch timetable access is not allowed. Current branch is ${sessionDept}.`,
                code: 'FORBIDDEN'
            });
        }
    }

    const effectiveBranch = sessionDept || (req.query.branch ? String(req.query.branch).trim().toUpperCase() : getBranch().code);

    let targetClassName = req.query.class ? String(req.query.class).trim() : null;
    const requestedSemester = req.query.semester ? String(req.query.semester).trim().toUpperCase() : null;
    const requestedSection = req.query.section ? String(req.query.section).trim().toUpperCase() : null;
    const requestedYear = req.query.academicYear ? String(req.query.academicYear).trim() : null;

    // If semester and section are provided, resolve or create class scope
    if (requestedSemester && requestedSection) {
        let resolvedClass;
        if (db.isConfigured() && store.usingDatabase) {
            resolvedClass = await repository.resolveOrCreateClass({
                branch: effectiveBranch,
                academicYear: requestedYear,
                semester: requestedSemester,
                section: requestedSection
            });
        } else {
            resolvedClass = store.resolveOrCreateClassInMemory({
                branch: effectiveBranch,
                academicYear: requestedYear,
                semester: requestedSemester,
                section: requestedSection
            });
        }
        targetClassName = resolvedClass.code || resolvedClass.class;
    }

    // Branch isolation check on targetClassName
    if (targetClassName && sessionDept) {
        const allClasses = await getClassesList();
        const found = allClasses.find(c => (c.code || c.class || '').toUpperCase() === targetClassName.toUpperCase());
        if (found) {
            const classDept = String(found.department || found.branch || '').toUpperCase();
            if (classDept && classDept !== sessionDept) {
                return res.status(403).json({
                    error: `Cross-branch timetable access is not allowed. Class ${targetClassName} belongs to ${classDept}, but current branch is ${sessionDept}.`,
                    code: 'FORBIDDEN'
                });
            }
        } else {
            const prefix = targetClassName.split('-')[0].toUpperCase();
            if (prefix && prefix !== sessionDept && ['CME', 'EEE', 'CSE', 'MEC', 'ECE', 'CIVIL', 'DEEE'].includes(prefix)) {
                return res.status(403).json({
                    error: `Cross-branch timetable access is not allowed. Class ${targetClassName} belongs to ${prefix}, but current branch is ${sessionDept}.`,
                    code: 'FORBIDDEN'
                });
            }
        }
    }

    const meta = engine.getMeta();
    if (req.query.class && !requestedSemester && !requestedSection) {
        const allClasses = await getClassesList();
        const exists = meta.classes.includes(targetClassName) || allClasses.some(c => (c.code || c.class || '').toUpperCase() === targetClassName.toUpperCase());
        if (!exists) {
            return res.status(404).json({
                error: `No class "${targetClassName}". Available: ${meta.classes.join(', ')}`,
                code: 'NOT_FOUND'
            });
        }
    }

    const allClasses = await getClassesList();
    if (!targetClassName && !requestedSemester && !requestedSection) {
        const branchClasses = allClasses.filter(c => {
            const dept = String(c.department || c.branch || '').toUpperCase();
            return !effectiveBranch || dept === effectiveBranch;
        }).map(c => c.code || c.class);

        const activeClass = branchClasses.find(c => {
            const g = engine.getClassGrid(c);
            return g && Array.isArray(g.cells) && g.cells.some(cell => cell.status !== 'free' && (cell.subject || cell.faculty));
        }) || branchClasses[0];
        if (activeClass) {
            targetClassName = activeClass;
        }
    }

    if (targetClassName) {
        let grid = engine.getClassGrid(targetClassName);
        grid = formatTimetableGridSubjects(grid, effectiveBranch);
        const targetClassObj = allClasses.find(c => (c.code || c.class || '').toUpperCase() === targetClassName.toUpperCase());
        const classTimings = (grid && grid.periodTimings && Object.keys(grid.periodTimings).length > 0)
            ? grid.periodTimings
            : ((meta && meta.periodTimings && Object.keys(meta.periodTimings).length > 0)
                ? meta.periodTimings
                : AUTHORITATIVE_PERIOD_TIMINGS);

        return res.json({
            ...grid,
            periodTimings: classTimings,
            classes: meta.classes,
            primaryClass: targetClassName,
            scope: {
                branch: effectiveBranch,
                academicYear: requestedYear || (targetClassObj && targetClassObj.academicYear) || (store.source && store.source.academicYear) || getBranch(effectiveBranch).academicYear || '2026-27',
                semester: requestedSemester || (targetClassObj && targetClassObj.semester) || null,
                section: requestedSection || (targetClassObj && targetClassObj.section) || null,
                classCode: targetClassName,
                className: (targetClassObj && targetClassObj.name) || targetClassName
            }
        });
    }

    // Default: primary class
    const targetClassObj = allClasses.find(c => (c.code || c.class || '').toUpperCase() === (meta.primaryClass || '').toUpperCase());
    const defaultTimings = (meta && meta.periodTimings && Object.keys(meta.periodTimings).length > 0)
        ? meta.periodTimings
        : AUTHORITATIVE_PERIOD_TIMINGS;
    let defaultGrid = engine.getClassGrid();
    defaultGrid = formatTimetableGridSubjects(defaultGrid, effectiveBranch);
    res.json({
        ...defaultGrid,
        periodTimings: defaultTimings,
        classes: meta.classes,
        primaryClass: meta.primaryClass,
        scope: {
            branch: effectiveBranch,
            academicYear: (targetClassObj && targetClassObj.academicYear) || (store.source && store.source.academicYear) || getBranch(effectiveBranch).academicYear || '2026-27',
            semester: (targetClassObj && targetClassObj.semester) || null,
            section: (targetClassObj && targetClassObj.section) || null,
            classCode: meta.primaryClass,
            className: (targetClassObj && targetClassObj.name) || meta.primaryClass
        }
    });
});

router.post('/clear', async (req, res) => {
    try {
        const isAuthorizedHOS = req.session && (
            req.session.role === 'hos' ||
            req.session.role === 'coordinator' ||
            await delegations.isAuthorizedHOS(req.session)
        );
        if (!isAuthorizedHOS) {
            return res.status(403).json({
                error: 'Only Head of Department (HOD) can clear timetable entries.',
                code: 'FORBIDDEN'
            });
        }

        const hosBranch = String(req.session.department || '').trim().toUpperCase();
        const body = req.body || {};

        if (body.branch && String(body.branch).trim().toUpperCase() !== hosBranch) {
            return res.status(403).json({
                error: `Cross-branch timetable clear is not allowed. Current branch is ${hosBranch}.`,
                code: 'FORBIDDEN'
            });
        }

        let targetCode = body.className || body.class;
        let classId = body.classId || null;

        if (!targetCode && body.semester && body.section) {
            const sem = String(body.semester).trim().toUpperCase();
            const sec = String(body.section).trim().toUpperCase();
            const yr = body.academicYear ? String(body.academicYear).trim() : null;

            let resolved;
            if (db.isConfigured() && store.usingDatabase) {
                resolved = await repository.resolveOrCreateClass({
                    branch: hosBranch,
                    academicYear: yr,
                    semester: sem,
                    section: sec
                });
            } else {
                resolved = store.resolveOrCreateClassInMemory({
                    branch: hosBranch,
                    academicYear: yr,
                    semester: sem,
                    section: sec
                });
            }
            targetCode = resolved.code || resolved.class;
            classId = resolved.id || null;
        }

        if (!targetCode && !classId) {
            return res.status(400).json({
                error: 'Target class or semester + section is required to clear timetable.',
                code: 'MISSING_TARGET_CLASS'
            });
        }

        let result;
        if (db.isConfigured() && store.usingDatabase) {
            result = await repository.clearTimetable({
                classId,
                className: targetCode,
                branchCode: hosBranch
            });
            await store.reloadFromDatabase();
        } else {
            result = store.clearTimetableInMemory({
                classId,
                className: targetCode,
                branchCode: hosBranch
            });
        }

        res.json({
            cleared: true,
            message: `Timetable cleared for ${result.className || targetCode}.`,
            class: result.className || targetCode,
            clearedCount: result.clearedCount
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to clear timetable.',
            code: err.code || 'CLEAR_FAILED'
        });
    }
});

module.exports = router;
