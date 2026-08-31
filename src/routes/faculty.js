/**
 * Faculty routes — roster and per-faculty load.
 *
 *   GET /api/faculty                       all faculty with free/busy counts
 *   GET /api/faculty?department=CSE        filter by department
 *   GET /api/faculty?search=rao            filter by name
 *   GET /api/faculty/departments           the distinct department list
 */
const express = require('express');
const router = express.Router();
const store = require('../data/store');

router.get('/departments', (req, res) => {
    const departments = [...new Set(store.engine.getFaculty().map(f => f.department))].sort();
    res.json({ departments });
});

router.get('/', (req, res) => {
    const { department, search } = req.query;
    let stats = store.engine.getFacultyStats();

    if (department) {
        const wanted = String(department).trim().toUpperCase();
        stats = stats.filter(f => (f.department || '').toUpperCase() === wanted);
    }
    if (search) {
        const needle = String(search).trim().toUpperCase();
        stats = stats.filter(f =>
            f.name.toUpperCase().includes(needle) || f.id.toUpperCase().includes(needle));
    }

    res.json({ count: stats.length, faculty: stats });
});

module.exports = router;
