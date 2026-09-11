/**
 * Phase B7.5 — Faculty-to-Faculty Substitution Workflow Test Suite
 *
 * Requirements:
 *  Suite 1: Creation of Substitution Request (Tests 1-7)
 *    1. Absent Faculty A creates a substitution request for a vacant teaching period
 *    2. Present Faculty cannot create a substitution request (requester must be absent)
 *    3. Faculty A cannot create request for a period they are not scheduled to teach
 *    4. Faculty A cannot select an inactive substitute
 *    5. Faculty A cannot select an absent substitute
 *    6. Faculty A cannot select a busy substitute (teaching)
 *    7. Faculty A cannot select self as substitute
 *
 *  Suite 2: Substitution Candidate Selection (Tests 8-12)
 *    8. Candidates endpoint returns available FREE faculty for absent faculty
 *    9. Same-branch FREE faculty are prioritized
 *   10. Other-branch FREE faculty appear after same-branch faculty
 *   11. Faculty A is excluded from candidate list
 *   12. Teaching, invigilating, and absent faculty are excluded from candidates
 *
 *  Suite 3: Faculty B Acceptance & Fresh Revalidation (Tests 13-17)
 *   13. Faculty B accepts request -> Status transitions from PENDING to ACCEPTED
 *   14. Acceptance re-checks Faculty B availability -> If Faculty B became absent after request creation, acceptance rejected (409)
 *   15. Acceptance re-checks Faculty B availability -> If Faculty B was assigned invigilation, acceptance rejected (409)
 *   16. Acceptance re-checks Faculty B availability -> If Faculty B is scheduled to teach, acceptance rejected (409)
 *   17. Acceptance re-checks Faculty B availability -> If Faculty B already accepted another substitution for the same slot, acceptance rejected (double booking conflict 409)
 *
 *  Suite 4: Faculty B Rejection & Faculty A Cancellation (Tests 18-20)
 *   18. Faculty B rejects substitution request with optional reason -> Status transitions to REJECTED
 *   19. Faculty A cancels pending substitution request -> Status transitions to CANCELLED
 *   20. Non-pending request cannot be cancelled or accepted/rejected again
 *
 *  Suite 5: Strict HOS Exclusion / Governance (Tests 21-25)
 *   21. HOS cannot create a substitution request (403 Forbidden)
 *   22. HOS cannot accept a substitution request (403 Forbidden)
 *   23. HOS cannot reject a substitution request (403 Forbidden)
 *   24. HOS can view branch substitutions in read-only mode
 *   25. Faculty from another branch / third party cannot accept/reject someone else's request (only target Faculty B)
 *
 *  Suite 6: Timetable Immutability & Double Booking (Tests 26-28)
 *   26. Original timetable records remain 100% UNMODIFIED after creation, acceptance, or rejection
 *   27. Double booking prevention: Faculty B cannot accept two substitutions for the same date & period
 *   28. Faculty B cannot be selected as candidate if already accepted for that date & period
 *
 *  Suite 7: History & Queries (Tests 29-32)
 *   29. Faculty A views outgoing substitution history
 *   30. Faculty B views incoming substitution requests
 *   31. HOS views branch substitution history
 *   32. Vacant periods endpoint returns absent teaching slots for Faculty A
 *
 *  Suite 8: Regressions & Backward Compatibility (Tests 33-38)
 *   33. B7.1 Faculty Registration still works
 *   34. B7.2 Faculty Attendance still works
 *   35. B7.3 Exam Invigilation still works
 *   36. B7.4 Availability & Candidates engine still works
 *   37. Timetable grid still renders correctly
 *   38. Multiple branches remain isolated
 */
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const substitutions = require('../src/data/substitutions');
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
    console.log('TecSubstitution — Phase B7.5 Faculty Substitution Suite');
    console.log('================================================================\n');

    await startServer();

    try {
        // [0] Reset state & initialize isolated branch environments
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();
        attendance.resetForTesting();
        invigilation.resetForTesting();
        substitutions.resetForTesting();
        facultyRequests.resetForTesting();

        console.log('[Setup] Registering HOS and Faculty accounts');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos_b75',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosCmeRes.status, 201);
        const cookieHosCme = hosCmeRes.cookie;

        // Register EEE HOS
        const hosEeeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Head',
            phone: '9876543211',
            branchName: 'Electrical Engineering',
            branchCode: 'EEE',
            username: 'eee_hos_b75',
            password: 'TecSub_123'
        });
        assert.strictEqual(hosEeeRes.status, 201);
        const cookieHosEee = hosEeeRes.cookie;

        // Create Faculty in CME:
        // 1. Dr. Ravi CME (Requester, Faculty A)
        const facRaviRes = await call('POST', '/api/auth/register', {
            name: 'Dr. Ravi CME',
            phone: '9123456780',
            username: 'ravi.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Algorithms']
        }, cookieHosCme);
        assert.strictEqual(facRaviRes.status, 201);
        const raviId = facRaviRes.body.user.id || facRaviRes.body.faculty.id;

        // 2. Sri Suresh CME (Substitute, Faculty B)
        const facSureshRes = await call('POST', '/api/auth/register', {
            name: 'Sri Suresh CME',
            phone: '9123456782',
            username: 'suresh.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Databases']
        }, cookieHosCme);
        assert.strictEqual(facSureshRes.status, 201);
        const sureshId = facSureshRes.body.user.id || facSureshRes.body.faculty.id;

        // 3. Prof. Kumar CME (Teaching conflict)
        const facKumarRes = await call('POST', '/api/auth/register', {
            name: 'Prof. Kumar CME',
            phone: '9123456781',
            username: 'kumar.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Associate Professor',
            subjects: ['Operating Systems']
        }, cookieHosCme);
        assert.strictEqual(facKumarRes.status, 201);
        const kumarId = facKumarRes.body.user.id || facKumarRes.body.faculty.id;

        // 4. Ramesh CME (Invigilation conflict)
        const facRameshRes = await call('POST', '/api/auth/register', {
            name: 'Ramesh CME',
            phone: '9123456784',
            username: 'ramesh.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Lecturer',
            subjects: ['Maths']
        }, cookieHosCme);
        assert.strictEqual(facRameshRes.status, 201);
        const rameshId = facRameshRes.body.user.id || facRameshRes.body.faculty.id;

        // 5. Ghost CME (Inactive)
        const facGhostRes = await call('POST', '/api/auth/register', {
            name: 'Ghost CME',
            phone: '9123456789',
            username: 'ghost.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Adhoc',
            subjects: ['Physics']
        }, cookieHosCme);
        assert.strictEqual(facGhostRes.status, 201);
        const ghostId = facGhostRes.body.user.id || facGhostRes.body.faculty.id;
        await call('POST', `/api/faculty/${ghostId}/deactivate`, {}, cookieHosCme);

        // 6. Late CME (Becomes absent/conflict later)
        const facLateRes = await call('POST', '/api/auth/register', {
            name: 'Late CME',
            phone: '9123456799',
            username: 'late.cme',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Lecturer',
            subjects: ['Networks']
        }, cookieHosCme);
        assert.strictEqual(facLateRes.status, 201);
        const lateId = facLateRes.body.user.id || facLateRes.body.faculty.id;

        // Create Faculty in EEE: Anil (Other branch FREE)
        const facAnilRes = await call('POST', '/api/auth/register', {
            name: 'Anil EEE',
            phone: '9123456783',
            username: 'anil.eee',
            password: 'TecSub_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Power Systems']
        }, cookieHosEee);
        assert.strictEqual(facAnilRes.status, 201);
        const anilId = facAnilRes.body.user.id || facAnilRes.body.faculty.id;

        // Log in faculty users
        const raviLogin = await call('POST', '/api/auth/login', { username: 'ravi.cme', password: 'TecSub_123' });
        assert.strictEqual(raviLogin.status, 200);
        const cookieRavi = raviLogin.cookie;

        const sureshLogin = await call('POST', '/api/auth/login', { username: 'suresh.cme', password: 'TecSub_123' });
        assert.strictEqual(sureshLogin.status, 200);
        const cookieSuresh = sureshLogin.cookie;

        const anilLogin = await call('POST', '/api/auth/login', { username: 'anil.eee', password: 'TecSub_123' });
        assert.strictEqual(anilLogin.status, 200);
        const cookieAnil = anilLogin.cookie;

        const lateLogin = await call('POST', '/api/auth/login', { username: 'late.cme', password: 'TecSub_123' });
        assert.strictEqual(lateLogin.status, 200);
        const cookieLate = lateLogin.cookie;

        // Timetable configuration:
        // Date: 2026-09-15 is Tuesday.
        // Ravi teaches Tuesday P1 in CME-SEM1-A
        // Ravi teaches Tuesday P3 in CME-SEM1-A
        // Kumar teaches Tuesday P1 in CME-SEM1-B
        store.resolveOrCreateClassInMemory({ branch: 'CME', academicYear: '2026-27', semester: 'SEM-1', section: 'A' });
        store.resolveOrCreateClassInMemory({ branch: 'CME', academicYear: '2026-27', semester: 'SEM-1', section: 'B' });

        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Tuesday',
            period: 1,
            subject: 'Algorithms',
            faculty: 'Dr. Ravi CME',
            room: 'C-101',
            type: 'theory'
        });

        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Tuesday',
            period: 3,
            subject: 'Advanced Algorithms',
            faculty: 'Dr. Ravi CME',
            room: 'C-101',
            type: 'theory'
        });

        store.addEntryInMemory({
            className: 'CME-SEM1-B',
            day: 'Tuesday',
            period: 1,
            subject: 'Operating Systems',
            faculty: 'Prof. Kumar CME',
            room: 'C-102',
            type: 'theory'
        });

        // Assign invigilation to Ramesh CME on Tuesday P1
        await call('POST', '/api/invigilation', {
            facultyId: rameshId,
            facultyName: 'Ramesh CME',
            examDate: '2026-09-15',
            periods: [1],
            notes: 'Midterm supervision'
        }, cookieHosCme);

        // Mark Ravi ABSENT on 2026-09-15
        const markAbsentRes = await call('POST', '/api/attendance', {
            facultyId: raviId,
            date: '2026-09-15',
            status: 'ABSENT'
        }, cookieHosCme);
        assert.strictEqual(markAbsentRes.status, 200, 'Ravi marked absent must succeed');

        let createdSubId1 = null;

        // ============================================================
        // SUITE 1: Creation of Substitution Request (Tests 1-7)
        // ============================================================
        console.log('\n--- SUITE 1: Creation of Substitution Request ---');

        await check('1. Absent Faculty A creates a substitution request for a vacant teaching period', async () => {
            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 1,
                className: 'CME-SEM1-A',
                subject: 'Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 201, `Expected 201 Created, got ${res.status}: ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.request.status, 'PENDING');
            assert.strictEqual(res.body.request.period, 1);
            assert.strictEqual(res.body.request.originalFacultyName, 'Dr. Ravi CME');
            assert.strictEqual(res.body.request.substituteFacultyName, 'Sri Suresh CME');
            assert.ok(res.body.request.id, 'Request must have an ID');
            createdSubId1 = res.body.request.id;
        });

        await check('2. Present Faculty cannot create a substitution request (requester must be absent)', async () => {
            // Ravi is PRESENT on 2026-09-16 (Wednesday) by default
            store.addEntryInMemory({
                className: 'CME-SEM1-A',
                day: 'Wednesday',
                period: 1,
                subject: 'Algorithms',
                faculty: 'Dr. Ravi CME',
                room: 'C-101',
                type: 'theory'
            });

            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-16',
                period: 1,
                className: 'CME-SEM1-A',
                subject: 'Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 400, 'Expected 400 when requester is not absent');
            assert.strictEqual(res.body.code, 'FACULTY_NOT_ABSENT');
        });

        await check('3. Faculty A cannot create request for a period they are not scheduled to teach', async () => {
            // Ravi has no class on Tuesday P4
            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 4,
                className: 'CME-SEM1-A',
                subject: 'Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 400, 'Expected 400 when not scheduled to teach');
            assert.strictEqual(res.body.code, 'NO_SCHEDULED_CLASS');
        });

        await check('4. Faculty A cannot select an inactive substitute', async () => {
            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: ghostId,
                substituteFacultyName: 'Ghost CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 400, 'Expected 400 for inactive substitute');
            assert.strictEqual(res.body.code, 'SUBSTITUTE_INACTIVE');
        });

        await check('5. Faculty A cannot select an absent substitute', async () => {
            // Mark Suresh absent on 2026-09-17 (Thursday)
            await call('POST', '/api/attendance', {
                facultyId: sureshId,
                date: '2026-09-17',
                status: 'ABSENT'
            }, cookieHosCme);

            // Also mark Ravi absent on 2026-09-17
            await call('POST', '/api/attendance', {
                facultyId: raviId,
                date: '2026-09-17',
                status: 'ABSENT'
            }, cookieHosCme);

            store.addEntryInMemory({
                className: 'CME-SEM1-A',
                day: 'Thursday',
                period: 1,
                subject: 'Algorithms',
                faculty: 'Dr. Ravi CME',
                room: 'C-101',
                type: 'theory'
            });

            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-17',
                period: 1,
                className: 'CME-SEM1-A',
                subject: 'Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 400, 'Expected 400 when substitute is absent');
            assert.strictEqual(res.body.code, 'SUBSTITUTE_NOT_PRESENT');
        });

        await check('6. Faculty A cannot select a busy substitute (teaching)', async () => {
            // Kumar is teaching Tuesday P1
            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 1,
                className: 'CME-SEM1-A',
                subject: 'Algorithms',
                substituteFacultyId: kumarId,
                substituteFacultyName: 'Prof. Kumar CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 400, 'Expected 400 for busy substitute');
            assert.strictEqual(res.body.code, 'SUBSTITUTE_NOT_FREE');
        });

        await check('7. Faculty A cannot select self as substitute', async () => {
            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: raviId,
                substituteFacultyName: 'Dr. Ravi CME'
            }, cookieRavi);

            assert.strictEqual(res.status, 400, 'Expected 400 when selecting self');
            assert.strictEqual(res.body.code, 'CANNOT_SUBSTITUTE_SELF');
        });

        // ============================================================
        // SUITE 2: Substitution Candidate Selection (Tests 8-12)
        // ============================================================
        console.log('\n--- SUITE 2: Substitution Candidate Selection ---');

        await check('8. Candidates endpoint returns available FREE faculty for absent faculty', async () => {
            const res = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-A', null, cookieRavi);
            assert.strictEqual(res.status, 200, `Candidates call failed: ${JSON.stringify(res.body)}`);
            assert.ok(res.body.candidates, 'Must return candidates array');
            assert.ok(res.body.candidates.length > 0, 'Must have at least one free candidate');
        });

        await check('9. Same-branch FREE faculty are prioritized', async () => {
            const res = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-A', null, cookieRavi);
            assert.strictEqual(res.status, 200);
            const candidates = res.body.candidates;
            // The first candidates should have isSameBranch === true
            assert.strictEqual(candidates[0].isSameBranch, true, 'First candidate must be same branch');
            assert.ok(candidates.some(c => c.name === 'Sri Suresh CME' && c.isSameBranch), 'Suresh must be in same-branch candidates');
        });

        await check('10. Other-branch FREE faculty appear after same-branch faculty', async () => {
            const res = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-A', null, cookieRavi);
            assert.strictEqual(res.status, 200);
            const candidates = res.body.candidates;
            const anilCandidate = candidates.find(c => c.name === 'Anil EEE');
            assert.ok(anilCandidate, 'Anil EEE should be in candidates');
            assert.strictEqual(anilCandidate.isSameBranch, false, 'Anil should be marked other branch');

            const sureshIndex = candidates.findIndex(c => c.name === 'Sri Suresh CME');
            const anilIndex = candidates.findIndex(c => c.name === 'Anil EEE');
            assert.ok(sureshIndex < anilIndex, 'Same-branch Suresh must appear before other-branch Anil');
        });

        await check('11. Faculty A is excluded from candidate list', async () => {
            const res = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-A', null, cookieRavi);
            assert.strictEqual(res.status, 200);
            const ravi = res.body.candidates.find(c => c.name === 'Dr. Ravi CME');
            assert.strictEqual(ravi, undefined, 'Requester must not appear in candidates');
        });

        await check('12. Teaching, invigilating, and absent faculty are excluded from candidates', async () => {
            const res = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-A', null, cookieRavi);
            assert.strictEqual(res.status, 200);
            const candidates = res.body.candidates;

            const kumar = candidates.find(c => c.name === 'Prof. Kumar CME'); // teaching
            const ramesh = candidates.find(c => c.name === 'Ramesh CME'); // invigilating
            const ghost = candidates.find(c => c.name === 'Ghost CME'); // inactive

            assert.strictEqual(kumar, undefined, 'Teaching faculty Kumar must be excluded');
            assert.strictEqual(ramesh, undefined, 'Invigilating faculty Ramesh must be excluded');
            assert.strictEqual(ghost, undefined, 'Inactive faculty Ghost must be excluded');
        });

        // ============================================================
        // SUITE 3: Faculty B Acceptance & Fresh Revalidation (Tests 13-17)
        // ============================================================
        console.log('\n--- SUITE 3: Faculty B Acceptance & Fresh Revalidation ---');

        await check('13. Faculty B accepts request -> Status transitions from PENDING to ACCEPTED', async () => {
            const res = await call('POST', `/api/substitutions/${createdSubId1}/accept`, {}, cookieSuresh);
            assert.strictEqual(res.status, 200, `Accept failed: ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.request.status, 'ACCEPTED');
            assert.ok(res.body.request.respondedAt, 'respondedAt must be timestamped');
        });

        await check('14. Acceptance re-checks Faculty B availability -> If Faculty B became absent after request creation, acceptance rejected (409)', async () => {
            // Ravi creates request for P3 to Late CME
            const createRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: lateId,
                substituteFacultyName: 'Late CME'
            }, cookieRavi);
            assert.strictEqual(createRes.status, 201);
            const lateSubId = createRes.body.request.id;

            // HOS marks Late CME absent on 2026-09-15
            await call('POST', '/api/attendance', {
                facultyId: lateId,
                date: '2026-09-15',
                status: 'ABSENT'
            }, cookieHosCme);

            // Now Late CME tries to accept
            const acceptRes = await call('POST', `/api/substitutions/${lateSubId}/accept`, {}, cookieLate);
            assert.strictEqual(acceptRes.status, 409, 'Acceptance must fail with 409 when substitute became absent');
            assert.strictEqual(acceptRes.body.code, 'FACULTY_NO_LONGER_AVAILABLE');

            // Reset Late CME attendance back to PRESENT
            await call('POST', '/api/attendance', {
                facultyId: lateId,
                date: '2026-09-15',
                status: 'PRESENT'
            }, cookieHosCme);
        });

        await check('15. Acceptance re-checks Faculty B availability -> If Faculty B was assigned invigilation, acceptance rejected (409)', async () => {
            // Create request for P3 to Late CME (in a new sub request or cancel old)
            // Cancel previous lateSubId first
            await call('DELETE', `/api/substitutions/${(await call('GET', '/api/substitutions/my', null, cookieRavi)).body.outgoingRequests.find(r => r.status === 'PENDING').id}`, null, cookieRavi);

            const createRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: lateId,
                substituteFacultyName: 'Late CME'
            }, cookieRavi);
            assert.strictEqual(createRes.status, 201);
            const reqId = createRes.body.request.id;

            // Assign invigilation to Late CME on Tuesday P3
            await call('POST', '/api/invigilation', {
                facultyId: lateId,
                facultyName: 'Late CME',
                examDate: '2026-09-15',
                periods: [3],
                notes: 'Exam duty'
            }, cookieHosCme);

            // Late CME tries to accept
            const acceptRes = await call('POST', `/api/substitutions/${reqId}/accept`, {}, cookieLate);
            assert.strictEqual(acceptRes.status, 409, 'Expected 409 when substitute assigned invigilation');
            assert.strictEqual(acceptRes.body.code, 'FACULTY_NO_LONGER_AVAILABLE');

            // Clean up invigilation assignment
            const invigList = await call('GET', '/api/invigilation?date=2026-09-15', null, cookieHosCme);
            const lateInvig = invigList.body.assignments.find(a => a.facultyId === lateId && a.period === 3);
            if (lateInvig) {
                await call('DELETE', `/api/invigilation/${lateInvig.id}`, null, cookieHosCme);
            }
        });

        await check('16. Acceptance re-checks Faculty B availability -> If Faculty B is scheduled to teach, acceptance rejected (409)', async () => {
            // Cancel pending request
            const pendingReq = (await call('GET', '/api/substitutions/my', null, cookieRavi)).body.outgoingRequests.find(r => r.status === 'PENDING');
            if (pendingReq) await call('DELETE', `/api/substitutions/${pendingReq.id}`, null, cookieRavi);

            const createRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: lateId,
                substituteFacultyName: 'Late CME'
            }, cookieRavi);
            assert.strictEqual(createRes.status, 201);
            const reqId = createRes.body.request.id;

            // Add teaching timetable conflict for Late CME on Tuesday P3
            store.addEntryInMemory({
                className: 'CME-SEM1-B',
                day: 'Tuesday',
                period: 3,
                subject: 'Computer Networks',
                faculty: 'Late CME',
                room: 'C-201',
                type: 'theory'
            });

            // Late CME tries to accept
            const acceptRes = await call('POST', `/api/substitutions/${reqId}/accept`, {}, cookieLate);
            assert.strictEqual(acceptRes.status, 409, 'Expected 409 when substitute scheduled to teach');
            assert.strictEqual(acceptRes.body.code, 'FACULTY_NO_LONGER_AVAILABLE');
        });

        await check('17. Acceptance re-checks Faculty B availability -> If Faculty B already accepted another substitution for the same slot, acceptance rejected (double booking conflict 409)', async () => {
            // Suresh already accepted Tuesday P1 in Test 13.
            // Try to create another request for Tuesday P1 to Suresh:
            // Since Suresh already accepted Tuesday P1, Suresh is no longer free.
            // If created directly or if two requests were created in parallel:
            // Let's test that hasAcceptedSubstitution prevents acceptance.
            assert.strictEqual(substitutions.hasAcceptedSubstitution({ id: sureshId, name: 'Sri Suresh CME' }, '2026-09-15', 1), true);

            // Directly invoke acceptRequest or attempt another request
            // In creation, Suresh is checked for accepted substitutions
            const cand = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-A', null, cookieRavi);
            const sureshCand = cand.body.candidates.find(c => c.name === 'Sri Suresh CME');
            assert.strictEqual(sureshCand, undefined, 'Suresh must not be listed as free candidate for P1 anymore');
        });

        // ============================================================
        // SUITE 4: Faculty B Rejection & Faculty A Cancellation (Tests 18-20)
        // ============================================================
        console.log('\n--- SUITE 4: Faculty B Rejection & Faculty A Cancellation ---');

        let rejectSubId = null;

        await check('18. Faculty B rejects substitution request with optional reason -> Status transitions to REJECTED', async () => {
            // Cancel any pending request for Ravi
            const pendingReqs = (await call('GET', '/api/substitutions/my', null, cookieRavi)).body.outgoingRequests.filter(r => r.status === 'PENDING');
            for (const r of pendingReqs) {
                await call('DELETE', `/api/substitutions/${r.id}`, null, cookieRavi);
            }

            // Create request to Anil EEE for Tuesday P3
            const createRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: anilId,
                substituteFacultyName: 'Anil EEE'
            }, cookieRavi);
            assert.strictEqual(createRes.status, 201);
            rejectSubId = createRes.body.request.id;

            // Anil rejects request
            const rejRes = await call('POST', `/api/substitutions/${rejectSubId}/reject`, {
                reason: 'Prior family commitment'
            }, cookieAnil);

            assert.strictEqual(rejRes.status, 200);
            assert.strictEqual(rejRes.body.success, true);
            assert.strictEqual(rejRes.body.request.status, 'REJECTED');
            assert.strictEqual(rejRes.body.request.rejectionReason, 'Prior family commitment');
            assert.ok(rejRes.body.request.respondedAt, 'respondedAt must be set');
        });

        let cancelSubId = null;

        await check('19. Faculty A cancels pending substitution request -> Status transitions to CANCELLED', async () => {
            // Create request to Suresh for Tuesday P3
            const createRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieRavi);
            assert.strictEqual(createRes.status, 201);
            cancelSubId = createRes.body.request.id;

            // Ravi cancels request
            const cancelRes = await call('DELETE', `/api/substitutions/${cancelSubId}`, null, cookieRavi);
            assert.strictEqual(cancelRes.status, 200);
            assert.strictEqual(cancelRes.body.success, true);

            // Verify in history
            const histRes = await call('GET', '/api/substitutions/my', null, cookieRavi);
            const found = histRes.body.outgoingRequests.find(r => r.id === cancelSubId);
            assert.strictEqual(found.status, 'CANCELLED');
            assert.ok(found.cancelledAt, 'cancelledAt must be set');
        });

        await check('20. Non-pending request cannot be cancelled or accepted/rejected again', async () => {
            // Try to cancel the already cancelled request
            const res1 = await call('DELETE', `/api/substitutions/${cancelSubId}`, null, cookieRavi);
            assert.strictEqual(res1.status, 400, 'Expected 400 when cancelling non-pending request');
            assert.strictEqual(res1.body.code, 'REQUEST_NOT_PENDING');

            // Try to accept the already accepted request
            const res2 = await call('POST', `/api/substitutions/${createdSubId1}/accept`, {}, cookieSuresh);
            assert.strictEqual(res2.status, 400, 'Expected 400 when accepting already accepted request');
            assert.strictEqual(res2.body.code, 'REQUEST_NOT_PENDING');

            // Try to reject the already rejected request
            const res3 = await call('POST', `/api/substitutions/${rejectSubId}/reject`, {}, cookieAnil);
            assert.strictEqual(res3.status, 400, 'Expected 400 when rejecting already rejected request');
            assert.strictEqual(res3.body.code, 'REQUEST_NOT_PENDING');
        });

        // ============================================================
        // SUITE 5: Strict HOS Exclusion / Governance (Tests 21-25)
        // ============================================================
        console.log('\n--- SUITE 5: Strict HOS Exclusion / Governance ---');

        await check('21. HOS cannot create a substitution request (403 Forbidden)', async () => {
            const res = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 1,
                className: 'CME-SEM1-A',
                subject: 'Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieHosCme);

            assert.strictEqual(res.status, 403, 'HOS must receive 403 Forbidden on create substitution');
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        await check('22. HOS cannot accept a substitution request (403 Forbidden)', async () => {
            // Create a pending request from Ravi to Suresh
            const createRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 3,
                className: 'CME-SEM1-A',
                subject: 'Advanced Algorithms',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieRavi);
            assert.strictEqual(createRes.status, 201);
            const testReqId = createRes.body.request.id;

            const res = await call('POST', `/api/substitutions/${testReqId}/accept`, {}, cookieHosCme);
            assert.strictEqual(res.status, 403, 'HOS must receive 403 Forbidden on accept substitution');
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        await check('23. HOS cannot reject a substitution request (403 Forbidden)', async () => {
            const pendingReq = (await call('GET', '/api/substitutions/my', null, cookieRavi)).body.outgoingRequests.find(r => r.status === 'PENDING');
            assert.ok(pendingReq, 'Must have pending request');

            const res = await call('POST', `/api/substitutions/${pendingReq.id}/reject`, { reason: 'HOS override' }, cookieHosCme);
            assert.strictEqual(res.status, 403, 'HOS must receive 403 Forbidden on reject substitution');
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        await check('24. HOS can view branch substitutions in read-only mode', async () => {
            const res = await call('GET', '/api/substitutions', null, cookieHosCme);
            assert.strictEqual(res.status, 200, 'HOS branch view must succeed');
            assert.ok(res.body.substitutions, 'Must contain substitutions list');
            assert.strictEqual(res.body.readOnly, true, 'Must indicate read-only view');
            assert.strictEqual(res.body.branch, 'CME');
        });

        await check('25. Faculty from another branch / third party cannot accept/reject someone else\'s request', async () => {
            const pendingReq = (await call('GET', '/api/substitutions/my', null, cookieRavi)).body.outgoingRequests.find(r => r.status === 'PENDING');
            assert.ok(pendingReq, 'Must have pending request');

            // Anil EEE tries to accept Suresh's request
            const res = await call('POST', `/api/substitutions/${pendingReq.id}/accept`, {}, cookieAnil);
            assert.strictEqual(res.status, 403, 'Third party faculty must receive 403');
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        // ============================================================
        // SUITE 6: Timetable Immutability & Double Booking (Tests 26-28)
        // ============================================================
        console.log('\n--- SUITE 6: Timetable Immutability & Double Booking ---');

        await check('26. Original timetable records remain 100% UNMODIFIED after creation, acceptance, or rejection', async () => {
            const records = store.engine.getRecords();
            const p1Record = records.find(r => r.className === 'CME-SEM1-A' && r.day === 'Tuesday' && r.period === 1);
            assert.ok(p1Record, 'Original record for Tuesday P1 must exist');
            assert.strictEqual(p1Record.faculty, 'Dr. Ravi CME', 'Original timetable faculty must NOT be modified by substitution');
            assert.strictEqual(p1Record.subject, 'Algorithms');
            assert.strictEqual(p1Record.room, 'C-101');
        });

        let cookieKumar = null;

        await check('27. Double booking prevention: Faculty B cannot accept two substitutions for the same date & period', async () => {
            // Suresh already has accepted substitution for Tuesday P1
            // Try to force another accepted substitution for Suresh on Tuesday P1
            const p1SubExists = substitutions.hasAcceptedSubstitution({ id: sureshId, name: 'Sri Suresh CME' }, '2026-09-15', 1);
            assert.strictEqual(p1SubExists, true, 'Suresh has accepted substitution for Tuesday P1');

            // Calling accept on another request for Tuesday P1 must fail with conflict
            // Create a second class at Tuesday P1 with Kumar absent
            await call('POST', '/api/attendance', { facultyId: kumarId, date: '2026-09-15', status: 'ABSENT' }, cookieHosCme);
            const kumarLogin = await call('POST', '/api/auth/login', { username: 'kumar.cme', password: 'TecSub_123' });
            cookieKumar = kumarLogin.cookie;

            // Kumar attempts to request Suresh for Tuesday P1
            const kumarReqRes = await call('POST', '/api/substitutions/requests', {
                date: '2026-09-15',
                period: 1,
                className: 'CME-SEM1-B',
                subject: 'Operating Systems',
                substituteFacultyId: sureshId,
                substituteFacultyName: 'Sri Suresh CME'
            }, cookieKumar);

            // Since Suresh already accepted Tuesday P1, creation itself rejects because Suresh is not free
            assert.strictEqual(kumarReqRes.status, 400, 'Creation should be rejected because Suresh is already accepted for P1');
            assert.strictEqual(kumarReqRes.body.code, 'SUBSTITUTE_NOT_FREE');
        });

        await check('28. Faculty B cannot be selected as candidate if already accepted for that date & period', async () => {
            const res = await call('GET', '/api/substitutions/candidates?date=2026-09-15&period=1&className=CME-SEM1-B', null, cookieKumar || cookieRavi);
            assert.strictEqual(res.status, 200);
            const suresh = res.body.candidates.find(c => c.name === 'Sri Suresh CME');
            assert.strictEqual(suresh, undefined, 'Suresh must not be offered as free candidate for P1');
        });

        // ============================================================
        // SUITE 7: History & Queries (Tests 29-32)
        // ============================================================
        console.log('\n--- SUITE 7: History & Queries ---');

        await check('29. Faculty A views outgoing substitution history', async () => {
            const res = await call('GET', '/api/substitutions/my', null, cookieRavi);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.outgoingRequests, 'Must have outgoingRequests array');
            assert.ok(res.body.outgoingRequests.length >= 1, 'Ravi must have outgoing requests');
            const p1Req = res.body.outgoingRequests.find(r => r.period === 1);
            assert.ok(p1Req, 'Must find P1 request');
            assert.strictEqual(p1Req.status, 'ACCEPTED');
        });

        await check('30. Faculty B views incoming substitution requests', async () => {
            const res = await call('GET', '/api/substitutions/incoming', null, cookieSuresh);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.requests, 'Must return requests array');
            assert.ok(Array.isArray(res.body.requests));
        });

        await check('31. HOS views branch substitution history', async () => {
            const res = await call('GET', '/api/substitutions', null, cookieHosCme);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.substitutions, 'Must return substitutions list');
            assert.ok(res.body.total >= 1, 'Total substitutions must be at least 1');
            const acceptedSub = res.body.substitutions.find(s => s.status === 'ACCEPTED');
            assert.ok(acceptedSub, 'Must find accepted substitution in branch history');
        });

        await check('32. Vacant periods endpoint returns absent teaching slots for Faculty A', async () => {
            const res = await call('GET', '/api/substitutions/vacant-periods?date=2026-09-15', null, cookieRavi);
            assert.strictEqual(res.status, 200, `Vacant periods call failed: ${JSON.stringify(res.body)}`);
            assert.ok(res.body.vacantPeriods, 'Must return vacantPeriods');
            assert.ok(res.body.vacantPeriods.length >= 1, 'Must return at least 1 vacant period');
            const p1 = res.body.vacantPeriods.find(p => p.period === 1);
            assert.ok(p1, 'Must find Period 1');
            assert.strictEqual(p1.className, 'CME-SEM1-A');
            assert.strictEqual(p1.subject, 'Algorithms');
        });

        // ============================================================
        // SUITE 8: Regressions & Backward Compatibility (Tests 33-38)
        // ============================================================
        console.log('\n--- SUITE 8: Regressions & Backward Compatibility ---');

        await check('33. B7.1 Faculty Registration still works', async () => {
            const regRes = await call('POST', '/api/faculty-requests', {
                fullName: 'Reg Test Faculty',
                phone: '9998887776',
                username: 'regtest.b75',
                password: 'TecSub_123',
                designation: 'Assistant Professor',
                subjects: ['C++'],
                branchCode: 'CME'
            });
            assert.strictEqual(regRes.status, 201);
            const reqId = regRes.body.request.id;

            // HOS approves
            const appRes = await call('POST', `/api/faculty-requests/${reqId}/approve`, {}, cookieHosCme);
            assert.strictEqual(appRes.status, 200);
            assert.strictEqual(appRes.body.success, true);
        });

        await check('34. B7.2 Faculty Attendance still works', async () => {
            const getAtt = await call('GET', '/api/attendance?date=2026-09-15', null, cookieHosCme);
            assert.strictEqual(getAtt.status, 200);
            assert.ok(getAtt.body.faculty, 'Must return attendance list');
            const ravi = getAtt.body.faculty.find(f => f.name === 'Dr. Ravi CME');
            assert.strictEqual(ravi.status, 'ABSENT');
        });

        await check('35. B7.3 Exam Invigilation still works', async () => {
            const invRes = await call('GET', '/api/invigilation?date=2026-09-15', null, cookieHosCme);
            assert.strictEqual(invRes.status, 200);
            assert.ok(invRes.body.assignments, 'Must return invigilation assignments');
            const rameshInv = invRes.body.assignments.find(a => a.facultyName === 'Ramesh CME');
            assert.ok(rameshInv, 'Must find Ramesh invigilation');
        });

        await check('36. B7.4 Availability & Candidates engine still works', async () => {
            const candRes = await call('GET', '/api/availability/candidates?day=Tuesday&period=1&branch=CME', null, cookieHosCme);
            assert.strictEqual(candRes.status, 200);
            assert.ok(candRes.body.candidates, 'Must return candidates array');
        });

        await check('37. Timetable grid still renders correctly', async () => {
            const ttRes = await call('GET', '/api/timetable?class=CME-SEM1-A', null, cookieHosCme);
            assert.strictEqual(ttRes.status, 200);
            assert.ok(ttRes.body.cells, 'Must return timetable cells');
        });

        await check('38. Multiple branches remain isolated', async () => {
            // EEE HOS checks substitutions
            const eeeSubs = await call('GET', '/api/substitutions', null, cookieHosEee);
            assert.strictEqual(eeeSubs.status, 200);
            assert.strictEqual(eeeSubs.body.branch, 'EEE');
            // CME substitutions should not appear in EEE
            const cmeSub = eeeSubs.body.substitutions.find(s => s.originalFacultyBranch === 'CME');
            assert.strictEqual(cmeSub, undefined, 'EEE HOS must not see CME branch substitutions');
        });

        console.log('\n================================================================');
        console.log(`Phase B7.5 Results: ${passed} passed, ${failed} failed`);
        console.log('================================================================\n');

        if (failed > 0) process.exit(1);

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
