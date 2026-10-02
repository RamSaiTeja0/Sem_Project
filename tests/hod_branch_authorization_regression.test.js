/**
 * HOD Branch Authorization & Terminology Regression Tests
 *
 * Verifies:
 * 1. Branch Authorization:
 *    - CME HOD + CME upload -> allowed (200)
 *    - CME HOD + EEE upload -> 403 (Cross-branch access forbidden. You are HOD of CME, but this upload belongs to EEE.)
 *    - EEE HOD + CME upload -> 403 (Cross-branch access forbidden. You are HOD of EEE, but this upload belongs to CME.)
 *    - Missing branch -> explicit safe error without "HOD of ,"
 *    - Error messages never contain "HOD of ,"
 * 2. Session Branch Resolution:
 *    - Authenticated session preserves and normalizes department
 *    - Deserialization and lookup from DB correctly populate department
 * 3. UI Terminology:
 *    - HTML files (index.html, login.html, register.html) and JS files (app.js, register.js) use HOD
 *    - No user-facing HOS references remain in target UI strings
 * 4. Internal Role Compatibility:
 *    - Database and API role remains `hos`
 *    - Auth still works with `role: 'hos'`
 */

const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const { saveUploadRecord, saveStagedData } = require('../src/data/uploads');
const session = require('../src/core/session');

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

function call(method, urlPath, body, cookie, rawHeaders = {}) {
    return new Promise((resolve, reject) => {
        let payload = null;
        const headers = { ...rawHeaders };

        if (typeof body === 'string') {
            payload = body;
            headers['Content-Length'] = Buffer.byteLength(payload);
        } else if (body) {
            payload = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                const setCookie = res.headers['set-cookie'];
                const cookieVal = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : (setCookie ? setCookie.split(';')[0] : null);
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    headers: res.headers,
                    cookie: cookieVal
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log('\n=============================================================');
    console.log('Running HOD Branch Authorization & Terminology Regression Tests');
    console.log('=============================================================\n');

    await startServer();

    if (db.isConfigured()) {
        await store.initFromDatabase();
    }

    const rand = Math.floor(10000 + Math.random() * 90000);
    const branchCME = `CME_${rand}`;
    const branchEEE = `EEE_${rand}`;

    const hodCMEUser = `hod_cme_${rand}`;
    const hodEEEUser = `hod_eee_${rand}`;
    const password = 'TestPassword_123';

    // -------------------------------------------------------------
    // TEST 1: Register Branches & HODs (Role remains 'hos' internally)
    // -------------------------------------------------------------
    console.log('--- TEST 1: Register Branches & HODs with internal role "hos" ---');

    // Branch CME
    const regCME = await call('POST', '/api/auth/register', {
        username: hodCMEUser,
        name: `CME HOD ${rand}`,
        phone: '9876543210',
        password,
        role: 'hos',
        branchCode: branchCME,
        branchName: `Department of CME ${rand}`
    });
    assert.ok(regCME.status === 200 || regCME.status === 201, `Register CME HOD failed: ${JSON.stringify(regCME.body)}`);
    assert.strictEqual(regCME.body.authenticated, true);
    assert.strictEqual(regCME.body.user.role, 'hos', 'Internal role must remain "hos"');
    assert.strictEqual(regCME.body.user.department, branchCME);

    // Branch EEE
    const regEEE = await call('POST', '/api/auth/register', {
        username: hodEEEUser,
        name: `EEE HOD ${rand}`,
        phone: '9876543211',
        password,
        role: 'hos',
        branchCode: branchEEE,
        branchName: `Department of EEE ${rand}`
    });
    assert.ok(regEEE.status === 200 || regEEE.status === 201, `Register EEE HOD failed: ${JSON.stringify(regEEE.body)}`);
    assert.strictEqual(regEEE.body.authenticated, true);
    assert.strictEqual(regEEE.body.user.role, 'hos', 'Internal role must remain "hos"');
    assert.strictEqual(regEEE.body.user.department, branchEEE);

    // -------------------------------------------------------------
    // TEST 2: Session Login & Branch Resolution
    // -------------------------------------------------------------
    console.log('--- TEST 2: Session Login & Authoritative Branch Resolution ---');

    const loginCME = await call('POST', '/api/auth/login', { username: hodCMEUser, password });
    assert.strictEqual(loginCME.status, 200);
    const cookieCME = loginCME.cookie;
    assert.ok(cookieCME, 'CME HOD must receive session cookie');
    assert.strictEqual(loginCME.body.user.department, branchCME);
    assert.strictEqual(loginCME.body.user.role, 'hos');

    const loginEEE = await call('POST', '/api/auth/login', { username: hodEEEUser, password });
    assert.strictEqual(loginEEE.status, 200);
    const cookieEEE = loginEEE.cookie;
    assert.ok(cookieEEE, 'EEE HOD must receive session cookie');
    assert.strictEqual(loginEEE.body.user.department, branchEEE);
    assert.strictEqual(loginEEE.body.user.role, 'hos');

    // Check /api/auth/session returns consistent department
    const meCME = await call('GET', '/api/auth/session', null, cookieCME);
    assert.strictEqual(meCME.status, 200);
    assert.strictEqual(meCME.body.user.department, branchCME);
    assert.strictEqual(meCME.body.user.role, 'hos');

    // -------------------------------------------------------------
    // TEST 3: Create Upload Records for CME and EEE
    // -------------------------------------------------------------
    console.log('--- TEST 3: Staging / Upload Authorization Checks ---');

    const uploadCMEId = `up_cme_${rand}`;
    const uploadEEEId = `up_eee_${rand}`;

    const dummyDataCME = {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        schedule_grid: { 'Monday': [{ slot: '09:00 - 10:00', subject: 'CS101', faculty: 'Prof. CME', room: '101' }] },
        raw_extraction: {}
    };
    const dummyDataEEE = {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        schedule_grid: { 'Monday': [{ slot: '09:00 - 10:00', subject: 'EE101', faculty: 'Prof. EEE', room: '201' }] },
        raw_extraction: {}
    };

    await saveUploadRecord({
        uploadId: uploadCMEId,
        originalFilename: 'timetable_cme.json',
        fileType: 'application/json',
        fileSize: 100,
        status: 'PROCESSING',
        uploadType: 'MASTER_TIMETABLE',
        branchId: branchCME,
        uploaderUserId: hodCMEUser,
        departmentCode: branchCME
    });
    await saveStagedData(uploadCMEId, dummyDataCME);

    await saveUploadRecord({
        uploadId: uploadEEEId,
        originalFilename: 'timetable_eee.json',
        fileType: 'application/json',
        fileSize: 100,
        status: 'PROCESSING',
        uploadType: 'MASTER_TIMETABLE',
        branchId: branchEEE,
        uploaderUserId: hodEEEUser,
        departmentCode: branchEEE
    });
    await saveStagedData(uploadEEEId, dummyDataEEE);

    // 3A: CME HOD + CME upload -> ALLOWED (200)
    console.log('Testing: CME HOD + CME upload -> ALLOWED');
    const cmeAccessCme = await call('GET', `/api/staging/${uploadCMEId}`, null, cookieCME);
    assert.strictEqual(cmeAccessCme.status, 200, `CME HOD should access CME upload, got ${cmeAccessCme.status}`);
    assert.strictEqual(cmeAccessCme.body.uploadId, uploadCMEId);

    // 3B: CME HOD + EEE upload -> REJECTED with 403
    console.log('Testing: CME HOD + EEE upload -> REJECTED with 403');
    const cmeAccessEee = await call('GET', `/api/staging/${uploadEEEId}`, null, cookieCME);
    assert.strictEqual(cmeAccessEee.status, 403, `CME HOD accessing EEE upload must return 403, got ${cmeAccessEee.status}`);
    assert.ok(cmeAccessEee.body.error, 'Should contain error message');
    assert.ok(
        cmeAccessEee.body.error.includes(`You are HOD of ${branchCME}`) && cmeAccessEee.body.error.includes(branchEEE),
        `Error message must contain "You are HOD of ${branchCME}, but this upload belongs to ${branchEEE}". Got: ${cmeAccessEee.body.error}`
    );
    assert.ok(!cmeAccessEee.body.error.includes('HOD of ,'), 'Error message must not contain blank branch "HOD of ,"');
    assert.ok(!cmeAccessEee.body.error.includes('HOS of'), 'Error message must use HOD terminology');

    // 3C: EEE HOD + CME upload -> REJECTED with 403
    console.log('Testing: EEE HOD + CME upload -> REJECTED with 403');
    const eeeAccessCme = await call('GET', `/api/staging/${uploadCMEId}`, null, cookieEEE);
    assert.strictEqual(eeeAccessCme.status, 403, `EEE HOD accessing CME upload must return 403, got ${eeeAccessCme.status}`);
    assert.ok(
        eeeAccessCme.body.error.includes(`You are HOD of ${branchEEE}`) && eeeAccessCme.body.error.includes(branchCME),
        `Error message must contain "You are HOD of ${branchEEE}, but this upload belongs to ${branchCME}". Got: ${eeeAccessCme.body.error}`
    );
    assert.ok(!eeeAccessCme.body.error.includes('HOD of ,'), 'Error message must not contain blank branch');

    // 3D: Missing authenticated branch -> Safe explicit error, never guessed
    console.log('Testing: Missing authenticated branch -> safe explicit 403');
    const noBranchToken = session.create({
        id: `nobranch_${rand}`,
        username: `nobranch_${rand}`,
        role: 'hos',
        department: ''
    });
    const noBranchCookie = `tec_session=${noBranchToken}`;

    const noBranchAccess = await call('GET', `/api/staging/${uploadCMEId}`, null, noBranchCookie);
    assert.strictEqual(noBranchAccess.status, 403);
    assert.ok(
        noBranchAccess.body.error.includes('Your authenticated HOD account has no associated branch') ||
        noBranchAccess.body.error.includes('Forbidden'),
        `Error should explicitly state missing branch, got: ${noBranchAccess.body.error}`
    );
    assert.ok(!noBranchAccess.body.error.includes('HOD of ,'), 'Must never output "HOD of ,"');

    // -------------------------------------------------------------
    // TEST 4: UI Terminology Checks
    // -------------------------------------------------------------
    console.log('--- TEST 4: UI Terminology Verification ---');

    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
    const registerHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const registerJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'register.js'), 'utf8');

    // Ensure user-facing texts contain HOD
    assert.ok(loginHtml.includes('Head of Department (HOD)'), 'login.html should reference HOD');
    assert.ok(registerHtml.includes('Head of Department (HOD)'), 'register.html should reference HOD');
    assert.ok(registerHtml.includes('approved by the HOD'), 'register.html should reference approved by the HOD');
    assert.ok(registerJs.includes('Register HOD Account'), 'register.js should reference Register HOD Account');
    assert.ok(appJs.includes('HOD ·'), 'app.js should format profile role as HOD');
    assert.ok(indexHtml.includes('Automatically inherited from your authenticated HOD session'), 'index.html should reference authenticated HOD session');

    // Ensure no obsolete user-facing HOS labels remain in UI HTML
    assert.ok(!loginHtml.includes('Head of Section (HOS)'), 'login.html must not contain Head of Section (HOS)');
    assert.ok(!loginHtml.includes('Create Initial HOS'), 'login.html must not contain Create Initial HOS');
    assert.ok(!registerHtml.includes('Head of Section (HOS)'), 'register.html must not contain Head of Section (HOS)');
    assert.ok(!registerHtml.includes('Register HOS Account'), 'register.html must not contain Register HOS Account');
    assert.ok(!indexHtml.includes('Head of Section (HOS)'), 'index.html must not contain Head of Section (HOS)');
    assert.ok(!indexHtml.includes('authenticated HOS session'), 'index.html must not contain authenticated HOS session');
    assert.ok(!indexHtml.includes('Pending HOS Approval'), 'index.html must not contain Pending HOS Approval');

    // Ensure role='hos' value is still preserved for internal API compatibility
    assert.ok(registerHtml.includes('value="hos"'), 'register.html must keep internal role value "hos"');
    assert.ok(registerJs.includes("'hos'"), 'register.js must keep internal role value "hos"');

    console.log('\n=============================================================');
    console.log('✅ All HOD Branch Authorization & Terminology Regression Tests PASSED');
    console.log('=============================================================\n');

    await stopServer();
    process.exit(0);
}

runTests().catch(async (err) => {
    console.error('\n❌ Test Failure:', err);
    await stopServer();
    process.exit(1);
});
