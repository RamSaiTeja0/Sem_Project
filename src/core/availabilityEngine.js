/**
 * Availability engine — the core of TecSubstitution.
 *
 * Reads only normalized records:
 *   { faculty, day, period, subject, className, status: 'busy' | 'free' }
 *
 * A faculty is FREE at a day + period when no record marks them busy there,
 * across every timetable loaded. The engine is pure: it takes plain data, has
 * no Express/DOM/database dependency, and never writes anything.
 */

const { normalizeDayName, normalizePeriodNumber } = require('./normalizer');

function slotKey(day, period) { return `${day}|${period}`; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

/**
 * @param {object} normalized  output of normalize(), already validated
 * @returns query interface
 */
function createEngine(normalized) {
    if (!normalized || !Array.isArray(normalized.records)) {
        throw new Error('Availability engine requires normalized timetable data');
    }

    const meta = normalized.meta;
    const faculty = normalized.faculty;
    const days = meta.days.slice();
    const periods = meta.periods.slice();

    // Index every slot once: availability is then a map lookup, not a scan.
    const bySlot = new Map();
    days.forEach(day => periods.forEach(period => {
        bySlot.set(slotKey(day, period), { busy: [], free: [] });
    }));

    normalized.records.forEach(record => {
        const slot = bySlot.get(slotKey(record.day, record.period));
        if (!slot) return;
        (record.status === 'busy' ? slot.busy : slot.free).push(record);
    });

    /** Class timetable grid: one cell per day + period. */
    function classGrid(className) {
        const target = className || meta.primaryClass;
        const byCoordinate = new Map();
        normalized.busyRecords
            .filter(r => r.className === target)
            .forEach(r => byCoordinate.set(slotKey(r.day, r.period), r));

        const cells = [];
        days.forEach(day => periods.forEach(period => {
            const record = byCoordinate.get(slotKey(day, period));
            cells.push(record
                ? {
                    day, period,
                    subject: record.subject,
                    faculty: record.faculty,
                    facultyId: record.facultyId,
                    className: record.className,
                    room: record.room,
                    status: 'busy'
                }
                : {
                    day, period,
                    subject: null, faculty: null, facultyId: null,
                    className: target, room: null,
                    status: 'free'
                });
        }));
        return { view: 'class', name: target, days: days.slice(), periods: periods.slice(), cells };
    }

    /** One faculty's own week — the other way to look at the same records. */
    function facultyGrid(facultyName) {
        const member = faculty.find(f => f.name.toUpperCase() === String(facultyName || '').trim().toUpperCase());
        if (!member) return null;

        const byCoordinate = new Map();
        normalized.busyRecords
            .filter(r => r.faculty === member.name)
            .forEach(r => byCoordinate.set(slotKey(r.day, r.period), r));

        const cells = [];
        days.forEach(day => periods.forEach(period => {
            const record = byCoordinate.get(slotKey(day, period));
            cells.push(record
                ? {
                    day, period,
                    subject: record.subject, faculty: member.name, facultyId: member.id,
                    className: record.className, room: record.room, status: 'busy'
                }
                : {
                    day, period,
                    subject: null, faculty: member.name, facultyId: member.id,
                    className: null, room: null, status: 'free'
                });
        }));
        return { view: 'faculty', name: member.name, days: days.slice(), periods: periods.slice(), cells };
    }

    return {
        getMeta() {
            return { ...clone(meta), facultyCount: faculty.length };
        },
        getDays() { return days.slice(); },
        getPeriods() { return periods.slice(); },
        getFaculty() { return faculty.map(f => ({ ...f })); },
        getRecords() { return clone(normalized.records); },

        normalizeDay(input) { return normalizeDayName(input, days); },
        normalizePeriod(input) { return normalizePeriodNumber(input, periods); },

        /** Per-faculty load, for the Faculty Management section. */
        getFacultyStats() {
            return faculty.map(member => {
                const busy = normalized.busyRecords.filter(r => r.faculty === member.name);
                const total = days.length * periods.length;
                return {
                    id: member.id,
                    name: member.name,
                    department: member.department,
                    busyPeriods: busy.length,
                    freePeriods: total - busy.length,
                    totalPeriods: total,
                    subjects: [...new Set(busy.map(r => r.subject).filter(Boolean))].sort(),
                    classes: [...new Set(busy.map(r => r.className).filter(Boolean))].sort()
                };
            });
        },

        /** Everyone's status at one slot. Returns null for an unknown slot. */
        getSlot(day, period) {
            const slot = bySlot.get(slotKey(day, period));
            if (!slot) return null;
            return { day, period, busy: clone(slot.busy), free: clone(slot.free) };
        },

        /**
         * THE core query: which faculty are FREE at this exact day + period.
         * Read-only — nothing is assigned, nothing is stored.
         */
        getAvailability(day, period, options = {}) {
            const slot = bySlot.get(slotKey(day, period));
            if (!slot) return null;

            const exclude = options.exclude
                ? String(options.exclude).trim().toUpperCase() : null;
            const department = options.department
                ? String(options.department).trim().toUpperCase() : null;
            const search = options.search
                ? String(options.search).trim().toUpperCase() : null;

            const matches = record =>
                (!exclude || record.faculty.toUpperCase() !== exclude) &&
                (!department || (record.department || '').toUpperCase() === department) &&
                (!search || record.faculty.toUpperCase().includes(search));

            const free = slot.free.filter(matches);
            const busy = slot.busy.filter(matches);

            return {
                day,
                period,
                availableFaculty: free.map(r => r.faculty),
                available: free.map(r => ({
                    faculty: r.faculty, facultyId: r.facultyId, department: r.department, status: 'free'
                })),
                busy: busy.map(r => ({
                    faculty: r.faculty, facultyId: r.facultyId, department: r.department,
                    subject: r.subject, className: r.className, room: r.room, status: 'busy'
                })),
                totalAvailable: free.length,
                totalBusy: busy.length,
                totalFaculty: free.length + busy.length
            };
        },

        getClassGrid: classGrid,
        getFacultyGrid: facultyGrid,

        /** Summary for the dashboard: totals plus the picture across the week. */
        getSummary(day, period) {
            const slotSummary = (day && period) ? this.getAvailability(day, period) : null;
            const perSlot = [];
            days.forEach(d => periods.forEach(p => {
                const slot = bySlot.get(slotKey(d, p));
                perSlot.push({ day: d, period: p, available: slot.free.length, busy: slot.busy.length });
            }));
            return {
                totalFaculty: faculty.length,
                days: days.slice(),
                periods: periods.slice(),
                classes: meta.classes.slice(),
                primaryClass: meta.primaryClass,
                selected: slotSummary
                    ? {
                        day: slotSummary.day, period: slotSummary.period,
                        available: slotSummary.totalAvailable, busy: slotSummary.totalBusy
                    }
                    : null,
                slots: perSlot
            };
        }
    };
}

module.exports = { createEngine };
