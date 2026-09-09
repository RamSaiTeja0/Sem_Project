/**
 * Phase B2.3 Manual & Live Verification Script
 *
 * Verifies all 10 items required by Phase B2.3:
 *  1. Existing HOS login still works.
 *  2. Existing Faculty login still works.
 *  3. Existing B1 upload still works.
 *  4. Internal API rejects missing secret.
 *  5. Internal API accepts valid secret.
 *  6. A valid upload can transition to PROCESSING.
 *  7. Valid test JSON can be staged.
 *  8. Invalid JSON is rejected.
 *  9. Existing timetable data is NOT modified by this phase.
 * 10. Direct /uploads/... access remains blocked.
 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { app } = require('../server');
const config = require('../src/config');
const store = require('../src/data/store');
const { getStagedData, clearUploads, UPLOADS_ROOT } = require('../src/data/uploads');

const TEST_SECRET = 'live_verify_secret_b23';
process.env.INTERNAL_API_SECRET = TEST_SECRET;
config.internalApiSecret = TEST_SECRET;

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

function request(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = { ...headers };
        if (payload) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers: reqHeaders }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                const setCookie = (res.headers['set-cookie'] || [])[0];
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

function uploadFile(urlPath, filename, buffer, cookie, mime = 'application/pdf') {
    return new Promise((resolve, reject) => {
        const boundary = '----liveverify' + Date.now();
        const parts = [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="timetable"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
            buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ];
        const payload = Buffer.concat(parts);
        const req = http.request(`${baseUrl}${urlPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': payload.length,
                ...(cookie ? { 'Cookie': cookie } : {})
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('=== STARTING PHASE B2.3 LIVE VERIFICATION ===\n');
    await startServer();

    try {
        clearUploads();

        // 1. Initial State & Live Timetable Snapshot
        const initialLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
        console.log(`Initial live timetable entries count: ${initialLiveCount}`);

        // 1. Existing HOS login still works
        console.log('\n--- 1. Testing HOS Registration & Login ---');
        const regHOS = await request('POST', '/api/auth/register', {
            role: 'hos',
            phone: '9876543210',
            username: 'b23_hos',
            password: 'Hos_password123',
            name: 'Dr. B23 HOS',
            branchCode: 'CME',
            branchName: 'Computer Engineering'
        });
        assert.strictEqual(regHOS.status, 201, 'HOS registration should succeed');
        const hosCookie = regHOS.cookie;
        console.log('PASS: 1. Existing HOS registration/login works');

        // 2. Existing Faculty login still works
        console.log('\n--- 2. Testing Faculty Creation & Login ---');
        const createFac = await request('POST', '/api/auth/register', {
            role: 'faculty',
            facultyId: 'FAC_B23_01',
            name: 'Prof. B23 Faculty',
            username: 'b23_faculty',
            password: 'Faculty_pass123',
            phone: '9876543211',
            department: 'CME',
            subjects: ['Python Programming']
        }, { 'Cookie': hosCookie });
        assert.strictEqual(createFac.status, 201, 'Faculty creation should succeed');

        const facLogin = await request('POST', '/api/auth/login', {
            username: 'b23_faculty',
            password: 'Faculty_pass123'
        });
        assert.strictEqual(facLogin.status, 200, 'Faculty login should succeed');
        const facCookie = facLogin.cookie;
        console.log('PASS: 2. Existing Faculty login works');

        // 3. Existing B1 upload still works
        console.log('\n--- 3. Testing Existing B1 Upload ---');
        const samplePdf = Buffer.from('%PDF-1.4 dummy live verification timetable');
        const uploadRes = await uploadFile('/api/uploads/master-timetable', 'Master_TT.pdf', samplePdf, hosCookie);
        assert.strictEqual(uploadRes.status, 201, 'B1 upload should return 201');
        assert.strictEqual(uploadRes.body.success, true);
        assert.strictEqual(uploadRes.body.status, 'UPLOADED');
        const uploadId = uploadRes.body.uploadId;
        console.log(`PASS: 3. Existing B1 upload works (Created uploadId: ${uploadId})`);

        // 4. Internal API rejects missing secret
        console.log('\n--- 4. Testing Internal API Secret Rejection (Missing) ---');
        const noSecretRes = await request('GET', `/api/internal/uploads/${uploadId}`);
        assert.strictEqual(noSecretRes.status, 401);
        assert.strictEqual(noSecretRes.body.code, 'UNAUTHORIZED');
        console.log('PASS: 4. Internal API rejects missing secret with HTTP 401');

        // 5. Internal API accepts valid secret
        console.log('\n--- 5. Testing Internal API Secret Acceptance ---');
        const validSecretRes = await request('GET', `/api/internal/uploads/${uploadId}`, null, {
            'X-Internal-Secret': TEST_SECRET
        });
        assert.strictEqual(validSecretRes.status, 200);
        assert.strictEqual(validSecretRes.body.uploadId, uploadId);
        assert.strictEqual(validSecretRes.body.status, 'UPLOADED');
        console.log('PASS: 5. Internal API accepts valid secret (HTTP 200)');

        // 6. A valid upload can transition to PROCESSING
        console.log('\n--- 6. Testing Status Transition to PROCESSING ---');
        const transRes = await request('POST', `/api/internal/uploads/${uploadId}/status`, {
            status: 'PROCESSING'
        }, { 'X-Internal-Secret': TEST_SECRET });
        assert.strictEqual(transRes.status, 200);
        assert.strictEqual(transRes.body.status, 'PROCESSING');
        console.log('PASS: 6. Valid upload transitions to PROCESSING (HTTP 200)');

        // 7. Valid test JSON can be staged
        console.log('\n--- 7. Testing Valid JSON Staging ---');
        const validPayload = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: 'CME',
            academic_year: '2026-27',
            semester: 5,
            class_name: 'CME-A',
            days: ['Monday', 'Tuesday', 'Wednesday'],
            periods: [1, 2, 3],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Python Programming',
                    faculty_name: 'Prof. B23 Faculty',
                    class_name: 'CME-A',
                    room_code: 'C-401',
                    session_type: 'theory',
                    is_free: false
                }
            ]
        };

        const stageRes = await request('POST', `/api/internal/uploads/${uploadId}/processed`, {
            uploadId,
            extractedData: validPayload
        }, { 'X-Internal-Secret': TEST_SECRET });
        assert.strictEqual(stageRes.status, 200, 'Valid JSON should be accepted and staged');
        assert.strictEqual(stageRes.body.status, 'PROCESSED');
        assert.strictEqual(stageRes.body.staged, true);

        const stagedRecord = await getStagedData(uploadId);
        assert.ok(stagedRecord, 'Staged data must be retrievable');
        assert.strictEqual(stagedRecord.validationStatus, 'VALID');
        console.log('PASS: 7. Valid test JSON is staged and upload marked PROCESSED');

        // 8. Invalid JSON is rejected
        console.log('\n--- 8. Testing Invalid JSON Rejection ---');
        // Create second upload for testing invalid payload
        const upload2Res = await uploadFile('/api/uploads/master-timetable', 'Master2.pdf', samplePdf, hosCookie);
        const uploadId2 = upload2Res.body.uploadId;

        const invalidRes = await request('POST', `/api/internal/uploads/${uploadId2}/processed`, {
            uploadId: uploadId2,
            extractedData: {
                contract_version: '2.1',
                timetable_type: 'MASTER_TIMETABLE',
                department_code: 'WRONG_DEPT', // Branch mismatch
                days: ['Monday'],
                periods: [1],
                entries: []
            }
        }, { 'X-Internal-Secret': TEST_SECRET });
        assert.strictEqual(invalidRes.status, 422, 'Invalid JSON should be rejected with 422');
        console.log(`PASS: 8. Invalid JSON rejected with HTTP 422 (code: ${invalidRes.body.code})`);

        // 9. Existing timetable data is NOT modified by this phase
        console.log('\n--- 9. Verifying Live Timetable Data Unchanged ---');
        const finalLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
        assert.strictEqual(finalLiveCount, initialLiveCount, 'Live timetable entries count must remain identical');
        console.log(`PASS: 9. Existing timetable entries untouched (Count: ${finalLiveCount})`);

        // 10. Direct /uploads/... access remains blocked
        console.log('\n--- 10. Verifying Direct /uploads Access Remains Blocked ---');
        const directUploadRes = await request('GET', `/uploads/timetables/${uploadId}.pdf`);
        assert.strictEqual(directUploadUploadBlockCheck(directUploadRes.status), true);
        console.log(`PASS: 10. Direct /uploads/... access returns HTTP ${directUploadRes.status} (Blocked)`);

        console.log('\n======================================================');
        console.log('ALL 10 PHASE B2.3 LIVE VERIFICATION CHECKS PASSED!');
        console.log('======================================================\n');
    } finally {
        clearUploads();
        await stopServer();
    }
}

function directUploadUploadBlockCheck(status) {
    return status === 404 || status === 403;
}

if (require.main === module) {
    run().catch(err => {
        console.error('LIVE VERIFY ERROR:', err);
        process.exit(1);
    });
}

module.exports = { run };
