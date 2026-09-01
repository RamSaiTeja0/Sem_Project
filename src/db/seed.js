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
const { normalize } = require('../core/normalizer');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function migrate() {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await db.query(sql);
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
        const departments = dataset.departments && dataset.departments.length
            ? dataset.departments
            : [...new Set(normalized.faculty.map(f => f.department))].map(code => ({ code, name: code }));
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
                `INSERT INTO faculty (code, name, department_id)
                 VALUES ($1, $2, (SELECT id FROM departments WHERE code = $3))
                 ON CONFLICT (code) DO NOTHING`,
                [member.id, member.name, member.department]);
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
                `INSERT INTO classes (code, department_id, semester, home_room_id)
                 VALUES ($1, (SELECT id FROM departments WHERE code = $2), $3,
                         (SELECT id FROM rooms WHERE code = $4))
                 ON CONFLICT (code) DO NOTHING`,
                [cls.class, cls.department || null, cls.semester || null, cls.room || null]);
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

module.exports = { migrate, seed, initialize, SCHEMA_PATH };
