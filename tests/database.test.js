/**
 * Database tests — schema, seeding, round-trip fidelity and entry CRUD.
 *
 * These run against a REAL PostgreSQL. Point TEST_DATABASE_URL (or
 * DATABASE_URL) at a scratch database and they will create the schema, seed it
 * and exercise every write path:
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@host/dbname node tests/database.test.js
 *
 * With no connection string the suite SKIPS rather than failing, so the normal
 * `npm test` run stays green on a machine with no database — the application
 * itself is designed to run without one.
 *
 * WARNING: the suite writes to and deletes from the database it is given. Use a
 * scratch database, never one holding real data.
 */
const assert = require('assert');
const http = require('http');
const { check, checkAsync, counts } = require('./helpers');

const CONNECTION = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

console.log('TecSubstitution — database tests');

if (!CONNECTION) {
    console.log('\n[skip] No TEST_DATABASE_URL or DATABASE_URL set.');
    console.log('       These tests need a scratch PostgreSQL database; skipping them.');
    console.log('       The application runs without a database, so this is not a failure.');
    console.log('\n✅ database: skipped (no connection string).');
    process.exit(0);
}

// The modules below read config at require time, so the URL must be set first.
process.env.DATABASE_URL = CONNECTION;

const db = require('../src/db/pool');
const seeder = require('../src/db/seed');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
const demo = require('../src/data/demoTimetable');
const { normalize } = require('../src/core/normalizer');
const { validate } = require('../src/core/validator');
const { app } = require('../server');

let server;
let base;

function call(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(`${base}${path}`, {
            method,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                : {}
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { /* html */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('\n[1] Schema and seeding');

    await checkAsync('migrate() creates every table and is safe to run twice', async () => {
        await seeder.migrate();
        await seeder.migrate();
        const { rows } = await db.query(`
            SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' ORDER BY table_name`);
        const tables = rows.map(r => r.table_name);
        ['attendance', 'classes', 'departments', 'faculty', 'periods',
         'rooms', 'subjects', 'substitutions', 'timetable', 'users']
            .forEach(name => assert.ok(tables.includes(name), `missing table: ${name}`));
    });

    await checkAsync('the schema declares primary and foreign keys', async () => {
        const { rows } = await db.query(`
            SELECT tc.table_name, tc.constraint_type
              FROM information_schema.table_constraints tc
             WHERE tc.table_schema = 'public'
               AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`);
        const pk = rows.filter(r => r.constraint_type === 'PRIMARY KEY').map(r => r.table_name);
        const fk = rows.filter(r => r.constraint_type === 'FOREIGN KEY').map(r => r.table_name);
        ['departments', 'faculty', 'classes', 'subjects', 'rooms', 'timetable',
         'users', 'substitutions', 'attendance'].forEach(t =>
            assert.ok(pk.includes(t), `${t} has no primary key`));
        ['faculty', 'classes', 'subjects', 'timetable', 'users', 'substitutions', 'attendance']
            .forEach(t => assert.ok(fk.includes(t), `${t} has no foreign key`));
    });

    let seededCounts;
    await checkAsync('seed() populates an empty database with the demo dataset', async () => {
        const result = await seeder.seed();
        // Either this run seeded it, or a previous run already did.
        seededCounts = result.counts || await repository.counts();
        assert.strictEqual(seededCounts.faculty, demo.faculty.length);
        assert.strictEqual(seededCounts.classes, demo.classes.length);
        assert.strictEqual(seededCounts.departments, demo.departments.length);
        assert.strictEqual(seededCounts.departments, 4, 'all four branches are seeded');
        assert.strictEqual(seededCounts.rooms, demo.rooms.length);
        assert.ok(seededCounts.timetable > 100, 'a full week of periods must be stored');
        assert.strictEqual(seededCounts.users, demo.faculty.length + 1, 'faculty + coordinator');
    });

    await checkAsync('seeding again inserts nothing — no duplicate demo records', async () => {
        const second = await seeder.seed();
        assert.strictEqual(second.seeded, false, 'a populated database must not be re-seeded');
        const after = await repository.counts();
        assert.deepStrictEqual(after, seededCounts);
    });

    await checkAsync('the faculty profile columns survive a re-run of the schema', async () => {
        // schema.sql is applied on every startup; the ALTER ... IF NOT EXISTS
        // statements must be no-ops the second time rather than errors.
        await seeder.migrate();
        const { rows } = await db.query(`
            SELECT column_name FROM information_schema.columns
             WHERE table_name = 'faculty'`);
        const columns = rows.map(r => r.column_name);
        ['designation', 'email', 'phone', 'max_weekly_periods', 'status']
            .forEach(c => assert.ok(columns.includes(c), `faculty.${c} is missing`));

        const stored = await db.query(
            "SELECT designation, email, status FROM faculty WHERE code = 'FAC001'");
        assert.ok(stored.rows[0].designation, 'the seeded designation survived');
        assert.match(stored.rows[0].email, /@/);
        assert.strictEqual(stored.rows[0].status, 'active');
    });

    await checkAsync('classes carry their branch, semester and academic year', async () => {
        const classes = await repository.listClasses();
        assert.strictEqual(classes.length, demo.classes.length);
        classes.forEach(c => {
            assert.ok(c.department, `${c.code} has no department`);
            assert.ok(c.semester, `${c.code} has no semester`);
            assert.ok(c.academicYear, `${c.code} has no academic year`);
        });
        const branches = [...new Set(classes.map(c => c.department))].sort();
        assert.deepStrictEqual(branches, ['CME', 'ECE', 'EE', 'MEC']);
    });

    console.log('\n[2] Round-trip through PostgreSQL');

    await checkAsync('the stored timetable normalizes to exactly the demo dataset', async () => {
        const source = await repository.loadSource(demo.meta);
        const fromDb = normalize(source);
        const fromMemory = normalize(demo);
        const key = r => [r.faculty, r.day, r.period, r.subject, r.className, r.room, r.type].join('|');
        assert.deepStrictEqual(
            fromDb.busyRecords.map(key).sort(),
            fromMemory.busyRecords.map(key).sort());
    });

    await checkAsync('the stored timetable passes validation with no conflicts', async () => {
        const report = validate(normalize(await repository.loadSource(demo.meta)));
        assert.ok(report.ok, 'stored data must validate: ' +
            report.errors.map(e => e.message).join('; '));
        assert.strictEqual(report.errors.length, 0);
        assert.ok(report.summary.labSlots > 0, 'lab sessions must survive the round trip');
        assert.ok(report.summary.theorySlots > 0, 'theory sessions must survive the round trip');
    });

    await checkAsync('the database refuses a double-booked faculty at the SQL level', async () => {
        const existing = (await repository.listEntries())[0];
        await assert.rejects(
            () => db.query(`
                INSERT INTO timetable (class_id, day_of_week, period, subject_id, faculty_id, session_type)
                SELECT class_id, day_of_week, period, subject_id, faculty_id, session_type
                  FROM timetable WHERE id = $1`, [existing.id]),
            /duplicate key|unique/i,
            'a repeated faculty slot must be rejected by the schema itself');
    });

    console.log('\n[3] Timetable entry API (add / edit / delete)');

    const dbState = await store.initFromDatabase();
    assert.ok(dbState.enabled, 'the store must be serving from the database: ' + JSON.stringify(dbState));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://localhost:${server.address().port}`;

    // The demo timetable fills every class completely, so free a slot first by
    // removing one entry through the API. That exercises the delete path and
    // gives the add/edit tests below a genuinely empty coordinate to write to.
    const primaryClass = demo.meta.primaryClass || 'CME-A';
    const seeded = await call('GET', '/api/timetable/entries?class=' + primaryClass);
    assert.ok(seeded.body.entries.length, primaryClass + ' must have seeded entries');
    const vacated = seeded.body.entries[0];
    const removed = await call('DELETE', '/api/timetable/entries/' + vacated.id);
    assert.strictEqual(removed.status, 200, 'freeing a slot must succeed');

    const grid = await call('GET', '/api/timetable?class=' + primaryClass);
    const freeCell = grid.body.cells.find(c => c.status === 'free');
    assert.ok(freeCell, `the vacated ${primaryClass} slot must now read as free`);
    const freeClass = primaryClass;

    const slotBefore = await call('POST', '/api/availability',
        { day: freeCell.day, period: freeCell.period });
    const substitute = slotBefore.body.availableFaculty[0];

    // Two classes other than CSE-A, taken from the dataset rather than named
    // literally, so this suite survives a change to the demo classes.
    const reference = (await call('GET', '/api/timetable/entries/reference')).body;
    const otherClasses = reference.classes.map(c => c.code).filter(code => code !== freeClass);
    assert.ok(otherClasses.length >= 2, 'the demo data needs at least three classes');

    // Two theory subjects, again taken from the data rather than named here.
    const theory = reference.subjects.filter(s => s.type === 'theory').map(s => s.name);
    const [SUBJECT_A, SUBJECT_B] = [theory[0], theory[1]];
    assert.ok(SUBJECT_A && SUBJECT_B, 'the demo data needs at least two theory subjects');

    let createdId = null;

    await checkAsync('GET /entries/reference offers the form options', async () => {
        const res = await call('GET', '/api/timetable/entries/reference');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.editable, true);
        assert.strictEqual(res.body.classes.length, demo.classes.length);
        assert.strictEqual(res.body.faculty.length, demo.faculty.length);
        assert.ok(res.body.subjects.length > 0 && res.body.rooms.length > 0);
        assert.deepStrictEqual(res.body.types, ['theory', 'lab']);
    });

    await checkAsync('POST /entries adds an entry and stores it', async () => {
        const before = (await call('GET', '/api/timetable/entries')).body.count;
        const res = await call('POST', '/api/timetable/entries', {
            class: freeClass, day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: substitute, room: 'C-401', type: 'theory'
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.saved, true);
        assert.ok(res.body.entry && res.body.entry.id, 'the created entry is returned');
        createdId = res.body.entry.id;
        const after = (await call('GET', '/api/timetable/entries')).body.count;
        assert.strictEqual(after, before + 1);
    });

    await checkAsync('the new entry reaches the grid and the availability engine', async () => {
        const cell = (await call('GET', '/api/timetable?class=' + freeClass)).body.cells
            .find(c => c.day === freeCell.day && c.period === freeCell.period);
        assert.strictEqual(cell.status, 'busy');
        assert.strictEqual(cell.faculty, substitute);

        const after = await call('POST', '/api/availability',
            { day: freeCell.day, period: freeCell.period });
        assert.ok(!after.body.availableFaculty.includes(substitute), 'now teaching, so not free');
        assert.ok(after.body.busy.some(b => b.faculty === substitute));
        assert.strictEqual(after.body.totalAvailable, slotBefore.body.totalAvailable - 1);
    });

    await checkAsync('a duplicate entry for the same class slot is rejected', async () => {
        const res = await call('POST', '/api/timetable/entries', {
            class: freeClass, day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: substitute, room: 'C-401'
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'SLOT_CONFLICT');
    });

    await checkAsync('a faculty conflict across classes is rejected', async () => {
        const res = await call('POST', '/api/timetable/entries', {
            class: otherClasses[0], day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: substitute, room: 'P-301'
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'SLOT_CONFLICT');
        assert.ok(res.body.conflicts.some(c => c.code === 'FACULTY_BUSY' || c.code === 'CLASS_BUSY'));
    });

    await checkAsync('a room conflict across classes is rejected', async () => {
        const other = (await call('POST', '/api/availability',
            { day: freeCell.day, period: freeCell.period })).body.availableFaculty[0];
        const res = await call('POST', '/api/timetable/entries', {
            class: otherClasses[1], day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: other, room: 'C-401'
        });
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.conflicts.some(c => c.code === 'ROOM_BUSY'),
            'the room clash must be reported: ' + JSON.stringify(res.body.conflicts));
    });

    await checkAsync('missing and invalid fields are all reported at once', async () => {
        const res = await call('POST', '/api/timetable/entries',
            { class: '', day: 'Funday', period: 99, subject: '', faculty: '' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'INVALID_ENTRY');
        assert.ok(res.body.problems.length >= 4, 'every problem is listed, not just the first');
    });

    await checkAsync('an unknown subject, class or faculty is rejected', async () => {
        const res = await call('POST', '/api/timetable/entries', {
            class: freeClass, day: freeCell.day, period: freeCell.period === 1 ? 2 : 1,
            subject: 'Astral Projection', faculty: substitute
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'UNKNOWN_REFERENCE');
    });

    await checkAsync('PUT /entries/:id edits an entry', async () => {
        const res = await call('PUT', `/api/timetable/entries/${createdId}`, {
            class: freeClass, day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_B, faculty: substitute, room: 'C-401', type: 'theory'
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.entry.subject, SUBJECT_B);

        const cell = (await call('GET', '/api/timetable?class=' + freeClass)).body.cells
            .find(c => c.day === freeCell.day && c.period === freeCell.period);
        assert.strictEqual(cell.subject, SUBJECT_B);
    });

    await checkAsync('editing into an occupied slot is rejected', async () => {
        const busyCell = (await call('GET', '/api/timetable?class=' + freeClass)).body.cells
            .find(c => c.status === 'busy' && !(c.day === freeCell.day && c.period === freeCell.period));
        const res = await call('PUT', `/api/timetable/entries/${createdId}`, {
            class: freeClass, day: busyCell.day, period: busyCell.period,
            subject: SUBJECT_B, faculty: substitute, room: 'C-401'
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'SLOT_CONFLICT');
    });

    await checkAsync('editing a non-existent entry is a 404', async () => {
        const res = await call('PUT', '/api/timetable/entries/99999999', {
            class: freeClass, day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_B, faculty: substitute
        });
        assert.strictEqual(res.status, 404);
    });

    await checkAsync('DELETE /entries/:id removes the entry and frees the slot', async () => {
        const res = await call('DELETE', `/api/timetable/entries/${createdId}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.deleted, true);

        const cell = (await call('GET', '/api/timetable?class=' + freeClass)).body.cells
            .find(c => c.day === freeCell.day && c.period === freeCell.period);
        assert.strictEqual(cell.status, 'free', 'the slot is free again');

        const restored = await call('POST', '/api/availability',
            { day: freeCell.day, period: freeCell.period });
        assert.strictEqual(restored.body.totalAvailable, slotBefore.body.totalAvailable);
    });

    await checkAsync('deleting a non-existent entry is a 404', async () => {
        const res = await call('DELETE', '/api/timetable/entries/99999999');
        assert.strictEqual(res.status, 404);
    });

    await checkAsync('the database row count matches what the API reports', async () => {
        const api = (await call('GET', '/api/timetable/entries')).body.count;
        const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM timetable');
        assert.strictEqual(rows[0].n, api);
    });

    console.log('\n[4] Adding a faculty member');

    const ADDED = 'FAC900';
    await checkAsync('POST /api/faculty rejects an incomplete or malformed record', async () => {
        const res = await call('POST', '/api/faculty',
            { id: 'bad id!', name: 'X', department: 'NOPE', email: 'not-an-email' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'INVALID_FACULTY');
        assert.ok(res.body.problems.length >= 4, 'every problem is reported at once');
        assert.ok(res.body.problems.some(p => /Faculty ID/i.test(p)));
        assert.ok(res.body.problems.some(p => /department/i.test(p)));
        assert.ok(res.body.problems.some(p => /email/i.test(p)));
    });

    await checkAsync('a duplicate faculty ID is rejected', async () => {
        const res = await call('POST', '/api/faculty',
            { id: 'FAC001', name: 'Dr. Somebody Else', department: 'CME' });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'DUPLICATE_FACULTY');
        assert.match(res.body.error, /already in use/);
    });

    await checkAsync('a duplicate email is rejected', async () => {
        const existing = (await call('GET', '/api/faculty?search=FAC002')).body.faculty[0];
        const res = await call('POST', '/api/faculty',
            { id: 'FAC901', name: 'Dr. Another Person', department: 'CME', email: existing.email });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /Email .* already in use/);
    });

    await checkAsync('POST /api/faculty stores a valid record', async () => {
        const before = (await call('GET', '/api/faculty')).body.count;
        const res = await call('POST', '/api/faculty', {
            id: ADDED, name: 'Dr. Test Appointee', department: 'CME',
            designation: 'Assistant Professor', email: 'test.appointee@college.edu',
            phone: '+91-90000-00000', maxWeeklyPeriods: 18, status: 'active'
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.faculty.id, ADDED);
        assert.strictEqual(res.body.faculty.department, 'CME');
        assert.strictEqual(res.body.faculty.designation, 'Assistant Professor');

        const after = (await call('GET', '/api/faculty')).body.count;
        assert.strictEqual(after, before + 1, 'the roster count grew by one');

        const row = await db.query('SELECT name, status FROM faculty WHERE code = $1', [ADDED]);
        assert.strictEqual(row.rows[0].name, 'Dr. Test Appointee', 'the row is really in PostgreSQL');
    });

    await checkAsync('the new faculty is immediately usable everywhere', async () => {
        // Free at every slot, since they teach nothing yet.
        const availability = await call('POST', '/api/availability', { day: 'Monday', period: 1 });
        assert.ok(availability.body.availableFaculty.includes('Dr. Test Appointee'),
            'the new member is offered as a substitute');

        const branch = await call('GET', '/api/faculty?department=CME');
        assert.ok(branch.body.faculty.some(f => f.id === ADDED), 'they appear under their branch');

        const reference = await call('GET', '/api/timetable/entries/reference');
        assert.ok(reference.body.faculty.some(f => f.name === 'Dr. Test Appointee'),
            'they are selectable when adding a timetable entry');

        const departments = await call('GET', '/api/faculty/departments');
        const cme = departments.body.details.find(d => d.code === 'CME');
        assert.strictEqual(cme.facultyCount, 8, 'the branch count includes them');
    });

    await checkAsync('a sign-in account is created for the new faculty member', async () => {
        const { rows } = await db.query(
            'SELECT username FROM users WHERE faculty_id = (SELECT id FROM faculty WHERE code = $1)',
            [ADDED]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].username, 'test.appointee');
    });

    // Leave the database as it was found.
    await db.query('DELETE FROM users WHERE faculty_id = (SELECT id FROM faculty WHERE code = $1)', [ADDED]);
    await db.query('DELETE FROM faculty WHERE code = $1', [ADDED]);
    await store.reloadFromDatabase();

    console.log('\n[5] Storage reporting');

    await checkAsync('GET /api/storage reports the database backing', async () => {
        const res = await call('GET', '/api/storage');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.backend, 'postgres');
        assert.strictEqual(res.body.editable, true);
        assert.strictEqual(res.body.databaseConfigured, true);
    });

    check('the reported target never contains the password', () => {
        const target = db.describeTarget();
        assert.ok(target && !/:.*@/.test(target), 'credentials must never be exposed: ' + target);
        assert.ok(!target.includes('password'));
    });
}

run()
    .then(async () => {
        if (server) server.close();
        await db.close();
        const { passed } = counts();
        console.log(`\n✅ database: ${passed} checks passed.`);
        process.exit(0);
    })
    .catch(async err => {
        console.error('\n✗ FAILED:', err.message);
        if (server) server.close();
        try { await db.close(); } catch (e) { /* already closing */ }
        process.exit(1);
    });
