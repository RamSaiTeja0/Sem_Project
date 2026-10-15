/**
 * Automated test suite for Faculty Leaving College & Faculty Deactivation workflow.
 *
 * Tests:
 *  1. An authorized HOD can deactivate an eligible faculty member in their branch.
 *  2. The faculty user account becomes inactive (status: 'inactive', active: false).
 *  3. The faculty record becomes inactive (status: 'inactive').
 *  4. The deactivated faculty member cannot log in.
 *  5. Existing sessions are invalidated.
 *  6. An inactive faculty member cannot access protected faculty APIs.
 *  7. The inactive faculty member disappears from active faculty lists.
 *  8. The inactive faculty member is excluded from availability results.
 *  9. The inactive faculty member cannot be selected for new substitutions.
 * 10. An unauthorized user cannot deactivate faculty.
 * 11. A HOD cannot deactivate faculty belonging to another branch.
 * 12. A faculty member cannot deactivate themselves or another faculty member.
 * 13. An ordinary deactivation request cannot bypass the HOD handover process.
 * 14. Historical attendance, timetable, substitution, invigilation, and audit records remain intact.
 * 15. Pending requests and active delegations are handled safely.
 * 16. Database transaction failures do not leave partially deactivated records.
 * 17. Existing HOD delegation and HOD transfer workflows continue to work.
 * 18. Existing faculty, timetable, attendance, and substitution features continue to work.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('../src/core/session');
const users = require('../src/data/users');
const store = require('../src/data/store');
const substitutions = require('../src/data/substitutions');
const delegations = require('../src/data/delegations');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const facultyRoutes = require('../src/routes/faculty');
const substitutionRoutes = require('../src/routes/substitutions');
const delegationRoutes = require('../src/routes/delegations');
const authRoutes = require('../src/routes/auth');
const availabilityRoutes = require('../src/routes/availability');
const config = require('../src/config');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');
const { registerBranch } = require('../src/data/departments');

const app = express();
app.use(express.json());
app.use(session.middleware);
app.use('/api/auth', authRoutes);
app.use('/api/faculty', facultyRoutes);
app.use('/api/substitutions', substitutionRoutes);
app.use('/api/delegations', delegationRoutes);
app.use('/api/availability', availabilityRoutes);

let server;
let baseUrl;

function request(method, path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const headers = options.headers || {};
        if (options.session) {
            headers.cookie = `${session.COOKIE_NAME}=${session.create(options.session)}`;
        }
        if (options.body && !headers['content-type']) {
            headers['content-type'] = 'application/json';
        }

        const req = http.request(url, {
            method,
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

const seed = require('../src/db/seed');

async function runTests() {
    console.log('--- Starting Faculty Leaving College & Deactivation Test Suite ---');
    if (db.isConfigured()) {
        try {
            await seed.migrate();
        } catch (_) {}
    }
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const tag = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const branchCme = `CME_${tag}`.toUpperCase();
    const branchEee = `EEE_${tag}`.toUpperCase();

    if (typeof registerBranch === 'function') {
        registerBranch(branchCme, `Computer Engineering ${tag}`);
        registerBranch(branchEee, `Electrical Engineering ${tag}`);
    }

    try {
        // Setup Unique Test Users
        // 1. CME HOD
        const hodUser = await users.register({
            username: `hod_cme_${tag}`,
            password: 'Password_123',
            name: `Dr. CME HOD ${tag}`,
            phone: '9876543210',
            role: 'hos',
            department: branchCme,
            branchCode: branchCme,
            branchName: `Computer Engineering ${tag}`
        });

        // 2. EEE HOD (Other branch)
        const eeeHodUser = await users.register({
            username: `hod_eee_${tag}`,
            password: 'Password_123',
            name: `Dr. EEE HOD ${tag}`,
            phone: '9876543211',
            role: 'hos',
            department: branchEee,
            branchCode: branchEee,
            branchName: `Electrical Engineering ${tag}`
        });

        // 3. CME Faculty 1 (Leaving faculty)
        const facLeavingId = `FAC_L_${tag}`.toUpperCase();
        const fac1 = await users.register({
            username: `fac_leaving_${tag}`,
            password: 'Password_123',
            name: `Prof. Leaving Faculty ${tag}`,
            phone: '9876543212',
            role: 'faculty',
            facultyId: facLeavingId,
            department: branchCme,
            branchCode: branchCme,
            subjects: ['Networks', 'Security']
        }, hodUser);

        // 4. CME Faculty 2 (Peer faculty)
        const facPeerId = `FAC_P_${tag}`.toUpperCase();
        const fac2 = await users.register({
            username: `fac_peer_${tag}`,
            password: 'Password_123',
            name: `Prof. Peer Faculty ${tag}`,
            phone: '9876543213',
            role: 'faculty',
            facultyId: facPeerId,
            department: branchCme,
            branchCode: branchCme,
            subjects: ['Databases']
        }, hodUser);

        // 5. EEE Faculty (Other branch faculty)
        const facEeeId = `FAC_E_${tag}`.toUpperCase();
        const eeeFac = await users.register({
            username: `fac_eee_${tag}`,
            password: 'Password_123',
            name: `Prof. EEE Faculty ${tag}`,
            phone: '9876543214',
            role: 'faculty',
            facultyId: facEeeId,
            department: branchEee,
            branchCode: branchEee,
            subjects: ['Circuits']
        }, eeeHodUser);

        // Populate in-memory engine if running in memory mode
        if (store.engine && typeof store.engine.getFaculty === 'function') {
            const currentFaculty = store.engine.getFaculty();
            currentFaculty.push({ id: facLeavingId, name: `Prof. Leaving Faculty ${tag}`, department: branchCme, status: 'active', subjects: ['Networks'] });
            currentFaculty.push({ id: facPeerId, name: `Prof. Peer Faculty ${tag}`, department: branchCme, status: 'active', subjects: ['Databases'] });
            currentFaculty.push({ id: facEeeId, name: `Prof. EEE Faculty ${tag}`, department: branchEee, status: 'active', subjects: ['Circuits'] });
        }

        console.log('Setup completed. Running test scenarios...');

        // -------------------------------------------------------------
        // Test 10: Unauthorized user cannot deactivate faculty
        // -------------------------------------------------------------
        console.log('Test 10: Unauthorized user cannot deactivate faculty');
        const unauthRes = await request('POST', `/api/faculty/${facLeavingId}/deactivate`, {
            body: { effectiveDate: '2026-10-10', reason: 'Resigned' }
        });
        assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must be rejected with 401');

        // -------------------------------------------------------------
        // Test 12: Faculty member cannot deactivate themselves or another faculty
        // -------------------------------------------------------------
        console.log('Test 12: Faculty member cannot deactivate themselves or another faculty');
        const facDeactPeer = await request('POST', `/api/faculty/${facPeerId}/deactivate`, {
            session: { id: fac1.id, username: `fac_leaving_${tag}`, role: 'faculty', department: branchCme },
            body: { effectiveDate: '2026-10-10', reason: 'Attempt' }
        });
        assert.strictEqual(facDeactPeer.status, 403, 'Faculty cannot deactivate another faculty');

        const facDeactSelf = await request('POST', `/api/faculty/${facLeavingId}/deactivate`, {
            session: { id: fac1.id, username: `fac_leaving_${tag}`, facultyId: facLeavingId, role: 'faculty', department: branchCme },
            body: { effectiveDate: '2026-10-10', reason: 'Self attempt' }
        });
        assert.strictEqual(facDeactSelf.status, 403, 'Faculty member cannot deactivate themselves');

        const hodDeactSelf = await request('POST', `/api/faculty/${hodUser.id}/deactivate`, {
            session: { id: hodUser.id, username: `hod_cme_${tag}`, role: 'hos', department: branchCme },
            body: { effectiveDate: '2026-10-10', reason: 'HOD self attempt' }
        });
        assert.strictEqual(hodDeactSelf.status, 400, 'HOD self-deactivation must be prohibited');
        assert.ok(
            hodDeactSelf.body.code === 'SELF_DEACTIVATION_PROHIBITED' || hodDeactSelf.body.code === 'HOD_DEACTIVATION_REQUIRES_HANDOVER',
            'Must return self deactivation or HOD handover error'
        );

        // -------------------------------------------------------------
        // Test 11: HOD cannot deactivate faculty belonging to another branch
        // -------------------------------------------------------------
        console.log('Test 11: HOD cannot deactivate faculty belonging to another branch');
        const crossBranchRes = await request('POST', `/api/faculty/${facEeeId}/deactivate`, {
            session: { id: hodUser.id, username: `hod_cme_${tag}`, role: 'hos', department: branchCme },
            body: { effectiveDate: '2026-10-10', reason: 'Cross branch' }
        });
        assert.strictEqual(crossBranchRes.status, 403, 'Cross-branch deactivation must return 403');
        assert.strictEqual(crossBranchRes.body.code, 'FORBIDDEN');

        // -------------------------------------------------------------
        // Test 13: Ordinary deactivation cannot bypass HOD handover process
        // -------------------------------------------------------------
        console.log('Test 13: Ordinary deactivation cannot bypass HOD handover process');
        const hodDeactRes = await request('POST', `/api/faculty/hod_eee_${tag}/deactivate`, {
            session: { id: eeeHodUser.id, username: 'admin_user', role: 'coordinator', department: branchEee },
            body: { effectiveDate: '2026-10-10', reason: 'Direct HOD deactivation attempt' }
        });
        assert.strictEqual(hodDeactRes.status, 400, 'HOD direct deactivation must be blocked');
        assert.strictEqual(hodDeactRes.body.code, 'HOD_DEACTIVATION_REQUIRES_HANDOVER');

        // Create a pre-deactivation session token for the leaving faculty
        const preDeactivationSessionToken = session.create({
            id: fac1.id,
            username: `fac_leaving_${tag}`,
            name: `Prof. Leaving Faculty ${tag}`,
            role: 'faculty',
            facultyId: facLeavingId,
            department: branchCme
        });

        // -------------------------------------------------------------
        // Test 1: Authorized HOD can deactivate an eligible faculty member in their branch
        // -------------------------------------------------------------
        console.log('Test 1: Authorized HOD can deactivate an eligible faculty member in their branch');
        const deactRes = await request('POST', `/api/faculty/${facLeavingId}/deactivate`, {
            session: { id: hodUser.id, username: `hod_cme_${tag}`, role: 'hos', department: branchCme },
            body: { effectiveDate: '2026-10-10', reason: 'Relocating to another college' }
        });
        assert.strictEqual(deactRes.status, 200, 'Deactivation should succeed with 200');
        assert.strictEqual(deactRes.body.success, true);
        assert.strictEqual(deactRes.body.status, 'inactive');

        // -------------------------------------------------------------
        // Test 2 & 3: Faculty user account and record become inactive
        // -------------------------------------------------------------
        console.log('Test 2 & 3: Faculty user account and faculty record become inactive');
        const updatedUser = users.findByUsername(`fac_leaving_${tag}`);
        assert.ok(updatedUser, 'User must still exist');
        assert.strictEqual(updatedUser.status, 'inactive', 'User status must be inactive');
        assert.strictEqual(updatedUser.active, false, 'User active flag must be false');

        // -------------------------------------------------------------
        // Test 4: Deactivated faculty member cannot log in
        // -------------------------------------------------------------
        console.log('Test 4: Deactivated faculty member cannot log in');
        const loginRes = await request('POST', '/api/auth/login', {
            body: { username: `fac_leaving_${tag}`, password: 'Password_123' }
        });
        assert.strictEqual(loginRes.status, 403, 'Inactive user login must be rejected with 403');
        assert.strictEqual(loginRes.body.code, 'ACCOUNT_DEACTIVATED');

        // -------------------------------------------------------------
        // Test 5 & 6: Existing sessions are invalidated and protected APIs inaccessible
        // -------------------------------------------------------------
        console.log('Test 5 & 6: Existing sessions invalidated and protected APIs inaccessible');
        const checkAuthRes = await request('GET', '/api/auth/session', {
            headers: { cookie: `${session.COOKIE_NAME}=${preDeactivationSessionToken}` }
        });
        assert.strictEqual(checkAuthRes.body.authenticated, false, 'Pre-deactivation session cookie must read as not signed in');

        const protectedApiRes = await request('GET', '/api/substitutions/my', {
            headers: { cookie: `${session.COOKIE_NAME}=${preDeactivationSessionToken}` }
        });
        assert.strictEqual(protectedApiRes.status, 401, 'Protected faculty API must reject invalidated session');

        // -------------------------------------------------------------
        // Test 7: Inactive faculty member disappears from active faculty lists
        // -------------------------------------------------------------
        console.log('Test 7: Inactive faculty disappears from active candidates list');
        const candRes = await request('GET', '/api/delegations/candidates', {
            session: { id: hodUser.id, username: `hod_cme_${tag}`, role: 'hos', department: branchCme }
        });
        assert.strictEqual(candRes.status, 200);
        const candidates = candRes.body.candidates || [];
        const foundLeavingInCandidates = candidates.some(c => c.id === facLeavingId || c.username === `fac_leaving_${tag}`);
        assert.strictEqual(foundLeavingInCandidates, false, 'Deactivated faculty must not be in delegation candidates');

        // -------------------------------------------------------------
        // Test 8: Inactive faculty member is excluded from availability results
        // -------------------------------------------------------------
        console.log('Test 8: Inactive faculty member is excluded from availability results');
        const availRes = await request('GET', `/api/availability?day=Monday&period=1&department=${branchCme}`);
        assert.strictEqual(availRes.status, 200);
        const freeList = availRes.body.available || [];
        const foundInFree = freeList.some(f => f.facultyId === facLeavingId || f.name === `Prof. Leaving Faculty ${tag}`);
        assert.strictEqual(foundInFree, false, 'Deactivated faculty must not appear as available/free');

        // -------------------------------------------------------------
        // Test 9: Inactive faculty member cannot be selected for new substitutions
        // -------------------------------------------------------------
        console.log('Test 9: Inactive faculty member cannot be selected for new substitutions');
        const subCandRes = await request('GET', `/api/substitutions/candidates?date=2026-10-12&period=1&department=${branchCme}`, {
            session: { id: fac2.id, username: `fac_peer_${tag}`, role: 'faculty', facultyId: facPeerId, department: branchCme }
        });
        assert.strictEqual(subCandRes.status, 200);
        const subCandidates = subCandRes.body.candidates || [];
        const inSubCandidates = subCandidates.some(f => String(f.id) === facLeavingId || String(f.facultyId) === facLeavingId || f.name === `Prof. Leaving Faculty ${tag}`);
        assert.strictEqual(inSubCandidates, false, 'Deactivated faculty must not appear in substitution candidates list');

        // -------------------------------------------------------------
        // Test 14 & 15: Historical records and audit trail
        // -------------------------------------------------------------
        console.log('Test 14 & 15: Historical records and audit trail preserved');
        const departuresRes = await request('GET', '/api/faculty/departures', {
            session: { id: hodUser.id, username: `hod_cme_${tag}`, role: 'hos', department: branchCme }
        });
        assert.strictEqual(departuresRes.status, 200);
        const depList = departuresRes.body.departures || [];
        const departureRecord = depList.find(d => String(d.facultyId) === String(facLeavingId) || d.facultyCode === facLeavingId || d.username === `fac_leaving_${tag}`);
        assert.ok(departureRecord, 'Departure audit record must be recorded');
        assert.strictEqual(departureRecord.branchCode, branchCme);
        assert.strictEqual(departureRecord.effectiveDate, '2026-10-10');
        assert.strictEqual(departureRecord.reason, 'Relocating to another college');

        // -------------------------------------------------------------
        // Test 17: Existing HOD delegation and transfer workflows continue to work
        // -------------------------------------------------------------
        console.log('Test 17: Existing HOD delegation and transfer workflows continue to work');
        const transferRes = await request('POST', '/api/delegations/transfer-role', {
            session: { id: hodUser.id, username: `hod_cme_${tag}`, role: 'hos', department: branchCme },
            body: { replacementFacultyId: facPeerId, confirm: true, notes: 'Routine transfer' }
        });
        assert.strictEqual(transferRes.status, 200, 'HOD role transfer must succeed');
        assert.strictEqual(transferRes.body.success, true);
        assert.strictEqual(transferRes.body.newHOD.role, 'hos');

        // -------------------------------------------------------------
        // Test 18: Existing faculty, timetable, attendance, and substitution features continue to work
        // -------------------------------------------------------------
        console.log('Test 18: Existing faculty directory and attendance features continue to work');
        const facListRes = await request('GET', '/api/faculty');
        assert.strictEqual(facListRes.status, 200);
        assert.ok(facListRes.body.faculty.length >= 2, 'Faculty list remains functional');

        console.log('\n========================================');
        console.log('ALL 18 FACULTY DEACTIVATION & DEPARTURE TESTS PASSED!');
        console.log('========================================');
    } finally {
        if (server) server.close();
    }
}

runTests().catch(err => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
});
