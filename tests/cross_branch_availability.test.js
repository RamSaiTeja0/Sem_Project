/**
 * Phase B6.3 — Cross-Branch Faculty Availability Test Suite
 *
 * Requirements:
 *  1. Same-branch FREE faculty appear first.
 *  2. Other-branch FREE faculty appear after same-branch faculty.
 *  3. Busy same-branch faculty are excluded.
 *  4. Busy other-branch faculty are excluded.
 *  5. Inactive same-branch faculty are excluded.
 *  6. Inactive other-branch faculty are excluded.
 *  7. A newly created branch automatically participates.
 *  8. New branch faculty appear without modifying a hard-coded branch list.
 *  9. Multiple future branches are supported dynamically.
 * 10. Branch priority is based on the absent faculty's actual branch.
 * 11. No automatic substitute assignment occurs.
 * 12. Dynamic state transitions (Free -> Busy -> Inactive) correctly alter availability.
 * 13. Cross-branch HOS tampering / spoofing returns 403 FORBIDDEN.
 * 14. Timetable data integrity preserved (read-only guarantee).
 */
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting, registerBranch, getRegisteredBranchCodes } = require('../src/data/departments');

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
    console.log('====================================');
    console.log('TecSubstitution — Phase B6.3 Cross-Branch Availability Tests');
    console.log('====================================\n');

    await startServer();

    try {
        // [0] Reset state & pre-configure clean isolated branches
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();

        console.log('[Setup] Registering HOS and Faculty accounts for CME and EEE');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos_b63',
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
            username: 'eee_hos_b63',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosEeeRes.status, 201, 'EEE HOS registration must succeed');
        const cookieEee = hosEeeRes.cookie;

        // Create Faculty in CME
        const cmeFac1 = await call('POST', '/api/auth/register', {
            name: 'Dr. Alice CME',
            phone: '9123456780',
            username: 'alice.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Data Structures']
        }, cookieCme);
        assert.strictEqual(cmeFac1.status, 201);
        const aliceId = cmeFac1.body.user.id || cmeFac1.body.faculty.id;

        const cmeFac2 = await call('POST', '/api/auth/register', {
            name: 'Prof. Bob CME',
            phone: '9123456781',
            username: 'bob.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Associate Professor',
            subjects: ['Algorithms']
        }, cookieCme);
        assert.strictEqual(cmeFac2.status, 201);
        const bobId = cmeFac2.body.user.id || cmeFac2.body.faculty.id;

        const cmeFac3 = await call('POST', '/api/auth/register', {
            name: 'Sri Charlie CME',
            phone: '9123456782',
            username: 'charlie.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Databases']
        }, cookieCme);
        assert.strictEqual(cmeFac3.status, 201);
        const charlieId = cmeFac3.body.user.id || cmeFac3.body.faculty.id;

        // Create Faculty in EEE
        const eeeFac1 = await call('POST', '/api/auth/register', {
            name: 'Dr. Edward EEE',
            phone: '9123456783',
            username: 'edward.eee',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Power Systems']
        }, cookieEee);
        assert.strictEqual(eeeFac1.status, 201);
        const edwardId = eeeFac1.body.user.id || eeeFac1.body.faculty.id;

        const eeeFac2 = await call('POST', '/api/auth/register', {
            name: 'Prof. Frank EEE',
            phone: '9123456784',
            username: 'frank.eee',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Associate Professor',
            subjects: ['Circuit Theory']
        }, cookieEee);
        assert.strictEqual(eeeFac2.status, 201);
        const frankId = eeeFac2.body.user.id || eeeFac2.body.faculty.id;

        // Schedule initial timetable entries for Monday Period 1:
        // - Dr. Alice CME teaches CME class on Monday P1 (BUSY)
        // - Dr. Edward EEE teaches EEE class on Monday P1 (BUSY)
        // - Prof. Bob CME has no class on Monday P1 (FREE)
        // - Sri Charlie CME has no class on Monday P1 (FREE)
        // - Prof. Frank EEE has no class on Monday P1 (FREE)

        store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });
        store.resolveOrCreateClassInMemory({
            branch: 'EEE',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });

        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Monday',
            period: 1,
            subject: 'Data Structures',
            faculty: 'Dr. Alice CME',
            room: 'C-101',
            type: 'theory'
        });

        store.addEntryInMemory({
            className: 'EEE-SEM1-A',
            day: 'Monday',
            period: 1,
            subject: 'Power Systems',
            faculty: 'Dr. Edward EEE',
            room: 'E-101',
            type: 'theory'
        });

        // ==============================================================
        // [1] & [2] Same-Branch vs Other-Branch Priority Ordering
        // ==============================================================
        console.log('\n[1] & [2] Priority Ordering: Same Branch First, Other Branches After');

        // Query availability for absent CME faculty: Dr. Alice CME on Monday Period 1
        const availCmeAbsent = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('Availability request succeeds with HTTP 200', () => {
            assert.strictEqual(availCmeAbsent.status, 200);
            assert.strictEqual(availCmeAbsent.body.readOnly, true);
        });

        await check('1. Same-branch FREE faculty appear first', () => {
            const availNames = availCmeAbsent.body.availableFaculty;
            const bobIdx = availNames.indexOf('Prof. Bob CME');
            const charlieIdx = availNames.indexOf('Sri Charlie CME');
            const frankIdx = availNames.indexOf('Prof. Frank EEE');

            assert.ok(bobIdx !== -1, 'Prof. Bob CME must be in availableFaculty');
            assert.ok(charlieIdx !== -1, 'Sri Charlie CME must be in availableFaculty');
            assert.ok(frankIdx !== -1, 'Prof. Frank EEE must be in availableFaculty');

            // Both Bob and Charlie must appear BEFORE Frank
            assert.ok(bobIdx < frankIdx, 'Same-branch Bob must appear before other-branch Frank');
            assert.ok(charlieIdx < frankIdx, 'Same-branch Charlie must appear before other-branch Frank');
        });

        await check('2. Other-branch FREE faculty appear after same-branch faculty', () => {
            const sameList = availCmeAbsent.body.sameBranch.available.map(f => f.faculty);
            const otherList = availCmeAbsent.body.otherBranches.available.map(f => f.faculty);

            assert.deepStrictEqual(sameList, ['Prof. Bob CME', 'Sri Charlie CME']);
            assert.ok(otherList.includes('Prof. Frank EEE'));
            assert.strictEqual(availCmeAbsent.body.sameBranch.branch, 'CME');
        });

        // ==============================================================
        // [3] & [4] Busy Faculty Excluded (Both Same-Branch and Other-Branch)
        // ==============================================================
        console.log('\n[3] & [4] Busy Faculty Excluded from Available Results');

        await check('3. Busy same-branch faculty (Dr. Alice CME) are excluded', () => {
            const availNames = availCmeAbsent.body.availableFaculty;
            assert.ok(!availNames.includes('Dr. Alice CME'), 'Busy/absent Alice must not be available');
        });

        await check('4. Busy other-branch faculty (Dr. Edward EEE) are excluded', () => {
            const availNames = availCmeAbsent.body.availableFaculty;
            assert.ok(!availNames.includes('Dr. Edward EEE'), 'Busy other-branch Edward must not be available');
        });

        // ==============================================================
        // [5] & [6] Inactive Faculty Excluded (Both Same-Branch and Other-Branch)
        // ==============================================================
        console.log('\n[5] & [6] Inactive Faculty Excluded from Available Results');

        // Deactivate same-branch Charlie
        const deactCharlie = await call('POST', `/api/faculty/${charlieId}/deactivate`, {}, cookieCme);
        assert.strictEqual(deactCharlie.status, 200);

        // Deactivate other-branch Frank
        const deactFrank = await call('POST', `/api/faculty/${frankId}/deactivate`, {}, cookieEee);
        assert.strictEqual(deactFrank.status, 200);

        const availWithInactive = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('5. Inactive same-branch faculty (Sri Charlie CME) are excluded', () => {
            const availNames = availWithInactive.body.availableFaculty;
            assert.ok(!availNames.includes('Sri Charlie CME'), 'Inactive Charlie must be excluded');
        });

        await check('6. Inactive other-branch faculty (Prof. Frank EEE) are excluded', () => {
            const availNames = availWithInactive.body.availableFaculty;
            assert.ok(!availNames.includes('Prof. Frank EEE'), 'Inactive Frank must be excluded');
        });

        // Reactivate Charlie and Frank for subsequent tests
        await call('POST', `/api/faculty/${charlieId}/activate`, {}, cookieCme);
        await call('POST', `/api/faculty/${frankId}/activate`, {}, cookieEee);

        // ==============================================================
        // [7], [8] & [9] Dynamic Branch Participation (No Hardcoded Lists)
        // ==============================================================
        console.log('\n[7], [8] & [9] Dynamic Branch Participation (New Branches: CSE & AI_DS)');

        // Register a 3rd new branch: CSE
        const hosCseRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CSE Head',
            phone: '9876543212',
            branchName: 'Computer Science and Engineering',
            branchCode: 'CSE',
            username: 'cse_hos_b63',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosCseRes.status, 201, 'CSE HOS registration must succeed');
        const cookieCse = hosCseRes.cookie;

        // Create faculty in CSE
        const cseFac = await call('POST', '/api/auth/register', {
            name: 'Dr. Grace CSE',
            phone: '9123456785',
            username: 'grace.cse',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Operating Systems']
        }, cookieCse);
        assert.strictEqual(cseFac.status, 201);
        const graceId = cseFac.body.user.id || cseFac.body.faculty.id;

        const availWithCse = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('7. Newly created branch (CSE) automatically participates in cross-branch availability', () => {
            assert.strictEqual(availWithCse.status, 200);
            const otherNames = availWithCse.body.otherBranches.available.map(f => f.faculty);
            assert.ok(otherNames.includes('Dr. Grace CSE'), 'Grace (CSE) must automatically appear under otherBranches');

            const otherDepts = availWithCse.body.otherBranches.available.map(f => f.department);
            assert.ok(otherDepts.includes('CSE'), 'Department CSE must be present');
        });

        await check('8. New branch faculty appear without modifying a hard-coded branch list', () => {
            const allRegistered = getRegisteredBranchCodes();
            assert.ok(allRegistered.includes('CSE'), 'CSE is registered dynamically as data');
            assert.ok(allRegistered.includes('CME'));
            assert.ok(allRegistered.includes('EEE'));
        });

        // Register a 4th new branch: AI_DS
        const hosAidsRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'AI Head',
            phone: '9876543213',
            branchName: 'Artificial Intelligence and Data Science',
            branchCode: 'AI_DS',
            username: 'aids_hos_b63',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosAidsRes.status, 201);
        const cookieAids = hosAidsRes.cookie;

        const aidsFac = await call('POST', '/api/auth/register', {
            name: 'Dr. Ian AI_DS',
            phone: '9123456786',
            username: 'ian.aids',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Deep Learning']
        }, cookieAids);
        assert.strictEqual(aidsFac.status, 201);

        const availMultiBranch = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('9. Multiple future branches (CSE, AI_DS) are supported dynamically', () => {
            const otherBranches = availMultiBranch.body.otherBranches.available;
            const namesList = otherBranches.map(f => f.faculty);
            assert.ok(namesList.includes('Dr. Grace CSE'), 'Grace CSE must be in otherBranches');
            assert.ok(namesList.includes('Dr. Ian AI_DS'), 'Ian AI_DS must be in otherBranches');
            assert.ok(namesList.includes('Prof. Frank EEE'), 'Frank EEE must be in otherBranches');
        });

        // ==============================================================
        // [10] Branch Priority Based on Absent Faculty's Actual Branch
        // ==============================================================
        console.log('\n[10] Branch Priority Based on Absent Faculty Actual Branch');

        const availEeeAbsent = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Edward EEE',
            day: 'Monday',
            period: 1
        }, cookieEee);

        await check('10. If absent faculty is from EEE, EEE faculty appear first and CME/CSE/AI_DS appear after', () => {
            assert.strictEqual(availEeeAbsent.status, 200);
            assert.strictEqual(availEeeAbsent.body.sameBranch.branch, 'EEE');

            // Same branch must be Frank EEE
            const sameList = availEeeAbsent.body.sameBranch.available.map(f => f.faculty);
            assert.deepStrictEqual(sameList, ['Prof. Frank EEE']);

            // Other branches must contain CME, CSE, AI_DS
            const otherList = availEeeAbsent.body.otherBranches.available.map(f => f.faculty);
            assert.ok(otherList.includes('Prof. Bob CME'));
            assert.ok(otherList.includes('Sri Charlie CME'));
            assert.ok(otherList.includes('Dr. Grace CSE'));
            assert.ok(otherList.includes('Dr. Ian AI_DS'));

            // In total available list: Frank (EEE) must precede Bob, Charlie, Grace, Ian
            const allAvailable = availEeeAbsent.body.availableFaculty;
            const frankIdx = allAvailable.indexOf('Prof. Frank EEE');
            const bobIdx = allAvailable.indexOf('Prof. Bob CME');
            const graceIdx = allAvailable.indexOf('Dr. Grace CSE');

            assert.ok(frankIdx < bobIdx, 'Frank (EEE) must appear before Bob (CME)');
            assert.ok(frankIdx < graceIdx, 'Frank (EEE) must appear before Grace (CSE)');
        });

        const availCseAbsent = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Grace CSE',
            day: 'Monday',
            period: 2 // period where Grace is free, so declaring her absent excludes her
        }, cookieCse);

        await check('10b. If absent faculty is from CSE, CSE faculty appear first', () => {
            assert.strictEqual(availCseAbsent.status, 200);
            assert.strictEqual(availCseAbsent.body.sameBranch.branch, 'CSE');
            // Grace is absent, no other CSE faculty, so same branch available is empty
            assert.strictEqual(availCseAbsent.body.sameBranch.totalAvailable, 0);
            // Other branches have free CME, EEE, AI_DS faculty
            assert.ok(availCseAbsent.body.otherBranches.totalAvailable > 0);
        });

        // ==============================================================
        // [11] No Automatic Substitute Assignment
        // ==============================================================
        console.log('\n[11] Read-Only Guarantee (No Automatic Substitute Assignment)');

        const entriesBefore = store.listEntriesInMemory({});
        const countBefore = entriesBefore.length;

        await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('11. Availability queries do not alter timetable entries or create substitutions', () => {
            const entriesAfter = store.listEntriesInMemory({});
            assert.strictEqual(entriesAfter.length, countBefore, 'Timetable entries count must be unchanged');
            assert.deepStrictEqual(entriesAfter, entriesBefore, 'Timetable entries must be untouched');
        });

        // ==============================================================
        // [12] Dynamic State Changes: Free -> Busy -> Inactive
        // ==============================================================
        console.log('\n[12] Dynamic State Changes: Free -> Busy -> Inactive for Cross-Branch Faculty');

        const res12a = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('12a. CSE faculty (Dr. Grace CSE) is free initially at Monday P1', () => {
            assert.ok(res12a.body.availableFaculty.includes('Dr. Grace CSE'));
        });

        // Make Grace BUSY on Monday P1 by adding an entry for CSE-SEM1-A
        store.resolveOrCreateClassInMemory({
            branch: 'CSE',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });
        store.addEntryInMemory({
            className: 'CSE-SEM1-A',
            day: 'Monday',
            period: 1,
            subject: 'Operating Systems',
            faculty: 'Dr. Grace CSE',
            room: 'CS-101',
            type: 'theory'
        });

        const res12b = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('12b. When CSE faculty becomes BUSY, they disappear from availability results', () => {
            assert.ok(!res12b.body.availableFaculty.includes('Dr. Grace CSE'), 'Busy Grace must not be in availableFaculty');
            assert.ok(!res12b.body.otherBranches.available.some(f => f.faculty === 'Dr. Grace CSE'), 'Grace must not be in otherBranches');
        });

        // Free Grace again (clear that class timetable), then deactivate Grace
        await store.clearTimetableInMemory({ className: 'CSE-SEM1-A', branchCode: 'CSE' });

        // Confirm Grace is free again
        const freeAgain = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);
        assert.ok(freeAgain.body.availableFaculty.includes('Dr. Grace CSE'), 'Grace is free again after clearing class entry');

        // Now deactivate Grace
        const deactGrace = await call('POST', `/api/faculty/${graceId}/deactivate`, {}, cookieCse);
        assert.strictEqual(deactGrace.status, 200);

        const res12c = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('12c. When CSE faculty is deactivated, they disappear from availability results', () => {
            assert.ok(!res12c.body.availableFaculty.includes('Dr. Grace CSE'), 'Deactivated Grace must not be in availableFaculty');
            assert.ok(!res12c.body.otherBranches.available.some(f => f.faculty === 'Dr. Grace CSE'), 'Deactivated Grace must not be in otherBranches');
        });

        // Reactivate Grace and verify they reappear
        const reactGrace = await call('POST', `/api/faculty/${graceId}/activate`, {}, cookieCse);
        assert.strictEqual(reactGrace.status, 200);

        const res12d = await call('POST', '/api/availability', {
            absentFaculty: 'Dr. Alice CME',
            day: 'Monday',
            period: 1
        }, cookieCme);

        await check('12d. When CSE faculty is reactivated, they reappear in availability results', () => {
            assert.ok(res12d.body.availableFaculty.includes('Dr. Grace CSE'), 'Reactivated Grace must reappear in availableFaculty');
        });

        // ==============================================================
        // [13] Cross-Branch Security & Validation Gates
        // ==============================================================
        console.log('\n[13] Cross-Branch Security & Validation Gates');

        const crossDeptAttempt = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            department: 'EEE'
        }, cookieCme);

        await check('13a. CME HOS query with spoofed department="EEE" is rejected with 403 FORBIDDEN', () => {
            assert.strictEqual(crossDeptAttempt.status, 403);
            assert.strictEqual(crossDeptAttempt.body.code, 'FORBIDDEN');
        });

        const crossAbsentAttempt = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            absentFaculty: 'Dr. Edward EEE'
        }, cookieCme);

        await check('13b. CME HOS declaring an EEE faculty member absent is rejected with 400 UNKNOWN_FACULTY', () => {
            assert.strictEqual(crossAbsentAttempt.status, 400);
            assert.strictEqual(crossAbsentAttempt.body.code, 'UNKNOWN_FACULTY');
        });

        const badDay = await call('POST', '/api/availability', { day: 'Funday', period: 1 }, cookieCme);
        const badPeriod = await call('POST', '/api/availability', { day: 'Monday', period: 99 }, cookieCme);

        await check('13c. Invalid day or period rejected with HTTP 400', () => {
            assert.strictEqual(badDay.status, 400);
            assert.strictEqual(badDay.body.code, 'INVALID_DAY');

            assert.strictEqual(badPeriod.status, 400);
            assert.strictEqual(badPeriod.body.code, 'INVALID_PERIOD');
        });

        // ==============================================================
        // Summary
        // ==============================================================
        console.log('\n------------------------------------');
        console.log(`Results: ${passed} passed, ${failed} failed\n`);

    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Fatal test error:', err);
        process.exit(1);
    });
}

module.exports = { run };
