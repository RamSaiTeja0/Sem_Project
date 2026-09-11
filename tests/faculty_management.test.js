/**
 * Phase B6.1 — Faculty Management Test Suite
 *
 * Covers:
 *  1. HOS edits own-branch faculty (Name, Phone, Designation, Subjects).
 *  2. Forbidden fields cannot be changed (ID, branch, username, password); no password hashes leaked.
 *  3. HOS cannot edit another branch's faculty (403 Forbidden).
 *  4. Faculty cannot perform HOS management operations (403 Forbidden).
 *  5. Unauthenticated requests to management endpoints are rejected (401).
 *  6. Cross-branch deactivation is rejected (403 Forbidden).
 *  7. HOS safely deactivates own-branch faculty (status becomes 'inactive').
 *  8. Deactivated faculty cannot log in (403 ACCOUNT_DEACTIVATED).
 *  9. Deactivated faculty are excluded from availability & free faculty lists.
 * 10. Existing timetable records of deactivated faculty remain intact and unchanged.
 * 11. Cross-branch reactivation is rejected (403 Forbidden).
 * 12. HOS reactivates inactive faculty; login and availability eligibility are restored.
 */
const assert = require('assert');
const http = require('http');
const { check, counts } = require('./helpers');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting, setBranch } = require('../src/data/departments');

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
    console.log('TecSubstitution — Phase B6.1 Faculty Management Tests\n');

    await startServer();

    try {
        // Reset state for pristine testing
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();

        // -------------------------------------------------------------
        // Setup: Register CME HOS, EEE HOS, CME Faculty, EEE Faculty
        // -------------------------------------------------------------
        console.log('[Setup] Registering HOS and Faculty accounts for CME and EEE');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            username: 'hos.cme',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'hos',
            name: 'Dr. Head CME',
            phone: '9876543210',
            branchCode: 'CME',
            branchName: 'Computer Engineering'
        });
        assert.strictEqual(hosCmeRes.status, 201);
        const cookieHosCme = hosCmeRes.cookie;

        // Register EEE HOS (isolated context)
        const hosEeeRes = await call('POST', '/api/auth/register', {
            username: 'hos.eee',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'hos',
            name: 'Dr. Head EEE',
            phone: '9876543211',
            branchCode: 'EEE',
            branchName: 'Electrical Engineering'
        });
        assert.strictEqual(hosEeeRes.status, 201);
        const cookieHosEee = hosEeeRes.cookie;

        // CME HOS creates CME Faculty: Prof. Alice CME
        const facCmeRes = await call('POST', '/api/auth/register', {
            username: 'prof.alice',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'faculty',
            name: 'Prof. Alice CME',
            phone: '+91 98765 43210',
            subjects: ['Data Structures', 'Algorithms']
        }, cookieHosCme);
        assert.strictEqual(facCmeRes.status, 201);
        const cmeFacultyId = facCmeRes.body.user.facultyId;

        // EEE HOS creates EEE Faculty: Prof. Bob EEE
        const facEeeRes = await call('POST', '/api/auth/register', {
            username: 'prof.bob',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'faculty',
            name: 'Prof. Bob EEE',
            phone: '+91 98765 43211',
            subjects: ['Circuit Theory', 'Digital Electronics']
        }, cookieHosEee);
        assert.strictEqual(facEeeRes.status, 201);
        const eeeFacultyId = facEeeRes.body.user.facultyId;

        // Login as Alice to get faculty cookie
        const loginAlice = await call('POST', '/api/auth/login', {
            username: 'prof.alice',
            password: 'TecSub_123'
        });
        assert.strictEqual(loginAlice.status, 200);
        const cookieAlice = loginAlice.cookie;

        // Add a timetable entry for Alice in CME-A on Monday P1
        store.addEntryInMemory({
            className: 'CME-A',
            day: 'Monday',
            period: 1,
            subject: 'Data Structures',
            faculty: 'Prof. Alice CME',
            room: 'C-101',
            type: 'theory'
        });

        // ==============================================================
        // [1] HOS Edits Own-Branch Faculty
        // ==============================================================
        console.log('\n[1] HOS Edits Own-Branch Faculty');

        const editRes = await call('PUT', `/api/faculty/${cmeFacultyId}`, {
            name: 'Dr. Alice CME',
            phone: '+91 91234 56789',
            designation: 'Associate Professor',
            subjects: ['Data Structures', 'Advanced Algorithms', 'AI Systems']
        }, cookieHosCme);

        check('HOS can edit own-branch faculty details', () => {
            assert.strictEqual(editRes.status, 200);
            assert.strictEqual(editRes.body.success, true);
            assert.strictEqual(editRes.body.faculty.name, 'Dr. Alice CME');
            assert.strictEqual(editRes.body.faculty.phone, '+91 91234 56789');
            assert.strictEqual(editRes.body.faculty.designation, 'Associate Professor');
            assert.deepStrictEqual(editRes.body.faculty.subjects, ['Data Structures', 'Advanced Algorithms', 'AI Systems']);
            assert.strictEqual(editRes.body.faculty.department, 'CME');
        });

        const getFacRes = await call('GET', `/api/faculty/${cmeFacultyId}`, null, cookieHosCme);
        check('Faculty details are updated in store and readable by HOS', () => {
            assert.strictEqual(getFacRes.status, 200);
            assert.strictEqual(getFacRes.body.faculty.name, 'Dr. Alice CME');
            assert.strictEqual(getFacRes.body.faculty.phone, '+91 91234 56789');
            assert.strictEqual(getFacRes.body.faculty.designation, 'Associate Professor');
        });

        // ==============================================================
        // [2] Forbidden Fields & Password Protection
        // ==============================================================
        console.log('\n[2] Forbidden Fields & Password Protection');

        const tamperRes = await call('PUT', `/api/faculty/${cmeFacultyId}`, {
            id: 'HACKED_ID',
            facultyId: 'HACKED_ID',
            department: 'EEE',
            branch: 'EEE',
            username: 'hacked_username',
            password: 'NewHackedPassword123!',
            passwordHash: 'fake_hash_value'
        }, cookieHosCme);

        check('Forbidden fields (ID, branch, username, password) cannot be altered via edit', () => {
            assert.strictEqual(tamperRes.status, 200);
            const fac = tamperRes.body.faculty;
            assert.strictEqual(fac.id, cmeFacultyId, 'Faculty ID must remain unchanged');
            assert.strictEqual(fac.department, 'CME', 'Faculty department must remain unchanged');
            assert.strictEqual(fac.password, undefined, 'Password must not be returned');
            assert.strictEqual(fac.passwordHash, undefined, 'Password hash must not be returned');
        });

        check('Original password remains intact after tampering attempt', async () => {
            const reloginAlice = await call('POST', '/api/auth/login', {
                username: 'prof.alice',
                password: 'TecSub_123'
            });
            assert.strictEqual(reloginAlice.status, 200);
        });

        // ==============================================================
        // [3] Cross-Branch Security Enforced
        // ==============================================================
        console.log('\n[3] Cross-Branch Security Enforced');

        const crossEditRes = await call('PUT', `/api/faculty/${cmeFacultyId}`, {
            name: 'Malicious Edit By EEE'
        }, cookieHosEee);

        check('HOS cannot edit another branch faculty (returns 403)', () => {
            assert.strictEqual(crossEditRes.status, 403);
            assert.strictEqual(crossEditRes.body.code, 'FORBIDDEN');
        });

        const crossDeactRes = await call('POST', `/api/faculty/${cmeFacultyId}/deactivate`, {}, cookieHosEee);
        check('HOS cannot deactivate another branch faculty (returns 403)', () => {
            assert.strictEqual(crossDeactRes.status, 403);
            assert.strictEqual(crossDeactRes.body.code, 'FORBIDDEN');
        });

        const crossActRes = await call('POST', `/api/faculty/${cmeFacultyId}/activate`, {}, cookieHosEee);
        check('HOS cannot activate another branch faculty (returns 403)', () => {
            assert.strictEqual(crossActRes.status, 403);
            assert.strictEqual(crossActRes.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [4] Role Authorization: Faculty Cannot Perform HOS Operations
        // ==============================================================
        console.log('\n[4] Role Authorization');

        const facEditSelf = await call('PUT', `/api/faculty/${cmeFacultyId}`, {
            name: 'Unauthorized Faculty Edit'
        }, cookieAlice);

        check('Faculty role cannot access PUT /api/faculty/:id (returns 403)', () => {
            assert.strictEqual(facEditSelf.status, 403);
            assert.strictEqual(facEditSelf.body.code, 'FORBIDDEN');
        });

        const facDeactSelf = await call('POST', `/api/faculty/${cmeFacultyId}/deactivate`, {}, cookieAlice);
        check('Faculty role cannot access deactivate endpoint (returns 403)', () => {
            assert.strictEqual(facDeactSelf.status, 403);
            assert.strictEqual(facDeactSelf.body.code, 'FORBIDDEN');
        });

        const anonEdit = await call('PUT', `/api/faculty/${cmeFacultyId}`, { name: 'Anon' });
        check('Unauthenticated request to faculty edit is rejected (returns 401)', () => {
            assert.strictEqual(anonEdit.status, 401);
            assert.strictEqual(anonEdit.body.code, 'UNAUTHENTICATED');
        });

        // ==============================================================
        // [5] Safe Deactivation
        // ==============================================================
        console.log('\n[5] Safe Faculty Deactivation');

        const deactRes = await call('POST', `/api/faculty/${cmeFacultyId}/deactivate`, {}, cookieHosCme);
        check('HOS can deactivate own-branch faculty', () => {
            assert.strictEqual(deactRes.status, 200);
            assert.strictEqual(deactRes.body.success, true);
            assert.strictEqual(deactRes.body.status, 'inactive');
        });

        const getDeactRes = await call('GET', `/api/faculty/${cmeFacultyId}`, null, cookieHosCme);
        check('Faculty status is reported as inactive', () => {
            assert.strictEqual(getDeactRes.status, 200);
            assert.strictEqual(getDeactRes.body.faculty.status, 'inactive');
        });

        // ==============================================================
        // [6] Deactivated Faculty Cannot Log In
        // ==============================================================
        console.log('\n[6] Deactivated Faculty Login Block');

        const deactLoginRes = await call('POST', '/api/auth/login', {
            username: 'prof.alice',
            password: 'TecSub_123'
        });

        check('Deactivated faculty cannot log in (returns 403 ACCOUNT_DEACTIVATED)', () => {
            assert.strictEqual(deactLoginRes.status, 403);
            assert.strictEqual(deactLoginRes.body.code, 'ACCOUNT_DEACTIVATED');
        });

        // ==============================================================
        // [7] Deactivated Faculty Excluded from Availability
        // ==============================================================
        console.log('\n[7] Excluded From Availability');

        // In Monday Period 2, Alice is not scheduled, but being deactivated she must NOT appear in free results
        const availRes = await call('GET', '/api/availability?day=Monday&period=2', null, cookieHosCme);
        check('Deactivated faculty is excluded from future FREE faculty results', () => {
            assert.strictEqual(availRes.status, 200);
            const availableNames = availRes.body.availableFaculty || [];
            assert.ok(!availableNames.includes('Dr. Alice CME'), 'Dr. Alice CME must not be in availableFaculty');
            assert.ok(!availableNames.includes('Prof. Alice CME'), 'Prof. Alice CME must not be in availableFaculty');
            const availableList = availRes.body.available || [];
            assert.ok(!availableList.some(f => f.faculty === 'Dr. Alice CME' || f.facultyId === cmeFacultyId),
                'Deactivated faculty must not appear in available list');
        });

        // ==============================================================
        // [8] Data Safety: Timetable Rows Intact
        // ==============================================================
        console.log('\n[8] Data Safety: Historical Timetable Preserved');

        const timetableEntries = store.listEntriesInMemory({ className: 'CME-A' });
        check('Existing timetable rows remain intact after deactivation', () => {
            assert.ok(timetableEntries.length > 0, 'Timetable entries must not be wiped');
            const aliceEntry = timetableEntries.find(e => e.day === 'Monday' && e.period === 1);
            assert.ok(aliceEntry, 'Alice timetable entry must still exist');
            assert.strictEqual(aliceEntry.subject, 'Data Structures');
        });

        // ==============================================================
        // [9] Reactivation Restores Login & Availability
        // ==============================================================
        console.log('\n[9] Faculty Reactivation');

        const reactRes = await call('POST', `/api/faculty/${cmeFacultyId}/activate`, {}, cookieHosCme);
        check('HOS can reactivate an inactive faculty member', () => {
            assert.strictEqual(reactRes.status, 200);
            assert.strictEqual(reactRes.body.success, true);
            assert.strictEqual(reactRes.body.status, 'active');
        });

        const reactLoginRes = await call('POST', '/api/auth/login', {
            username: 'prof.alice',
            password: 'TecSub_123'
        });
        check('Reactivated faculty can log in successfully', () => {
            assert.strictEqual(reactLoginRes.status, 200);
            assert.strictEqual(reactLoginRes.body.authenticated, true);
            assert.strictEqual(reactLoginRes.body.user.name, 'Dr. Alice CME');
        });

        const reactAvailRes = await call('GET', '/api/availability?day=Monday&period=2', null, cookieHosCme);
        check('Reactivated faculty is restored to availability results', () => {
            assert.strictEqual(reactAvailRes.status, 200);
            const availableNames = reactAvailRes.body.availableFaculty || [];
            assert.ok(availableNames.includes('Dr. Alice CME'),
                'Dr. Alice CME must be available again at Monday P2 after reactivation');
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
    console.error('Fatal error in faculty_management.test.js:', err);
    process.exit(1);
});
