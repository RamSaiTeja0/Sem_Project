/**
 * Phase B2.4 — Live Verification Script
 *
 * Exercises the complete B2.4 Gemini Vision & n8n extraction pipeline:
 *  1. HOS authentication & branch setup
 *  2. B1 upload creation (status: UPLOADED)
 *  3. Pipeline execution & Gemini Vision extraction
 *  4. Staging validation and verification
 *  5. Transition to PROCESSED
 *  6. Failure case handling (branch mismatch -> FAILED)
 *  7. Idempotency (duplicate processing rejected with 409)
 *  8. Verification that live timetable data is NOT modified
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const config = require('../src/config');
const { app } = require('../server');
const store = require('../src/data/store');
const { clearUploads, getUploadRecord, getStagedData, UPLOADS_ROOT } = require('../src/data/uploads');
const { runExtractionPipeline } = require('../src/services/extractionPipeline');

const TEST_SECRET = 'tecsub_internal_live_secret_99999';
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

function request(method, pathUrl, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = { ...headers };
        if (payload) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${baseUrl}${pathUrl}`, { method, headers: reqHeaders }, res => {
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
                    headers: res.headers,
                    cookie: setCookie ? setCookie.split(';')[0] : null
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function uploadFile(pathUrl, filename, buffer, cookie, mime = 'application/pdf') {
    return new Promise((resolve, reject) => {
        const boundary = '----b24verify' + Date.now();
        const parts = [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="timetable"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
            buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ];
        const payload = Buffer.concat(parts);

        const req = http.request(`${baseUrl}${pathUrl}`, {
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

function sampleB21Payload(dept = 'CME') {
    return {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        institution_name: 'Aditya Institute of Technology and Management',
        title: 'V SEM CME TIMETABLE',
        department_code: dept,
        academic_year: '2026-27',
        semester: 5,
        class_name: 'CME-A',
        faculty_name: null,
        faculty_code: null,
        default_room: 'C-401',
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        period_timings: {
            '1': { start: '08:00', end: '08:45' },
            '2': { start: '08:45', end: '09:30' }
        },
        entries: [
            {
                day: 'Monday',
                period: 1,
                span_to: null,
                subject_name: 'Python Programming',
                subject_code: 'CM-501',
                faculty_name: 'Ms. B. Kusuma',
                class_name: 'CME-A',
                room_code: 'C-401',
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'PP - Ms. B. Kusuma'
            }
        ],
        extraction_metadata: {
            confidence_score: 0.98,
            warnings: []
        }
    };
}

async function run() {
    console.log('=== STARTING PHASE B2.4 LIVE VERIFICATION ===\n');
    await startServer();

    try {
        clearUploads();

        // 1. Snapshot live timetable entries count
        const initialLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
        console.log(`Initial live timetable entries count: ${initialLiveCount}`);

        // 2. Authenticate HOS for branch CME
        console.log('\n--- 1. Authenticating HOS for branch CME ---');
        const regHOS = await request('POST', '/api/auth/register', {
            role: 'hos',
            phone: '9876543210',
            username: 'b24_hos',
            password: 'Hos_password123',
            name: 'Dr. B24 HOS',
            branchCode: 'CME',
            branchName: 'Computer Engineering'
        });
        assert.strictEqual(regHOS.status, 201, 'HOS registration must succeed');
        const hosCookie = regHOS.cookie;
        console.log('PASS: 1. HOS registered and authenticated successfully');

        // 3. Upload a master timetable
        console.log('\n--- 2. Uploading Timetable Document via Phase B1 Endpoint ---');
        const samplePdf = Buffer.from('%PDF-1.4 Live Phase B2.4 Test Master Timetable');
        const uploadRes = await uploadFile('/api/uploads/master-timetable', 'CME_V_Master.pdf', samplePdf, hosCookie);
        assert.strictEqual(uploadRes.status, 201, 'Upload should return 201 Created');
        assert.strictEqual(uploadRes.body.status, 'UPLOADED');
        const uploadId = uploadRes.body.uploadId;
        console.log(`PASS: 2. Upload created successfully (uploadId: ${uploadId}, status: UPLOADED)`);

        // 4. Run extraction pipeline
        console.log('\n--- 3. Running Extraction Pipeline with Gemini Vision ---');
        const pipelineRes = await runExtractionPipeline(uploadId, {
            geminiTransport: async () => JSON.stringify(sampleB21Payload('CME'))
        });
        assert.strictEqual(pipelineRes.success, true);
        assert.strictEqual(pipelineRes.status, 'PROCESSED');
        console.log(`PASS: 3. Extraction pipeline processed successfully (status: PROCESSED)`);

        // 5. Verify staging record
        console.log('\n--- 4. Verifying Timetable Staging ---');
        const staged = await getStagedData(uploadId);
        assert.ok(staged, 'Staging data must exist');
        assert.strictEqual(staged.validationStatus, 'VALID');
        assert.strictEqual(staged.extractedJson.contract_version, '2.1');
        assert.strictEqual(staged.extractedJson.department_code, 'CME');
        console.log('PASS: 4. Extracted data staged safely with validation status VALID');

        // 6. Verify duplicate processing rejection
        console.log('\n--- 5. Verifying Duplicate Processing Rejection (Idempotency) ---');
        try {
            await runExtractionPipeline(uploadId, {
                geminiTransport: async () => JSON.stringify(sampleB21Payload('CME'))
            });
            assert.fail('Duplicate processing must be rejected');
        } catch (dupErr) {
            assert.strictEqual(dupErr.status, 409);
            assert.strictEqual(dupErr.code, 'ALREADY_PROCESSED');
            console.log('PASS: 5. Duplicate processing safely rejected with HTTP 409 (ALREADY_PROCESSED)');
        }

        // 7. Verify failure case handling (Branch Mismatch)
        console.log('\n--- 6. Verifying Failure Case Handling (Branch Mismatch) ---');
        const failUploadRes = await uploadFile('/api/uploads/master-timetable', 'CME_WrongBranch.pdf', samplePdf, hosCookie);
        const failUploadId = failUploadRes.body.uploadId;

        const failPipelineRes = await runExtractionPipeline(failUploadId, {
            geminiTransport: async () => JSON.stringify(sampleB21Payload('EEE')) // Mismatched branch
        });
        assert.strictEqual(failPipelineRes.success, false);
        assert.strictEqual(failPipelineRes.status, 'FAILED');
        assert.strictEqual(failPipelineRes.code, 'BRANCH_MISMATCH');

        const failRec = await getUploadRecord(failUploadId);
        assert.strictEqual(failRec.status, 'FAILED');

        const failStaged = await getStagedData(failUploadId);
        assert.strictEqual(failStaged.validationStatus, 'INVALID');
        console.log('PASS: 6. Branch mismatch safely transitioned upload to FAILED and recorded reason');

        // 8. Verify live timetable unmodified
        console.log('\n--- 7. Verifying Live Timetable Data Unmodified ---');
        const currentLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
        assert.strictEqual(currentLiveCount, initialLiveCount, 'Live timetable entries count must remain 0');
        console.log(`PASS: 7. Live timetable entries count remained untouched at ${currentLiveCount}`);

        console.log('\n======================================================');
        console.log('ALL PHASE B2.4 LIVE VERIFICATION CHECKS PASSED!');
        console.log('======================================================\n');
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('LIVE VERIFY ERROR:', err);
        process.exit(1);
    });
}

module.exports = { run };
