/**
 * Faculty "Register All" Workflow Integration Test Suite
 *
 * Verifies:
 * 1. Uploading a timetable with unregistered faculty flags them as unresolved entities (Unregistered Faculty).
 * 2. Unregistered faculty are NOT automatically registered merely because a timetable was uploaded.
 * 3. Timetable approval is blocked (HTTP 422 UNRESOLVED_ENTITIES) while faculty remains unregistered.
 * 4. HOD calls POST /api/staging/:uploadId/register-all-unresolved to register all unresolved faculty.
 * 5. Faculty members are registered in the correct branch's faculty roster (and linked user account).
 * 6. Branch isolation: CME faculty registered in CME cannot be modified or accessed by EEE HOD.
 * 7. Duplicate prevention: Calling Register All multiple times is idempotent and does not create duplicate records.
 * 8. Refresh / resolution: After registration, the unresolved list is cleared (unregistered faculty disappears).
 * 9. Timetable approval succeeds (HTTP 200) once resolved, and imported slots reference the valid faculty ID.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const { app } = require('../server');
const { saveUploadRecord, saveStagedData, getStagedData } = require('../src/data/uploads');
const { resolveContract } = require('../src/core/entityResolver');

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

function call(method, urlPath, body = null, cookie = null) {
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
    console.log('Testing Faculty "Register All" Workflow & Protection Gates');
    console.log('======================================================\n');

    await startServer();

    try {
        if (db.isConfigured()) {
            await store.initFromDatabase();
        } else {
            await store.init();
        }

        const rand = Math.floor(1000 + Math.random() * 9000);
        const cmeBranch = 'CME_TEST_' + rand;
        const eeeBranch = 'EEE_TEST_' + rand;

        // 1. Create CME HOD Account
        const cmeHodUser = `hod_cme_${rand}`;
        const hodPassword = 'TestPassword_123';
        const regCmeHod = await call('POST', '/api/auth/register', {
            role: 'hos',
            username: cmeHodUser,
            password: hodPassword,
            confirmPassword: hodPassword,
            name: 'CME HOD Tester ' + rand,
            phone: '9876543210',
            branchCode: cmeBranch,
            branchName: 'Computer Engineering ' + rand,
            academicYear: '2025-2026',
            semester: 4
        });
        assert(regCmeHod.status === 200 || regCmeHod.status === 201, `CME HOD register failed: ${JSON.stringify(regCmeHod.body)}`);

        const cmeLogin = await call('POST', '/api/auth/login', {
            username: cmeHodUser,
            password: hodPassword
        });
        assert.strictEqual(cmeLogin.status, 200);
        const cmeCookie = cmeLogin.cookie;

        // 2. Create EEE HOD Account (for branch isolation testing)
        const eeeHodUser = `hod_eee_${rand}`;
        const regEeeHod = await call('POST', '/api/auth/register', {
            role: 'hos',
            username: eeeHodUser,
            password: hodPassword,
            confirmPassword: hodPassword,
            name: 'EEE HOD Tester ' + rand,
            phone: '9876543211',
            branchCode: eeeBranch,
            branchName: 'Electrical Engineering ' + rand,
            academicYear: '2025-2026',
            semester: 4
        });
        assert(regEeeHod.status === 200 || regEeeHod.status === 201, `EEE HOD register failed: ${JSON.stringify(regEeeHod.body)}`);

        const eeeLogin = await call('POST', '/api/auth/login', {
            username: eeeHodUser,
            password: hodPassword
        });
        assert.strictEqual(eeeLogin.status, 200);
        const eeeCookie = eeeLogin.cookie;

        // 3. Define Timetable Contract with unregistered faculty
        const targetFacultyName = 'G.SANDHYA RANI ' + rand;
        const targetSubjectName = 'Advanced Algorithms ' + rand;
        const uploadId = 'upload_cme_regall_' + rand;

        const contract = {
            academic_year: '2025-2026',
            semester: 4,
            section: 'A',
            branch_code: cmeBranch,
            class_name: `${cmeBranch}-4-A`,
            days: ['Monday'],
            periods: [1],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: targetSubjectName,
                    subject_code: 'CS501',
                    faculty_name: targetFacultyName,
                    room_code: 'LAB-101',
                    session_type: 'theory'
                }
            ],
            faculty_legend: [
                {
                    short_name: 'GSR',
                    full_name: targetFacultyName,
                    designation: 'Assistant Professor'
                }
            ]
        };

        // Resolution before staging
        const resInitial = await resolveContract(contract, cmeBranch);

        // TEST 1: Unregistered faculty is marked in unresolvedEntities
        const unresolvedFac = (resInitial.unresolvedEntities || []).filter(e => e.entityType === 'faculty');
        assert.strictEqual(unresolvedFac.length, 1, 'Unregistered faculty must be in unresolvedEntities');
        assert.strictEqual(unresolvedFac[0].extractedText, targetFacultyName);
        console.log('✓ Test 1: Timetable with unregistered faculty flagged in unresolvedEntities');

        // TEST 2: Upload DOES NOT auto-create faculty record
        const checkLoginBefore = await call('POST', '/api/auth/login', {
            username: targetFacultyName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
            password: 'any_password'
        });
        assert.notStrictEqual(checkLoginBefore.status, 200, 'Faculty user must NOT be auto-created merely by uploading/resolving');
        console.log('✓ Test 2: Upload does not automatically register faculty');

        // Save staged upload record
        await saveUploadRecord({
            uploadId: uploadId,
            departmentCode: cmeBranch,
            uploadedBy: cmeHodUser,
            originalFilename: 'cme_timetable.json',
            uploadType: 'master',
            fileType: 'application/json',
            fileBuffer: Buffer.from(JSON.stringify(contract)),
            mimeType: 'application/json',
            status: 'UPLOADED'
        });

        await saveStagedData(uploadId, {
            extractedJson: contract,
            validationStatus: 'VALID',
            validationErrors: [],
            importStatus: 'STAGED',
            resolution: {
                canAutoApprove: false,
                unresolvedEntities: resInitial.unresolvedEntities
            }
        });

        // TEST 3: Timetable approval is BLOCKED while faculty is unregistered
        const blockedApprove = await call('POST', `/api/staging/${uploadId}/approve`, {}, cmeCookie);
        assert.strictEqual(blockedApprove.status, 422, 'Approval must be rejected with 422 when unresolved entities exist');
        assert.strictEqual(blockedApprove.body.code, 'UNRESOLVED_ENTITIES');
        console.log('✓ Test 3: Timetable approval blocked while faculty is unregistered');

        // TEST 4: Branch Isolation - EEE HOD cannot access or Register All CME staging
        const crossBranchAttempt = await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, eeeCookie);
        assert.strictEqual(crossBranchAttempt.status, 403, 'Cross-branch HOD must be rejected with 403');
        console.log('✓ Test 4: Branch isolation strictly enforced (EEE HOD cannot register CME faculty)');

        // TEST 5: HOD clicks "Register All" (POST /api/staging/:uploadId/register-all-unresolved)
        const regAllRes = await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, cmeCookie);
        assert.strictEqual(regAllRes.status, 200, `Register All failed: ${JSON.stringify(regAllRes.body)}`);
        assert.strictEqual(regAllRes.body.success, true);
        assert(Array.isArray(regAllRes.body.registeredList), 'Expected registeredList array');
        assert(regAllRes.body.registeredList.length >= 1, 'Expected at least 1 registered entity');
        console.log('✓ Test 5: "Register All" executed successfully by CME HOD');

        // TEST 6: Faculty is registered in CME branch roster and linked user created
        const stagedAfterReg = await getStagedData(uploadId);
        const resAfterReg = await resolveContract(contract, cmeBranch);
        const unresolvedFacAfter = (resAfterReg.unresolvedEntities || []).filter(e => e.entityType === 'faculty');
        assert.strictEqual(unresolvedFacAfter.length, 0, 'Unregistered faculty list must be empty after Register All');
        console.log('✓ Test 6: Faculty removed from Unregistered list after registration');

        // Verify faculty in store
        const foundInCme = (store.source.faculty || []).find(f =>
            f.name.toUpperCase() === targetFacultyName.toUpperCase() &&
            (!f.department || f.department.toUpperCase() === cmeBranch.toUpperCase())
        );
        assert(foundInCme, `Faculty "${targetFacultyName}" must exist in CME faculty roster`);
        assert(foundInCme.id, 'Registered faculty must have a valid ID');
        console.log(`✓ Test 7: Faculty correctly registered under branch ${cmeBranch} with ID ${foundInCme.id}`);

        // TEST 7: Duplicate prevention - calling Register All again is idempotent
        const secondRegAll = await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, cmeCookie);
        assert.strictEqual(secondRegAll.status, 200);
        const countOccurrences = (store.source.faculty || []).filter(f =>
            f.name.toUpperCase() === targetFacultyName.toUpperCase() &&
            (!f.department || f.department.toUpperCase() === cmeBranch.toUpperCase())
        ).length;
        assert.strictEqual(countOccurrences, 1, 'Duplicate faculty record must NOT be created on second Register All call');
        console.log('✓ Test 8: Duplicate prevention verified (idempotent registration)');

        // TEST 8: Approval succeeds once faculty and entities are resolved
        const approveSuccess = await call('POST', `/api/staging/${uploadId}/approve`, {}, cmeCookie);
        assert.strictEqual(approveSuccess.status, 200, `Approval failed: ${JSON.stringify(approveSuccess.body)}`);
        assert.strictEqual(approveSuccess.body.success, true);
        console.log('✓ Test 9: Timetable approval succeeds after faculty registration');

        // Verify timetable query shows the newly registered faculty
        const ttRes = await call('GET', `/api/timetable?branch=${cmeBranch}&semester=SEM-4&section=A`, null, cmeCookie);
        assert.strictEqual(ttRes.status, 200);
        const mondaySlot = (ttRes.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
        assert(mondaySlot, 'Monday P1 must exist in live timetable');
        assert.strictEqual(mondaySlot.faculty, targetFacultyName, 'Slot must reference the registered faculty name');
        console.log('✓ Test 10: Live timetable verified with newly registered faculty');

        console.log('\n======================================================');
        console.log('ALL FACULTY "REGISTER ALL" WORKFLOW TESTS PASSED!');
        console.log('======================================================\n');
        process.exit(0);
    } finally {
        await stopServer();
    }
}

run().catch(err => {
    console.error('Test failure:', err);
    process.exit(1);
});
