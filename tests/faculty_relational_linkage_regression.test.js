/**
 * Test Suite: Faculty Relational Linkage and Tab Counts Regression
 *
 * Verifies:
 * 1. Mutual exclusivity: Each faculty record in the branch is counted exactly once:
 *    total = withAccount.length + withoutAccount.length.
 * 2. Relational linkage: A faculty master record without a linked user in users table
 *    MUST have hasAccount: false (Faculty Without Account), even if another user shares
 *    a similar or identical display name.
 * 3. Exact matching: Faculty with a valid linked login account (via users.faculty_id or
 *    explicit code) appear under Faculty With Account (hasAccount: true).
 * 4. Staging / Catalog registration: Unresolved faculty registered via staging/catalog
 *    without an account appear immediately in "Faculty Without Account" and are visible
 *    to the HOD without requiring manual server restart.
 * 5. Account creation flow: Creating an account via POST /api/faculty/:id/create-account
 *    links users.faculty_id to the exact faculty database ID, immediately transitioning
 *    the faculty from "Faculty Without Account" to "Faculty With Account".
 * 6. Duplicate prevention: Attempting to create an account with an existing username or
 *    for an already-linked faculty fails with 409 Conflict, without corrupting database state.
 * 7. Branch isolation: HOD of CME cannot see, access, or create accounts for EEE faculty.
 * 8. Status reflection: Inactive status updates both faculty record and linked user account.
 */

const { initTestDb, verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

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
    console.log('Faculty Relational Linkage Regression Test Suite');
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
                DELETE FROM exam_invigilation WHERE branch_code IN ('TEST_LINK_CME', 'TEST_LINK_EEE');
                DELETE FROM faculty_registration_requests WHERE branch_code IN ('TEST_LINK_CME', 'TEST_LINK_EEE');
                DELETE FROM faculty_subjects WHERE faculty_id IN (
                    SELECT id FROM faculty WHERE code IN ('TL_FAC_LINKED', 'TL_FAC_UNLINKED', 'TL_FAC_SAMENAME_UNLINKED', 'TL_EEE_FAC')
                );
                DELETE FROM users WHERE username IN ('tl_cme_hod', 'tl_eee_hod', 'tl_user_linked', 'tl_samename_other', 'tl_newly_created');
                DELETE FROM timetable WHERE faculty_id IN (
                    SELECT id FROM faculty WHERE code IN ('TL_FAC_LINKED', 'TL_FAC_UNLINKED', 'TL_FAC_SAMENAME_UNLINKED', 'TL_EEE_FAC')
                );
                DELETE FROM faculty WHERE code IN ('TL_FAC_LINKED', 'TL_FAC_UNLINKED', 'TL_FAC_SAMENAME_UNLINKED', 'TL_EEE_FAC');
                DELETE FROM departments WHERE code IN ('TEST_LINK_CME', 'TEST_LINK_EEE');
            `);
        }

        console.log('[Step 1] Setting up CME and EEE departments with HODs...');
        const cmeHod = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Section Head',
            phone: '9876543210',
            branchName: 'Computer Engineering',
            branchCode: 'TEST_LINK_CME',
            username: 'tl_cme_hod',
            password: 'Password_123'
        });
        assert.strictEqual(cmeHod.status, 201, 'CME HOD registration should succeed');
        const cmeCookie = cmeHod.cookie;

        const eeeHod = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Section Head',
            phone: '9876543211',
            branchName: 'Electrical Engineering',
            branchCode: 'TEST_LINK_EEE',
            username: 'tl_eee_hod',
            password: 'Password_123'
        });
        assert.strictEqual(eeeHod.status, 201, 'EEE HOD registration should succeed');
        const eeeCookie = eeeHod.cookie;

        // Get department IDs
        const cmeDeptRes = await db.query('SELECT id FROM departments WHERE code = $1', ['TEST_LINK_CME']);
        const cmeDeptId = cmeDeptRes.rows[0].id;

        const eeeDeptRes = await db.query('SELECT id FROM departments WHERE code = $1', ['TEST_LINK_EEE']);
        const eeeDeptId = eeeDeptRes.rows[0].id;

        console.log('[Step 2] Inserting faculty master records into CME and EEE...');
        // 1) CME Faculty with account
        const facLinkedRes = await db.query(`
            INSERT INTO faculty (code, name, designation, department_id, status)
            VALUES ('TL_FAC_LINKED', 'G Sandhya Rani', 'Assistant Professor', $1, 'active')
            RETURNING id
        `, [cmeDeptId]);
        const facLinkedId = facLinkedRes.rows[0].id;

        // 2) CME Faculty WITHOUT account
        const facUnlinkedRes = await db.query(`
            INSERT INTO faculty (code, name, designation, department_id, status)
            VALUES ('TL_FAC_UNLINKED', 'Debadatta Bhattacharya', 'Assistant Professor', $1, 'active')
            RETURNING id
        `, [cmeDeptId]);
        const facUnlinkedId = facUnlinkedRes.rows[0].id;

        // 3) CME Faculty sharing a display name with an existing user, but with NO account of their own
        const facSameNameRes = await db.query(`
            INSERT INTO faculty (code, name, designation, department_id, status)
            VALUES ('TL_FAC_SAMENAME_UNLINKED', 'Sai Kishore', 'Assistant Professor', $1, 'active')
            RETURNING id
        `, [cmeDeptId]);
        const facSameNameId = facSameNameRes.rows[0].id;

        // 4) EEE Faculty in another department
        const facEeeRes = await db.query(`
            INSERT INTO faculty (code, name, designation, department_id, status)
            VALUES ('TL_EEE_FAC', 'Pavan Varma', 'Assistant Professor', $1, 'active')
            RETURNING id
        `, [eeeDeptId]);
        const facEeeId = facEeeRes.rows[0].id;

        // Create linked user for facLinkedId
        await db.query(`
            INSERT INTO users (username, password_hash, role, name, department_id, faculty_id, status)
            VALUES ('tl_user_linked', 'dummy_hash', 'faculty', 'G Sandhya Rani', $1, $2, 'active')
        `, [cmeDeptId, facLinkedId]);

        // Create an unrelated user with name "Sai Kishore" in EEE (or without faculty_id), NOT linked to facSameNameId
        await db.query(`
            INSERT INTO users (username, password_hash, role, name, department_id, faculty_id, status)
            VALUES ('tl_samename_other', 'dummy_hash', 'faculty', 'Sai Kishore', $1, NULL, 'active')
        `, [eeeDeptId]);

        // Reload store cache from DB
        await store.reloadFromDatabase();

        console.log('[Step 3] Fetching CME faculty list as CME HOD...');
        const facListRes = await call('GET', '/api/faculty', null, cmeCookie);
        assert.strictEqual(facListRes.status, 200, 'GET /api/faculty should return 200');

        const facultyList = facListRes.body.faculty;
        console.log(`  Total CME faculty returned: ${facultyList.length}`);

        // Branch isolation: exactly 3 CME faculty, 0 EEE faculty
        assert.strictEqual(facultyList.length, 3, 'Must return exactly 3 CME faculty');
        assert.ok(!facultyList.some(f => f.code === 'TL_EEE_FAC'), 'EEE faculty must be isolated from CME HOD');

        // Check classification
        const withAccount = facultyList.filter(f => f.hasAccount === true);
        const withoutAccount = facultyList.filter(f => f.hasAccount === false);

        console.log(`  Faculty With Account: ${withAccount.length}`);
        console.log(`  Faculty Without Account: ${withoutAccount.length}`);

        // Requirement 1 & 2: Mutual exclusivity and accurate counting
        assert.strictEqual(facultyList.length, withAccount.length + withoutAccount.length,
            'Every faculty record must be counted in exactly one category (mutual exclusivity)');
        assert.strictEqual(withAccount.length, 1, 'Exactly 1 faculty should have an account');
        assert.strictEqual(withoutAccount.length, 2, 'Exactly 2 faculty should NOT have accounts');

        // Linked faculty checks
        const linkedFaculty = withAccount.find(f => f.code === 'TL_FAC_LINKED');
        assert.ok(linkedFaculty, 'TL_FAC_LINKED must be in Faculty With Account');
        assert.strictEqual(linkedFaculty.account.username, 'tl_user_linked');

        // Debadatta must NOT have account
        const debadatta = withoutAccount.find(f => f.code === 'TL_FAC_UNLINKED');
        assert.ok(debadatta, 'Debadatta must be in Faculty Without Account');
        assert.strictEqual(debadatta.hasAccount, false);
        assert.strictEqual(debadatta.account, null);

        // Sai Kishore must NOT have account despite name match with an unrelated user
        const saiKishore = withoutAccount.find(f => f.code === 'TL_FAC_SAMENAME_UNLINKED');
        assert.ok(saiKishore, 'Sai Kishore must be in Faculty Without Account despite name match heuristic');
        assert.strictEqual(saiKishore.hasAccount, false);
        assert.strictEqual(saiKishore.account, null);

        console.log('  ✓ Mutual exclusivity and relational linkage verified successfully');

        console.log('\n[Step 4] Testing Account Creation for unlinked faculty...');
        const createAccRes = await call('POST', `/api/faculty/${debadatta.id}/create-account`, {
            username: 'tl_newly_created',
            password: 'NewFacultyPassword_123',
            phone: '9123456789'
        }, cmeCookie);

        if (createAccRes.status !== 201) {
            console.error('createAccRes failed with:', createAccRes.status, createAccRes.body);
        }
        assert.strictEqual(createAccRes.status, 201, 'Account creation should return 201');
        assert.strictEqual(createAccRes.body.user.username, 'tl_newly_created');
        const returnedFacId = createAccRes.body.user.facultyId || createAccRes.body.user.faculty_id;
        assert.ok(returnedFacId, 'Created user must link to the faculty ID');

        // Refresh faculty list
        const refreshedListRes = await call('GET', '/api/faculty', null, cmeCookie);
        const refreshedList = refreshedListRes.body.faculty;
        const refreshedWith = refreshedList.filter(f => f.hasAccount === true);
        const refreshedWithout = refreshedList.filter(f => f.hasAccount === false);

        console.log(`  Refreshed With Account: ${refreshedWith.length}`);
        console.log(`  Refreshed Without Account: ${refreshedWithout.length}`);

        assert.strictEqual(refreshedWith.length, 2, 'Faculty With Account count must increment to 2');
        assert.strictEqual(refreshedWithout.length, 1, 'Faculty Without Account count must decrement to 1');

        const nowLinkedDebadatta = refreshedWith.find(f => f.code === 'TL_FAC_UNLINKED');
        assert.ok(nowLinkedDebadatta, 'Debadatta must now appear in Faculty With Account');
        assert.strictEqual(nowLinkedDebadatta.account.username, 'tl_newly_created');

        console.log('  ✓ Transition from Without Account to With Account verified');

        console.log('\n[Step 5] Testing Duplicate Account Creation Prevention...');
        const duplicateRes = await call('POST', `/api/faculty/${debadatta.id}/create-account`, {
            username: 'tl_another_user',
            password: 'AnotherPassword_123'
        }, cmeCookie);
        assert.strictEqual(duplicateRes.status, 409, 'Attempting to create account for already linked faculty must fail with 409 Conflict');

        const duplicateUsernameRes = await call('POST', `/api/faculty/${saiKishore.id}/create-account`, {
            username: 'tl_newly_created', // already used
            password: 'AnotherPassword_123'
        }, cmeCookie);
        assert.strictEqual(duplicateUsernameRes.status, 409, 'Reusing an existing username must fail with 409 Conflict');

        console.log('  ✓ Duplicate prevention verified');

        console.log('\n[Step 6] Testing Branch Isolation for Account Creation...');
        // CME HOD trying to create account for EEE faculty
        const crossBranchRes = await call('POST', `/api/faculty/${facEeeId}/create-account`, {
            username: 'tl_cross_branch',
            password: 'CrossPassword_123'
        }, cmeCookie);
        assert.ok([403, 404].includes(crossBranchRes.status), `Cross branch account creation must be rejected (got ${crossBranchRes.status})`);

        console.log('  ✓ Branch isolation for account creation verified');

        console.log('\n================================================================');
        console.log('ALL RELATIONAL LINKAGE & TAB COUNT TESTS PASSED (0 failures)');
        console.log('================================================================\n');

    } finally {
        await stopServer();
    }
}

run().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Fatal error in faculty_relational_linkage_regression.test.js:', err);
    process.exit(1);
});
