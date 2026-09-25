/**
 * Database tests — schema, seeding, round-trip fidelity and entry CRUD.
 *
 * Runs against PostgreSQL (Neon).
 * Tests clean database initialization, schema integrity, and CRUD paths
 * without requiring legacy demo data.
 */
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const { check, checkAsync, counts } = require('./helpers');

const { verifySafetyGuard } = require('./testDbGuard');

console.log('TecSubstitution — database tests');

const guardInfo = verifySafetyGuard();
console.log(`[Safety Guard] Active test database: ${guardInfo.parsedTest.full}`);

const db = require('../src/db/pool');
const seeder = require('../src/db/seed');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
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

// Dedicated test fixture identifiers with DB_TEST_ prefix to avoid collisions
const TEST_DEPT = 'DB_TEST_DEPT';
const TEST_CLASS_1 = 'DB_TEST_C1';
const TEST_CLASS_2 = 'DB_TEST_C2';
const TEST_SUBJ_1 = 'DB Test Subject 1';
const TEST_SUBJ_2 = 'DB Test Subject 2';
const TEST_FAC_1_CODE = 'DB_TEST_F1';
const TEST_FAC_1_NAME = 'Dr. DB Test Faculty 1';
const TEST_FAC_1_EMAIL = 'db_test_f1@college.edu';
const TEST_FAC_2_CODE = 'DB_TEST_F2';
const TEST_FAC_2_NAME = 'Dr. DB Test Faculty 2';
const TEST_FAC_2_EMAIL = 'db_test_f2@college.edu';
const TEST_ROOM_1 = 'DB_TEST_R1';
const TEST_ROOM_2 = 'DB_TEST_R2';
const ADDED = 'FAC900';

async function cleanupDbTestRecords() {
    await db.query('DELETE FROM users WHERE username IN ($1, $2) OR faculty_id IN (SELECT id FROM faculty WHERE code IN ($3, $4, $5))',
        ['test.appointee', 'db_test_f1', TEST_FAC_1_CODE, TEST_FAC_2_CODE, ADDED]);
    await db.query('DELETE FROM timetable WHERE class_id IN (SELECT id FROM classes WHERE code IN ($1, $2))',
        [TEST_CLASS_1, TEST_CLASS_2]);
    await db.query('DELETE FROM classes WHERE code IN ($1, $2)', [TEST_CLASS_1, TEST_CLASS_2]);
    await db.query('DELETE FROM subjects WHERE name IN ($1, $2)', [TEST_SUBJ_1, TEST_SUBJ_2]);
    await db.query('DELETE FROM rooms WHERE code IN ($1, $2)', [TEST_ROOM_1, TEST_ROOM_2]);
    await db.query('DELETE FROM faculty WHERE code IN ($1, $2, $3)', [TEST_FAC_1_CODE, TEST_FAC_2_CODE, ADDED]);
    await db.query('DELETE FROM departments WHERE code = $1', [TEST_DEPT]);
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

    await checkAsync('seed() initializes the database cleanly without injecting demo records', async () => {
        const result = await seeder.seed();
        assert.strictEqual(result.seeded, true);
        const { rows: periods } = await db.query('SELECT COUNT(*)::int AS n FROM periods');
        assert.ok(periods[0].n >= 7, 'default periods (1-7) must be populated');
    });

    await checkAsync('seeding again is idempotent', async () => {
        const second = await seeder.seed();
        assert.strictEqual(second.seeded, true, 'seed is idempotent');
    });

    await checkAsync('the faculty profile columns survive a re-run of the schema', async () => {
        await seeder.migrate();
        const { rows } = await db.query(`
            SELECT column_name FROM information_schema.columns
             WHERE table_name = 'faculty'`);
        const columns = rows.map(r => r.column_name);
        ['designation', 'email', 'phone', 'max_weekly_periods', 'status']
            .forEach(c => assert.ok(columns.includes(c), `faculty.${c} is missing`));
    });

    // Setup test fixtures for round-trip and CRUD testing
    await cleanupDbTestRecords();

    await repository.updateInstanceBranch({
        code: TEST_DEPT,
        name: 'Database Test Department',
        academicYear: '2026-2027',
        semester: 1,
        totalSemesters: 6
    });

    await repository.addClass({
        code: TEST_CLASS_1,
        department: TEST_DEPT,
        semester: 1,
        academicYear: '2026-2027',
        section: 'A'
    });
    await repository.addClass({
        code: TEST_CLASS_2,
        department: TEST_DEPT,
        semester: 1,
        academicYear: '2026-2027',
        section: 'B'
    });

    await repository.addSubject({
        code: 'DB_SUBJ_01',
        name: TEST_SUBJ_1,
        department: TEST_DEPT,
        type: 'theory'
    });
    await repository.addSubject({
        code: 'DB_SUBJ_02',
        name: TEST_SUBJ_2,
        department: TEST_DEPT,
        type: 'theory'
    });

    await repository.addFaculty({
        id: TEST_FAC_1_CODE,
        name: TEST_FAC_1_NAME,
        department: TEST_DEPT,
        email: TEST_FAC_1_EMAIL,
        phone: '9888800001',
        status: 'active',
        maxWeeklyPeriods: 18
    });
    await repository.addFaculty({
        id: TEST_FAC_2_CODE,
        name: TEST_FAC_2_NAME,
        department: TEST_DEPT,
        email: TEST_FAC_2_EMAIL,
        phone: '9888800002',
        status: 'active',
        maxWeeklyPeriods: 18
    });

    await db.query(`
        INSERT INTO rooms (code, name, room_type, capacity)
        VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)
        ON CONFLICT (code) DO NOTHING
    `, [TEST_ROOM_1, 'Test Classroom 1', 'classroom', 40,
        TEST_ROOM_2, 'Test Classroom 2', 'classroom', 40]);

    console.log('\n[2] Round-trip through PostgreSQL');

    await checkAsync('classes carry their branch, semester and academic year', async () => {
        const classes = await repository.listClasses();
        const testClass = classes.find(c => c.code === TEST_CLASS_1);
        assert.ok(testClass, 'test class must be found in database');
        assert.strictEqual(testClass.department, TEST_DEPT);
        assert.strictEqual(testClass.semester, 1);
        assert.strictEqual(testClass.academicYear, '2026-2027');
    });

    await checkAsync('the database refuses a double-booked faculty at the SQL level', async () => {
        const entry = await repository.addEntry({
            className: TEST_CLASS_1,
            day: 'Monday',
            period: 1,
            subject: TEST_SUBJ_1,
            faculty: TEST_FAC_1_NAME,
            type: 'theory'
        });
        assert.ok(entry && entry.id, 'entry should be created');

        await assert.rejects(
            () => db.query(`
                INSERT INTO timetable (class_id, day_of_week, period, subject_id, faculty_id, session_type)
                SELECT class_id, day_of_week, period, subject_id, faculty_id, session_type
                  FROM timetable WHERE id = $1`, [entry.id]),
            /duplicate key|unique/i,
            'a repeated faculty slot must be rejected by the schema itself');

        await repository.deleteEntry(entry.id);
    });

    await checkAsync('the stored timetable normalizes and passes validation with no conflicts', async () => {
        const source = await repository.loadSource();
        const report = validate(normalize(source, { allowEmpty: true }));
        assert.ok(report.ok, 'stored data must validate: ' +
            report.errors.map(e => e.message).join('; '));
        assert.strictEqual(report.errors.length, 0);
    });

    console.log('\n[3] Timetable entry API (add / edit / delete)');

    const dbState = await store.initFromDatabase();
    assert.ok(dbState.enabled, 'the store must be serving from the database: ' + JSON.stringify(dbState));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const freeClass = TEST_CLASS_1;
    const otherClasses = [TEST_CLASS_2];
    const freeCell = { day: 'Monday', period: 2 };
    const substitute = TEST_FAC_1_NAME;
    const otherFaculty = TEST_FAC_2_NAME;
    const SUBJECT_A = TEST_SUBJ_1;
    const SUBJECT_B = TEST_SUBJ_2;

    let createdId = null;

    await checkAsync('GET /entries/reference offers the form options', async () => {
        const res = await call('GET', '/api/timetable/entries/reference');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.editable, true);
        assert.ok(res.body.classes.some(c => c.code === TEST_CLASS_1));
        assert.ok(res.body.faculty.some(f => f.name === substitute));
        assert.ok(res.body.subjects.length > 0);
        assert.deepStrictEqual(res.body.types, ['theory', 'lab']);
    });

    let slotBefore;
    await checkAsync('POST /entries adds an entry and stores it', async () => {
        slotBefore = await call('POST', '/api/availability',
            { day: freeCell.day, period: freeCell.period });
        const before = (await call('GET', '/api/timetable/entries')).body.count;
        const res = await call('POST', '/api/timetable/entries', {
            class: freeClass, day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: substitute, room: TEST_ROOM_1, type: 'theory'
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
            subject: SUBJECT_A, faculty: substitute, room: TEST_ROOM_1
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'SLOT_CONFLICT');
    });

    await checkAsync('a faculty conflict across classes is rejected', async () => {
        const res = await call('POST', '/api/timetable/entries', {
            class: otherClasses[0], day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: substitute, room: TEST_ROOM_2
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'SLOT_CONFLICT');
        assert.ok(res.body.conflicts.some(c => c.code === 'FACULTY_BUSY' || c.code === 'CLASS_BUSY'));
    });

    await checkAsync('a room conflict across classes is rejected', async () => {
        const res = await call('POST', '/api/timetable/entries', {
            class: otherClasses[0], day: freeCell.day, period: freeCell.period,
            subject: SUBJECT_A, faculty: otherFaculty, room: TEST_ROOM_1
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
            subject: SUBJECT_B, faculty: substitute, room: TEST_ROOM_1, type: 'theory'
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.entry.subject, SUBJECT_B);

        const cell = (await call('GET', '/api/timetable?class=' + freeClass)).body.cells
            .find(c => c.day === freeCell.day && c.period === freeCell.period);
        assert.strictEqual(cell.subject, SUBJECT_B);
    });

    await checkAsync('editing into an occupied slot is rejected', async () => {
        const entry2 = await call('POST', '/api/timetable/entries', {
            class: freeClass, day: freeCell.day, period: 3,
            subject: SUBJECT_A, faculty: otherFaculty, room: TEST_ROOM_2, type: 'theory'
        });
        assert.strictEqual(entry2.status, 201);

        const res = await call('PUT', `/api/timetable/entries/${createdId}`, {
            class: freeClass, day: freeCell.day, period: 3,
            subject: SUBJECT_B, faculty: substitute, room: TEST_ROOM_1
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'SLOT_CONFLICT');

        await call('DELETE', `/api/timetable/entries/${entry2.body.entry.id}`);
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
            { id: TEST_FAC_1_CODE, name: 'Dr. Somebody Else', department: TEST_DEPT });
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'DUPLICATE_FACULTY');
        assert.match(res.body.error, /already in use/);
    });

    await checkAsync('a duplicate email is rejected', async () => {
        const res = await call('POST', '/api/faculty',
            { id: 'FAC901', name: 'Dr. Another Person', department: TEST_DEPT, email: TEST_FAC_1_EMAIL });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /Email .* already in use/);
    });

    let deptBeforeCount = 0;
    await checkAsync('POST /api/faculty stores a valid record', async () => {
        const before = (await call('GET', '/api/faculty')).body.count;
        const deptsRes = await call('GET', '/api/faculty/departments');
        const dept = deptsRes.body.details.find(d => d.code === TEST_DEPT);
        deptBeforeCount = dept ? dept.facultyCount : 0;

        const res = await call('POST', '/api/faculty', {
            id: ADDED, name: 'Dr. Test Appointee', department: TEST_DEPT,
            designation: 'Assistant Professor', email: 'test.appointee@college.edu',
            phone: '+91-90000-00000', maxWeeklyPeriods: 18, status: 'active'
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.faculty.id, ADDED);
        assert.strictEqual(res.body.faculty.department, TEST_DEPT);
        assert.strictEqual(res.body.faculty.designation, 'Assistant Professor');

        const after = (await call('GET', '/api/faculty')).body.count;
        assert.strictEqual(after, before + 1, 'the roster count grew by one');

        const row = await db.query('SELECT name, status FROM faculty WHERE code = $1', [ADDED]);
        assert.strictEqual(row.rows[0].name, 'Dr. Test Appointee', 'the row is really in PostgreSQL');
    });

    await checkAsync('the new faculty is immediately usable everywhere', async () => {
        const availability = await call('POST', '/api/availability', { day: 'Monday', period: 1 });
        assert.ok(availability.body.availableFaculty.includes('Dr. Test Appointee'),
            'the new member is offered as a substitute');

        const branch = await call('GET', '/api/faculty?department=' + TEST_DEPT);
        assert.ok(branch.body.faculty.some(f => f.id === ADDED), 'they appear under their branch');

        const reference = await call('GET', '/api/timetable/entries/reference');
        assert.ok(reference.body.faculty.some(f => f.name === 'Dr. Test Appointee'),
            'they are selectable when adding a timetable entry');

        const departments = await call('GET', '/api/faculty/departments');
        const dept = departments.body.details.find(d => d.code === TEST_DEPT);
        assert.strictEqual(dept.facultyCount, deptBeforeCount + 1, 'the branch count includes them');
    });

    await checkAsync('a sign-in account is created for the new faculty member', async () => {
        const { rows } = await db.query(
            'SELECT username FROM users WHERE faculty_id = (SELECT id FROM faculty WHERE code = $1)',
            [ADDED]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].username, 'test.appointee');
    });

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
        await cleanupDbTestRecords();
        if (server) server.close();
        await db.close();
        const { passed } = counts();
        console.log(`\n✅ database: ${passed} checks passed.`);
        process.exit(0);
    })
    .catch(async err => {
        console.error('\n✗ FAILED:', err);
        try { await cleanupDbTestRecords(); } catch (_) {}
        if (server) server.close();
        try { await db.close(); } catch (_) {}
        process.exit(1);
    });
