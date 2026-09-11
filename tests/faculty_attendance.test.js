/**
 * Phase B7.2 — Faculty Attendance / Absence Test Suite
 *
 * Requirements:
 *  1. HOS can view attendance for their own branch.
 *  2. HOS can mark their own faculty ABSENT.
 *  3. HOS can mark faculty PRESENT again.
 *  4. Attendance is date-specific (absent on 2026-09-10 does not make them absent on 2026-09-11).
 *  5. Same faculty can be ABSENT on one date and PRESENT on another.
 *  6. Duplicate attendance records are prevented.
 *  7. HOS cannot modify another branch's faculty attendance (returns 403 FORBIDDEN).
 *  8. Faculty cannot modify attendance (returns 403 FORBIDDEN).
 *  9. Public users cannot modify attendance (returns 401 UNAUTHENTICATED).
 * 10. Faculty can view their own attendance (GET /api/attendance/my).
 * 11. Faculty cannot view another faculty's private attendance data.
 * 12. ABSENT faculty are excluded completely from availability on that date.
 * 13. PRESENT faculty continue through normal timetable availability logic (FREE or BUSY).
 * 14. Same-branch-first / other-branch-second availability ordering remains intact.
 * 15. Existing B6 functionality remains intact.
 * 16. Existing B7.1 registration workflow remains intact.
 */
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const attendance = require('../src/data/attendance');
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
    console.log('TecSubstitution — Phase B7.2 Faculty Attendance / Absence Tests');
    console.log('================================================================\n');

    await startServer();

    try {
        // [0] Reset state & pre-configure clean isolated branches
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();
        attendance.resetForTesting();

        console.log('[Setup] Registering HOS and Faculty accounts for CME and EEE');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos_b72',
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
            username: 'eee_hos_b72',
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

        // Login as Ravi (faculty)
        const raviLogin = await call('POST', '/api/auth/login', {
            username: 'ravi.cme',
            password: 'TecSub_123'
        });
        assert.strictEqual(raviLogin.status, 200);
        const cookieRavi = raviLogin.cookie;

        // Login as Kumar (faculty)
        const kumarLogin = await call('POST', '/api/auth/login', {
            username: 'kumar.cme',
            password: 'TecSub_123'
        });
        assert.strictEqual(kumarLogin.status, 200);
        const cookieKumar = kumarLogin.cookie;

        // Setup Timetable entry:
        // Thursday Period 3 (2026-09-10 is Thursday):
        // Suresh has a class on Thursday P3 (BUSY)
        // Ravi has NO class on Thursday P3 (FREE)
        // Kumar has NO class on Thursday P3 (will be tested as ABSENT)
        // Frank EEE has NO class on Thursday P3 (FREE, other branch)
        store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });

        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Thursday',
            period: 3,
            subject: 'Databases',
            faculty: 'Sri Suresh CME',
            room: 'C-201',
            type: 'theory'
        });

        // ==============================================================
        // [1] HOS Can View Own-Branch Attendance (Default: PRESENT)
        // ==============================================================
        console.log('\n[1] HOS Attendance View & Default Status');

        const viewAttRes = await call('GET', '/api/attendance?date=2026-09-10', null, cookieCme);
        await check('1. HOS can view attendance for own branch with 200 OK', () => {
            assert.strictEqual(viewAttRes.status, 200);
            assert.strictEqual(viewAttRes.body.branch, 'CME');
            assert.strictEqual(viewAttRes.body.date, '2026-09-10');
            assert.strictEqual(viewAttRes.body.dayOfWeek, 'Thursday');
            assert.strictEqual(viewAttRes.body.count, 3);
        });

        await check('Active faculty are PRESENT by default', () => {
            const facList = viewAttRes.body.faculty;
            const ravi = facList.find(f => f.name === 'Dr. Ravi CME');
            const kumar = facList.find(f => f.name === 'Prof. Kumar CME');
            const suresh = facList.find(f => f.name === 'Sri Suresh CME');

            assert.ok(ravi, 'Ravi must be listed');
            assert.ok(kumar, 'Kumar must be listed');
            assert.ok(suresh, 'Suresh must be listed');

            assert.strictEqual(ravi.status, 'PRESENT', 'Ravi must be PRESENT by default');
            assert.strictEqual(kumar.status, 'PRESENT', 'Kumar must be PRESENT by default');
            assert.strictEqual(suresh.status, 'PRESENT', 'Suresh must be PRESENT by default');
        });

        // ==============================================================
        // [2] & [3] Marking ABSENT and Marking PRESENT Again
        // ==============================================================
        console.log('\n[2] & [3] Marking ABSENT and PRESENT');

        // Mark Kumar ABSENT on 2026-09-10
        const markAbsentRes = await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieCme);

        await check('2. HOS can mark their own faculty ABSENT', () => {
            assert.strictEqual(markAbsentRes.status, 200);
            assert.strictEqual(markAbsentRes.body.success, true);
            assert.strictEqual(markAbsentRes.body.record.status, 'ABSENT');
            assert.strictEqual(markAbsentRes.body.record.date, '2026-09-10');
            assert.strictEqual(markAbsentRes.body.record.facultyName, 'Prof. Kumar CME');
        });

        // Verify view shows Kumar ABSENT
        const viewAfterAbsent = await call('GET', '/api/attendance?date=2026-09-10', null, cookieCme);
        await check('Branch attendance reflects ABSENT status for Kumar', () => {
            const kumar = viewAfterAbsent.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            assert.ok(kumar);
            assert.strictEqual(kumar.status, 'ABSENT');
            assert.ok(kumar.attendanceId, 'Must have attendanceId');
        });

        // Mark Kumar PRESENT again using POST with status PRESENT
        const markPresentRes = await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-10',
            status: 'PRESENT'
        }, cookieCme);

        await check('3. HOS can mark faculty PRESENT again', () => {
            assert.strictEqual(markPresentRes.status, 200);
            assert.strictEqual(markPresentRes.body.record.status, 'PRESENT');
        });

        const viewAfterPresent = await call('GET', '/api/attendance?date=2026-09-10', null, cookieCme);
        await check('Branch attendance reflects PRESENT status after updating', () => {
            const kumar = viewAfterPresent.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            assert.strictEqual(kumar.status, 'PRESENT');
        });

        // Mark Kumar ABSENT again for remaining tests
        const markAbsentAgain = await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieCme);
        assert.strictEqual(markAbsentAgain.status, 200);
        const attendanceRecordId = markAbsentAgain.body.record.id;

        // Also verify DELETE /api/attendance/:id restores default PRESENT
        const deleteAttRes = await call('DELETE', `/api/attendance/${attendanceRecordId}`, null, cookieCme);
        await check('DELETE /api/attendance/:id restores default PRESENT status', () => {
            assert.strictEqual(deleteAttRes.status, 200);
            assert.strictEqual(deleteAttRes.body.status, 'PRESENT');
        });

        // Re-mark Kumar ABSENT on 2026-09-10 for availability checks
        await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieCme);

        // ==============================================================
        // [4] & [5] Date Specificity & Multi-Date Independence
        // ==============================================================
        console.log('\n[4] & [5] Date Specificity & Multi-Date Independence');

        // Check Kumar's status on 2026-09-11 (the next day, Friday)
        const nextDayView = await call('GET', '/api/attendance?date=2026-09-11', null, cookieCme);
        await check('4. Attendance is date-specific: absence on Sep 10 does not affect Sep 11', () => {
            assert.strictEqual(nextDayView.status, 200);
            const kumarNextDay = nextDayView.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            assert.strictEqual(kumarNextDay.status, 'PRESENT', 'Kumar must be default PRESENT on 2026-09-11');
        });

        // Mark Ravi ABSENT on 2026-09-11, but keep him PRESENT on 2026-09-10
        await call('POST', '/api/attendance', {
            facultyId: raviId,
            date: '2026-09-11',
            status: 'ABSENT'
        }, cookieCme);

        const sep10View = await call('GET', '/api/attendance?date=2026-09-10', null, cookieCme);
        const sep11View = await call('GET', '/api/attendance?date=2026-09-11', null, cookieCme);

        await check('5. Same faculty can be ABSENT on one date and PRESENT on another', () => {
            const raviSep10 = sep10View.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            const raviSep11 = sep11View.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            assert.strictEqual(raviSep10.status, 'PRESENT', 'Ravi is PRESENT on Sep 10');
            assert.strictEqual(raviSep11.status, 'ABSENT', 'Ravi is ABSENT on Sep 11');

            const kumarSep10 = sep10View.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            const kumarSep11 = sep11View.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            assert.strictEqual(kumarSep10.status, 'ABSENT', 'Kumar is ABSENT on Sep 10');
            assert.strictEqual(kumarSep11.status, 'PRESENT', 'Kumar is PRESENT on Sep 11');
        });

        // ==============================================================
        // [6] Duplicate Attendance Prevention
        // ==============================================================
        console.log('\n[6] Duplicate Attendance Prevention');

        // Re-marking same faculty on same date updates in-place without duplicating
        const reMarkKumar = await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieCme);
        assert.strictEqual(reMarkKumar.status, 200);

        const checkDupView = await call('GET', '/api/attendance?date=2026-09-10', null, cookieCme);
        await check('6. Duplicate attendance records are prevented (exactly 1 record per faculty/date)', () => {
            const kumarEntries = checkDupView.body.faculty.filter(f => f.name === 'Prof. Kumar CME');
            assert.strictEqual(kumarEntries.length, 1, 'Kumar appears exactly once in branch roster');
        });

        // ==============================================================
        // [7], [8], & [9] Backend Security & Cross-Branch Authorization
        // ==============================================================
        console.log('\n[7], [8], & [9] Backend Security & Role Enforcement');

        // EEE HOS attempts to mark CME faculty (Kumar) absent -> 403
        const crossBranchMark = await call('POST', '/api/attendance', {
            facultyId: kumarId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieEee);

        await check('7. HOS cannot modify another branch\'s faculty attendance (HTTP 403)', () => {
            assert.strictEqual(crossBranchMark.status, 403);
            assert.strictEqual(crossBranchMark.body.code, 'FORBIDDEN');
        });

        // Faculty user attempts to mark attendance -> 403
        const facultyMark = await call('POST', '/api/attendance', {
            facultyId: raviId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieRavi);

        await check('8. Faculty cannot modify attendance (HTTP 403)', () => {
            assert.strictEqual(facultyMark.status, 403);
            assert.strictEqual(facultyMark.body.code, 'FORBIDDEN');
        });

        // Public unauthenticated user attempts to mark attendance -> 401
        const publicMark = await call('POST', '/api/attendance', {
            facultyId: raviId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, null);

        await check('9. Public users cannot modify attendance (HTTP 401)', () => {
            assert.strictEqual(publicMark.status, 401);
            assert.strictEqual(publicMark.body.code, 'UNAUTHENTICATED');
        });

        // Invalid date format rejected
        const badDateRes = await call('POST', '/api/attendance', {
            facultyId: raviId,
            date: 'not-a-date',
            status: 'ABSENT'
        }, cookieCme);
        await check('Invalid date format rejected with 400 INVALID_DATE', () => {
            assert.strictEqual(badDateRes.status, 400);
            assert.strictEqual(badDateRes.body.code, 'INVALID_DATE');
        });

        // Nonexistent faculty rejected
        const nonExistentFac = await call('POST', '/api/attendance', {
            facultyId: 'NONEXISTENT_9999',
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieCme);
        await check('Nonexistent faculty rejected with 404 NOT_FOUND', () => {
            assert.strictEqual(nonExistentFac.status, 404);
            assert.strictEqual(nonExistentFac.body.code, 'NOT_FOUND');
        });

        // ==============================================================
        // [10] & [11] Faculty Self-View (Read-Only)
        // ==============================================================
        console.log('\n[10] & [11] Faculty Self-View (Read-Only)');

        const raviMyAtt = await call('GET', '/api/attendance/my', null, cookieRavi);
        await check('10. Faculty can view their own attendance history with 200 OK', () => {
            assert.strictEqual(raviMyAtt.status, 200);
            assert.strictEqual(raviMyAtt.body.readOnly, true);
            assert.strictEqual(raviMyAtt.body.facultyName, 'Dr. Ravi CME');
            assert.ok(Array.isArray(raviMyAtt.body.records));
            // Ravi was marked absent on 2026-09-11
            const sep11Record = raviMyAtt.body.records.find(r => r.date === '2026-09-11');
            assert.ok(sep11Record, 'Ravi sees his 2026-09-11 record');
            assert.strictEqual(sep11Record.status, 'ABSENT');
        });

        const kumarMyAtt = await call('GET', '/api/attendance/my', null, cookieKumar);
        await check('11. Faculty cannot view another faculty\'s private attendance', () => {
            assert.strictEqual(kumarMyAtt.status, 200);
            assert.strictEqual(kumarMyAtt.body.facultyName, 'Prof. Kumar CME');
            // Kumar sees his own record on 2026-09-10
            const sep10Record = kumarMyAtt.body.records.find(r => r.date === '2026-09-10');
            assert.ok(sep10Record, 'Kumar sees his own 2026-09-10 record');
            // Kumar must not see Ravi's records
            const hasRaviRecord = kumarMyAtt.body.records.some(r => r.facultyName === 'Dr. Ravi CME');
            assert.strictEqual(hasRaviRecord, false, 'Kumar cannot see Ravi\'s attendance records');
        });

        // ==============================================================
        // [12] & [13] Availability Integration on Date
        // ==============================================================
        console.log('\n[12] & [13] Availability Integration with Date & Absence');

        // Check availability for Thursday Period 3 on date 2026-09-10
        // State on 2026-09-10 Thursday P3:
        // - Dr. Ravi CME: PRESENT + no class -> FREE
        // - Sri Suresh CME: PRESENT + timetable class (Databases) -> BUSY
        // - Prof. Kumar CME: ABSENT for the day -> EXCLUDED COMPLETELY
        // - Prof. Frank EEE: PRESENT + no class -> FREE (Other branch)
        const availSep10P3 = await call('POST', '/api/availability', {
            date: '2026-09-10',
            period: 3
        }, cookieCme);

        await check('Availability request for date returns 200 OK with date metadata', () => {
            assert.strictEqual(availSep10P3.status, 200);
            assert.strictEqual(availSep10P3.body.date, '2026-09-10');
            assert.strictEqual(availSep10P3.body.day, 'Thursday');
            assert.strictEqual(availSep10P3.body.period, 3);
        });

        await check('12. ABSENT faculty (Kumar) is EXCLUDED completely from availability', () => {
            const availNames = availSep10P3.body.availableFaculty || [];
            const freeList = availSep10P3.body.available || [];
            const busyList = availSep10P3.body.busy || [];
            const unifiedList = availSep10P3.body.faculty || [];

            assert.ok(!availNames.includes('Prof. Kumar CME'), 'Kumar must NOT be in availableFaculty');
            assert.ok(!freeList.some(f => f.faculty === 'Prof. Kumar CME'), 'Kumar must NOT be in available list');
            assert.ok(!busyList.some(f => f.faculty === 'Prof. Kumar CME'), 'Kumar must NOT be in busy list');
            assert.ok(!unifiedList.some(f => f.name === 'Prof. Kumar CME'), 'Kumar must NOT be in unified faculty list');
        });

        await check('13. PRESENT faculty continue through normal timetable logic (Ravi FREE, Suresh BUSY)', () => {
            const freeList = availSep10P3.body.available || [];
            const busyList = availSep10P3.body.busy || [];

            const raviFree = freeList.find(f => f.faculty === 'Dr. Ravi CME');
            assert.ok(raviFree, 'Ravi must be reported FREE');
            assert.strictEqual(raviFree.status, 'free');

            const sureshBusy = busyList.find(f => f.faculty === 'Sri Suresh CME');
            assert.ok(sureshBusy, 'Suresh must be reported BUSY due to timetable class');
            assert.strictEqual(sureshBusy.status, 'busy');
            assert.strictEqual(sureshBusy.subject, 'Databases');
        });

        // ==============================================================
        // [14] Cross-Branch Availability Preservation (B6 Rule)
        // ==============================================================
        console.log('\n[14] Cross-Branch Availability with Absence Filter');

        await check('14. Same-branch FREE faculty appear first, other-branch FREE faculty second', () => {
            const availNames = availSep10P3.body.availableFaculty || [];
            const raviIdx = availNames.indexOf('Dr. Ravi CME');
            const frankIdx = availNames.indexOf('Prof. Frank EEE');

            assert.ok(raviIdx !== -1, 'Ravi (CME) must be in availableFaculty');
            assert.ok(frankIdx !== -1, 'Frank (EEE) must be in availableFaculty');
            assert.ok(raviIdx < frankIdx, 'Same-branch CME faculty (Ravi) must precede other-branch EEE faculty (Frank)');

            assert.strictEqual(availSep10P3.body.sameBranch.totalAvailable, 1, '1 same-branch faculty free (Ravi)');
            assert.strictEqual(availSep10P3.body.otherBranches.totalAvailable, 1, '1 other-branch faculty free (Frank)');
        });

        // If other-branch faculty Frank EEE is marked ABSENT on 2026-09-10
        await call('POST', '/api/attendance', {
            facultyId: frankId,
            date: '2026-09-10',
            status: 'ABSENT'
        }, cookieEee);

        const availAfterFrankAbsent = await call('POST', '/api/availability', {
            date: '2026-09-10',
            period: 3
        }, cookieCme);

        await check('Other-branch faculty marked ABSENT is also excluded from cross-branch list', () => {
            const availNames = availAfterFrankAbsent.body.availableFaculty || [];
            assert.ok(!availNames.includes('Prof. Frank EEE'), 'Frank EEE must be excluded when absent');
            assert.ok(availNames.includes('Dr. Ravi CME'), 'Ravi CME remains available');
        });

        // ==============================================================
        // [15] & [16] Existing B6 & B7.1 Functionality Remains Intact
        // ==============================================================
        console.log('\n[15] & [16] Regression Safety: B6 and B7.1 Integrity');

        // B6: Availability query without date still works 100% normally
        const noDateAvail = await call('POST', '/api/availability', {
            day: 'Thursday',
            period: 3
        }, cookieCme);

        await check('15. Backward compatibility: availability queries without date work as before', () => {
            assert.strictEqual(noDateAvail.status, 200);
            assert.strictEqual(noDateAvail.body.day, 'Thursday');
            assert.strictEqual(noDateAvail.body.period, 3);
            assert.ok(noDateAvail.body.availableFaculty.includes('Dr. Ravi CME'));
        });

        // B7.1: Faculty self-registration request works normally
        const regReq = await call('POST', '/api/faculty-requests', {
            name: 'New Applicant',
            phone: '9888877770',
            username: 'applicant.cme',
            password: 'TecSub_123',
            branchCode: 'CME',
            subjects: ['Computer Networks']
        });

        await check('16. B7.1 faculty self-registration requests remain fully functional', () => {
            assert.strictEqual(regReq.status, 201);
            assert.strictEqual(regReq.body.success, true);
            assert.strictEqual(regReq.body.request.status, 'PENDING');
        });

        console.log('\n================================================================');
        console.log(`Phase B7.2 Attendance Tests: ${passed} passed, ${failed} failed.`);
        console.log('================================================================\n');

    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Test run error:', err);
        process.exit(1);
    });
}

module.exports = { run };
