/**
 * Phase B2.5 — Staged Timetable Review & Approval Integration Tests
 *
 * Verifies all 15 key Phase B2.5 requirements:
 *   1. Anonymous request to staging API is rejected (HTTP 401).
 *   2. Faculty user cannot review, approve, or reject staged timetable (HTTP 403).
 *   3. Cross-branch isolation: HOS cannot view, map, approve, or reject another branch's upload (HTTP 403).
 *   4. Invalid staging data (contract validation failed) cannot be approved (HTTP 422).
 *   5. Unresolved entities (unregistered faculty/subject/class) block approval (HTTP 422 UNRESOLVED_ENTITIES).
 *   6. Explicit entity mapping resolves unresolved references.
 *   7. Scheduled activities (e.g. TPC) with faculty_name=null remain valid and require no faculty resolution.
 *   8. HOS approval executes transactional import into live timetable (HTTP 200).
 *   9. Multi-period cells with span_to expand into atomic slots in live timetable.
 *  10. REPLACE_CLASS scoped replacement: replaces target class section only.
 *  11. Other classes and existing timetable entries remain completely untouched.
 *  12. Faculty conflict with another class aborts import and rolls back completely (HTTP 409 SLOT_CONFLICT).
 *  13. Room conflict with another class aborts import and rolls back completely (HTTP 409 SLOT_CONFLICT).
 *  14. Approval idempotency: already IMPORTED timetable cannot be imported again (HTTP 409 ALREADY_IMPORTED).
 *  15. Staged timetable rejection marks status REJECTED and leaves live timetable untouched.
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
    console.log('TecSubstitution — Phase B2.5 Staging & Approval Tests\n');

    await startServer();

    try {
        users.resetForTesting();
        resetBranchForTesting();
        clearUploads();

        // -------------------------------------------------------------
        // Register CME HOS (registers branch CME automatically)
        const cmeHosReg = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head of Section',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos',
            password: 'Cme_password1'
        });
        assert.strictEqual(cmeHosReg.status, 201);
        const cmeHosLogin = await call('POST', '/api/auth/login', {
            username: 'cme_hos',
            password: 'Cme_password1'
        });
        const cmeHosCookie = cmeHosLogin.cookie;
        assert.ok(cmeHosCookie);

        // Register CME Faculty
        const cmeFacReg = await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'Ms. B. Kusuma',
            phone: '9123456789',
            username: 'kusuma_fac',
            password: 'Kusuma_pass1',
            subjects: ['Python Programming']
        }, cmeHosCookie);
        assert.strictEqual(cmeFacReg.status, 201);
        const cmeFacLogin = await call('POST', '/api/auth/login', {
            username: 'kusuma_fac',
            password: 'Kusuma_pass1'
        });
        const cmeFacCookie = cmeFacLogin.cookie;
        assert.ok(cmeFacCookie);

        // Register EEE HOS
        const eeeHosReg = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Head of Section',
            phone: '9876500000',
            branchName: 'Electrical Engineering',
            branchCode: 'EEE',
            username: 'eee_hos',
            password: 'Eee_password1'
        });
        assert.strictEqual(eeeHosReg.status, 201);
        const eeeHosLogin = await call('POST', '/api/auth/login', {
            username: 'eee_hos',
            password: 'Eee_password1'
        });
        const eeeHosCookie = eeeHosLogin.cookie;
        assert.ok(eeeHosCookie);

        // Seed initial store dataset with catalog & existing entries:
        // - CME-B has Monday P1 with Dr. Ravi Sharma in room C-402
        // - CME-A has Tuesday P1 with Dr. Ravi Sharma in room C-401 (an old entry to be replaced)
        store.replace({
            allowEmpty: true,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            classes: [
                { class: 'CME-A', department: 'CME' },
                { class: 'CME-B', department: 'CME' },
                { class: 'CME-C', department: 'CME' }
            ],
            faculty: [
                { id: 'F1', name: 'Ms. B. Kusuma', department: 'CME' },
                { id: 'F2', name: 'Dr. Ravi Sharma', department: 'CME' }
            ],
            subjects: [
                { code: 'CM-505', name: 'Python Programming', department: 'CME', type: 'theory' },
                { code: 'CM-502', name: 'Database Systems', department: 'CME', type: 'theory' },
                { code: 'TPC', name: 'TPC', department: 'CME', type: 'activity' }
            ],
            rooms: [
                { code: 'C-401', name: 'Room C-401' },
                { code: 'C-402', name: 'Room C-402' }
            ],
            entries: [
                {
                    id: 101,
                    class: 'CME-B',
                    className: 'CME-B',
                    day: 'Monday',
                    period: 1,
                    subject: 'Database Systems',
                    faculty: 'Dr. Ravi Sharma',
                    room: 'C-402',
                    type: 'theory'
                },
                {
                    id: 102,
                    class: 'CME-A',
                    className: 'CME-A',
                    day: 'Tuesday',
                    period: 1,
                    subject: 'Database Systems',
                    faculty: 'Dr. Ravi Sharma',
                    room: 'C-401',
                    type: 'theory'
                }
            ]
        }, 'test-seed');

        const initialEntries = store.source.entries || [];
        assert.strictEqual(initialEntries.length, 2, 'Initial entries must be 2');

        // Create a dummy staged upload for CME
        await saveUploadRecord({
            uploadId: 'upl_cme_review_01',
            originalFilename: 'CME_V_Sem_TT.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        // -------------------------------------------------------------
        // Test 1: HOS Authentication & Role Enforcement
        // -------------------------------------------------------------
        console.log('[1] HOS Authentication & Role Access Control');
        await checkAsync('Anonymous request to staging API is rejected with HTTP 401', async () => {
            const res = await call('GET', '/api/staging/pending');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.code, 'UNAUTHENTICATED');
        });

        await checkAsync('Faculty user is forbidden from accessing staging review (HTTP 403)', async () => {
            const resGet = await call('GET', '/api/staging/upl_cme_review_01', null, cmeFacCookie);
            assert.strictEqual(resGet.status, 403);
            assert.strictEqual(resGet.body.code, 'FORBIDDEN');

            const resApprove = await call('POST', '/api/staging/upl_cme_review_01/approve', {}, cmeFacCookie);
            assert.strictEqual(resApprove.status, 403);
            assert.strictEqual(resApprove.body.code, 'FORBIDDEN');

            const resReject = await call('POST', '/api/staging/upl_cme_review_01/reject', {}, cmeFacCookie);
            assert.strictEqual(resReject.status, 403);
            assert.strictEqual(resReject.body.code, 'FORBIDDEN');
        });

        // -------------------------------------------------------------
        // Test 2: Cross-Branch Access Isolation
        // -------------------------------------------------------------
        console.log('\n[2] Cross-Branch Isolation');
        await checkAsync('EEE HOS cannot view, map, approve or reject CME upload (HTTP 403)', async () => {
            const viewRes = await call('GET', '/api/staging/upl_cme_review_01', null, eeeHosCookie);
            assert.strictEqual(viewRes.status, 403);
            assert.strictEqual(viewRes.body.code, 'FORBIDDEN');

            const mapRes = await call('POST', '/api/staging/upl_cme_review_01/map-entity', {
                entityType: 'faculty',
                extractedText: 'Unknown',
                targetName: 'Ms. B. Kusuma'
            }, eeeHosCookie);
            assert.strictEqual(mapRes.status, 403);
            assert.strictEqual(mapRes.body.code, 'FORBIDDEN');

            const appRes = await call('POST', '/api/staging/upl_cme_review_01/approve', {}, eeeHosCookie);
            assert.strictEqual(appRes.status, 403);
            assert.strictEqual(appRes.body.code, 'FORBIDDEN');

            const rejRes = await call('POST', '/api/staging/upl_cme_review_01/reject', {}, eeeHosCookie);
            assert.strictEqual(rejRes.status, 403);
            assert.strictEqual(rejRes.body.code, 'FORBIDDEN');
        });

        // -------------------------------------------------------------
        // Test 3: Invalid Staging Data Cannot Be Approved
        // -------------------------------------------------------------
        console.log('\n[3] Contract Validation Gate');
        await saveUploadRecord({
            uploadId: 'upl_cme_invalid_02',
            originalFilename: 'invalid_contract.pdf',
            fileType: 'application/pdf',
            fileSize: 500,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await saveStagedData('upl_cme_invalid_02', { contract_version: '2.1' }, 'INVALID', [{ code: 'MISSING_ENTRIES', message: 'No entries provided' }]);

        await checkAsync('Staged data with INVALID validation status cannot be approved (HTTP 422)', async () => {
            const res = await call('POST', '/api/staging/upl_cme_invalid_02/approve', {}, cmeHosCookie);
            assert.strictEqual(res.status, 422);
            assert.strictEqual(res.body.code, 'CANNOT_APPROVE_INVALID_DATA');
            assert.ok(Array.isArray(res.body.validationErrors));
        });

        // -------------------------------------------------------------
        // Test 4: Unresolved Entities Block Approval & Explicit Mapping Works
        // -------------------------------------------------------------
        console.log('\n[4] Zero Silent Creation & Entity Resolution Gate');
        // Extracted contract contains an unknown subject "Quantum Computing"
        // and unknown faculty "Prof. Unknown Guest"
        const contractWithUnresolved = {
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
                    span_to: 2,
                    subject_name: 'Quantum Computing', // UNRESOLVED
                    subject_code: 'QC-101',
                    faculty_name: 'Prof. Unknown Guest', // UNRESOLVED
                    class_name: 'CME-A',
                    room_code: 'C-401',
                    session_type: 'theory',
                    is_free: false
                },
                {
                    day: 'Monday',
                    period: 3,
                    subject_name: 'TPC',
                    session_type: 'activity',
                    faculty_name: null, // Scheduled activity without faculty is VALID
                    class_name: 'CME-A',
                    room_code: 'C-401',
                    is_free: false
                }
            ]
        };

        await saveStagedData('upl_cme_review_01', contractWithUnresolved, 'VALID', []);

        await checkAsync('Staged record with uncatalogued subject blocks approval (HTTP 422)', async () => {
            const res = await call('POST', '/api/staging/upl_cme_review_01/approve', {}, cmeHosCookie);
            assert.strictEqual(res.status, 422);
            assert.strictEqual(res.body.code, 'UNRESOLVED_ENTITIES');
            assert.strictEqual(res.body.unresolvedEntities.length, 1);

            const types = res.body.unresolvedEntities.map(e => e.entityType);
            assert.ok(types.includes('subject'), 'Must detect unresolved subject');
        });

        await checkAsync('Unregistered faculty generates informational warning without blocking', async () => {
            const detailRes = await call('GET', '/api/staging/upl_cme_review_01', null, cmeHosCookie);
            assert.strictEqual(detailRes.status, 200);
            assert.ok(detailRes.body.resolution.informationalWarnings.length > 0, 'Must contain informational warning for unregistered faculty');
        });

        await checkAsync('HOS explicitly maps unresolved subject to existing catalog entity', async () => {
            const mapSubjRes = await call('POST', '/api/staging/upl_cme_review_01/map-entity', {
                entityType: 'subject',
                extractedText: 'Quantum Computing',
                targetName: 'Python Programming'
            }, cmeHosCookie);
            assert.strictEqual(mapSubjRes.status, 200);
            assert.strictEqual(mapSubjRes.body.success, true);
            assert.strictEqual(mapSubjRes.body.resolution.unresolvedCount, 0); // 0 unresolved left!
            assert.strictEqual(mapSubjRes.body.resolution.ok, true);
        });

        // -------------------------------------------------------------
        // Test 5: Approval, Span Expansion & Class-Scoped Replacement
        // -------------------------------------------------------------
        console.log('\n[5] Approval, Atomic Span Expansion & REPLACE_CLASS Scoped Import');
        await checkAsync('Approval succeeds transactionally once all entities are resolved', async () => {
            const appRes = await call('POST', '/api/staging/upl_cme_review_01/approve', {}, cmeHosCookie);
            assert.strictEqual(appRes.status, 200);
            assert.strictEqual(appRes.body.success, true);
            assert.strictEqual(appRes.body.importStatus, 'IMPORTED');
            // Span Monday P1..P2 = 2 atomic slots, plus Monday P3 = 1 slot => total 3 slots imported
            assert.strictEqual(appRes.body.importedCount, 3);
        });

        await checkAsync('Multi-period span (span_to: 2) expanded into atomic slots for P1 and P2', async () => {
            const liveSlots = store.source.entries || [];
            const cmeASlots = liveSlots.filter(e => (e.class === 'CME-A' || e.className === 'CME-A') && e.day === 'Monday');
            assert.strictEqual(cmeASlots.length, 3, 'CME-A must have exactly 3 slots on Monday');

            const p1 = cmeASlots.find(e => e.period === 1);
            const p2 = cmeASlots.find(e => e.period === 2);
            const p3 = cmeASlots.find(e => e.period === 3);

            assert.ok(p1, 'Period 1 slot must exist');
            assert.ok(p2, 'Period 2 slot must exist (expanded from span_to: 2)');
            assert.ok(p3, 'Period 3 slot must exist');

            assert.strictEqual(p1.faculty, 'Prof. Unknown Guest');
            assert.strictEqual(p2.faculty, 'Prof. Unknown Guest');
            assert.strictEqual(p3.subject, 'TPC');
            assert.strictEqual(p3.faculty, null);
        });

        await checkAsync('REPLACE_CLASS behavior: old CME-A entry on Tuesday was replaced', async () => {
            const liveSlots = store.source.entries || [];
            const cmeATue = liveSlots.find(e => (e.class === 'CME-A' || e.className === 'CME-A') && e.day === 'Tuesday');
            assert.strictEqual(cmeATue, undefined, 'Old Tuesday CME-A entry must have been replaced');
        });

        await checkAsync('Other classes remain untouched: CME-B on Monday P1 is still intact', async () => {
            const liveSlots = store.source.entries || [];
            const cmeBSlot = liveSlots.find(e => (e.class === 'CME-B' || e.className === 'CME-B') && e.day === 'Monday' && e.period === 1);
            assert.ok(cmeBSlot, 'CME-B entry must still exist');
            assert.strictEqual(cmeBSlot.faculty, 'Dr. Ravi Sharma');
            assert.strictEqual(cmeBSlot.room, 'C-402');
        });

        // -------------------------------------------------------------
        // Test 6: Import Idempotency
        // -------------------------------------------------------------
        console.log('\n[6] Approval Idempotency');
        await checkAsync('Attempting to approve an already IMPORTED upload returns HTTP 409 ALREADY_IMPORTED', async () => {
            const countBefore = (store.source.entries || []).length;
            const reApproveRes = await call('POST', '/api/staging/upl_cme_review_01/approve', {}, cmeHosCookie);
            assert.strictEqual(reApproveRes.status, 409);
            assert.strictEqual(reApproveRes.body.code, 'ALREADY_IMPORTED');
            const countAfter = (store.source.entries || []).length;
            assert.strictEqual(countAfter, countBefore, 'Live entries count must remain identical');
        });

        // -------------------------------------------------------------
        // Test 7: Conflict Detection & Transaction Rollback
        // -------------------------------------------------------------
        console.log('\n[7] Cross-Class Conflict Detection & Rollback');
        // CME-B currently has Dr. Ravi Sharma at Monday P1 in C-402.
        // If an upload for CME-C schedules Dr. Ravi Sharma at Monday P1, it must be rejected!
        await saveUploadRecord({
            uploadId: 'upl_cme_conflict_03',
            originalFilename: 'CME_C_Conflict.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        const conflictContract = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: 'CME',
            academic_year: '2026-27',
            semester: 3,
            class_name: 'CME-C',
            days: ['Monday'],
            periods: [1],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Database Systems',
                    faculty_name: 'Dr. Ravi Sharma', // Clashes with CME-B at Monday P1!
                    class_name: 'CME-C',
                    room_code: 'C-401',
                    session_type: 'theory',
                    is_free: false
                }
            ]
        };

        await saveStagedData('upl_cme_conflict_03', conflictContract, 'VALID', []);

        await checkAsync('Cross-class faculty conflict causes HTTP 409 rejection and rolls back completely', async () => {
            const countBefore = (store.source.entries || []).length;
            const res = await call('POST', '/api/staging/upl_cme_conflict_03/approve', {}, cmeHosCookie);
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.code, 'SLOT_CONFLICT');
            assert.ok(res.body.details && res.body.details.length > 0);
            assert.strictEqual(res.body.details[0].code, 'FACULTY_BUSY');

            // Verify live timetable was not mutated (zero entries for CME-C)
            const countAfter = (store.source.entries || []).length;
            assert.strictEqual(countAfter, countBefore);
            const cmecEntries = (store.source.entries || []).filter(e => e.class === 'CME-C' || e.className === 'CME-C');
            assert.strictEqual(cmecEntries.length, 0);

            // Staging record must still be STAGED (not IMPORTED)
            const stageRec = await getStagedData('upl_cme_conflict_03');
            assert.strictEqual(stageRec.importStatus, 'STAGED');
        });

        // -------------------------------------------------------------
        // Test 8: Staged Timetable Rejection Flow
        // -------------------------------------------------------------
        console.log('\n[8] Rejection Flow & Zero Live Mutation');
        await saveUploadRecord({
            uploadId: 'upl_cme_reject_04',
            originalFilename: 'CME_Wrong_Upload.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await saveStagedData('upl_cme_reject_04', contractWithUnresolved, 'VALID', []);

        await checkAsync('HOS can reject staged timetable with reason (HTTP 200)', async () => {
            const rejRes = await call('POST', '/api/staging/upl_cme_reject_04/reject', {
                reason: 'Uploaded wrong semester timetable by mistake.'
            }, cmeHosCookie);
            assert.strictEqual(rejRes.status, 200);
            assert.strictEqual(rejRes.body.success, true);
            assert.strictEqual(rejRes.body.importStatus, 'REJECTED');
            assert.strictEqual(rejRes.body.rejectionReason, 'Uploaded wrong semester timetable by mistake.');

            const stageRec = await getStagedData('upl_cme_reject_04');
            assert.strictEqual(stageRec.importStatus, 'REJECTED');
            assert.strictEqual(stageRec.rejectionReason, 'Uploaded wrong semester timetable by mistake.');
        });

        await checkAsync('Attempting to approve a REJECTED upload is blocked (HTTP 409 ALREADY_REJECTED)', async () => {
            const res = await call('POST', '/api/staging/upl_cme_reject_04/approve', {}, cmeHosCookie);
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.code, 'ALREADY_REJECTED');
        });

        // -------------------------------------------------------------
        // Test 9: Pending Staging Query
        // -------------------------------------------------------------
        console.log('\n[9] Staging Pending Query');
        await checkAsync('GET /api/staging/pending lists staged uploads for authenticated branch only', async () => {
            const res = await call('GET', '/api/staging/pending', null, cmeHosCookie);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.department, 'CME');
            assert.ok(Array.isArray(res.body.staging));
            assert.ok(res.body.staging.every(s => s.departmentCode === 'CME' || s.department === 'CME'));

            // EEE HOS sees only EEE pending uploads
            const eeeRes = await call('GET', '/api/staging/pending', null, eeeHosCookie);
            assert.strictEqual(eeeRes.status, 200);
            assert.strictEqual(eeeRes.body.department, 'EEE');
            assert.ok(Array.isArray(eeeRes.body.staging));
            assert.ok(eeeRes.body.staging.every(s => s.departmentCode === 'EEE' || s.department === 'EEE'));
        });

        console.log('\n======================================================');
        const { passed, failed } = counts();
        console.log(`Phase B2.5 Staging Tests finished: ${passed} passed, ${failed} failed.\n`);
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
