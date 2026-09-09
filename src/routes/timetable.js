/**
 * Timetable routes — read-only views of the loaded timetable.
 *
 *   GET /api/timetable                 primary class grid
 *   GET /api/timetable?class=CSE-B     another class grid
 *   GET /api/timetable?faculty=Name    one faculty's own week
 *   GET /api/timetable/meta            days, periods, classes, timings
 *   GET /api/timetable/records         the normalized records themselves
 */
const express = require('express');
const router = express.Router();
const store = require('../data/store');

router.get('/meta', (req, res) => {
    const engine = store.engine;
    res.json({
        ...engine.getMeta(),
        origin: store.origin,
        loadedAt: store.loadedAt,
        warnings: store.report.warnings
    });
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

router.get('/', (req, res) => {
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

    const meta = engine.getMeta();
    const requested = req.query.class;
    if (requested && !meta.classes.includes(requested)) {
        return res.status(404).json({
            error: `No class "${requested}". Available: ${meta.classes.join(', ')}`,
            code: 'NOT_FOUND'
        });
    }

    res.json({
        ...engine.getClassGrid(requested),
        periodTimings: meta.periodTimings,
        classes: meta.classes,
        primaryClass: meta.primaryClass
    });
});

module.exports = router;
