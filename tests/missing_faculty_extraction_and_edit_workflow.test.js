const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const http = require('http');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
const { app } = require('../server');
const users = require('../src/data/users');
const { resetBranchForTesting } = require('../src/data/departments');
const { clearUploads, saveUploadRecord, saveStagedData, getStagedData } = require('../src/data/uploads');
const { validateExtractedContract } = require('../src/core/contractValidator');
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

async function runMissingFacultyTests() {
    console.log('\n======================================================');
    console.log('Running Missing Faculty Extraction & Staging Workflow Tests');
    console.log('======================================================\n');

    await startServer();

    try {
        users.resetForTesting();
        resetBranchForTesting();
        clearUploads();

        // 1. Setup HOS Account
        const hosReg = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'Test HOD',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hod_test',
            password: 'Hod_password1'
        });
        assert.strictEqual(hosReg.status, 201);
        const hosLogin = await call('POST', '/api/auth/login', {
            username: 'cme_hod_test',
            password: 'Hod_password1'
        });
        const hosCookie = hosLogin.cookie;
        assert.ok(hosCookie);

        if (db.isConfigured()) {
            await repository.addClass({ code: 'CME-SEM5-A', department: 'CME', semester: 5, section: 'A', academicYear: '2025-2026' }).catch(() => {});
            await repository.addSubject({ code: 'PP_CME', name: 'Python Programming', department: 'CME', subjectType: 'theory' }).catch(() => {});
            await repository.addSubject({ code: 'AP_CME', name: 'Android Programming', department: 'CME', subjectType: 'theory' }).catch(() => {});
            await repository.addSubject({ code: 'TPC_CME', name: 'TPC', department: 'CME', subjectType: 'activity' }).catch(() => {});
            await repository.addFaculty({ id: 'FAC_BK_CME', code: 'FAC_BK_CME', name: 'Ms. B. Kusuma', department: 'CME', status: 'active' }).catch(() => {});
            await repository.addFaculty({ id: 'FAC_CD_CME', code: 'FAC_CD_CME', name: 'Mr. CH. Debadatta', department: 'CME', status: 'active' }).catch(() => {});
        }

        // Seed catalog in store
        store.replace({
            allowEmpty: true,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            classes: [
                { class: 'CME-SEM5-A', code: 'CME-SEM5-A', department: 'CME', semester: 5, section: 'A', rows: {} }
            ],
            faculty: [
                { id: 'FAC_BK', code: 'FAC_BK', name: 'Ms. B. Kusuma', department: 'CME' },
                { id: 'FAC_CD', code: 'FAC_CD', name: 'Mr. CH. Debadatta', department: 'CME' }
            ],
            subjects: [
                { code: 'PP', name: 'Python Programming', department: 'CME', type: 'theory' },
                { code: 'AP', name: 'Android Programming', department: 'CME', type: 'theory' },
                { code: 'TPC', name: 'TPC', department: 'CME', type: 'activity' }
            ],
            rooms: [
                { code: 'C-101', name: 'Room C-101' }
            ],
            entries: []
        });

        // Test A: validateExtractedContract tolerates missing faculty on theory entry
        console.log('[Test 1] Contract Validation Tolerates Incomplete Faculty Extraction');
        const incompleteContract = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: 'CME',
            academic_year: '2025-2026',
            semester: 5,
            section: 'A',
            class_name: 'CME-SEM5-A',
            days: ['Monday'],
            periods: [1, 2, 3],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Python Programming',
                    faculty_name: null, // MISSING FACULTY
                    class_name: 'CME-SEM5-A',
                    session_type: 'theory',
                    is_free: false
                },
                {
                    day: 'Monday',
                    period: 2,
                    subject_name: 'Android Programming',
                    faculty_name: 'Mr. CH. Debadatta', // COMPLETE
                    class_name: 'CME-SEM5-A',
                    session_type: 'theory',
                    is_free: false
                },
                {
                    day: 'Monday',
                    period: 3,
                    subject_name: 'TPC',
                    faculty_name: null, // ACTIVITY (VALID)
                    class_name: 'CME-SEM5-A',
                    session_type: 'activity',
                    is_free: false
                }
            ]
        };

        const val = validateExtractedContract(incompleteContract, { departmentCode: 'CME', uploadType: 'MASTER_TIMETABLE' });
        assert.strictEqual(val.ok, true, 'Contract validation must pass even if theory faculty is missing');
        assert.ok(val.warnings.length > 0, 'Contract validation must record warning for missing faculty');
        console.log('✓ Contract validation passed with non-fatal warning:', val.warnings[0]);

        // Test B: Staging creation with missing faculty
        console.log('\n[Test 2] Missing Faculty Staged with Needs Review status');
        const uploadId = 'upl_test_missing_fac_' + Date.now();
        await saveUploadRecord({
            uploadId,
            originalFilename: 'oldTT2_sample.jpeg',
            fileType: 'image/jpeg',
            fileSize: 1000,
            uploaderUserId: '1',
            branchId: '1',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        const res1 = await resolveContract(incompleteContract, 'CME');
        assert.strictEqual(res1.ok, false, 'resolveContract must report unresolved status when faculty is missing for non-activity slot');
        assert.strictEqual(res1.unresolvedCount, 1, 'Exactly 1 unresolved entity for the missing faculty slot');
        assert.strictEqual(res1.unresolvedEntities[0].extractedText, 'Needs review');
        console.log('✓ resolveContract correctly flagged missing faculty slot as needing review');

        await saveStagedData(uploadId, incompleteContract, 'VALID', null, {
            unresolvedEntities: res1.unresolvedEntities
        });

        // Test C: Staging preview GET returns unresolved details
        const getStagedRes = await call('GET', `/api/staging/${uploadId}`, null, hosCookie);
        assert.strictEqual(getStagedRes.status, 200);
        assert.strictEqual(getStagedRes.body.resolution.unresolvedCount, 1);
        console.log('✓ Staging preview endpoint successfully provides timetable and unresolved flags');

        // Test D: Final approval is strictly blocked while faculty is missing
        console.log('\n[Test 3] Approval Rejection Gate on Unresolved Faculty');
        const approveBlockedRes = await call('POST', `/api/staging/${uploadId}/approve`, {}, hosCookie);
        assert.strictEqual(approveBlockedRes.status, 422, 'Approval must be rejected with HTTP 422 when faculty is missing');
        assert.strictEqual(approveBlockedRes.body.code, 'UNRESOLVED_ENTITIES');
        console.log('✓ Approval strictly blocked with 422 UNRESOLVED_ENTITIES');

        // Test E: HOD edits the entry to assign the correct faculty
        console.log('\n[Test 4] HOD Edits Missing Faculty Slot');
        const editRes = await call('PUT', `/api/staging/${uploadId}/entry`, {
            day: 'Monday',
            period: 1,
            subject_name: 'Python Programming',
            faculty_name: 'Ms. B. Kusuma',
            session_type: 'theory',
            is_free: false
        }, hosCookie);
        assert.strictEqual(editRes.status, 200, 'Entry edit must succeed');
        assert.strictEqual(editRes.body.resolution.unresolvedCount, 0, 'Unresolved count must become 0 after editing');
        assert.strictEqual(editRes.body.resolution.ok, true, 'Resolution must now be OK');
        console.log('✓ HOD entry edit resolved missing faculty to "Ms. B. Kusuma"');

        // Test F: Final approval now succeeds
        console.log('\n[Test 5] Final Approval After Resolution');
        const approveSuccessRes = await call('POST', `/api/staging/${uploadId}/approve`, {}, hosCookie);
        assert.strictEqual(approveSuccessRes.status, 200, 'Approval must succeed after all faculty are resolved');
        assert.strictEqual(approveSuccessRes.body.importStatus, 'IMPORTED');
        assert.strictEqual(approveSuccessRes.body.importedCount, 3);
        console.log('✓ Staging approved and imported 3 slots successfully');

        // Verify imported entries
        const ttRes = await call('GET', '/api/timetable?class=CME-SEM5-A', null, hosCookie);
        assert.strictEqual(ttRes.status, 200);
        const liveSlots = (ttRes.body && ttRes.body.cells) || [];
        const p1 = liveSlots.find(e => e.day === 'Monday' && e.period === 1);
        const p2 = liveSlots.find(e => e.day === 'Monday' && e.period === 2);
        const p3 = liveSlots.find(e => e.day === 'Monday' && e.period === 3);

        assert.ok(p1, 'Monday P1 must exist');
        assert.ok(p2, 'Monday P2 must exist');
        assert.ok(p3, 'Monday P3 must exist');
        assert.strictEqual(p1.faculty, 'Ms. B. Kusuma');
        assert.strictEqual(p2.faculty, 'Mr. CH. Debadatta');
        assert.strictEqual(p3.faculty, null);
        console.log('✓ Live imported slots confirmed: P1 -> B. Kusuma, P2 -> CH. Debadatta, P3 -> null (TPC)');

        console.log('\n======================================================');
        console.log('✅ ALL MISSING FACULTY WORKFLOW TESTS PASSED (6/6)');
        console.log('======================================================\n');
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    runMissingFacultyTests().then(() => {
        process.exit(0);
    }).catch(err => {
        console.error('Test Failed:', err);
        process.exit(1);
    });
}

module.exports = { runMissingFacultyTests };
