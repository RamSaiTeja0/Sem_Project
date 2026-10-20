/**
 * Regression Test Suite: Staging Registration Workflow & Account Separation
 * 
 * Verifies:
 * 1. Registering one unresolved faculty entity creates a faculty record but no login account.
 * 2. Registering all unresolved faculty entities creates faculty records without login accounts.
 * 3. Registered unlinked faculty appear under Faculty Without Account (hasAccount: false).
 * 4. Explicit Create Account creates a linked login account and moves faculty to Faculty With Account.
 * 5. Repeated requests do not create duplicate faculty records or accounts.
 * 6. Existing faculty matches are reused appropriately.
 * 7. Faculty registration and account creation remain branch-isolated.
 * 8. Timetable approval still imports valid timetable entries without creating extra accounts.
 * 9. Ordinary faculty users cannot register staging entities or approve timetables (HTTP 403).
 * 
 * SAFETY:
 * Strictly isolated to TEST_DATABASE_URL (neondb_test) via testDbGuard.
 */

const { verifySafetyGuard, initTestDb } = require('./testDbGuard');
const guardInfo = verifySafetyGuard();
console.log(`[Safety Guard] Target confirmed: ${guardInfo.parsedTest.full}`);

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { app } = require('../server');
const pool = require('../src/db/pool');
const store = require('../src/data/store');
const { hashPassword } = require('../src/core/authSecurity');
const {
    saveUploadRecord,
    saveStagedData,
    clearUploads
} = require('../src/data/uploads');

let server;
let baseUrl;

function startServer() {
    return new Promise(resolve => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
}

function stopServer() {
    return new Promise(resolve => {
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
                try { parsed = JSON.parse(data); } catch (e) {}
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
    console.log('\n======================================================');
    console.log('Staging Registration No-Account Separation Tests');
    console.log('======================================================\n');

    // POSITIVE VERIFICATION: Ensure the active target is confirmed to be the isolated test database
    const activeTarget = (pool.describeTarget() || '').toLowerCase();
    const testDbName = (guardInfo.parsedTest.dbName || '').toLowerCase();
    if (!activeTarget.includes(testDbName) || activeTarget.includes('neondb?')) {
        throw new Error(`[SAFETY GUARD FATAL] Refusing to run tests: active target "${activeTarget}" is not the test database "${testDbName}"!`);
    }

    await initTestDb();

    // Clean test database tables
    await pool.query(`
        DELETE FROM timetable;
        DELETE FROM faculty_attendance;
        DELETE FROM exam_invigilation;
        DELETE FROM exam_invigilation_requests;
        DELETE FROM faculty_substitutions;
        DELETE FROM faculty_subjects;
        DELETE FROM timetable_staging;
        DELETE FROM timetable_uploads;
        DELETE FROM users WHERE role = 'faculty' OR faculty_id IS NOT NULL;
        DELETE FROM faculty;
    `);

    // Ensure departments exist
    await pool.query(`
        INSERT INTO departments (code, name) VALUES ('CME', 'Computer Engineering')
        ON CONFLICT (code) DO NOTHING;
        INSERT INTO departments (code, name) VALUES ('ECE', 'Electronics Engineering')
        ON CONFLICT (code) DO NOTHING;
    `);

    const cmeDeptRes = await pool.query("SELECT id FROM departments WHERE code = 'CME'");
    const cmeDeptId = cmeDeptRes.rows[0].id;

    const eceDeptRes = await pool.query("SELECT id FROM departments WHERE code = 'ECE'");
    const eceDeptId = eceDeptRes.rows[0].id;

    // Seed test HODs and one regular faculty
    const pwdHash = hashPassword('Test@1234');
    await pool.query(`
        INSERT INTO users (username, password_hash, name, role, department_id, active, status)
        VALUES ('hod_cme', $1, 'HOD CME', 'hos', $2, true, 'active')
        ON CONFLICT (username) DO UPDATE SET password_hash = $1, department_id = $2;
    `, [pwdHash, cmeDeptId]);

    await pool.query(`
        INSERT INTO users (username, password_hash, name, role, department_id, active, status)
        VALUES ('hod_ece', $1, 'HOD ECE', 'hos', $2, true, 'active')
        ON CONFLICT (username) DO UPDATE SET password_hash = $1, department_id = $2;
    `, [pwdHash, eceDeptId]);

    await store.reloadFromDatabase();
    await startServer();

    try {
        // Sign in HOD CME
        const cmeLogin = await call('POST', '/api/auth/login', { username: 'hod_cme', password: 'Test@1234' });
        assert.strictEqual(cmeLogin.status, 200, 'HOD CME login should succeed');
        const cmeCookie = cmeLogin.cookie;

        // Sign in HOD ECE
        const eceLogin = await call('POST', '/api/auth/login', { username: 'hod_ece', password: 'Test@1234' });
        assert.strictEqual(eceLogin.status, 200, 'HOD ECE login should succeed');
        const eceCookie = eceLogin.cookie;

        // Set up staged timetable for CME with 2 unresolved faculty: "Dr. Alice Smith" and "Prof. Bob Jones"
        const uploadId = 'upl_test_no_account_001';
        await saveUploadRecord({
            uploadId,
            originalFilename: 'test_cme_tt.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: 'test_cme_tt.pdf',
            uploaderUserId: cmeLogin.body.user.id,
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'PROCESSING'
        });

        const extractedJson = {
            metadata: { institution: 'Test Poly', department: 'CME', semester: '5', academic_year: '2026-2027', section: 'A' },
            class_name: 'CME-5A',
            semester: '5',
            section: 'A',
            academic_year: '2026-2027',
            entries: [
                { day: 'Monday', period_start: 1, period_end: 1, subject_name: 'Algorithms', faculty_name: 'Dr. Alice Smith', room_code: 'Lab-1' },
                { day: 'Tuesday', period_start: 2, period_end: 2, subject_name: 'Databases', faculty_name: 'Prof. Bob Jones', room_code: 'Lab-2' }
            ],
            subject_legend: [
                { code: 'CME501', name: 'Algorithms' },
                { code: 'CME502', name: 'Databases' }
            ],
            faculty_legend: [
                { name: 'Dr. Alice Smith', code: 'CME_ALICE' },
                { name: 'Prof. Bob Jones', code: 'CME_BOB' }
            ]
        };

        await saveStagedData(uploadId, {
            extractedJson,
            validationStatus: 'VALID',
            unresolvedEntities: [
                { entityType: 'faculty', extractedText: 'Dr. Alice Smith', code: 'CME_ALICE' },
                { entityType: 'faculty', extractedText: 'Prof. Bob Jones', code: 'CME_BOB' },
                { entityType: 'subject', extractedText: 'Algorithms', code: 'CME501' },
                { entityType: 'subject', extractedText: 'Databases', code: 'CME502' },
                { entityType: 'room', extractedText: 'Lab-1', code: 'Lab-1' },
                { entityType: 'room', extractedText: 'Lab-2', code: 'Lab-2' }
            ],
            importStatus: 'STAGED'
        });

        console.log('--- Test 1: Register single unresolved faculty entity ---');
        const reg1 = await call('POST', `/api/staging/${uploadId}/register-entity`, {
            entityType: 'faculty',
            extractedText: 'Dr. Alice Smith',
            code: 'CME_ALICE'
        }, cmeCookie);

        assert.strictEqual(reg1.status, 200, 'Register single entity should succeed');
        assert(reg1.body.success, 'Expected success: true');

        // Verify in DB: faculty table has 1 record, users table has 0 faculty records
        const facCountRes1 = await pool.query("SELECT id, code, name FROM faculty WHERE UPPER(name) = 'DR. ALICE SMITH'");
        assert.strictEqual(facCountRes1.rows.length, 1, 'Faculty table must have Alice Smith');
        const aliceFacId = facCountRes1.rows[0].id;

        const userFacCount1 = await pool.query("SELECT id, username FROM users WHERE role = 'faculty' OR faculty_id = $1", [aliceFacId]);
        assert.strictEqual(userFacCount1.rows.length, 0, 'CRITICAL: No user account must be created for Alice Smith!');
        console.log('✓ PASS: Faculty record created with ZERO login accounts');

        console.log('\n--- Test 2: Unlinked faculty appears under Faculty Without Account ---');
        const facListRes1 = await call('GET', '/api/faculty?department=CME', null, cmeCookie);
        assert.strictEqual(facListRes1.status, 200);
        const aliceInList = facListRes1.body.faculty.find(f => f.name.toUpperCase() === 'DR. ALICE SMITH');
        assert(aliceInList, 'Alice Smith must appear in faculty list');
        assert.strictEqual(aliceInList.hasAccount, false, 'hasAccount must be FALSE');
        assert.strictEqual(aliceInList.account, null, 'account must be null');
        console.log('✓ PASS: Alice Smith has hasAccount: false and is unlinked');

        console.log('\n--- Test 3: Register All Unresolved creates remaining faculty with NO accounts ---');
        const regAll = await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, cmeCookie);
        assert.strictEqual(regAll.status, 200, 'Register all unresolved should succeed');

        const facCountRes2 = await pool.query("SELECT id, code, name FROM faculty WHERE UPPER(name) = 'PROF. BOB JONES'");
        assert.strictEqual(facCountRes2.rows.length, 1, 'Bob Jones must exist in faculty');
        const bobFacId = facCountRes2.rows[0].id;

        const userFacCount2 = await pool.query("SELECT id, username FROM users WHERE role = 'faculty'");
        assert.strictEqual(userFacCount2.rows.length, 0, 'CRITICAL: Total faculty user accounts in users table must STILL be 0!');
        console.log('✓ PASS: Register-all-unresolved created faculty records with ZERO login accounts');

        console.log('\n--- Test 4: Repeated registration reuses existing faculty without duplicates ---');
        const regRepeat = await call('POST', `/api/staging/${uploadId}/register-entity`, {
            entityType: 'faculty',
            extractedText: 'Dr. Alice Smith',
            code: 'CME_ALICE'
        }, cmeCookie);
        assert.strictEqual(regRepeat.status, 200);

        const facAllAlice = await pool.query("SELECT id FROM faculty WHERE UPPER(name) = 'DR. ALICE SMITH'");
        assert.strictEqual(facAllAlice.rows.length, 1, 'Repeated registration must not create duplicate faculty records');
        console.log('✓ PASS: Duplicate registration prevented and existing record reused');

        console.log('\n--- Test 5: Cross-branch isolation blocks HOD ECE from CME staging ---');
        const crossReg = await call('POST', `/api/staging/${uploadId}/register-entity`, {
            entityType: 'faculty',
            extractedText: 'Prof. Charlie Cross'
        }, eceCookie);
        assert.strictEqual(crossReg.status, 403, 'Cross-branch staging access must be forbidden');
        console.log('✓ PASS: Cross-branch staging access rejected with HTTP 403');

        console.log('\n--- Test 6: Explicit Create Account creates linked account and moves to With Account ---');
        const createAccRes = await call('POST', `/api/faculty/${aliceFacId}/create-account`, {
            username: 'alice.smith',
            password: 'Password_123',
            confirmPassword: 'Password_123'
        }, cmeCookie);

        if (createAccRes.status !== 201) {
            console.error('createAccRes failed:', createAccRes.status, createAccRes.body);
        }
        assert.strictEqual(createAccRes.status, 201, 'Explicit account creation should return HTTP 201');
        assert(createAccRes.body.success, 'Expected success: true');
        assert.strictEqual(createAccRes.body.user.username, 'alice.smith');

        // Check DB
        const aliceUserDb = await pool.query("SELECT id, username, role, faculty_id FROM users WHERE username = 'alice.smith'");
        assert.strictEqual(aliceUserDb.rows.length, 1);
        assert.strictEqual(aliceUserDb.rows[0].faculty_id, aliceFacId, 'users.faculty_id must match faculty.id');

        // Check GET /api/faculty
        const facListRes2 = await call('GET', '/api/faculty?department=CME', null, cmeCookie);
        const aliceUpdated = facListRes2.body.faculty.find(f => f.name.toUpperCase() === 'DR. ALICE SMITH');
        assert.strictEqual(aliceUpdated.hasAccount, true, 'Alice Smith must now have hasAccount: true');
        assert.strictEqual(aliceUpdated.username, 'alice.smith');

        // Bob should still have hasAccount: false
        const bobUpdated = facListRes2.body.faculty.find(f => f.name.toUpperCase() === 'PROF. BOB JONES');
        assert.strictEqual(bobUpdated.hasAccount, false, 'Bob Jones must still have hasAccount: false');
        console.log('✓ PASS: Explicit Create Account successfully created user and updated hasAccount');

        console.log('\n--- Test 7: Duplicate account creation on already linked faculty returns HTTP 409 ---');
        const dupAccRes = await call('POST', `/api/faculty/${aliceFacId}/create-account`, {
            username: 'alice.second',
            password: 'Password_123',
            confirmPassword: 'Password_123'
        }, cmeCookie);
        assert.strictEqual(dupAccRes.status, 409, 'Duplicate account creation must return HTTP 409 ACCOUNT_EXISTS');
        console.log('✓ PASS: Duplicate account rejected with HTTP 409');

        console.log('\n--- Test 8: Timetable approval imports entries without creating extra accounts ---');
        // Ensure class and remaining subjects are registered
        await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, cmeCookie);

        const approveRes = await call('POST', `/api/staging/${uploadId}/approve`, {}, cmeCookie);
        assert.strictEqual(approveRes.status, 200, 'Approve timetable should succeed');
        assert(approveRes.body.success, 'Expected approve success');

        const ttCountRes = await pool.query('SELECT count(*)::int as count FROM timetable');
        assert(ttCountRes.rows[0].count > 0, 'Timetable entries must be imported');

        // Total faculty users in users table must STILL be exactly 1 (Alice only, none for Bob or others)
        const totalFacUsers = await pool.query("SELECT count(*)::int as count FROM users WHERE role = 'faculty'");
        assert.strictEqual(totalFacUsers.rows[0].count, 1, 'Timetable approval must not create extra faculty accounts');
        console.log(`✓ PASS: ${ttCountRes.rows[0].count} timetable rows imported without creating extra faculty accounts`);

        console.log('\n--- Test 9: Regular faculty permission check ---');
        const facLogin = await call('POST', '/api/auth/login', { username: 'alice.smith', password: 'Password_123' });
        assert.strictEqual(facLogin.status, 200, 'Alice login should succeed');
        const aliceCookie = facLogin.cookie;

        const facStagingAttempt = await call('POST', `/api/staging/${uploadId}/register-entity`, {
            entityType: 'faculty',
            extractedText: 'Hacker Faculty'
        }, aliceCookie);
        assert.strictEqual(facStagingAttempt.status, 403, 'Regular faculty cannot register entities in staging');

        const facApproveAttempt = await call('POST', `/api/staging/${uploadId}/approve`, {}, aliceCookie);
        assert.strictEqual(facApproveAttempt.status, 403, 'Regular faculty cannot approve timetables');
        console.log('✓ PASS: Regular faculty permissions strictly blocked with HTTP 403');

        console.log('\n======================================================');
        console.log('ALL 9 REGRESSION TESTS PASSED SUCCESSFULLY!');
        console.log('======================================================\n');

    } finally {
        await stopServer();
    }
}

run().catch(err => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
});
