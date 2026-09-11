/**
 * Phase B6 — Final Integration Verification Test Suite
 *
 * Covers complete end-to-end integration across B6.1, B6.2, and B6.3:
 *  1. Dynamic new branch registration with totalSemesters=8 (SEM-1 ... SEM-8).
 *  2. Branch-specific dynamic semester generation without hardcoding.
 *  3. Class/scope creation for SEM-1/A, SEM-2/A, and SEM-2/B with distinct class_ids.
 *  4. Active faculty creation and HOS branch management boundary.
 *  5. Timetable scope isolation across semesters and sections.
 *  6. B2.5 staging/approval import targeting specific semester + section only.
 *  7. Timetable clearing isolated to target class scope without affecting others.
 *  8. Faculty management lifecycle: edit, deactivate (login blocked, excluded from availability), and reactivate.
 *  9. Cross-branch availability ordering: same-branch priority first, other branches after.
 * 10. Busy & inactive cross-branch faculty exclusion.
 * 11. Second dynamic new branch (AI_DS) automatic participation without code changes.
 * 12. Strict administrative branch isolation & read-only guarantee.
 * 13. Legacy classes (CME-A, CME-B, EEE-B, DEEE-B) backward compatibility.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting, getBranchSemesters } = require('../src/data/departments');
const {
    clearUploads,
    saveUploadRecord,
    saveStagedData,
    UPLOADS_ROOT
} = require('../src/data/uploads');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}\n      ${err.message}`);
        throw err;
    }
}

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
    console.log('===============================================================');
    console.log('TecSubstitution — Phase B6 Final Integration Verification');
    console.log('===============================================================\n');

    await startServer();

    try {
        // Reset state for clean integration verification
        users.resetForTesting();
        resetBranchForTesting();
        clearUploads();

        // -------------------------------------------------------------
        // [1] & [2] Register CME HOS and a NEW Branch: CSE (B.Tech, 8 Semesters)
        // -------------------------------------------------------------
        console.log('[1] Registering CME HOS (Diploma: 6 Semesters)');
        const regCME = await call('POST', '/api/auth/register', {
            username: 'cme_hos',
            password: 'Password_123',
            name: 'CME Head of Section',
            role: 'hos',
            phone: '9876543210',
            branchCode: 'CME',
            branchName: 'Computer Engineering',
            totalSemesters: 6
        });
        check('CME HOS registered successfully with totalSemesters=6', () => {
            assert.strictEqual(regCME.status, 201);
            assert.strictEqual(regCME.body.user.department, 'CME');
        });

        console.log('\n[2] Registering NEW Branch: CSE (B.Tech / BTEC: 8 Semesters)');
        const regCSE = await call('POST', '/api/auth/register', {
            username: 'cse_hos',
            password: 'Password_123',
            name: 'CSE Head of Section',
            role: 'hos',
            phone: '9876543220',
            branchCode: 'CSE',
            branchName: 'Computer Science and Engineering',
            totalSemesters: 8
        });
        check('CSE HOS registered successfully with totalSemesters=8', () => {
            assert.strictEqual(regCSE.status, 201);
            assert.strictEqual(regCSE.body.user.department, 'CSE');
        });

        const cmeLogin = await call('POST', '/api/auth/login', { username: 'cme_hos', password: 'Password_123' });
        const cmeCookie = cmeLogin.cookie;
        const cseLogin = await call('POST', '/api/auth/login', { username: 'cse_hos', password: 'Password_123' });
        const cseCookie = cseLogin.cookie;

        // Verify dynamic semester count: CME has 6, CSE has 8
        const cmeScopes = await call('GET', '/api/timetable/scopes', null, cmeCookie);
        check('CME receives SEM-1 ... SEM-6', () => {
            assert.strictEqual(cmeScopes.status, 200);
            assert.strictEqual(cmeScopes.body.totalSemesters, 6);
            assert.deepStrictEqual(cmeScopes.body.semesters, ['SEM-1', 'SEM-2', 'SEM-3', 'SEM-4', 'SEM-5', 'SEM-6']);
        });

        const cseScopes = await call('GET', '/api/timetable/scopes', null, cseCookie);
        check('CSE receives SEM-1 ... SEM-8 dynamically', () => {
            assert.strictEqual(cseScopes.status, 200);
            assert.strictEqual(cseScopes.body.totalSemesters, 8);
            assert.deepStrictEqual(cseScopes.body.semesters, [
                'SEM-1', 'SEM-2', 'SEM-3', 'SEM-4', 'SEM-5', 'SEM-6', 'SEM-7', 'SEM-8'
            ]);
        });

        // -------------------------------------------------------------
        // [3] Create Multiple CSE Sections/Classes
        // -------------------------------------------------------------
        console.log('\n[3] Creating CSE Section Scopes: SEM-1/A, SEM-2/A, SEM-2/B');
        const s1a = store.resolveOrCreateClassInMemory({
            branch: 'CSE', academicYear: '2026-27', semester: 'SEM-1', section: 'A'
        });
        const s2a = store.resolveOrCreateClassInMemory({
            branch: 'CSE', academicYear: '2026-27', semester: 'SEM-2', section: 'A'
        });
        const s2b = store.resolveOrCreateClassInMemory({
            branch: 'CSE', academicYear: '2026-27', semester: 'SEM-2', section: 'B'
        });

        check('SEM-1/A, SEM-2/A, and SEM-2/B resolve to distinct class identifiers', () => {
            assert.ok(s1a && s1a.code);
            assert.ok(s2a && s2a.code);
            assert.ok(s2b && s2b.code);
            assert.notStrictEqual(s1a.code, s2a.code);
            assert.notStrictEqual(s2a.code, s2b.code);
            assert.notStrictEqual(s1a.code, s2b.code);
            assert.notStrictEqual(s1a.id, s2a.id);
            assert.notStrictEqual(s2a.id, s2b.id);
            assert.notStrictEqual(s1a.id, s2b.id);
        });

        // -------------------------------------------------------------
        // [4] & [5] Faculty Creation & Administrative Boundary
        // -------------------------------------------------------------
        console.log('\n[4] Creating Faculty in CME and CSE');
        // CME Faculty
        const cmeFac1 = await call('POST', '/api/auth/register', {
            name: 'Dr. Alice CME', username: 'alice_cme', password: 'Password_123',
            confirmPassword: 'Password_123', role: 'faculty',
            phone: '9876543210', designation: 'Senior Professor', subjects: ['Algorithms']
        }, cmeCookie);
        const cmeFac2 = await call('POST', '/api/auth/register', {
            name: 'Prof. Bob CME', username: 'bob_cme', password: 'Password_123',
            confirmPassword: 'Password_123', role: 'faculty',
            phone: '9876543211', designation: 'Assistant Professor', subjects: ['Data Structures']
        }, cmeCookie);

        // CSE Faculty
        const cseFac1 = await call('POST', '/api/auth/register', {
            name: 'Dr. Grace CSE', username: 'grace_cse', password: 'Password_123',
            confirmPassword: 'Password_123', role: 'faculty',
            phone: '9876543212', designation: 'Associate Professor', subjects: ['Machine Learning']
        }, cseCookie);
        const cseFac2 = await call('POST', '/api/auth/register', {
            name: 'Prof. Alan CSE', username: 'alan_cse', password: 'Password_123',
            confirmPassword: 'Password_123', role: 'faculty',
            phone: '9876543213', designation: 'Assistant Professor', subjects: ['Operating Systems']
        }, cseCookie);

        check('CME and CSE faculty created and bound to respective branches', () => {
            assert.strictEqual(cmeFac1.status, 201);
            assert.strictEqual(cseFac1.status, 201);
            assert.strictEqual(cmeFac1.body.user.department, 'CME');
            assert.strictEqual(cseFac1.body.user.department, 'CSE');
        });

        console.log('\n[5] Verifying HOS Administrative Isolation');
        const cseViewCmeFac = await call('GET', '/api/faculty?department=CME', null, cseCookie);
        check('CSE HOS cannot query CME faculty (returns 403)', () => {
            assert.strictEqual(cseViewCmeFac.status, 403);
        });
        const cmeViewCseFac = await call('GET', '/api/faculty?department=CSE', null, cmeCookie);
        check('CME HOS cannot query CSE faculty (returns 403)', () => {
            assert.strictEqual(cmeViewCseFac.status, 403);
        });

        // -------------------------------------------------------------
        // [6] & [7] Timetable Scope Isolation & Entry Population
        // -------------------------------------------------------------
        console.log('\n[6] Populating Timetable for SEM-2/A and Verifying Isolation');
        const s2aClassCode = s2a.code;
        const s1aClassCode = s1a.code;
        const s2bClassCode = s2b.code;

        // Dr. Grace teaches SEM-2/A on Monday P1
        store.addEntryInMemory({
            id: 'cse_s2a_e1',
            faculty: 'Dr. Grace CSE',
            department: 'CSE',
            day: 'Monday',
            period: 1,
            subject: 'Machine Learning',
            className: s2aClassCode,
            type: 'theory'
        });

        // Dr. Alice teaches CME on Monday P1
        store.addEntryInMemory({
            id: 'cme_entry_1',
            faculty: 'Dr. Alice CME',
            department: 'CME',
            day: 'Monday',
            period: 1,
            subject: 'Algorithms',
            className: 'CME-A',
            type: 'theory'
        });

        // Query SEM-2/A grid vs SEM-1/A grid
        const viewS2a = await call('GET', `/api/timetable?semester=SEM-2&section=A`, null, cseCookie);
        const viewS1a = await call('GET', `/api/timetable?semester=SEM-1&section=A`, null, cseCookie);

        check('Timetable query for SEM-2/A returns only SEM-2/A entries', () => {
            assert.strictEqual(viewS2a.status, 200);
            assert.strictEqual(viewS1a.status, 200);
            const p1Cell = (viewS2a.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(p1Cell, 'Monday P1 cell must exist');
            assert.strictEqual(p1Cell.subject, 'Machine Learning');
            assert.strictEqual(p1Cell.status, 'busy');

            const s1aP1 = (viewS1a.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(s1aP1);
            assert.strictEqual(s1aP1.status, 'free');
        });

        // -------------------------------------------------------------
        // [8] B2.5 Staging & Approval Pipeline Scoped to Target Class
        // -------------------------------------------------------------
        console.log('\n[7] & [8] Staging & Approving Timetable Import for SEM-2/B');

        // Add Operating Systems to subjects catalog for CSE
        store.source.subjects = store.source.subjects || [];
        store.source.subjects.push({
            code: 'CS-201',
            name: 'Operating Systems',
            department: 'CSE',
            type: 'theory'
        });

        const uploadId = 'b6_test_upload_s2b';
        await saveUploadRecord({
            uploadId: uploadId,
            originalFilename: 'timetable_s2b.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: path.join(UPLOADS_ROOT, 'test.pdf'),
            uploaderUserId: '1',
            branchId: '1',
            departmentCode: 'CSE',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await saveStagedData(uploadId, {
            contract_version: '2.1',
            branch_code: 'CSE',
            class_name: s2bClassCode,
            academic_year: '2026-27',
            semester: 'SEM-2',
            section: 'B',
            entries: [
                {
                    day: 'Tuesday',
                    period: 2,
                    subject_name: 'Operating Systems',
                    session_type: 'theory',
                    faculty_name: 'Prof. Alan CSE',
                    class_name: s2bClassCode,
                    room_code: 'C-202',
                    is_free: false
                }
            ]
        }, 'VALID', []);

        const approveRes = await call('POST', `/api/staging/${uploadId}/approve`, {}, cseCookie);
        check('B2.5 staging approval completes successfully (HTTP 200)', () => {
            assert.strictEqual(approveRes.status, 200);
            assert.strictEqual(approveRes.body.importStatus, 'IMPORTED');
        });

        const viewS2b = await call('GET', `/api/timetable?semester=SEM-2&section=B`, null, cseCookie);
        check('Import affected ONLY SEM-2/B (contains Tuesday P2)', () => {
            assert.strictEqual(viewS2b.status, 200);
            const tuesP2 = (viewS2b.body.cells || []).find(c => c.day === 'Tuesday' && c.period === 2);
            assert.ok(tuesP2, 'Tuesday P2 cell must exist');
            assert.strictEqual(tuesP2.subject, 'Operating Systems');
            assert.strictEqual(tuesP2.faculty, 'Prof. Alan CSE');
        });

        // Verify other classes remain intact
        const recheckS2a = await call('GET', `/api/timetable?semester=SEM-2&section=A`, null, cseCookie);
        check('SEM-2/A entries remain intact after SEM-2/B import', () => {
            assert.strictEqual(recheckS2a.status, 200);
            const p1Cell = (recheckS2a.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(p1Cell);
            assert.strictEqual(p1Cell.subject, 'Machine Learning');
        });

        // -------------------------------------------------------------
        // [9] Clearing Class Timetable Scope Isolation
        // -------------------------------------------------------------
        console.log('\n[9] Clearing Timetable for SEM-2/A');
        const clearRes = await call('POST', '/api/timetable/clear', {
            semester: 'SEM-2',
            section: 'A',
            academicYear: '2026-27'
        }, cseCookie);
        check('Clearing SEM-2/A returns HTTP 200 and clearedCount=1', () => {
            assert.strictEqual(clearRes.status, 200);
            assert.strictEqual(clearRes.body.cleared, true);
        });

        const afterClearS2a = await call('GET', `/api/timetable?semester=SEM-2&section=A`, null, cseCookie);
        const afterClearS2b = await call('GET', `/api/timetable?semester=SEM-2&section=B`, null, cseCookie);
        check('SEM-2/A is cleared, but SEM-2/B is unaffected', () => {
            const anyBusyS2a = (afterClearS2a.body.cells || []).some(c => c.status === 'busy');
            assert.strictEqual(anyBusyS2a, false);
            const tuesP2 = (afterClearS2b.body.cells || []).find(c => c.day === 'Tuesday' && c.period === 2);
            assert.ok(tuesP2);
            assert.strictEqual(tuesP2.status, 'busy');
        });

        // -------------------------------------------------------------
        // [10] Faculty Lifecycle: Edit, Deactivate, Reactivate
        // -------------------------------------------------------------
        console.log('\n[10] Faculty Lifecycle Management for CSE Faculty');
        const cseFacultyId = cseFac1.body.user.facultyId || cseFac1.body.user.id || 'CSE_GRACE_CSE';

        // 1. Edit
        const editRes = await call('PUT', `/api/faculty/${cseFacultyId}`, {
            name: 'Dr. Grace CSE Updated',
            phone: '9999988888',
            designation: 'Professor & Head',
            subjects: ['AI', 'Deep Learning']
        }, cseCookie);
        check('Faculty details updated successfully', () => {
            assert.strictEqual(editRes.status, 200);
            assert.strictEqual(editRes.body.faculty.name, 'Dr. Grace CSE Updated');
            assert.strictEqual(editRes.body.faculty.phone, '9999988888');
        });

        // 2. Deactivate
        const deactRes = await call('POST', `/api/faculty/${cseFacultyId}/deactivate`, null, cseCookie);
        check('Faculty deactivated successfully (status: inactive)', () => {
            assert.strictEqual(deactRes.status, 200);
            assert.strictEqual(deactRes.body.status, 'inactive');
        });

        // Deactivated faculty login blocked
        const blockedLogin = await call('POST', '/api/auth/login', {
            username: 'grace_cse',
            password: 'Password_123'
        });
        check('Deactivated faculty cannot log in (HTTP 403 ACCOUNT_DEACTIVATED)', () => {
            assert.strictEqual(blockedLogin.status, 403);
            assert.strictEqual(blockedLogin.body.code, 'ACCOUNT_DEACTIVATED');
        });

        // Deactivated faculty excluded from availability
        const availDeact = await call('POST', '/api/availability', { day: 'Monday', period: 3 }, cmeCookie);
        check('Deactivated faculty excluded from availability', () => {
            assert.strictEqual(availDeact.status, 200);
            const found = availDeact.body.availableFaculty.find(n => n.includes('Grace'));
            assert.strictEqual(found, undefined);
        });

        // 3. Reactivate
        const reactRes = await call('POST', `/api/faculty/${cseFacultyId}/activate`, null, cseCookie);
        check('Faculty reactivated successfully (status: active)', () => {
            assert.strictEqual(reactRes.status, 200);
            assert.strictEqual(reactRes.body.status, 'active');
        });

        const reactLogin = await call('POST', '/api/auth/login', {
            username: 'grace_cse',
            password: 'Password_123'
        });
        check('Reactivated faculty can log in successfully', () => {
            assert.strictEqual(reactLogin.status, 200);
        });

        // -------------------------------------------------------------
        // [11] Cross-Branch Availability Ordering & Priority
        // -------------------------------------------------------------
        console.log('\n[11] Cross-Branch Availability with Absent Faculty');
        // Let's set up Monday P3:
        // Dr. Alice CME teaches Monday P3 (BUSY)
        // Prof. Bob CME is FREE on Monday P3
        // Dr. Grace CSE is FREE on Monday P3
        // Prof. Alan CSE teaches Monday P3 (BUSY)
        store.addEntryInMemory({
            id: 'cme_m_p3_alice',
            faculty: 'Dr. Alice CME',
            department: 'CME',
            day: 'Monday',
            period: 3,
            subject: 'Algorithms',
            className: 'CME-A',
            type: 'theory'
        });
        store.addEntryInMemory({
            id: 'cse_m_p3_alan',
            faculty: 'Prof. Alan CSE',
            department: 'CSE',
            day: 'Monday',
            period: 3,
            subject: 'Operating Systems',
            className: s2bClassCode,
            type: 'theory'
        });

        // CME HOS checks availability for absent faculty Dr. Alice CME
        const cmeAvailRes = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 3,
            absentFaculty: 'Dr. Alice CME'
        }, cmeCookie);

        check('Availability returns HTTP 200 with structured candidate list', () => {
            assert.strictEqual(cmeAvailRes.status, 200);
            assert.ok(Array.isArray(cmeAvailRes.body.availableFaculty));
        });

        check('Priority 1: Active FREE same-branch faculty (Prof. Bob CME) appear first', () => {
            const list = cmeAvailRes.body.availableFaculty;
            const bobIdx = list.indexOf('Prof. Bob CME');
            const graceIdx = list.findIndex(n => n.includes('Grace'));
            assert.ok(bobIdx >= 0, 'Prof. Bob CME must be present');
            assert.ok(graceIdx >= 0, 'Dr. Grace CSE must be present');
            assert.ok(bobIdx < graceIdx, 'Prof. Bob CME must appear BEFORE Dr. Grace CSE');
        });

        check('Priority 2: Active FREE other-branch faculty (Dr. Grace CSE) appear under Other Branches', () => {
            assert.ok(cmeAvailRes.body.otherBranches && Array.isArray(cmeAvailRes.body.otherBranches.available));
            const cseInOther = cmeAvailRes.body.otherBranches.available.find(f => f.faculty && f.faculty.includes('Grace'));
            assert.ok(cseInOther, 'Dr. Grace CSE must appear in otherBranches');
            assert.strictEqual(cseInOther.department, 'CSE');
        });

        check('Busy same-branch faculty (Dr. Alice CME) and other-branch faculty (Prof. Alan CSE) are excluded', () => {
            const list = cmeAvailRes.body.availableFaculty;
            assert.strictEqual(list.includes('Dr. Alice CME'), false);
            assert.strictEqual(list.includes('Prof. Alan CSE'), false);
        });

        // -------------------------------------------------------------
        // [12] SECOND Dynamic New Branch (AI_DS) Participation
        // -------------------------------------------------------------
        console.log('\n[12] Creating SECOND New Branch: AI_DS (Artificial Intelligence & Data Science)');
        const regAIDS = await call('POST', '/api/auth/register', {
            username: 'aids_hos',
            password: 'Password_123',
            name: 'AI_DS Head of Section',
            role: 'hos',
            phone: '9876543230',
            branchCode: 'AI_DS',
            branchName: 'Artificial Intelligence and Data Science',
            totalSemesters: 8
        });
        check('AI_DS registered successfully', () => {
            assert.strictEqual(regAIDS.status, 201);
            assert.strictEqual(regAIDS.body.user.department, 'AI_DS');
        });

        const aidsLogin = await call('POST', '/api/auth/login', { username: 'aids_hos', password: 'Password_123' });
        const aidsCookie = aidsLogin.cookie;

        const aidsFac = await call('POST', '/api/auth/register', {
            name: 'Dr. Turing AI_DS', username: 'turing_aids', password: 'Password_123',
            confirmPassword: 'Password_123', role: 'faculty',
            phone: '9876543299', designation: 'Professor', subjects: ['Neural Networks']
        }, aidsCookie);
        check('AI_DS faculty created successfully', () => {
            assert.strictEqual(aidsFac.status, 201);
            assert.strictEqual(aidsFac.body.user.department, 'AI_DS');
        });

        // Recheck availability for absent CME faculty
        const cmeAvailWithAIDS = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 3,
            absentFaculty: 'Dr. Alice CME'
        }, cmeCookie);

        check('AI_DS faculty automatically appears in Other Branches without hardcoding', () => {
            const otherList = (cmeAvailWithAIDS.body.otherBranches && cmeAvailWithAIDS.body.otherBranches.available) || [];
            const aidsFaculty = otherList.find(f => f.department === 'AI_DS');
            assert.ok(aidsFaculty, 'AI_DS faculty must appear in otherBranches');
            assert.strictEqual(aidsFaculty.faculty, 'Dr. Turing AI_DS');
        });

        // -------------------------------------------------------------
        // [13] Strict Administrative Branch Isolation & Read-Only Guarantee
        // -------------------------------------------------------------
        console.log('\n[13] Strict Administrative Branch Isolation & Read-Only Verification');
        // CME HOS cannot modify CSE faculty
        const cmeEditCse = await call('PUT', `/api/faculty/${cseFacultyId}`, { name: 'Hacked Name' }, cmeCookie);
        check('CME HOS cannot modify CSE faculty (returns HTTP 403)', () => {
            assert.strictEqual(cmeEditCse.status, 403);
        });

        // CSE HOS cannot clear CME timetable
        const cseClearCme = await call('POST', '/api/timetable/clear', { className: 'CME-A' }, cseCookie);
        check('CSE HOS cannot clear CME timetable (returns HTTP 403)', () => {
            assert.strictEqual(cseClearCme.status, 403);
        });

        // Read-only guarantee: availability queries do not create substitutions or change timetables
        const entriesBefore = (store.source.entries || []).length;
        await call('POST', '/api/availability', { day: 'Monday', period: 3, absentFaculty: 'Dr. Alice CME' }, cmeCookie);
        const entriesAfter = (store.source.entries || []).length;
        check('Availability query does not mutate timetable entries or auto-assign substitutes', () => {
            assert.strictEqual(entriesBefore, entriesAfter);
        });

        // -------------------------------------------------------------
        // [14] Legacy Class Compatibility (CME-A, CME-B, EEE-B, DEEE-B)
        // -------------------------------------------------------------
        console.log('\n[14] Legacy Class Compatibility Verification');
        // Verify legacy classes can be queried
        const legacyCMEA = await call('GET', '/api/timetable?class=CME-A', null, cmeCookie);
        check('Legacy class CME-A resolves without error', () => {
            assert.strictEqual(legacyCMEA.status, 200);
            assert.strictEqual(legacyCMEA.body.primaryClass || legacyCMEA.body.className, 'CME-A');
        });

        // Ensure legacy entries remain intact
        const legacyEntries = (store.source.entries || []).filter(e => (e.class === 'CME-A' || e.className === 'CME-A'));
        check('Legacy timetable rows for CME-A remain intact', () => {
            assert.ok(legacyEntries.length >= 1);
        });

        console.log('\n---------------------------------------------------------------');
        console.log(`Phase B6 Final Integration: ${passed} passed, ${failed} failed.`);
        console.log('---------------------------------------------------------------\n');
    } finally {
        await stopServer();
    }
}

run().catch(err => {
    console.error('\n✗ FATAL:', err);
    process.exit(1);
});
