/**
 * Phase B7.4 — Faculty Availability & Substitution Preparation Test Suite
 *
 * Requirements:
 *  1. Active PRESENT faculty with no schedule → FREE
 *  2. Faculty teaching during period → BUSY / TEACHING
 *  3. Faculty invigilating during period → BUSY / INVIGILATION
 *  4. Faculty absent → ABSENT and excluded from candidates
 *  5. Inactive faculty → excluded
 *  6. Same faculty FREE on one period and BUSY on another
 *  7. Invigilation does not modify attendance
 *  8. Date-specific attendance works
 *  9. Date-specific invigilation works
 * 10. Same-branch FREE faculty appear first
 * 11. Other-branch FREE faculty appear after same-branch faculty
 * 12. No absent faculty appears in candidates
 * 13. No teaching faculty appears in candidates
 * 14. No invigilating faculty appears in candidates
 * 15. HOS branch security works
 * 16. Future/new branch works without hardcoding
 * 17. Multiple sections remain isolated
 * 18. Existing availability API remains compatible
 * 19. Dynamic periods remain supported
 * 20. B7.1 registration still works
 * 21. B7.2 attendance still works
 * 22. B7.3 invigilation still works
 */
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const facultyRequests = require('../src/data/facultyRequests');
const { resetBranchForTesting } = require('../src/data/departments');

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
    console.log('TecSubstitution — Phase B7.4 Availability & Candidates Suite');
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

        console.log('[Setup] Registering HOS and Faculty accounts for CME, EEE, and testing branches');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos_b74',
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
            username: 'eee_hos_b74',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosEeeRes.status, 201, 'EEE HOS registration must succeed');
        const cookieEee = hosEeeRes.cookie;

        // Create Faculty in CME: Ravi, Kumar, Suresh, Ramesh, Ghost
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

        const cmeFac4 = await call('POST', '/api/auth/register', {
            name: 'Ramesh CME',
            phone: '9123456784',
            username: 'ramesh.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Lecturer',
            subjects: ['Maths']
        }, cookieCme);
        assert.strictEqual(cmeFac4.status, 201);
        const rameshId = cmeFac4.body.user.id || cmeFac4.body.faculty.id;

        const cmeFacGhost = await call('POST', '/api/auth/register', {
            name: 'Ghost CME',
            phone: '9123456789',
            username: 'ghost.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Adhoc',
            subjects: ['Physics']
        }, cookieCme);
        assert.strictEqual(cmeFacGhost.status, 201);
        const ghostId = cmeFacGhost.body.user.id || cmeFacGhost.body.faculty.id;

        // Deactivate Ghost CME so we test inactive faculty
        const deactGhost = await call('POST', `/api/faculty/${ghostId}/deactivate`, {}, cookieCme);
        assert.strictEqual(deactGhost.status, 200, 'Deactivation of Ghost CME must succeed');

        // Create Faculty in EEE: Anil
        const eeeFac1 = await call('POST', '/api/auth/register', {
            name: 'Anil EEE',
            phone: '9123456783',
            username: 'anil.eee',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Power Systems']
        }, cookieEee);
        assert.strictEqual(eeeFac1.status, 201);
        const anilId = eeeFac1.body.user.id || eeeFac1.body.faculty.id;

        // Sign in Ravi (Faculty role) to test security
        const raviLogin = await call('POST', '/api/auth/login', {
            username: 'ravi.cme',
            password: 'TecSub_123'
        });
        assert.strictEqual(raviLogin.status, 200);
        const cookieRavi = raviLogin.cookie;

        // Setup Timetable:
        // 2026-09-15 is Tuesday.
        // Multiple sections: CME-SEM1-A and CME-SEM1-B
        store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });
        store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'B'
        });

        // Kumar teaches Tuesday P2 in CME-SEM1-A
        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Tuesday',
            period: 2,
            subject: 'Operating Systems',
            faculty: 'Prof. Kumar CME',
            room: 'C-101',
            type: 'theory'
        });

        // Suresh teaches Tuesday P3 in CME-SEM1-B
        store.addEntryInMemory({
            className: 'CME-SEM1-B',
            day: 'Tuesday',
            period: 3,
            subject: 'Databases',
            faculty: 'Sri Suresh CME',
            room: 'C-102',
            type: 'theory'
        });

        // Invigilation: Ravi is assigned invigilation on 2026-09-15 Tuesday P3 (Exam Duty)
        const invigRes = await call('POST', '/api/invigilation', {
            facultyId: raviId,
            date: '2026-09-15',
            periods: [3],
            notes: 'Midterm Supervision'
        }, cookieCme);
        assert.strictEqual(invigRes.status, 201, 'Invigilation assignment must succeed');

        // Attendance: Ramesh is marked ABSENT on 2026-09-15 Tuesday
        const attRes = await call('POST', '/api/attendance', {
            facultyId: rameshId,
            date: '2026-09-15',
            status: 'ABSENT'
        }, cookieCme);
        assert.strictEqual(attRes.status, 200, 'Attendance mark ABSENT must succeed');

        // ==============================================================
        // Test 1: Active PRESENT faculty with no schedule → FREE
        // ==============================================================
        await check('1. Active PRESENT faculty with no schedule → FREE', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const ravi = res.body.candidates.find(c => c.name === 'Dr. Ravi CME');
            assert.ok(ravi, 'Ravi must be in candidates list for P1');
            assert.strictEqual(ravi.status, 'FREE');
            assert.strictEqual(ravi.reason, null);

            const facOverview = res.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            assert.ok(facOverview, 'Ravi must be in faculty overview');
            assert.strictEqual(facOverview.status, 'FREE');
            assert.strictEqual(facOverview.reason, null);
        });

        // ==============================================================
        // Test 2: Faculty teaching during period → BUSY / TEACHING
        // ==============================================================
        await check('2. Faculty teaching during period → BUSY / TEACHING', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=2', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const kumar = res.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            assert.ok(kumar, 'Kumar must be in faculty overview for P2');
            assert.strictEqual(kumar.status, 'BUSY');
            assert.strictEqual(kumar.reason, 'TEACHING');
        });

        // ==============================================================
        // Test 3: Faculty invigilating during period → BUSY / INVIGILATION
        // ==============================================================
        await check('3. Faculty invigilating during period → BUSY / INVIGILATION', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=3', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const ravi = res.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            assert.ok(ravi, 'Ravi must be in faculty overview for P3');
            assert.strictEqual(ravi.status, 'BUSY');
            assert.strictEqual(ravi.reason, 'INVIGILATION');
        });

        // ==============================================================
        // Test 4: Faculty absent → ABSENT and excluded from candidates
        // ==============================================================
        await check('4. Faculty absent → ABSENT and excluded from candidates', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const rameshCand = res.body.candidates.find(c => c.name === 'Ramesh CME');
            assert.strictEqual(rameshCand, undefined, 'Absent Ramesh must NOT appear in candidates');

            const rameshFac = res.body.faculty.find(f => f.name === 'Ramesh CME');
            assert.ok(rameshFac, 'Ramesh must appear in status table');
            assert.strictEqual(rameshFac.status, 'ABSENT');
            assert.strictEqual(rameshFac.reason, null);
        });

        // ==============================================================
        // Test 5: Inactive faculty → excluded
        // ==============================================================
        await check('5. Inactive faculty → excluded completely from candidates', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const ghostCand = res.body.candidates.find(c => c.name === 'Ghost CME');
            assert.strictEqual(ghostCand, undefined, 'Inactive Ghost CME must never be in candidates');
        });

        // ==============================================================
        // Test 6: Same faculty FREE on one period and BUSY on another
        // ==============================================================
        await check('6. Same faculty FREE on one period and BUSY on another', async () => {
            // Ravi: P1 is FREE, P3 is BUSY (invigilation)
            const p1Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            const p3Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=3', null, cookieCme);

            const raviP1 = p1Res.body.candidates.find(c => c.name === 'Dr. Ravi CME');
            assert.ok(raviP1, 'Ravi must be FREE on P1');
            assert.strictEqual(raviP1.status, 'FREE');

            const raviP3 = p3Res.body.candidates.find(c => c.name === 'Dr. Ravi CME');
            assert.strictEqual(raviP3, undefined, 'Ravi must NOT be in candidates on P3');

            const raviP3Fac = p3Res.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            assert.strictEqual(raviP3Fac.status, 'BUSY');
            assert.strictEqual(raviP3Fac.reason, 'INVIGILATION');

            // Kumar: P1 is FREE, P2 is BUSY (teaching)
            const kumarP1 = p1Res.body.candidates.find(c => c.name === 'Prof. Kumar CME');
            assert.ok(kumarP1, 'Kumar must be FREE on P1');
            assert.strictEqual(kumarP1.status, 'FREE');

            const p2Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=2', null, cookieCme);
            const kumarP2 = p2Res.body.candidates.find(c => c.name === 'Prof. Kumar CME');
            assert.strictEqual(kumarP2, undefined, 'Kumar must NOT be in candidates on P2');
            const kumarP2Fac = p2Res.body.faculty.find(f => f.name === 'Prof. Kumar CME');
            assert.strictEqual(kumarP2Fac.status, 'BUSY');
            assert.strictEqual(kumarP2Fac.reason, 'TEACHING');
        });

        // ==============================================================
        // Test 7: Invigilation does not modify attendance
        // ==============================================================
        await check('7. Invigilation does not modify attendance', async () => {
            const absentList = await attendance.getAbsentFacultyOnDate('2026-09-15');
            const raviAbsent = absentList.find(a => a.name === 'Dr. Ravi CME');
            assert.strictEqual(raviAbsent, undefined, 'Ravi must NOT be marked absent merely for having invigilation');
        });

        // ==============================================================
        // Test 8: Date-specific attendance works
        // ==============================================================
        await check('8. Date-specific attendance works', async () => {
            // Ramesh is absent on 2026-09-15 (Tuesday), but NOT absent on 2026-09-16 (Wednesday)
            const sep16Res = await call('GET', '/api/availability/candidates?date=2026-09-16&period=1', null, cookieCme);
            assert.strictEqual(sep16Res.status, 200);
            const rameshSep16 = sep16Res.body.candidates.find(c => c.name === 'Ramesh CME');
            assert.ok(rameshSep16, 'Ramesh must be FREE / candidate on 2026-09-16 where not marked absent');
            assert.strictEqual(rameshSep16.status, 'FREE');
        });

        // ==============================================================
        // Test 9: Date-specific invigilation works
        // ==============================================================
        await check('9. Date-specific invigilation works', async () => {
            // Ravi is invigilating on 2026-09-15 P3 -> BUSY
            // On 2026-09-16 P3 (Wednesday), Ravi has no invigilation -> FREE
            const sep16P3 = await call('GET', '/api/availability/candidates?date=2026-09-16&period=3', null, cookieCme);
            assert.strictEqual(sep16P3.status, 200);
            const raviSep16P3 = sep16P3.body.candidates.find(c => c.name === 'Dr. Ravi CME');
            assert.ok(raviSep16P3, 'Ravi must be FREE on 2026-09-16 P3 where he has no invigilation');
            assert.strictEqual(raviSep16P3.status, 'FREE');
        });

        // ==============================================================
        // Test 10: Same-branch FREE faculty appear first
        // ==============================================================
        await check('10. Same-branch FREE faculty appear first in candidates', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const candidates = res.body.candidates;
            assert.ok(candidates.length >= 2, 'Should have multiple candidates');

            // Find index of same-branch faculty and other-branch faculty
            const cmeIndices = candidates.map((c, i) => c.branch === 'CME' ? i : -1).filter(i => i !== -1);
            const eeeIndices = candidates.map((c, i) => c.branch === 'EEE' ? i : -1).filter(i => i !== -1);

            assert.ok(cmeIndices.length > 0, 'CME candidates exist');
            assert.ok(eeeIndices.length > 0, 'EEE candidates exist');
            assert.ok(Math.max(...cmeIndices) < Math.min(...eeeIndices),
                'All same-branch CME candidates must precede other-branch EEE candidates');
        });

        // ==============================================================
        // Test 11: Other-branch FREE faculty appear after same-branch faculty
        // ==============================================================
        await check('11. Other-branch FREE faculty appear after same-branch faculty', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            assert.strictEqual(res.status, 200);
            const otherBranchCand = res.body.otherBranches.candidates;
            assert.ok(otherBranchCand.some(c => c.name === 'Anil EEE'), 'Anil EEE must be in otherBranches candidates');
            assert.strictEqual(otherBranchCand.every(c => c.isSameBranch === false), true);
        });

        // ==============================================================
        // Test 12: No absent faculty appears in candidates
        // ==============================================================
        await check('12. No absent faculty appears in candidates', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieCme);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.candidates.some(c => c.name === 'Ramesh CME'), false,
                'Absent Ramesh must NOT be in candidates');
            assert.strictEqual(res.body.candidates.some(c => c.status === 'ABSENT'), false);
        });

        // ==============================================================
        // Test 13: No teaching faculty appears in candidates
        // ==============================================================
        await check('13. No teaching faculty appears in candidates', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=2', null, cookieCme);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.candidates.some(c => c.name === 'Prof. Kumar CME'), false,
                'Teaching Kumar must NOT be in candidates on P2');
        });

        // ==============================================================
        // Test 14: No invigilating faculty appears in candidates
        // ==============================================================
        await check('14. No invigilating faculty appears in candidates', async () => {
            const res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=3', null, cookieCme);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.candidates.some(c => c.name === 'Dr. Ravi CME'), false,
                'Invigilating Ravi must NOT be in candidates on P3');
        });

        // ==============================================================
        // Test 15: HOS branch security works
        // ==============================================================
        await check('15. HOS branch security works (cross-branch tampering, faculty, unauthenticated)', async () => {
            // 1. Cross-branch query attempt by CME HOS for EEE
            const tamper = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1&branch=EEE', null, cookieCme);
            assert.strictEqual(tamper.status, 403);
            assert.strictEqual(tamper.body.code, 'FORBIDDEN');

            // 2. Faculty role attempt
            const facAttempt = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieRavi);
            assert.strictEqual(facAttempt.status, 403);
            assert.strictEqual(facAttempt.body.code, 'FORBIDDEN');

            // 3. Unauthenticated attempt
            const noAuth = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, null);
            assert.strictEqual(noAuth.status, 401);
            assert.strictEqual(noAuth.body.code, 'UNAUTHENTICATED');
        });

        // ==============================================================
        // Test 16: Future/new branch works without hardcoding
        // ==============================================================
        await check('16. Future/new branch works without hardcoding', async () => {
            // Register an entirely new branch: MECH_ROBOTICS
            const hosMechRes = await call('POST', '/api/auth/register', {
                role: 'hos',
                name: 'Mech Head',
                phone: '9876543299',
                branchName: 'Robotics and Mechanical',
                branchCode: 'MEC_ROBO',
                username: 'mech_hos_b74',
                password: 'TecSub_123'
            });
            assert.strictEqual(hosMechRes.status, 201);
            const cookieMech = hosMechRes.cookie;

            // Register faculty in MEC_ROBO
            const roboFac = await call('POST', '/api/auth/register', {
                name: 'Dr. Turing ROBO',
                phone: '9123456799',
                username: 'turing.robo',
                password: 'TecSub_123',
                role: 'faculty',
                designation: 'Professor',
                subjects: ['Kinematics']
            }, cookieMech);
            assert.strictEqual(roboFac.status, 201);

            // MEC_ROBO HOS queries candidates
            const roboRes = await call('GET', '/api/availability/candidates?date=2026-09-15&period=1', null, cookieMech);
            assert.strictEqual(roboRes.status, 200);
            assert.strictEqual(roboRes.body.branch, 'MEC_ROBO');
            assert.strictEqual(roboRes.body.priorityBranch, 'MEC_ROBO');

            // Turing must be in sameBranch candidates
            const sameCand = roboRes.body.sameBranch.candidates;
            assert.ok(sameCand.some(c => c.name === 'Dr. Turing ROBO'), 'Turing must be in sameBranch for MEC_ROBO');
            // CME and EEE faculty should appear under otherBranches
            const otherCand = roboRes.body.otherBranches.candidates;
            assert.ok(otherCand.some(c => c.name === 'Dr. Ravi CME'), 'Ravi CME must be in otherBranches for MEC_ROBO');
        });

        // ==============================================================
        // Test 17: Multiple sections remain isolated
        // ==============================================================
        await check('17. Multiple sections remain isolated', async () => {
            // Kumar is teaching in CME-SEM1-A on Tuesday P2
            // Suresh is teaching in CME-SEM1-B on Tuesday P3
            const p2Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=2&class=CME-SEM1-A', null, cookieCme);
            assert.strictEqual(p2Res.status, 200);
            // Suresh is NOT teaching on P2 in section A or B -> Suresh must be FREE on P2
            const sureshP2 = p2Res.body.candidates.find(c => c.name === 'Sri Suresh CME');
            assert.ok(sureshP2, 'Suresh must be FREE on P2 even though he teaches on P3 in Section B');

            const p3Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=3&class=CME-SEM1-B', null, cookieCme);
            assert.strictEqual(p3Res.status, 200);
            // Suresh is BUSY on P3
            const sureshP3 = p3Res.body.candidates.find(c => c.name === 'Sri Suresh CME');
            assert.strictEqual(sureshP3, undefined, 'Suresh must NOT be candidate on P3');
            const sureshP3Fac = p3Res.body.faculty.find(f => f.name === 'Sri Suresh CME');
            assert.strictEqual(sureshP3Fac.status, 'BUSY');
            assert.strictEqual(sureshP3Fac.reason, 'TEACHING');
        });

        // ==============================================================
        // Test 18: Existing availability API remains compatible
        // ==============================================================
        await check('18. Existing availability API remains compatible (POST /api/availability)', async () => {
            const availRes = await call('POST', '/api/availability', {
                date: '2026-09-15',
                day: 'Tuesday',
                period: 2
            }, cookieCme);
            assert.strictEqual(availRes.status, 200);
            assert.ok(Array.isArray(availRes.body.availableFaculty));
            assert.ok(Array.isArray(availRes.body.available));
            assert.ok(Array.isArray(availRes.body.busy));

            const busyKumar = availRes.body.busy.find(b => b.faculty === 'Prof. Kumar CME');
            assert.ok(busyKumar, 'Kumar is busy');
            assert.strictEqual(busyKumar.status, 'busy');
            assert.strictEqual(busyKumar.reason, 'TEACHING');
        });

        // ==============================================================
        // Test 19: Dynamic periods remain supported
        // ==============================================================
        await check('19. Dynamic periods remain supported (e.g. Period 6 and Period 7)', async () => {
            const p6Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=6', null, cookieCme);
            assert.strictEqual(p6Res.status, 200);
            assert.strictEqual(p6Res.body.period, 6);
            assert.ok(p6Res.body.candidates.length > 0);

            const p7Res = await call('GET', '/api/availability/candidates?date=2026-09-15&period=7', null, cookieCme);
            assert.strictEqual(p7Res.status, 200);
            assert.strictEqual(p7Res.body.period, 7);
        });

        // ==============================================================
        // Test 20: B7.1 registration still works
        // ==============================================================
        await check('20. B7.1 registration still works', async () => {
            // Self-register a faculty request in CME
            const regReq = await call('POST', '/api/faculty-requests', {
                name: 'Dr. Newbie CME',
                phone: '9123456755',
                email: 'newbie@cme.edu',
                branchCode: 'CME',
                username: 'newbie.cme',
                password: 'TecSub_123',
                confirmPassword: 'TecSub_123',
                designation: 'Assistant Professor',
                subjects: ['Networks']
            });
            assert.strictEqual(regReq.status, 201);
            const reqId = regReq.body.request.id;

            // HOS approves request
            const approveRes = await call('POST', `/api/faculty-requests/${reqId}/approve`, {}, cookieCme);
            assert.strictEqual(approveRes.status, 200);
            assert.ok(approveRes.body.user || approveRes.body.facultyId, 'Approved request creates faculty');
        });

        // ==============================================================
        // Test 21: B7.2 attendance still works
        // ==============================================================
        await check('21. B7.2 attendance still works', async () => {
            // Mark Suresh absent on 2026-09-20
            const markAbsent = await call('POST', '/api/attendance', {
                facultyId: sureshId,
                date: '2026-09-20',
                status: 'ABSENT'
            }, cookieCme);
            assert.strictEqual(markAbsent.status, 200);

            const records = await call('GET', '/api/attendance?date=2026-09-20', null, cookieCme);
            assert.strictEqual(records.status, 200);
            const sureshRec = records.body.faculty.find(f => f.name === 'Sri Suresh CME');
            assert.ok(sureshRec);
            assert.strictEqual(sureshRec.status, 'ABSENT');

            // Toggle back to PRESENT
            const markPresent = await call('POST', '/api/attendance', {
                facultyId: sureshId,
                date: '2026-09-20',
                status: 'PRESENT'
            }, cookieCme);
            assert.strictEqual(markPresent.status, 200);

            const recordsAfter = await call('GET', '/api/attendance?date=2026-09-20', null, cookieCme);
            assert.strictEqual(recordsAfter.status, 200);
            const sureshAfter = recordsAfter.body.faculty.find(f => f.name === 'Sri Suresh CME');
            assert.ok(sureshAfter);
            assert.strictEqual(sureshAfter.status, 'PRESENT');
        });

        // ==============================================================
        // Test 22: B7.3 invigilation still works
        // ==============================================================
        await check('22. B7.3 invigilation still works', async () => {
            // Assign Kumar invigilation on 2026-09-22 P4
            const invig = await call('POST', '/api/invigilation', {
                facultyId: kumarId,
                date: '2026-09-22',
                periods: [4],
                notes: 'Annual Exam P4'
            }, cookieCme);
            assert.strictEqual(invig.status, 201);
            const invigId = invig.body.assignments[0].id;

            // Check HOS list
            const listRes = await call('GET', '/api/invigilation?date=2026-09-22', null, cookieCme);
            assert.strictEqual(listRes.status, 200);
            assert.ok(listRes.body.assignments.some(i => i.id === invigId));

            // Delete invigilation
            const delRes = await call('DELETE', `/api/invigilation/${invigId}`, null, cookieCme);
            assert.strictEqual(delRes.status, 200);
        });

        // ==============================================================
        // Test 23: Candidates endpoint over POST also works
        // ==============================================================
        await check('23. Candidates endpoint over POST also works', async () => {
            const postRes = await call('POST', '/api/availability/candidates', {
                date: '2026-09-15',
                period: 1
            }, cookieCme);
            assert.strictEqual(postRes.status, 200);
            assert.ok(Array.isArray(postRes.body.candidates));
            assert.ok(Array.isArray(postRes.body.faculty));
            assert.strictEqual(postRes.body.period, 1);
        });

    } finally {
        await stopServer();
    }

    console.log('\n================================================================');
    if (failed === 0) {
        console.log(`ALL ${passed} TESTS PASSED! Phase B7.4 verified.`);
    } else {
        console.error(`${failed} tests failed out of ${passed + failed}.`);
        process.exit(1);
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Fatal error running suite:', err);
        process.exit(1);
    });
}

module.exports = { run };
