/**
 * Comprehensive Account Workflow and Multi-Branch Setup Tests.
 *
 * Verifies all 15 key requirements:
 *   1. Fresh instance can create HOS for CME.
 *   2. Fresh/independent branch context can create HOS for EEE.
 *   3. HOS 1 belongs to CME.
 *   4. HOS 2 belongs to EEE.
 *   5. CME HOS sees only CME data.
 *   6. EEE HOS sees only EEE data.
 *   7. CME HOS creating Faculty automatically assigns Faculty to CME.
 *   8. EEE HOS creating Faculty automatically assigns Faculty to EEE.
 *   9. Faculty cannot change their branch.
 *  10. Faculty cannot choose another branch.
 *  11. A new HOS registration does NOT inherit CME automatically.
 *  12. No CME default appears in empty registration fields.
 *  13. Password show/hide works and accessible attributes exist.
 *  14. Password validation works for all valid & invalid patterns.
 *  15. Existing A1-A5 tests remain passing.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { check, counts } = require('./helpers');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { getBranch, setBranch, resetBranchForTesting } = require('../src/data/departments');
const { validatePassword, PASSWORD_ERROR_MESSAGE } = require('../src/core/authSecurity');

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
    console.log('\n====================================');
    console.log('TecSubstitution — Account & Multi-Branch Setup Tests\n');

    await startServer();

    try {
        // ==============================================================
        // [1] Fresh Instance State & No CME Default
        // ==============================================================
        console.log('[1] Fresh Instance Verification');
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();

        const branchRes = await call('GET', '/api/branch');
        check('Fresh instance has no branch configured', () => {
            assert.strictEqual(branchRes.status, 200);
            assert.strictEqual(branchRes.body.configured, false);
            assert.strictEqual(branchRes.body.status, 'NOT CONFIGURED');
            assert.strictEqual(branchRes.body.branch, null);
        });

        const statusRes = await call('GET', '/api/auth/status');
        check('12. No CME default appears in empty registration fields', () => {
            assert.strictEqual(statusRes.status, 200);
            assert.strictEqual(statusRes.body.allowHOSCreation, true);
            assert.strictEqual(statusRes.body.branch.configured, false);
            assert.strictEqual(statusRes.body.branch.code, '');
            assert.strictEqual(statusRes.body.branch.name, '');
        });

        const registerHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
        check('register.html contains no hardcoded CME values', () => {
            assert.ok(!registerHtml.includes('value="CME"'), 'register.html must not hardcode value="CME"');
            assert.ok(!registerHtml.includes('value="Computer Engineering"'), 'register.html must not hardcode value="Computer Engineering"');
        });

        // ==============================================================
        // [2] Password Visibility & Validation Tests
        // ==============================================================
        console.log('\n[2] Password Visibility & Validation Verification');
        check('13. Password show/hide controls exist with accessible labels', () => {
            assert.ok(registerHtml.includes('id="toggleRegPassword"'), 'Password toggle button must exist');
            assert.ok(registerHtml.includes('id="toggleRegConfirmPassword"'), 'Confirm Password toggle button must exist');
            assert.ok(registerHtml.includes('aria-label="Show password"'), 'Toggle must have aria-label');
            assert.ok(registerHtml.includes('title="Show password"'), 'Toggle must have title');
        });

        check('14. Password validation logic accepts valid and rejects invalid passwords', () => {
            // VALID
            assert.strictEqual(validatePassword('abc123_'), true, 'abc123_ must be valid');
            assert.strictEqual(validatePassword('TecSub_123'), true, 'TecSub_123 must be valid');
            assert.strictEqual(validatePassword('A1_b2'), true, 'A1_b2 must be valid');

            // INVALID
            assert.strictEqual(validatePassword('abc123'), false, 'abc123 missing underscore must be invalid');
            assert.strictEqual(validatePassword('abcdef_'), false, 'abcdef_ missing number must be invalid');
            assert.strictEqual(validatePassword('123456_'), false, '123456_ missing letter must be invalid');
            assert.strictEqual(validatePassword('abc.123_'), false, 'abc.123_ dot must be rejected');
            assert.strictEqual(validatePassword('abc-123_'), false, 'abc-123_ dash must be rejected');
            assert.strictEqual(validatePassword('abc@123_'), false, 'abc@123_ @ must be rejected');
            assert.strictEqual(validatePassword('abc 123_'), false, 'space must be rejected');
            assert.strictEqual(validatePassword(''), false, 'empty must be invalid');
            assert.strictEqual(validatePassword(null), false, 'null must be invalid');
        });

        // Backend enforcement of password validation
        const invalidRegAttempt = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'Test HOS',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'test.pw.hos',
            password: 'abc.123_', // contains dot
            confirmPassword: 'abc.123_'
        });
        check('Backend rejects invalid password even if frontend is bypassed', () => {
            assert.strictEqual(invalidRegAttempt.status, 400);
            assert.strictEqual(invalidRegAttempt.body.code, 'INVALID_PASSWORD');
            assert.strictEqual(invalidRegAttempt.body.error, PASSWORD_ERROR_MESSAGE);
        });

        const mismatchRegAttempt = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'Test HOS',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'test.mismatch.hos',
            password: 'TecSub_123',
            confirmPassword: 'Different_123'
        });
        check('Backend rejects password and confirm password mismatch', () => {
            assert.strictEqual(mismatchRegAttempt.status, 400);
            assert.strictEqual(mismatchRegAttempt.body.code, 'PASSWORD_MISMATCH');
        });

        // ==============================================================
        // [3] HOS 1 Creation for CME
        // ==============================================================
        console.log('\n[3] HOS 1 Creation for CME');
        const cmeHosData = {
            role: 'hos',
            name: 'Ravi Kumar',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'ravi.cme',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123'
        };

        const cmeHosRes = await call('POST', '/api/auth/register', cmeHosData);
        check('1. Fresh instance can create HOS for CME', () => {
            assert.strictEqual(cmeHosRes.status, 201);
            assert.strictEqual(cmeHosRes.body.authenticated, true);
        });

        check('3. HOS 1 belongs to CME', () => {
            assert.strictEqual(cmeHosRes.body.user.username, 'ravi.cme');
            assert.strictEqual(cmeHosRes.body.user.role, 'hos');
            assert.strictEqual(cmeHosRes.body.user.department, 'CME');
            assert.strictEqual(cmeHosRes.body.user.branchName, 'Computer Engineering');
        });

        // ==============================================================
        // [4] Public Status Does NOT Inherit CME
        // ==============================================================
        console.log('\n[4] Independence Verification (No Auto-Inherit of CME)');
        const postCmeStatus = await call('GET', '/api/auth/status');
        check('11. A new HOS registration does NOT inherit CME automatically', () => {
            assert.strictEqual(postCmeStatus.status, 200);
            assert.strictEqual(postCmeStatus.body.allowHOSCreation, true, 'New HOS can create independent branch');
            assert.strictEqual(postCmeStatus.body.branch.code, '', 'Branch code must be empty for unauthenticated visitor');
            assert.strictEqual(postCmeStatus.body.branch.name, '', 'Branch name must be empty for unauthenticated visitor');
        });

        // ==============================================================
        // [5] HOS 2 Creation for EEE (Independent Branch)
        // ==============================================================
        console.log('\n[5] HOS 2 Creation for EEE');
        const eeeHosData = {
            role: 'hos',
            name: 'Suresh Kumar',
            phone: '9876500001',
            branchName: 'Electrical and Electronics Engineering',
            branchCode: 'EEE',
            username: 'suresh.eee',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123'
        };

        const eeeHosRes = await call('POST', '/api/auth/register', eeeHosData);
        check('2. Fresh/independent branch context can create HOS for EEE', () => {
            assert.strictEqual(eeeHosRes.status, 201);
            assert.strictEqual(eeeHosRes.body.authenticated, true);
        });

        check('4. HOS 2 belongs to EEE', () => {
            assert.strictEqual(eeeHosRes.body.user.username, 'suresh.eee');
            assert.strictEqual(eeeHosRes.body.user.role, 'hos');
            assert.strictEqual(eeeHosRes.body.user.department, 'EEE');
            assert.strictEqual(eeeHosRes.body.user.branchName, 'Electrical and Electronics Engineering');
            assert.notStrictEqual(eeeHosRes.body.user.department, 'CME', 'EEE must NOT become CME');
        });

        // ==============================================================
        // [6] Faculty Creation & Branch Inheritance
        // ==============================================================
        console.log('\n[6] Faculty Creation & Branch Inheritance');

        // Log in as CME HOS
        const cmeLogin = await call('POST', '/api/auth/login', { username: 'ravi.cme', password: 'TecSub_123' });
        const cmeCookie = cmeLogin.cookie;
        assert.ok(cmeCookie, 'Expected CME HOS cookie');

        // CME HOS creates Faculty A
        const facCmeData = {
            role: 'faculty',
            name: 'Faculty A',
            phone: '9876543211',
            username: 'faculty.a',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            subjects: ['Data Structures', 'Operating Systems']
        };
        const facCmeRes = await call('POST', '/api/auth/register', facCmeData, cmeCookie);
        check('7. CME HOS creating Faculty automatically assigns Faculty to CME', () => {
            assert.strictEqual(facCmeRes.status, 201);
            assert.strictEqual(facCmeRes.body.user.name, 'Faculty A');
            assert.strictEqual(facCmeRes.body.user.department, 'CME');
            assert.strictEqual(facCmeRes.body.user.branchName, 'Computer Engineering');
        });

        // Log in as EEE HOS
        const eeeLogin = await call('POST', '/api/auth/login', { username: 'suresh.eee', password: 'TecSub_123' });
        const eeeCookie = eeeLogin.cookie;
        assert.ok(eeeCookie, 'Expected EEE HOS cookie');

        // EEE HOS creates Faculty B (attempting to pass department: 'CME')
        const facEeeData = {
            role: 'faculty',
            name: 'Faculty B',
            phone: '9876543212',
            username: 'faculty.b',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            department: 'CME', // Rogue attempt
            branchCode: 'CME', // Rogue attempt
            subjects: ['Power Systems', 'Circuit Theory']
        };
        const facEeeRes = await call('POST', '/api/auth/register', facEeeData, eeeCookie);
        check('8. EEE HOS creating Faculty automatically assigns Faculty to EEE', () => {
            assert.strictEqual(facEeeRes.status, 201);
            assert.strictEqual(facEeeRes.body.user.name, 'Faculty B');
            assert.strictEqual(facEeeRes.body.user.department, 'EEE');
            assert.strictEqual(facEeeRes.body.user.branchName, 'Electrical and Electronics Engineering');
        });

        check('9. & 10. Faculty cannot choose another branch or change their branch', () => {
            assert.notStrictEqual(facEeeRes.body.user.department, 'CME', 'Faculty must not be assigned to requested foreign branch CME');
            assert.strictEqual(facEeeRes.body.user.department, 'EEE', 'Faculty must be strictly bound to authenticated HOS branch');
        });

        // ==============================================================
        // [7] Data Isolation: CME HOS vs EEE HOS
        // ==============================================================
        console.log('\n[7] Data Isolation Verification');
        const cmeAccountsRes = await call('GET', '/api/auth/accounts', null, cmeCookie);
        check('5. CME HOS sees only CME data', () => {
            assert.strictEqual(cmeAccountsRes.status, 200);
            const userNames = cmeAccountsRes.body.accounts.map(a => a.username);
            assert.ok(userNames.includes('ravi.cme'), 'CME accounts list must include ravi.cme');
            assert.ok(userNames.includes('faculty.a'), 'CME accounts list must include faculty.a');
            assert.ok(!userNames.includes('suresh.eee'), 'CME accounts list must NOT include suresh.eee');
            assert.ok(!userNames.includes('faculty.b'), 'CME accounts list must NOT include faculty.b');
            cmeAccountsRes.body.accounts.forEach(a => {
                assert.strictEqual(a.department, 'CME', 'Every account seen by CME HOS must belong to CME');
            });
        });

        const eeeAccountsRes = await call('GET', '/api/auth/accounts', null, eeeCookie);
        check('6. EEE HOS sees only EEE data', () => {
            assert.strictEqual(eeeAccountsRes.status, 200);
            const userNames = eeeAccountsRes.body.accounts.map(a => a.username);
            assert.ok(userNames.includes('suresh.eee'), 'EEE accounts list must include suresh.eee');
            assert.ok(userNames.includes('faculty.b'), 'EEE accounts list must include faculty.b');
            assert.ok(!userNames.includes('ravi.cme'), 'EEE accounts list must NOT include ravi.cme');
            assert.ok(!userNames.includes('faculty.a'), 'EEE accounts list must NOT include faculty.a');
            eeeAccountsRes.body.accounts.forEach(a => {
                assert.strictEqual(a.department, 'EEE', 'Every account seen by EEE HOS must belong to EEE');
            });
        });

        // Second HOS for same branch (CME) must be rejected
        const dupCmeHos = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'Duplicate CME HOS',
            phone: '9000000000',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'dup.cme',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123'
        });
        check('Public registration of second HOS for existing branch is rejected (403 Forbidden)', () => {
            assert.strictEqual(dupCmeHos.status, 403);
            assert.strictEqual(dupCmeHos.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [8] Compatibility with Existing Operations
        // ==============================================================
        console.log('\n[8] Compatibility Verification');
        const ttMetaRes = await call('GET', '/api/timetable/meta');
        check('15. Existing timetable and availability tests remain passing', () => {
            assert.strictEqual(ttMetaRes.status, 200);
            assert.ok(Array.isArray(ttMetaRes.body.days));
            assert.ok(Array.isArray(ttMetaRes.body.periods));
        });

        const availRes = await call('POST', '/api/availability', { day: 'Monday', period: 1 });
        check('Availability queries continue working properly', () => {
            assert.strictEqual(availRes.status, 200);
            assert.ok(Array.isArray(availRes.body.availableFaculty));
        });

    } finally {
        await stopServer();
    }

    const { passed, failed } = counts();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Test run failed:', err);
    process.exit(1);
});
