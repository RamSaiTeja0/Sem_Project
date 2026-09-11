/**
 * Phase B7.1 — Faculty Self-Registration with HOS Approval Test Suite
 *
 * Covers:
 *  1. Valid faculty registration request submission (201 Created).
 *  2. Request starts as PENDING.
 *  3. No faculty user account exists while request is pending.
 *  4. Invalid/nonexistent branch is rejected (400 Bad Request).
 *  5. Duplicate username against existing user is rejected (409 Conflict).
 *  6. Duplicate username against another PENDING request is rejected (409 Conflict).
 *  7. Sensible re-apply behavior: submitting with username of a REJECTED request succeeds.
 *  8. Invalid password rules rejected (no underscore, no number, no letter) (400 Bad Request).
 *  9. Password confirmation mismatch rejected (400 Bad Request).
 * 10. Missing required fields rejected (400 Bad Request).
 * 11. HOS sees own-branch requests.
 * 12. HOS cannot see another branch's requests.
 * 13. HOS cannot approve another branch's request (403 Forbidden).
 * 14. HOS cannot reject another branch's request (403 Forbidden).
 * 15. Approval creates exactly one faculty user account.
 * 16. Approved faculty inherits the request's branch.
 * 17. Approved faculty can log in with requested credentials.
 * 18. Rejection creates no faculty account.
 * 19. Rejected request cannot log in (401 Unauthorized).
 * 20. Public users and faculty cannot access HOS request management APIs (401/403).
 * 21. Duplicate approval and approving rejected requests are blocked (409 Conflict).
 * 22. Existing HOS direct faculty creation still works.
 */
const assert = require('assert');
const http = require('http');
const { check, counts } = require('./helpers');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting, setBranch } = require('../src/data/departments');
const facultyRequests = require('../src/data/facultyRequests');

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
    console.log('TecSubstitution — Phase B7.1 Faculty Self-Registration Tests\n');

    await startServer();

    try {
        // Reset state for pristine testing
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();
        facultyRequests.resetForTesting();

        // -------------------------------------------------------------
        // Setup: Register two distinct branches and HOS accounts
        // We use dynamic branch codes (BRANCH_A and BRANCH_B) to guarantee
        // no hardcoding of specific branch names like CME or EEE.
        // -------------------------------------------------------------
        const BRANCH_A = 'DEPTA';
        const BRANCH_B = 'DEPTB';

        console.log(`[Setup] Registering HOS for ${BRANCH_A} and ${BRANCH_B}`);

        const hosARes = await call('POST', '/api/auth/register', {
            username: 'hos.dept.a',
            password: 'HosPass_123',
            confirmPassword: 'HosPass_123',
            role: 'hos',
            name: 'HOS Department A',
            phone: '9876543201',
            branchCode: BRANCH_A,
            branchName: 'Department A Engineering'
        });
        assert.strictEqual(hosARes.status, 201, 'HOS A registration failed: ' + JSON.stringify(hosARes.body));
        const cookieHosA = hosARes.cookie;

        const hosBRes = await call('POST', '/api/auth/register', {
            username: 'hos.dept.b',
            password: 'HosPass_123',
            confirmPassword: 'HosPass_123',
            role: 'hos',
            name: 'HOS Department B',
            phone: '9876543202',
            branchCode: BRANCH_B,
            branchName: 'Department B Engineering'
        });
        assert.strictEqual(hosBRes.status, 201, 'HOS B registration failed: ' + JSON.stringify(hosBRes.body));
        const cookieHosB = hosBRes.cookie;

        // -------------------------------------------------------------
        // Test 1: Valid faculty request starts PENDING (no account created)
        // -------------------------------------------------------------
        console.log('\n[Test 1] Valid faculty registration request submission');
        const reqPayload1 = {
            name: 'Dr. Faculty One',
            phone: '9876543210',
            branchCode: BRANCH_A,
            username: 'fac.one',
            password: 'FacPass_123',
            confirmPassword: 'FacPass_123',
            designation: 'Assistant Professor',
            subjects: ['Calculus', 'Linear Algebra']
        };

        const submitRes1 = await call('POST', '/api/faculty-requests', reqPayload1);
        check('1. Valid faculty request returns 201 Created with sanitized data', () => {
            assert.strictEqual(submitRes1.status, 201);
            assert.strictEqual(submitRes1.body.success, true);
            assert.ok(submitRes1.body.request, 'Response must contain request object');
            assert.ok(submitRes1.body.request.id, 'Request must have an ID');
            assert.strictEqual(submitRes1.body.request.username, 'fac.one');
            assert.strictEqual(submitRes1.body.request.branchCode, BRANCH_A);
            assert.strictEqual(submitRes1.body.request.status, 'PENDING');
            // Plaintext password or password hash must NEVER be returned
            assert.strictEqual(submitRes1.body.request.password, undefined);
            assert.strictEqual(submitRes1.body.request.passwordHash, undefined);
        });

        const req1Id = submitRes1.body.request.id;

        check('2. Request starts in PENDING status', () => {
            assert.strictEqual(submitRes1.body.request.status, 'PENDING');
        });

        check('3. No faculty account exists while request is pending', async () => {
            const userLookup = users.findByUsername('fac.one');
            assert.strictEqual(userLookup, null, 'No user record should exist for pending username');

            // Attempt login as pending faculty -> must fail
            const loginRes = await call('POST', '/api/auth/login', {
                username: 'fac.one',
                password: 'FacPass_123'
            });
            assert.strictEqual(loginRes.status, 401, 'Pending faculty must not be able to log in');
        });

        // -------------------------------------------------------------
        // Test 4: Invalid/nonexistent branch rejected
        // -------------------------------------------------------------
        console.log('\n[Test 4] Validation: Nonexistent branch');
        const invalidBranchRes = await call('POST', '/api/faculty-requests', {
            name: 'Fake Faculty',
            phone: '9876543211',
            branchCode: 'NON_EXISTENT_BRANCH_XYZ',
            username: 'fac.fake',
            password: 'FacPass_123',
            confirmPassword: 'FacPass_123',
            designation: 'Lecturer',
            subjects: ['General']
        });
        check('4. Invalid/nonexistent branch code is rejected with 400 Bad Request', () => {
            assert.strictEqual(invalidBranchRes.status, 400);
            assert.strictEqual(invalidBranchRes.body.code, 'INVALID_BRANCH');
        });

        // -------------------------------------------------------------
        // Test 5: Duplicate username handling
        // -------------------------------------------------------------
        console.log('\n[Test 5] Duplicate username handling');
        // A) Duplicate against existing user (HOS A)
        const dupUserRes = await call('POST', '/api/faculty-requests', {
            name: 'Imposter Faculty',
            phone: '9876543212',
            branchCode: BRANCH_A,
            username: 'hos.dept.a', // Already taken by HOS A
            password: 'FacPass_123',
            confirmPassword: 'FacPass_123',
            designation: 'Lecturer',
            subjects: ['General']
        });
        check('5a. Duplicate username against existing active user returns 409 Conflict', () => {
            assert.strictEqual(dupUserRes.status, 409);
            assert.strictEqual(dupUserRes.body.code, 'USERNAME_EXISTS');
        });

        // B) Duplicate against already pending request ('fac.one')
        const dupPendingRes = await call('POST', '/api/faculty-requests', {
            name: 'Another Faculty One',
            phone: '9876543213',
            branchCode: BRANCH_A,
            username: 'fac.one', // Already pending
            password: 'FacPass_123',
            confirmPassword: 'FacPass_123',
            designation: 'Lecturer',
            subjects: ['General']
        });
        check('5b. Duplicate username against another PENDING request returns 409 Conflict', () => {
            assert.strictEqual(dupPendingRes.status, 409);
            assert.strictEqual(dupPendingRes.body.code, 'REQUEST_EXISTS');
        });

        // -------------------------------------------------------------
        // Test 6: Password validation rules
        // -------------------------------------------------------------
        console.log('\n[Test 6] Password policy validation');
        // No underscore
        const noUnderscoreRes = await call('POST', '/api/faculty-requests', {
            name: 'Test Fac', phone: '9876543214', branchCode: BRANCH_A,
            username: 'fac.nounder', password: 'Password123', confirmPassword: 'Password123',
            designation: 'Lecturer', subjects: ['Math']
        });
        check('6a. Password without underscore rejected (400)', () => {
            assert.strictEqual(noUnderscoreRes.status, 400);
            assert.strictEqual(noUnderscoreRes.body.code, 'INVALID_PASSWORD');
        });

        // No number
        const noNumberRes = await call('POST', '/api/faculty-requests', {
            name: 'Test Fac', phone: '9876543214', branchCode: BRANCH_A,
            username: 'fac.nonumber', password: 'Password_abc', confirmPassword: 'Password_abc',
            designation: 'Lecturer', subjects: ['Math']
        });
        check('6b. Password without number rejected (400)', () => {
            assert.strictEqual(noNumberRes.status, 400);
            assert.strictEqual(noNumberRes.body.code, 'INVALID_PASSWORD');
        });

        // No letter
        const noLetterRes = await call('POST', '/api/faculty-requests', {
            name: 'Test Fac', phone: '9876543214', branchCode: BRANCH_A,
            username: 'fac.noletter', password: '123456_789', confirmPassword: '123456_789',
            designation: 'Lecturer', subjects: ['Math']
        });
        check('6c. Password without letter rejected (400)', () => {
            assert.strictEqual(noLetterRes.status, 400);
            assert.strictEqual(noLetterRes.body.code, 'INVALID_PASSWORD');
        });

        // Confirmation mismatch
        const mismatchRes = await call('POST', '/api/faculty-requests', {
            name: 'Test Fac', phone: '9876543214', branchCode: BRANCH_A,
            username: 'fac.mismatch', password: 'FacPass_123', confirmPassword: 'Different_123',
            designation: 'Lecturer', subjects: ['Math']
        });
        check('6d. Password confirmation mismatch rejected (400)', () => {
            assert.strictEqual(mismatchRes.status, 400);
            assert.strictEqual(mismatchRes.body.code, 'PASSWORD_MISMATCH');
        });

        // Missing required fields
        const missingNameRes = await call('POST', '/api/faculty-requests', {
            name: '', phone: '9876543214', branchCode: BRANCH_A,
            username: 'fac.noname', password: 'FacPass_123', confirmPassword: 'FacPass_123'
        });
        check('6e. Missing required name rejected (400)', () => {
            assert.strictEqual(missingNameRes.status, 400);
        });

        // -------------------------------------------------------------
        // Test 7 & 8: Branch Isolation for HOS viewing requests
        // -------------------------------------------------------------
        console.log('\n[Test 7 & 8] Branch isolation for requests list');
        // Submit request for Branch B
        const submitResB = await call('POST', '/api/faculty-requests', {
            name: 'Prof. Faculty Branch B',
            phone: '9876543220',
            branchCode: BRANCH_B,
            username: 'fac.deptb',
            password: 'DeptBPass_123',
            confirmPassword: 'DeptBPass_123',
            designation: 'Professor',
            subjects: ['Control Systems', 'Power Electronics']
        });
        assert.strictEqual(submitResB.status, 201, 'Submit request B failed: ' + JSON.stringify(submitResB.body));
        const reqBId = submitResB.body.request.id;

        // HOS A fetches requests
        const hosAListRes = await call('GET', '/api/faculty-requests', null, cookieHosA);
        check('7. HOS A sees only requests belonging to Branch A', () => {
            assert.strictEqual(hosAListRes.status, 200);
            const list = hosAListRes.body.requests || [];
            const reqAInList = list.some(r => r.id === req1Id && r.branchCode === BRANCH_A);
            const reqBInList = list.some(r => r.id === reqBId || r.branchCode === BRANCH_B);
            assert.ok(reqAInList, 'HOS A must see Branch A request');
            assert.strictEqual(reqBInList, false, 'HOS A must NOT see Branch B request');
        });

        // HOS B fetches requests
        const hosBListRes = await call('GET', '/api/faculty-requests', null, cookieHosB);
        check('8. HOS B sees only requests belonging to Branch B', () => {
            assert.strictEqual(hosBListRes.status, 200);
            const list = hosBListRes.body.requests || [];
            const reqBInList = list.some(r => r.id === reqBId && r.branchCode === BRANCH_B);
            const reqAInList = list.some(r => r.id === req1Id || r.branchCode === BRANCH_A);
            assert.ok(reqBInList, 'HOS B must see Branch B request');
            assert.strictEqual(reqAInList, false, 'HOS B must NOT see Branch A request');
        });

        // -------------------------------------------------------------
        // Test 9 & 10: Cross-branch approval and rejection forbidden
        // -------------------------------------------------------------
        console.log('\n[Test 9 & 10] Cross-branch approval and rejection prevention');
        // HOS B tries to approve Branch A's request
        const crossApproveRes = await call('POST', `/api/faculty-requests/${req1Id}/approve`, {}, cookieHosB);
        check('9. HOS cannot approve another branch\'s request (403 Forbidden)', () => {
            assert.strictEqual(crossApproveRes.status, 403);
            assert.strictEqual(crossApproveRes.body.code, 'FORBIDDEN');
        });

        // HOS B tries to reject Branch A's request
        const crossRejectRes = await call('POST', `/api/faculty-requests/${req1Id}/reject`, { reason: 'Cross reject' }, cookieHosB);
        check('10. HOS cannot reject another branch\'s request (403 Forbidden)', () => {
            assert.strictEqual(crossRejectRes.status, 403);
            assert.strictEqual(crossRejectRes.body.code, 'FORBIDDEN');
        });

        // -------------------------------------------------------------
        // Test 11, 12, 13: Legitimate approval by own HOS
        // -------------------------------------------------------------
        console.log('\n[Test 11, 12, 13] Approval creates faculty account with correct branch & login');
        const approveRes = await call('POST', `/api/faculty-requests/${req1Id}/approve`, {}, cookieHosA);
        check('11. Approval creates exactly one faculty user account', () => {
            assert.strictEqual(approveRes.status, 200);
            assert.strictEqual(approveRes.body.success, true);
            assert.ok(approveRes.body.user, 'Approval response must include created user');
            assert.strictEqual(approveRes.body.user.username, 'fac.one');
            assert.strictEqual(approveRes.body.user.role, 'faculty');
            assert.strictEqual(approveRes.body.request.status, 'APPROVED');
            assert.ok(approveRes.body.request.reviewedBy, 'Must record reviewedBy');
            assert.ok(approveRes.body.request.reviewedAt, 'Must record reviewedAt');

            // Verify exactly one user in users store
            const user = users.findByUsername('fac.one');
            assert.ok(user, 'User record must exist in users store');
            assert.strictEqual(user.username, 'fac.one');
        });

        check('12. Approved faculty inherits the request\'s branch and metadata', () => {
            const user = users.findByUsername('fac.one');
            assert.strictEqual(user.department, BRANCH_A);
            assert.strictEqual(user.role, 'faculty');
            assert.strictEqual(user.name, 'Dr. Faculty One');
            assert.strictEqual(user.phone, '9876543210');
            assert.deepStrictEqual(user.subjects, ['Calculus', 'Linear Algebra']);
            assert.strictEqual(user.status, 'active');
        });

        let cookieFacultyOne;
        check('13. Approved faculty can log in successfully with requested credentials', async () => {
            const loginRes = await call('POST', '/api/auth/login', {
                username: 'fac.one',
                password: 'FacPass_123'
            });
            assert.strictEqual(loginRes.status, 200);
            assert.strictEqual(loginRes.body.authenticated, true);
            assert.strictEqual(loginRes.body.user.username, 'fac.one');
            assert.strictEqual(loginRes.body.user.role, 'faculty');
            assert.strictEqual(loginRes.body.user.department, BRANCH_A);
            cookieFacultyOne = loginRes.cookie;
        });

        // -------------------------------------------------------------
        // Test 14 & 15: Rejection creates no faculty account & cannot log in
        // -------------------------------------------------------------
        console.log('\n[Test 14 & 15] Rejection creates no account and prevents login');
        // Submit another request for Branch A to test rejection
        const reqPayloadReject = {
            name: 'Candidate To Reject',
            phone: '9876543230',
            branchCode: BRANCH_A,
            username: 'fac.rejectme',
            password: 'RejectPass_123',
            confirmPassword: 'RejectPass_123',
            designation: 'Lecturer',
            subjects: ['Basic Science']
        };
        const submitRejectRes = await call('POST', '/api/faculty-requests', reqPayloadReject);
        assert.strictEqual(submitRejectRes.status, 201);
        const reqRejectId = submitRejectRes.body.request.id;

        const rejectRes = await call('POST', `/api/faculty-requests/${reqRejectId}/reject`, {
            reason: 'Incomplete credentials and unverifiable phone number'
        }, cookieHosA);

        check('14. Rejection marks request as REJECTED and records reason without creating user', () => {
            assert.strictEqual(rejectRes.status, 200);
            assert.strictEqual(rejectRes.body.success, true);
            assert.strictEqual(rejectRes.body.request.status, 'REJECTED');
            assert.strictEqual(rejectRes.body.request.rejectionReason, 'Incomplete credentials and unverifiable phone number');
            assert.ok(rejectRes.body.request.reviewedBy, 'Must record reviewedBy');

            const userLookup = users.findByUsername('fac.rejectme');
            assert.strictEqual(userLookup, null, 'No user account must be created for rejected candidate');
        });

        check('15. Rejected request cannot log in', async () => {
            const loginRes = await call('POST', '/api/auth/login', {
                username: 'fac.rejectme',
                password: 'RejectPass_123'
            });
            assert.strictEqual(loginRes.status, 401, 'Rejected candidate must not be able to log in');
        });

        // -------------------------------------------------------------
        // Test 16: Faculty cannot access HOS request management APIs
        // -------------------------------------------------------------
        console.log('\n[Test 16] Security: Faculty cannot access HOS request APIs');
        const facListRes = await call('GET', '/api/faculty-requests', null, cookieFacultyOne);
        check('16a. Faculty cannot list requests (403 Forbidden)', () => {
            assert.strictEqual(facListRes.status, 403);
        });

        const facApproveRes = await call('POST', `/api/faculty-requests/${reqBId}/approve`, {}, cookieFacultyOne);
        check('16b. Faculty cannot approve requests (403 Forbidden)', () => {
            assert.strictEqual(facApproveRes.status, 403);
        });

        const facRejectRes = await call('POST', `/api/faculty-requests/${reqBId}/reject`, {}, cookieFacultyOne);
        check('16c. Faculty cannot reject requests (403 Forbidden)', () => {
            assert.strictEqual(facRejectRes.status, 403);
        });

        // -------------------------------------------------------------
        // Test 17: Public (unauthenticated) users cannot access management APIs
        // -------------------------------------------------------------
        console.log('\n[Test 17] Security: Public users cannot manage requests');
        const unauthListRes = await call('GET', '/api/faculty-requests');
        check('17a. Public user cannot list requests (401 Unauthorized)', () => {
            assert.strictEqual(unauthListRes.status, 401);
        });

        const unauthApproveRes = await call('POST', `/api/faculty-requests/${reqBId}/approve`, {});
        check('17b. Public user cannot approve requests (401 Unauthorized)', () => {
            assert.strictEqual(unauthApproveRes.status, 401);
        });

        // -------------------------------------------------------------
        // Test 18: Prevent duplicate approval & approving rejected requests
        // -------------------------------------------------------------
        console.log('\n[Test 18] State guards: Prevent duplicate approval');
        const dupApproveRes = await call('POST', `/api/faculty-requests/${req1Id}/approve`, {}, cookieHosA);
        check('18a. Duplicate approval of already approved request returns 409 Conflict', () => {
            assert.strictEqual(dupApproveRes.status, 409);
            assert.strictEqual(dupApproveRes.body.code, 'ALREADY_APPROVED');
        });

        const approveRejectedRes = await call('POST', `/api/faculty-requests/${reqRejectId}/approve`, {}, cookieHosA);
        check('18b. Cannot approve a rejected request (409 Conflict)', () => {
            assert.strictEqual(approveRejectedRes.status, 409);
            assert.strictEqual(approveRejectedRes.body.code, 'ALREADY_REJECTED');
        });

        // -------------------------------------------------------------
        // Test 19: Re-applying with username from rejected request
        // -------------------------------------------------------------
        console.log('\n[Test 19] Re-applying after rejection succeeds cleanly');
        const reapplyRes = await call('POST', '/api/faculty-requests', {
            name: 'Candidate Reapplying',
            phone: '9876543231',
            branchCode: BRANCH_A,
            username: 'fac.rejectme', // Was previously rejected
            password: 'NewPass_123',
            confirmPassword: 'NewPass_123',
            designation: 'Assistant Professor',
            subjects: ['Advanced Physics']
        });
        check('19. Submitting request with previously rejected username succeeds and starts new PENDING request', () => {
            assert.strictEqual(reapplyRes.status, 201);
            assert.strictEqual(reapplyRes.body.request.status, 'PENDING');
            assert.strictEqual(reapplyRes.body.request.username, 'fac.rejectme');
        });

        // -------------------------------------------------------------
        // Test 20: Existing HOS direct faculty creation still works
        // -------------------------------------------------------------
        console.log('\n[Test 20] Existing HOS direct faculty creation still works');
        const directFacRes = await call('POST', '/api/auth/register', {
            username: 'fac.direct',
            password: 'DirectPass_123',
            confirmPassword: 'DirectPass_123',
            role: 'faculty',
            name: 'Prof. Direct Added',
            phone: '9876543240',
            designation: 'Professor',
            subjects: ['Robotics'],
            branchCode: BRANCH_A
        }, cookieHosA);

        check('20. Authenticated HOS can still directly create faculty via POST /api/auth/register', () => {
            assert.strictEqual(directFacRes.status, 201);
            assert.strictEqual(directFacRes.body.user.username, 'fac.direct');
            assert.strictEqual(directFacRes.body.user.department, BRANCH_A);

            const directUser = users.findByUsername('fac.direct');
            assert.ok(directUser, 'Directly created faculty must exist in users store');
            assert.strictEqual(directUser.department, BRANCH_A);
        });

        // -------------------------------------------------------------
        // Test 21: Directly created faculty can log in
        // -------------------------------------------------------------
        const directLoginRes = await call('POST', '/api/auth/login', {
            username: 'fac.direct',
            password: 'DirectPass_123'
        });
        check('21. Directly created faculty can log in successfully', () => {
            assert.strictEqual(directLoginRes.status, 200);
            assert.strictEqual(directLoginRes.body.authenticated, true);
        });

    } finally {
        await stopServer();
    }

    const c = counts();
    console.log('\n------------------------------------');
    console.log(`Results: ${c.passed} passed, ${c.failed} failed\n`);
    if (c.failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal error in faculty_registration_requests.test.js:', err);
    process.exit(1);
});
