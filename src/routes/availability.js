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

function handle(input, res) {
    const engine = store.engine;
    const slot = resolveSlot(engine, input.day, input.period);
    if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });

    const result = engine.getAvailability(slot.day, slot.period, {
        exclude: input.faculty || input.excludeFaculty || null,
        department: input.department || null,
        search: input.search || null
    });

    res.json({
        day: result.day,
        period: result.period,
        // Context echoed back from the clicked cell — the engine does not
        // trust it, day + period alone drive the lookup.
        subject: input.subject || null,
        class: input.class || input.className || null,
        availableFaculty: result.availableFaculty,
        totalAvailable: result.totalAvailable,
        available: result.available,
        busy: result.busy,
        totalBusy: result.totalBusy,
        totalFaculty: result.totalFaculty,
        excluded: input.faculty || input.excludeFaculty || null,
        readOnly: true
    });
}

router.post('/', (req, res) => handle(req.body || {}, res));
router.get('/summary', (req, res) => {
    const engine = store.engine;
    const { day, period } = req.query;

    if (day || period) {
        const slot = resolveSlot(engine, day, period);
        if (slot.error) return res.status(400).json({ error: slot.error, code: slot.code });
        return res.json(engine.getSummary(slot.day, slot.period));
    }
    res.json(engine.getSummary());
});
router.get('/', (req, res) => handle(req.query || {}, res));

// Unknown sub-paths answer in JSON rather than falling through to the SPA.
router.use((req, res) => {
    res.status(404).json({ error: `Unknown availability endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

module.exports = router;
