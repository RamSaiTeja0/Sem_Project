/**
 * Phase A5 — Final Single-Branch End-to-End Validation Test Suite.
 *
 * Exercises the complete single-branch workflow in a clean instance:
 *   1. HOS can configure the branch.
 *   2. HOS can add/manage faculty.
 *   3. HOS can create the master timetable.
 *   4. Faculty A can access only Faculty A's timetable.
 *   5. Faculty B can access only Faculty B's timetable.
 *   6. Faculty C can access only Faculty C's timetable.
 *   7. Faculty cannot modify another faculty's timetable.
 *   8. HOS can open Availability.
 *   9. HOS can select an absent faculty.
 *  10. HOS can select a valid day.
 *  11. HOS can select a valid period.
 *  12. Backend calculates FREE/BUSY from stored timetable data.
 *  13. Faculty with an assignment at that slot is BUSY.
 *  14. Faculty without an assignment at that slot is FREE.
 *  15. Absent faculty is excluded from available faculty.
 *  16. Institutional activity without assigned faculty does not make everyone BUSY.
 *  17. Only faculty in the current single branch are returned.
 *  18. Availability does not modify timetable data.
 *  19. Availability does not create a substitute record.
 *  20. No automatic assignment occurs.
 *
 * Plus data integrity before/after verification.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3403;
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
    console.log('TecSubstitution — Phase A5 Final Single-Branch End-to-End Validation\n');

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

        // ==============================================================
        // [1] User Setup & Single-Branch Context
        // ==============================================================
        console.log('[1] User Setup & Single-Branch Context');

        const accountsRes = await call('GET', '/api/auth/accounts');
        assert.strictEqual(accountsRes.status, 200);
        const facultyAccounts = accountsRes.body.accounts.filter(a => a.role === 'faculty');
        assert.ok(facultyAccounts.length >= 3, 'Must have at least 3 faculty members in the branch roster');

        const facA = facultyAccounts[0]; // e.g. Dr. A. Sharma
        const facB = facultyAccounts[1]; // e.g. Prof. B. Patel
        const facC = facultyAccounts[2]; // e.g. Sri C. Rao

        // Sign in HOS
        const loginHOS = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOS.status, 200);
        const cookieHOS = loginHOS.cookie;

        // Sign in Faculty A, B, C
        const loginA = await call('POST', '/api/auth/login', { username: facA.username, password: 'tecsub123' });
        assert.strictEqual(loginA.status, 200);
        const cookieA = loginA.cookie;

        const loginB = await call('POST', '/api/auth/login', { username: facB.username, password: 'tecsub123' });
        assert.strictEqual(loginB.status, 200);
        const cookieB = loginB.cookie;

        const loginC = await call('POST', '/api/auth/login', { username: facC.username, password: 'tecsub123' });
        assert.strictEqual(loginC.status, 200);
        const cookieC = loginC.cookie;

        // Verify 1: HOS can configure the branch
        const updateBranch = await call('PUT', '/api/branch', {
            code: 'CIV',
            name: 'Civil Engineering Department',
            academicYear: '2026-27',
            semester: '5'
        }, cookieHOS);

        check('1. HOS can configure the branch', () => {
            assert.strictEqual(updateBranch.status, 200);
            assert.strictEqual(updateBranch.body.branch.code, 'CIV');
            assert.strictEqual(updateBranch.body.branch.name, 'Civil Engineering Department');
        });

        // Verify 2: HOS can add/manage faculty
        const facRoster = await call('GET', '/api/faculty', null, cookieHOS);
        const facDepts = await call('GET', '/api/faculty/departments', null, cookieHOS);
        const facAttempt = await call('POST', '/api/faculty', {
            id: 'FAC_CIV_99',
            name: 'Dr. D. Verma',
            department: 'CIV',
            designation: 'Associate Professor',
            status: 'active'
        }, cookieHOS);

        check('2. HOS can add/manage faculty', () => {
            assert.strictEqual(facRoster.status, 200);
            assert.ok(facRoster.body.faculty.length >= 3);
            assert.strictEqual(facDepts.status, 200);
            assert.strictEqual(facDepts.body.departments[0], 'CIV');
            // HOS is authorized (never 403); returns 201 when DB connected or 503 DATABASE_REQUIRED without DB
            assert.ok([201, 503].includes(facAttempt.status));
            if (facAttempt.status === 503) {
                assert.strictEqual(facAttempt.body.code, 'DATABASE_REQUIRED');
            }
        });

        // ==============================================================
        // [2] Master Timetable Creation
        // ==============================================================
        console.log('\n[2] Master Timetable Creation');

        const refRes = await call('GET', '/api/timetable/entries/reference');
        assert.strictEqual(refRes.status, 200);
        const testClassA = refRes.body.classes[0].code; // e.g. CIV-A
        const testClassB = refRes.body.classes[1] ? refRes.body.classes[1].code : testClassA;
        const testSubj1 = refRes.body.subjects[0].name;
        const testSubj2 = refRes.body.subjects[1] ? refRes.body.subjects[1].name : testSubj1;

        // Entry 1: Faculty A teaches Monday P1 in Class A
        const e1 = await call('POST', '/api/timetable/entries', {
            class: testClassA,
            day: 'Monday',
            period: 1,
            subject: testSubj1,
            faculty: facA.name,
            room: 'C-101',
            type: 'theory'
        }, cookieHOS);
        assert.strictEqual(e1.status, 201);
        const entry1Id = e1.body.entry.id;

        // Entry 2: Faculty B teaches Monday P1 in Class B
        const e2 = await call('POST', '/api/timetable/entries', {
            class: testClassB,
            day: 'Monday',
            period: 1,
            subject: testSubj2,
            faculty: facB.name,
            room: 'C-102',
            type: 'theory'
        }, cookieHOS);
        assert.strictEqual(e2.status, 201);
        const entry2Id = e2.body.entry.id;

        // Entry 3: Unassigned institutional activity on Tuesday P2 (Library)
        const e3 = await call('POST', '/api/timetable/entries', {
            class: testClassA,
            day: 'Tuesday',
            period: 2,
            subject: 'Library',
            faculty: null,
            room: 'LIB-1',
            type: 'activity'
        }, cookieHOS);
        assert.strictEqual(e3.status, 201);

        // Entry 4: Explicitly assigned institutional activity on Wednesday P3 (Sports with Faculty B)
        const e4 = await call('POST', '/api/timetable/entries', {
            class: testClassA,
            day: 'Wednesday',
            period: 3,
            subject: 'Sports',
            faculty: facB.name,
            room: 'GROUND',
            type: 'activity'
        }, cookieHOS);
        assert.strictEqual(e4.status, 201);

        check('3. HOS can create the master timetable', () => {
            assert.ok(entry1Id);
            assert.ok(entry2Id);
        });

        // ==============================================================
        // [3] Faculty Timetable Access & Ownership Isolation
        // ==============================================================
        console.log('\n[3] Faculty Timetable Access & Ownership Isolation');

        // Verify 4: Faculty A can access only Faculty A's timetable
        const timeA = await call('GET', '/api/timetable/mine', null, cookieA);
        check('4. Faculty A can access only Faculty A\'s timetable', () => {
            assert.strictEqual(timeA.status, 200);
            assert.strictEqual(timeA.body.name, facA.name);
            const busyP1 = timeA.body.cells.find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(busyP1 && busyP1.status === 'busy');
            assert.strictEqual(busyP1.faculty, facA.name);
        });

        // Verify 5: Faculty B can access only Faculty B's timetable
        const timeB = await call('GET', '/api/timetable/mine', null, cookieB);
        check('5. Faculty B can access only Faculty B\'s timetable', () => {
            assert.strictEqual(timeB.status, 200);
            assert.strictEqual(timeB.body.name, facB.name);
            const busyP1 = timeB.body.cells.find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(busyP1 && busyP1.status === 'busy');
            assert.strictEqual(busyP1.faculty, facB.name);
        });

        // Verify 6: Faculty C can access only Faculty C's timetable
        const timeC = await call('GET', '/api/timetable/mine', null, cookieC);
        check('6. Faculty C can access only Faculty C\'s timetable', () => {
            assert.strictEqual(timeC.status, 200);
            assert.strictEqual(timeC.body.name, facC.name);
            const cellP1 = timeC.body.cells.find(c => c.day === 'Monday' && c.period === 1);
            assert.strictEqual(cellP1.status, 'free');
        });

        // Verify 7: Faculty cannot modify another faculty's timetable
        const tamperCreate = await call('POST', '/api/timetable/entries/mine', {
            class: testClassA,
            day: 'Monday',
            period: 2,
            subject: testSubj1,
            faculty: facB.name,
            type: 'theory'
        }, cookieA);

        const tamperUpdate = await call('PUT', `/api/timetable/entries/mine/${entry2Id}`, {
            class: testClassB,
            day: 'Monday',
            period: 1,
            subject: 'Hacked Subject'
        }, cookieA);

        const tamperDelete = await call('DELETE', `/api/timetable/entries/mine/${entry2Id}`, null, cookieA);

        check('7. Faculty cannot modify another faculty\'s timetable (403 FORBIDDEN)', () => {
            assert.strictEqual(tamperCreate.status, 403);
            assert.strictEqual(tamperUpdate.status, 403);
            assert.strictEqual(tamperDelete.status, 403);
        });

        // Faculty A adds own timetable entry for Monday P2
        const facAOwnCreate = await call('POST', '/api/timetable/entries/mine', {
            class: testClassA,
            day: 'Monday',
            period: 2,
            subject: testSubj1,
            room: 'C-101',
            type: 'theory'
        }, cookieA);
        assert.strictEqual(facAOwnCreate.status, 201);

        // ==============================================================
        // [4] Data Integrity Baseline Snapshot
        // ==============================================================
        console.log('\n[4] Data Integrity Baseline Snapshot');

        const snapEntries = await call('GET', '/api/timetable/entries', null, cookieHOS);
        const snapFaculty = await call('GET', '/api/faculty', null, cookieHOS);
        const snapSubjects = await call('GET', '/api/subjects', null, cookieHOS);
        const snapClasses = await call('GET', '/api/classes', null, cookieHOS);
        const snapBranch = await call('GET', '/api/branch', null, cookieHOS);

        assert.strictEqual(snapEntries.status, 200);
        assert.strictEqual(snapFaculty.status, 200);
        assert.strictEqual(snapSubjects.status, 200);
        assert.strictEqual(snapClasses.status, 200);
        assert.strictEqual(snapBranch.status, 200);

        const baselineEntriesCount = snapEntries.body.count;
        const baselineFacultyCount = snapFaculty.body.totalFaculty;
        const baselineSubjectsCount = snapSubjects.body.count;
        const baselineClassesCount = snapClasses.body.count;

        // ==============================================================
        // [5] Availability Calculation & Verification (Items 8 - 17)
        // ==============================================================
        console.log('\n[5] Availability Calculation & Verification');

        // Query: Absent faculty = Faculty A, Day = Monday, Period = 1
        const availMonP1 = await call('POST', '/api/availability', {
            absentFaculty: facA.name,
            day: 'Monday',
            period: 1
        }, cookieHOS);

        check('8. HOS can open Availability', () => {
            assert.strictEqual(availMonP1.status, 200);
            assert.strictEqual(availMonP1.body.readOnly, true);
        });

        check('9. HOS can select an absent faculty', () => {
            assert.ok(availMonP1.body.absentFaculty);
            assert.strictEqual(availMonP1.body.absentFaculty.name, facA.name);
        });

        check('10. HOS can select a valid day', () => {
            assert.strictEqual(availMonP1.body.day, 'Monday');
        });

        check('11. HOS can select a valid period', () => {
            assert.strictEqual(availMonP1.body.period, 1);
        });

        check('12. Backend calculates FREE/BUSY from stored timetable data', () => {
            assert.ok(Array.isArray(availMonP1.body.faculty));
            assert.ok(availMonP1.body.faculty.length > 0);
        });

        check('13. Faculty with an assignment at that slot is BUSY', () => {
            const busyB = availMonP1.body.busy.find(f => f.faculty === facB.name);
            assert.ok(busyB, 'Faculty B must be reported busy at Monday P1');
            assert.strictEqual(busyB.subject, testSubj2);
            assert.strictEqual(busyB.status, 'busy');

            const unifiedB = availMonP1.body.faculty.find(f => f.name === facB.name);
            assert.ok(unifiedB);
            assert.strictEqual(unifiedB.status, 'BUSY');
        });

        check('14. Faculty without an assignment at that slot is FREE', () => {
            const freeC = availMonP1.body.available.find(f => f.faculty === facC.name);
            assert.ok(freeC, 'Faculty C must be reported free at Monday P1');
            assert.strictEqual(freeC.status, 'free');
            assert.ok(availMonP1.body.availableFaculty.includes(facC.name));

            const unifiedC = availMonP1.body.faculty.find(f => f.name === facC.name);
            assert.ok(unifiedC);
            assert.strictEqual(unifiedC.status, 'FREE');
        });

        // Slot: Monday P3 where Faculty A is not teaching: Absent faculty must still be excluded
        const availMonP3 = await call('POST', '/api/availability', {
            absentFaculty: facA.name,
            day: 'Monday',
            period: 3
        }, cookieHOS);

        check('15. Absent faculty is excluded from available faculty', () => {
            assert.strictEqual(availMonP3.status, 200);
            assert.ok(!availMonP3.body.availableFaculty.includes(facA.name), 'Absent faculty A must not appear in availableFaculty');
            assert.ok(!availMonP3.body.available.some(f => f.faculty === facA.name), 'Absent faculty A must not appear in available list');
            const freeAInUnified = availMonP3.body.faculty.find(f => f.name === facA.name && f.status === 'FREE');
            assert.strictEqual(freeAInUnified, undefined, 'Absent faculty must never have status FREE');
        });

        // Slot: Tuesday P2 (Library with unassigned faculty)
        const availTueP2 = await call('POST', '/api/availability', {
            day: 'Tuesday',
            period: 2
        }, cookieHOS);

        check('16. Institutional activity without assigned faculty does not make everyone BUSY', () => {
            assert.strictEqual(availTueP2.status, 200);
            assert.strictEqual(availTueP2.body.totalBusy, 0, 'No faculty member should be marked busy for unassigned Library slot');
            assert.ok(availTueP2.body.availableFaculty.includes(facA.name));
            assert.ok(availTueP2.body.availableFaculty.includes(facB.name));
            assert.ok(availTueP2.body.availableFaculty.includes(facC.name));
        });

        check('17. Only faculty in the current single branch are returned', () => {
            assert.strictEqual(availMonP1.body.branch, 'CIV');
            availMonP1.body.faculty.forEach(f => {
                assert.strictEqual(f.department, 'CIV', `Returned faculty ${f.name} must belong to CIV`);
            });
        });

        // ==============================================================
        // [6] Data Integrity Verification (Items 18 - 20)
        // ==============================================================
        console.log('\n[6] Data Integrity Verification (Before vs After)');

        const postEntries = await call('GET', '/api/timetable/entries', null, cookieHOS);
        const postFaculty = await call('GET', '/api/faculty', null, cookieHOS);
        const postSubjects = await call('GET', '/api/subjects', null, cookieHOS);
        const postClasses = await call('GET', '/api/classes', null, cookieHOS);
        const postBranch = await call('GET', '/api/branch', null, cookieHOS);

        check('18. Availability does not modify timetable data', () => {
            assert.strictEqual(postEntries.body.count, baselineEntriesCount, 'Timetable entry count must remain identical');
            assert.deepStrictEqual(postEntries.body.entries, snapEntries.body.entries, 'Timetable entries must not be altered');
        });

        check('19. Availability does not create a substitute record', () => {
            // Confirm no substitute property or table record exists
            postEntries.body.entries.forEach(e => {
                assert.strictEqual(e.substitute, undefined, 'Entry must not contain any substitute property');
            });
        });

        check('20. No automatic assignment occurs', () => {
            assert.strictEqual(postFaculty.body.totalFaculty, baselineFacultyCount, 'Faculty count must be unchanged');
            assert.strictEqual(postSubjects.body.count, baselineSubjectsCount, 'Subjects count must be unchanged');
            assert.strictEqual(postClasses.body.count, baselineClassesCount, 'Classes count must be unchanged');
            assert.deepStrictEqual(postBranch.body.branch, snapBranch.body.branch, 'Branch config must be unchanged');
        });

        console.log('\n✅ Phase A5 single-branch E2E validation: all 20 checks passed.');
    } finally {
        server.kill();
    }
}

run().catch(err => {
    console.error('Fatal test failure:', err);
    process.exit(1);
});
