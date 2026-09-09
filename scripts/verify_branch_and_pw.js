/**
 * Direct Live Server Verification Script.
 *
 * Verifies live server at http://localhost:3001:
 *   1. HTML structure of /register (toggles, live requirements, accessible labels, no CME prefill)
 *   2. Flow 1: Create initial CME HOS
 *   3. Flow 2: CME HOS creates Faculty A (branch inherited as CME)
 *   4. Flow 3: Independent EEE HOS setup (branch preserved as EEE, CME not inherited, data isolation verified)
 *   5. Flow 4: Password validation and error messages
 */
const http = require('http');
const assert = require('assert');

const BASE = 'http://localhost:3001';

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

async function verify() {
    console.log('--- Starting Live Server Verification on', BASE, '---');

    // 1. Verify Register HTML
    console.log('\n[Check 1] Verify Register HTML & Controls');
    const htmlRes = await call('GET', '/register');
    assert.strictEqual(htmlRes.status, 200);
    const html = htmlRes.raw;
    assert.ok(html.includes('id="toggleRegPassword"'), 'Missing #toggleRegPassword');
    assert.ok(html.includes('id="toggleRegConfirmPassword"'), 'Missing #toggleRegConfirmPassword');
    assert.ok(html.includes('aria-label="Show password"'), 'Missing aria-label="Show password"');
    assert.ok(html.includes('title="Show password"'), 'Missing title="Show password"');
    assert.ok(html.includes('id="passwordRequirements"'), 'Missing #passwordRequirements');
    assert.ok(html.includes('id="reqLetter"'), 'Missing #reqLetter');
    assert.ok(html.includes('id="reqNumber"'), 'Missing #reqNumber');
    assert.ok(html.includes('id="reqUnderscore"'), 'Missing #reqUnderscore');
    assert.ok(html.includes('id="reqChars"'), 'Missing #reqChars');
    assert.ok(!html.includes('value="CME"'), 'HTML must not have value="CME"');
    assert.ok(!html.includes('value="Computer Engineering"'), 'HTML must not have value="Computer Engineering"');
    console.log('✓ Register HTML contains both password toggles, accessible attributes, live requirements checklist, and no hardcoded CME defaults.');

    // 2. Unauthenticated Status
    console.log('\n[Check 2] Public /api/auth/status');
    const statusRes = await call('GET', '/api/auth/status');
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.body.authenticated, false);
    assert.strictEqual(statusRes.body.allowHOSCreation, true);
    assert.strictEqual(statusRes.body.branch.code, '');
    assert.strictEqual(statusRes.body.branch.name, '');
    console.log('✓ Public visitor sees allowHOSCreation=true and empty branch fields (no CME default).');

    // 3. FLOW 4: Password Validation Tests on Live API
    console.log('\n[Check 3] Flow 4: Password Validation on Live API');
    const { validatePassword, PASSWORD_ERROR_MESSAGE } = require('../src/core/authSecurity');
    assert.strictEqual(validatePassword('TecSub_123'), true);
    assert.strictEqual(validatePassword('abc123_'), true);
    assert.strictEqual(validatePassword('A1_b2'), true);
    assert.strictEqual(validatePassword('abc123'), false);
    assert.strictEqual(validatePassword('abcdef_'), false);
    assert.strictEqual(validatePassword('123456_'), false);
    assert.strictEqual(validatePassword('abc.123_'), false);
    assert.strictEqual(validatePassword('abc-123_'), false);
    assert.strictEqual(validatePassword('abc@123_'), false);
    assert.strictEqual(validatePassword('abc 123_'), false);

    const testDot = await call('POST', '/api/auth/register', {
        role: 'hos',
        name: 'Test Dot',
        phone: '9876543210',
        branchName: 'Civil Engineering',
        branchCode: 'CIV_TEST',
        username: 'test.dot.hos',
        password: 'abc.123_',
        confirmPassword: 'abc.123_'
    });
    assert.strictEqual(testDot.status, 400);
    assert.strictEqual(testDot.body.code, 'INVALID_PASSWORD');
    assert.strictEqual(testDot.body.error, PASSWORD_ERROR_MESSAGE);

    const testDash = await call('POST', '/api/auth/register', {
        role: 'hos',
        name: 'Test Dash',
        phone: '9876543210',
        branchName: 'Civil Engineering',
        branchCode: 'CIV_TEST',
        username: 'test.dash.hos',
        password: 'abc-123_',
        confirmPassword: 'abc-123_'
    });
    assert.strictEqual(testDash.status, 400);
    assert.strictEqual(testDash.body.code, 'INVALID_PASSWORD');
    assert.strictEqual(testDash.body.error, PASSWORD_ERROR_MESSAGE);
    console.log('✓ Live API rejects passwords containing dot (.) and dash (-) with the exact required error message.');

    // 4. FLOW 1: Create Initial HOS for CME
    console.log('\n[Check 4] Flow 1: Create Initial HOS for CME');
    const cmeUsername = `cme.hos.${Date.now()}`;
    const cmeHosRes = await call('POST', '/api/auth/register', {
        role: 'hos',
        name: 'Test CME HOS',
        phone: '9876543210',
        branchName: 'Computer Engineering',
        branchCode: 'CME',
        username: cmeUsername,
        password: 'TecSub_123',
        confirmPassword: 'TecSub_123'
    });
    assert.strictEqual(cmeHosRes.status, 201);
    assert.strictEqual(cmeHosRes.body.user.role, 'hos');
    assert.strictEqual(cmeHosRes.body.user.department, 'CME');
    assert.strictEqual(cmeHosRes.body.user.branchName, 'Computer Engineering');
    const cmeCookie = cmeHosRes.cookie;
    assert.ok(cmeCookie, 'Expected CME HOS cookie');

    const cmeSession = await call('GET', '/api/auth/session', null, cmeCookie);
    assert.strictEqual(cmeSession.body.authenticated, true);
    assert.strictEqual(cmeSession.body.user.department, 'CME');
    console.log('✓ CME HOS registered and verified in session (branch = CME).');

    // 5. FLOW 2: As CME HOS, Create Faculty A
    console.log('\n[Check 5] Flow 2: As CME HOS, Create Faculty A');
    const facAUsername = `faculty.a.${Date.now()}`;
    const facARes = await call('POST', '/api/auth/register', {
        role: 'faculty',
        name: 'Faculty A',
        phone: '9876543211',
        username: facAUsername,
        password: 'TecSub_123',
        confirmPassword: 'TecSub_123',
        subjects: ['Computer Networks', 'Operating Systems']
    }, cmeCookie);
    assert.strictEqual(facARes.status, 201);
    assert.strictEqual(facARes.body.user.department, 'CME');
    assert.strictEqual(facARes.body.user.branchName, 'Computer Engineering');
    console.log('✓ Faculty A created by CME HOS is automatically assigned to CME.');

    // 6. Check that public status does NOT inherit CME
    console.log('\n[Check 6] Verify Public Registration Does NOT Inherit CME');
    const pubStatusAfterCme = await call('GET', '/api/auth/status');
    assert.strictEqual(pubStatusAfterCme.body.authenticated, false);
    assert.strictEqual(pubStatusAfterCme.body.allowHOSCreation, true);
    assert.strictEqual(pubStatusAfterCme.body.branch.code, '');
    assert.strictEqual(pubStatusAfterCme.body.branch.name, '');
    console.log('✓ Unauthenticated visitor still sees empty branch fields (CME is NOT inherited).');

    // 7. FLOW 3: Independent HOS / EEE Branch Setup
    console.log('\n[Check 7] Flow 3: Independent HOS / EEE Branch Setup');
    const eeeUsername = `eee.hos.${Date.now()}`;
    const eeeHosRes = await call('POST', '/api/auth/register', {
        role: 'hos',
        name: 'Test EEE HOS',
        phone: '9876543220',
        branchName: 'Electrical Engineering',
        branchCode: 'EEE',
        username: eeeUsername,
        password: 'TecSub_123',
        confirmPassword: 'TecSub_123'
    });
    assert.strictEqual(eeeHosRes.status, 201);
    assert.strictEqual(eeeHosRes.body.user.role, 'hos');
    assert.strictEqual(eeeHosRes.body.user.department, 'EEE');
    assert.strictEqual(eeeHosRes.body.user.branchName, 'Electrical Engineering');
    const eeeCookie = eeeHosRes.cookie;
    assert.ok(eeeCookie, 'Expected EEE HOS cookie');

    const eeeSession = await call('GET', '/api/auth/session', null, eeeCookie);
    assert.strictEqual(eeeSession.body.authenticated, true);
    assert.strictEqual(eeeSession.body.user.department, 'EEE');
    assert.notStrictEqual(eeeSession.body.user.department, 'CME');
    console.log('✓ EEE HOS registered and verified in session (branch = EEE, did not become CME).');

    // 8. Verify Branch Data Isolation
    console.log('\n[Check 8] Verify Branch Data Isolation');
    const cmeAccounts = await call('GET', '/api/auth/accounts', null, cmeCookie);
    const cmeUsernames = cmeAccounts.body.accounts.map(a => a.username);
    assert.ok(cmeUsernames.includes(cmeUsername), 'CME accounts must include CME HOS');
    assert.ok(cmeUsernames.includes(facAUsername), 'CME accounts must include Faculty A');
    assert.ok(!cmeUsernames.includes(eeeUsername), 'CME accounts must NOT include EEE HOS');

    const eeeAccounts = await call('GET', '/api/auth/accounts', null, eeeCookie);
    const eeeUsernames = eeeAccounts.body.accounts.map(a => a.username);
    assert.ok(eeeUsernames.includes(eeeUsername), 'EEE accounts must include EEE HOS');
    assert.ok(!eeeUsernames.includes(cmeUsername), 'EEE accounts must NOT include CME HOS');
    assert.ok(!eeeUsernames.includes(facAUsername), 'EEE accounts must NOT include Faculty A');
    console.log('✓ Data isolation confirmed: CME HOS only sees CME data, EEE HOS only sees EEE data.');

    console.log('\n====================================');
    console.log('ALL LIVE SERVER VERIFICATIONS PASSED SUCCESSFULLY!');
    console.log('====================================\n');
}

verify().catch(err => {
    console.error('\nVerification failed:', err);
    process.exit(1);
});
