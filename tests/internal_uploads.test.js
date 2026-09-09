/**
 * Phase B2.3 — Internal Uploads & n8n Integration Tests
 *
 * Verifies:
 *  1. Internal API rejects missing secret (401).
 *  2. Internal API rejects incorrect secret (401).
 *  3. Valid secret allows authorized internal request.
 *  4. Unknown uploadId returns 404.
 *  5. File retrieval only works for valid uploadId.
 *  6. Arbitrary filesystem path cannot be requested.
 *  7. UPLOADED -> PROCESSING works.
 *  8. Invalid status transition is rejected (409).
 *  9. Valid processed JSON is accepted (200, status marked PROCESSED).
 * 10. Invalid JSON is rejected (422).
 * 11. Missing required fields are rejected (422).
 * 12. Invalid day is rejected (422).
 * 13. Invalid period is rejected (422).
 * 14. Branch mismatch is rejected (422).
 * 15. Faculty mismatch is rejected (422).
 * 16. MASTER upload cannot become FACULTY upload (422).
 * 17. FACULTY upload cannot become MASTER upload (422).
 * 18. Valid extracted JSON is staged without altering live timetable.
 * 19. Duplicate processing is handled safely (409).
 * 20. Failure endpoint marks upload as FAILED.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { check, checkAsync, counts } = require('./helpers');
const config = require('../src/config');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting } = require('../src/data/departments');
const {
    clearUploads,
    saveUploadRecord,
    getUploadRecord,
    getStagedData,
    UPLOADS_ROOT
} = require('../src/data/uploads');

const TEST_SECRET = 'tecsub_internal_test_secret_12345';
// Set in config/env for test run
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

function callInternal(method, urlPath, body, secret = TEST_SECRET) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (secret !== null && secret !== undefined) {
            headers['X-Internal-Secret'] = secret;
        }

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    raw: data,
                    headers: res.headers
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('TecSubstitution — Phase B2.3 Internal Upload Integration Tests\n');

    await startServer();

    try {
        clearUploads();
        resetBranchForTesting();

        // Register testing test branch CME
        const { setBranch } = require('../src/data/departments');
        setBranch({ code: 'CME', name: 'Computer Engineering' });

        // Create sample dummy file on disk in UPLOADS_ROOT
        if (!fs.existsSync(UPLOADS_ROOT)) {
            fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
        }
        const sampleFilePath = path.join(UPLOADS_ROOT, 'test_sample_doc.pdf');
        fs.writeFileSync(sampleFilePath, '%PDF-1.4 dummy pdf content for testing');

        // Create testing master upload record
        const masterRecord = await saveUploadRecord({
            uploadId: 'upl_test_master_101',
            originalFilename: 'CME_V_Sem.pdf',
            fileType: 'application/pdf',
            fileSize: 38,
            storagePath: sampleFilePath,
            uploaderUserId: '1',
            facultyId: null,
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        // Create testing faculty upload record
        const facultyRecord = await saveUploadRecord({
            uploadId: 'upl_test_faculty_202',
            originalFilename: 'Kusuma_Faculty_TT.pdf',
            fileType: 'application/pdf',
            fileSize: 38,
            storagePath: sampleFilePath,
            uploaderUserId: '5',
            facultyId: 'Ms. B. Kusuma',
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'FACULTY_TIMETABLE',
            status: 'UPLOADED'
        });

        // Initial live timetable count
        const initialLiveEntriesCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);

        // 1. Internal API rejects missing secret
        console.log('[1] Internal Service-to-Service Authentication');
        const noSecretRes = await callInternal('GET', '/api/internal/uploads/upl_test_master_101', null, null);
        check('Internal API rejects missing secret with HTTP 401', () => {
            assert.strictEqual(noSecretRes.status, 401);
            assert.strictEqual(noSecretRes.body.code, 'UNAUTHORIZED');
        });

        // 2. Internal API rejects incorrect secret
        const wrongSecretRes = await callInternal('GET', '/api/internal/uploads/upl_test_master_101', null, 'wrong-secret');
        check('Internal API rejects incorrect secret with HTTP 401', () => {
            assert.strictEqual(wrongSecretRes.status, 401);
            assert.strictEqual(wrongSecretRes.body.code, 'UNAUTHORIZED');
        });

        // 3. Valid secret allows authorized internal request
        const validRes = await callInternal('GET', '/api/internal/uploads/upl_test_master_101');
        check('Valid secret allows authorized internal request (HTTP 200)', () => {
            assert.strictEqual(validRes.status, 200);
            assert.strictEqual(validRes.body.uploadId, 'upl_test_master_101');
            assert.strictEqual(validRes.body.departmentCode, 'CME');
            assert.strictEqual(validRes.body.uploadType, 'MASTER_TIMETABLE');
        });

        // 4. Unknown uploadId returns 404
        console.log('\n[2] Upload Lookup & Ownership');
        const notFoundRes = await callInternal('GET', '/api/internal/uploads/upl_non_existent_999');
        check('Unknown uploadId returns HTTP 404', () => {
            assert.strictEqual(notFoundRes.status, 404);
            assert.strictEqual(notFoundRes.body.code, 'NOT_FOUND');
        });

        // 5. File retrieval only works for valid uploadId
        console.log('\n[3] Secure File Retrieval');
        const fileRes = await callInternal('GET', '/api/internal/uploads/upl_test_master_101/file');
        check('File retrieval returns correct file stream for valid uploadId', () => {
            assert.strictEqual(fileRes.status, 200);
            assert.strictEqual(fileRes.headers['content-type'], 'application/pdf');
            assert.strictEqual(fileRes.raw, '%PDF-1.4 dummy pdf content for testing');
        });

        // 6. Arbitrary filesystem path cannot be requested / path traversal check
        const badFileRes = await callInternal('GET', '/api/internal/uploads/../../etc/passwd/file');
        check('Path traversal attempts are rejected', () => {
            assert.ok(badFileRes.status === 404 || badFileRes.status === 403);
        });

        // 7. Status transition: UPLOADED -> PROCESSING works
        console.log('\n[4] Status State Machine & Transitions');
        const toProcRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/status', {
            status: 'PROCESSING'
        });
        check('UPLOADED -> PROCESSING transition succeeds (HTTP 200)', () => {
            assert.strictEqual(toProcRes.status, 200);
            assert.strictEqual(toProcRes.body.status, 'PROCESSING');
        });

        const recordAfterProc = await getUploadRecord('upl_test_master_101');
        assert.strictEqual(recordAfterProc.status, 'PROCESSING');

        // 8. Invalid status transition is rejected
        const invalidTransRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/status', {
            status: 'UPLOADED'
        });
        check('Invalid transition PROCESSING -> UPLOADED is rejected (HTTP 409)', () => {
            assert.strictEqual(invalidTransRes.status, 409);
            assert.strictEqual(invalidTransRes.body.code, 'INVALID_STATUS_TRANSITION');
        });

        // Base valid B2.1 payload for Master Timetable
        const validMasterPayload = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: 'CME',
            academic_year: '2026-27',
            semester: 5,
            class_name: 'CME-A',
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    span_to: 2,
                    subject_name: 'Python Programming',
                    subject_code: 'CM-505',
                    faculty_name: 'Ms. B. Kusuma',
                    class_name: 'CME-A',
                    room_code: 'C-401',
                    session_type: 'theory',
                    is_free: false
                },
                {
                    day: 'Monday',
                    period: 3,
                    subject_name: 'Library',
                    session_type: 'activity',
                    class_name: 'CME-A',
                    is_free: false
                }
            ]
        };

        // 10. Invalid JSON structure is rejected (422)
        console.log('\n[5] Contract Validation & Negative Constraints');
        const invalidJsonRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: 'not an object'
        });
        check('Invalid JSON structure rejected with HTTP 422', () => {
            assert.strictEqual(invalidJsonRes.status, 422);
            assert.strictEqual(invalidJsonRes.body.code, 'INVALID_JSON_STRUCTURE');
        });

        // 11. Missing required fields are rejected (422)
        const missingFieldsRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: {
                contract_version: '2.1',
                timetable_type: 'MASTER_TIMETABLE'
                // missing department_code, days, periods, entries
            }
        });
        check('Missing required fields rejected with HTTP 422', () => {
            assert.strictEqual(missingFieldsRes.status, 422);
            assert.ok(missingFieldsRes.body.details.errors.length > 0);
        });

        // 12. Invalid day is rejected (422)
        const badDayPayload = JSON.parse(JSON.stringify(validMasterPayload));
        badDayPayload.entries[0].day = 'Funday';
        const badDayRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: badDayPayload
        });
        check('Invalid day rejected with HTTP 422 INVALID_DAY', () => {
            assert.strictEqual(badDayRes.status, 422);
            assert.strictEqual(badDayRes.body.code, 'INVALID_DAY');
        });

        // 13. Invalid period is rejected (422)
        const badPeriodPayload = JSON.parse(JSON.stringify(validMasterPayload));
        badPeriodPayload.entries[0].period = 15; // outside 1..12
        const badPeriodRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: badPeriodPayload
        });
        check('Invalid period outside 1..12 rejected with HTTP 422 INVALID_PERIOD', () => {
            assert.strictEqual(badPeriodRes.status, 422);
            assert.strictEqual(badPeriodRes.body.code, 'INVALID_PERIOD');
        });

        // 14. Branch mismatch is rejected (422 BRANCH_MISMATCH)
        console.log('\n[6] Authoritative Ownership Enforcement');
        const branchMismatchPayload = JSON.parse(JSON.stringify(validMasterPayload));
        branchMismatchPayload.department_code = 'EEE'; // Upload is CME!
        const branchMismatchRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: branchMismatchPayload
        });
        check('Branch mismatch rejected with HTTP 422 BRANCH_MISMATCH', () => {
            assert.strictEqual(branchMismatchRes.status, 422);
            assert.strictEqual(branchMismatchRes.body.code, 'BRANCH_MISMATCH');
        });

        // 16. MASTER upload cannot become FACULTY upload (422 TIMETABLE_TYPE_MISMATCH)
        const typeMismatchPayload = JSON.parse(JSON.stringify(validMasterPayload));
        typeMismatchPayload.timetable_type = 'FACULTY_TIMETABLE';
        const typeMismatchRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: typeMismatchPayload
        });
        check('Master upload claimed as faculty upload rejected with 422 TIMETABLE_TYPE_MISMATCH', () => {
            assert.strictEqual(typeMismatchRes.status, 422);
            assert.strictEqual(typeMismatchRes.body.code, 'TIMETABLE_TYPE_MISMATCH');
        });

        // Reset upl_test_master_101 to PROCESSING for valid commit test
        await callInternal('POST', '/api/internal/uploads/upl_test_master_101/status', { status: 'PROCESSING' });

        // 9. Valid processed JSON is accepted (200, status marked PROCESSED)
        console.log('\n[7] Staging & Status Completion');
        const processSuccessRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            uploadId: 'upl_test_master_101',
            extractedData: validMasterPayload
        });
        check('Valid processed JSON accepted with HTTP 200 and status marked PROCESSED', () => {
            assert.strictEqual(processSuccessRes.status, 200, JSON.stringify(processSuccessRes.body));
            assert.strictEqual(processSuccessRes.body.success, true);
            assert.strictEqual(processSuccessRes.body.status, 'PROCESSED');
            assert.strictEqual(processSuccessRes.body.staged, true);
        });

        // 18. Valid extracted JSON is staged without altering live timetable
        const stagedRecord = await getStagedData('upl_test_master_101');
        check('Extracted JSON is safely staged and retrievable', () => {
            assert.ok(stagedRecord, 'Staging record must exist');
            assert.strictEqual(stagedRecord.validationStatus, 'VALID');
            assert.strictEqual(stagedRecord.extractedJson.class_name, 'CME-A');
        });

        const currentLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
        check('Live timetable records remain completely untouched (NOT committed)', () => {
            assert.strictEqual(currentLiveCount, initialLiveEntriesCount);
        });

        // 19. Duplicate processing is handled safely (409 ALREADY_PROCESSED)
        const duplicateRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/processed', {
            extractedData: validMasterPayload
        });
        check('Duplicate processing rejected with HTTP 409 ALREADY_PROCESSED', () => {
            assert.strictEqual(duplicateRes.status, 409);
            assert.strictEqual(duplicateRes.body.code, 'ALREADY_PROCESSED');
        });

        // 8b. Cannot transition PROCESSED -> PROCESSING
        const procToProcRes = await callInternal('POST', '/api/internal/uploads/upl_test_master_101/status', {
            status: 'PROCESSING'
        });
        check('PROCESSED upload cannot transition back to PROCESSING (HTTP 409)', () => {
            assert.strictEqual(procToProcRes.status, 409);
            assert.strictEqual(procToProcRes.body.code, 'ALREADY_PROCESSED');
        });

        // Testing Faculty Upload
        console.log('\n[8] Faculty Timetable Ownership & Authority');
        const validFacultyPayload = {
            contract_version: '2.1',
            timetable_type: 'FACULTY_TIMETABLE',
            department_code: 'CME',
            faculty_name: 'Ms. B. Kusuma',
            days: ['Monday', 'Tuesday', 'Wednesday'],
            periods: [1, 2, 3],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Python Programming',
                    class_name: 'CME-A',
                    session_type: 'theory',
                    is_free: false
                }
            ]
        };

        // 15. Faculty mismatch is rejected (422 FACULTY_MISMATCH)
        const facultyMismatchPayload = JSON.parse(JSON.stringify(validFacultyPayload));
        facultyMismatchPayload.faculty_name = 'Dr. A. Sharma'; // upload is for Ms. B. Kusuma
        const facultyMismatchRes = await callInternal('POST', '/api/internal/uploads/upl_test_faculty_202/processed', {
            extractedData: facultyMismatchPayload
        });
        check('Faculty mismatch rejected with HTTP 422 FACULTY_MISMATCH', () => {
            assert.strictEqual(facultyMismatchRes.status, 422);
            assert.strictEqual(facultyMismatchRes.body.code, 'FACULTY_MISMATCH');
        });

        // 17. FACULTY upload cannot become MASTER upload
        const facultyToMasterPayload = JSON.parse(JSON.stringify(validMasterPayload));
        facultyToMasterPayload.timetable_type = 'MASTER_TIMETABLE';
        const facToMasterRes = await callInternal('POST', '/api/internal/uploads/upl_test_faculty_202/processed', {
            extractedData: facultyToMasterPayload
        });
        check('Faculty upload claimed as master rejected with 422 TIMETABLE_TYPE_MISMATCH', () => {
            assert.strictEqual(facToMasterRes.status, 422);
            assert.strictEqual(facToMasterRes.body.code, 'TIMETABLE_TYPE_MISMATCH');
        });

        // 20. Failure endpoint marks upload as FAILED
        console.log('\n[9] Failure Notification Handling');
        const failRes = await callInternal('POST', '/api/internal/uploads/upl_test_faculty_202/fail', {
            errorCode: 'OCR_UNREADABLE',
            errorMessage: 'Image was blurry'
        });
        check('Failure endpoint marks status as FAILED', () => {
            assert.strictEqual(failRes.status, 200);
            assert.strictEqual(failRes.body.status, 'FAILED');
        });

        const recordAfterFail = await getUploadRecord('upl_test_faculty_202');
        assert.strictEqual(recordAfterFail.status, 'FAILED');

        // Cleanup test files
        if (fs.existsSync(sampleFilePath)) {
            try { fs.unlinkSync(sampleFilePath); } catch (e) {}
        }
        clearUploads();

        console.log('\n====================================');
        console.log('Phase B2.3 Internal Upload Tests: ALL CHECKS PASSED');
        console.log('====================================\n');
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('TEST ERROR:', err);
        process.exit(1);
    });
}

module.exports = { run };
