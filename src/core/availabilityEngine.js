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

    const facultyMap = new Map((faculty || []).map(f => [(f.name || '').toUpperCase(), f]));

    normalized.records.forEach(record => {
        const slot = bySlot.get(slotKey(record.day, record.period));
        if (!slot) return;
        if (record.status === 'busy') {
            slot.busy.push(record);
        } else if (record.status === 'free') {
            const fac = facultyMap.get((record.faculty || '').toUpperCase());
            const isInactive = (fac && fac.status === 'inactive') || record.facultyStatus === 'inactive';
            if (!isInactive) {
                slot.free.push(record);
            }
        }
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
                    phone: record.phone || null,
                    className: record.className,
                    room: record.room,
                    type: record.type,
                    status: record.status || (record.faculty ? 'busy' : 'activity')
                }
                : {
                    day, period,
                    subject: null, faculty: null, facultyId: null, phone: null,
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
                    phone: member.phone || null,
                    className: record.className, room: record.room, status: 'busy'
                }
                : {
                    day, period,
                    subject: null, faculty: member.name, facultyId: member.id,
                    phone: member.phone || null,
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

        /**
         * Per-faculty profile and load, for the Faculty Directory.
         *
         * @param options.day     with `period`, adds `availability` — whether
         *                        this faculty is free or busy at that slot,
         *                        and what they are teaching if busy.
         */
        getFacultyStats(options = {}) {
            const slotDay = options.day || null;
            const slotPeriod = options.period == null ? null : options.period;
            const total = days.length * periods.length;

            return faculty.map(member => {
                const busy = normalized.busyRecords.filter(r => r.faculty === member.name);
                const stats = {
                    id: member.id,
                    name: member.name,
                    department: member.department,
                    designation: member.designation || null,
                    email: member.email || null,
                    phone: member.phone || null,
                    maxWeeklyPeriods: member.maxWeeklyPeriods == null ? null : member.maxWeeklyPeriods,
                    status: member.status || 'active',
                    busyPeriods: busy.length,
                    freePeriods: total - busy.length,
                    totalPeriods: total,
                    subjects: [...new Set((Array.isArray(member.subjects) ? member.subjects : []).concat(busy.map(r => r.subject).filter(Boolean)))].sort(),
                    classes: [...new Set(busy.map(r => r.className).filter(Boolean))].sort()
                };

                if (slotDay && slotPeriod != null) {
                    const at = busy.find(r => r.day === slotDay && r.period === slotPeriod);
                    stats.availability = at
                        ? {
                            day: slotDay, period: slotPeriod, status: 'busy',
                            subject: at.subject, className: at.className, room: at.room
                        }
                        : { day: slotDay, period: slotPeriod, status: 'free' };
                }
                return stats;
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
            const excludedFaculty = new Set(
                (Array.isArray(options.excludedFaculty) ? options.excludedFaculty : [])
                    .map(x => String(typeof x === 'object' ? (x.name || x.id || x.code) : x).trim().toUpperCase())
            );
            if (exclude) excludedFaculty.add(exclude);

            const department = options.department
                ? String(options.department).trim().toUpperCase() : null;
            const search = options.search
                ? String(options.search).trim().toUpperCase() : null;
            const priorityBranch = (options.priorityBranch || options.sameBranch)
                ? String(options.priorityBranch || options.sameBranch).trim().toUpperCase() : null;
            const validBranches = options.validBranches || null;

            const matches = record => {
                const fac = facultyMap.get((record.faculty || '').toUpperCase());
                if (fac && fac.status === 'inactive') return false;
                if (validBranches) {
                    const dept = (record.department || '').trim().toUpperCase();
                    const isValid = Array.isArray(validBranches)
                        ? validBranches.includes(dept)
                        : (validBranches.has ? validBranches.has(dept) : true);
                    if (!isValid) return false;
                }
                const facUpper = (record.faculty || '').trim().toUpperCase();
                const facIdUpper = record.facultyId ? String(record.facultyId).trim().toUpperCase() : null;
                if (excludedFaculty.size > 0 && (excludedFaculty.has(facUpper) || (facIdUpper && excludedFaculty.has(facIdUpper)))) {
                    return false;
                }
                return (!department || (record.department || '').toUpperCase() === department) &&
                    (!search || record.faculty.toUpperCase().includes(search));
            };

            const invigilationMap = new Map();
            if (Array.isArray(options.invigilationFaculty)) {
                options.invigilationFaculty.forEach(x => {
                    const name = typeof x === 'object' ? (x.name || x.faculty) : x;
                    const id = typeof x === 'object' ? (x.facultyId || x.id) : null;
                    if (name) invigilationMap.set(String(name).trim().toUpperCase(), x);
                    if (id) invigilationMap.set(String(id).trim().toUpperCase(), x);
                });
            }

            const free = [];
            const invigilationBusy = [];

            slot.free.filter(matches).forEach(r => {
                const facUpper = (r.faculty || '').trim().toUpperCase();
                const facIdUpper = r.facultyId ? String(r.facultyId).trim().toUpperCase() : null;
                const invigInfo = (invigilationMap.size > 0)
                    ? (invigilationMap.get(facUpper) || (facIdUpper ? invigilationMap.get(facIdUpper) : null))
                    : null;

                if (invigInfo) {
                    invigilationBusy.push({
                        faculty: r.faculty,
                        facultyId: r.facultyId,
                        department: r.department,
                        phone: r.phone || null,
                        subject: 'Exam Invigilation',
                        className: typeof invigInfo === 'object' && invigInfo.notes ? invigInfo.notes : 'Exam Duty',
                        room: null,
                        status: 'busy',
                        isInvigilation: true,
                        isSameBranch: Boolean(priorityBranch && (r.department || '').trim().toUpperCase() === priorityBranch)
                    });
                } else {
                    free.push(r);
                }
            });

            const busy = [
                ...slot.busy.filter(matches).map(r => {
                    const facUpper = (r.faculty || '').trim().toUpperCase();
                    const facIdUpper = r.facultyId ? String(r.facultyId).trim().toUpperCase() : null;
                    const invigInfo = (invigilationMap.size > 0)
                        ? (invigilationMap.get(facUpper) || (facIdUpper ? invigilationMap.get(facIdUpper) : null))
                        : null;
                    if (invigInfo) {
                        return { ...r, isInvigilation: true };
                    }
                    return r;
                }),
                ...invigilationBusy
            ];

            let orderedFree = free;
            let sameBranchFree = [];
            let otherBranchFree = [];

            if (priorityBranch) {
                free.forEach(r => {
                    const dept = (r.department || '').trim().toUpperCase();
                    if (dept === priorityBranch) {
                        sameBranchFree.push(r);
                    } else {
                        otherBranchFree.push(r);
                    }
                });

                sameBranchFree.sort((a, b) => a.faculty.localeCompare(b.faculty));
                otherBranchFree.sort((a, b) => {
                    const d1 = (a.department || '').toUpperCase();
                    const d2 = (b.department || '').toUpperCase();
                    if (d1 !== d2) return d1.localeCompare(d2);
                    return a.faculty.localeCompare(b.faculty);
                });

                orderedFree = [...sameBranchFree, ...otherBranchFree];
            }

            return {
                day,
                period,
                priorityBranch: priorityBranch || null,
                availableFaculty: orderedFree.map(r => r.faculty),
                available: orderedFree.map(r => ({
                    faculty: r.faculty,
                    facultyId: r.facultyId,
                    facultyName: r.faculty,
                    name: r.faculty,
                    department: r.department,
                    branch: r.department,
                    phone: r.phone || null,
                    status: 'free',
                    reason: null,
                    isSameBranch: Boolean(priorityBranch && (r.department || '').trim().toUpperCase() === priorityBranch)
                })),
                sameBranch: priorityBranch ? {
                    branch: priorityBranch,
                    available: sameBranchFree.map(r => ({
                        faculty: r.faculty,
                        facultyId: r.facultyId,
                        facultyName: r.faculty,
                        name: r.faculty,
                        department: r.department,
                        branch: r.department,
                        phone: r.phone || null,
                        status: 'free',
                        reason: null,
                        isSameBranch: true
                    })),
                    totalAvailable: sameBranchFree.length
                } : null,
                otherBranches: priorityBranch ? {
                    available: otherBranchFree.map(r => ({
                        faculty: r.faculty,
                        facultyId: r.facultyId,
                        facultyName: r.faculty,
                        name: r.faculty,
                        department: r.department,
                        branch: r.department,
                        phone: r.phone || null,
                        status: 'free',
                        reason: null,
                        isSameBranch: false
                    })),
                    totalAvailable: otherBranchFree.length
                } : null,
                busy: busy.map(r => ({
                    faculty: r.faculty,
                    facultyId: r.facultyId,
                    facultyName: r.faculty,
                    name: r.faculty,
                    department: r.department,
                    branch: r.department,
                    phone: r.phone || null,
                    subject: r.subject,
                    className: r.className,
                    room: r.room,
                    status: 'busy',
                    reason: r.isInvigilation ? 'INVIGILATION' : 'TEACHING',
                    isInvigilation: Boolean(r.isInvigilation),
                    isSameBranch: Boolean(priorityBranch && (r.department || '').trim().toUpperCase() === priorityBranch)
                })),
                totalAvailable: orderedFree.length,
                totalBusy: busy.length,
                totalFaculty: orderedFree.length + busy.length
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
