/**
 * Comprehensive verification of the real login interface and role sessions.
 */
const assert = require('assert');
const http = require('http');

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;

function call(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${BASE}${urlPath}`, { method, headers }, res => {
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
    console.log('=== VERIFYING ACTUAL APPLICATION LOGIN & UI FLOW ===\n');

    // 1. Inspect actual served /login HTML
    console.log('[1] Inspecting served /login page HTML...');
    const loginPage = await call('GET', '/login');
    assert.strictEqual(loginPage.status, 200, 'Login page must be served with 200 OK');
    assert.ok(loginPage.raw.includes('id="hosChip"'), 'Login page must have #hosChip button');
    assert.ok(loginPage.raw.includes('data-user="hos"'), '#hosChip must prefill user "hos"');
    assert.ok(loginPage.raw.includes('HOS · Branch Lead'), 'Login page must show "HOS · Branch Lead" badge');
    assert.ok(loginPage.raw.includes('id="facultyGrid"'), 'Login page must have #facultyGrid for faculty accounts');
    assert.ok(loginPage.raw.includes('id="username"'), 'Login page must have #username input');
    assert.ok(loginPage.raw.includes('id="password"'), 'Login page must have #password input');
    console.log('✓ Login page HTML correctly contains HOS login button and credentials UI.');

    // 2. Inspect /api/auth/accounts API
    console.log('\n[2] Inspecting /api/auth/accounts payload...');
    const accountsRes = await call('GET', '/api/auth/accounts');
    assert.strictEqual(accountsRes.status, 200);
    assert.ok(accountsRes.body.hos, 'Response must provide hos account metadata');
    assert.strictEqual(accountsRes.body.hos.username, 'hos');
    assert.strictEqual(accountsRes.body.hos.role, 'hos');
    assert.strictEqual(accountsRes.body.demoPassword, 'tecsub123');
    console.log(`✓ Accounts API returns HOS: ${accountsRes.body.hos.name} (${accountsRes.body.hos.role}) in branch ${accountsRes.body.hos.department}`);

    // 3. Perform HOS login through the UI endpoint
    console.log('\n[3] Logging in as HOS through POST /api/auth/login...');
    const hosLogin = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
    assert.strictEqual(hosLogin.status, 200, 'HOS login must succeed');
    assert.ok(hosLogin.cookie, 'HOS login must issue session cookie');
    assert.strictEqual(hosLogin.body.user.username, 'hos');
    assert.strictEqual(hosLogin.body.user.role, 'hos');
    console.log(`✓ HOS successfully signed in: ${hosLogin.body.user.name}, role: ${hosLogin.body.user.role}`);

    // 4. Verify session persistence
    console.log('\n[4] Verifying HOS session on /api/auth/session...');
    const hosSession = await call('GET', '/api/auth/session', null, hosLogin.cookie);
    assert.strictEqual(hosSession.status, 200);
    assert.strictEqual(hosSession.body.authenticated, true);
    assert.strictEqual(hosSession.body.user.role, 'hos');
    assert.strictEqual(hosSession.body.user.username, 'hos');
    console.log('✓ HOS session persistence verified.');

    // 5. Verify HOS capabilities
    console.log('\n[5] Verifying HOS capabilities in session...');
    const branchUpdate = await call('PUT', '/api/branch', { name: 'Computer Engineering Department' }, hosLogin.cookie);
    assert.strictEqual(branchUpdate.status, 200, 'HOS must be able to configure branch');

    const facultyListRes = await call('GET', '/api/faculty', null, hosLogin.cookie);
    assert.strictEqual(facultyListRes.status, 200);
    const sampleFaculty = facultyListRes.body.faculty[0];
    assert.ok(sampleFaculty, 'Should have at least one faculty member in branch');

    const hosAvailCheck = await call('POST', '/api/availability', {
        day: 'Monday',
        period: 1,
        absentFaculty: sampleFaculty.name
    }, hosLogin.cookie);
    assert.strictEqual(hosAvailCheck.status, 200, 'HOS must be able to run availability with absent faculty');
    console.log(`✓ HOS can configure branch and check availability for absent faculty (${sampleFaculty.name}).`);

    // 6. Perform Faculty login through UI endpoint
    const facultyAccount = accountsRes.body.accounts.find(a => a.role === 'faculty');
    assert.ok(facultyAccount, 'Must have at least one faculty account in accounts directory');
    console.log(`\n[6] Logging in as Faculty (${facultyAccount.username})...`);
    const facLogin = await call('POST', '/api/auth/login', { username: facultyAccount.username, password: 'tecsub123' });
    assert.strictEqual(facLogin.status, 200);
    assert.ok(facLogin.cookie);
    assert.strictEqual(facLogin.body.user.role, 'faculty');
    console.log(`✓ Faculty successfully signed in: ${facLogin.body.user.name}, role: ${facLogin.body.user.role}`);

    // 7. Verify Faculty workflow & restrictions
    console.log('\n[7] Verifying Faculty workflow and security boundaries...');
    const facMine = await call('GET', '/api/timetable/mine', null, facLogin.cookie);
    assert.strictEqual(facMine.status, 200, 'Faculty can read own timetable');

    const facConfigBlocked = await call('PUT', '/api/branch', { name: 'Hacked' }, facLogin.cookie);
    assert.strictEqual(facConfigBlocked.status, 403, 'Faculty is forbidden from configuring branch (403)');

    const facAvailBlocked = await call('POST', '/api/availability', {
        day: 'Monday',
        period: 1,
        absentFaculty: facultyAccount.name
    }, facLogin.cookie);
    assert.strictEqual(facAvailBlocked.status, 403, 'Faculty is forbidden from absent faculty queries (403)');
    console.log('✓ Faculty access and restrictions verified.');

    // 8. Verify Dashboard HTML served to client
    console.log('\n[8] Verifying Dashboard HTML contains all required views and elements...');
    const dashHtml = await call('GET', '/dashboard');
    assert.strictEqual(dashHtml.status, 200);
    assert.ok(dashHtml.raw.includes('id="userName"'), 'Contains user name display');
    assert.ok(dashHtml.raw.includes('id="userRole"'), 'Contains user role display');
    assert.ok(dashHtml.raw.includes('id="view-availability"'), 'Contains Faculty Availability view');
    assert.ok(dashHtml.raw.includes('id="availHOSCard"'), 'Contains HOS Availability Finder card');
    assert.ok(dashHtml.raw.includes('id="view-timetable"'), 'Contains Master Timetable view');
    assert.ok(dashHtml.raw.includes('id="ttManageBtn"'), 'Contains Master Timetable manage button');
    assert.ok(dashHtml.raw.includes('id="view-faculty"'), 'Contains Faculty Directory view');
    assert.ok(dashHtml.raw.includes('id="facAddCard"'), 'Contains Add Faculty card');
    assert.ok(dashHtml.raw.includes('id="view-schedule"'), 'Contains My Timetable view');
    assert.ok(dashHtml.raw.includes('id="view-about"'), 'Contains Settings / About view');
    assert.ok(dashHtml.raw.includes('id="aboutBranchCard"'), 'Contains Branch Configuration card');
    console.log('✓ Dashboard HTML includes all required elements for HOS and Faculty.');

    console.log('\n======================================================');
    console.log('ALL VERIFICATIONS PASSED: HOS LOGIN & UI ARE FULLY OPERATIONAL');
    console.log('======================================================');
}

run().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
