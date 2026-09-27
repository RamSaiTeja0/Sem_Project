/**
 * Test Suite: Faculty Account Management Redesign
 *
 * Verifies:
 * 1. CME HOD sees CME faculty with accounts in "Faculty With Account" (hasAccount = true).
 * 2. CME HOD sees CME faculty without accounts in "Faculty Without Account" (hasAccount = false).
 * 3. EEE faculty are not shown to CME HOD (strict branch isolation).
 * 4. Faculty without accounts do not appear in HOD Invigilation dropdown.
 * 5. Faculty with accounts appear in HOD Invigilation dropdown if active.
 * 6. Create Account for a no-account faculty via POST /api/faculty/:id/create-account.
 * 7. Verify the SAME faculty_id is retained (no duplicate faculty row).
 * 8. Verify exactly one user account is created and linked.
 * 9. Verify the faculty moves from "Without Account" to "With Account".
 * 10. Verify the newly created account can be resolved and logged into as that faculty.
 * 11. Verify the newly account-linked faculty now appears in Invigilation dropdown.
 * 12. Verify branch isolation remains intact (CME HOD cannot create account for EEE faculty).
 * 13. Verify inactive faculty remain excluded from Invigilation dropdown.
 * 14. Verify duplicate account creation is prevented (409 Conflict).
 * 15. Verify existing faculty registration/approval flow still works.
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
                try { parsed = JSON.parse(data); } catch (e) { }
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
    console.log('Faculty Account Management Redesign Test Suite (TEST_DATABASE_URL)');
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
                DELETE FROM faculty_subjects WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ('CME_RAMESH', 'CME_INACTIVE', 'EEE_MAHESH', 'CME_SURESH_RAW', 'EEE_GANESH_RAW', 'CME_DEBADATTA_BATTACHARYA'));
                DELETE FROM users WHERE username IN ('cme_hod_mgmt', 'eee_hod_mgmt', 'ramesh.cme', 'inactive.cme', 'mahesh.eee', 'suresh.linked.cme', 'anita.selfreg.cme', 'debadatta.cme');
                DELETE FROM timetable WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ('CME_RAMESH', 'CME_INACTIVE', 'EEE_MAHESH', 'CME_SURESH_RAW', 'EEE_GANESH_RAW', 'CME_DEBADATTA_BATTACHARYA'));
                DELETE FROM faculty WHERE code IN ('CME_RAMESH', 'CME_INACTIVE', 'EEE_MAHESH', 'CME_SURESH_RAW', 'EEE_GANESH_RAW', 'CME_DEBADATTA_BATTACHARYA');
                DELETE FROM departments WHERE code IN ('CME', 'EEE');
            `);
        }

        console.log('1. Setting up HOD accounts for CME and EEE...');
        const cmeHodRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Section Head',
            phone: '9876543201',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hod_mgmt',
            password: 'Password_123'
        });
        assert.strictEqual(cmeHodRes.status, 201);
        const cookieCme = cmeHodRes.cookie;

        const eeeHodRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Section Head',
            phone: '9876543202',
            branchName: 'Electrical Engineering',
            branchCode: 'EEE',
            username: 'eee_hod_mgmt',
            password: 'Password_123'
        });
        assert.strictEqual(eeeHodRes.status, 201);
        const cookieEee = eeeHodRes.cookie;

        console.log('2. Creating test faculty in CME and EEE:');
        console.log('   - CME Faculty 1 (WITH account): Prof. Ramesh CME');
        const cmeFac1 = await call('POST', '/api/auth/register', {
            name: 'Prof. Ramesh CME',
            phone: '9123456701',
            username: 'ramesh.cme',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Data Structures', 'Algorithms']
        }, cookieCme);
        assert.strictEqual(cmeFac1.status, 201);
        const rameshId = cmeFac1.body.user.facultyId || (cmeFac1.body.faculty && cmeFac1.body.faculty.id);

        console.log('   - CME Faculty 2 (WITHOUT account): Prof. Suresh Unlinked CME (e.g. from timetable import)');
        let sureshUnlinkedId = null;
        if (db.isConfigured() && store.usingDatabase) {
            const addRes = await repository.addFaculty({
                id: 'CME_SURESH_RAW',
                name: 'Prof. Suresh Unlinked CME',
                department: 'CME',
                phone: '9123456702',
                designation: 'Assistant Professor',
                status: 'active'
            });
            sureshUnlinkedId = addRes.id;
            await store.reloadFromDatabase();
        } else {
            const f = store.addFacultyInMemory({
                id: 'CME_SURESH_RAW',
                name: 'Prof. Suresh Unlinked CME',
                department: 'CME',
                phone: '9123456702',
                designation: 'Assistant Professor',
                subjects: ['Operating Systems'],
                status: 'active'
            });
            sureshUnlinkedId = f.id;
        }

        console.log('   - CME Faculty 3 (WITH account, INACTIVE): Prof. Inactive CME');
        const cmeFac3 = await call('POST', '/api/auth/register', {
            name: 'Prof. Inactive CME',
            phone: '9123456703',
            username: 'inactive.cme',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Networks']
        }, cookieCme);
        assert.strictEqual(cmeFac3.status, 201);
        const inactiveFacTarget = cmeFac3.body.user.facultyId || 'inactive.cme';
        const deactRes = await call('POST', `/api/faculty/${encodeURIComponent(inactiveFacTarget)}/deactivate`, {}, cookieCme);
        assert.strictEqual(deactRes.status, 200);

        console.log('   - EEE Faculty 1 (WITH account): Dr. Mahesh EEE');
        const eeeFac1 = await call('POST', '/api/auth/register', {
            name: 'Dr. Mahesh EEE',
            phone: '9123456704',
            username: 'mahesh.eee',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Associate Professor',
            subjects: ['Circuits']
        }, cookieEee);
        assert.strictEqual(eeeFac1.status, 201);

        console.log('   - EEE Faculty 2 (WITHOUT account): Prof. Ganesh Unlinked EEE');
        if (db.isConfigured() && store.usingDatabase) {
            await repository.addFaculty({
                id: 'EEE_GANESH_RAW',
                name: 'Prof. Ganesh Unlinked EEE',
                department: 'EEE',
                phone: '9123456705',
                designation: 'Lecturer',
                status: 'active'
            });
            await store.reloadFromDatabase();
        } else {
            store.addFacultyInMemory({
                id: 'EEE_GANESH_RAW',
                name: 'Prof. Ganesh Unlinked EEE',
                department: 'EEE',
                phone: '9123456705',
                designation: 'Lecturer',
                subjects: ['Power Systems'],
                status: 'active'
            });
        }

        console.log('\n--- VERIFICATIONS ---');

        // Verification 1 & 2: CME HOD sees CME faculty with accounts and without accounts
        console.log('Verification 1 & 2: CME HOD retrieves faculty categorized with hasAccount flag...');
        const cmeFacultyRes = await call('GET', '/api/faculty', null, cookieCme);
        assert.strictEqual(cmeFacultyRes.status, 200);
        const cmeFacultyList = cmeFacultyRes.body.faculty || [];

        const cmeWithAccount = cmeFacultyList.filter(f => f.hasAccount === true);
        const cmeWithoutAccount = cmeFacultyList.filter(f => f.hasAccount === false);

        assert.ok(cmeWithAccount.some(f => f.name === 'Prof. Ramesh CME'), 'Prof. Ramesh CME must be in "Faculty With Account"');
        assert.ok(cmeWithAccount.some(f => f.name === 'Prof. Inactive CME'), 'Prof. Inactive CME must be in "Faculty With Account"');
        assert.ok(cmeWithoutAccount.some(f => f.name === 'Prof. Suresh Unlinked CME'), 'Prof. Suresh Unlinked CME must be in "Faculty Without Account"');

        // Verification 3: Branch isolation - EEE faculty not exposed to CME HOD
        console.log('Verification 3: EEE faculty not shown to CME HOD...');
        assert.ok(!cmeFacultyList.some(f => f.name.includes('EEE')), 'CME HOD must never see EEE faculty');

        // Verification 4: Faculty without accounts do NOT appear in Invigilation dropdown
        console.log('Verification 4 & 5: Invigilation dropdown filtering (only active with valid accounts)...');
        const cmeDropdownFaculty = cmeFacultyList.filter(f => {
            const isSameBranch = f.department && f.department.toUpperCase() === 'CME';
            const isActive = f.status !== 'inactive';
            const hasAccount = Boolean(f.hasAccount);
            return isSameBranch && isActive && hasAccount;
        });

        assert.ok(cmeDropdownFaculty.some(f => f.name === 'Prof. Ramesh CME'), 'Ramesh (active + with account) must appear in dropdown');
        assert.ok(!cmeDropdownFaculty.some(f => f.name === 'Prof. Suresh Unlinked CME'), 'Suresh (without account) must NOT appear in dropdown');
        assert.ok(!cmeDropdownFaculty.some(f => f.name === 'Prof. Inactive CME'), 'Inactive faculty must NOT appear in dropdown');
        assert.ok(!cmeDropdownFaculty.some(f => f.name.includes('EEE')), 'EEE faculty must NOT appear in dropdown');

        // Verification 4b: Backend rejects direct invigilation assignment to faculty without account
        console.log('Verification 4b: Direct invigilation assignment to unlinked faculty is rejected...');
        const directAssignNoAcc = await call('POST', '/api/invigilation', {
            facultyId: sureshUnlinkedId,
            date: '2026-10-25',
            periods: [1],
            notes: 'Attempt on unlinked faculty'
        }, cookieCme);
        assert.strictEqual(directAssignNoAcc.status, 400, 'Direct assignment to faculty without account must return 400');
        assert.strictEqual(directAssignNoAcc.body.code, 'FACULTY_ACCOUNT_REQUIRED');

        // Verification 6, 7, 8, 9, 10, 11: Create Account for no-account faculty
        console.log('Verification 6-11: Creating account for no-account faculty (Prof. Suresh Unlinked CME)...');
        const createAccRes = await call('POST', `/api/faculty/${encodeURIComponent(sureshUnlinkedId)}/create-account`, {
            username: 'suresh.linked.cme',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9123456702',
            subjects: ['Operating Systems', 'System Design']
        }, cookieCme);

        assert.strictEqual(createAccRes.status, 201, 'Account creation must return 201');
        assert.strictEqual(createAccRes.body.success, true);
        assert.ok(createAccRes.body.user, 'Must return created user object');
        assert.strictEqual(createAccRes.body.user.username, 'suresh.linked.cme');
        assert.strictEqual(createAccRes.body.user.department, 'CME');

        // Verification 7: SAME faculty_id is retained
        console.log('Verification 7: Verifying SAME faculty_id is retained...');
        if (db.isConfigured() && store.usingDatabase) {
            const { rows: facRows } = await db.query('SELECT id, name, code, department_id FROM faculty WHERE name = $1', ['Prof. Suresh Unlinked CME']);
            assert.strictEqual(facRows.length, 1, 'Exactly ONE faculty row must exist for Prof. Suresh Unlinked CME');
            assert.strictEqual(String(facRows[0].id), String(sureshUnlinkedId), 'Existing faculty_id must be preserved');

            const { rows: userRows } = await db.query('SELECT id, username, faculty_id, role FROM users WHERE username = $1', ['suresh.linked.cme']);
            assert.strictEqual(userRows.length, 1, 'Exactly ONE user row must exist');
            assert.strictEqual(String(userRows[0].faculty_id), String(sureshUnlinkedId), 'User faculty_id must link to existing faculty id');
        }

        // Verification 9: Faculty moves from "Without Account" to "With Account"
        console.log('Verification 9: Verifying faculty moves from Without Account to With Account...');
        const cmeFacultyResAfter = await call('GET', '/api/faculty', null, cookieCme);
        const cmeListAfter = cmeFacultyResAfter.body.faculty || [];
        const sureshAfter = cmeListAfter.find(f => f.name === 'Prof. Suresh Unlinked CME');
        assert.ok(sureshAfter, 'Suresh must exist in faculty list');
        assert.strictEqual(sureshAfter.hasAccount, true, 'Suresh must now have hasAccount = true');
        assert.strictEqual(sureshAfter.username, 'suresh.linked.cme', 'Suresh must have linked username');

        // Verification 10: The newly created account can log in
        console.log('Verification 10: Authenticating as newly created faculty account...');
        const loginSuresh = await call('POST', '/api/auth/login', {
            username: 'suresh.linked.cme',
            password: 'Password_123'
        });
        assert.strictEqual(loginSuresh.status, 200, 'Newly created faculty account must be able to log in');
        assert.strictEqual(loginSuresh.body.user.username, 'suresh.linked.cme');
        assert.strictEqual(loginSuresh.body.user.department, 'CME');
        assert.strictEqual(loginSuresh.body.user.role, 'faculty');

        // Verification 11: Newly account-linked faculty now appears in Invigilation dropdown & can be assigned
        console.log('Verification 11: Newly account-linked faculty appears in Invigilation dropdown & assignment succeeds...');
        const cmeDropdownAfter = cmeListAfter.filter(f => {
            const isSameBranch = f.department && f.department.toUpperCase() === 'CME';
            const isActive = f.status !== 'inactive';
            const hasAccount = Boolean(f.hasAccount);
            return isSameBranch && isActive && hasAccount;
        });
        assert.ok(cmeDropdownAfter.some(f => f.name === 'Prof. Suresh Unlinked CME'), 'Suresh must now appear in HOD invigilation dropdown');

        const assignSureshRes = await call('POST', '/api/invigilation', {
            facultyId: sureshUnlinkedId,
            date: '2026-10-25',
            periods: [1],
            notes: 'Invigilation for newly account-linked faculty'
        }, cookieCme);
        assert.strictEqual(assignSureshRes.status, 201, 'Direct invigilation assignment should now succeed');
        assert.strictEqual(assignSureshRes.body.assignments.length, 1);

        // Verification 12: Cross-branch account creation is rejected
        console.log('Verification 12: CME HOD attempting to create account for EEE faculty is rejected (403)...');
        const crossBranchCreate = await call('POST', `/api/faculty/EEE_GANESH_RAW/create-account`, {
            username: 'ganesh.cross',
            password: 'Password_123',
            phone: '9123456799',
            subjects: ['Power']
        }, cookieCme);
        assert.strictEqual(crossBranchCreate.status, 403, 'Cross branch account creation must return 403 Forbidden');

        // Verification 14: Duplicate account creation is prevented (409 Conflict)
        console.log('Verification 14: Duplicate account creation attempt for same faculty with DIFFERENT username is rejected (409)...');
        const dupAccRes = await call('POST', `/api/faculty/${encodeURIComponent(sureshUnlinkedId)}/create-account`, {
            username: 'suresh.second.username',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9123456702',
            subjects: ['OS']
        }, cookieCme);
        assert.strictEqual(dupAccRes.status, 409, 'Duplicate account creation must return 409 Conflict');
        assert.strictEqual(dupAccRes.body.code, 'ACCOUNT_EXISTS');

        // Verification 14b: Attempting to create account for Faculty B (Ramesh, who already has an account) is rejected
        console.log('Verification 14b: Attempting account creation for faculty with existing account (Ramesh) is rejected (409)...');
        const dupRameshRes = await call('POST', `/api/faculty/${encodeURIComponent(rameshId)}/create-account`, {
            username: 'ramesh.another',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9123456701',
            subjects: ['Data Structures']
        }, cookieCme);
        assert.strictEqual(dupRameshRes.status, 409, 'Account creation for faculty with account must return 409 Conflict');
        assert.strictEqual(dupRameshRes.body.code, 'ACCOUNT_EXISTS');

        // Verification 14c: Username collision with another user returns username-taken error
        console.log('Verification 14c: Username collision with another existing user returns username-taken error (409)...');
        const dupUsernameRes = await call('POST', `/api/auth/register`, {
            name: 'Another User',
            phone: '9123456708',
            username: 'ramesh.cme',
            password: 'Password_123',
            role: 'faculty',
            subjects: ['Math']
        }, cookieCme);
        assert.strictEqual(dupUsernameRes.status, 409, 'Duplicate username must return 409');
        assert.strictEqual(dupUsernameRes.body.code, 'USERNAME_EXISTS');

        // Verification 14d: Test account creation for non-numeric faculty ID (e.g. CME_DEBADATTA_BATTACHARYA)
        console.log('Verification 14d: Creating account for faculty with non-numeric string code (CME_DEBADATTA_BATTACHARYA)...');
        let debadattaFacId = 'CME_DEBADATTA_BATTACHARYA';
        if (db.isConfigured() && store.usingDatabase) {
            await repository.addFaculty({
                id: debadattaFacId,
                name: 'DEBADATTA BATTACHARYA',
                department: 'CME',
                phone: '9123456799',
                designation: 'Assistant Professor',
                status: 'active'
            });
            await store.reloadFromDatabase();
        } else {
            store.addFacultyInMemory({
                id: debadattaFacId,
                name: 'DEBADATTA BATTACHARYA',
                department: 'CME',
                phone: '9123456799',
                designation: 'Assistant Professor',
                subjects: ['Compiler Design'],
                status: 'active'
            });
        }

        // Before account creation: Debadatta is in Without Account
        const preDebRes = await call('GET', '/api/faculty', null, cookieCme);
        const preDebList = preDebRes.body.faculty || [];
        const preDeb = preDebList.find(f => f.name === 'DEBADATTA BATTACHARYA');
        assert.ok(preDeb, 'Debadatta must exist');
        assert.strictEqual(preDeb.hasAccount, false, 'Debadatta must initially have hasAccount = false');

        // Create account using string faculty ID
        const debCreateRes = await call('POST', `/api/faculty/${encodeURIComponent(debadattaFacId)}/create-account`, {
            username: 'debadatta.cme',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9123456799',
            subjects: ['Compiler Design']
        }, cookieCme);
        assert.strictEqual(debCreateRes.status, 201, 'Debadatta account creation must return 201');

        // After account creation: Debadatta MUST have hasAccount = true and be in With Account
        const postDebRes = await call('GET', '/api/faculty', null, cookieCme);
        const postDebList = postDebRes.body.faculty || [];
        const postDeb = postDebList.find(f => f.name === 'DEBADATTA BATTACHARYA');
        assert.ok(postDeb, 'Debadatta must exist after account creation');
        assert.strictEqual(postDeb.hasAccount, true, 'Debadatta must now have hasAccount = true');
        assert.strictEqual(postDeb.username, 'debadatta.cme', 'Debadatta must report linked username');

        const postDebWith = postDebList.filter(f => f.hasAccount === true);
        const postDebWithout = postDebList.filter(f => f.hasAccount === false);
        assert.ok(postDebWith.some(f => f.name === 'DEBADATTA BATTACHARYA'), 'Debadatta must be in Faculty With Account');
        assert.ok(!postDebWithout.some(f => f.name === 'DEBADATTA BATTACHARYA'), 'Debadatta must NOT be in Faculty Without Account (mutually exclusive)');

        // Second attempt with different username must be blocked
        const debSecondAttempt = await call('POST', `/api/faculty/${encodeURIComponent(debadattaFacId)}/create-account`, {
            username: 'debadatta.second',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9123456799',
            subjects: ['Compiler Design']
        }, cookieCme);
        assert.strictEqual(debSecondAttempt.status, 409, 'Second account creation for Debadatta must be rejected with 409');
        assert.strictEqual(debSecondAttempt.body.code, 'ACCOUNT_EXISTS');

        // Verification 15: Existing faculty registration/approval flow still works
        console.log('Verification 15: Faculty self-registration & HOD approval flow remains functional...');
        const regReqRes = await call('POST', '/api/faculty-requests', {
            fullName: 'Dr. Anita SelfReg CME',
            phone: '9888877777',
            username: 'anita.selfreg.cme',
            password: 'Password_123',
            branchCode: 'CME',
            designation: 'Assistant Professor',
            subjects: ['Cloud Computing']
        });
        assert.strictEqual(regReqRes.status, 201);
        const anitaReqId = regReqRes.body.request.id;

        const approveRes = await call('POST', `/api/faculty-requests/${anitaReqId}/approve`, {}, cookieCme);
        assert.strictEqual(approveRes.status, 200);
        assert.strictEqual(approveRes.body.success, true);
        assert.strictEqual(approveRes.body.request.status, 'APPROVED');

        const loginAnita = await call('POST', '/api/auth/login', {
            username: 'anita.selfreg.cme',
            password: 'Password_123'
        });
        assert.strictEqual(loginAnita.status, 200, 'Approved self-registered faculty can log in');

        console.log('\n✓ ALL 20 VERIFICATION POINTS FOR FACULTY ACCOUNT MANAGEMENT PASSED SUCCESSFULLY!\n');
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
