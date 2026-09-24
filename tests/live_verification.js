/**
 * Live Verification Script
 * Tests the running application on http://localhost:3001
 * Verifies all 16 user requirements end-to-end.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3405;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const headers = options.headers || {};
        if (options.body) {
            headers['Content-Type'] = 'application/json';
        }
        if (options.cookie) {
            headers['Cookie'] = options.cookie;
        }

        const req = http.request(url, {
            method: options.method || 'GET',
            headers: headers
        }, (res) => {
            let rawData = '';
            res.on('data', chunk => rawData += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(rawData);
                } catch (e) {
                    parsed = rawData;
                }

                const setCookie = res.headers['set-cookie'];
                let cookie = null;
                if (setCookie) {
                    cookie = setCookie[0].split(';')[0];
                }

                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: parsed,
                    cookie: cookie
                });
            });
        });

        req.on('error', reject);

        if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        req.end();
    });
}

function assert(condition, message) {
    if (!condition) {
        console.error('FAIL: ' + message);
        throw new Error('Assertion failed: ' + message);
    }
    console.log('PASS: ' + message);
}

async function runLiveVerification() {
    console.log('\n=================== STARTING LIVE VERIFICATION ===================\n');

    // 1. Homepage "Get Started" links
    console.log('--- Checking Homepage Get Started links ---');
    const homeRes = await request('/home.html');
    assert(homeRes.status === 200, 'Homepage returns 200');
    assert(!homeRes.body.includes('href="/dashboard">Get Started</a>'), 'No Get Started button links to /dashboard');
    assert(homeRes.body.includes('href="/login">Get Started</a>'), 'Get Started buttons link to /login');

    // 2. Login Page UI
    console.log('\n--- Checking Login page ---');
    const loginRes = await request('/login.html');
    assert(loginRes.status === 200, 'Login page returns 200');
    assert(loginRes.body.includes('id="toggleLoginPassword"'), 'Login page has password visibility toggle button');
    assert(loginRes.body.includes('password-input-wrapper'), 'Login page has password-input-wrapper');
    assert(!loginRes.body.includes('demo-chip'), 'Login page has no demo credential chips');
    assert(!loginRes.body.includes('quick login'), 'Login page has no quick login shortcuts');

    // 3. Fresh instance database state
    console.log('\n--- Checking Fresh Instance Database State ---');
    const statusRes = await request('/api/auth/status');
    assert(statusRes.status === 200, '/api/auth/status returns 200');
    assert(statusRes.body.hasHOS === false, 'Initial state: hasHOS is false');
    assert(statusRes.body.branch.configured === false, 'Initial state: branch is not configured');
    assert(statusRes.body.userCount === 0, 'Initial state: userCount is 0');

    const facultyInit = await request('/api/faculty');
    assert(facultyInit.status === 200 && facultyInit.body.count === 0, 'Initial state: faculty count is 0');

    const branchInit = await request('/api/branch');
    assert(branchInit.status === 200 && branchInit.body.configured === false, 'Initial state: branch configured is false');

    const entriesInit = await request('/api/timetable/entries');
    assert(entriesInit.status === 200 && entriesInit.body.count === 0, 'Initial state: timetable entries count is 0');

    // 4. First-time HOS registration with custom branch (CSE, not CME)
    console.log('\n--- Testing First-time HOS Registration (Branch CSE) ---');
    const regRes = await request('/api/auth/register', {
        method: 'POST',
        body: {
            role: 'hos',
            name: 'Test HOS',
            phone: '9876543210',
            username: 'test_hos',
            password: 'Test_123',
            confirmPassword: 'Test_123',
            branchName: 'Computer Science and Engineering',
            branchCode: 'CSE'
        }
    });

    assert(regRes.status === 201, 'HOS registration returns 201 Created');
    assert(regRes.body.user.role === 'hos', 'Registered user role is hos');
    assert(regRes.body.user.department === 'CSE', 'Registered user branch is CSE');
    assert(regRes.body.user.branchName === 'Computer Science and Engineering', 'Branch name is Computer Science and Engineering');
    assert(!regRes.body.user.password && !regRes.body.user.passwordHash, 'User response does not leak password or hash');

    // 5. Logout HOS
    console.log('\n--- Testing Logout ---');
    const logoutRes = await request('/api/auth/logout', {
        method: 'POST',
        cookie: regRes.cookie
    });
    assert(logoutRes.status === 200, 'HOS logout returns 200');

    // 6. HOS Login with credentials
    console.log('\n--- Testing HOS Login ---');
    const loginAttempt = await request('/api/auth/login', {
        method: 'POST',
        body: {
            username: 'test_hos',
            password: 'Test_123'
        }
    });
    assert(loginAttempt.status === 200, 'HOS login returns 200 OK');
    assert(Boolean(loginAttempt.cookie), 'HOS login issued session cookie');
    const hosCookie = loginAttempt.cookie;
    assert(loginAttempt.body.user.role === 'hos', 'Authenticated role is hos');
    assert(loginAttempt.body.user.department === 'CSE', 'Authenticated branch is CSE');

    // 7. Trace HOS Dashboard API calls (must not error or 500)
    console.log('\n--- Tracing All HOS Dashboard APIs ---');
    const dashSession = await request('/api/auth/session', { cookie: hosCookie });
    assert(dashSession.status === 200 && dashSession.body.authenticated === true, 'HOS Dashboard /api/auth/session is 200 and authenticated');

    const dashStatus = await request('/api/auth/status', { cookie: hosCookie });
    assert(dashStatus.status === 200 && dashStatus.body.isHOS === true, 'HOS Dashboard /api/auth/status confirms isHOS: true');
    assert(dashStatus.body.branch.code === 'CSE', 'HOS Dashboard active branch is CSE');

    const dashBranch = await request('/api/branch', { cookie: hosCookie });
    assert(dashBranch.status === 200 && dashBranch.body.configured === true, 'HOS Dashboard /api/branch is configured: true');
    assert(dashBranch.body.branch.code === 'CSE', 'HOS Dashboard /api/branch code is CSE');

    const dashBranches = await request('/api/branches', { cookie: hosCookie });
    assert(dashBranches.status === 200 && dashBranches.body.branches[0].code === 'CSE', 'HOS Dashboard /api/branches has CSE');

    const dashMeta = await request('/api/timetable/meta', { cookie: hosCookie });
    assert(dashMeta.status === 200, 'HOS Dashboard /api/timetable/meta returns 200');

    const dashRef = await request('/api/timetable/entries/reference', { cookie: hosCookie });
    assert(dashRef.status === 200, 'HOS Dashboard /api/timetable/entries/reference returns 200');

    const dashFaculty = await request('/api/faculty', { cookie: hosCookie });
    assert(dashFaculty.status === 200, 'HOS Dashboard /api/faculty returns 200');

    const dashDepts = await request('/api/faculty/departments', { cookie: hosCookie });
    assert(dashDepts.status === 200 && dashDepts.body.departments[0] === 'CSE', 'HOS Dashboard /api/faculty/departments returns CSE');

    const dashSummary = await request('/api/availability/summary', { cookie: hosCookie });
    assert(dashSummary.status === 200, 'HOS Dashboard /api/availability/summary returns 200');

    const dashAvail = await request('/api/availability', {
        method: 'POST',
        cookie: hosCookie,
        body: { day: 'Monday', period: 1 }
    });
    assert(dashAvail.status === 200, 'HOS Dashboard /api/availability returns 200');
    assert(dashAvail.body.branch === 'CSE', 'Availability engine checked branch CSE');

    // 8. Test Strict Password Policy on Faculty Creation
    console.log('\n--- Testing Strict Password Policy on Faculty Creation ---');
    const invalidPasswords = [
        { pwd: 'abc123', reason: 'missing underscore' },
        { pwd: 'abcdef_', reason: 'missing number' },
        { pwd: '123456_', reason: 'missing letter' },
        { pwd: 'abc.123_', reason: 'contains dot' },
        { pwd: 'abc-123_', reason: 'contains dash' },
        { pwd: 'abc 123_', reason: 'contains space' },
        { pwd: 'abc@123_', reason: 'contains @' }
    ];

    for (const testCase of invalidPasswords) {
        const failRes = await request('/api/auth/register', {
            method: 'POST',
            cookie: hosCookie,
            body: {
                role: 'faculty',
                name: 'Test Faculty',
                phone: '9876543210',
                username: 'fac_' + Math.random().toString(36).slice(2, 7),
                password: testCase.pwd,
                confirmPassword: testCase.pwd,
                subjects: ['Subject 1']
            }
        });
        assert(failRes.status === 400, `Rejected invalid password "${testCase.pwd}" (${testCase.reason}) with HTTP 400`);
    }

    // 9. Create Faculty Account from HOS
    console.log('\n--- Creating Faculty Account from HOS ---');
    const createFacRes = await request('/api/auth/register', {
        method: 'POST',
        cookie: hosCookie,
        body: {
            role: 'faculty',
            name: 'Test Faculty',
            phone: '9876543210',
            username: 'test_faculty',
            password: 'Test_123',
            confirmPassword: 'Test_123',
            subjects: ['Subject 1']
        }
    });
    assert(createFacRes.status === 201, 'Faculty creation returns 201 Created');
    assert(createFacRes.body.user.name === 'Test Faculty', 'Created faculty name is Test Faculty');
    assert(createFacRes.body.user.username === 'test_faculty', 'Created faculty username is test_faculty');
    assert(createFacRes.body.user.department === 'CSE', 'Created faculty automatically inherited branch CSE');
    assert(createFacRes.body.user.role === 'faculty', 'Created user role is faculty');
    assert(!createFacRes.body.user.password && !createFacRes.body.user.passwordHash, 'Faculty response does not expose plaintext password or hash');

    // Verify HOS session is still active
    const verifyHOSSession = await request('/api/auth/session', { cookie: hosCookie });
    assert(verifyHOSSession.body.user.username === 'test_hos', 'HOS session was preserved after creating faculty');

    // 10. Verify Faculty Cannot be accessed with plaintext passwords in GET APIs
    console.log('\n--- Verifying Plaintext Password Security ---');
    const facList = await request('/api/faculty', { cookie: hosCookie });
    assert(facList.status === 200 && facList.body.count === 1, 'Faculty roster has 1 faculty');
    assert(!JSON.stringify(facList.body).includes('Test_123'), 'Faculty roster does NOT contain plaintext password');

    const accountsList = await request('/api/auth/accounts', { cookie: hosCookie });
    assert(accountsList.status === 200, 'Accounts list returns 200');
    assert(!JSON.stringify(accountsList.body).includes('Test_123'), 'Accounts list does NOT contain plaintext password');

    // 11. Faculty Login
    console.log('\n--- Testing Faculty Login ---');
    const facLogin = await request('/api/auth/login', {
        method: 'POST',
        body: {
            username: 'test_faculty',
            password: 'Test_123'
        }
    });
    assert(facLogin.status === 200, 'Faculty login succeeds with HTTP 200');
    assert(Boolean(facLogin.cookie), 'Faculty login issued session cookie');
    const facCookie = facLogin.cookie;
    assert(facLogin.body.user.role === 'faculty', 'Authenticated user role is faculty');
    assert(facLogin.body.user.department === 'CSE', 'Faculty belongs to branch CSE');

    // 12. Verify Branch Isolation (Cross-branch 403)
    console.log('\n--- Testing Cross-Branch Isolation ---');
    const crossBranchCheck = await request('/api/availability', {
        method: 'POST',
        cookie: facCookie,
        body: {
            day: 'Monday',
            period: 1,
            department: 'EEE'
        }
    });
    assert(crossBranchCheck.status === 403, 'Cross-branch availability request rejected with HTTP 403 FORBIDDEN');

    // 13. Specific CME HOS & Faculty Workflow Verification (User Requirement Test)
    console.log('\n--- Testing Specific CME HOS and Faculty Creation Workflow ---');
    // Register CME HOS
    const cmeHOSReg = await request('/api/auth/register', {
        method: 'POST',
        body: {
            role: 'hos',
            name: 'CME HOS',
            phone: '9876543220',
            username: 'cme_hos',
            password: 'Cme_1234',
            confirmPassword: 'Cme_1234',
            branchName: 'Computer Engineering',
            branchCode: 'CME'
        }
    });
    assert(cmeHOSReg.status === 201, 'CME HOS registered successfully');

    // Login as CME HOS
    const cmeLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'cme_hos', password: 'Cme_1234' }
    });
    assert(cmeLogin.status === 200, 'CME HOS login returns 200');
    const cmeHOSCookie = cmeLogin.cookie;

    // Verify HOS branch status is CME
    const cmeStatus = await request('/api/auth/status', { cookie: cmeHOSCookie });
    assert(cmeStatus.body.branch.code === 'CME', 'CME HOS branch code is CME');
    assert(cmeStatus.body.branch.name === 'Computer Engineering', 'CME HOS branch name is Computer Engineering');

    // Verify UI templates have read-only branch display and no editable branch inputs
    const registerPage = await request('/register.html');
    assert(registerPage.body.includes('id="currentBranchBox"'), 'register.html has currentBranchBox');
    assert(registerPage.body.includes('id="currentBranchDisplay"'), 'register.html has currentBranchDisplay');

    const indexPage = await request('/index.html');
    assert(indexPage.body.includes('id="facBranchInheritBadge"'), 'index.html has facBranchInheritBadge');
    assert(indexPage.body.includes('Read-only · Automatically inherited from your authenticated HOS session'), 'index.html marks branch as read-only and auto-inherited');

    // Create Faculty under CME HOS
    const cmeFacCreate = await request('/api/auth/register', {
        method: 'POST',
        cookie: cmeHOSCookie,
        body: {
            role: 'faculty',
            name: 'CME Faculty Member',
            phone: '9876543221',
            username: 'cme_faculty',
            password: 'Fac_1234',
            confirmPassword: 'Fac_1234',
            subjects: ['Computer Networks']
        }
    });
    assert(cmeFacCreate.status === 201, 'CME Faculty created successfully (201 Created)');
    assert(cmeFacCreate.body.user.department === 'CME', 'CME Faculty automatically inherited branch CME');
    assert(!cmeFacCreate.body.user.password && !cmeFacCreate.body.user.passwordHash, 'Plaintext password not leaked in response');

    // Logout CME HOS
    await request('/api/auth/logout', { method: 'POST', cookie: cmeHOSCookie });

    // Login as CME Faculty
    const cmeFacLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'cme_faculty', password: 'Fac_1234' }
    });
    assert(cmeFacLogin.status === 200, 'CME Faculty logged in successfully');
    assert(cmeFacLogin.body.user.role === 'faculty', 'User role is faculty');
    assert(cmeFacLogin.body.user.department === 'CME', 'User department is strictly CME');

    // 14. Independent EEE HOS & Faculty Workflow
    console.log('\n--- Testing Independent EEE HOS and Faculty Workflow ---');
    const eeeHOSReg = await request('/api/auth/register', {
        method: 'POST',
        body: {
            role: 'hos',
            name: 'EEE HOS',
            phone: '9876543230',
            username: 'eee_hos',
            password: 'Eee_1234',
            confirmPassword: 'Eee_1234',
            branchName: 'Electrical and Electronics Engineering',
            branchCode: 'EEE'
        }
    });
    assert(eeeHOSReg.status === 201, 'EEE HOS registered successfully for independent branch EEE');

    const eeeLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'eee_hos', password: 'Eee_1234' }
    });
    assert(eeeLogin.status === 200, 'EEE HOS logged in successfully');
    const eeeHOSCookie = eeeLogin.cookie;

    const eeeFacCreate = await request('/api/auth/register', {
        method: 'POST',
        cookie: eeeHOSCookie,
        body: {
            role: 'faculty',
            name: 'EEE Faculty Member',
            phone: '9876543231',
            username: 'eee_faculty',
            password: 'Fac_1234',
            confirmPassword: 'Fac_1234',
            subjects: ['Power Systems']
        }
    });
    assert(eeeFacCreate.status === 201, 'EEE Faculty created successfully');
    assert(eeeFacCreate.body.user.department === 'EEE', 'EEE Faculty automatically inherited branch EEE');

    const eeeFacLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'eee_faculty', password: 'Fac_1234' }
    });
    assert(eeeFacLogin.status === 200, 'EEE Faculty logged in successfully');
    assert(eeeFacLogin.body.user.department === 'EEE', 'EEE Faculty belongs to branch EEE');

    // 15. Verify Branch Code Uniqueness (Cannot register duplicate CME or EEE)
    console.log('\n--- Testing Branch Code Uniqueness ---');
    const dupCME = await request('/api/auth/register', {
        method: 'POST',
        body: {
            role: 'hos',
            name: 'Another CME HOS',
            phone: '9876543240',
            username: 'another_cme',
            password: 'Cme_1234',
            confirmPassword: 'Cme_1234',
            branchName: 'Computer Engineering Department 2',
            branchCode: 'CME'
        }
    });
    assert(dupCME.status === 403, 'Duplicate CME branch registration rejected with HTTP 403 FORBIDDEN');
    assert(dupCME.body.error && dupCME.body.error.includes('Branch code CME already exists'), 'Clear error message: "Branch code CME already exists."');

    // 16. Verify Public Faculty Creation is Blocked
    console.log('\n--- Testing Public Faculty Creation Rejection ---');
    const pubFacAttempt = await request('/api/auth/register', {
        method: 'POST',
        body: {
            role: 'faculty',
            name: 'Unauthorized Public Faculty',
            phone: '9876543250',
            username: 'unauth_faculty',
            password: 'Fac_1234',
            confirmPassword: 'Fac_1234',
            subjects: ['Algorithms']
        }
    });
    assert(pubFacAttempt.status === 403, 'Public faculty registration rejected with HTTP 403');
    assert(pubFacAttempt.body.error && pubFacAttempt.body.error.includes('Public faculty creation is not allowed'), 'Clear error message for public faculty attempt');

    // 17. Verify Complete Multi-Branch Isolation between CME HOS and EEE HOS
    console.log('\n--- Testing Complete Multi-Branch Data Isolation ---');
    // Login as CME HOS
    const loginCME = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'cme_hos', password: 'Cme_1234' }
    });
    const cmeCookie = loginCME.cookie;

    // CME HOS checks faculty
    const cmeFacList = await request('/api/faculty', { cookie: cmeCookie });
    assert(cmeFacList.status === 200, 'CME HOS retrieved faculty');
    assert(cmeFacList.body.faculty.every(f => f.department === 'CME'), 'CME HOS sees only CME faculty');
    assert(!cmeFacList.body.faculty.some(f => f.department === 'EEE'), 'EEE faculty is completely invisible to CME HOS');

    // CME HOS checks accounts
    const cmeAccounts = await request('/api/auth/accounts', { cookie: cmeCookie });
    assert(cmeAccounts.status === 200, 'CME HOS retrieved accounts');
    assert(cmeAccounts.body.accounts.every(a => a.department === 'CME'), 'CME HOS sees only CME accounts');
    assert(!cmeAccounts.body.accounts.some(a => a.department === 'EEE'), 'EEE accounts are completely invisible to CME HOS');

    // CME HOS cross-branch attempt to query EEE faculty
    const cmeCrossFac = await request('/api/faculty?department=EEE', { cookie: cmeCookie });
    assert(cmeCrossFac.status === 403, 'CME HOS cross-branch query to EEE faculty returns HTTP 403');

    // Login as EEE HOS
    const loginEEE = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'eee_hos', password: 'Eee_1234' }
    });
    const eeeCookie = loginEEE.cookie;

    // EEE HOS checks faculty
    const eeeFacList = await request('/api/faculty', { cookie: eeeCookie });
    assert(eeeFacList.status === 200, 'EEE HOS retrieved faculty');
    assert(eeeFacList.body.faculty.every(f => f.department === 'EEE'), 'EEE HOS sees only EEE faculty');
    assert(!eeeFacList.body.faculty.some(f => f.department === 'CME'), 'CME faculty is completely invisible to EEE HOS');

    // EEE HOS checks accounts
    const eeeAccounts = await request('/api/auth/accounts', { cookie: eeeCookie });
    assert(eeeAccounts.status === 200, 'EEE HOS retrieved accounts');
    assert(eeeAccounts.body.accounts.every(a => a.department === 'EEE'), 'EEE HOS sees only EEE accounts');
    assert(!eeeAccounts.body.accounts.some(a => a.department === 'CME'), 'CME accounts are completely invisible to EEE HOS');

    // EEE HOS cross-branch attempt to query CME faculty
    const eeeCrossFac = await request('/api/faculty?department=CME', { cookie: eeeCookie });
    assert(eeeCrossFac.status === 403, 'EEE HOS cross-branch query to CME faculty returns HTTP 403');

    console.log('\n=================== ALL LIVE VERIFICATION CHECKS PASSED ===================\n');
}

if (process.env.BASE_URL) {
    runLiveVerification().catch(err => {
        console.error('VERIFICATION FAILED:', err);
        process.exit(1);
    });
} else {
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    server.stdout.on('data', d => log += d);
    server.stderr.on('data', d => log += d);

    waitForServer(BASE_URL)
        .then(runLiveVerification)
        .then(() => server.kill())
        .catch(err => {
            console.error('VERIFICATION FAILED:', err);
            if (log) console.error('\nServer output:\n' + log);
            server.kill();
            process.exit(1);
        });
}
