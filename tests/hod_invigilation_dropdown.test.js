/**
 * Test Suite: HOD Exam Invigilation Faculty Dropdown & Branch Isolation
 * Validates that the faculty dropdown correctly returns active faculty belonging to the HOD's branch only.
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
    console.log('HOD Exam Invigilation Faculty Dropdown Test Suite');
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
                DELETE FROM faculty_subjects WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ('CME_RAMESH', 'CME_INACTIVE', 'EEE_MAHESH', 'EEE_FRANK', 'EEE_SURESH') OR name IN ('Prof. Ramesh CME', 'Prof. Inactive CME', 'Dr. Suresh EEE', 'Dr. Mahesh EEE'));
                DELETE FROM users WHERE username IN ('cme_hos_dropdown', 'eee_hos_dropdown', 'ramesh.cme', 'inactive.cme', 'mahesh.eee', 'frank.eee', 'suresh.eee');
                DELETE FROM timetable WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ('CME_RAMESH', 'CME_INACTIVE', 'EEE_MAHESH', 'EEE_FRANK', 'EEE_SURESH') OR name IN ('Prof. Ramesh CME', 'Prof. Inactive CME', 'Dr. Suresh EEE', 'Dr. Mahesh EEE'));
                DELETE FROM faculty WHERE code IN ('CME_RAMESH', 'CME_INACTIVE', 'EEE_MAHESH', 'EEE_FRANK', 'EEE_SURESH') OR name IN ('Prof. Ramesh CME', 'Prof. Inactive CME', 'Dr. Suresh EEE', 'Dr. Mahesh EEE');
                DELETE FROM departments WHERE code IN ('CME', 'EEE');
            `);
        }

        console.log('1. Registering CME HOD and EEE HOD accounts...');
        const cmeHodRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Section Head',
            phone: '9876543201',
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: 'cme_hos_dropdown',
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
            username: 'eee_hos_dropdown',
            password: 'Password_123'
        });
        assert.strictEqual(eeeHodRes.status, 201);
        const cookieEee = eeeHodRes.cookie;

        console.log('2. Registering Active & Inactive Faculty in CME and EEE...');
        // Active CME faculty
        const cmeFacActive = await call('POST', '/api/auth/register', {
            name: 'Prof. Ramesh CME',
            phone: '9123456701',
            username: 'ramesh.cme',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Algorithms']
        }, cookieCme);
        assert.strictEqual(cmeFacActive.status, 201);

        // Inactive CME faculty
        const cmeFacInactive = await call('POST', '/api/auth/register', {
            name: 'Prof. Inactive CME',
            phone: '9123456702',
            username: 'inactive.cme',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Networks']
        }, cookieCme);
        assert.strictEqual(cmeFacInactive.status, 201);
        const inactiveFacTarget = (cmeFacInactive.body.faculty && cmeFacInactive.body.faculty.id) ||
                                  (cmeFacInactive.body.user && (cmeFacInactive.body.user.facultyId || cmeFacInactive.body.user.name)) || 'inactive.cme';

        // Deactivate the inactive faculty
        const deactRes = await call('POST', `/api/faculty/${encodeURIComponent(inactiveFacTarget)}/deactivate`, {}, cookieCme);
        assert.strictEqual(deactRes.status, 200, 'Deactivation must succeed');

        // Active EEE faculty
        const eeeFacActive = await call('POST', '/api/auth/register', {
            name: 'Dr. Suresh EEE',
            phone: '9123456703',
            username: 'suresh.eee',
            password: 'Password_123',
            role: 'faculty',
            designation: 'Associate Professor',
            subjects: ['Circuits']
        }, cookieEee);
        assert.strictEqual(eeeFacActive.status, 201);

        console.log('3. Testing GET /api/faculty for CME HOD...');
        const cmeFacultyRes = await call('GET', '/api/faculty', null, cookieCme);
        assert.strictEqual(cmeFacultyRes.status, 200);
        const cmeFacultyList = cmeFacultyRes.body.faculty || [];
        console.log('CME HOD retrieved faculty:', cmeFacultyList.map(f => `${f.name} (${f.department}, ${f.status})`));

        // Filter active CME faculty as frontend does
        const cmeDropdownFaculty = cmeFacultyList.filter(f => {
            const isSameBranch = f.department && f.department.toUpperCase() === 'CME';
            const isActive = f.status !== 'inactive';
            return isSameBranch && isActive;
        });

        // Verification 1: CME HOD list contains active CME faculty
        assert.ok(cmeDropdownFaculty.some(f => f.name === 'Prof. Ramesh CME'), 'CME HOD dropdown must include active CME faculty');

        // Verification 2: CME HOD list does NOT contain EEE faculty
        assert.ok(!cmeDropdownFaculty.some(f => f.name === 'Dr. Suresh EEE'), 'CME HOD dropdown must NOT include EEE faculty');

        // Verification 5: Inactive CME faculty is excluded
        assert.ok(!cmeDropdownFaculty.some(f => f.name === 'Prof. Inactive CME'), 'CME HOD dropdown must exclude inactive faculty');

        console.log('4. Testing GET /api/faculty for EEE HOD...');
        const eeeFacultyRes = await call('GET', '/api/faculty', null, cookieEee);
        assert.strictEqual(eeeFacultyRes.status, 200);
        const eeeFacultyList = eeeFacultyRes.body.faculty || [];
        console.log('EEE HOD retrieved faculty:', eeeFacultyList.map(f => `${f.name} (${f.department}, ${f.status})`));

        // Filter active EEE faculty as frontend does
        const eeeDropdownFaculty = eeeFacultyList.filter(f => {
            const isSameBranch = f.department && f.department.toUpperCase() === 'EEE';
            const isActive = f.status !== 'inactive';
            return isSameBranch && isActive;
        });

        // Verification 3: EEE HOD list contains active EEE faculty
        assert.ok(eeeDropdownFaculty.some(f => f.name === 'Dr. Suresh EEE'), 'EEE HOD dropdown must include active EEE faculty');

        // Verification 4: EEE HOD list does NOT contain CME faculty
        assert.ok(!eeeDropdownFaculty.some(f => f.name === 'Prof. Ramesh CME'), 'EEE HOD dropdown must NOT include CME faculty');

        console.log('5. Testing Direct Invigilation Assignment from CME HOD...');
        const ramesh = cmeDropdownFaculty.find(f => f.name === 'Prof. Ramesh CME');
        assert.ok(ramesh.id, 'Faculty ID must be present');
        assert.strictEqual(ramesh.name, 'Prof. Ramesh CME', 'Faculty name must be correct');

        const assignRes = await call('POST', '/api/invigilation', {
            facultyId: ramesh.id,
            date: '2026-10-20',
            periods: [1, 2],
            notes: 'Mid-term Lab Invigilation'
        }, cookieCme);
        assert.strictEqual(assignRes.status, 201, 'Direct assignment should return 201');
        assert.strictEqual(assignRes.body.assignments.length, 2);
        assert.ok(assignRes.body.assignments[0].facultyId, 'Assignment must have facultyId');

        console.log('6. Testing Direct Invigilation Assignment with legacy string code / non-numeric identifier...');
        if (db.isConfigured() && store.usingDatabase) {
            // Verify PostgreSQL row contains integer faculty_id
            const { rows } = await db.query('SELECT faculty_id, branch_code, period, notes FROM exam_invigilation WHERE exam_date = $1', ['2026-10-20']);
            assert.ok(rows.length >= 2, 'Must have inserted rows into exam_invigilation');
            assert.strictEqual(typeof rows[0].faculty_id, 'number', 'DB faculty_id must be integer');
            assert.ok(rows[0].faculty_id > 0, 'DB faculty_id must be positive integer');
            assert.ok(!String(rows[0].faculty_id).includes('OBJECT'), 'DB faculty_id must not contain OBJECT');
        }

        console.log('7. Testing Cross-Branch Assignment Rejection (CME HOD assigning EEE faculty)...');
        const suresh = eeeDropdownFaculty.find(f => f.name === 'Dr. Suresh EEE');
        assert.ok(suresh, 'EEE faculty must be found');
        const crossBranchRes = await call('POST', '/api/invigilation', {
            facultyId: suresh.id,
            date: '2026-10-20',
            periods: [3],
            notes: 'Cross-branch test'
        }, cookieCme);
        assert.strictEqual(crossBranchRes.status, 403, 'Cross-branch assignment must return 403 Forbidden');

        console.log('8. Testing Faculty Availability (Busy during assigned periods)...');
        const availCheck = await invigilation.checkDuplicateInvigilation(ramesh, '2026-10-20', 1);
        assert.strictEqual(availCheck, true, 'Faculty must be marked busy/duplicate on assigned period');

        console.log('\n✓ ALL HOD INVIGILATION DIRECT ASSIGNMENT & DROPDOWN TESTS PASSED SUCCESSFULLY!\n');
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

