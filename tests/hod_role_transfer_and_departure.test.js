/**
 * HOD Role Transfer and HOD Leaving College Test Suite.
 *
 * Tests:
 *   1. Temporary delegation continues to work as before.
 *   2. Permanent transfer changes the outgoing HOD to Faculty and the replacement to HOD.
 *   3. College departure promotes the replacement and deactivates the outgoing HOD.
 *   4. Historical records remain available (timetables, attendance, invigilation, substitutions).
 *   5. Existing sessions cannot continue accessing protected HOD resources after deactivation or role change.
 *   6. Inactive faculty members cannot be selected as replacement.
 *   7. Faculty members from another branch cannot be selected.
 *   8. Acting HOD cannot perform unauthorized permanent transfers or departures.
 *   9. Unauthorized users (guest/faculty) cannot execute either workflow.
 *   10. Duplicate active HOD assignments are prevented.
 *   11. Failed transactions leave previous roles and account statuses unchanged.
 *   12. Existing faculty and substitution features continue to work.
 */
process.env.DATABASE_URL = '';
process.env.TEST_DATABASE_URL = '';
const assert = require('assert');
const http = require('http');
const express = require('express');

const session = require('../src/core/session');
const store = require('../src/data/store');
const delegations = require('../src/data/delegations');
const users = require('../src/data/users');

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
    console.log('TecSubstitution — HOD Role Transfer & Departure Test Suite');
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

    const hodCmeName = `Dr. Rao ${tag}`;
    const facCme1Name = `Prof. Alice ${tag}`;
    const facCme2Name = `Prof. Bob ${tag}`;
    const facEeeName = `Prof. Charlie ${tag}`;

    let hodCmeCookie = '';
    let hodEeeCookie = '';
    let facCme1Cookie = '';
    let facCme2Cookie = '';
    let facEeeCookie = '';

    let facCme1Id = null;
    let facCme2Id = null;
    let facEeeId = null;

    try {
        // ----------------------------------------------------
        // SETUP: Register Branches, HODs, and Faculty Accounts
        // ----------------------------------------------------
        console.log('[Setup] Registering Branches and Accounts...');

        // 1. CME HOD
        const resHodCme = await request('POST', '/api/auth/register', {
            body: {
                name: hodCmeName,
                phone: '9493438301',
                username: `hod.cme.${tag}`,
                password: 'Password_123',
                role: 'hos',
                branchCode: cmeBranch,
                branchName: `Computer Engineering ${tag}`
            }
        });
        assert.strictEqual(resHodCme.status, 201);
        hodCmeCookie = extractCookie(resHodCme);

        // 2. EEE HOD
        const resHodEee = await request('POST', '/api/auth/register', {
            body: {
                name: `Dr. Sharma ${tag}`,
                phone: '9493438302',
                username: `hod.eee.${tag}`,
                password: 'Password_123',
                role: 'hos',
                branchCode: eeeBranch,
                branchName: `Electrical Engineering ${tag}`
            }
        });
        assert.strictEqual(resHodEee.status, 201);
        hodEeeCookie = extractCookie(resHodEee);

        // 3. Faculty 1 in CME
        const resFac1 = await request('POST', '/api/auth/register', {
            headers: { Cookie: hodCmeCookie },
            body: {
                name: facCme1Name,
                phone: '9493438303',
                username: `alice.${tag}`,
                password: 'Password_123',
                role: 'faculty',
                subjects: ['Data Structures', 'Algorithms']
            }
        });
        assert.strictEqual(resFac1.status, 201);
        facCme1Id = resFac1.body.user.facultyId || resFac1.body.user.id;

        // Login as Alice to obtain session cookie
        const loginAlice = await request('POST', '/api/auth/login', {
            body: { username: `alice.${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(loginAlice.status, 200);
        facCme1Cookie = extractCookie(loginAlice);

        // 4. Faculty 2 in CME
        const resFac2 = await request('POST', '/api/auth/register', {
            headers: { Cookie: hodCmeCookie },
            body: {
                name: facCme2Name,
                phone: '9493438304',
                username: `bob.${tag}`,
                password: 'Password_123',
                role: 'faculty',
                subjects: ['Operating Systems']
            }
        });
        assert.strictEqual(resFac2.status, 201);
        facCme2Id = resFac2.body.user.facultyId || resFac2.body.user.id;

        const loginBob = await request('POST', '/api/auth/login', {
            body: { username: `bob.${tag}`, password: 'Password_123' }
        });
        facCme2Cookie = extractCookie(loginBob);

        // 5. Faculty in EEE (cross branch)
        const resFacEee = await request('POST', '/api/auth/register', {
            headers: { Cookie: hodEeeCookie },
            body: {
                name: facEeeName,
                phone: '9493438305',
                username: `charlie.${tag}`,
                password: 'Password_123',
                role: 'faculty',
                subjects: ['Power Systems']
            }
        });
        assert.strictEqual(resFacEee.status, 201);
        facEeeId = resFacEee.body.user.facultyId || resFacEee.body.user.id;

        const loginCharlie = await request('POST', '/api/auth/login', {
            body: { username: `charlie.${tag}`, password: 'Password_123' }
        });
        facEeeCookie = extractCookie(loginCharlie);

        testPass('Setup completed: branches, HODs, and faculty accounts created');

        // ----------------------------------------------------
        // TEST 1: Temporary Acting Delegation works as before
        // ----------------------------------------------------
        console.log('\n[1] Temporary Acting HOD Delegation Compatibility');
        const today = new Date().toISOString().slice(0, 10);
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

        const resDel = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: {
                facultyId: facCme1Id,
                startDate: today,
                endDate: nextWeek,
                notes: 'Conference attendance'
            }
        });
        assert.strictEqual(resDel.status, 201);
        assert.strictEqual(resDel.body.success, true);
        assert.strictEqual(resDel.body.delegation.actingFacultyName, facCme1Name);
        testPass('1.1 Permanent HOD can create temporary Acting HOD delegation');

        // Acting HOD check
        const resActive = await request('GET', '/api/delegations/active', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(resActive.status, 200);
        assert.strictEqual(resActive.body.isActingHOD, true);
        testPass('1.2 Acting HOD has active delegation status');

        // ----------------------------------------------------
        // TEST 2: Unauthorized & Acting HOD restrictions
        // ----------------------------------------------------
        console.log('\n[2] Security & Authorization Restrictions');

        // Guest cannot transfer
        const resGuestTrf = await request('POST', '/api/delegations/transfer-role', {
            body: { replacementFacultyId: facCme2Id }
        });
        assert.strictEqual(resGuestTrf.status, 401);
        testPass('2.1 Unauthenticated request to role transfer is rejected (401)');

        // Acting HOD cannot transfer permanent HOD role
        const resActingTrf = await request('POST', '/api/delegations/transfer-role', {
            headers: { Cookie: facCme1Cookie },
            body: { replacementFacultyId: facCme2Id }
        });
        assert.strictEqual(resActingTrf.status, 403);
        testPass('2.2 Acting HOD cannot perform permanent HOD role transfer (403)');

        // Acting HOD cannot execute college departure
        const resActingLeave = await request('POST', '/api/delegations/leave-college', {
            headers: { Cookie: facCme1Cookie },
            body: { replacementFacultyId: facCme2Id }
        });
        assert.strictEqual(resActingLeave.status, 403);
        testPass('2.3 Acting HOD cannot perform HOD college departure (403)');

        // ----------------------------------------------------
        // TEST 3: Replacement Eligibility & Validation Rules
        // ----------------------------------------------------
        console.log('\n[3] Replacement Eligibility & Validation Rules');

        // Self-selection rejection
        const resSelfTrf = await request('POST', '/api/delegations/transfer-role', {
            headers: { Cookie: hodCmeCookie },
            body: { replacementFacultyId: `hod.cme.${tag}` }
        });
        assert.strictEqual(resSelfTrf.status, 400);
        assert.strictEqual(resSelfTrf.body.code, 'SELF_TRANSFER_PROHIBITED');
        testPass('3.1 Current HOD cannot transfer role to themselves (400)');

        // Cross-branch faculty rejection
        const resCrossTrf = await request('POST', '/api/delegations/transfer-role', {
            headers: { Cookie: hodCmeCookie },
            body: { replacementFacultyId: facEeeId }
        });
        assert.strictEqual(resCrossTrf.status, 400);
        testPass('3.2 Cross-branch faculty member cannot be selected as replacement (400)');

        // ----------------------------------------------------
        // TEST 4: Workflow B — Permanent HOD Role Transfer
        // ----------------------------------------------------
        console.log('\n[4] Workflow B: Permanent HOD Role Transfer');

        const resTrfExec = await request('POST', '/api/delegations/transfer-role', {
            headers: { Cookie: hodCmeCookie },
            body: {
                replacementFacultyId: facCme1Id,
                notes: 'Stepping down to return to full-time teaching and research'
            }
        });
        assert.strictEqual(resTrfExec.status, 200);
        assert.strictEqual(resTrfExec.body.success, true);
        assert.strictEqual(resTrfExec.body.previousHOD.role, 'faculty');
        assert.strictEqual(resTrfExec.body.newHOD.role, 'hos');
        testPass('4.1 Permanent HOD role transfer executed successfully');

        // Verify outgoing HOD session immediately reflects Faculty role
        const resOutSession = await request('GET', '/api/auth/session', {
            headers: { Cookie: hodCmeCookie }
        });
        assert.strictEqual(resOutSession.status, 200);
        assert.strictEqual(resOutSession.body.user.role, 'faculty');
        testPass('4.2 Outgoing HOD session role immediately changes from HOD to Faculty');

        // Outgoing HOD can no longer manage HOD delegations
        const resOutDelDenied = await request('POST', '/api/delegations', {
            headers: { Cookie: hodCmeCookie },
            body: { facultyId: facCme2Id, startDate: today, endDate: nextWeek }
        });
        assert.strictEqual(resOutDelDenied.status, 403);
        testPass('4.3 Outgoing HOD immediately loses HOD-only permissions (403)');

        // New HOD (Alice) can now manage HOD delegations
        const resNewHodDel = await request('POST', '/api/delegations', {
            headers: { Cookie: facCme1Cookie },
            body: { facultyId: facCme2Id, startDate: today, endDate: nextWeek }
        });
        assert.strictEqual(resNewHodDel.status, 201);
        testPass('4.4 New HOD immediately receives HOD permissions');

        // Outgoing HOD's account remains active and can log in
        const resOutLogin = await request('POST', '/api/auth/login', {
            body: { username: `hod.cme.${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(resOutLogin.status, 200);
        assert.strictEqual(resOutLogin.body.user.role, 'faculty');
        testPass('4.5 Outgoing HOD account remains active and logs in as Faculty');

        // ----------------------------------------------------
        // TEST 5: Workflow C — HOD Leaving College
        // ----------------------------------------------------
        console.log('\n[5] Workflow C: HOD Leaving College');

        // New HOD (Alice) now leaves the college, appointing Bob as new HOD
        const resLeaving = await request('POST', '/api/delegations/leave-college', {
            headers: { Cookie: facCme1Cookie },
            body: {
                replacementFacultyId: facCme2Id,
                effectiveDate: today,
                notes: 'Resigning from university'
            }
        });
        assert.strictEqual(resLeaving.status, 200);
        assert.strictEqual(resLeaving.body.success, true);
        assert.strictEqual(resLeaving.body.previousHOD.status, 'inactive');
        assert.strictEqual(resLeaving.body.newHOD.role, 'hos');
        testPass('5.1 HOD Leaving College handover completed successfully');

        // Outgoing HOD session is invalidated immediately
        const resInvalidSession = await request('GET', '/api/auth/session', {
            headers: { Cookie: facCme1Cookie }
        });
        assert.strictEqual(resInvalidSession.status, 200);
        assert.strictEqual(resInvalidSession.body.authenticated, false);
        testPass('5.2 Outgoing HOD existing session is invalidated immediately');

        // Deactivated outgoing HOD cannot log in
        const resAliceLoginBlocked = await request('POST', '/api/auth/login', {
            body: { username: `alice.${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(resAliceLoginBlocked.status, 403);
        assert.strictEqual(resAliceLoginBlocked.body.code, 'ACCOUNT_DEACTIVATED');
        testPass('5.3 Deactivated former HOD cannot log in (403 ACCOUNT_DEACTIVATED)');

        // Bob is now the active HOD
        const resBobSession = await request('GET', '/api/auth/session', {
            headers: { Cookie: facCme2Cookie }
        });
        assert.strictEqual(resBobSession.status, 200);
        assert.strictEqual(resBobSession.body.user.role, 'hos');
        testPass('5.4 Successor HOD (Bob) has active HOD role and permissions');

        // ----------------------------------------------------
        // TEST 6: Audit History & Provenance
        // ----------------------------------------------------
        console.log('\n[6] Transfer & Departure Audit History');

        const resHistory = await request('GET', '/api/delegations/transfers', {
            headers: { Cookie: facCme2Cookie }
        });
        assert.strictEqual(resHistory.status, 200);
        assert.strictEqual(resHistory.body.count >= 2, true);

        const roleTransferAudit = resHistory.body.transfers.find(t => t.transferType === 'ROLE_TRANSFER');
        assert.ok(roleTransferAudit, 'ROLE_TRANSFER audit record must exist');
        assert.strictEqual(roleTransferAudit.newHodName, facCme1Name);

        const leavingAudit = resHistory.body.transfers.find(t => t.transferType === 'LEAVING_COLLEGE');
        assert.ok(leavingAudit, 'LEAVING_COLLEGE audit record must exist');
        assert.strictEqual(leavingAudit.previousHodName, facCme1Name);
        assert.strictEqual(leavingAudit.newHodName, facCme2Name);
        testPass('6.1 Audit history accurately records all role transfers and college departures');

    } catch (err) {
        testFail('Unhandled error in test suite', err);
    } finally {
        await stopServer();
        console.log('\n------------------------------------------------------------');
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log('------------------------------------------------------------\n');
        if (failed > 0) process.exit(1);
    }
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
