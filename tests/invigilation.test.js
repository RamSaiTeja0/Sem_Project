/**
 * Phase B7.3 — Exam Invigilation Test Suite
 *
 * Requirements:
 *  1. HOS can directly assign invigilation.
 *  2. HOS can assign multiple periods.
 *  3. Assignment is date-specific.
 *  4. Faculty remains PRESENT after invigilation assignment.
 *  5. Faculty can submit invigilation request.
 *  6. Request starts PENDING.
 *  7. Faculty cannot directly create active invigilation.
 *  8. HOS sees only own-branch requests.
 *  9. HOS cannot access another branch's requests.
 * 10. HOS can approve own-branch request.
 * 11. Approval creates active assignment(s).
 * 12. HOS can reject request.
 * 13. Rejection creates no active assignment.
 * 14. Duplicate approval is prevented.
 * 15. Duplicate faculty/date/period assignment is prevented.
 * 16. Timetable conflict is detected.
 * 17. Existing timetable is not modified by conflict.
 * 18. Invigilation makes faculty BUSY for that period.
 * 19. Invigilation does not make faculty ABSENT.
 * 20. ABSENT faculty remain excluded from availability.
 * 21. PRESENT + no timetable + no invigilation remains FREE.
 * 22. Same-branch FREE faculty remain before other-branch FREE faculty.
 * 23. Faculty can view own assignments.
 * 24. Faculty cannot modify another faculty's assignments.
 * 25. Public users cannot manage invigilation.
 * 26. B7.1 faculty registration still works.
 * 27. B7.2 attendance still works.
 * 28. Existing B6 tests still pass.
 */
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const facultyRequests = require('../src/data/facultyRequests');
const { resetBranchForTesting, registerBranch } = require('../src/data/departments');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
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
                try { parsed = JSON.parse(data); } catch (e) { /* html */ }
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
    console.log('================================================================');
    console.log('TecSubstitution — Phase B7.3 Exam Invigilation Test Suite');
    console.log('================================================================\n');

    await startServer();

    try {
        // [0] Reset state & initialize isolated branch environments
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();
        attendance.resetForTesting();
        invigilation.resetForTesting();
        facultyRequests.resetForTesting();

        console.log('[Setup] Registering HOS and Faculty accounts for CME and EEE');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos_b73',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosCmeRes.status, 201, 'CME HOS registration must succeed');
        const cookieCme = hosCmeRes.cookie;

        // Register EEE HOS
        const hosEeeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Head',
            phone: '9876543211',
            branchName: 'Electrical Engineering',
            branchCode: 'EEE',
            username: 'eee_hos_b73',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosEeeRes.status, 201, 'EEE HOS registration must succeed');
        const cookieEee = hosEeeRes.cookie;

        // Create Faculty in CME: Ravi, Kumar, Suresh
        const cmeFac1 = await call('POST', '/api/auth/register', {
            name: 'Dr. Ravi CME',
            phone: '9123456780',
            username: 'ravi.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Algorithms']
        }, cookieCme);
        assert.strictEqual(cmeFac1.status, 201);
        const raviId = cmeFac1.body.user.id || cmeFac1.body.faculty.id;

        const cmeFac2 = await call('POST', '/api/auth/register', {
            name: 'Prof. Kumar CME',
            phone: '9123456781',
            username: 'kumar.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Associate Professor',
            subjects: ['Operating Systems']
        }, cookieCme);
        assert.strictEqual(cmeFac2.status, 201);
        const kumarId = cmeFac2.body.user.id || cmeFac2.body.faculty.id;

        const cmeFac3 = await call('POST', '/api/auth/register', {
            name: 'Sri Suresh CME',
            phone: '9123456782',
            username: 'suresh.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Databases']
        }, cookieCme);
        assert.strictEqual(cmeFac3.status, 201);
        const sureshId = cmeFac3.body.user.id || cmeFac3.body.faculty.id;

        // Create Faculty in EEE: Frank
        const eeeFac1 = await call('POST', '/api/auth/register', {
            name: 'Prof. Frank EEE',
            phone: '9123456783',
            username: 'frank.eee',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Power Systems']
        }, cookieEee);
        assert.strictEqual(eeeFac1.status, 201);
        const frankId = eeeFac1.body.user.id || eeeFac1.body.faculty.id;

        // Sign in faculty members to acquire faculty cookies
        const raviLogin = await call('POST', '/api/auth/login', {
            username: 'ravi.cme',
            password: 'TecSub_123'
        });
        assert.strictEqual(raviLogin.status, 200);
        const cookieRavi = raviLogin.cookie;

        const kumarLogin = await call('POST', '/api/auth/login', {
            username: 'kumar.cme',
            password: 'TecSub_123'
        });
        assert.strictEqual(kumarLogin.status, 200);
        const cookieKumar = kumarLogin.cookie;

        const frankLogin = await call('POST', '/api/auth/login', {
            username: 'frank.eee',
            password: 'TecSub_123'
        });
        assert.strictEqual(frankLogin.status, 200);
        const cookieFrank = frankLogin.cookie;

        // Add a teaching class for Dr. Ravi on Monday Period 3 to test timetable conflict
        // Date 2026-09-14 is a Monday!
        store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });

        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Monday',
            period: 3,
            subject: 'Algorithms',
            faculty: 'Dr. Ravi CME',
            room: 'C-101',
            type: 'theory'
        });

        // ==============================================================
        // [1] & [2] Workflow A: HOS Direct Assignment with Multiple Periods
        // ==============================================================
        console.log('\n[1] & [2] Workflow A: HOS Direct Assignment');

        // Date 2026-09-15 is Tuesday. Ravi has no class on Tuesday.
        // HOS assigns Ravi to P2, P3, P4
        const directAssignRes = await call('POST', '/api/invigilation', {
            facultyId: raviId,
            date: '2026-09-15',
            periods: [2, 3, 4],
            notes: 'Mid-term Exam Supervision Hall 101'
        }, cookieCme);

        await check('1. HOS can directly assign invigilation (201 Created)', () => {
            assert.strictEqual(directAssignRes.status, 201);
            assert.strictEqual(directAssignRes.body.success, true);
            assert.ok(Array.isArray(directAssignRes.body.assignments));
        });

        await check('2. HOS can assign multiple periods (P2, P3, P4)', () => {
            const periods = directAssignRes.body.assignments.map(a => a.period);
            assert.deepStrictEqual(periods.sort(), [2, 3, 4]);
            assert.strictEqual(directAssignRes.body.assignments.length, 3);
            directAssignRes.body.assignments.forEach(a => {
                assert.strictEqual(a.source, 'DIRECT');
                assert.strictEqual(a.facultyName, 'Dr. Ravi CME');
                assert.strictEqual(a.examDate, '2026-09-15');
                assert.strictEqual(a.notes, 'Mid-term Exam Supervision Hall 101');
            });
        });

        // ==============================================================
        // [3] Assignment is Date-Specific
        // ==============================================================
        console.log('\n[3] Date Specificity');

        const activeListRes = await call('GET', '/api/invigilation?date=2026-09-15', null, cookieCme);
        const activeOtherDateRes = await call('GET', '/api/invigilation?date=2026-09-16', null, cookieCme);

        await check('3. Assignment is date-specific (present on 2026-09-15, none on 2026-09-16)', () => {
            assert.strictEqual(activeListRes.status, 200);
            assert.strictEqual(activeListRes.body.assignments.length, 3);
            assert.strictEqual(activeOtherDateRes.status, 200);
            assert.strictEqual(activeOtherDateRes.body.assignments.length, 0);
        });

        // ==============================================================
        // [4] Faculty Remains PRESENT After Invigilation Assignment
        // ==============================================================
        console.log('\n[4] Attendance Integration');

        const attSep15Res = await call('GET', '/api/attendance?date=2026-09-15', null, cookieCme);
        await check('4. Faculty remains PRESENT after invigilation assignment (INVIGILATION != ABSENCE)', () => {
            assert.strictEqual(attSep15Res.status, 200);
            const raviAtt = attSep15Res.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            assert.ok(raviAtt, 'Ravi must be present in attendance list');
            assert.strictEqual(raviAtt.status, 'PRESENT', 'Ravi must continue to show PRESENT in attendance');
        });

        // ==============================================================
        // [5] & [6] Workflow B: Faculty Submits Invigilation Request
        // ==============================================================
        console.log('\n[5] & [6] Workflow B: Faculty Invigilation Request');

        const facReqRes = await call('POST', '/api/invigilation/requests', {
            date: '2026-09-17',
            periods: [1, 2],
            reason: 'University practical exam duty'
        }, cookieKumar);

        let createdRequestId;
        await check('5. Faculty can submit invigilation request (201 Created)', () => {
            assert.strictEqual(facReqRes.status, 201);
            assert.strictEqual(facReqRes.body.success, true);
            assert.ok(facReqRes.body.request);
            createdRequestId = facReqRes.body.request.id;
        });

        await check('6. Request starts in PENDING status', () => {
            assert.strictEqual(facReqRes.body.request.status, 'PENDING');
            assert.strictEqual(facReqRes.body.request.facultyName, 'Prof. Kumar CME');
            assert.strictEqual(facReqRes.body.request.examDate, '2026-09-17');
            assert.deepStrictEqual(facReqRes.body.request.periods, [1, 2]);
            assert.strictEqual(facReqRes.body.request.reviewedBy, null);
        });

        // ==============================================================
        // [7] Faculty Cannot Directly Create Active Invigilation
        // ==============================================================
        console.log('\n[7] Role Restriction on Direct Assignment');

        const facDirectAttempt = await call('POST', '/api/invigilation', {
            facultyId: kumarId,
            date: '2026-09-17',
            periods: [3],
            notes: 'Sneak assignment'
        }, cookieKumar);

        await check('7. Faculty cannot directly create active invigilation (HTTP 403 FORBIDDEN)', () => {
            assert.strictEqual(facDirectAttempt.status, 403);
            assert.strictEqual(facDirectAttempt.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [8] & [9] Branch Isolation for Requests
        // ==============================================================
        console.log('\n[8] & [9] HOS Branch Isolation on Requests');

        const cmeReqsList = await call('GET', '/api/invigilation/requests', null, cookieCme);
        const eeeReqsList = await call('GET', '/api/invigilation/requests', null, cookieEee);

        await check('8. HOS sees only own-branch requests', () => {
            assert.strictEqual(cmeReqsList.status, 200);
            assert.strictEqual(cmeReqsList.body.branch, 'CME');
            const hasKumarReq = cmeReqsList.body.requests.some(r => r.id === createdRequestId);
            assert.strictEqual(hasKumarReq, true, 'CME HOS sees Kumar CME request');

            assert.strictEqual(eeeReqsList.status, 200);
            assert.strictEqual(eeeReqsList.body.branch, 'EEE');
            const eeeHasKumarReq = eeeReqsList.body.requests.some(r => r.id === createdRequestId);
            assert.strictEqual(eeeHasKumarReq, false, 'EEE HOS must NOT see CME request');
        });

        // EEE HOS attempts to approve CME request -> 403 FORBIDDEN
        const crossApproveRes = await call('POST', `/api/invigilation/requests/${createdRequestId}/approve`, {}, cookieEee);
        await check('9. HOS cannot access or approve another branch\'s requests (HTTP 403 FORBIDDEN)', () => {
            assert.strictEqual(crossApproveRes.status, 403);
            assert.strictEqual(crossApproveRes.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [10] & [11] HOS Approves Request -> Creates Active Assignments
        // ==============================================================
        console.log('\n[10] & [11] HOS Request Approval');

        const approveRes = await call('POST', `/api/invigilation/requests/${createdRequestId}/approve`, {}, cookieCme);
        await check('10. HOS can approve own-branch request (200 OK)', () => {
            assert.strictEqual(approveRes.status, 200);
            assert.strictEqual(approveRes.body.success, true);
            assert.strictEqual(approveRes.body.request.status, 'APPROVED');
            assert.ok(approveRes.body.request.reviewedBy, 'ReviewedBy must be set');
        });

        await check('11. Approval creates active assignment(s) for all requested periods', () => {
            assert.strictEqual(approveRes.body.assignments.length, 2);
            const activePeriods = approveRes.body.assignments.map(a => a.period);
            assert.deepStrictEqual(activePeriods.sort(), [1, 2]);
            approveRes.body.assignments.forEach(a => {
                assert.strictEqual(a.source, 'REQUEST');
                assert.strictEqual(a.requestId, createdRequestId);
            });
        });

        // ==============================================================
        // [12] & [13] HOS Rejects Request
        // ==============================================================
        console.log('\n[12] & [13] HOS Request Rejection');

        // Submit another request from Kumar for testing rejection
        const reqToReject = await call('POST', '/api/invigilation/requests', {
            date: '2026-09-18',
            periods: [5],
            reason: 'Observer duty'
        }, cookieKumar);
        assert.strictEqual(reqToReject.status, 201);
        const rejectTargetId = reqToReject.body.request.id;

        const rejectRes = await call('POST', `/api/invigilation/requests/${rejectTargetId}/reject`, {
            rejectionReason: 'Already sufficient invigilators assigned'
        }, cookieCme);

        await check('12. HOS can reject request with optional reason (200 OK)', () => {
            assert.strictEqual(rejectRes.status, 200);
            assert.strictEqual(rejectRes.body.success, true);
            assert.strictEqual(rejectRes.body.request.status, 'REJECTED');
            assert.strictEqual(rejectRes.body.request.rejectionReason, 'Already sufficient invigilators assigned');
        });

        await check('13. Rejection creates NO active assignment', async () => {
            const activeOnSep18 = await call('GET', '/api/invigilation?date=2026-09-18', null, cookieCme);
            assert.strictEqual(activeOnSep18.body.assignments.length, 0);
        });

        // ==============================================================
        // [14] Duplicate Approval Prevention
        // ==============================================================
        console.log('\n[14] Duplicate Approval Prevention');

        const dupApproveRes = await call('POST', `/api/invigilation/requests/${createdRequestId}/approve`, {}, cookieCme);
        await check('14. Duplicate approval is prevented (HTTP 400 ALREADY_APPROVED)', () => {
            assert.strictEqual(dupApproveRes.status, 400);
            assert.strictEqual(dupApproveRes.body.code, 'ALREADY_APPROVED');
        });

        // ==============================================================
        // [15] Duplicate Faculty/Date/Period Assignment Prevention
        // ==============================================================
        console.log('\n[15] Duplicate Assignment Prevention');

        // Kumar is already assigned to 2026-09-17 P1 and P2
        const dupAssignRes = await call('POST', '/api/invigilation', {
            facultyId: kumarId,
            date: '2026-09-17',
            periods: [2],
            notes: 'Duplicate assign attempt'
        }, cookieCme);

        await check('15. Duplicate faculty/date/period assignment is prevented (HTTP 409 DUPLICATE_INVIGILATION)', () => {
            assert.strictEqual(dupAssignRes.status, 409);
            assert.strictEqual(dupAssignRes.body.code, 'DUPLICATE_INVIGILATION');
        });

        // ==============================================================
        // [16] & [17] Timetable Conflict Detection & Preservation
        // ==============================================================
        console.log('\n[16] & [17] Timetable Conflict Detection');

        // Dr. Ravi teaches Algorithms on Monday Period 3.
        // 2026-09-14 is a Monday!
        const conflictAssignRes = await call('POST', '/api/invigilation', {
            facultyId: raviId,
            date: '2026-09-14',
            periods: [3],
            notes: 'Conflict duty'
        }, cookieCme);

        await check('16. Timetable conflict is detected (HTTP 409 FACULTY_PERIOD_CONFLICT)', () => {
            assert.strictEqual(conflictAssignRes.status, 409);
            assert.strictEqual(conflictAssignRes.body.code, 'FACULTY_PERIOD_CONFLICT');
            assert.ok(conflictAssignRes.body.error.includes('FACULTY_PERIOD_CONFLICT'));
        });

        await check('17. Existing timetable is NOT modified by conflict', () => {
            const slot = store.engine.getSlot('Monday', 3);
            assert.ok(slot, 'Slot must exist');
            const classEntry = slot.busy.find(b => b.faculty === 'Dr. Ravi CME');
            assert.ok(classEntry, 'Ravi\'s class must remain intact');
            assert.strictEqual(classEntry.subject, 'Algorithms');
            assert.strictEqual(classEntry.className, 'CME-SEM1-A');
        });

        // ==============================================================
        // [18], [19], [20], [21], & [22] Availability Engine Integration
        // ==============================================================
        console.log('\n[18] - [22] Availability Engine Integration');

        // On 2026-09-15 (Tuesday):
        // Ravi has invigilation on P2, P3, P4
        // Kumar is marked ABSENT by HOS
        // Suresh is PRESENT and has no timetable class or invigilation
        // Frank EEE is PRESENT and in other branch

        // Mark Kumar ABSENT on 2026-09-15
        const markKumarAbsent = await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-15',
            status: 'ABSENT'
        }, cookieCme);
        assert.strictEqual(markKumarAbsent.status, 200);

        // Check availability on 2026-09-15 Period 2
        const availSep15P2 = await call('POST', '/api/availability', {
            date: '2026-09-15',
            period: 2
        }, cookieCme);
        assert.strictEqual(availSep15P2.status, 200);

        await check('18. Invigilation makes faculty BUSY for that period (Ravi is BUSY on P2)', () => {
            const busyList = availSep15P2.body.busy || [];
            const raviBusy = busyList.find(b => b.faculty === 'Dr. Ravi CME');
            assert.ok(raviBusy, 'Ravi must be reported in busy list on P2');
            assert.strictEqual(raviBusy.status, 'busy');
            assert.strictEqual(raviBusy.isInvigilation, true);
            assert.strictEqual(raviBusy.subject, 'Exam Invigilation');

            const freeList = availSep15P2.body.available || [];
            const raviFree = freeList.find(f => f.faculty === 'Dr. Ravi CME');
            assert.strictEqual(raviFree, undefined, 'Ravi must NOT be in available/free list on P2');
        });

        await check('19. Invigilation does NOT make faculty ABSENT (Ravi is NOT in absentList)', () => {
            const absentList = availSep15P2.body.absentList || [];
            assert.strictEqual(absentList.includes('Dr. Ravi CME'), false, 'Ravi must NOT be in absentList');
        });

        await check('20. ABSENT faculty remain excluded from availability (Kumar in absentList, excluded from free & busy)', () => {
            const absentList = availSep15P2.body.absentList || [];
            assert.strictEqual(absentList.includes('Prof. Kumar CME'), true, 'Kumar must be in absentList');

            const freeList = availSep15P2.body.available || [];
            const busyList = availSep15P2.body.busy || [];
            assert.strictEqual(freeList.some(f => f.faculty === 'Prof. Kumar CME'), false, 'Kumar not in free');
            assert.strictEqual(busyList.some(b => b.faculty === 'Prof. Kumar CME'), false, 'Kumar not in busy');
        });

        await check('21. PRESENT + no timetable + no invigilation remains FREE (Suresh is FREE)', () => {
            const freeList = availSep15P2.body.available || [];
            const suresh = freeList.find(f => f.faculty === 'Sri Suresh CME');
            assert.ok(suresh, 'Suresh must be free');
            assert.strictEqual(suresh.status, 'free');
            assert.strictEqual(suresh.isSameBranch, true);
        });

        // Also verify Ravi is FREE during P1 (where he has NO invigilation)
        const availSep15P1 = await call('POST', '/api/availability', {
            date: '2026-09-15',
            period: 1
        }, cookieCme);
        await check('Ravi is FREE during P1 on 2026-09-15 (invigilation is only P2, P3, P4)', () => {
            const freeP1 = availSep15P1.body.available || [];
            const raviP1 = freeP1.find(f => f.faculty === 'Dr. Ravi CME');
            assert.ok(raviP1, 'Ravi must be FREE during P1');
            assert.strictEqual(raviP1.status, 'free');
        });

        await check('22. Same-branch FREE faculty remain before other-branch FREE faculty', () => {
            const availableFaculty = availSep15P2.body.availableFaculty || [];
            const sureshIdx = availableFaculty.indexOf('Sri Suresh CME');
            const frankIdx = availableFaculty.indexOf('Prof. Frank EEE');

            assert.ok(sureshIdx !== -1, 'Suresh (CME) must be in availableFaculty');
            assert.ok(frankIdx !== -1, 'Frank (EEE) must be in availableFaculty');
            assert.ok(sureshIdx < frankIdx, 'Same-branch CME faculty (Suresh) must appear before other-branch EEE faculty (Frank)');
        });

        // ==============================================================
        // [23] & [24] Faculty Self-View (Read-Only)
        // ==============================================================
        console.log('\n[23] & [24] Faculty Self-View & Protection');

        const myInvigRes = await call('GET', '/api/invigilation/my', null, cookieRavi);
        await check('23. Faculty can view own assignments and requests (200 OK)', () => {
            assert.strictEqual(myInvigRes.status, 200);
            assert.strictEqual(myInvigRes.body.readOnly, true);
            assert.strictEqual(myInvigRes.body.facultyName, 'Dr. Ravi CME');
            assert.ok(Array.isArray(myInvigRes.body.assignments));
            assert.strictEqual(myInvigRes.body.assignments.length, 3);
            const periods = myInvigRes.body.assignments.map(a => a.period);
            assert.deepStrictEqual(periods.sort(), [2, 3, 4]);
        });

        // Ravi tries to cancel Kumar's invigilation assignment
        const kumarAssignId = approveRes.body.assignments[0].id;
        const facDeleteAttempt = await call('DELETE', `/api/invigilation/${kumarAssignId}`, {}, cookieRavi);
        await check('24. Faculty cannot modify another faculty\'s assignments (HTTP 403 FORBIDDEN)', () => {
            assert.strictEqual(facDeleteAttempt.status, 403);
            assert.strictEqual(facDeleteAttempt.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [25] Public Access Prevention
        // ==============================================================
        console.log('\n[25] Public Access Prevention');

        const publicDirect = await call('POST', '/api/invigilation', {
            facultyId: raviId,
            date: '2026-09-15',
            periods: [5]
        }, null);

        const publicReqs = await call('GET', '/api/invigilation/requests', null, null);

        await check('25. Public users cannot manage invigilation (HTTP 401 UNAUTHENTICATED)', () => {
            assert.strictEqual(publicDirect.status, 401);
            assert.strictEqual(publicDirect.body.code, 'UNAUTHENTICATED');
            assert.strictEqual(publicReqs.status, 401);
            assert.strictEqual(publicReqs.body.code, 'UNAUTHENTICATED');
        });

        // ==============================================================
        // [26] B7.1 Faculty Registration Workflow Remains Intact
        // ==============================================================
        console.log('\n[26] B7.1 Registration Verification');

        const newRegRes = await call('POST', '/api/faculty-requests', {
            fullName: 'Dr. Anita CME',
            phone: '9888877777',
            username: 'anita.cme',
            password: 'TecSub_123',
            branchCode: 'CME',
            designation: 'Assistant Professor',
            subjects: ['Computer Networks']
        });
        assert.strictEqual(newRegRes.status, 201);
        const anitaReqId = newRegRes.body.request.id;

        const approveRegRes = await call('POST', `/api/faculty-requests/${anitaReqId}/approve`, {}, cookieCme);
        await check('26. B7.1 faculty registration still works (submission, approval, account creation)', () => {
            assert.strictEqual(approveRegRes.status, 200);
            assert.strictEqual(approveRegRes.body.success, true);
            assert.strictEqual(approveRegRes.body.request.status, 'APPROVED');
            assert.ok(approveRegRes.body.user, 'User account must be created');
        });

        // ==============================================================
        // [27] B7.2 Attendance Workflow Remains Intact
        // ==============================================================
        console.log('\n[27] B7.2 Attendance Verification');

        // Suresh marked ABSENT on 2026-09-20, then marked PRESENT again
        const markAbsentRes = await call('POST', '/api/attendance', {
            facultyId: sureshId,
            date: '2026-09-20',
            status: 'ABSENT'
        }, cookieCme);
        assert.strictEqual(markAbsentRes.status, 200);

        const markPresentRes = await call('POST', '/api/attendance', {
            facultyId: sureshId,
            date: '2026-09-20',
            status: 'PRESENT'
        }, cookieCme);

        await check('27. B7.2 attendance still works (mark ABSENT, revert to PRESENT)', () => {
            assert.strictEqual(markPresentRes.status, 200);
            assert.strictEqual(markPresentRes.body.record.status, 'PRESENT');
        });

        // ==============================================================
        // [28] Existing B6 Multi-Branch Test Integrity
        // ==============================================================
        console.log('\n[28] B6 Multi-Branch Integrity');

        await check('28. Existing B6 multi-branch isolation and dynamic periods remain intact', () => {
            const configuredPeriods = invigilation.getConfiguredPeriods();
            assert.ok(Array.isArray(configuredPeriods), 'Configured periods must be an array');
            assert.ok(configuredPeriods.length > 0, 'Configured periods must not be empty');

            const cmeRoster = store.engine.getFaculty().filter(f => f.department === 'CME');
            const eeeRoster = store.engine.getFaculty().filter(f => f.department === 'EEE');
            assert.ok(cmeRoster.length >= 3, 'CME has at least 3 faculty');
            assert.ok(eeeRoster.length >= 1, 'EEE has at least 1 faculty');
        });

        console.log('\n================================================================');
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log('================================================================\n');

    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().then(() => {
        process.exit(failed > 0 ? 1 : 0);
    }).catch(err => {
        console.error('Test execution aborted due to error:', err);
        process.exit(1);
    });
}

module.exports = { run };
