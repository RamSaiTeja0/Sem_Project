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
const { getBranch, getBranchSemesters } = require('../data/departments');

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

router.get('/scopes', async (req, res) => {
    try {
        const isHOS = req.session && (req.session.role === 'hos' || req.session.role === 'coordinator');
        const sessionDept = req.session && req.session.department ? String(req.session.department).trim().toUpperCase() : null;
        const queryDept = req.query.branch ? String(req.query.branch).trim().toUpperCase() : null;

        if (isHOS && queryDept && sessionDept && queryDept !== sessionDept) {
            return res.status(403).json({
                error: `Cross-branch timetable queries are not allowed. Current branch is ${sessionDept}.`,
                code: 'FORBIDDEN'
            });
        }

        const effectiveBranch = sessionDept || queryDept || getBranch().code;
        const branchConfig = getBranch(effectiveBranch);
        const totalSemesters = branchConfig.totalSemesters || 6;
        const semesters = getBranchSemesters(effectiveBranch);

        const allClasses = await getClassesList();
        const branchClasses = allClasses.filter(c => {
            const dept = String(c.department || c.branch || '').toUpperCase();
            return !effectiveBranch || dept === effectiveBranch;
        });

        const secSet = new Set(['A', 'B', 'C']);
        branchClasses.forEach(c => {
            if (c.section) secSet.add(c.section.toUpperCase());
            else if (c.code) {
                const m = c.code.match(/-([A-Za-z0-9])$/);
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

router.get('/mine', (req, res) => {
    if (!req.session || req.session.role !== 'faculty') {
        return res.status(401).json({ error: 'Faculty sign-in required', code: 'UNAUTHORIZED' });
    }
    const facultyName = req.session.facultyName || req.session.name;
    const engine = store.engine;
    let grid = engine.getFacultyGrid(facultyName);
    const meta = engine.getMeta();
    if (!grid) {
        const days = engine.getDays();
        const periods = engine.getPeriods();
        const cells = [];
        days.forEach(day => periods.forEach(period => {
            cells.push({
                day, period,
                subject: null, faculty: facultyName, facultyId: req.session.facultyId || null,
                phone: null, className: null, room: null, status: 'free'
            });
        }));
        grid = { view: 'faculty', name: facultyName, days, periods, cells };
    }
    res.json({
        ...grid,
        faculty: facultyName,
        branch: req.session.department,
        periodTimings: meta.periodTimings
    });
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
    }

    if (req.query.faculty) {
        const grid = engine.getFacultyGrid(req.query.faculty);
        if (!grid) {
            return res.status(404).json({ error: `No faculty named "${req.query.faculty}"`, code: 'NOT_FOUND' });
        }
        return res.json({ ...grid, periodTimings: engine.getMeta().periodTimings });
    }

    // Branch isolation for HOS
    const isHOS = req.session && (req.session.role === 'hos' || req.session.role === 'coordinator');
    const hosDept = isHOS ? String(req.session.department || '').trim().toUpperCase() : null;

    if (isHOS && req.query.branch) {
        const qBranch = String(req.query.branch).trim().toUpperCase();
        if (qBranch !== hosDept) {
            return res.status(403).json({
                error: `Cross-branch timetable access is not allowed. Current branch is ${hosDept}.`,
                code: 'FORBIDDEN'
            });
        }
    }

    const effectiveBranch = hosDept || (req.query.branch ? String(req.query.branch).trim().toUpperCase() : getBranch().code);

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
    if (targetClassName && isHOS) {
        const allClasses = await getClassesList();
        const found = allClasses.find(c => (c.code || c.class || '').toUpperCase() === targetClassName.toUpperCase());
        if (found) {
            const classDept = String(found.department || found.branch || '').toUpperCase();
            if (classDept && classDept !== hosDept) {
                return res.status(403).json({
                    error: `Cross-branch timetable access is not allowed. Class ${targetClassName} belongs to ${classDept}, but current branch is ${hosDept}.`,
                    code: 'FORBIDDEN'
                });
            }
        } else {
            const prefix = targetClassName.split('-')[0].toUpperCase();
            if (prefix && prefix !== hosDept && ['CME', 'EEE', 'CSE', 'MEC', 'ECE', 'CIVIL', 'DEEE'].includes(prefix)) {
                return res.status(403).json({
                    error: `Cross-branch timetable access is not allowed. Class ${targetClassName} belongs to ${prefix}, but current branch is ${hosDept}.`,
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

    if (targetClassName) {
        const grid = engine.getClassGrid(targetClassName);
        return res.json({
            ...grid,
            periodTimings: meta.periodTimings,
            classes: meta.classes,
            primaryClass: targetClassName,
            scope: {
                branch: effectiveBranch,
                academicYear: requestedYear,
                semester: requestedSemester,
                section: requestedSection,
                classCode: targetClassName
            }
        });
    }

    // Default: primary class
    res.json({
        ...engine.getClassGrid(),
        periodTimings: meta.periodTimings,
        classes: meta.classes,
        primaryClass: meta.primaryClass
    });
});

router.post('/clear', async (req, res) => {
    try {
        if (!req.session || (req.session.role !== 'hos' && req.session.role !== 'coordinator')) {
            return res.status(403).json({
                error: 'Only Head of Section (HOS) can clear timetable entries.',
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
