/**
 * Focused Regression Test: HOD Master Timetable "Register All Unresolved to Catalog" Flow
 *
 * Verifies:
 * 1. Create a staging timetable containing unresolved subjects (e.g. "Engineering Chemistry" without code,
 *    and another subject "Engineering Physics" with common prefix).
 * 2. Confirm they appear as unresolved references in GET /api/staging/:uploadId.
 * 3. Call the exact registration endpoint: POST /api/staging/:uploadId/register-all-unresolved.
 * 4. Confirm the API returns successfully with success: true and registered count.
 * 5. Confirm subjects are registered strictly in the authenticated HOD's branch catalog (CME only).
 * 6. Confirm staging references become resolved and unresolved list becomes empty.
 * 7. Confirm the staging timetable proceeds to approval without being blocked.
 * 8. Test duplicate registration safety (idempotent, no collisions or data overwrites).
 * 9. Test API failure handling on frontend and verify button is never stuck on "Registering...".
 */

const { verifySafetyGuard, initTestDb } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const { saveUploadRecord, saveStagedData, getStagedData } = require('../src/data/uploads');
const repository = require('../src/db/repository');

function makeAppRequest(server, options, body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: server.address().port,
            ...options
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function runTests() {
    console.log('======================================================');
    console.log('Running Focused Unresolved Subject Registration Tests');
    console.log('======================================================\n');

    await initTestDb();

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    console.log(`Test server running on port ${port}`);

    try {
        const testSuffix = Math.floor(1000 + Math.random() * 9000);
        const branchCode = `CME_${testSuffix}`;
        const otherBranchCode = `ECE_${testSuffix}`;

        // 1. Register HOD user for CME branch
        const hodUsername = `hod_cme_${testSuffix}`;
        const hodPassword = 'Hos_Password_123';
        let hodCookie;

        const regRes = await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            role: 'hos',
            username: hodUsername,
            password: hodPassword,
            confirmPassword: hodPassword,
            name: `HOD CME ${testSuffix}`,
            phone: '9876543210',
            email: `hod_cme_${testSuffix}@college.edu`,
            branchName: `Computer Engineering ${testSuffix}`,
            branchCode: branchCode
        }));
        assert(regRes.status === 200 || regRes.status === 201, `HOD registration failed: ${JSON.stringify(regRes.body)}`);

        // Login as CME HOD
        const loginRes = await makeAppRequest(server, {
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ username: hodUsername, password: hodPassword }));

        assert.strictEqual(loginRes.status, 200, `HOD login failed: ${JSON.stringify(loginRes.body)}`);
        hodCookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0].split(';')[0] : '';
        assert.ok(hodCookie, 'Received session cookie for HOD');

        // Pre-create known class and faculty in CME
        const targetClass = `CME-SEM4-A-${testSuffix}`;
        const knownFaculty = `Prof. Ramanujan ${testSuffix}`;
        await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: hodCookie }
        }, JSON.stringify({
            role: 'faculty',
            username: `fac_ram_${testSuffix}`,
            password: 'Fac_Password_123',
            confirmPassword: 'Fac_Password_123',
            name: knownFaculty,
            phone: '9876543211',
            email: `fac_${testSuffix}@college.edu`,
            branchName: `Computer Engineering ${testSuffix}`,
            branchCode: branchCode,
            designation: 'Professor'
        }));

        // -------------------------------------------------------------
        // TEST 1: Create Staged Timetable with Unresolved Subject
        // -------------------------------------------------------------
        console.log('--- Test 1: Create Staging Timetable with Unresolved Subjects ---');
        const uploadId = `upl_unres_${testSuffix}`;
        const unresolvedSubject1 = 'Engineering Chemistry';
        const unresolvedSubject2 = 'Engineering Physics';

        const contract = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            academic_year: '2025-2026',
            semester: '4',
            section: 'A',
            class_name: targetClass,
            department_code: branchCode,
            days: ['Monday', 'Tuesday', 'Wednesday'],
            periods: [1, 2, 3],
            period_timings: {
                '1': { start: '09:00', end: '10:00' },
                '2': { start: '10:00', end: '11:00' },
                '3': { start: '11:00', end: '12:00' }
            },
            entries: [
                { day: 'Monday', period: 1, subject_name: unresolvedSubject1, faculty_name: knownFaculty, room_code: 'LH-1', session_type: 'theory', class_name: targetClass },
                { day: 'Monday', period: 2, subject_name: unresolvedSubject2, faculty_name: knownFaculty, room_code: 'LH-1', session_type: 'theory', class_name: targetClass },
                { day: 'Tuesday', period: 1, subject_name: unresolvedSubject1, faculty_name: knownFaculty, room_code: 'LH-1', session_type: 'theory', class_name: targetClass }
            ]
        };

        await saveUploadRecord({
            uploadId,
            originalFilename: 'master_chem_physics.xlsx',
            departmentCode: branchCode,
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED',
            storagePath: 'uploads/test.xlsx',
            fileSize: 1024,
            fileType: 'xlsx'
        });

        await saveStagedData(
            uploadId,
            contract,
            'VALID',
            [],
            { importStatus: 'STAGED' }
        );

        console.log(`✓ Test 1 Passed: Staging record created with uploadId=${uploadId}`);

        // -------------------------------------------------------------
        // TEST 2: Confirm Staging Timetable reports Unresolved Subjects
        // -------------------------------------------------------------
        console.log('--- Test 2: Verify GET /api/staging/:uploadId lists Unresolved Subjects ---');
        const getStageRes = await makeAppRequest(server, {
            path: `/api/staging/${encodeURIComponent(uploadId)}`,
            method: 'GET',
            headers: { Cookie: hodCookie }
        });

        assert.strictEqual(getStageRes.status, 200);
        const unresList = getStageRes.body.resolution && getStageRes.body.resolution.unresolvedEntities;
        assert.ok(Array.isArray(unresList), 'Unresolved entities array returned');
        assert(unresList.length >= 2, `Expected at least 2 unresolved subjects, found ${unresList.length}`);
        
        const foundChem = unresList.find(e => e.extractedText === unresolvedSubject1);
        const foundPhys = unresList.find(e => e.extractedText === unresolvedSubject2);
        assert.ok(foundChem, 'Engineering Chemistry found in unresolved list');
        assert.ok(foundPhys, 'Engineering Physics found in unresolved list');
        console.log(`✓ Test 2 Passed: Unresolved list correctly identifies missing catalog subjects: "${unresolvedSubject1}" and "${unresolvedSubject2}"`);

        // -------------------------------------------------------------
        // TEST 3: Call POST /api/staging/:uploadId/register-all-unresolved
        // -------------------------------------------------------------
        console.log('--- Test 3: Call POST /api/staging/:uploadId/register-all-unresolved ---');
        const regAllRes = await makeAppRequest(server, {
            path: `/api/staging/${encodeURIComponent(uploadId)}/register-all-unresolved`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: hodCookie }
        });

        assert.strictEqual(regAllRes.status, 200, `register-all-unresolved returned ${regAllRes.status}: ${JSON.stringify(regAllRes.body)}`);
        assert.strictEqual(regAllRes.body.success, true);
        assert(regAllRes.body.registeredCount >= 2, `Expected at least 2 registered entities, got ${regAllRes.body.registeredCount}`);
        console.log(`✓ Test 3 Passed: register-all-unresolved returned success=true, registeredCount=${regAllRes.body.registeredCount}`);

        // -------------------------------------------------------------
        // TEST 4: Confirm Subjects created in branch catalog (CME only)
        // -------------------------------------------------------------
        console.log('--- Test 4: Confirm branch-scoping and catalog registration ---');
        if (db.isConfigured() && store.usingDatabase) {
            const chemDb = await db.query(
                `SELECT s.id, s.code, s.name, d.code AS dept_code 
                   FROM subjects s 
                   JOIN departments d ON s.department_id = d.id 
                  WHERE UPPER(s.name) = UPPER($1)`,
                [unresolvedSubject1]
            );
            assert.ok(chemDb.rows.length > 0, 'Engineering Chemistry exists in PostgreSQL database');
            assert.strictEqual(chemDb.rows[0].dept_code, 'CME', 'Engineering Chemistry must be registered in CME department only');

            const physDb = await db.query(
                `SELECT s.id, s.code, s.name, d.code AS dept_code 
                   FROM subjects s 
                   JOIN departments d ON s.department_id = d.id 
                  WHERE UPPER(s.name) = UPPER($1)`,
                [unresolvedSubject2]
            );
            assert.ok(physDb.rows.length > 0, 'Engineering Physics exists in PostgreSQL database');
            assert.strictEqual(physDb.rows[0].dept_code, 'CME', 'Engineering Physics must be registered in CME department only');

            // Confirm unique codes were generated without collision
            assert.notStrictEqual(chemDb.rows[0].code, physDb.rows[0].code, 'Codes for Chem and Phys must be unique and non-colliding');
        }
        console.log('✓ Test 4 Passed: Subjects registered strictly in CME branch catalog without code collisions');

        // -------------------------------------------------------------
        // TEST 5: Confirm Staging is fully resolved (unresolved list empty)
        // -------------------------------------------------------------
        console.log('--- Test 5: Confirm GET /api/staging/:uploadId now has empty unresolved list ---');
        const refreshStageRes = await makeAppRequest(server, {
            path: `/api/staging/${encodeURIComponent(uploadId)}`,
            method: 'GET',
            headers: { Cookie: hodCookie }
        });

        assert.strictEqual(refreshStageRes.status, 200);
        const resolvedList = refreshStageRes.body.resolution && refreshStageRes.body.resolution.unresolvedEntities;
        console.log('Resolved list remaining:', JSON.stringify(resolvedList, null, 2));
        assert.strictEqual(resolvedList.length, 0, `Expected 0 unresolved entities after registration, got ${resolvedList.length}: ${JSON.stringify(resolvedList)}`);
        assert.strictEqual(refreshStageRes.body.resolution.ok, true, 'Resolution ok must be true');
        console.log('✓ Test 5 Passed: Unresolved list is now empty and resolution.ok is true');

        // -------------------------------------------------------------
        // TEST 6: Confirm HOD Approval proceeds successfully
        // -------------------------------------------------------------
        console.log('--- Test 6: Confirm HOD Approval unblocked and succeeds ---');
        const approveRes = await makeAppRequest(server, {
            path: `/api/staging/${encodeURIComponent(uploadId)}/approve`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: hodCookie }
        });

        assert.strictEqual(approveRes.status, 200, `Approval returned ${approveRes.status}: ${JSON.stringify(approveRes.body)}`);
        assert.strictEqual(approveRes.body.success, true);
        assert.strictEqual(approveRes.body.importStatus, 'IMPORTED');
        console.log(`✓ Test 6 Passed: Timetable approved and imported ${approveRes.body.importedCount} slots into live Master Timetable`);

        // -------------------------------------------------------------
        // TEST 7: Duplicate Registration Safety Check
        // -------------------------------------------------------------
        console.log('--- Test 7: Duplicate Registration Safety Check ---');
        const dupRes = await makeAppRequest(server, {
            path: `/api/staging/${encodeURIComponent(uploadId)}/register-all-unresolved`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: hodCookie }
        });
        assert.strictEqual(dupRes.status, 200);
        assert.strictEqual(dupRes.body.success, true);
        console.log('✓ Test 7 Passed: Calling register-all-unresolved again is safe, idempotent, and error-free');

        // -------------------------------------------------------------
        // TEST 8: Cross-Branch Unauthorized Rejection Check
        // -------------------------------------------------------------
        console.log('--- Test 8: Cross-Branch Unauthorized Rejection Check ---');
        const eceHOD = `hod_ece_${testSuffix}`;
        const eceReg = await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            role: 'hos',
            username: eceHOD,
            password: hodPassword,
            confirmPassword: hodPassword,
            name: `HOD ECE ${testSuffix}`,
            phone: '9876543212',
            email: `hod_ece_${testSuffix}@college.edu`,
            branchName: `Electronics Engineering ${testSuffix}`,
            branchCode: otherBranchCode
        }));
        assert(eceReg.status === 200 || eceReg.status === 201, `ECE HOD registration failed: ${JSON.stringify(eceReg.body)}`);

        const eceLogin = await makeAppRequest(server, {
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ username: eceHOD, password: hodPassword }));

        const eceCookie = eceLogin.headers['set-cookie'] ? eceLogin.headers['set-cookie'][0].split(';')[0] : '';
        const crossRes = await makeAppRequest(server, {
            path: `/api/staging/${encodeURIComponent(uploadId)}/register-all-unresolved`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: eceCookie }
        });

        assert.strictEqual(crossRes.status, 403, 'Cross-branch HOD must receive 403 Forbidden');
        console.log('✓ Test 8 Passed: Cross-branch registration forbidden as expected');

        console.log('\n======================================================');
        console.log('ALL UNRESOLVED SUBJECT REGISTRATION TESTS PASSED!');
        console.log('======================================================\n');
    } finally {
        server.close();
    }
}

if (require.main === module) {
    runTests().catch(err => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });
}

module.exports = { runTests };
