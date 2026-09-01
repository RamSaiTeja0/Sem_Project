/**
 * Normalizer — turns any timetable source into the single internal record shape.
 *
 *   { faculty, facultyId, day, period, subject, className, room, type, status }
 *
 * `type` is 'theory' or 'lab'. A source may state it per entry; when it does
 * not, it is inferred from the subject name so older sources keep working.
 *
 * status is 'busy' when the faculty is teaching that slot, 'free' otherwise.
 * Free records are materialized for every faculty x day x period combination
 * that carries no class, so the availability engine only ever reads one shape.
 *
 * This module performs no I/O and throws nothing: anything it cannot resolve is
 * returned as an issue for the validator to classify.
 */

const DAY_ALIASES = {
    MON: 'Monday', MONDAY: 'Monday',
    TUE: 'Tuesday', TUES: 'Tuesday', TUESDAY: 'Tuesday',
    WED: 'Wednesday', WEDS: 'Wednesday', WEDNESDAY: 'Wednesday',
    THU: 'Thursday', THUR: 'Thursday', THURS: 'Thursday', THURSDAY: 'Thursday',
    FRI: 'Friday', FRIDAY: 'Friday',
    SAT: 'Saturday', SATURDAY: 'Saturday',
    SUN: 'Sunday', SUNDAY: 'Sunday'
};

const DEFAULT_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DEFAULT_PERIODS = [1, 2, 3, 4, 5, 6, 7];

/** Cell text meaning "nothing scheduled here". */
const FREE_TOKENS = new Set(['', '-', '--', 'FREE', 'NIL', 'NONE', 'N/A', 'NA', 'X']);

function text(value) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isFreeToken(value) {
    const raw = text(value);
    return raw === null || FREE_TOKENS.has(raw.toUpperCase());
}

/** Session kinds a source may state directly. */
const TYPE_ALIASES = {
    LAB: 'lab', LABORATORY: 'lab', PRACTICAL: 'lab', PRAC: 'lab',
    THEORY: 'theory', LECTURE: 'theory', LEC: 'theory', CLASS: 'theory'
};

/**
 * Resolve a session type. An explicit value wins; otherwise a subject reading
 * like "DBMS Lab" is a lab, and everything else is theory. Inferring keeps
 * sources written before this field existed working unchanged.
 */
function classifySessionType(declared, subject) {
    const raw = text(declared);
    if (raw) {
        const known = TYPE_ALIASES[raw.toUpperCase()];
        if (known) return known;
    }
    return /\b(lab|laboratory|practical)\b/i.test(String(subject || '')) ? 'lab' : 'theory';
}

function normalizeDayName(input, allowedDays = DEFAULT_DAYS) {
    const raw = text(input);
    if (!raw) return null;
    const upper = raw.toUpperCase();
    const lookup = new Map(allowedDays.map(d => [d.toUpperCase(), d]));
    if (lookup.has(upper)) return lookup.get(upper);
    const alias = DAY_ALIASES[upper];
    return alias && lookup.has(alias.toUpperCase()) ? lookup.get(alias.toUpperCase()) : null;
}

function normalizePeriodNumber(input, allowedPeriods = DEFAULT_PERIODS) {
    if (input == null) return null;
    const match = String(input).trim().match(/(\d+)/);
    if (!match) return null;
    const period = parseInt(match[1], 10);
    return allowedPeriods.includes(period) ? period : null;
}

/** Parse an "Monday P2" / "MON-P2" / "Monday 2" column header. */
function parseSlotHeader(header, days = DEFAULT_DAYS, periods = DEFAULT_PERIODS) {
    const raw = text(header);
    if (!raw) return null;
    const match = raw.match(/^\s*([A-Za-z]+)\s*[-_ ]?\s*P?\s*(\d+)\s*$/);
    if (!match) return null;
    const day = normalizeDayName(match[1], days);
    const period = normalizePeriodNumber(match[2], periods);
    return day && period ? { day, period } : null;
}

/**
 * Normalize a timetable source.
 *
 * Accepts either shape:
 *   A) entries: [{ faculty, day, period, subject, class, room }]  (long form)
 *   B) classes: [{ class, room, rows: { Monday: [{period, subject, faculty, spanTo}] } }]
 *
 * @returns {{ meta, faculty, records, busyRecords, issues }}
 */
function normalize(source) {
    const issues = [];
    const add = (severity, code, message, context) =>
        issues.push({ severity, code, message, context: context || null });

    if (!source || typeof source !== 'object') {
        add('error', 'MALFORMED_SOURCE', 'Timetable source must be an object');
        return { meta: null, faculty: [], records: [], busyRecords: [], issues };
    }

    const rawMeta = source.meta || {};
    const days = Array.isArray(rawMeta.days) && rawMeta.days.length
        ? rawMeta.days.map(d => String(d).trim()) : DEFAULT_DAYS.slice();
    const periods = Array.isArray(rawMeta.periods) && rawMeta.periods.length
        ? rawMeta.periods.map(p => parseInt(p, 10)).filter(p => !isNaN(p)) : DEFAULT_PERIODS.slice();

    const dayLookup = new Map(days.map(d => [d.toUpperCase(), d]));
    const periodSet = new Set(periods);

    // ---- faculty roster -------------------------------------------------
    const faculty = [];
    const byName = new Map();

    (Array.isArray(source.faculty) ? source.faculty : []).forEach(entry => {
        const name = text(entry && (entry.name || entry.faculty));
        if (!name) {
            add('error', 'FACULTY_NO_NAME', 'A faculty entry has no name', entry);
            return;
        }
        if (byName.has(name.toUpperCase())) {
            add('error', 'FACULTY_DUPLICATE', `Duplicate faculty name: "${name}"`, { name });
            return;
        }
        faculty.push(buildMember(text(entry.id) || name, name, entry));
        byName.set(name.toUpperCase(), faculty[faculty.length - 1]);
    });

    // A faculty referenced by a timetable entry but absent from the roster is
    // registered here rather than dropped — dropping them would silently make
    // them look free everywhere.
    /**
     * A faculty member as the rest of the app sees them. The profile fields
     * are optional: a source that carries none (an uploaded spreadsheet, say)
     * still produces a valid member, with nulls where it said nothing.
     */
    function buildMember(id, name, entry) {
        const source = entry || {};
        return {
            id,
            name,
            department: text(source.department) || 'General',
            designation: text(source.designation) || null,
            email: text(source.email) || null,
            phone: text(source.phone) || null,
            maxWeeklyPeriods: Number.isFinite(parseInt(source.maxWeeklyPeriods, 10))
                ? parseInt(source.maxWeeklyPeriods, 10) : null,
            status: text(source.status) || 'active'
        };
    }

    function resolveFaculty(name, context) {
        const clean = text(name);
        if (!clean) return null;
        const existing = byName.get(clean.toUpperCase());
        if (existing) return existing;
        const member = buildMember(clean, clean, null);
        faculty.push(member);
        byName.set(clean.toUpperCase(), member);
        add('warning', 'FACULTY_AUTO_ADDED',
            `Faculty "${clean}" was not in the roster and has been added from the timetable`, context);
        return member;
    }

    // ---- collect busy records -------------------------------------------
    const busyRecords = [];
    const seen = new Map();

    function pushBusy(member, day, period, subject, className, room, type, context) {
        const key = `${member.name}|${day}|${period}`;
        if (seen.has(key)) {
            const prev = seen.get(key);
            add('error', 'DUPLICATE_ENTRY',
                `${member.name} has two entries for ${day} P${period} (${prev.subject} / ${subject})`,
                { faculty: member.name, day, period });
            return;
        }
        const record = {
            faculty: member.name,
            facultyId: member.id,
            department: member.department,
            day,
            period,
            subject,
            className: className || null,
            room: room || null,
            type: classifySessionType(type, subject),
            status: 'busy'
        };
        seen.set(key, record);
        busyRecords.push(record);
        void context;
    }

    // --- shape A: long-form entries ---
    (Array.isArray(source.entries) ? source.entries : []).forEach((entry, index) => {
        const line = { index };
        const day = dayLookup.get(String(entry.day || '').trim().toUpperCase())
            || normalizeDayName(entry.day, days);
        if (!day) {
            add('error', 'INVALID_DAY', `Entry ${index + 1}: unknown day "${entry.day}"`, line);
            return;
        }
        const period = normalizePeriodNumber(entry.period, periods);
        if (period == null) {
            add('error', 'INVALID_PERIOD',
                `Entry ${index + 1}: period "${entry.period}" is outside [${periods.join(', ')}]`, line);
            return;
        }
        if (isFreeToken(entry.subject)) return; // an explicit free slot adds nothing

        const member = resolveFaculty(entry.faculty, line);
        if (!member) {
            add('error', 'MISSING_FACULTY', `Entry ${index + 1}: no faculty name`, line);
            return;
        }
        pushBusy(member, day, period, text(entry.subject), text(entry.class || entry.className),
            text(entry.room), entry.type, line);
    });

    // --- shape B: per-class grids ---
    (Array.isArray(source.classes) ? source.classes : []).forEach(cls => {
        const className = text(cls && (cls.class || cls.name));
        if (!className) {
            add('error', 'CLASS_NO_NAME', 'A class entry has no name', cls);
            return;
        }
        const defaultRoom = text(cls.room);
        const rows = cls.rows || {};

        Object.keys(rows).forEach(rawDay => {
            const day = dayLookup.get(String(rawDay).trim().toUpperCase());
            if (!day) {
                add('error', 'INVALID_DAY', `Class "${className}" has unknown day "${rawDay}"`, { className });
                return;
            }

            (rows[rawDay] || []).forEach(cell => {
                const start = parseInt(cell.period, 10);
                const end = cell.spanTo != null ? parseInt(cell.spanTo, 10) : start;

                if (!periodSet.has(start) || !periodSet.has(end)) {
                    add('error', 'INVALID_PERIOD',
                        `Class "${className}" ${day}: periods ${start}-${end} are outside [${periods.join(', ')}]`,
                        { className, day });
                    return;
                }
                if (end < start) {
                    add('error', 'INVALID_SPAN',
                        `Class "${className}" ${day} P${start}: spanTo (${end}) precedes the start period`,
                        { className, day });
                    return;
                }
                if (isFreeToken(cell.subject)) return;

                const member = resolveFaculty(cell.faculty, { className, day, period: start });
                if (!member) {
                    add('error', 'MISSING_FACULTY',
                        `Class "${className}" ${day} P${start} has no faculty`, { className, day });
                    return;
                }

                // A lab spanning several periods becomes one record per period,
                // so every coordinate is independently addressable.
                for (let p = start; p <= end; p++) {
                    pushBusy(member, day, p, text(cell.subject), className, text(cell.room) || defaultRoom,
                        cell.type, { className, day, period: p });
                }
            });
        });
    });

    // ---- materialize the full record set --------------------------------
    const records = [];
    days.forEach(day => {
        periods.forEach(period => {
            faculty.forEach(member => {
                const busy = seen.get(`${member.name}|${day}|${period}`);
                records.push(busy || {
                    faculty: member.name,
                    facultyId: member.id,
                    department: member.department,
                    day,
                    period,
                    subject: null,
                    className: null,
                    room: null,
                    type: null,
                    status: 'free'
                });
            });
        });
    });

    if (faculty.length === 0) add('error', 'NO_FACULTY', 'Timetable contains no faculty');
    if (busyRecords.length === 0) add('error', 'EMPTY_TIMETABLE', 'Timetable contains no scheduled periods');

    const classNames = [...new Set(busyRecords.map(r => r.className).filter(Boolean))];
    const primaryClass = text(rawMeta.primaryClass) || classNames[0] || null;

    return {
        meta: {
            institution: text(rawMeta.institution),
            title: text(rawMeta.title) || 'Timetable',
            days,
            periods,
            periodTimings: rawMeta.periodTimings || {},
            classes: classNames,
            primaryClass
        },
        faculty,
        records,
        busyRecords,
        issues
    };
}

module.exports = {
    normalize,
    classifySessionType,
    normalizeDayName,
    normalizePeriodNumber,
    parseSlotHeader,
    isFreeToken,
    DEFAULT_DAYS,
    DEFAULT_PERIODS
};
