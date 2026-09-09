/**
 * Single-Branch Foundation Tests (Phase A1).
 *
 * Verifies:
 *   1. Single branch initialization (configurable name, code, academic year, semester).
 *   2. HOS belongs to the branch and can configure it.
 *   3. Faculty belongs to the branch.
 *   4. Faculty cannot modify another faculty's timetable (returns 403).
 *   5. Faculty cannot register new faculty or configure the branch (returns 403).
 *   6. No branch selector in the UI; only the single configured branch is active.
 *   7. No CME/EEE/MEC hardcoded dependency in the active workflow.
 *   8. Existing authentication and health endpoints continue to work.
 *
 * Usage: node tests/singlebranch.test.js
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, counts, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3398;
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
    console.log('TecSubstitution — Single-Branch Foundation tests\n');

    // Start instance configured as Civil Engineering (CIV)
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            FALLBACK_PORTS: '',
            BRANCH_NAME: 'Civil Engineering',
            BRANCH_CODE: 'CIV',
            ACADEMIC_YEAR: '2025-2026',
            SEMESTER: '3',
            AUTH_REQUIRED: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        await waitForServer(BASE);

        // ==============================================================
        // [1] Single-Branch Initialization & Active Branch Context
        // ==============================================================
        console.log('[1] Single-Branch Initialization');

        const branchRes = await call('GET', '/api/branch');
        check('GET /api/branch returns the configured single branch context', () => {
            assert.strictEqual(branchRes.status, 200);
            assert.ok(branchRes.body && branchRes.body.branch);
            assert.strictEqual(branchRes.body.branch.code, 'CIV');
            assert.strictEqual(branchRes.body.branch.name, 'Civil Engineering');
            assert.strictEqual(branchRes.body.branch.academicYear, '2025-2026');
            assert.strictEqual(Number(branchRes.body.branch.semester), 3);
        });

        const branchesRes = await call('GET', '/api/branches');
        check('GET /api/branches returns exactly one active branch (count = 1)', () => {
            assert.strictEqual(branchesRes.status, 200);
            assert.strictEqual(branchesRes.body.count, 1);
            assert.strictEqual(branchesRes.body.branches.length, 1);
            assert.strictEqual(branchesRes.body.branches[0].code, 'CIV');
        });

        const deptsRes = await call('GET', '/api/faculty/departments');
        check('GET /api/faculty/departments reports only this branch', () => {
            assert.strictEqual(deptsRes.status, 200);
            assert.deepStrictEqual(deptsRes.body.departments, ['CIV']);
            assert.ok(!deptsRes.body.departments.includes('CME'));
            assert.ok(!deptsRes.body.departments.includes('EEE'));
            assert.ok(!deptsRes.body.departments.includes('MEC'));
        });

        // ==============================================================
        // [2] HOS Role and Branch Management
        // ==============================================================
        console.log('\n[2] HOS Role and Branch Management');

        const hosLogin = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        check('HOS signs in and belongs to the single branch', () => {
            assert.strictEqual(hosLogin.status, 200);
            assert.strictEqual(hosLogin.body.user.role, 'hos');
            assert.strictEqual(hosLogin.body.user.department, 'CIV');
            assert.ok(hosLogin.cookie);
        });

        const adminLogin = await call('POST', '/api/auth/login', { username: 'admin', password: 'tecsub123' });
        check('Admin alias signs in as HOS/coordinator belonging to the branch', () => {
            assert.strictEqual(adminLogin.status, 200);
            assert.strictEqual(adminLogin.body.user.department, 'CIV');
        });

        const updateBranch = await call('PUT', '/api/branch', {
            name: 'Civil and Environmental Engineering',
            semester: 4
        }, hosLogin.cookie);
        check('HOS can update branch configuration', () => {
            assert.strictEqual(updateBranch.status, 200);
            assert.strictEqual(updateBranch.body.branch.name, 'Civil and Environmental Engineering');
            assert.strictEqual(Number(updateBranch.body.branch.semester), 4);
        });

        // ==============================================================
        // [3] Faculty Role and Scope Isolation
        // ==============================================================
        console.log('\n[3] Faculty Role and Timetable Ownership');

        const accounts = await call('GET', '/api/auth/accounts');
        check('accounts directory lists HOS/coordinator and branch faculty', () => {
            assert.strictEqual(accounts.status, 200);
            assert.ok(accounts.body.accounts.some(a => ['hos', 'coordinator'].includes(a.role) && a.department === 'CIV'));
        });

        // Find a faculty user in the roster
        const facultyUser = accounts.body.accounts.find(a => a.role === 'faculty');
        let facultyCookie = null;
        if (facultyUser) {
            const facLogin = await call('POST', '/api/auth/login', {
                username: facultyUser.username, password: 'tecsub123'
            });
            check('Faculty member signs in and belongs to the single branch', () => {
                assert.strictEqual(facLogin.status, 200);
                assert.strictEqual(facLogin.body.user.role, 'faculty');
                assert.strictEqual(facLogin.body.user.department, 'CIV');
            });
            facultyCookie = facLogin.cookie;

            // Faculty attempts to reconfigure branch -> 403
            const facConfigAttempt = await call('PUT', '/api/branch', { name: 'Hacked Branch' }, facultyCookie);
            check('Faculty cannot configure the branch (returns 403)', () => {
                assert.strictEqual(facConfigAttempt.status, 403);
            });

            // Faculty attempts to add faculty -> 403
            const facAddFacAttempt = await call('POST', '/api/faculty', {
                id: 'NEWFAC01', name: 'Dr. New Faculty', department: 'CIV'
            }, facultyCookie);
            check('Faculty cannot register new faculty (returns 403)', () => {
                assert.strictEqual(facAddFacAttempt.status, 403);
            });

            // Faculty attempts to add an entry for another faculty -> 403
            const facAddOtherEntry = await call('POST', '/api/timetable/entries', {
                class: 'CIV-A', day: 'Monday', period: 1, subject: 'Mechanics',
                faculty: 'Different Faculty Member', type: 'theory'
            }, facultyCookie);
            check('Faculty cannot create a timetable entry for another faculty (returns 403)', () => {
                assert.strictEqual(facAddOtherEntry.status, 403);
            });
        }

        // ==============================================================
        // [4] UI Multi-Branch Elimination & Cleanup
        // ==============================================================
        console.log('\n[4] UI Branch Isolation');

        const indexHtml = await call('GET', '/index.html');
        check('index.html contains no active multi-branch select dropdowns', () => {
            assert.strictEqual(indexHtml.status, 200);
            assert.ok(!indexHtml.raw.includes('<span>Department</span><select id="ttDept">'));
            assert.ok(!indexHtml.raw.includes('<span>Department</span><select id="availDept">'));
            assert.ok(!indexHtml.raw.includes('<span>Department</span><select id="facDept">'));
            assert.ok(!indexHtml.raw.includes('<span>Department</span><select id="manageDept">'));
            assert.ok(!indexHtml.raw.includes('placeholder="e.g. CME-A"'));
        });

        const loginHtml = await call('GET', '/login.html');
        check('login.html contains no hardcoded CME or ECE demo chips', () => {
            assert.strictEqual(loginHtml.status, 200);
            assert.ok(!loginHtml.raw.includes('CME faculty'));
            assert.ok(!loginHtml.raw.includes('ECE faculty'));
        });

        // ==============================================================
        // [5] Existing Health & Session
        // ==============================================================
        console.log('\n[5] Health & Session Integrity');

        const health = await call('GET', '/api/health');
        check('/api/health is operational', () => {
            assert.strictEqual(health.status, 200);
            assert.strictEqual(health.body.status, 'ok');
        });

        const sessionRes = await call('GET', '/api/auth/session', null, hosLogin.cookie);
        check('/api/auth/session recognizes signed-in HOS session', () => {
            assert.strictEqual(sessionRes.status, 200);
            assert.strictEqual(sessionRes.body.authenticated, true);
            assert.strictEqual(sessionRes.body.user.role, 'hos');
            assert.strictEqual(sessionRes.body.user.department, 'CIV');
        });

        console.log(`\n✅ single-branch tests: ${counts().passed} checks passed.`);
    } finally {
        server.kill();
    }
}

run().catch(err => {
    console.error('Fatal test failure:', err);
    process.exit(1);
});
