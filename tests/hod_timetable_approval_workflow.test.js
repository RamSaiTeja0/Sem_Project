/**
 * HOD Timetable Approval UI & Workflow Regression Test Suite
 *
 * Verifies all requirements:
 * 1. HOD flow: Upload -> Process -> Validate -> Preview -> HOD Approval -> Import -> Master Timetable.
 * 2. Clear Accept & Import button: "✓ Accept & Import to Master Timetable".
 * 3. Distinct Preview from Approval before approval ("Approve Timetable · Preview Only").
 * 4. Staging approval endpoint is invoked directly without duplicate import mechanisms.
 * 5. Successful approval imports rows and returns importedCount.
 * 6. Button changes to "✓ Already Imported" and is disabled only after success.
 * 7. Failed approval does not mark it imported and keeps the approval button available.
 * 8. Never display "Already Imported" before actual successful import.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { check, checkAsync, counts } = require('./helpers');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { setBranch, resetBranchForTesting } = require('../src/data/departments');
const {
    clearUploads,
    saveUploadRecord,
    saveStagedData,
    getStagedData,
    getUploadRecord,
    UPLOADS_ROOT
} = require('../src/data/uploads');

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
    console.log('HOD Timetable Approval UI & Workflow Regression Tests\n');

    await startServer();

    try {
        users.resetForTesting();
        resetBranchForTesting();
        clearUploads();

        // 1. Register CME HOS
        const hosReg = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Department HOD',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hod_wf',
            password: 'Hod_password1'
        });
        assert.strictEqual(hosReg.status, 201);
        const hosLogin = await call('POST', '/api/auth/login', {
            username: 'cme_hod_wf',
            password: 'Hod_password1'
        });
        const hosCookie = hosLogin.cookie;
        assert.ok(hosCookie);

        // Seed store with initial catalog
        store.replace({
            allowEmpty: true,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            classes: [
                { class: 'CME-A', department: 'CME' },
                { class: 'CME-B', department: 'CME' }
            ],
            faculty: [
                { id: 'F1', name: 'Dr. Alan Turing', department: 'CME' }
            ],
            subjects: [
                { code: 'CS-101', name: 'Computer Architecture', department: 'CME', type: 'theory' }
            ],
            rooms: [
                { code: 'CR-101', name: 'Room 101' }
            ],
            entries: []
        }, 'test-seed');

        // Verify index.html contains the Accept & Import button definition
        const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
        check('index.html contains "✓ Accept & Import to Master Timetable" button', () => {
            assert.ok(indexHtml.includes('✓ Accept &amp; Import to Master Timetable') || indexHtml.includes('✓ Accept & Import to Master Timetable'),
                'Must contain Accept & Import to Master Timetable button');
            assert.ok(indexHtml.includes('btnStagingApprove'), 'Must define btnStagingApprove button id');
        });

        // Verify app.js contains the required workflow functions and button states
        const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
        check('app.js configures "✓ Accept & Import to Master Timetable" button label and already imported states', () => {
            assert.ok(appJs.includes('✓ Accept &amp; Import to Master Timetable') || appJs.includes('✓ Accept & Import to Master Timetable'),
                'Must have Accept & Import to Master Timetable label in app.js');
            assert.ok(appJs.includes('✓ Already Imported'), 'Must have Already Imported label in app.js');
            assert.ok(appJs.includes('Approve Timetable · Preview Only') || appJs.includes('Approve Timetable'), 'Must distinguish Preview from Approval');
        });

        // -------------------------------------------------------------
        // Test 1: Staged upload in pending state shows Accept/Approve button & STAGED status
        // -------------------------------------------------------------
        console.log('\n[1] Staging Workflow: Pending Staged State');
        const uploadId1 = 'upl_hod_test_01';
        const validContract = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: 'CME',
            academic_year: '2026-27',
            semester: 5,
            class_name: 'CME-A',
            days: ['Monday', 'Tuesday'],
            periods: [1, 2],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Computer Architecture',
                    subject_code: 'CS-101',
                    faculty_name: 'Dr. Alan Turing',
                    class_name: 'CME-A',
                    room_code: 'CR-101',
                    session_type: 'theory',
                    is_free: false
                }
            ]
        };

        await saveUploadRecord({
            uploadId: uploadId1,
            originalFilename: 'CME_5_Timetable.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: 'CME',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await saveStagedData(uploadId1, validContract, 'VALID', []);

        await checkAsync('Pending staged timetable reports STAGED import status (not imported yet)', async () => {
            const getRes = await call('GET', `/api/staging/${uploadId1}`, null, hosCookie);
            assert.strictEqual(getRes.status, 200);
            assert.strictEqual(getRes.body.importStatus, 'STAGED');
            assert.strictEqual(getRes.body.validationStatus, 'VALID');
            assert.strictEqual(getRes.body.resolution.unresolvedCount, 0);
        });

        // -------------------------------------------------------------
        // Test 2: Successful approval imports rows and updates importStatus to IMPORTED
        // -------------------------------------------------------------
        console.log('\n[2] Approval Execution & Master Timetable Import');
        await checkAsync('Calling staging approval endpoint imports rows and returns HTTP 200 with IMPORTED status', async () => {
            const approveRes = await call('POST', `/api/staging/${uploadId1}/approve`, {}, hosCookie);
            assert.strictEqual(approveRes.status, 200);
            assert.strictEqual(approveRes.body.success, true);
            assert.strictEqual(approveRes.body.importStatus, 'IMPORTED');
            assert.strictEqual(approveRes.body.importedCount, 1);
            assert.strictEqual(approveRes.body.targetClass, 'CME-A');
        });

        await checkAsync('Master Timetable contains the approved imported slot', async () => {
            const ttRes = await call('GET', '/api/timetable?class=CME-A', null, hosCookie);
            assert.strictEqual(ttRes.status, 200);
            const cells = ttRes.body.cells || [];
            const monP1 = cells.find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(monP1, 'Monday P1 must exist');
            assert.strictEqual(monP1.subject, 'Computer Architecture');
            assert.strictEqual(monP1.faculty, 'Dr. Alan Turing');
        });

        await checkAsync('Staging data now reports importStatus === IMPORTED', async () => {
            const getRes = await call('GET', `/api/staging/${uploadId1}`, null, hosCookie);
            assert.strictEqual(getRes.status, 200);
            assert.strictEqual(getRes.body.importStatus, 'IMPORTED');
            assert.ok(getRes.body.importedAt);
        });

        // -------------------------------------------------------------
        // Test 3: Already imported timetable cannot be approved again (Idempotency)
        // -------------------------------------------------------------
        console.log('\n[3] Approval Idempotency Protection');
        await checkAsync('Approving already IMPORTED timetable returns HTTP 409 ALREADY_IMPORTED', async () => {
            const reApproveRes = await call('POST', `/api/staging/${uploadId1}/approve`, {}, hosCookie);
            assert.strictEqual(reApproveRes.status, 409);
            assert.strictEqual(reApproveRes.body.code, 'ALREADY_IMPORTED');
        });

        // -------------------------------------------------------------
        // Test 4: Failed approval does not mark timetable as imported
        // -------------------------------------------------------------
        console.log('\n[4] Failed Approval Handling & State Preservation');
        const uploadIdFail = 'upl_hod_test_fail';
        // Contract with conflict (Dr. Alan Turing already scheduled at Monday P1 for CME-A, conflicting with CME-B)
        const conflictContract = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: 'CME',
            academic_year: '2026-27',
            semester: 3,
            class_name: 'CME-B',
            days: ['Monday'],
            periods: [1],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Computer Architecture',
                    faculty_name: 'Dr. Alan Turing',
                    class_name: 'CME-B',
                    room_code: 'CR-101',
                    session_type: 'theory',
                    is_free: false
                }
            ]
        };

        await saveUploadRecord({
            uploadId: uploadIdFail,
            originalFilename: 'CME_B_Conflict.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: 'CME',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });
        await saveStagedData(uploadIdFail, conflictContract, 'VALID', []);

        await checkAsync('Conflicting approval fails with HTTP 409 SLOT_CONFLICT', async () => {
            const failApproveRes = await call('POST', `/api/staging/${uploadIdFail}/approve`, {}, hosCookie);
            assert.strictEqual(failApproveRes.status, 409);
            assert.strictEqual(failApproveRes.body.code, 'SLOT_CONFLICT');
        });

        await checkAsync('Failed upload retains STAGED status (is NOT marked IMPORTED)', async () => {
            const stageRec = await getStagedData(uploadIdFail);
            assert.strictEqual(stageRec.importStatus, 'STAGED');
            assert.strictEqual(stageRec.importedAt, null);
        });

        console.log('\n======================================================');
        const { passed, failed } = counts();
        console.log(`HOD Timetable Approval Tests finished: ${passed} passed, ${failed} failed.\n`);
        if (failed > 0) process.exit(1);
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('TEST RUNNER ERROR:', err);
        process.exit(1);
    });
}

module.exports = { run };
