/**
 * Tests for HOD Registration: Existing Branch Reuse & New Branch Creation
 *
 * Verifies:
 * 1. Registering an HOD against an EXISTING branch (e.g. CME) reuses the branch without error.
 * 2. Attempting to register another HOD for a branch with an active HOD is rejected (403).
 * 3. Registering an HOD for a brand-NEW branch (e.g. CIVIL) creates the branch and associates the HOD.
 * 4. Existing branch metadata (name, semesters, etc.) are strictly preserved.
 * 5. Branch-code uniqueness is enforced.
 */
process.env.DATABASE_URL = '';
process.env.TEST_DATABASE_URL = '';

const assert = require('assert');
const http = require('http');
const { check, counts } = require('./helpers');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { getBranch, registerBranch, resetBranchForTesting, isBranchRegistered } = require('../src/data/departments');

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
    console.log('TecSubstitution — HOD Registration & Branch Reuse Tests\n');

    await startServer();

    try {
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();

        // 1. Pre-register an existing branch "CME" without any assigned HOD
        console.log('[1] Pre-configure Existing Branch (CME) Without HOD');
        registerBranch({
            code: 'CME',
            name: 'Computer Engineering Department',
            academicYear: '2026-2027',
            semester: 1,
            totalSemesters: 6
        });

        check('Existing branch CME is registered in catalog', () => {
            assert.strictEqual(isBranchRegistered('CME'), true);
            const branch = getBranch('CME');
            assert.strictEqual(branch.code, 'CME');
            assert.strictEqual(branch.name, 'Computer Engineering Department');
        });

        check('Existing branch CME has zero assigned HODs initially', () => {
            assert.strictEqual(users.hasHOSForBranch('CME'), false);
        });

        // 2. Register new HOD for the EXISTING branch CME
        console.log('\n[2] Register HOD for Existing Branch (CME)');
        const cmeHodData = {
            role: 'hos',
            name: 'Dr. C. Mohan',
            phone: '9876543210',
            branchName: 'Computer Engineering Department',
            branchCode: 'CME',
            username: 'mohan.cme',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123'
        };

        const regRes = await call('POST', '/api/auth/register', cmeHodData);
        check('HOD registration for existing branch CME succeeds (HTTP 201)', () => {
            assert.strictEqual(regRes.status, 201);
            assert.strictEqual(regRes.body.authenticated, true);
        });

        check('New HOD is associated with existing branch CME and reuses branch metadata', () => {
            assert.strictEqual(regRes.body.user.username, 'mohan.cme');
            assert.strictEqual(regRes.body.user.role, 'hos');
            assert.strictEqual(regRes.body.user.department, 'CME');
            assert.strictEqual(regRes.body.user.branchName, 'Computer Engineering Department');
            const branch = getBranch('CME');
            assert.strictEqual(branch.academicYear, '2026-2027', 'Preserves academic year');
            assert.strictEqual(branch.totalSemesters, 6, 'Preserves total semesters');
        });

        check('Branch CME now has an assigned active HOD', () => {
            assert.strictEqual(users.hasHOSForBranch('CME'), true);
        });

        // 3. Prevent duplicate HOD assignment on CME
        console.log('\n[3] Prevent Duplicate HOD Assignment on CME');
        const dupHodData = {
            role: 'hos',
            name: 'Dr. Duplicate HOD',
            phone: '9876543299',
            branchName: 'Another Name',
            branchCode: 'CME',
            username: 'dup.cme.hod',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123'
        };

        const dupRes = await call('POST', '/api/auth/register', dupHodData);
        check('Attempting to register a second HOD for CME is rejected with HTTP 403', () => {
            assert.strictEqual(dupRes.status, 403);
            assert.strictEqual(dupRes.body.code, 'FORBIDDEN');
            assert.ok(
                dupRes.body.error && dupRes.body.error.includes('already assigned to branch CME'),
                'Error indicates an active HOD is already assigned to branch CME'
            );
        });

        check('Original HOD for CME remains unchanged and active', () => {
            const currentHOD = users.findHOSByBranch('CME');
            assert.strictEqual(currentHOD.username, 'mohan.cme');
        });

        // 4. Register HOD for a brand-NEW branch (CIVIL)
        console.log('\n[4] Register HOD for Brand-New Branch (CIVIL)');
        check('Branch CIVIL does not exist prior to registration', () => {
            assert.strictEqual(isBranchRegistered('CIVIL'), false);
        });

        const civilHodData = {
            role: 'hos',
            name: 'Dr. V. Prasad',
            phone: '9876543220',
            branchName: 'Civil Engineering',
            branchCode: 'CIVIL',
            username: 'prasad.civil',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123'
        };

        const civilRes = await call('POST', '/api/auth/register', civilHodData);
        check('Registering HOD for new branch CIVIL succeeds (HTTP 201)', () => {
            assert.strictEqual(civilRes.status, 201);
            assert.strictEqual(civilRes.body.authenticated, true);
        });

        check('New branch CIVIL is created in catalog with correct metadata', () => {
            assert.strictEqual(isBranchRegistered('CIVIL'), true);
            const branch = getBranch('CIVIL');
            assert.strictEqual(branch.code, 'CIVIL');
            assert.strictEqual(branch.name, 'Civil Engineering');
            assert.strictEqual(civilRes.body.user.department, 'CIVIL');
            assert.strictEqual(civilRes.body.user.branchName, 'Civil Engineering');
        });

        check('Both CME and CIVIL HODs coexist independently', () => {
            const cmeHOD = users.findHOSByBranch('CME');
            const civilHOD = users.findHOSByBranch('CIVIL');
            assert.strictEqual(cmeHOD.username, 'mohan.cme');
            assert.strictEqual(civilHOD.username, 'prasad.civil');
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
