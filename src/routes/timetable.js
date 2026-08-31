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

router.get('/', (req, res) => {
    const engine = store.engine;

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
