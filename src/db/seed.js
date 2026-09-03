/**
 * Database initialization and seeding.
 *
 *   migrate()  applies schema.sql. Every statement is IF NOT EXISTS, so it is
 *              safe to run on every startup.
 *   seed()     inserts the demo dataset ONLY when the timetable is empty.
 *
 * Duplicate demo records are impossible by construction: reference rows use
 * ON CONFLICT (code) DO NOTHING, timetable rows are inserted only into an empty
 * table, and the UNIQUE constraints in the schema reject a repeat regardless.
 *
 * Nothing here ever drops or truncates a table. Existing data is left alone.
 */
const fs = require('fs');
const path = require('path');

const db = require('./pool');
const repository = require('./repository');
const demoTimetable = require('../data/demoTimetable');
const { DEPARTMENTS } = require('../data/departments');
const { normalize } = require('../core/normalizer');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function migrate() {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await db.query(sql);
    await labelBundledPlaceholders();
}

/**
 * Label classes that are still the bundled placeholder week.
 *
 * `classes.data_source` defaults to 'real', because anything a person creates
 * through the application is real. A database seeded before that column existed
 * therefore reports its demo classes as real, which is exactly the confusion the
 * column exists to prevent.
 *
 * The relabel is deliberately conservative: a class is only marked as a
 * placeholder when its stored week STILL MATCHES the bundled one period for
 * period. Replace MEC-A with a real timetable and it stays 'real', so this can
 * never demote genuine data. Idempotent — re-running changes nothing.
 */
async function labelBundledPlaceholders() {
    const bundled = (demoTimetable.classes || [])
        .filter(cls => cls.dataSource === 'placeholder');
    if (!bundled.length) return { relabelled: [] };

    const expected = new Map();
    normalize(demoTimetable).busyRecords.forEach(record => {
        if (!expected.has(record.className)) expected.set(record.className, new Set());
        expected.get(record.className).add(`${record.day}|${record.period}|${record.subject}`);
    });

    const relabelled = [];
    for (const cls of bundled) {
        const code = cls.class;
        const { rows } = await db.query(`
            SELECT t.day_of_week AS day, t.period, s.name AS subject, c.data_source
              FROM classes c
              LEFT JOIN timetable t ON t.class_id = c.id
              LEFT JOIN subjects s ON s.id = t.subject_id
             WHERE c.code = $1`, [code]);
        if (!rows.length || rows[0].data_source === 'placeholder') continue;

        const stored = new Set(rows
            .filter(r => r.day && r.subject)
            .map(r => `${r.day}|${r.period}|${r.subject}`));
        const want = expected.get(code) || new Set();
        const unchanged = stored.size === want.size &&
            [...want].every(key => stored.has(key));
        if (!unchanged) continue;      // someone's real timetable now — leave it

        await db.query('UPDATE classes SET data_source = $2 WHERE code = $1',
            [code, 'placeholder']);
        relabelled.push(code);
    }
    return { relabelled };
}

/**
 * Insert the bundled demo dataset. Returns what was written, or
 * `{ seeded: false }` when the database already holds a timetable.
 */
async function seed(dataset = demoTimetable, options = {}) {
    if (!options.force && !(await repository.isEmpty())) {
        return { seeded: false, reason: 'timetable already contains rows', counts: await repository.counts() };
    }

    // Normalizing first means the rows written to the database are exactly the
    // rows the engine would have served from memory — one source of truth for
    // what "the demo data" is, including the inferred theory/lab type.
    const normalized = normalize(dataset);

    await db.withTransaction(async client => {
        // ---- departments ----
        // The canonical branch list first, then anything else the dataset
        // mentions, so every branch is selectable even before a faculty
        // member has been assigned to it.
        const declaredDepartments = dataset.departments || [];
        const mentioned = [...new Set(normalized.faculty.map(f => f.department))]
            .filter(code => !DEPARTMENTS.some(d => d.code === code) &&
                            !declaredDepartments.some(d => d.code === code))
            .map(code => ({ code, name: code }));
        const departments = [...DEPARTMENTS, ...declaredDepartments, ...mentioned]
            .filter((dept, index, all) => all.findIndex(d => d.code === dept.code) === index);
        for (const dept of departments) {
            await client.query(
                `INSERT INTO departments (code, name) VALUES ($1, $2)
                 ON CONFLICT (code) DO NOTHING`, [dept.code, dept.name || dept.code]);
        }

        // ---- rooms ----
        const roomCodes = new Set((dataset.rooms || []).map(r => r.code));
        normalized.busyRecords.forEach(r => { if (r.room) roomCodes.add(r.room); });
        for (const code of roomCodes) {
            const known = (dataset.rooms || []).find(r => r.code === code);
            await client.query(
                `INSERT INTO rooms (code, name, room_type, capacity) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (code) DO NOTHING`,
                [code, known ? known.name : code,
                 known ? known.type : (/lab/i.test(code) ? 'lab' : 'classroom'),
                 known ? known.capacity : null]);
        }

        // ---- faculty ----
        for (const member of normalized.faculty) {
            await client.query(
                `INSERT INTO faculty (code, name, department_id, designation, email, phone,
                                      max_weekly_periods, status)
                 VALUES ($1, $2, (SELECT id FROM departments WHERE code = $3), $4, $5, $6, $7, $8)
                 ON CONFLICT (code) DO NOTHING`,
                [member.id, member.name, member.department, member.designation || null,
                 member.email || null, member.phone || null,
                 member.maxWeeklyPeriods == null ? null : member.maxWeeklyPeriods,
                 member.status || 'active']);
        }

        // ---- subjects ----
        const declared = new Map((dataset.subjects || []).map(s => [s.name, s]));
        const subjectNames = new Set([
            ...declared.keys(),
            ...normalized.busyRecords.map(r => r.subject).filter(Boolean)
        ]);
        let generated = 0;
        for (const name of subjectNames) {
            const known = declared.get(name);
            const record = normalized.busyRecords.find(r => r.subject === name);
            await client.query(
                `INSERT INTO subjects (code, name, department_id, subject_type)
                 VALUES ($1, $2, (SELECT id FROM departments WHERE code = $3), $4)
                 ON CONFLICT (code) DO NOTHING`,
                [known ? known.code : `SUB${String(++generated).padStart(3, '0')}`,
                 name,
                 known ? known.department : (record ? record.department : null),
                 known ? known.type : (record ? record.type : 'theory')]);
        }

        // ---- classes ----
        for (const cls of dataset.classes || []) {
            await client.query(
                `INSERT INTO classes (code, department_id, semester, academic_year, home_room_id, data_source)
                 VALUES ($1, (SELECT id FROM departments WHERE code = $2), $3, $4,
                         (SELECT id FROM rooms WHERE code = $5), $6)
                 ON CONFLICT (code) DO NOTHING`,
                [cls.class, cls.department || null, cls.semester || null,
                 cls.academicYear || (dataset.meta && dataset.meta.academicYear) || null,
                 cls.room || null, cls.dataSource === 'placeholder' ? 'placeholder' : 'real']);
        }

        // ---- periods ----
        const timings = (dataset.meta && dataset.meta.periodTimings) || {};
        for (const period of (dataset.meta && dataset.meta.periods) || []) {
            const timing = timings[String(period)] || {};
            await client.query(
                `INSERT INTO periods (period, start_time, end_time) VALUES ($1, $2, $3)
                 ON CONFLICT (period) DO NOTHING`,
                [period, timing.start || null, timing.end || null]);
        }

        // ---- timetable ----
        // One row per faculty x day x period that is actually taught. A lab
        // spanning P5-P7 is three rows, so every coordinate is addressable and
        // editable on its own.
        for (const record of normalized.busyRecords) {
            await client.query(`
                INSERT INTO timetable (class_id, day_of_week, period, subject_id, faculty_id, room_id, session_type)
                VALUES ((SELECT id FROM classes WHERE code = $1),
                        $2, $3,
                        (SELECT id FROM subjects WHERE name = $4),
                        (SELECT id FROM faculty WHERE name = $5),
                        (SELECT id FROM rooms WHERE code = $6),
                        $7)
                ON CONFLICT DO NOTHING`,
                [record.className, record.day, record.period, record.subject,
                 record.faculty, record.room, record.type || 'theory']);
        }

        // ---- users ----
        // The coordinator plus one account per faculty member, mirroring the
        // in-memory demo directory in src/data/users.js.
        await client.query(
            `INSERT INTO users (username, name, role) VALUES ('admin', 'Timetable Coordinator', 'coordinator')
             ON CONFLICT (username) DO NOTHING`);
        for (const member of normalized.faculty) {
            const username = member.name.toLowerCase()
                .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/, '')
                .replace(/[^a-z0-9]+/g, '.')
                .replace(/^\.|\.$/g, '');
            await client.query(
                `INSERT INTO users (username, name, role, department_id, faculty_id)
                 VALUES ($1, $2, 'faculty',
                         (SELECT id FROM departments WHERE code = $3),
                         (SELECT id FROM faculty WHERE name = $4))
                 ON CONFLICT (username) DO NOTHING`,
                [username, member.name, member.department, member.name]);
        }
    });

    return { seeded: true, counts: await repository.counts() };
}

/** migrate + seed, used at startup and by `npm run db:setup`. */
async function initialize(options = {}) {
    await migrate();
    return seed(demoTimetable, options);
}

module.exports = { migrate, seed, labelBundledPlaceholders, initialize, SCHEMA_PATH };
