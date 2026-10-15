const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const pool = require('../src/db/pool');
const { validateExtractedContract } = require('../src/core/contractValidator');
const { resolveContract } = require('../src/core/entityResolver');
const { saveStagedData, getStagedData } = require('../src/data/uploads');

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

function makeRequest(method, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, baseUrl);
        const req = http.request(url, { method, headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function loginAs(username, password) {
    const res = await makeRequest('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { username, password });
    assert.strictEqual(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.body)}`);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie.map(c => c.split(';')[0]).join('; ') : cookie.split(';')[0];
}

async function runTests() {
    console.log('================================================================');
    console.log('F.A.S.T. — CANNOT APPROVE (INVALID) ROOT CAUSE & FIX VERIFICATION');
    console.log('================================================================\n');

    await startServer();

    try {
        // --- TEST 1: Initial Staged State has clear validation errors and conflicts ---
        console.log('[Test 1] Verify invalid staged timetable returns explicit error details');
        const uploadId = 'upl_mv6vb0fk_c4a4308574a9';
        
        // Log in as CME HOS
        const cookie = await loginAs('cme_hos', 'Cme_password1');

        const getRes = await makeRequest('GET', `/api/staging/${uploadId}`, { Cookie: cookie });
        assert.strictEqual(getRes.status, 200);
        assert.strictEqual(getRes.body.validationStatus, 'INVALID', 'Staged upload with Wednesday P3 double booking must be INVALID');
        assert.ok(Array.isArray(getRes.body.validationErrors), 'validationErrors must be an array, not null');
        assert.ok(getRes.body.validationErrors.length > 0, 'validationErrors must contain the conflict error');
        
        const conflictMessage = getRes.body.validationErrors.map(e => e.message || e).join(' ');
        console.log('  Validation error surfaced to user:', conflictMessage);
        assert.ok(conflictMessage.includes('conflicting entries at Wednesday P3') || conflictMessage.includes('CLASS_BUSY'), 'Conflict error must specifically mention Wednesday P3 collision');
        console.log('  ✓ Test 1 Passed: Invalid timetable returns explicit conflict error.\n');

        // --- TEST 2: Attempting approval on invalid timetable returns HTTP 422 with exact reasons ---
        console.log('[Test 2] Verify approval gate strictly blocks invalid timetable with full error details');
        const appRes = await makeRequest('POST', `/api/staging/${uploadId}/approve`, {
            Cookie: cookie,
            'Content-Type': 'application/json'
        }, {
            targetScope: { branch: 'CME', academicYear: '2026-2027', semester: '4', section: 'A' }
        });
        assert.strictEqual(appRes.status, 422, 'Cannot approve invalid timetable (must be HTTP 422)');
        assert.strictEqual(appRes.body.code, 'CANNOT_APPROVE_INVALID_DATA');
        assert.ok(Array.isArray(appRes.body.validationErrors) && appRes.body.validationErrors.length > 0, 'Approval failure must include validationErrors array');
        console.log('  Approval rejection code:', appRes.body.code);
        console.log('  Rejection details:', appRes.body.validationErrors);
        console.log('  ✓ Test 2 Passed: Approval gate rejects invalid timetable and returns exact reasons.\n');

        // --- TEST 3: Editing to clear the conflicting slot makes the timetable VALID ---
        console.log('[Test 3] Verify editing/clearing the conflicting slot updates validationStatus to VALID');
        // Clear Wednesday P3 (mark as free)
        const clearRes = await makeRequest('PUT', `/api/staging/${uploadId}/entry`, {
            Cookie: cookie,
            'Content-Type': 'application/json'
        }, {
            day: 'Wednesday',
            period: 3,
            is_free: true
        });
        assert.strictEqual(clearRes.status, 200, `Clearing slot must return 200: ${JSON.stringify(clearRes.body)}`);
        assert.strictEqual(clearRes.body.validationStatus, 'VALID', 'After clearing conflict, timetable must be VALID');
        assert.strictEqual(clearRes.body.validationErrors, null, 'After clearing conflict, validationErrors must be null');
        console.log('  Updated validation status:', clearRes.body.validationStatus);
        console.log('  Updated validation errors:', clearRes.body.validationErrors);
        console.log('  ✓ Test 3 Passed: Clearing conflict makes timetable VALID.\n');

        // --- TEST 4: Empty periods remain valid and allowed ---
        console.log('[Test 4] Verify empty/free periods remain valid');
        const addFreeRes = await makeRequest('PUT', `/api/staging/${uploadId}/entry`, {
            Cookie: cookie,
            'Content-Type': 'application/json'
        }, {
            day: 'Monday',
            period: 7,
            is_free: true
        });
        assert.strictEqual(addFreeRes.status, 200);
        assert.strictEqual(addFreeRes.body.validationStatus, 'VALID', 'Free periods must remain valid');
        console.log('  ✓ Test 4 Passed: Free periods remain valid.\n');

        // --- TEST 5: Verify zero faculty records were auto-created in the database ---
        console.log('[Test 5] Verify no faculty records were auto-created or seeded in the database');
        const facCount = await pool.query('SELECT count(*)::int as count FROM faculty');
        console.log('  Faculty table count in database:', facCount.rows[0].count);
        assert.strictEqual(facCount.rows[0].count, 0, 'Faculty table must remain at 0 records (no auto-seeding)');
        console.log('  ✓ Test 5 Passed: Zero faculty records auto-created.\n');

        // --- TEST 6: Branch isolation: EEE HOS cannot access or approve CME upload ---
        console.log('[Test 6] Verify branch isolation: EEE HOS cannot access CME timetable');
        const eeeCookie = await loginAs('eee_hos', 'Eee_password1');
        const eeeGet = await makeRequest('GET', `/api/staging/${uploadId}`, { Cookie: eeeCookie });
        assert.strictEqual(eeeGet.status, 403, 'Cross-branch access must return 403 Forbidden');
        const eeeApprove = await makeRequest('POST', `/api/staging/${uploadId}/approve`, {
            Cookie: eeeCookie,
            'Content-Type': 'application/json'
        }, { targetScope: { branch: 'EEE' } });
        assert.strictEqual(eeeApprove.status, 403, 'Cross-branch approval must return 403 Forbidden');
        console.log('  ✓ Test 6 Passed: CME and EEE remain strictly isolated.\n');

        // Restore Wednesday P3 conflict for state integrity if desired
        console.log('================================================================');
        console.log('ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY!');
        console.log('================================================================\n');
    } finally {
        await stopServer();
        await pool.close();
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
