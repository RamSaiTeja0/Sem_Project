/**
 * Validator — classifies normalizer output into a report.
 *
 *   errors   block the timetable from loading (it would give wrong answers)
 *   warnings are shown to the user but do not block
 *
 * Checks needing the whole picture (double-booking across classes, uncovered
 * slots) live here rather than in the normalizer.
 */

function validate(normalized) {
    const errors = [];
    const warnings = [];

    (normalized.issues || []).forEach(issue => {
        const target = issue.severity === 'error' ? errors : warnings;
        target.push({ code: issue.code, message: issue.message, context: issue.context || null });
    });

    const busy = normalized.busyRecords || [];
    const meta = normalized.meta || {};
    const days = meta.days || [];
    const periods = meta.periods || [];

    // A faculty cannot teach two classes in the same slot.
    const bySlot = new Map();
    busy.forEach(record => {
        const key = `${record.faculty}|${record.day}|${record.period}`;
        const existing = bySlot.get(key);
        if (existing && existing.className !== record.className) {
            errors.push({
                code: 'DOUBLE_BOOKING',
                message: `${record.faculty} is booked in two classes at ${record.day} P${record.period} (${existing.className} / ${record.className})`,
                context: { faculty: record.faculty, day: record.day, period: record.period }
            });
        } else {
            bySlot.set(key, record);
        }
    });

    // A room cannot host two classes in the same slot. Two entries for the same
    // class in one room are a class-level clash the faculty check already
    // reports, so only cross-class collisions are raised here.
    const byRoom = new Map();
    busy.forEach(record => {
        if (!record.room) return;
        const key = `${record.room}|${record.day}|${record.period}`;
        const existing = byRoom.get(key);
        if (existing && existing.className !== record.className) {
            errors.push({
                code: 'ROOM_DOUBLE_BOOKING',
                message: `Room ${record.room} is booked by two classes at ${record.day} P${record.period} (${existing.className} / ${record.className})`,
                context: { room: record.room, day: record.day, period: record.period }
            });
        } else if (!existing) {
            byRoom.set(key, record);
        }
    });

    // Slots the primary class does not cover — informational, never invented.
    if (meta.primaryClass && days.length && periods.length) {
        const covered = new Set(busy
            .filter(r => r.className === meta.primaryClass)
            .map(r => `${r.day}|${r.period}`));
        const missing = [];
        days.forEach(day => periods.forEach(period => {
            if (!covered.has(`${day}|${period}`)) missing.push(`${day} P${period}`);
        }));
        if (missing.length) {
            warnings.push({
                code: 'UNCOVERED_SLOTS',
                message: `Primary class "${meta.primaryClass}" has no entry for ${missing.length} slot(s): ${missing.join(', ')}`,
                context: { missing }
            });
        }
    }

    const facultyCount = (normalized.faculty || []).length;

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        summary: {
            faculty: facultyCount,
            days: days.length,
            periods: periods.length,
            classes: (meta.classes || []).length,
            busySlots: busy.length,
            theorySlots: busy.filter(r => r.type === 'theory').length,
            labSlots: busy.filter(r => r.type === 'lab').length,
            totalRecords: (normalized.records || []).length,
            freeSlots: (normalized.records || []).filter(r => r.status === 'free').length
        }
    };
}

module.exports = { validate };
