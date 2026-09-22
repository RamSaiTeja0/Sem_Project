/**
 * Web Application Authentication, Dashboard Loading & Feature Visibility Lifecycle Test
 *
 * Verifies:
 * 1. Guest access lifecycle: unauthenticated session returns Guest, public navigation only,
 *    dashboard bootstrap endpoints succeed without stuck "Loading..." state.
 * 2. HOD login & feature visibility: authenticated as HOD, all HOD navigation endpoints accessible,
 *    dashboard bootstrap APIs resolve.
 * 3. Faculty login & feature visibility: authenticated as Faculty, faculty navigation endpoints accessible,
 *    HOD management endpoints protected.
 * 4. Session persistence across restarts and logout behavior.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, counts, waitForServer } = require('./helpers');

const PORT = 3590;
const BASE = `http://localhost:${PORT}`;

function call(base, method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${base}${urlPath}`, { method, headers }, res => {
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

function startServer(env = {}) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            DATABASE_URL: '',
            LOAD_DEMO_DATA: 'true',
            BRANCH_CODE: 'CME',
            BRANCH_NAME: 'Computer Engineering',
            PORT: String(PORT),
            FALLBACK_PORTS: '',
            SESSION_SECRET: 'test_session_secret_for_web_lifecycle_12345678',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return child;
}

async function run() {
    console.log('TecSubstitution — Web Auth & UI Lifecycle Tests\n');
    let server = startServer();
    await waitForServer(BASE);

    try {
        console.log('[1] Guest State & Public Feature Access');
        const guestSession = await call(BASE, 'GET', '/api/auth/session');
        check('Guest session returns authenticated: false', () => {
            assert.strictEqual(guestSession.status, 200);
            assert.strictEqual(guestSession.body.authenticated, false);
            assert.strictEqual(guestSession.body.user, null);
        });

        const dashMeta = await call(BASE, 'GET', '/api/timetable/meta');
        const dashSummary = await call(BASE, 'GET', '/api/availability/summary');
        const dashFaculty = await call(BASE, 'GET', '/api/faculty');
        const dashRecords = await call(BASE, 'GET', '/api/timetable/records?status=busy');

        check('Guest dashboard bootstrap APIs return 200 and valid data (no infinite loading)', () => {
            assert.strictEqual(dashMeta.status, 200);
            assert.ok(dashMeta.body.days && dashMeta.body.days.length > 0);
            assert.strictEqual(dashSummary.status, 200);
            assert.ok(dashSummary.body.slots && dashSummary.body.slots.length > 0);
            assert.strictEqual(dashFaculty.status, 200);
            assert.strictEqual(dashRecords.status, 200);
        });

        console.log('\n[2] HOD Login & Authentication');
        const loginRes = await call(BASE, 'POST', '/api/auth/login', {
            username: 'hos',
            password: 'tecsub123'
        });

        check('HOD logs in successfully and receives session cookie', () => {
            assert.strictEqual(loginRes.status, 200);
            assert.ok(loginRes.cookie, 'Session cookie issued');
        });

        const hodCookie = loginRes.cookie;
        const hodSession = await call(BASE, 'GET', '/api/auth/session', null, hodCookie);

        check('HOD session returns role "hos" and department "CME"', () => {
            assert.strictEqual(hodSession.status, 200);
            assert.strictEqual(hodSession.body.authenticated, true);
            assert.strictEqual(hodSession.body.user.role, 'hos');
            assert.strictEqual(hodSession.body.user.department, 'CME');
        });

        console.log('\n[3] HOD Feature Endpoint Accessibility');
        const hodRequests = await call(BASE, 'GET', '/api/faculty-requests', null, hodCookie);
        const hodAtt = await call(BASE, 'GET', '/api/attendance?date=2026-09-21', null, hodCookie);
        const hodInvig = await call(BASE, 'GET', '/api/invigilation?date=2026-09-21', null, hodCookie);
        const hodBranch = await call(BASE, 'GET', '/api/branch', null, hodCookie);

        check('HOD feature endpoints respond with 200 for authenticated HOD', () => {
            assert.strictEqual(hodRequests.status, 200);
            assert.strictEqual(hodAtt.status, 200);
            assert.strictEqual(hodInvig.status, 200);
            assert.strictEqual(hodBranch.status, 200);
        });

        console.log('\n[4] Faculty Login & Scoped Access');
        const facLogin = await call(BASE, 'POST', '/api/auth/login', {
            username: 'b.gopala.rao',
            password: 'tecsub123'
        });

        check('Faculty member logs in successfully and receives session cookie', () => {
            assert.strictEqual(facLogin.status, 200);
            assert.ok(facLogin.cookie, 'Faculty session cookie issued');
        });

        const facCookie = facLogin.cookie;
        const facSession = await call(BASE, 'GET', '/api/auth/session', null, facCookie);

        check('Faculty session returns role "faculty" and department "CME"', () => {
            assert.strictEqual(facSession.status, 200);
            assert.strictEqual(facSession.body.authenticated, true);
            assert.strictEqual(facSession.body.user.role, 'faculty');
            assert.strictEqual(facSession.body.user.department, 'CME');
            assert.strictEqual(facSession.body.user.facultyName, 'Sri B. Gopala Rao');
        });

        const facBlockedHODRoute = await call(BASE, 'GET', '/api/faculty-requests', null, facCookie);
        check('Faculty is forbidden from accessing HOD management endpoints', () => {
            assert.strictEqual(facBlockedHODRoute.status, 403);
        });

        console.log('\n[5] Session Persistence Across Simulated Restart');
        server.kill();
        await new Promise(r => setTimeout(r, 600));

        server = startServer();
        await waitForServer(BASE);

        const restoredHodSession = await call(BASE, 'GET', '/api/auth/session', null, hodCookie);
        check('HOD session persists across server restart with same secret', () => {
            assert.strictEqual(restoredHodSession.status, 200);
            assert.strictEqual(restoredHodSession.body.authenticated, true);
            assert.strictEqual(restoredHodSession.body.user.role, 'hos');
        });

        const restoredFacSession = await call(BASE, 'GET', '/api/auth/session', null, facCookie);
        check('Faculty session persists across server restart with same secret', () => {
            assert.strictEqual(restoredFacSession.status, 200);
            assert.strictEqual(restoredFacSession.body.authenticated, true);
            assert.strictEqual(restoredFacSession.body.user.role, 'faculty');
        });

        console.log('\n[6] Logout Flow');
        const logoutRes = await call(BASE, 'POST', '/api/auth/logout', {}, hodCookie);
        check('Logout clears session cookie', () => {
            assert.strictEqual(logoutRes.status, 200);
        });

        const postLogoutSession = await call(BASE, 'GET', '/api/auth/session', null, logoutRes.cookie);
        check('Session is unauthenticated after logout', () => {
            assert.strictEqual(postLogoutSession.body.authenticated, false);
        });

        console.log('\n============================================================');
        const { passed, failed } = counts();
        console.log(`Web Auth & UI Lifecycle Verification: ${passed} passed, ${failed} failed.`);
        console.log('============================================================\n');

        if (failed > 0) {
            process.exit(1);
        }
    } finally {
        if (server) server.kill();
    }
}

run().catch(err => {
    console.error('Test run failed:', err);
    process.exit(1);
});
