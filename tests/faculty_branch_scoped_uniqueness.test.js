/**
 * Test Suite: Branch-Scoped Faculty Uniqueness and Resolution Isolation
 *
 * Verifies:
 * CASE A: Create "Ravi Kumar" in CME -> SUCCESS
 * CASE B: Create "Ravi Kumar" in EEE -> SUCCESS
 * CASE C: Create another "Ravi Kumar" in CME -> REJECT as duplicate within CME
 * CASE D: Create another "Ravi Kumar" in EEE -> REJECT as duplicate within EEE
 * CASE E: Import CME timetable containing CME faculty -> resolves only to CME faculty
 * CASE F: Import EEE timetable containing same faculty name -> resolves only to EEE faculty
 * CASE G: Ensure a CME timetable cannot resolve a same-name EEE faculty
 * Coexistence: Verify CME, EEE, and MEC faculty with identical names coexist safely.
 */
const { initTestDb } = require('./testDbGuard');
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
const entityResolver = require('../src/core/entityResolver');
const seed = require('../src/db/seed');

let server;
let baseUrl;

function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

function call(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { }
                const setCookie = (res.headers['set-cookie'] || [])[0] || null;
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    raw: data,
                    cookie: setCookie ? setCookie.split(';')[0] : null
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('--- STARTING Branch-Scoped Faculty Uniqueness & Isolation Test Suite ---');
    await initTestDb();
    await seed.migrate();
    await startServer();

    try {
        // Ensure CME, EEE, and MEC departments exist
        await db.query(`
            INSERT INTO departments (code, name, total_semesters)
            VALUES ('CME', 'Computer Engineering', 6),
                   ('EEE', 'Electrical & Electronics Engineering', 6),
                   ('MEC', 'Mechanical Engineering', 6)
            ON CONFLICT (code) DO NOTHING
        `);

        // Clean up test-specific faculty if present
        await db.query(`
            DELETE FROM timetable WHERE faculty_id IN (
                SELECT id FROM faculty WHERE name IN ('Ravi Kumar', 'Dr. Shared Name', 'Prof. Multi Branch')
            )
        `);
        await db.query(`
            DELETE FROM users WHERE name IN ('Ravi Kumar', 'Dr. Shared Name', 'Prof. Multi Branch')
        `);
        await db.query(`
            DELETE FROM faculty WHERE name IN ('Ravi Kumar', 'Dr. Shared Name', 'Prof. Multi Branch')
        `);

        console.log('\n--- CASE A: Create "Ravi Kumar" in CME ---');
        const cmeFaculty = await repository.addFaculty({
            id: 'CME_RAVI_01',
            name: 'Ravi Kumar',
            department: 'CME',
            designation: 'Assistant Professor',
            status: 'active'
        });
        assert.ok(cmeFaculty && cmeFaculty.numeric_id, 'CME faculty should be created');
        assert.strictEqual(cmeFaculty.department, 'CME');
        console.log('✔ Case A Passed: "Ravi Kumar" created in CME with ID:', cmeFaculty.numeric_id);

        console.log('\n--- CASE B: Create "Ravi Kumar" in EEE ---');
        const eeeFaculty = await repository.addFaculty({
            id: 'EEE_RAVI_01',
            name: 'Ravi Kumar',
            department: 'EEE',
            designation: 'Associate Professor',
            status: 'active'
        });
        assert.ok(eeeFaculty && eeeFaculty.numeric_id, 'EEE faculty should be created');
        assert.strictEqual(eeeFaculty.department, 'EEE');
        assert.notStrictEqual(cmeFaculty.numeric_id, eeeFaculty.numeric_id, 'CME and EEE faculty must have distinct numeric IDs');
        console.log('✔ Case B Passed: "Ravi Kumar" created in EEE with ID:', eeeFaculty.numeric_id);

        console.log('\n--- Coexistence Check: Create "Ravi Kumar" in MEC ---');
        const mecFaculty = await repository.addFaculty({
            id: 'MEC_RAVI_01',
            name: 'Ravi Kumar',
            department: 'MEC',
            designation: 'Professor',
            status: 'active'
        });
        assert.ok(mecFaculty && mecFaculty.numeric_id, 'MEC faculty should be created');
        assert.strictEqual(mecFaculty.department, 'MEC');
        console.log('✔ MEC Faculty Created: "Ravi Kumar" in MEC with ID:', mecFaculty.numeric_id);

        console.log('\n--- CASE C: Reject duplicate "Ravi Kumar" within CME ---');
        let duplicateCmeRejected = false;
        try {
            await repository.addFaculty({
                id: 'CME_RAVI_02',
                name: 'Ravi Kumar',
                department: 'CME',
                designation: 'Lecturer',
                status: 'active'
            });
        } catch (err) {
            duplicateCmeRejected = true;
            assert.strictEqual(err.status, 409, 'Duplicate in same department should return 409');
            console.log('✔ Caught expected rejection for CME duplicate:', err.message);
        }
        assert.strictEqual(duplicateCmeRejected, true, 'Duplicate "Ravi Kumar" in CME must be rejected');
        console.log('✔ Case C Passed: Second "Ravi Kumar" in CME correctly rejected');

        console.log('\n--- CASE D: Reject duplicate "Ravi Kumar" within EEE ---');
        let duplicateEeeRejected = false;
        try {
            await repository.addFaculty({
                id: 'EEE_RAVI_02',
                name: 'Ravi Kumar',
                department: 'EEE',
                designation: 'Lecturer',
                status: 'active'
            });
        } catch (err) {
            duplicateEeeRejected = true;
            assert.strictEqual(err.status, 409, 'Duplicate in same department should return 409');
            console.log('✔ Caught expected rejection for EEE duplicate:', err.message);
        }
        assert.strictEqual(duplicateEeeRejected, true, 'Duplicate "Ravi Kumar" in EEE must be rejected');
        console.log('✔ Case D Passed: Second "Ravi Kumar" in EEE correctly rejected');

        console.log('\n--- Database Direct Constraint Verification ---');
        let dbConstraintTripped = false;
        try {
            const { rows: dRows } = await db.query("SELECT id FROM departments WHERE code = 'CME'");
            await db.query(
                `INSERT INTO faculty (code, name, department_id) VALUES ('CME_RAVI_DIRECT_DUP', 'Ravi Kumar', $1)`,
                [dRows[0].id]
            );
        } catch (err) {
            dbConstraintTripped = true;
            assert.ok(/faculty_dept_name_unique/i.test(err.message) || /unique constraint/i.test(err.message),
                'DB constraint should trigger on branch duplicate: ' + err.message);
            console.log('✔ Database constraint faculty_dept_name_unique fired as expected:', err.message);
        }
        assert.strictEqual(dbConstraintTripped, true, 'DB unique index must reject duplicate within same department');

        console.log('\n--- CASE E: Import CME timetable resolves ONLY to CME faculty ---');
        const cmeContract = {
            academic_year: '2025-2026',
            semester: 3,
            section: 'A',
            class_name: 'CME-SEM3-A',
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Data Structures',
                    faculty_name: 'Ravi Kumar',
                    room_code: 'C-101',
                    session_type: 'theory'
                }
            ]
        };

        const cmeRes = await entityResolver.resolveContract(cmeContract, 'CME', {}, { useDatabase: true });
        const cmeResolvedFac = entityResolver.getResolvedFacultyEntry(cmeRes.resolvedMap.faculty, 'Ravi Kumar');
        assert.ok(cmeResolvedFac, 'CME contract must resolve faculty "Ravi Kumar"');
        assert.strictEqual(cmeResolvedFac.id, cmeFaculty.numeric_id, 'Must resolve to CME faculty record');
        console.log('✔ Case E Passed: CME contract resolved to CME faculty ID:', cmeResolvedFac.id);

        console.log('\n--- CASE F: Import EEE timetable resolves ONLY to EEE faculty ---');
        const eeeContract = {
            academic_year: '2025-2026',
            semester: 3,
            section: 'A',
            class_name: 'EEE-SEM3-A',
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Power Systems',
                    faculty_name: 'Ravi Kumar',
                    room_code: 'E-101',
                    session_type: 'theory'
                }
            ]
        };

        const eeeRes = await entityResolver.resolveContract(eeeContract, 'EEE', {}, { useDatabase: true });
        const eeeResolvedFac = entityResolver.getResolvedFacultyEntry(eeeRes.resolvedMap.faculty, 'Ravi Kumar');
        assert.ok(eeeResolvedFac, 'EEE contract must resolve faculty "Ravi Kumar"');
        assert.strictEqual(eeeResolvedFac.id, eeeFaculty.numeric_id, 'Must resolve to EEE faculty record');
        console.log('✔ Case F Passed: EEE contract resolved to EEE faculty ID:', eeeResolvedFac.id);

        console.log('\n--- CASE G: Verify CME timetable resolution cannot pick EEE faculty ---');
        const cmeCatalog = await entityResolver.fetchBranchCatalog('CME', { useDatabase: true });
        const cmeCatalogFacIds = cmeCatalog.faculty.map(f => f.id);
        assert.ok(cmeCatalogFacIds.includes(cmeFaculty.numeric_id), 'CME catalog contains CME faculty');
        assert.ok(!cmeCatalogFacIds.includes(eeeFaculty.numeric_id), 'CME catalog MUST NOT contain EEE faculty');
        assert.ok(!cmeCatalogFacIds.includes(mecFaculty.numeric_id), 'CME catalog MUST NOT contain MEC faculty');
        console.log('✔ Case G Passed: CME catalog is strictly branch-isolated from EEE and MEC faculty');

        console.log('\n--- In-Memory Store Branch-Scoped Verification ---');
        store.resetForEmptyInstance();
        const memCme = store.addFacultyInMemory({
            id: 'MEM_CME_RAVI',
            name: 'Ravi Kumar',
            department: 'CME',
            status: 'active'
        });
        const memEee = store.addFacultyInMemory({
            id: 'MEM_EEE_RAVI',
            name: 'Ravi Kumar',
            department: 'EEE',
            status: 'active'
        });
        assert.ok(memCme && memEee, 'Both in-memory faculty should be created');
        assert.strictEqual(memCme.department, 'CME');
        assert.strictEqual(memEee.department, 'EEE');
        assert.notStrictEqual(memCme.id, memEee.id, 'In-memory IDs must differ');
        console.log('✔ In-memory branch-scoped faculty verified successfully');

        console.log('\n=== ALL BRANCH-SCOPED FACULTY UNIQUENESS & ISOLATION TESTS PASSED ===\n');
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
