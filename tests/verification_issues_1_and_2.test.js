const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting } = require('../src/data/departments');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');

let server;
let baseUrl;

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

const AUTHORITATIVE_PERIODS = {
    '1': { start: '08:00', end: '08:45' },
    '2': { start: '08:45', end: '09:30' },
    '3': { start: '09:30', end: '10:15' },
    '4': { start: '10:30', end: '11:15' },
    '5': { start: '11:15', end: '12:00' },
    '6': { start: '12:00', end: '12:45' },
    '7': { start: '12:45', end: '13:30' }
};

function makeRequest(urlPath, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlPath, baseUrl);
        const reqHeaders = { ...headers };
        let payload = null;
        if (body) {
            payload = typeof body === 'string' ? body : JSON.stringify(body);
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request(parsedUrl, { method, headers: reqHeaders }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusMessage, statusCode: res.statusCode, headers: res.headers, body: json });
                } catch (e) {
                    resolve({ status: res.statusMessage, statusCode: res.statusCode, headers: res.headers, body: data });
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runVerification() {
    await startServer();
    console.log('====================================================');
    console.log('STARTING AUTOMATED VERIFICATION FOR ISSUES 1 & 2');
    console.log('====================================================\n');

    // ----------------------------------------------------
    // TEST 1: Check HTML and CSS DOM for Modal Responsiveness and Error Visibility (Issue 1)
    // ----------------------------------------------------
    console.log('--- TEST 1: Verifying Create Faculty Account Modal DOM & Styling ---');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

    // Check modal markup
    assert.ok(indexHtml.includes('id="createFacultyAccountModal"'), 'createFacultyAccountModal must exist');
    assert.ok(indexHtml.includes('max-height:88vh') || indexHtml.includes('max-height: 88vh'), 'Modal card must have max-height 85-90vh');
    assert.ok(indexHtml.includes('overflow-y:auto') || indexHtml.includes('overflow-y: auto'), 'Modal container and body must have overflow-y: auto');
    assert.ok(indexHtml.includes('id="createAccNote"'), 'createAccNote error container must exist');
    
    // Check app.js error handling
    assert.ok(appJs.includes('noteBox.textContent = err.message'), 'app.js must display exact backend error message');
    assert.ok(appJs.includes('scrollIntoView'), 'app.js must scroll noteBox into view if needed');
    console.log('✓ Modal responsiveness and error visibility markup verified.');

    // ----------------------------------------------------
    // TEST 2: Trigger Real Backend Errors for Create Faculty Account (Issue 1)
    // ----------------------------------------------------
    console.log('\n--- TEST 2: Testing Create Faculty Account API Validation Errors ---');
    
    // 2.1 Register HOD to get session
    const rand = Math.floor(1000 + Math.random() * 9000);
    const hodRegRes = await makeRequest('/api/auth/register', 'POST', {
        role: 'hos',
        name: `HOD CME ${rand}`,
        username: `hod_cme_${rand}`,
        phone: `998877${rand}`,
        password: `HOD_pass_${rand}`,
        confirmPassword: `HOD_pass_${rand}`,
        branchCode: `CME_${rand}`,
        branchName: 'Computer Engineering'
    });
    assert.strictEqual(hodRegRes.statusCode, 201, 'HOD registration should succeed');
    const cookie = hodRegRes.headers['set-cookie'] ? hodRegRes.headers['set-cookie'][0].split(';')[0] : '';
    const authHeaders = { Cookie: cookie };

    // 2.2 Add an unlinked faculty member directly into repository / store (simulating discovered/timetable faculty without account)
    const store = require('../src/data/store');
    const repository = require('../src/db/repository');
    const db = require('../src/db/pool');

    const unlinkedFacId = `FAC_UNLINKED_${rand}`;
    if (db.isConfigured() && store.usingDatabase) {
        await repository.addFaculty({
            id: unlinkedFacId,
            name: `Prof. Unlinked ${rand}`,
            department: `CME_${rand}`,
            phone: `912345${rand}`,
            designation: 'Lecturer',
            status: 'active'
        });
        await store.reloadFromDatabase();
    } else {
        store.addFacultyInMemory({
            id: unlinkedFacId,
            name: `Prof. Unlinked ${rand}`,
            department: `CME_${rand}`,
            phone: `912345${rand}`,
            designation: 'Lecturer',
            subjects: ['Algorithms'],
            status: 'active'
        });
    }

    // 2.3 Attempt to create account with mismatched password
    const errPwMismatch = await makeRequest(`/api/faculty/${encodeURIComponent(unlinkedFacId)}/create-account`, 'POST', {
        name: `Prof. Unlinked ${rand}`,
        username: `user_${rand}`,
        phone: `912345${rand}`,
        password: `Pass_1234_${rand}`,
        confirmPassword: `Pass_Different_${rand}`,
        subjects: 'Algorithms'
    }, authHeaders);
    assert.strictEqual(errPwMismatch.statusCode, 400);
    assert.ok(errPwMismatch.body.error.includes('Passwords do not match'), `Should give password mismatch error, got: ${errPwMismatch.body.error}`);
    console.log('✓ Verified error: Passwords do not match');

    // 2.4 Attempt to create account with invalid phone
    const errPhone = await makeRequest(`/api/faculty/${encodeURIComponent(unlinkedFacId)}/create-account`, 'POST', {
        name: `Prof. Unlinked ${rand}`,
        username: `user_${rand}`,
        phone: `12345`,
        password: `Pass_1234_${rand}`,
        confirmPassword: `Pass_1234_${rand}`,
        subjects: 'Algorithms'
    }, authHeaders);
    assert.strictEqual(errPhone.statusCode, 400);
    assert.ok(errPhone.body.error.toLowerCase().includes('phone'), `Should give phone error, got: ${errPhone.body.error}`);
    console.log('✓ Verified error: Invalid phone number');

    // 2.5 Successfully create first account
    const okAcc = await makeRequest(`/api/faculty/${encodeURIComponent(unlinkedFacId)}/create-account`, 'POST', {
        name: `Prof. Unlinked ${rand}`,
        username: `user_${rand}`,
        phone: `912345${rand}`,
        password: `Pass_1234_${rand}`,
        confirmPassword: `Pass_1234_${rand}`,
        subjects: 'Algorithms'
    }, authHeaders);
    assert.strictEqual(okAcc.statusCode, 201, 'Account creation should succeed');
    console.log('✓ Account created successfully');

    // 2.6 Attempt to create account again for same faculty (Faculty already has account error)
    const errAlreadyHasAcc = await makeRequest(`/api/faculty/${encodeURIComponent(unlinkedFacId)}/create-account`, 'POST', {
        name: `Prof. Unlinked ${rand}`,
        username: `user_new_${rand}`,
        phone: `912345${rand}`,
        password: `Pass_1234_${rand}`,
        confirmPassword: `Pass_1234_${rand}`,
        subjects: 'Algorithms'
    }, authHeaders);
    assert.strictEqual(errAlreadyHasAcc.statusCode, 409);
    assert.ok(errAlreadyHasAcc.body.error.toLowerCase().includes('already has an account') || errAlreadyHasAcc.body.error.toLowerCase().includes('already has a linked login account'),
        `Should give faculty already has account error, got: ${errAlreadyHasAcc.body.error}`);
    console.log('✓ Verified error: Faculty already has an account (' + errAlreadyHasAcc.body.error + ')');

    // 2.7 Attempt to create account for another faculty with DUPLICATE username
    const unlinkedFacId2 = `FAC_UNLINKED_2_${rand}`;
    if (db.isConfigured() && store.usingDatabase) {
        await repository.addFaculty({
            id: unlinkedFacId2,
            name: `Prof. Unlinked 2 ${rand}`,
            department: `CME_${rand}`,
            phone: `922345${rand}`,
            designation: 'Lecturer',
            status: 'active'
        });
        await store.reloadFromDatabase();
    } else {
        store.addFacultyInMemory({
            id: unlinkedFacId2,
            name: `Prof. Unlinked 2 ${rand}`,
            department: `CME_${rand}`,
            phone: `922345${rand}`,
            designation: 'Lecturer',
            subjects: ['Networks'],
            status: 'active'
        });
    }

    const errDupUsername = await makeRequest(`/api/faculty/${encodeURIComponent(unlinkedFacId2)}/create-account`, 'POST', {
        name: `Prof. Unlinked 2 ${rand}`,
        username: `user_${rand}`, // duplicate username
        phone: `922345${rand}`,
        password: `Pass_1234_${rand}`,
        confirmPassword: `Pass_1234_${rand}`,
        subjects: 'Networks'
    }, authHeaders);
    assert.strictEqual(errDupUsername.statusCode, 409);
    assert.ok(errDupUsername.body.error.toLowerCase().includes('username') && errDupUsername.body.error.toLowerCase().includes('already taken'),
        `Should give duplicate username error, got: ${errDupUsername.body.error}`);
    console.log('✓ Verified error: Username already taken (' + errDupUsername.body.error + ')');

    // ----------------------------------------------------
    // TEST 3: Authoritative Period Timings Verification (Issue 2)
    // ----------------------------------------------------
    console.log('\n--- TEST 3: Verifying Authoritative 08:00-based Period Timings Everywhere ---');

    // 3.1 GET /api/timetable/meta
    const metaRes = await makeRequest('/api/timetable/meta', 'GET', null, authHeaders);
    assert.strictEqual(metaRes.statusCode, 200);
    assert.ok(metaRes.body.periodTimings, 'meta must contain periodTimings');
    for (let p = 1; p <= 7; p++) {
        const expected = AUTHORITATIVE_PERIODS[String(p)];
        const actual = metaRes.body.periodTimings[String(p)];
        assert.ok(actual, `meta.periodTimings must have period ${p}`);
        assert.strictEqual(actual.start, expected.start, `Period ${p} start time must be ${expected.start}, got ${actual.start}`);
        assert.strictEqual(actual.end, expected.end, `Period ${p} end time must be ${expected.end}, got ${actual.end}`);
    }
    console.log('✓ GET /api/timetable/meta returned authoritative 08:00-based timings for P1-P7:');
    console.log(JSON.stringify(metaRes.body.periodTimings, null, 2));

    // 3.2 GET /api/timetable (Master Timetable)
    const ttRes = await makeRequest('/api/timetable', 'GET', null, authHeaders);
    assert.strictEqual(ttRes.statusCode, 200);
    assert.ok(ttRes.body.periodTimings, 'GET /api/timetable must return periodTimings');
    assert.strictEqual(ttRes.body.periodTimings['1'].start, '08:00');
    assert.strictEqual(ttRes.body.periodTimings['1'].end, '08:45');
    assert.strictEqual(ttRes.body.periodTimings['7'].start, '12:45');
    assert.strictEqual(ttRes.body.periodTimings['7'].end, '13:30');
    console.log('✓ GET /api/timetable returned authoritative timings (P1: 08:00–08:45, P7: 12:45–13:30)');

    // 3.3 POST /api/availability
    const availRes = await makeRequest('/api/availability', 'POST', {
        day: 'Monday',
        period: 1,
        branch: `CME_${rand}`
    }, authHeaders);
    assert.strictEqual(availRes.statusCode, 200);
    assert.ok(availRes.body.periodTimings, 'POST /api/availability must return periodTimings');
    assert.strictEqual(availRes.body.periodTimings['1'].start, '08:00');
    assert.strictEqual(availRes.body.periodTimings['7'].end, '13:30');
    console.log('✓ POST /api/availability returned authoritative timings');

    // 3.4 GET /api/availability/summary
    const summaryRes = await makeRequest('/api/availability/summary', 'GET', null, authHeaders);
    assert.strictEqual(summaryRes.statusCode, 200);
    assert.ok(summaryRes.body.periodTimings, 'GET /api/availability/summary must return periodTimings');
    assert.strictEqual(summaryRes.body.periodTimings['1'].start, '08:00');
    console.log('✓ GET /api/availability/summary returned authoritative timings');

    // 3.5 Login as Faculty and check GET /api/timetable/mine
    const facLoginRes = await makeRequest('/api/auth/login', 'POST', {
        username: `user_${rand}`,
        password: `Pass_1234_${rand}`
    });
    assert.strictEqual(facLoginRes.statusCode, 200);
    const facCookie = facLoginRes.headers['set-cookie'][0].split(';')[0];
    const facAuthHeaders = { Cookie: facCookie };

    const mineRes = await makeRequest('/api/timetable/mine', 'GET', null, facAuthHeaders);
    assert.strictEqual(mineRes.statusCode, 200);
    assert.ok(mineRes.body.periodTimings, 'GET /api/timetable/mine must return periodTimings');
    assert.strictEqual(mineRes.body.periodTimings['1'].start, '08:00');
    assert.strictEqual(mineRes.body.periodTimings['7'].end, '13:30');
    console.log('✓ GET /api/timetable/mine returned authoritative timings');

    console.log('\n====================================================');
    console.log('ALL VERIFICATION CHECKS PASSED SUCCESSFULLY!');
    console.log('====================================================');
    await stopServer();
    process.exit(0);
}

runVerification().catch(async (err) => {
    console.error('VERIFICATION ERROR:', err);
    await stopServer();
    process.exit(1);
});
