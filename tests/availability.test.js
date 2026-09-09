/**
 * Phase A4 — Faculty Availability Engine test suite.
 *
 * Verifies:
 *  1. HOS can request availability.
 *  2. Correct day/period is accepted.
 *  3. Invalid day is rejected.
 *  4. Invalid period is rejected.
 *  5. Invalid absent faculty is rejected.
 *  6. Busy faculty is correctly reported BUSY.
 *  7. Faculty without an assignment is correctly reported FREE.
 *  8. Absent faculty is excluded from FREE results.
 *  9. Faculty explicitly assigned to a slot is BUSY.
 * 10. Unassigned institutional activity does not make all faculty BUSY.
 * 11. Only current-branch faculty are returned.
 * 12. Faculty cannot manipulate branch context.
 * 13. Faculty cannot access an HOS-only availability operation if the existing authorization model requires HOS.
 * 14. No automatic substitute assignment is created.
 * 15. No substitute is persisted anywhere.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3402;
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
    console.log('TecSubstitution — Phase A4 Faculty Availability Engine tests\n');

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

        // Fetch accounts
        const accountsRes = await call('GET', '/api/auth/accounts');
        assert.strictEqual(accountsRes.status, 200);
        const facultyAccounts = accountsRes.body.accounts.filter(a => a.role === 'faculty');
        assert.ok(facultyAccounts.length >= 2, 'Need at least two faculty accounts for availability testing');

        const facA = facultyAccounts[0]; // e.g. Dr. A. Sharma
        const facB = facultyAccounts[1]; // e.g. Prof. B. Patel

        // Sign in HOS
        const loginHOS = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOS.status, 200);
        const cookieHOS = loginHOS.cookie;

        // Sign in Faculty A
        const loginA = await call('POST', '/api/auth/login', { username: facA.username, password: 'tecsub123' });
        assert.strictEqual(loginA.status, 200);
        const cookieA = loginA.cookie;

        // References
        const refRes = await call('GET', '/api/timetable/entries/reference');
        assert.strictEqual(refRes.status, 200);
        const testClass = refRes.body.classes[0].code;
        const testSubject = refRes.body.subjects[0].name;

        // Setup test entries via HOS
        // Entry 1: Faculty A teaches Monday P1
        const entry1 = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: 'Monday',
            period: 1,
            subject: testSubject,
            faculty: facA.name,
            room: 'C-101',
            type: 'theory'
        }, cookieHOS);
        assert.strictEqual(entry1.status, 201);

        // Entry 2: Unassigned institutional activity on Tuesday P2 (Library)
        const entry2 = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: 'Tuesday',
            period: 2,
            subject: 'Library',
            faculty: null,
            room: 'LIB-1',
            type: 'activity'
        }, cookieHOS);
        assert.strictEqual(entry2.status, 201);

        // Entry 3: Explicitly assigned institutional activity on Wednesday P3 (Sports with Faculty B)
        const entry3 = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: 'Wednesday',
            period: 3,
            subject: 'Sports',
            faculty: facB.name,
            room: 'GROUND',
            type: 'activity'
        }, cookieHOS);
        assert.strictEqual(entry3.status, 201);

        // Record initial count of entries
        const initialEntries = await call('GET', '/api/timetable/entries', null, cookieHOS);
        const initialCount = initialEntries.body.count;

        // ==============================================================
        // [1] Core Availability Queries
        // ==============================================================
        console.log('[1] Core Availability Queries');

        const hosAvail = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            absentFaculty: facA.name
        }, cookieHOS);

        check('HOS can request availability', () => {
            assert.strictEqual(hosAvail.status, 200, JSON.stringify(hosAvail.body));
            assert.strictEqual(hosAvail.body.readOnly, true);
        });

        check('Correct day/period is accepted and returned', () => {
            assert.strictEqual(hosAvail.body.day, 'Monday');
            assert.strictEqual(hosAvail.body.period, 1);
            assert.strictEqual(hosAvail.body.branch, 'CIV');
        });

        const badDay = await call('POST', '/api/availability', {
            day: 'Holiday',
            period: 1,
            absentFaculty: facA.name
        }, cookieHOS);

        check('Invalid day is rejected with 400 INVALID_DAY', () => {
            assert.strictEqual(badDay.status, 400);
            assert.strictEqual(badDay.body.code, 'INVALID_DAY');
        });

        const badPeriod = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 99,
            absentFaculty: facA.name
        }, cookieHOS);

        check('Invalid period is rejected with 400 INVALID_PERIOD', () => {
            assert.strictEqual(badPeriod.status, 400);
            assert.strictEqual(badPeriod.body.code, 'INVALID_PERIOD');
        });

        const badFaculty = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            absentFaculty: 'NonExistent Phantom Faculty'
        }, cookieHOS);

        check('Invalid absent faculty is rejected with 400 UNKNOWN_FACULTY', () => {
            assert.strictEqual(badFaculty.status, 400);
            assert.strictEqual(badFaculty.body.code, 'UNKNOWN_FACULTY');
        });

        // ==============================================================
        // [2] Free / Busy / Absent Determination
        // ==============================================================
        console.log('\n[2] Free / Busy / Absent Determination');

        // Slot: Monday P1 without absent faculty: Faculty A is teaching (BUSY), Faculty B has no class (FREE)
        const slotMonP1 = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1
        }, cookieHOS);

        check('Busy faculty is correctly reported BUSY', () => {
            assert.strictEqual(slotMonP1.status, 200);
            const busyMember = slotMonP1.body.busy.find(f => f.faculty === facA.name);
            assert.ok(busyMember, 'Faculty A must appear in busy list');
            assert.strictEqual(busyMember.status, 'busy');
            assert.strictEqual(busyMember.subject, testSubject);

            const unifiedMember = slotMonP1.body.faculty.find(f => f.name === facA.name);
            assert.ok(unifiedMember);
            assert.strictEqual(unifiedMember.status, 'BUSY');
        });

        check('Faculty without an assignment is correctly reported FREE', () => {
            assert.strictEqual(slotMonP1.status, 200);
            const freeMember = slotMonP1.body.available.find(f => f.faculty === facB.name);
            assert.ok(freeMember, 'Faculty B must appear in available list');
            assert.strictEqual(freeMember.status, 'free');
            assert.ok(slotMonP1.body.availableFaculty.includes(facB.name));

            const unifiedMember = slotMonP1.body.faculty.find(f => f.name === facB.name);
            assert.ok(unifiedMember);
            assert.strictEqual(unifiedMember.status, 'FREE');
        });

        // Slot: Monday P2 (where Faculty A has no class): When Faculty A is absent, Faculty A must NOT appear as FREE
        const slotMonP2AbsentA = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 2,
            absentFaculty: facA.name
        }, cookieHOS);

        check('Absent faculty is excluded from FREE results', () => {
            assert.strictEqual(slotMonP2AbsentA.status, 200);
            assert.strictEqual(slotMonP2AbsentA.body.absentFaculty.name, facA.name);
            assert.ok(!slotMonP2AbsentA.body.availableFaculty.includes(facA.name), 'Absent faculty must not be in availableFaculty');
            assert.ok(!slotMonP2AbsentA.body.available.some(f => f.faculty === facA.name), 'Absent faculty must not be in available list');
            const freeInUnified = slotMonP2AbsentA.body.faculty.find(f => f.name === facA.name && f.status === 'FREE');
            assert.strictEqual(freeInUnified, undefined, 'Absent faculty must never be returned with status FREE');
        });

        // ==============================================================
        // [3] Special Institutional Activities
        // ==============================================================
        console.log('\n[3] Special Activities Handling');

        // Wednesday P3: Sports with Faculty B explicitly assigned
        const slotWedP3 = await call('POST', '/api/availability', {
            day: 'Wednesday',
            period: 3
        }, cookieHOS);

        check('Faculty explicitly assigned to a slot is BUSY even for institutional activity', () => {
            assert.strictEqual(slotWedP3.status, 200);
            const busyMember = slotWedP3.body.busy.find(f => f.faculty === facB.name);
            assert.ok(busyMember, 'Faculty B must be reported busy for assigned activity');
            assert.strictEqual(busyMember.subject, 'Sports');
        });

        // Tuesday P2: Library with NO faculty assigned
        const slotTueP2 = await call('POST', '/api/availability', {
            day: 'Tuesday',
            period: 2
        }, cookieHOS);

        check('Unassigned institutional activity does not make all faculty BUSY', () => {
            assert.strictEqual(slotTueP2.status, 200);
            assert.strictEqual(slotTueP2.body.totalBusy, 0, 'No faculty should be marked busy for unassigned Library slot');
            assert.strictEqual(slotTueP2.body.busy.length, 0);
            assert.ok(slotTueP2.body.availableFaculty.includes(facA.name));
            assert.ok(slotTueP2.body.availableFaculty.includes(facB.name));
        });

        // ==============================================================
        // [4] Single Branch & Authorization
        // ==============================================================
        console.log('\n[4] Single-Branch & Role Authorization');

        check('Only current-branch faculty are returned in results', () => {
            assert.strictEqual(hosAvail.body.branch, 'CIV');
            hosAvail.body.faculty.forEach(f => {
                assert.strictEqual(f.department, 'CIV');
            });
        });

        const crossDept = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            department: 'MEC'
        }, cookieHOS);

        check('Cross-branch query attempt is rejected with 403 FORBIDDEN', () => {
            assert.strictEqual(crossDept.status, 403);
            assert.strictEqual(crossDept.body.code, 'FORBIDDEN');
        });

        const facHOSOp = await call('POST', '/api/availability/hos', {
            day: 'Monday',
            period: 1
        }, cookieA);

        check('Faculty cannot access HOS-only availability operation (403 FORBIDDEN)', () => {
            assert.strictEqual(facHOSOp.status, 403);
            assert.strictEqual(facHOSOp.body.code, 'FORBIDDEN');
        });

        const facAbsentQuery = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            absentFaculty: facB.name
        }, cookieA);

        check('Faculty cannot query availability with absent faculty selection (403 FORBIDDEN)', () => {
            assert.strictEqual(facAbsentQuery.status, 403);
            assert.strictEqual(facAbsentQuery.body.code, 'FORBIDDEN');
        });

        // ==============================================================
        // [5] Read-Only Guarantee (No Substitution Mutation or Persistence)
        // ==============================================================
        console.log('\n[5] Read-Only Guarantee');

        const finalEntries = await call('GET', '/api/timetable/entries', null, cookieHOS);
        check('No automatic substitute assignment is created or saved', () => {
            assert.strictEqual(finalEntries.body.count, initialCount);
        });

        const finalRecords = await call('GET', '/api/timetable/records?day=Monday&period=1', null, cookieHOS);
        check('Timetable records remain untouched by availability queries', () => {
            const entryA = finalRecords.body.records.find(r => r.faculty === facA.name);
            assert.ok(entryA);
            assert.strictEqual(entryA.status, 'busy');
        });

        console.log('\n✅ availability engine tests: all checks passed.');
    } finally {
        server.kill();
    }
}

run().catch(err => {
    console.error('Fatal test failure:', err);
    process.exit(1);
});
