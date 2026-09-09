/**
 * Phase A2 — HOS Master Timetable test suite.
 *
 * Verifies:
 *  1. Master timetable loads successfully.
 *  2. HOS can create an entry.
 *  3. HOS can update an entry.
 *  4. HOS can delete an entry.
 *  5. Faculty cannot create master timetable entries for another faculty (returns 403).
 *  6. Faculty cannot update another faculty's master entry (returns 403).
 *  7. Faculty cannot delete another faculty's master entry (returns 403).
 *  8. Invalid faculty is rejected (400 UNKNOWN_REFERENCE).
 *  9. Invalid subject is rejected (400 UNKNOWN_REFERENCE).
 * 10. Invalid class is rejected (400 UNKNOWN_REFERENCE).
 * 11. Duplicate / conflicting timetable entries are rejected (400 SLOT_CONFLICT).
 * 12. Faculty double-booking is rejected (400 SLOT_CONFLICT FACULTY_BUSY).
 * 13. Class double-booking is rejected (400 SLOT_CONFLICT CLASS_BUSY).
 * 14. Non-faculty activities (Library, TPC, Counselling) do not require a faculty.
 * 15. Single-branch isolation remains intact in reference data and operations.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3399;
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
    console.log('TecSubstitution — Phase A2 HOS Master Timetable tests\n');

    // Start server instance with memory writes enabled for test validation
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

    server.stderr.on('data', d => console.error('SERVER ERR:', d.toString()));
    server.stdout.on('data', d => {
        const text = d.toString();
        if (text.includes('Error') || text.includes('error')) console.error('SERVER OUT:', text);
    });

    try {
        await waitForServer(BASE);

        // [1] Master Timetable Loading & Empty State
        console.log('[1] Master Timetable Loading & Empty State');
        const initialTimetable = await call('GET', '/api/timetable');
        check('GET /api/timetable returns valid grid structure', () => {
            assert.strictEqual(initialTimetable.status, 200);
            assert.ok(Array.isArray(initialTimetable.body.cells));
            assert.ok(Array.isArray(initialTimetable.body.days));
            assert.ok(Array.isArray(initialTimetable.body.periods));
        });

        check('Initial timetable is empty with all periods free', () => {
            assert.strictEqual(initialTimetable.body.cells.length, 42);
            assert.ok(initialTimetable.body.cells.every(c => c.status === 'free'));
        });

        const initialEntries = await call('GET', '/api/timetable/entries');
        check('GET /api/timetable/entries returns 200 with 0 entries initially', () => {
            assert.strictEqual(initialEntries.status, 200);
            assert.strictEqual(initialEntries.body.count, 0);
        });

        // Sign in HOS
        const hosLogin = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        const hosCookie = hosLogin.cookie;
        assert.ok(hosCookie, 'HOS cookie must be set');

        // Sign in Faculty member
        const accountsRes = await call('GET', '/api/auth/accounts');
        const facultyAcc = accountsRes.body.accounts.find(a => a.role === 'faculty');
        assert.ok(facultyAcc, 'Must have at least one faculty account');
        const facLogin = await call('POST', '/api/auth/login', { username: facultyAcc.username, password: 'tecsub123' });
        const facCookie = facLogin.cookie;
        assert.ok(facCookie, 'Faculty cookie must be set');

        // Reference data
        const refRes = await call('GET', '/api/timetable/entries/reference');
        assert.strictEqual(refRes.status, 200);
        const testClass = refRes.body.classes[0].code;
        const testSubject = refRes.body.subjects[0].name;
        const testFaculty = facultyAcc.name;
        const testRoom = refRes.body.rooms.length ? refRes.body.rooms[0].code : null;

        // Find available free slots in testClass
        const gridRes = await call('GET', '/api/timetable?class=' + testClass);
        const freeCells = gridRes.body.cells.filter(c => c.status === 'free');
        assert.ok(freeCells.length >= 3, 'Must have free cells available for testing');
        const freeCell1 = freeCells[0];
        const freeCell2 = freeCells[1];
        const freeCell3 = freeCells[2];

        // [2] HOS CRUD operations
        console.log('\n[2] HOS Entry Management (CRUD)');
        let createdEntryId = null;

        const createRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: freeCell1.day,
            period: freeCell1.period,
            subject: testSubject,
            faculty: testFaculty,
            room: testRoom,
            type: 'theory'
        }, hosCookie);

        check('HOS can create a master timetable entry', () => {
            assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
            assert.strictEqual(createRes.body.saved, true);
            assert.ok(createRes.body.entry && createRes.body.entry.id);
            createdEntryId = createRes.body.entry.id;
        });

        const readCreated = await call('GET', `/api/timetable/entries/${createdEntryId}`);
        check('Created entry is readable by ID', () => {
            assert.strictEqual(readCreated.status, 200);
            assert.strictEqual(readCreated.body.entry.subject, testSubject);
            assert.strictEqual(readCreated.body.entry.faculty, testFaculty);
            assert.strictEqual(readCreated.body.entry.day, freeCell1.day);
            assert.strictEqual(readCreated.body.entry.period, freeCell1.period);
        });

        const updateRes = await call('PUT', `/api/timetable/entries/${createdEntryId}`, {
            class: testClass,
            day: freeCell1.day,
            period: freeCell1.period,
            subject: testSubject,
            faculty: testFaculty,
            room: testRoom,
            type: 'lab'
        }, hosCookie);

        check('HOS can update an existing master timetable entry', () => {
            assert.strictEqual(updateRes.status, 200, JSON.stringify(updateRes.body));
            assert.strictEqual(updateRes.body.saved, true);
            assert.strictEqual(updateRes.body.entry.type, 'lab');
        });

        // [3] Faculty Authorization Restrictions (403)
        console.log('\n[3] Faculty Authorization & Master Timetable Protection');

        // Find another faculty name
        const otherFaculty = refRes.body.faculty.find(f => f.name !== testFaculty);
        assert.ok(otherFaculty, 'Need a second faculty member for authorization tests');

        const facCreateOther = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: freeCell2.day,
            period: freeCell2.period,
            subject: testSubject,
            faculty: otherFaculty.name,
            room: testRoom,
            type: 'theory'
        }, facCookie);

        check('Faculty cannot create master timetable entries for another faculty (403)', () => {
            assert.strictEqual(facCreateOther.status, 403);
            assert.strictEqual(facCreateOther.body.code, 'FORBIDDEN');
        });

        // HOS creates an entry for otherFaculty
        const otherEntryRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: freeCell2.day,
            period: freeCell2.period,
            subject: testSubject,
            faculty: otherFaculty.name,
            room: testRoom,
            type: 'theory'
        }, hosCookie);
        assert.strictEqual(otherEntryRes.status, 201);
        const otherEntryId = otherEntryRes.body.entry.id;

        const facUpdateOther = await call('PUT', `/api/timetable/entries/${otherEntryId}`, {
            class: testClass,
            day: freeCell2.day,
            period: freeCell2.period,
            subject: testSubject,
            faculty: otherFaculty.name,
            room: testRoom,
            type: 'lab'
        }, facCookie);

        check('Faculty cannot update another faculty\'s master entry (403)', () => {
            assert.strictEqual(facUpdateOther.status, 403);
            assert.strictEqual(facUpdateOther.body.code, 'FORBIDDEN');
        });

        const facDeleteOther = await call('DELETE', `/api/timetable/entries/${otherEntryId}`, null, facCookie);
        check('Faculty cannot delete another faculty\'s master entry (403)', () => {
            assert.strictEqual(facDeleteOther.status, 403);
            assert.strictEqual(facDeleteOther.body.code, 'FORBIDDEN');
        });

        // [4] Validation Rules
        console.log('\n[4] Validation Rules & Reference Integrity');

        const badFacultyRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: 'Wednesday',
            period: 3,
            subject: testSubject,
            faculty: 'NonExistentFaculty_X99',
            type: 'theory'
        }, hosCookie);

        check('Invalid faculty is rejected with 400 UNKNOWN_REFERENCE', () => {
            assert.strictEqual(badFacultyRes.status, 400);
            assert.strictEqual(badFacultyRes.body.code, 'UNKNOWN_REFERENCE');
        });

        const badSubjectRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: 'Wednesday',
            period: 3,
            subject: 'Quantum Teleportation 999',
            faculty: testFaculty,
            type: 'theory'
        }, hosCookie);

        check('Invalid subject is rejected with 400 UNKNOWN_REFERENCE', () => {
            assert.strictEqual(badSubjectRes.status, 400);
            assert.strictEqual(badSubjectRes.body.code, 'UNKNOWN_REFERENCE');
        });

        const badClassRes = await call('POST', '/api/timetable/entries', {
            class: 'UNKNOWN-CLASS-999',
            day: 'Wednesday',
            period: 3,
            subject: testSubject,
            faculty: testFaculty,
            type: 'theory'
        }, hosCookie);

        check('Invalid class is rejected with 400 UNKNOWN_REFERENCE', () => {
            assert.strictEqual(badClassRes.status, 400);
            assert.strictEqual(badClassRes.body.code, 'UNKNOWN_REFERENCE');
        });

        const badDayRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: 'Funday',
            period: 3,
            subject: testSubject,
            faculty: testFaculty,
            type: 'theory'
        }, hosCookie);

        check('Invalid day is rejected with 400 INVALID_ENTRY', () => {
            assert.strictEqual(badDayRes.status, 400);
            assert.strictEqual(badDayRes.body.code, 'INVALID_ENTRY');
        });

        // [5] Conflict and Double-Booking Prevention
        console.log('\n[5] Conflict & Double-Booking Prevention');

        // createdEntryId is at freeCell1 for testClass & testFaculty
        const classClashRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: freeCell1.day,
            period: freeCell1.period,
            subject: testSubject,
            faculty: otherFaculty.name,
            type: 'theory'
        }, hosCookie);

        check('Class double-booking at same day/period is rejected with SLOT_CONFLICT', () => {
            assert.strictEqual(classClashRes.status, 400);
            assert.strictEqual(classClashRes.body.code, 'SLOT_CONFLICT');
            assert.ok(classClashRes.body.conflicts.some(c => c.code === 'CLASS_BUSY'));
        });

        // otherClasses if available
        const otherClasses = refRes.body.classes.filter(c => c.code !== testClass);
        if (otherClasses.length) {
            const facultyClashRes = await call('POST', '/api/timetable/entries', {
                class: otherClasses[0].code,
                day: freeCell1.day,
                period: freeCell1.period,
                subject: testSubject,
                faculty: testFaculty,
                type: 'theory'
            }, hosCookie);

            check('Faculty double-booking across classes is rejected with SLOT_CONFLICT', () => {
                assert.strictEqual(facultyClashRes.status, 400);
                assert.strictEqual(facultyClashRes.body.code, 'SLOT_CONFLICT');
                assert.ok(facultyClashRes.body.conflicts.some(c => c.code === 'FACULTY_BUSY'));
            });
        }

        // [6] Special Non-Faculty Activities
        console.log('\n[6] Non-Faculty Activities (Library / Counselling / TPC)');
        const activityRes = await call('POST', '/api/timetable/entries', {
            class: testClass,
            day: freeCell3.day,
            period: freeCell3.period,
            subject: 'Library',
            faculty: '',
            type: 'activity'
        }, hosCookie);

        check('Library / Activity slot is accepted without faculty', () => {
            assert.strictEqual(activityRes.status, 201, JSON.stringify(activityRes.body));
            assert.strictEqual(activityRes.body.saved, true);
            assert.strictEqual(activityRes.body.entry.faculty, null);
        });

        // [7] Deletion & Cleanup
        console.log('\n[7] HOS Deletion');
        const deleteRes = await call('DELETE', `/api/timetable/entries/${createdEntryId}`, null, hosCookie);
        check('HOS can delete a master timetable entry', () => {
            assert.strictEqual(deleteRes.status, 200);
            assert.strictEqual(deleteRes.body.deleted, true);
        });

        const verifyDeleted = await call('GET', `/api/timetable/entries/${createdEntryId}`);
        check('Deleted entry is no longer available (404)', () => {
            assert.strictEqual(verifyDeleted.status, 404);
        });

        // [8] Single-Branch Isolation
        console.log('\n[8] Single-Branch Isolation');
        check('Reference data is scoped strictly to current branch', () => {
            assert.ok(refRes.body.classes.every(c => c.department === 'CIV'));
            assert.ok(refRes.body.subjects.every(s => s.department === 'CIV'));
            assert.ok(refRes.body.faculty.every(f => f.department === 'CIV'));
            assert.strictEqual(refRes.body.departments.length, 1);
            assert.strictEqual(refRes.body.departments[0].code, 'CIV');
        });

        const foreignClassRes = await call('POST', '/api/timetable/entries', {
            class: 'CME-A',
            day: 'Monday',
            period: 5,
            subject: testSubject,
            faculty: testFaculty,
            type: 'theory'
        }, hosCookie);

        check('Foreign branch class is rejected with 400 UNKNOWN_REFERENCE', () => {
            assert.strictEqual(foreignClassRes.status, 400);
            assert.strictEqual(foreignClassRes.body.code, 'UNKNOWN_REFERENCE');
        });

        console.log('\n✅ master timetable tests: all checks passed.');
    } finally {
        server.kill();
    }
}

run().catch(err => {
    console.error('Fatal test failure:', err);
    process.exit(1);
});
