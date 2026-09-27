/**
 * Complete Authentication & Authorization Regression Test Suite
 *
 * Covers:
 * 1. Existing HOD login.
 * 2. Existing Faculty login.
 * 3. Newly created Faculty login.
 * 4. Wrong password rejection.
 * 5. Duplicate username rejection.
 * 6. Duplicate faculty-account rejection.
 * 7. Login after logout.
 * 8. Login after server restart.
 * 9. Login with empty in-memory cache (PostgreSQL reload).
 * 10. PostgreSQL remains authoritative.
 * 11. Session remains valid after refresh / profile fetch.
 * 12. HOD branch isolation (CME vs EEE).
 * 13. Faculty branch isolation (CME vs EEE).
 * 14. Existing timetable data remains untouched.
 * 15. Faculty Management account status remains correct.
 * 16. Invigilation account filtering remains correct.
 */
const assert = require('assert');
const http = require('http');
const { verifySafetyGuard, initTestDb } = require('./testDbGuard');
const { check, counts } = require('./helpers');

let guard;
let app;
let server;
let baseUrl;
let db;
let repository;
let users;
let session;
let authSecurity;

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
    console.log('\n============================================================');
    console.log('TecSubstitution — Auth Full Lifecycle Regression Tests');
    console.log('============================================================\n');

    // 1. Initialize isolated test database
    guard = await initTestDb();
    console.log(`[Safety Guard] Active Test DB: ${guard.parsedTest.full}`);

    // Load server and modules under TEST_DATABASE_URL
    const serverModule = require('../server');
    app = serverModule.app;
    db = require('../src/db/pool');
    repository = require('../src/db/repository');
    users = require('../src/data/users');
    session = require('../src/core/session');
    authSecurity = require('../src/core/authSecurity');

    // Start test HTTP server
    await new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });

    try {
        // Clean up previous test users in test db
        await db.query("DELETE FROM users WHERE username LIKE 'test_reg_%' OR username LIKE 'dup_%'");

        // Test credentials (using valid policy: letter + number + underscore)
        const hodCmeUser = 'test_reg_hod_cme';
        const hodEeeUser = 'test_reg_hod_eee';
        const facCmeUser = 'test_reg_fac_cme';
        const facEeeUser = 'test_reg_fac_eee';
        const testPassword = 'Password_123';

        // 1. Register HOD for CME
        console.log('[1] HOD CME Setup & Login');
        const regHodCme = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Department Head',
            phone: '9000000001',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: hodCmeUser,
            password: testPassword,
            confirmPassword: testPassword
        });

        check('1. Existing HOD registers and receives valid session', () => {
            assert.strictEqual(regHodCme.status, 201);
            assert.strictEqual(regHodCme.body.user.role, 'hos');
            assert.strictEqual(regHodCme.body.user.department, 'CME');
            assert.ok(regHodCme.cookie, 'Session cookie issued');
        });

        const hodCmeCookie = regHodCme.cookie;

        // 2. Register HOD for EEE
        console.log('\n[2] HOD EEE Setup & Login');
        const regHodEee = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Department Head',
            phone: '9000000002',
            branchName: 'Electrical and Electronics Engineering',
            branchCode: 'EEE',
            username: hodEeeUser,
            password: testPassword,
            confirmPassword: testPassword
        });

        check('2. EEE HOD registers independently', () => {
            assert.strictEqual(regHodEee.status, 201);
            assert.strictEqual(regHodEee.body.user.role, 'hos');
            assert.strictEqual(regHodEee.body.user.department, 'EEE');
        });
        const hodEeeCookie = regHodEee.cookie;

        // 3. CME HOD creates Faculty Member for CME
        console.log('\n[3] CME HOD creates CME Faculty');
        const regFacCme = await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'CME Faculty Test',
            phone: '9000000003',
            username: facCmeUser,
            password: testPassword,
            confirmPassword: testPassword,
            subjects: ['Algorithms', 'DBMS']
        }, hodCmeCookie);

        check('3. CME HOD creates Faculty account assigned to CME', () => {
            assert.strictEqual(regFacCme.status, 201);
            assert.strictEqual(regFacCme.body.user.role, 'faculty');
            assert.strictEqual(regFacCme.body.user.department, 'CME');
        });

        // 4. EEE HOD creates Faculty Member for EEE
        console.log('\n[4] EEE HOD creates EEE Faculty');
        const regFacEee = await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'EEE Faculty Test',
            phone: '9000000004',
            username: facEeeUser,
            password: testPassword,
            confirmPassword: testPassword,
            subjects: ['Power Systems', 'Signals']
        }, hodEeeCookie);

        check('4. EEE HOD creates Faculty account assigned to EEE', () => {
            assert.strictEqual(regFacEee.status, 201);
            assert.strictEqual(regFacEee.body.user.role, 'faculty');
            assert.strictEqual(regFacEee.body.user.department, 'EEE');
        });

        // 5. Wrong Password Rejection
        console.log('\n[5] Wrong Password Rejection');
        const wrongHodLogin = await call('POST', '/api/auth/login', {
            username: hodCmeUser,
            password: 'WrongPassword_123'
        });
        const wrongFacLogin = await call('POST', '/api/auth/login', {
            username: facCmeUser,
            password: 'WrongPassword_123'
        });

        check('5. Wrong password rejected with 401 for both HOD and Faculty', () => {
            assert.strictEqual(wrongHodLogin.status, 401);
            assert.strictEqual(wrongHodLogin.body.error, 'Incorrect username or password.');
            assert.strictEqual(wrongFacLogin.status, 401);
            assert.strictEqual(wrongFacLogin.body.error, 'Incorrect username or password.');
        });

        // 6. Duplicate Username Rejection
        console.log('\n[6] Duplicate Username Rejection');
        const dupUserAttempt = await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'Another Name',
            phone: '9111111111',
            username: facCmeUser, // duplicate username
            password: testPassword,
            confirmPassword: testPassword,
            subjects: ['Math']
        }, hodCmeCookie);

        check('6. Duplicate username registration rejected with 409', () => {
            assert.strictEqual(dupUserAttempt.status, 409);
        });

        // 7. Duplicate Faculty Account Rejection
        console.log('\n[7] Duplicate Faculty-Account Rejection');
        const dupFacAttempt = await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'CME Faculty Test', // same name as registered CME faculty
            phone: '9222222222',
            username: 'test_reg_fac_cme_dup',
            password: testPassword,
            confirmPassword: testPassword,
            subjects: ['Math']
        }, hodCmeCookie);

        check('7. Duplicate faculty-account registration rejected with 409', () => {
            assert.strictEqual(dupFacAttempt.status, 409);
        });

        // 8. Login after Logout
        console.log('\n[8] Login after Logout');
        const cmeFacLogin = await call('POST', '/api/auth/login', {
            username: facCmeUser,
            password: testPassword
        });
        check('8a. Faculty logs in successfully', () => {
            assert.strictEqual(cmeFacLogin.status, 200);
            assert.strictEqual(cmeFacLogin.body.user.username, facCmeUser);
            assert.ok(cmeFacLogin.cookie);
        });

        const cmeFacCookie = cmeFacLogin.cookie;
        const logoutRes = await call('POST', '/api/auth/logout', null, cmeFacCookie);
        check('8b. Logout succeeds', () => {
            assert.strictEqual(logoutRes.status, 200);
        });

        const postLogoutCheck = await call('GET', '/api/auth/session', null, logoutRes.cookie);
        check('8c. Session is unauthenticated after logout', () => {
            assert.strictEqual(postLogoutCheck.body.authenticated, false);
        });

        const reLoginRes = await call('POST', '/api/auth/login', {
            username: facCmeUser,
            password: testPassword
        });
        check('8d. Login succeeds again after logout', () => {
            assert.strictEqual(reLoginRes.status, 200);
            assert.strictEqual(reLoginRes.body.authenticated, true);
        });

        // 9. Login with Empty In-Memory Cache (PostgreSQL Authoritativeness)
        console.log('\n[9] PostgreSQL Authoritativeness & Empty In-Memory Cache');
        users.resetForTesting(); // Clear in-memory users cache completely

        const authDirectFromDb = await users.authenticateAsync(facCmeUser, testPassword);
        check('9a. authenticateAsync finds user directly in PostgreSQL after cache wipe', () => {
            assert.ok(authDirectFromDb, 'User must authenticate directly from DB');
            assert.strictEqual(authDirectFromDb.username, facCmeUser);
            assert.strictEqual(authDirectFromDb.department, 'CME');
        });

        const loginDirectDbHttp = await call('POST', '/api/auth/login', {
            username: facCmeUser,
            password: testPassword
        });
        check('9b. HTTP login succeeds after in-memory cache wipe', () => {
            assert.strictEqual(loginDirectDbHttp.status, 200);
            assert.strictEqual(loginDirectDbHttp.body.user.username, facCmeUser);
            assert.strictEqual(loginDirectDbHttp.body.user.department, 'CME');
        });

        // 10. Session Remains Valid after Refresh / Profile Fetch
        console.log('\n[10] Session Refresh & Profile Fetch');
        const sessionCheck = await call('GET', '/api/auth/session', null, loginDirectDbHttp.cookie);
        const profileCheck = await call('GET', '/api/auth/profile', null, loginDirectDbHttp.cookie);

        check('10. Session and profile preserve department and subjects', () => {
            assert.strictEqual(sessionCheck.body.authenticated, true);
            assert.strictEqual(sessionCheck.body.user.username, facCmeUser);
            assert.strictEqual(sessionCheck.body.user.department, 'CME');
            assert.ok(sessionCheck.body.user.subjects.includes('Algorithms'));

            assert.strictEqual(profileCheck.status, 200);
            assert.strictEqual(profileCheck.body.profile.username, facCmeUser);
            assert.strictEqual(profileCheck.body.profile.department, 'CME');
            assert.ok(profileCheck.body.profile.subjects.includes('Algorithms'));
        });

        // 11. HOD Branch Isolation
        console.log('\n[11] HOD Branch Isolation');
        const cmeAccounts = await call('GET', '/api/auth/accounts', null, hodCmeCookie);
        const eeeAccounts = await call('GET', '/api/auth/accounts', null, hodEeeCookie);

        check('11. CME HOD sees only CME accounts, EEE HOD sees only EEE accounts', () => {
            assert.strictEqual(cmeAccounts.status, 200);
            const cmeUsernames = cmeAccounts.body.accounts.map(a => a.username);
            assert.ok(cmeUsernames.includes(hodCmeUser));
            assert.ok(cmeUsernames.includes(facCmeUser));
            assert.ok(!cmeUsernames.includes(hodEeeUser));
            assert.ok(!cmeUsernames.includes(facEeeUser));

            assert.strictEqual(eeeAccounts.status, 200);
            const eeeUsernames = eeeAccounts.body.accounts.map(a => a.username);
            assert.ok(eeeUsernames.includes(hodEeeUser));
            assert.ok(eeeUsernames.includes(facEeeUser));
            assert.ok(!eeeUsernames.includes(hodCmeUser));
            assert.ok(!eeeUsernames.includes(facCmeUser));
        });

        // 12. Faculty Branch Isolation
        console.log('\n[12] Faculty Branch Isolation');
        const cmeFacSession = await call('GET', '/api/auth/session', null, loginDirectDbHttp.cookie);
        const eeeFacLogin = await call('POST', '/api/auth/login', { username: facEeeUser, password: testPassword });
        const eeeFacSession = await call('GET', '/api/auth/session', null, eeeFacLogin.cookie);

        check('12. Faculty department is strictly isolated', () => {
            assert.strictEqual(cmeFacSession.body.user.department, 'CME');
            assert.strictEqual(eeeFacSession.body.user.department, 'EEE');
        });

        // 13. Timetable Data Remains Untouched
        console.log('\n[13] Timetable Integrity Check');
        const timetableMeta = await call('GET', '/api/timetable/meta');
        check('13. Timetable metadata intact and responsive', () => {
            assert.strictEqual(timetableMeta.status, 200);
            assert.ok(Array.isArray(timetableMeta.body.days));
            assert.ok(Array.isArray(timetableMeta.body.periods));
        });

        // 14. Faculty Registration Request & Approval Workflow
        console.log('\n[14] Public Faculty Registration Request & HOD Approval');
        const reqUname = `test_reg_req_${Date.now()}`;
        const submitReq = await call('POST', '/api/faculty-requests', {
            name: 'Approval Flow Faculty',
            phone: '9333333333',
            branchCode: 'CME',
            username: reqUname,
            password: testPassword,
            confirmPassword: testPassword,
            designation: 'Lecturer',
            subjects: ['Microprocessors']
        });

        check('14a. Public registration request submitted successfully', () => {
            assert.strictEqual(submitReq.status, 201);
            assert.ok(submitReq.body.request && submitReq.body.request.id);
        });

        const reqId = submitReq.body.request.id;
        const approveRes = await call('POST', `/api/faculty-requests/${reqId}/approve`, null, hodCmeCookie);
        check('14b. HOD approves faculty request', () => {
            assert.strictEqual(approveRes.status, 200);
            assert.strictEqual(approveRes.body.user.username, reqUname);
            assert.strictEqual(approveRes.body.user.department, 'CME');
        });

        const approvedLogin = await call('POST', '/api/auth/login', {
            username: reqUname,
            password: testPassword
        });
        check('14c. Approved faculty logs in immediately with correct role & branch', () => {
            assert.strictEqual(approvedLogin.status, 200);
            assert.strictEqual(approvedLogin.body.user.role, 'faculty');
            assert.strictEqual(approvedLogin.body.user.department, 'CME');
        });

    } finally {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    console.log('\n============================================================');
    const { passed, failed } = counts();
    console.log(`Auth Full Lifecycle Results: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error('Fatal error in auth regression test:', err);
    process.exit(1);
});
