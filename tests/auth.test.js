/**
 * Authentication tests.
 *
 * Two servers are started: one in the default configuration (sign-in optional,
 * exactly as every other suite sees it) and one with AUTH_REQUIRED=true, so the
 * guard is proved to actually turn anonymous callers away.
 *
 * Usage: node tests/auth.test.js
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, counts, request, waitForServer } = require('./helpers');

const OPEN_PORT = process.env.TEST_PORT || 3394;
const LOCKED_PORT = Number(OPEN_PORT) + 1;
const OPEN = `http://localhost:${OPEN_PORT}`;
const LOCKED = `http://localhost:${LOCKED_PORT}`;

/** Like helpers.request, but keeps the Set-Cookie header and can send one. */
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
                    location: res.headers.location || null,
                    cookie: setCookie ? setCookie.split(';')[0] : null
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function startServer(port, env) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(port), FALLBACK_PORTS: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    return child;
}

async function run() {
    console.log('TecSubstitution — authentication tests');

    // ------------------------------------------------ default: sign-in optional
    console.log('\n[1] Default configuration — sign-in optional');

    const anonSession = await call(OPEN, 'GET', '/api/auth/session');
    check('an anonymous visitor has no session and is not forced to sign in', () => {
        assert.strictEqual(anonSession.status, 200);
        assert.strictEqual(anonSession.body.authenticated, false);
        assert.strictEqual(anonSession.body.authRequired, false);
        assert.strictEqual(anonSession.body.user, null);
    });

    const openTimetable = await call(OPEN, 'GET', '/api/timetable');
    check('the demo timetable stays browsable without signing in', () => {
        assert.strictEqual(openTimetable.status, 200);
        assert.strictEqual(openTimetable.body.cells.length, 35);
    });

    const accounts = await call(OPEN, 'GET', '/api/auth/accounts');
    check('the demo account directory lists the coordinator and the faculty', () => {
        assert.strictEqual(accounts.status, 200);
        const names = accounts.body.accounts.map(a => a.username);
        assert.ok(names.includes('admin'), 'the coordinator account must exist');
        assert.strictEqual(accounts.body.accounts.length, 13, '1 coordinator + 12 faculty');
        // A password must never be attached to an account record.
        accounts.body.accounts.forEach(a =>
            assert.strictEqual(a.password, undefined, 'accounts must not carry passwords'));
    });

    const badPassword = await call(OPEN, 'POST', '/api/auth/login', { username: 'admin', password: 'nope' });
    check('a wrong password is rejected with 401 and no cookie', () => {
        assert.strictEqual(badPassword.status, 401);
        assert.strictEqual(badPassword.body.code, 'INVALID_CREDENTIALS');
        assert.strictEqual(badPassword.cookie, null);
    });

    const unknownUser = await call(OPEN, 'POST', '/api/auth/login', { username: 'nobody', password: 'tecsub123' });
    check('an unknown username gets the same message, revealing nothing', () => {
        assert.strictEqual(unknownUser.status, 401);
        assert.strictEqual(unknownUser.body.error, badPassword.body.error);
    });

    const missing = await call(OPEN, 'POST', '/api/auth/login', { username: 'admin' });
    check('a missing password is a 400, not a 500', () => {
        assert.strictEqual(missing.status, 400);
        assert.strictEqual(missing.body.code, 'MISSING_CREDENTIALS');
    });

    const good = await call(OPEN, 'POST', '/api/auth/login', { username: 'admin', password: 'tecsub123' });
    check('a correct sign-in returns the user and sets an HttpOnly cookie', () => {
        assert.strictEqual(good.status, 200);
        assert.strictEqual(good.body.authenticated, true);
        assert.strictEqual(good.body.user.username, 'admin');
        assert.strictEqual(good.body.user.role, 'coordinator');
        assert.ok(good.cookie && good.cookie.startsWith('tec_session='), 'a session cookie must be set');
    });

    const cookie = good.cookie;
    const withCookie = await call(OPEN, 'GET', '/api/auth/session', null, cookie);
    check('the session cookie identifies the user on the next request', () => {
        assert.strictEqual(withCookie.body.authenticated, true);
        assert.strictEqual(withCookie.body.user.name, 'Timetable Coordinator');
    });

    const tampered = await call(OPEN, 'GET', '/api/auth/session', null,
        cookie.slice(0, -3) + 'aaa');
    check('a tampered cookie reads back as not signed in', () => {
        assert.strictEqual(tampered.body.authenticated, false);
        assert.strictEqual(tampered.body.user, null);
    });

    const facultyLogin = await call(OPEN, 'POST', '/api/auth/login',
        { username: 'arjun.rao', password: 'tecsub123' });
    check('a faculty account signs in and carries its own faculty name', () => {
        assert.strictEqual(facultyLogin.status, 200);
        assert.strictEqual(facultyLogin.body.user.role, 'faculty');
        assert.strictEqual(facultyLogin.body.user.facultyName, 'Dr. Arjun Rao');
        assert.strictEqual(facultyLogin.body.user.department, 'CSE');
    });

    const loggedOut = await call(OPEN, 'POST', '/api/auth/logout', {}, cookie);
    check('logging out clears the cookie', () => {
        assert.strictEqual(loggedOut.status, 200);
        assert.strictEqual(loggedOut.body.authenticated, false);
        assert.ok(/tec_session=/.test(loggedOut.cookie), 'the cookie is overwritten');
    });

    // -------------------------------------------------- AUTH_REQUIRED=true
    console.log('\n[2] AUTH_REQUIRED=true — the guard turns anonymous callers away');

    const anonApi = await call(LOCKED, 'GET', '/api/timetable');
    check('an anonymous API call is 401 JSON, never dashboard HTML', () => {
        assert.strictEqual(anonApi.status, 401);
        assert.strictEqual(anonApi.body.code, 'UNAUTHENTICATED');
    });

    const anonPage = await call(LOCKED, 'GET', '/dashboard');
    check('an anonymous page request is redirected to /login', () => {
        assert.strictEqual(anonPage.status, 302);
        assert.match(anonPage.location, /^\/login\?next=/);
    });

    const publicPages = await Promise.all([
        call(LOCKED, 'GET', '/'),
        call(LOCKED, 'GET', '/login'),
        call(LOCKED, 'GET', '/api/health')
    ]);
    check('the landing page, sign-in page and health check stay public', () => {
        publicPages.forEach(res => assert.strictEqual(res.status, 200));
        assert.strictEqual(publicPages[2].body.authRequired, true);
    });

    const lockedLogin = await call(LOCKED, 'POST', '/api/auth/login',
        { username: 'arjun.rao', password: 'tecsub123' });
    check('signing in works while the guard is on', () => {
        assert.strictEqual(lockedLogin.status, 200);
        assert.ok(lockedLogin.cookie);
    });

    const afterLogin = await call(LOCKED, 'GET', '/api/timetable', null, lockedLogin.cookie);
    check('the same API call succeeds once signed in', () => {
        assert.strictEqual(afterLogin.status, 200);
        assert.strictEqual(afterLogin.body.cells.length, 35);
    });

    const pageAfterLogin = await call(LOCKED, 'GET', '/dashboard', null, lockedLogin.cookie);
    check('the dashboard page is served once signed in', () => {
        assert.strictEqual(pageAfterLogin.status, 200);
        assert.match(pageAfterLogin.raw, /id="view-availability"/);
    });

    const { passed } = counts();
    console.log(`\n✅ auth: ${passed} checks passed.`);
}

const openServer = startServer(OPEN_PORT, { AUTH_REQUIRED: 'false' });
const lockedServer = startServer(LOCKED_PORT, { AUTH_REQUIRED: 'true' });

function stop() {
    openServer.kill();
    lockedServer.kill();
}

Promise.all([waitForServer(OPEN), waitForServer(LOCKED)])
    .then(run)
    .then(stop)
    .catch(err => {
        console.error('\n✗ FAILED:', err.message);
        stop();
        process.exit(1);
    });
