/**
 * Comprehensive Configuration & Session Persistence Test Suite
 *
 * Tests:
 * 1. SESSION_SECRET loaded from environment.
 * 2. Missing SESSION_SECRET in development generates dev warning without crash.
 * 3. Missing/short SESSION_SECRET in production fails fast with clear error without leaking secrets.
 * 4. Stable session verification across simulated restarts using fixed secret.
 * 5. Invalidation of old session when secret is rotated.
 * 6. HOD and Faculty sign-in, session survival, logout, RBAC and branch isolation.
 * 7. Security verification: no secret strings in responses or error payloads.
 */

const assert = require('assert');
const http = require('http');
const config = require('../src/config');
const session = require('../src/core/session');
const users = require('../src/data/users');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

async function run() {
    console.log('TecSubstitution — Configuration & Session Persistence Tests');

    console.log('\n[1] Configuration Validation & Environment Loading');

    check('SESSION_SECRET is exposed in config object', () => {
        assert.ok(config.sessionSecret, 'config.sessionSecret must exist');
        assert.strictEqual(typeof config.sessionSecret, 'string');
        assert.strictEqual(typeof config.sessionSecretConfigured, 'boolean');
    });

    check('Production fail-fast: throws error when SESSION_SECRET is not configured', () => {
        const prodOptions = { env: 'production', noThrow: true };
        const originalConfigured = config.sessionSecretConfigured;
        config.sessionSecretConfigured = false;
        try {
            const res = config.validateConfig(prodOptions);
            assert.strictEqual(res.valid, false);
            assert.ok(res.errors.some(e => e.includes('SESSION_SECRET is required in production')));
            assert.ok(!res.errors.some(e => e.includes(config.sessionSecret)));
        } finally {
            config.sessionSecretConfigured = originalConfigured;
        }
    });

    check('Production fail-fast: throws when SESSION_SECRET is too short in production', () => {
        const prodOptions = { env: 'production', noThrow: true };
        const originalSecret = config.sessionSecret;
        const originalConfigured = config.sessionSecretConfigured;
        config.sessionSecretConfigured = true;
        config.sessionSecret = 'short';
        try {
            const res = config.validateConfig(prodOptions);
            assert.strictEqual(res.valid, false);
            assert.ok(res.errors.some(e => e.includes('SESSION_SECRET is too short')));
        } finally {
            config.sessionSecret = originalSecret;
            config.sessionSecretConfigured = originalConfigured;
        }
    });

    check('Development mode: does not throw on missing secret but issues clear warning', () => {
        const devOptions = { env: 'development', noThrow: true };
        const originalConfigured = config.sessionSecretConfigured;
        config.sessionSecretConfigured = false;
        try {
            const res = config.validateConfig(devOptions);
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.errors.length, 0);
            assert.ok(res.warnings.some(w => w.includes('SESSION_SECRET is not set')));
        } finally {
            config.sessionSecretConfigured = originalConfigured;
        }
    });

    console.log('\n[2] Session Signing, Verification & Secret Rotation');

    const TEST_SECRET_A = 'test_session_secret_aaaa_1234567890_abcdef123456';
    const TEST_SECRET_B = 'test_session_secret_bbbb_0987654321_fedcba654321';

    const testFaculty = {
        id: 101,
        username: 'test_prof_alan',
        name: 'Dr. Alan Turing',
        role: 'faculty',
        department: 'CME',
        facultyName: 'Alan Turing'
    };

    let sessionCookieA = null;

    check('Session cookie is created and signed with Secret A', () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            sessionCookieA = session.create(testFaculty);
            assert.ok(sessionCookieA, 'Cookie token must be non-empty');
            assert.ok(sessionCookieA.includes('.'), 'Cookie token must contain signature dot');
            const verified = session.verify(sessionCookieA);
            assert.ok(verified, 'Verification with Secret A must succeed');
            assert.strictEqual(verified.username, 'test_prof_alan');
            assert.strictEqual(verified.role, 'faculty');
            assert.strictEqual(verified.department, 'CME');
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    check('Session cookie signed with Secret A survives simulated server restart with same Secret A', () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            const verifiedAfterRestart = session.verify(sessionCookieA);
            assert.ok(verifiedAfterRestart, 'Session must be valid after restart with identical secret');
            assert.strictEqual(verifiedAfterRestart.username, 'test_prof_alan');
            assert.strictEqual(verifiedAfterRestart.department, 'CME');
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    check('Session cookie signed with Secret A is rejected when Secret is changed to Secret B', () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_B;
        try {
            const verifiedWithSecretB = session.verify(sessionCookieA);
            assert.strictEqual(verifiedWithSecretB, null, 'Session must NOT be verified with rotated secret B');
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    check('Tampered payload in session cookie is immediately rejected', () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            const parts = sessionCookieA.split('.');
            const tamperedCookie = 'tamperedPayload.' + parts[1];
            assert.strictEqual(session.verify(tamperedCookie), null);
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    console.log('\n[3] HTTP Session Middleware & Restart Simulation');

    const { app } = require('../server');
    let testServer;
    let testBaseUrl;

    await new Promise((resolve) => {
        testServer = app.listen(0, () => {
            const port = testServer.address().port;
            testBaseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    function makeRequest(method, urlPath, headers = {}, body = null) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlPath, testBaseUrl);
            const req = http.request(url, {
                method,
                headers: {
                    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
                    ...headers
                }
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: parsed,
                        raw: data
                    });
                });
            });
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    let hosCookie = null;
    let facultyCookie = null;

    await checkAsync('HOS registers via /api/auth/register with valid policy and receives session cookie', async () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            const regRes = await makeRequest('POST', '/api/auth/register', {}, JSON.stringify({
                name: 'Persistence Head',
                phone: '9876543210',
                username: 'persist_hos_user',
                password: 'password_123',
                role: 'hos',
                branchName: 'Persistence Engineering',
                branchCode: 'PE_TEST',
                academicYear: '2025-2026',
                semester: 4
            }));

            assert.strictEqual(regRes.status, 201);
            const setCookie = regRes.headers['set-cookie'];
            assert.ok(setCookie && setCookie.length > 0, 'Set-Cookie header must be present');
            hosCookie = setCookie[0].split(';')[0];
            assert.ok(hosCookie.startsWith('tec_session='), 'Cookie name must be tec_session');
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    await checkAsync('HOS creates a Faculty user under their branch context', async () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            const facRes = await makeRequest('POST', '/api/auth/register', { Cookie: hosCookie }, JSON.stringify({
                name: 'Dr. Persist Faculty',
                phone: '9876543211',
                username: 'persist_fac_user',
                password: 'fac_password_123',
                role: 'faculty',
                subjects: ['PE101']
            }));

            assert.strictEqual(facRes.status, 201);
            assert.strictEqual(facRes.body.user.role, 'faculty');
            assert.strictEqual(facRes.body.user.department, 'PE_TEST');
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    await checkAsync('Faculty logs in via /api/auth/login and receives session cookie', async () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            const loginRes = await makeRequest('POST', '/api/auth/login', {}, JSON.stringify({
                username: 'persist_fac_user',
                password: 'fac_password_123'
            }));

            assert.strictEqual(loginRes.status, 200);
            assert.strictEqual(loginRes.body.authenticated, true);
            const setCookie = loginRes.headers['set-cookie'];
            assert.ok(setCookie && setCookie.length > 0);
            facultyCookie = setCookie[0].split(';')[0];
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    await checkAsync('HOS and Faculty sessions survive simulated server restart with SAME secret', async () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            // Check HOS session
            const hosRes = await makeRequest('GET', '/api/auth/session', { Cookie: hosCookie });
            assert.strictEqual(hosRes.status, 200);
            assert.strictEqual(hosRes.body.authenticated, true);
            assert.strictEqual(hosRes.body.user.username, 'persist_hos_user');
            assert.strictEqual(hosRes.body.user.role, 'hos');

            // Check Faculty session
            const facRes = await makeRequest('GET', '/api/auth/session', { Cookie: facultyCookie });
            assert.strictEqual(facRes.status, 200);
            assert.strictEqual(facRes.body.authenticated, true);
            assert.strictEqual(facRes.body.user.username, 'persist_fac_user');
            assert.strictEqual(facRes.body.user.role, 'faculty');
            assert.strictEqual(facRes.body.user.department, 'PE_TEST');
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    await checkAsync('Rotated secret B invalidates both HOS and Faculty sessions', async () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_B;
        try {
            const hosRes = await makeRequest('GET', '/api/auth/session', { Cookie: hosCookie });
            assert.strictEqual(hosRes.status, 200);
            assert.strictEqual(hosRes.body.authenticated, false);

            const facRes = await makeRequest('GET', '/api/auth/session', { Cookie: facultyCookie });
            assert.strictEqual(facRes.status, 200);
            assert.strictEqual(facRes.body.authenticated, false);
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    await checkAsync('Logout clears session cookie', async () => {
        const originalSecret = config.sessionSecret;
        config.sessionSecret = TEST_SECRET_A;
        try {
            const res = await makeRequest('POST', '/api/auth/logout', { Cookie: hosCookie });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.authenticated, false);
            const setCookie = res.headers['set-cookie'];
            assert.ok(setCookie && setCookie.length > 0);
            assert.ok(setCookie[0].includes('Max-Age=0'));
        } finally {
            config.sessionSecret = originalSecret;
        }
    });

    console.log('\n[4] Security & Credential Isolation');

    await checkAsync('/api/storage never exposes database credentials or full connection string', async () => {
        const res = await makeRequest('GET', '/api/storage');
        assert.strictEqual(res.status, 200);
        const str = JSON.stringify(res.body);
        assert.strictEqual(str.includes('password'), false, 'Response must not contain password field');
        assert.strictEqual(str.includes('postgresql://'), false, 'Response must not contain full connection URI');
    });

    await checkAsync('No secrets leaked in /api/health or error endpoints', async () => {
        const healthRes = await makeRequest('GET', '/api/health');
        assert.strictEqual(healthRes.status, 200);
        assert.strictEqual(JSON.stringify(healthRes.body).includes(config.sessionSecret), false);

        const errorRes = await makeRequest('GET', '/api/unknown-endpoint');
        assert.strictEqual(errorRes.status, 404);
        assert.strictEqual(JSON.stringify(errorRes.body).includes(config.sessionSecret), false);
    });

    await new Promise((resolve) => testServer.close(resolve));

    console.log('\n' + '='.repeat(60));
    console.log(`Test Results: ${passed} passed, ${failed} failed.`);
    console.log('='.repeat(60));

    if (failed > 0) {
        process.exit(1);
    }
    process.exit(0);
}

run().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
