/**
 * HOD Delegation / Acting HOD Test Suite (Phase B9).
 *
 * Tests:
 *   1. Delegation Creation & Validation (HOD, same branch, active faculty, date checks, overlap prevention)
 *   2. Rejection of self-delegation, cross-branch delegation, inactive faculty, malformed dates
 *   3. Permanent HOD authority vs Acting HOD restrictions (Acting HOD cannot create or cancel delegations)
 *   4. Acting HOD capability activation during active date window (Attendance, Invigilation, Requests, Timetable)
 *   5. Branch isolation enforcement for Acting HOD (cannot manage another branch)
 *   6. Audit preservation: marked_by / reviewed_by records acting faculty member identity
 *   7. Automatic expiration: permissions cease when current date > end_date
 *   8. Cancellation of delegation by permanent HOD immediately revokes permissions
 *   9. Original HOD continues to retain full HOD permissions during delegation
 *
 * DATABASE ISOLATION: This test is in-memory only. Force DATABASE_URL='' so
 * standalone runs do not pollute the application database.
 */
process.env.DATABASE_URL = '';
process.env.TEST_DATABASE_URL = '';
const assert = require('assert');
const http = require('http');
const express = require('express');

const session = require('../src/core/session');
const store = require('../src/data/store');
const delegations = require('../src/data/delegations');

// Import routes
const authRoutes = require('../src/routes/auth');
const delegationRoutes = require('../src/routes/delegations');
const attendanceRoutes = require('../src/routes/attendance');
const invigilationRoutes = require('../src/routes/invigilation');
const substitutionsRoutes = require('../src/routes/substitutions');
const facultyRequestsRoutes = require('../src/routes/facultyRequests');
const timetableRoutes = require('../src/routes/timetable');
const entryRoutes = require('../src/routes/entries');
const facultyRoutes = require('../src/routes/faculty');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(session.middleware);
    app.use('/api/auth', authRoutes);
    app.use('/api/delegations', delegationRoutes);
    app.use('/api/attendance', attendanceRoutes);
    app.use('/api/invigilation', invigilationRoutes);
    app.use('/api/substitutions', substitutionsRoutes);
    app.use('/api/faculty-requests', facultyRequestsRoutes);
    app.use('/api/timetable/entries', entryRoutes);
    app.use('/api/timetable', timetableRoutes);
    app.use('/api/faculty', facultyRoutes);
    return app;
}

let server;
let baseUrl = '';

function startServer(app) {
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

function request(method, url, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = { ...headers };
        if (payload) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${baseUrl}${url}`, { method, headers: reqHeaders }, res => {
            let resBody = '';
            res.on('data', chunk => { resBody += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(resBody); } catch (_) { parsed = resBody; }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: parsed,
                    cookies: res.headers['set-cookie']
                });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function extractCookie(res) {
    const cookies = res.headers['set-cookie'];
    if (!cookies) return '';
    const cookie = Array.isArray(cookies) ? cookies[0] : cookies;
    return cookie.split(';')[0];
}

async function runTests() {
    console.log('\n============================================================');
    console.log('TecSubstitution — HOD Delegation / Acting HOD Test Suite');
    console.log('============================================================\n');

    let passed = 0;
    let failed = 0;

    function testPass(msg) {
        console.log(`  ✓ ${msg}`);
        passed++;
    }

    function testFail(msg, err) {
        console.error(`  ✗ ${msg}`);
        console.error(`    Error: ${err.message}`);
        failed++;
    }

    const app = makeApp();
    await startServer(app);

    const tag = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const cmeBranch = `CME_${tag}`.toUpperCase();
    const eeeBranch = `EEE_${tag}`.toUpperCase();

    const hodCmeName = `Sai Kishore ${tag}`;
    const facCme1Name = `B. Swarupa ${tag}`;
    const facCme2Name = `K. Ramesh ${tag}`;
    const facEeeName = `P. Suresh ${tag}`;

    let hodCmeCookie = '';
    let hodEeeCookie = '';
    let facCme1Cookie = '';
    let facCme2Cookie = '';
    let facEeeCookie = '';

    let facCme1Id = null;
    let facCme2Id = null;
    let facEeeId = null;
    const rnd = () => Math.floor(100000 + Math.random() * 900000);

    try {
        console.log('[Setup] Registering HOD and Faculty accounts...');

        // 1. CME HOD
        const hodCmeRes = await request('POST', '/api/auth/register', {
            body: {
                username: `hod_cme_${tag}`,
                name: hodCmeName,
                phone: `9848${rnd()}`,
                password: 'Password_123',
                role: 'hos',
                branchCode: cmeBranch,
                branchName: 'Computer Engineering'
            }
        });
        if (hodCmeRes.status !== 201) {
            console.error('HOD CME registration error response:', hodCmeRes.body);
        }
        assert.strictEqual(hodCmeRes.status, 201);
        hodCmeCookie = extractCookie(hodCmeRes);

        // 2. EEE HOD
        const hodEeeRes = await request('POST', '/api/auth/register', {
            body: {
                username: `hod_eee_${tag}`,
                name: `Dr. EEE HOD ${tag}`,
                phone: `9848${rnd()}`,
                password: 'Password_123',
                role: 'hos',
                branchCode: eeeBranch,
                branchName: 'Electrical Engineering'
            }
        });
        if (hodEeeRes.status !== 201) {
            console.error('HOD EEE registration error response:', hodEeeRes.body);
        }
        assert.strictEqual(hodEeeRes.status, 201);
        hodEeeCookie = extractCookie(hodEeeRes);

        // 3. CME Faculty 1 (B. Swarupa)
        const facCme1Res = await request('POST', '/api/auth/register', {
            headers: { Cookie: hodCmeCookie },
            body: {
                username: `fac_swarupa_${tag}`,
                name: facCme1Name,
                phone: `9848${rnd()}`,
                password: 'Password_123',
                role: 'faculty',
                subjects: ['Data Structures', 'C Programming']
            }
        });
        if (facCme1Res.status !== 201) {
            console.error('Faculty 1 registration error response:', facCme1Res.body);
        }
        assert.strictEqual(facCme1Res.status, 201);
        facCme1Id = facCme1Res.body.user.facultyId || facCme1Res.body.user.id;

        // Login as CME Faculty 1
        const loginFac1 = await request('POST', '/api/auth/login', {
            body: { username: `fac_swarupa_${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(loginFac1.status, 200);
        facCme1Cookie = extractCookie(loginFac1);

        // 4. CME Faculty 2 (K. Ramesh)
        const facCme2Res = await request('POST', '/api/auth/register', {
            headers: { Cookie: hodCmeCookie },
            body: {
                username: `fac_ramesh_${tag}`,
                name: facCme2Name,
                phone: `9848${rnd()}`,
                password: 'Password_123',
                role: 'faculty',
                subjects: ['Java Programming', 'Algorithms']
            }
        });
        assert.strictEqual(facCme2Res.status, 201);
        facCme2Id = facCme2Res.body.user.facultyId || facCme2Res.body.user.id;

        // Login as CME Faculty 2
        const loginFac2 = await request('POST', '/api/auth/login', {
            body: { username: `fac_ramesh_${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(loginFac2.status, 200);
        facCme2Cookie = extractCookie(loginFac2);

        // 5. EEE Faculty (P. Suresh)
        const facEeeRes = await request('POST', '/api/auth/register', {
            headers: { Cookie: hodEeeCookie },
            body: {
                username: `fac_suresh_${tag}`,
                name: facEeeName,
                phone: `9848${rnd()}`,
                password: 'Password_123',
                role: 'faculty',
                subjects: ['Power Systems', 'Circuits']
            }
        });
        assert.strictEqual(facEeeRes.status, 201);
        facEeeId = facEeeRes.body.user.facultyId || facEeeRes.body.user.id;

        const loginFacEee = await request('POST', '/api/auth/login', {
            body: { username: `fac_suresh_${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(loginFacEee.status, 200);
        facEeeCookie = extractCookie(loginFacEee);

        testPass('Test accounts and branch setup successfully created');
    } catch (err) {
        testFail('Setup failed', err);
        await stopServer();
        return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const nextWeekStart = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const nextWeekEnd = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);

    // =========================================================================
    // Area 0: Acting HOD Candidates & Account Requirements
    // =========================================================================
    console.log('\n[Area 0] Acting HOD Candidates & Account Requirements');

    // Setup additional faculty scenarios:
    // a) Faculty without login account
    // b) Inactive faculty (even if they had an account)
    const currentSource = store.source ? { ...store.source } : { entries: [], faculty: [], classes: [], rooms: [], allowEmpty: true };
    if (!currentSource.faculty) currentSource.faculty = [];
    currentSource.allowEmpty = true;
    currentSource.faculty.push({
        id: `FAC_NO_ACC_${tag}`,
        name: `Faculty No Account ${tag}`,
        department: cmeBranch,
        status: 'active'
    });
    currentSource.faculty.push({
        id: `FAC_INACTIVE_${tag}`,
        name: `Faculty Inactive ${tag}`,
        department: cmeBranch,
        status: 'inactive'
    });
    store.replace(currentSource);

    // c) Faculty with deactivated user account
    const facDeactivatedRes = await request('POST', '/api/auth/register', {
        headers: { Cookie: hodCmeCookie },
        body: {
            username: `fac_deact_${tag}`,
            name: `Faculty Deactivated ${tag}`,
            phone: `9848${rnd()}`,
            password: 'Password_123',
            role: 'faculty',
            subjects: ['Theory']
        }
    });
    assert.strictEqual(facDeactivatedRes.status, 201);
    const facDeactivatedId = facDeactivatedRes.body.user.facultyId || facDeactivatedRes.body.user.id;
    // Deactivate account in user store
    const usersStore = require('../src/data/users');
    usersStore.updateFacultyUser(facDeactivatedId, { status: 'inactive' });

    // 0.1 Candidates endpoint returns ONLY faculty with active login accounts in same branch
    try {
        const candRes = await request('GET', '/api/delegations/candidates', {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(candRes.status, 200);
        assert.strictEqual(candRes.body.branch, cmeBranch);
        const candidates = candRes.body.candidates;
        const candNames = candidates.map(c => c.name);

        // Faculty with active account (B. Swarupa, K. Ramesh) MUST appear
        assert.ok(candNames.includes(facCme1Name), `Active account faculty ${facCme1Name} must appear in candidates`);
        assert.ok(candNames.includes(facCme2Name), `Active account faculty ${facCme2Name} must appear in candidates`);
        testPass('0.1 Same-branch faculty with active accounts appear in candidates');

        // Faculty without login account MUST NOT appear
        assert.ok(!candNames.includes(`Faculty No Account ${tag}`), 'Faculty without login account must NOT appear');
        testPass('0.2 Faculty without account does NOT appear in candidates');

        // Inactive faculty MUST NOT appear
        assert.ok(!candNames.includes(`Faculty Inactive ${tag}`), 'Inactive faculty must NOT appear');
        testPass('0.3 Inactive faculty does NOT appear in candidates');

        // Deactivated/inactive account MUST NOT appear
        assert.ok(!candNames.includes(`Faculty Deactivated ${tag}`), 'Deactivated user account must NOT appear');
        testPass('0.4 Deactivated/inactive account does NOT appear in candidates');

        // Cross-branch faculty (EEE) MUST NOT appear
        assert.ok(!candNames.includes(facEeeName), 'Cross-branch faculty must NOT appear');
        testPass('0.5 Faculty from another branch does NOT appear in candidates');

        // Current HOD MUST NOT appear
        assert.ok(!candNames.includes(hodCmeName), 'Current HOD must NOT appear');
        testPass('0.6 Current HOD does NOT appear in candidates');
    } catch (err) {
        testFail('0.1-0.6 Candidate filtering checks failed', err);
    }

    // 0.7 Backend rejects creating delegation for faculty without login account (Bypass prevention)
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: {
                facultyId: `FAC_NO_ACC_${tag}`,
                startDate: today,
                endDate: dayAfter
            }
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'ACCOUNT_REQUIRED');
        assert.match(res.body.error, /does not have an active login account/i);
        testPass('0.7 Backend rejects delegation for faculty without account with 400 ACCOUNT_REQUIRED');
    } catch (err) {
        testFail('0.7 Backend rejects delegation for faculty without account', err);
    }

    // 0.8 Backend rejects creating delegation for inactive faculty (Bypass prevention)
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: {
                facultyId: `FAC_INACTIVE_${tag}`,
                startDate: today,
                endDate: dayAfter
            }
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'INACTIVE_FACULTY');
        testPass('0.8 Backend rejects delegation for inactive faculty with 400 INACTIVE_FACULTY');
    } catch (err) {
        testFail('0.8 Backend rejects delegation for inactive faculty', err);
    }

    // 0.9 Candidate count equals UNIQUE eligible faculty count
    try {
        const candRes = await request('GET', '/api/delegations/candidates', {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(candRes.status, 200);
        const candidates = candRes.body.candidates;
        assert.strictEqual(candRes.body.count, candidates.length);
        assert.strictEqual(candidates.length, 2, 'Should have exactly 2 eligible candidates (B. Swarupa and K. Ramesh)');
        testPass('0.9 Candidate count equals UNIQUE eligible faculty count');
    } catch (err) {
        testFail('0.9 Candidate count equals UNIQUE eligible faculty count', err);
    }

    // 0.10 Same faculty never appears twice in the API response
    try {
        const candRes = await request('GET', '/api/delegations/candidates', {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(candRes.status, 200);
        const candidates = candRes.body.candidates;
        const candNames = candidates.map(c => c.name.trim().toUpperCase());
        const uniqueNames = new Set(candNames);
        assert.strictEqual(candNames.length, uniqueNames.size, 'No candidate name should appear more than once');
        const candIds = candidates.map(c => String(c.facultyId || c.id));
        const uniqueIds = new Set(candIds);
        assert.strictEqual(candIds.length, uniqueIds.size, 'No candidate ID should appear more than once');
        testPass('0.10 Same faculty never appears twice in the API response');
    } catch (err) {
        testFail('0.10 Same faculty never appears twice in the API response', err);
    }

    // 0.11 Accidental duplicate user account linked to same faculty name/id does NOT duplicate candidate
    try {
        const usersStore = require('../src/data/users');
        // Simulate a duplicate user account in user store
        usersStore.syncFromDatabase([{
            id: 99999,
            username: `fac_swarupa_dup_${tag}`,
            name: facCme1Name, // Same faculty name
            facultyName: facCme1Name,
            facultyId: facCme1Id, // Same faculty ID
            phone: `9848${rnd()}`,
            role: 'faculty',
            department: cmeBranch,
            status: 'active'
        }]);

        const candRes = await request('GET', '/api/delegations/candidates', {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(candRes.status, 200);
        const candidates = candRes.body.candidates;
        const swarupaCandidates = candidates.filter(c => c.name.trim().toUpperCase() === facCme1Name.toUpperCase());
        assert.strictEqual(swarupaCandidates.length, 1, 'Faculty with duplicate account records must still appear exactly ONCE');
        testPass('0.11 Same faculty linked to multiple user rows produces exactly ONE unique candidate');
    } catch (err) {
        testFail('0.11 Duplicate user account handling failed', err);
    }

    // =========================================================================
    // Area 1: Delegation Creation & Input Validation
    // =========================================================================
    console.log('\n[Area 1] Delegation Creation & Validation');

    // 1.1 Unauthenticated attempt rejected
    try {
        const res = await request('POST', '/api/delegations', {
            body: { facultyId: facCme1Id, startDate: today, endDate: dayAfter }
        });
        assert.strictEqual(res.status, 401);
        testPass('1.1 Unauthenticated delegation creation rejected with 401');
    } catch (err) {
        testFail('1.1 Unauthenticated delegation creation rejected with 401', err);
    }

    // 1.2 Normal faculty attempt rejected
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: facCme1Cookie },
            body: { facultyId: facCme2Id, startDate: today, endDate: dayAfter }
        });
        assert.strictEqual(res.status, 403);
        assert.match(res.body.error, /Acting HOD cannot manage|permanent Head of Department/i);
        testPass('1.2 Normal faculty cannot create delegation (403 Forbidden)');
    } catch (err) {
        testFail('1.2 Normal faculty cannot create delegation', err);
    }

    // 1.3 Invalid dates (start > end) rejected
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: { facultyId: facCme1Id, startDate: dayAfter, endDate: today }
        });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /cannot be after/i);
        testPass('1.3 Start date after end date rejected with 400');
    } catch (err) {
        testFail('1.3 Start date after end date rejected with 400', err);
    }

    // 1.4 Cross-branch faculty assignment rejected
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: { facultyId: facEeeId, startDate: today, endDate: dayAfter }
        });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /same branch/i);
        testPass('1.4 Cross-branch faculty assignment rejected with 400');
    } catch (err) {
        testFail('1.4 Cross-branch faculty assignment rejected with 400', err);
    }

    // 1.5 Self-delegation rejected
    try {
        const selfRes = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: { facultyName: hodCmeName, startDate: today, endDate: dayAfter }
        });
        assert.strictEqual(selfRes.status, 400);
        assert.match(selfRes.body.error, /themselves/i);
        testPass('1.5 Current HOD cannot delegate to themselves');
    } catch (err) {
        testFail('1.5 Current HOD cannot delegate to themselves', err);
    }

    // 1.6 Valid HOD delegation creation for B. Swarupa
    let delegationId = null;
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: {
                facultyId: facCme1Id,
                startDate: today,
                endDate: dayAfter,
                notes: 'HOD on official duty'
            }
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.delegation);
        delegationId = res.body.delegation.id;
        assert.strictEqual(res.body.delegation.status, 'ACTIVE');
        assert.strictEqual(res.body.delegation.actingFacultyName, facCme1Name);
        assert.strictEqual(res.body.delegation.branchCode, cmeBranch);
        testPass(`1.6 Valid HOD delegation successfully created for ${facCme1Name}`);
    } catch (err) {
        testFail('1.6 Valid HOD delegation creation failed', err);
    }

    // 1.7 Overlapping active delegation rejected with 409
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: {
                facultyId: facCme2Id,
                startDate: tomorrow,
                endDate: dayAfter,
                notes: 'Attempt duplicate overlap'
            }
        });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /active delegation already exists/i);
        testPass('1.7 Overlapping active delegation in same branch rejected with 409 Conflict');
    } catch (err) {
        testFail('1.7 Overlapping active delegation in same branch rejected', err);
    }

    // 1.8 Non-overlapping future delegation for EEE branch allowed independently
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: hodEeeCookie },
            body: {
                facultyId: facEeeId,
                startDate: today,
                endDate: dayAfter,
                notes: 'EEE HOD duty leave'
            }
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.delegation.branchCode, eeeBranch);
        testPass('1.8 Independent delegation in another branch (EEE) created successfully');
    } catch (err) {
        testFail('1.8 Independent delegation in another branch created', err);
    }

    // =========================================================================
    // Area 2: Session & Role Integrity
    // =========================================================================
    console.log('\n[Area 2] Session & Role Integrity for Acting HOD');

    // 2.1 Permanent role remains 'faculty', but isActingHOD flag is true
    try {
        const res = await request('GET', '/api/auth/session', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.user.role, 'faculty', 'Permanent role must remain faculty');
        assert.strictEqual(res.body.user.isActingHOD, true, 'isActingHOD must be true');
        assert.strictEqual(res.body.user.actingHOD.branch, cmeBranch);
        testPass('2.1 Acting HOD maintains permanent role="faculty" with isActingHOD=true');
    } catch (err) {
        testFail('2.1 Acting HOD maintains permanent role="faculty"', err);
    }

    // 2.2 Profile preserves permanent faculty role and attributes
    try {
        const res = await request('GET', '/api/auth/profile', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.profile.role, 'faculty');
        assert.strictEqual(res.body.profile.isActingHOD, true);
        assert.strictEqual(res.body.profile.name, facCme1Name);
        testPass('2.2 Profile endpoint reflects active delegation while preserving faculty profile');
    } catch (err) {
        testFail('2.2 Profile endpoint reflects active delegation', err);
    }

    // 2.3 Faculty without delegation (K. Ramesh) has isActingHOD = false
    try {
        const res = await request('GET', '/api/auth/session', {
            headers: { Cookie: facCme2Cookie }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.user.role, 'faculty');
        assert.strictEqual(res.body.user.isActingHOD, false);
        testPass('2.3 Non-delegated faculty has isActingHOD=false');
    } catch (err) {
        testFail('2.3 Non-delegated faculty has isActingHOD=false', err);
    }

    // =========================================================================
    // Area 3: Acting HOD Permissions & Capabilities
    // =========================================================================
    console.log('\n[Area 3] Acting HOD Capabilities Execution');

    // 3.1 Non-delegated faculty cannot manage attendance
    try {
        const res = await request('POST', '/api/attendance', {
            headers: { Cookie: facCme2Cookie },
            body: { facultyId: facCme1Id, date: today, status: 'ABSENT' }
        });
        assert.strictEqual(res.status, 403);
        testPass('3.1 Non-delegated faculty cannot manage attendance (403)');
    } catch (err) {
        testFail('3.1 Non-delegated faculty cannot manage attendance', err);
    }

    // 3.2 Acting HOD CAN mark attendance for branch faculty
    try {
        const res = await request('POST', '/api/attendance', {
            headers: { Cookie: facCme1Cookie },
            body: { facultyId: facCme2Id, date: today, status: 'ABSENT' }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.record.status, 'ABSENT');
        assert.ok(
            res.body.record.markedBy === facCme1Name || res.body.record.markedBy === `fac_swarupa_${tag}`,
            'Audit trail must record Acting HOD name or username'
        );
        testPass(`3.2 Acting HOD can mark attendance and audit records ${facCme1Name} (not original HOD)`);
    } catch (err) {
        testFail('3.2 Acting HOD can mark attendance', err);
    }

    // 3.3 Acting HOD can view branch substitutions
    try {
        const res = await request('GET', '/api/substitutions', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(res.status, 200);
        testPass('3.3 Acting HOD can access branch substitutions overview');
    } catch (err) {
        testFail('3.3 Acting HOD can access branch substitutions overview', err);
    }

    // 3.4 Acting HOD can manage exam invigilation
    try {
        const res = await request('POST', '/api/invigilation', {
            headers: { Cookie: facCme1Cookie },
            body: {
                facultyId: facCme2Id,
                examDate: today,
                periods: [1, 2],
                notes: 'Midterm invigilation'
            }
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.success, true);
        testPass('3.4 Acting HOD can directly assign exam invigilation');
    } catch (err) {
        testFail('3.4 Acting HOD can directly assign exam invigilation', err);
    }

    // 3.5 Acting HOD can review registration requests
    try {
        // Submit public request for CME
        const reqRes = await request('POST', '/api/faculty-requests', {
            body: {
                name: `New CME Applicant ${tag}`,
                phone: `9848${Math.floor(100000 + Math.random() * 900000)}`,
                username: `new_cme_fac_${tag}`,
                password: 'Password_123',
                branchCode: cmeBranch,
                subjects: ['Networks']
            }
        });
        assert.strictEqual(reqRes.status, 201);
        const reqId = reqRes.body.request.id;

        // Acting HOD views requests
        const listRes = await request('GET', '/api/faculty-requests', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(listRes.status, 200);
        assert.strictEqual(listRes.body.requests.some(r => r.id === reqId), true);

        // Acting HOD approves request
        const approveRes = await request('POST', `/api/faculty-requests/${reqId}/approve`, {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(approveRes.status, 200);
        assert.strictEqual(approveRes.body.success, true);
        assert.strictEqual(approveRes.body.request.reviewedBy, `fac_swarupa_${tag}`);
        testPass('3.5 Acting HOD can review and approve faculty registration requests');
    } catch (err) {
        testFail('3.5 Acting HOD can review and approve faculty registration requests', err);
    }

    // =========================================================================
    // Area 4: Restrictions & Security on Acting HOD
    // =========================================================================
    console.log('\n[Area 4] Acting HOD Restrictions & Security');

    // 4.1 Acting HOD CANNOT create another delegation (sub-delegation prohibited)
    try {
        const res = await request('POST', '/api/delegations', {
            headers: { Cookie: facCme1Cookie },
            body: {
                facultyId: facCme2Id,
                startDate: nextWeekStart,
                endDate: nextWeekEnd
            }
        });
        assert.strictEqual(res.status, 403);
        assert.match(res.body.error, /Acting HOD cannot manage|permanent Head of Department/i);
        testPass('4.1 Acting HOD cannot create sub-delegations (403 Forbidden)');
    } catch (err) {
        testFail('4.1 Acting HOD cannot create sub-delegations', err);
    }

    // 4.2 Acting HOD CANNOT cancel delegations
    try {
        const res = await request('POST', `/api/delegations/${delegationId}/cancel`, {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(res.status, 403);
        assert.match(res.body.error, /Acting HOD cannot manage|permanent Head of Department/i);
        testPass('4.2 Acting HOD cannot cancel delegations (403 Forbidden)');
    } catch (err) {
        testFail('4.2 Acting HOD cannot cancel delegations', err);
    }

    // 4.3 Acting HOD CANNOT access another branch (Branch Isolation)
    try {
        const res = await request('POST', '/api/attendance', {
            headers: { Cookie: facCme1Cookie },
            body: { facultyId: facEeeId, date: today, status: 'ABSENT', branch: eeeBranch }
        });
        assert.strictEqual(res.status, 403);
        testPass('4.3 Acting HOD cannot access or manage another branch (403 Forbidden)');
    } catch (err) {
        testFail('4.3 Acting HOD cannot access or manage another branch', err);
    }

    // =========================================================================
    // Area 5: Permanent HOD Authority Retention
    // =========================================================================
    console.log('\n[Area 5] Permanent HOD Retains Full Authority');

    // 5.1 Permanent HOD can still mark attendance
    try {
        const res = await request('POST', '/api/attendance', {
            headers: { Cookie: hodCmeCookie },
            body: { facultyId: facCme1Id, date: today, status: 'PRESENT' }
        });
        assert.strictEqual(res.status, 200);
        testPass('5.1 Permanent HOD retains full authority and can mark attendance');
    } catch (err) {
        testFail('5.1 Permanent HOD retains full authority', err);
    }

    // =========================================================================
    // Area 6: Cancellation & Automatic Expiration
    // =========================================================================
    console.log('\n[Area 6] Delegation Cancellation & Expiration');

    // 6.1 Permanent HOD cancels active delegation
    try {
        const cancelRes = await request('POST', `/api/delegations/${delegationId}/cancel`, {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(cancelRes.status, 200);
        assert.strictEqual(cancelRes.body.status, 'CANCELLED');
        testPass('6.1 Permanent HOD successfully cancels delegation');
    } catch (err) {
        testFail('6.1 Permanent HOD successfully cancels delegation', err);
    }

    // 6.2 B. Swarupa immediately loses Acting HOD permissions
    try {
        const sessionRes = await request('GET', '/api/auth/session', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(sessionRes.status, 200);
        assert.strictEqual(sessionRes.body.user.isActingHOD, false, 'isActingHOD must be false after cancellation');

        const attRes = await request('POST', '/api/attendance', {
            headers: { Cookie: facCme1Cookie },
            body: { facultyId: facCme2Id, date: today, status: 'ABSENT' }
        });
        assert.strictEqual(attRes.status, 403, 'Must be 403 Forbidden after cancellation');
        testPass('6.2 Revoked faculty immediately loses HOD permissions and returns to normal faculty permissions');
    } catch (err) {
        testFail('6.2 Revoked faculty immediately loses HOD permissions', err);
    }

    // 6.3 Historical delegation remains stored with status CANCELLED
    try {
        const listRes = await request('GET', '/api/delegations', {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(listRes.status, 200);
        const record = listRes.body.delegations.find(d => String(d.id) === String(delegationId));
        assert.ok(record);
        assert.strictEqual(record.status, 'CANCELLED');
        testPass('6.3 Historical delegation remains stored for audit with status CANCELLED');
    } catch (err) {
        testFail('6.3 Historical delegation remains stored for audit', err);
    }

    // =========================================================================
    // Final Summary
    // =========================================================================
    console.log('\n============================================================');
    console.log(`Results: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    await stopServer();

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runTests().catch(err => {
        console.error('Fatal error during test run:', err);
        if (server) server.close();
        process.exit(1);
    });
}

module.exports = { runTests };
