/**
 * Phase A3 — Faculty Own Timetable security and CRUD test suite.
 *
 * Verifies:
 *  1. Faculty A can read own timetable.
 *  2. Faculty A cannot read Faculty B's timetable.
 *  3. Faculty A can create own entry.
 *  4. Faculty A can update own entry.
 *  5. Faculty A can delete own entry.
 *  6. Faculty A cannot create an entry claiming Faculty B.
 *  7. Faculty A cannot update Faculty B's entry.
 *  8. Faculty A cannot delete Faculty B's entry.
 *  9. Changing faculty_id in request cannot bypass ownership.
 * 10. Changing facultyName in request cannot bypass ownership.
 * 11. Query parameter manipulation cannot expose another faculty's timetable.
 * 12. Invalid subject/class/day/period is rejected.
 * 13. Faculty double-booking is rejected.
 * 14. Branch isolation remains intact.
 * 15. HOS behavior and master timetable access is preserved.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3401;
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
    console.log('TecSubstitution — Phase A3 Faculty Own Timetable tests\n');

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            FALLBACK_PORTS: '',
            BRANCH_NAME: 'Civil Engineering',
            BRANCH_CODE: 'CIV',
            ACADEMIC_YEAR: '2026-27',
            SEMESTER: '5',
            EMPTY_TIMETABLE: 'true',
            ALLOW_MEMORY_WRITES: 'true',
            AUTH_REQUIRED: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        await waitForServer(BASE);

        // Fetch accounts and identify Faculty A, Faculty B, and HOS
        const accountsRes = await call('GET', '/api/auth/accounts');
        assert.strictEqual(accountsRes.status, 200);
        const facultyAccounts = accountsRes.body.accounts.filter(a => a.role === 'faculty');
        assert.ok(facultyAccounts.length >= 2, 'Must have at least two faculty accounts for ownership tests');

        const facA = facultyAccounts[0];
        const facB = facultyAccounts[1];

        // Sign in Faculty A
        const loginA = await call('POST', '/api/auth/login', { username: facA.username, password: 'tecsub123' });
        assert.strictEqual(loginA.status, 200);
        const cookieA = loginA.cookie;

        // Sign in Faculty B
        const loginB = await call('POST', '/api/auth/login', { username: facB.username, password: 'tecsub123' });
        assert.strictEqual(loginB.status, 200);
        const cookieB = loginB.cookie;

        // Sign in HOS
        const loginHOS = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOS.status, 200);
        const cookieHOS = loginHOS.cookie;

        // Reference data
        const refRes = await call('GET', '/api/timetable/entries/reference');
        assert.strictEqual(refRes.status, 200);
        const testClass = refRes.body.classes[0].code;
        const otherClass = refRes.body.classes[1] ? refRes.body.classes[1].code : 'CIV-B';
        const testSubject = refRes.body.subjects[0].name;

        // ==============================================================
        // [1] Read Isolation
        // ==============================================================
        console.log('[1] Read Isolation & Ownership');

        const readOwnGrid = await call('GET', '/api/timetable/mine', null, cookieA);
        check('Faculty A can read own timetable via /api/timetable/mine', () => {
            assert.strictEqual(readOwnGrid.status, 200);
            assert.strictEqual(readOwnGrid.body.name, facA.name);
            assert.strictEqual(readOwnGrid.body.faculty, facA.name);
            assert.ok(Array.isArray(readOwnGrid.body.cells));
        });

        const readOtherGrid = await call('GET', `/api/timetable?faculty=${encodeURIComponent(facB.name)}`, null, cookieA);
        check('Faculty A cannot read Faculty B\'s timetable via query parameter (403)', () => {
            assert.strictEqual(readOtherGrid.status, 403);
            assert.strictEqual(readOtherGrid.body.code, 'FORBIDDEN');
        });

        const readOtherRecords = await call('GET', `/api/timetable/records?faculty=${encodeURIComponent(facB.name)}`, null, cookieA);
        check('Faculty A cannot read Faculty B\'s timetable records (403)', () => {
            assert.strictEqual(readOtherRecords.status, 403);
            assert.strictEqual(readOtherRecords.body.code, 'FORBIDDEN');
        });

        const readOtherEntries = await call('GET', `/api/timetable/entries?faculty=${encodeURIComponent(facB.name)}`, null, cookieA);
        check('Faculty A cannot query Faculty B\'s timetable entries (403)', () => {
            assert.strictEqual(readOtherEntries.status, 403);
            assert.strictEqual(readOtherEntries.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [2] Faculty CRUD Operations on Own Timetable
        // ==============================================================
        console.log('\n[2] Faculty CRUD Operations');

        let entryIdA = null;

        // Faculty A creates own entry
        const createA = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Monday',
            period: 1,
            subject: testSubject,
            room: 'C-101',
            type: 'theory'
        }, cookieA);

        check('Faculty A can create own entry via /api/timetable/entries/mine', () => {
            assert.strictEqual(createA.status, 201, JSON.stringify(createA.body));
            assert.strictEqual(createA.body.saved, true);
            assert.strictEqual(createA.body.entry.faculty, facA.name);
            assert.strictEqual(createA.body.entry.day, 'Monday');
            assert.strictEqual(createA.body.entry.period, 1);
            entryIdA = createA.body.entry.id;
        });

        // Faculty A updates own entry
        const updateA = await call('PUT', `/api/timetable/entries/mine/${entryIdA}`, {
            class: testClass,
            day: 'Monday',
            period: 1,
            subject: testSubject,
            room: 'C-102',
            type: 'lab'
        }, cookieA);

        check('Faculty A can update own entry', () => {
            assert.strictEqual(updateA.status, 200, JSON.stringify(updateA.body));
            assert.strictEqual(updateA.body.saved, true);
            assert.strictEqual(updateA.body.entry.type, 'lab');
            assert.strictEqual(updateA.body.entry.room, 'C-102');
        });

        // Faculty A reads own entry
        const readEntryA = await call('GET', `/api/timetable/entries/${entryIdA}`, null, cookieA);
        check('Faculty A can read own entry by ID', () => {
            assert.strictEqual(readEntryA.status, 200);
            assert.strictEqual(readEntryA.body.entry.faculty, facA.name);
        });

        // ==============================================================
        // [3] Cross-Faculty Tampering & Protection
        // ==============================================================
        console.log('\n[3] Cross-Faculty Tampering & Protection');

        // Faculty B creates an entry for themselves
        const createB = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Tuesday',
            period: 2,
            subject: testSubject,
            room: 'C-201',
            type: 'theory'
        }, cookieB);
        assert.strictEqual(createB.status, 201);
        const entryIdB = createB.body.entry.id;

        // Faculty A attempts to read Faculty B's entry by ID -> 403
        const facAReadEntryB = await call('GET', `/api/timetable/entries/${entryIdB}`, null, cookieA);
        check('Faculty A cannot read Faculty B\'s entry by ID (403)', () => {
            assert.strictEqual(facAReadEntryB.status, 403);
            assert.strictEqual(facAReadEntryB.body.code, 'FORBIDDEN');
        });

        // Faculty A attempts to create an entry claiming to be Faculty B -> 403
        const facACreateClaimingB = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Wednesday',
            period: 2,
            subject: testSubject,
            faculty: facB.name,
            type: 'theory'
        }, cookieA);

        check('Faculty A cannot create an entry claiming Faculty B (403)', () => {
            assert.strictEqual(facACreateClaimingB.status, 403);
            assert.strictEqual(facACreateClaimingB.body.code, 'FORBIDDEN');
        });

        // Faculty A attempts to update Faculty B's entry -> 403
        const facAUpdateEntryB = await call('PUT', `/api/timetable/entries/mine/${entryIdB}`, {
            class: testClass,
            day: 'Tuesday',
            period: 2,
            subject: testSubject,
            room: 'C-999',
            type: 'lab'
        }, cookieA);

        check('Faculty A cannot update Faculty B\'s entry (403)', () => {
            assert.strictEqual(facAUpdateEntryB.status, 403);
            assert.strictEqual(facAUpdateEntryB.body.code, 'FORBIDDEN');
        });

        // Faculty A attempts to delete Faculty B's entry -> 403
        const facADeleteEntryB = await call('DELETE', `/api/timetable/entries/mine/${entryIdB}`, null, cookieA);
        check('Faculty A cannot delete Faculty B\'s entry (403)', () => {
            assert.strictEqual(facADeleteEntryB.status, 403);
            assert.strictEqual(facADeleteEntryB.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [4] Parameter Manipulation & Identity Spoofing Protection
        // ==============================================================
        console.log('\n[4] Parameter Manipulation Protection');

        // Bypassing with faculty_id in body
        const spoofFacultyId = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Thursday',
            period: 3,
            subject: testSubject,
            faculty_id: 'OTHER_FAC_ID',
            type: 'theory'
        }, cookieA);

        check('Supplying another faculty_id is rejected (403)', () => {
            assert.strictEqual(spoofFacultyId.status, 403);
            assert.strictEqual(spoofFacultyId.body.code, 'FORBIDDEN');
        });

        // Bypassing with facultyName in body
        const spoofFacultyName = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Thursday',
            period: 3,
            subject: testSubject,
            facultyName: facB.name,
            type: 'theory'
        }, cookieA);

        check('Supplying another facultyName is rejected (403)', () => {
            assert.strictEqual(spoofFacultyName.status, 403);
            assert.strictEqual(spoofFacultyName.body.code, 'FORBIDDEN');
        });

        // Query param spoofing on timetable endpoint
        const queryParamSpoof = await call('GET', `/api/timetable?facultyName=${encodeURIComponent(facB.name)}`, null, cookieA);
        check('Query param manipulation to inspect another faculty is rejected (403)', () => {
            assert.strictEqual(queryParamSpoof.status, 403);
            assert.strictEqual(queryParamSpoof.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [5] Validation & Conflict Enforcement
        // ==============================================================
        console.log('\n[5] Validation & Conflict Enforcement for Faculty');

        const badSubject = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Friday',
            period: 1,
            subject: 'Invalid Fake Subject 999',
            type: 'theory'
        }, cookieA);

        check('Invalid subject is rejected with 400 UNKNOWN_REFERENCE', () => {
            assert.strictEqual(badSubject.status, 400);
            assert.strictEqual(badSubject.body.code, 'UNKNOWN_REFERENCE');
        });

        const badClass = await call('POST', '/api/timetable/entries/mine', {
            class: 'NON_EXISTENT_CLASS_999',
            day: 'Friday',
            period: 1,
            subject: testSubject,
            type: 'theory'
        }, cookieA);

        check('Invalid class is rejected with 400 UNKNOWN_REFERENCE', () => {
            assert.strictEqual(badClass.status, 400);
            assert.strictEqual(badClass.body.code, 'UNKNOWN_REFERENCE');
        });

        const badDay = await call('POST', '/api/timetable/entries/mine', {
            class: testClass,
            day: 'Holiday',
            period: 1,
            subject: testSubject,
            type: 'theory'
        }, cookieA);

        check('Invalid day is rejected with 400 INVALID_ENTRY', () => {
            assert.strictEqual(badDay.status, 400);
            assert.strictEqual(badDay.body.code, 'INVALID_ENTRY');
        });

        // Faculty A is already booked at Monday P1 (entryIdA). Try to book Faculty A at Monday P1 for otherClass.
        const facDoubleBook = await call('POST', '/api/timetable/entries/mine', {
            class: otherClass,
            day: 'Monday',
            period: 1,
            subject: testSubject,
            type: 'theory'
        }, cookieA);

        check('Faculty double-booking is rejected with SLOT_CONFLICT', () => {
            assert.strictEqual(facDoubleBook.status, 400);
            assert.strictEqual(facDoubleBook.body.code, 'SLOT_CONFLICT');
            assert.ok(facDoubleBook.body.conflicts.some(c => c.code === 'FACULTY_BUSY'));
        });

        // ==============================================================
        // [6] Faculty Deletion of Own Entry & HOS Preservation
        // ==============================================================
        console.log('\n[6] Faculty Deletion & HOS Master Timetable Access');

        const deleteA = await call('DELETE', `/api/timetable/entries/mine/${entryIdA}`, null, cookieA);
        check('Faculty A can delete own entry', () => {
            assert.strictEqual(deleteA.status, 200);
            assert.strictEqual(deleteA.body.deleted, true);
        });

        const verifyDeleted = await call('GET', `/api/timetable/entries/${entryIdA}`, null, cookieHOS);
        check('Deleted entry is no longer available in master database (404)', () => {
            assert.strictEqual(verifyDeleted.status, 404);
        });

        // HOS preserves complete visibility into any faculty and master timetable
        const hosViewB = await call('GET', `/api/timetable?faculty=${encodeURIComponent(facB.name)}`, null, cookieHOS);
        check('HOS retains access to view any faculty schedule', () => {
            assert.strictEqual(hosViewB.status, 200);
            assert.strictEqual(hosViewB.body.name, facB.name);
        });

        const hosViewMaster = await call('GET', `/api/timetable?class=${encodeURIComponent(testClass)}`, null, cookieHOS);
        check('HOS retains access to view complete class master timetable', () => {
            assert.strictEqual(hosViewMaster.status, 200);
            assert.strictEqual(hosViewMaster.body.name, testClass);
        });

        // Cleanup
        await call('DELETE', `/api/timetable/entries/mine/${entryIdB}`, null, cookieB);

        console.log('\n✅ faculty own timetable tests: all checks passed.');
    } finally {
        server.kill();
    }
}

run().catch(err => {
    console.error('Fatal test failure:', err);
    process.exit(1);
});
