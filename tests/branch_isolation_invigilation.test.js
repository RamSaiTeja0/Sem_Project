/**
 * Part 3 — Branch Isolation Invigilation Test Suite (Database & In-Memory)
 * Enforces strict branch isolation and complete Faculty -> HOD invigilation request workflow.
 */
const { initTestDb } = require('./testDbGuard');
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const facultyRequests = require('../src/data/facultyRequests');
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
    console.log('================================================================');
    console.log('Branch Isolation Invigilation Workflow Test (TEST_DATABASE_URL)');
    console.log('================================================================\n');

    await initTestDb();
    await startServer();

    try {
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();
        attendance.resetForTesting();
        invigilation.resetForTesting();
        facultyRequests.resetForTesting();

        if (db.isConfigured()) {
            await db.query(`
                DELETE FROM exam_invigilation WHERE branch_code IN ('CME', 'EEE');
                DELETE FROM faculty_registration_requests WHERE branch_code IN ('CME', 'EEE');
                DELETE FROM faculty_subjects WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ('CME_FAC_A', 'EEE_FAC_B') OR name IN ('Lohith CME', 'Farhan EEE'));
                DELETE FROM users WHERE username IN ('hod_cme_test', 'hod_eee_test', 'fac_cme_test', 'fac_eee_test', 'lohith.cme', 'farhan.eee');
                DELETE FROM timetable WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ('CME_FAC_A', 'EEE_FAC_B') OR name IN ('Lohith CME', 'Farhan EEE'));
                DELETE FROM faculty WHERE code IN ('CME_FAC_A', 'EEE_FAC_B') OR name IN ('Lohith CME', 'Farhan EEE');
                DELETE FROM departments WHERE code IN ('CME', 'EEE');
            `);
        }

        const testDate = '2026-10-15';

        console.log('1. Registering HODs for Branch A (CME) and Branch B (EEE)...');
        const hodARes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'HOD Branch A',
            phone: '9876543201',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'hod_cme_test',
            password: 'Password_123'
        });
        assert.strictEqual(hodARes.status, 201, 'HOD A registration should succeed');
        const cookieHodA = hodARes.cookie;

        const hodBRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'HOD Branch B',
            phone: '9876543202',
            branchName: 'Electrical Engineering',
            branchCode: 'EEE',
            username: 'hod_eee_test',
            password: 'Password_123'
        });
        assert.strictEqual(hodBRes.status, 201, 'HOD B registration should succeed');
        const cookieHodB = hodBRes.cookie;

        console.log('2. Registering Faculty in Branch A (Lohith) and Branch B (Farhan)...');
        const facARes = await call('POST', '/api/auth/register', {
            name: 'Lohith CME',
            phone: '9123456701',
            username: 'lohith.cme',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Algorithms']
        }, cookieHodA);
        assert.strictEqual(facARes.status, 201, 'Faculty A registration should succeed');

        // Login as Faculty A
        const loginARes = await call('POST', '/api/auth/login', {
            username: 'lohith.cme',
            password: 'Password_123'
        });
        assert.strictEqual(loginARes.status, 200, 'Faculty A login should succeed');
        const cookieFacA = loginARes.cookie;

        const facBRes = await call('POST', '/api/auth/register', {
            name: 'Farhan EEE',
            phone: '9123456702',
            username: 'farhan.eee',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Power Systems']
        }, cookieHodB);
        assert.strictEqual(facBRes.status, 201, 'Faculty B registration should succeed');

        // Login as Faculty B
        const loginBRes = await call('POST', '/api/auth/login', {
            username: 'farhan.eee',
            password: 'Password_123'
        });
        assert.strictEqual(loginBRes.status, 200, 'Faculty B login should succeed');
        const cookieFacB = loginBRes.cookie;

        console.log('3. Faculty A submits an invigilation request...');
        const reqSubmitRes = await call('POST', '/api/invigilation/requests', {
            date: testDate,
            periods: [1, 2, 3],
            reason: 'MID-TERM EXAMS'
        }, cookieFacA);
        assert.strictEqual(reqSubmitRes.status, 201, 'Invigilation request submission should return 201');
        assert.strictEqual(reqSubmitRes.body.request.status, 'PENDING', 'Request status must be PENDING');
        assert.strictEqual(reqSubmitRes.body.request.branchCode, 'CME', 'Request branch must be CME');
        const requestId = reqSubmitRes.body.request.id;

        console.log('4. Verifying Faculty A sees their own submitted request...');
        const myInvigRes = await call('GET', '/api/invigilation/my', null, cookieFacA);
        assert.strictEqual(myInvigRes.status, 200);
        const myRequests = myInvigRes.body.requests || [];
        const foundSelf = myRequests.find(r => String(r.id) === String(requestId));
        assert.ok(foundSelf, 'Faculty A must see their own submitted request in /api/invigilation/my');
        assert.strictEqual(foundSelf.status, 'PENDING');

        console.log('5. Verifying Branch A HOD (CME) sees the request...');
        const hodAListRes = await call('GET', '/api/invigilation/requests?status=PENDING', null, cookieHodA);
        assert.strictEqual(hodAListRes.status, 200);
        const hodARequests = hodAListRes.body.requests || [];
        const foundHodA = hodARequests.find(r => String(r.id) === String(requestId));
        assert.ok(foundHodA, 'Branch A HOD MUST see the request submitted by Branch A faculty');
        assert.strictEqual(foundHodA.facultyName, 'Lohith CME', 'Faculty name must be accurate');
        assert.strictEqual(foundHodA.reason, 'MID-TERM EXAMS');

        console.log('6. Verifying Branch B HOD (EEE) does NOT see the request (Branch Isolation)...');
        const hodBListRes = await call('GET', '/api/invigilation/requests?status=PENDING', null, cookieHodB);
        assert.strictEqual(hodBListRes.status, 200);
        const hodBRequests = hodBListRes.body.requests || [];
        const foundHodB = hodBRequests.find(r => String(r.id) === String(requestId));
        assert.strictEqual(foundHodB, undefined, 'Branch B HOD MUST NOT see Branch A requests');

        console.log('7. Verifying Branch B HOD cannot approve or reject Branch A request (Forbidden)...');
        const crossApproveRes = await call('POST', `/api/invigilation/requests/${requestId}/approve`, {}, cookieHodB);
        assert.strictEqual(crossApproveRes.status, 403, 'Cross-branch approval must be forbidden (403)');

        const crossRejectRes = await call('POST', `/api/invigilation/requests/${requestId}/reject`, { rejectionReason: 'Hacked' }, cookieHodB);
        assert.strictEqual(crossRejectRes.status, 403, 'Cross-branch rejection must be forbidden (403)');

        console.log('8. Branch A HOD approves the request...');
        const approveRes = await call('POST', `/api/invigilation/requests/${requestId}/approve`, {}, cookieHodA);
        assert.strictEqual(approveRes.status, 200, 'Branch A HOD approval must succeed');
        assert.strictEqual(approveRes.body.request.status, 'APPROVED');
        assert.strictEqual(approveRes.body.assignments.length, 3, 'Approval must generate 3 active assignments');

        console.log('9. Verifying Faculty A sees updated APPROVED status and active assignments...');
        const myInvigAfter = await call('GET', '/api/invigilation/my', null, cookieFacA);
        assert.strictEqual(myInvigAfter.status, 200);
        const approvedReq = (myInvigAfter.body.requests || []).find(r => String(r.id) === String(requestId));
        assert.ok(approvedReq, 'Request should exist in faculty view');
        assert.strictEqual(approvedReq.status, 'APPROVED');
        assert.strictEqual(myInvigAfter.body.assignments.length, 3, 'Faculty A should have 3 active assignments');

        console.log('10. Verifying Branch A HOD sees active assignments, Branch B HOD does NOT...');
        const activeARes = await call('GET', '/api/invigilation', null, cookieHodA);
        assert.strictEqual(activeARes.status, 200);
        assert.strictEqual(activeARes.body.assignments.length, 3);

        const activeBRes = await call('GET', '/api/invigilation', null, cookieHodB);
        assert.strictEqual(activeBRes.status, 200);
        assert.strictEqual(activeBRes.body.assignments.length, 0, 'Branch B HOD must not see Branch A assignments');

        console.log('\n✓ ALL BRANCH ISOLATION TESTS PASSED SUCCESSFULLY!\n');
    } finally {
        await stopServer();
    }
}

run().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});

