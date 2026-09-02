/**
 * Catalog tests — branch, subject and class management, plus the image/PDF
 * extraction adapter.
 *
 * The read paths and the extraction adapter are tested without a database.
 * The write paths need a real PostgreSQL, so with no connection string those
 * sections are SKIPPED rather than passing vacuously:
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@host/db node tests/catalog.test.js
 *
 * WARNING: the write section creates and deletes records. Use a scratch database.
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { check, checkAsync, counts, request, waitForServer } = require('./helpers');

const CONNECTION = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const PORT = process.env.TEST_PORT || 3394;
const BASE = `http://localhost:${PORT}`;

// The modules below read configuration at require time, so the connection
// string has to be in the environment before any of them is loaded.
if (CONNECTION) process.env.DATABASE_URL = CONNECTION;

const get = p => request(BASE, 'GET', p);
const post = (p, b) => request(BASE, 'POST', p, b);
const del = p => request(BASE, 'DELETE', p);

const documentImporter = require('../src/importers/documentImporter');
const importer = require('../src/importers');

// ------------------------------------------- adapter (no server needed)
function adapterTests() {
    console.log('\n[1] Image / PDF extraction adapter');

    const config = require('../src/config');
    check('extraction status matches provider configuration', () => {
        assert.strictEqual(documentImporter.hasProvider(), Boolean(config.pdfcoApiKey));
        const status = documentImporter.status();
        assert.strictEqual(status.available, Boolean(config.pdfcoApiKey));
        if (!config.pdfcoApiKey) {
            assert.match(status.message, /not configured/i);
            assert.match(status.message, /no extraction has been attempted/i);
        }
        assert.ok(status.alternatives.length >= 3, 'it must offer working alternatives');
    });

    check('image and PDF extensions route to the adapter, not to a parser', () => {
        ['.png', '.jpg', '.jpeg', '.webp', '.pdf'].forEach(ext => {
            assert.strictEqual(importer.importerFor('tt' + ext), documentImporter, ext);
        });
        assert.ok(importer.SUPPORTED.includes('.pdf'));
        assert.ok(importer.SUPPORTED.includes('.webp'));
    });

    check('spreadsheet formats still route to their own importers', () => {
        assert.notStrictEqual(importer.importerFor('tt.xlsx'), documentImporter);
        assert.notStrictEqual(importer.importerFor('tt.csv'), documentImporter);
        assert.deepStrictEqual(importer.SPREADSHEET_FORMATS, ['.xlsx', '.xls', '.csv']);
    });

    check('a registered provider flows through the same pipeline', () => {
        documentImporter.setProvider({
            name: 'test-provider',
            async extract() { return { source: {}, confidence: 0.8 }; }
        });
        try {
            assert.strictEqual(documentImporter.hasProvider(), true);
            const status = documentImporter.status();
            assert.strictEqual(status.available, true);
            assert.match(status.message, /test-provider/);
        } finally {
            documentImporter.setProvider(null);
        }
    });

    check('a provider without extract() is refused', () => {
        assert.throws(() => documentImporter.setProvider({ name: 'broken' }), /extract/);
    });
}

async function adapterOverHttp() {
    console.log('\n[2] Extraction over HTTP');

    const config = require('../src/config');
    const status = await get('/api/timetable/import/document-status');
    check('GET /document-status reports extraction status', () => {
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.available, Boolean(config.pdfcoApiKey));
        assert.ok(status.body.alternatives.includes('Manual Timetable Entry'));
    });

    const formats = await get('/api/timetable/import/formats');
    check('GET /formats lists image/PDF and the extraction status together', () => {
        assert.ok(formats.body.supported.includes('.pdf'));
        assert.strictEqual(formats.body.document.available, Boolean(config.pdfcoApiKey));
    });
}

// ------------------------------------------------- catalog reads (no DB)
async function readTests() {
    console.log('\n[3] Catalog reads (work without a database)');

    const branches = await get('/api/branches');
    check('GET /api/branches lists every branch', () => {
        assert.strictEqual(branches.status, 200);
        assert.ok(branches.body.count >= 4, 'the four seeded branches at least');
        const codes = branches.body.branches.map(b => b.code);
        ['EE', 'ECE', 'MEC', 'CME'].forEach(code => {
            assert.ok(codes.includes(code), `${code} must still be listed`);
        });
        assert.strictEqual(typeof branches.body.writable, 'boolean');
    });

    const subjects = await get('/api/subjects');
    const classes = await get('/api/classes');
    check('GET /api/subjects and /api/classes list the catalog', () => {
        assert.strictEqual(subjects.status, 200);
        assert.ok(subjects.body.count > 0);
        assert.strictEqual(classes.status, 200);
        assert.ok(classes.body.count > 0);
    });

    const filtered = await get('/api/subjects?branch=CME');
    check('subjects filter by branch', () => {
        assert.strictEqual(filtered.status, 200);
        filtered.body.subjects.forEach(s =>
            assert.strictEqual(String(s.department).toUpperCase(), 'CME'));
    });

    const filteredClasses = await get('/api/classes?branch=CME');
    check('classes filter by branch', () => {
        filteredClasses.body.classes.forEach(c =>
            assert.strictEqual(String(c.department).toUpperCase(), 'CME'));
    });

    if (!CONNECTION) {
        const attempt = await post('/api/branches', { code: 'ZZ', name: 'Nope' });
        check('without a database, writes are refused with a clear reason', () => {
            assert.strictEqual(attempt.status, 503);
            assert.strictEqual(attempt.body.code, 'DATABASE_REQUIRED');
            assert.match(attempt.body.error, /DATABASE_URL/);
        });
    }
}

// ------------------------------------------------ catalog writes (needs DB)
async function writeTests() {
    console.log('\n[4] Catalog writes (database)');

    const CODE = 'TSTB';

    // Clear anything a previous (possibly crashed) run left behind, in
    // dependency order. The API refuses to delete a branch that still has
    // faculty, so residue has to be cleared directly or it wedges this suite.
    const pool = require('../src/db/pool');
    await pool.query(`DELETE FROM timetable WHERE class_id IN
        (SELECT id FROM classes WHERE code LIKE 'TSTB%')`);
    await pool.query("DELETE FROM classes WHERE code LIKE 'TSTB%'");
    await pool.query("DELETE FROM subjects WHERE code = 'TST101'");
    await pool.query(`DELETE FROM users WHERE faculty_id IN
        (SELECT id FROM faculty WHERE code = 'TSTF1')`);
    await pool.query("DELETE FROM faculty WHERE code = 'TSTF1'");
    await pool.query("DELETE FROM departments WHERE code IN ('TSTB', 'TSTC')");

    const created = await post('/api/branches', { code: CODE, name: 'Test Branch for Suite' });
    check('POST /api/branches creates a branch', () => {
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.body.branch.code, CODE);
        assert.strictEqual(created.body.branch.facultyCount, 0);
    });

    const dupCode = await post('/api/branches', { code: CODE, name: 'Something Different' });
    const dupName = await post('/api/branches', { code: 'TSTC', name: 'Test Branch for Suite' });
    check('duplicate code and duplicate name are both rejected', () => {
        assert.strictEqual(dupCode.status, 409);
        assert.match(dupCode.body.error, /already exists/i);
        assert.strictEqual(dupName.status, 409);
        assert.match(dupName.body.error, /already exists/i);
    });

    const missing = await post('/api/branches', {});
    check('a branch with no code or name is rejected', () => {
        assert.strictEqual(missing.status, 400);
        assert.match(missing.body.error, /code is required/i);
        assert.match(missing.body.error, /name is required/i);
    });

    const listed = await get('/api/branches');
    check('the new branch appears in the branch list immediately', () => {
        assert.ok(listed.body.branches.some(b => b.code === CODE));
    });

    // --- subjects belong to exactly one branch ---
    const subject = await post('/api/subjects',
        { code: 'TST101', name: 'Suite Subject', department: CODE, type: 'theory' });
    check('a subject can be added to the new branch', () => {
        assert.strictEqual(subject.status, 201);
        assert.strictEqual(subject.body.subject.department, CODE);
    });

    const mine = await get('/api/subjects?branch=' + CODE);
    const cse = await get('/api/subjects?branch=CSE');
    check('the subject appears under its own branch and nowhere else', () => {
        assert.ok(mine.body.subjects.some(s => s.code === 'TST101'));
        assert.ok(!cse.body.subjects.some(s => s.code === 'TST101'),
            'a subject must not leak into another branch');
    });

    // --- classes are sections inside a branch ---
    const section = await post('/api/classes',
        { code: 'TSTB-A', department: CODE, semester: 5, academicYear: '2025-26' });
    check('a class can be added under the new branch', () => {
        assert.strictEqual(section.status, 201);
        assert.strictEqual(section.body.class.department, CODE);
        assert.strictEqual(section.body.class.semester, 5);
    });

    const badSemester = await post('/api/classes', { code: 'TSTB-Z', department: CODE, semester: 99 });
    const unknownBranch = await post('/api/classes', { code: 'TSTB-Y', department: 'NOSUCH' });
    check('an invalid semester and an unknown branch are rejected', () => {
        assert.strictEqual(badSemester.status, 400);
        assert.strictEqual(unknownBranch.status, 400);
        assert.match(unknownBranch.body.error, /Unknown branch/i);
    });

    // --- faculty must accept the new branch without a code change ---
    const member = await post('/api/faculty', {
        id: 'TSTF1', name: 'Dr. Suite Tester', department: CODE,
        designation: 'Assistant Professor', email: 'suite.tester@example.edu'
    });
    check('faculty can be added to the newly created branch', () => {
        assert.strictEqual(member.status, 201);
        assert.strictEqual(member.body.faculty.department, CODE);
    });

    const roster = await get('/api/faculty?department=' + CODE);
    check('the faculty directory filters by the new branch', () => {
        assert.strictEqual(roster.body.count, 1);
        assert.strictEqual(roster.body.faculty[0].name, 'Dr. Suite Tester');
    });

    // --- a timetable entry for the new branch ---
    const entry = await post('/api/timetable/entries', {
        class: 'TSTB-A', day: 'Monday', period: 1,
        subject: 'Suite Subject', faculty: 'Dr. Suite Tester', sessionType: 'theory'
    });
    check('a timetable entry can be created for the new branch', () => {
        assert.strictEqual(entry.status, 201, JSON.stringify(entry.body));
    });

    const clash = await post('/api/timetable/entries', {
        class: 'TSTB-A', day: 'Monday', period: 1,
        subject: 'Suite Subject', faculty: 'Dr. Suite Tester', sessionType: 'theory'
    });
    check('a duplicate slot for that class is rejected', () => {
        assert.ok(clash.status >= 400);
        assert.match(clash.body.error, /already has|already teaches/i);
    });

    // --- deletes are refused while anything still references the record ---
    const busySubject = await del('/api/subjects/TST101');
    const busyClass = await del('/api/classes/TSTB-A');
    const busyBranch = await del('/api/branches/' + CODE);
    check('a subject, class or branch still in use cannot be deleted', () => {
        assert.strictEqual(busySubject.status, 409);
        assert.match(busySubject.body.error, /timetable entry/i);
        assert.strictEqual(busyClass.status, 409);
        assert.strictEqual(busyBranch.status, 409);
        assert.match(busyBranch.body.error, /still has/i);
    });

    // --- tear down in dependency order, which also tests the delete paths ---
    const entries = await get('/api/timetable/entries?class=TSTB-A');
    for (const row of entries.body.entries) await del('/api/timetable/entries/' + row.id);
    const removedClass = await del('/api/classes/TSTB-A');
    const removedSubject = await del('/api/subjects/TST101');
    check('once free of references, class and subject delete cleanly', () => {
        assert.strictEqual(removedClass.status, 200);
        assert.strictEqual(removedSubject.status, 200);
    });

    const stillHasFaculty = await del('/api/branches/' + CODE);
    check('the branch is still protected by its remaining faculty', () => {
        assert.strictEqual(stillHasFaculty.status, 409);
        assert.match(stillHasFaculty.body.error, /faculty/i);
    });

    // Leave the database exactly as found. There is deliberately no faculty
    // DELETE endpoint, so the test's own row is removed directly here rather
    // than left behind to skew the counts other suites assert on.
    await pool.query("DELETE FROM users WHERE faculty_id IN (SELECT id FROM faculty WHERE code = 'TSTF1')");
    await pool.query("DELETE FROM faculty WHERE code = 'TSTF1'");

    const removedBranch = await del('/api/branches/' + CODE);
    check('with nothing left referencing it, the branch deletes cleanly', () => {
        assert.strictEqual(removedBranch.status, 200);
    });

    const finalList = await get('/api/branches');
    check('teardown leaves only the original branches', () => {
        assert.ok(!finalList.body.branches.some(b => b.code === CODE));
        ['CSE', 'ECE', 'EEE', 'CME', 'MEC', 'CIVIL'].forEach(code =>
            assert.ok(finalList.body.branches.some(b => b.code === code), code + ' must survive'));
    });
}

async function main() {
    console.log('TecSubstitution — catalog tests');
    adapterTests();

    const env = { ...process.env, PORT: String(PORT) };
    if (CONNECTION) env.DATABASE_URL = CONNECTION;

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    server.stdout.on('data', d => log += d);
    server.stderr.on('data', d => log += d);

    try {
        await waitForServer(BASE);
        await adapterOverHttp();
        await readTests();
        if (CONNECTION) {
            await writeTests();
        } else {
            console.log('\n[4] Catalog writes (database)');
            console.log('  [skip] No TEST_DATABASE_URL set — write paths need a real PostgreSQL.');
        }
    } catch (err) {
        console.error('\nServer output:\n' + log);
        throw err;
    } finally {
        server.kill();
        if (CONNECTION) {
            try { await require('../src/db/pool').close(); } catch (err) { /* already closed */ }
        }
    }

    const { passed } = counts();
    console.log(`\n✅ catalog: ${passed} checks passed${CONNECTION ? '' : ' (writes skipped — no database)'}.`);
}

main().catch(err => {
    console.error('\n✗ FAILED:', err.message);
    process.exit(1);
});
