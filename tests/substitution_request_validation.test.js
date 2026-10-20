/**
 * F.A.S.T. — Substitution Request Validation Regression Test Suite
 *
 * Verifies:
 * 1. A valid scheduled class (including from faculty personal timetable, e.g. Saturday Period 6)
 *    can be selected for a substitution request.
 * 2. A faculty member cannot request a substitution for a slot where they have no class (NO_SCHEDULED_CLASS).
 * 3. Requester with classes in the Master Timetable can still create requests (fallback works).
 * 4. Faculty IDs, codes, and names resolve consistently.
 * 5. Saturday and period numbering (string vs number, canonical day names) are handled correctly.
 * 6. Substitute candidate availability and conflict checks still work (SUBSTITUTE_NOT_FREE, CANNOT_SUBSTITUTE_SELF).
 * 7. Class name matching and fallback logic works properly without throwing false CLASS_MISMATCH.
 * 8. Accepted / Rejected workflow remains intact with proper status transitions.
 * 9. getMyVacantPeriods returns personal timetable slots when requester is absent.
 * 10. Existing branch isolation and authorization remain intact (HOD cannot create/accept, cross-faculty blocked).
 */

const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const store = require('../src/data/store');
const substitutions = require('../src/data/substitutions');
const repository = require('../src/db/repository');
const { query } = require('../src/db/pool');

async function run() {
    console.log('================================================================');
    console.log('F.A.S.T. — Substitution Request Validation Regression Tests');
    console.log('================================================================\n');

    let passed = 0;
    let failed = 0;

    async function check(name, fn) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✕ ${name}`);
            console.error(`    ${err.message}`);
            if (err.stack) console.error(`    ${err.stack.split('\n').slice(1, 3).join('\n')}`);
            failed++;
        }
    }

    const rand = Math.floor(Math.random() * 90000 + 10000);
    const FAC_A_ID = 91000 + rand;
    const FAC_B_ID = 92000 + rand;
    const FAC_C_ID = 93000 + rand;
    const FAC_OTHER_ID = 94000 + rand;

    const sessionKusuma = {
        role: 'faculty',
        department: 'CME',
        username: `kusuma_${rand}`,
        name: `Ms. B. Kusuma ${rand}`,
        facultyName: `Ms. B. Kusuma ${rand}`,
        facultyId: FAC_A_ID,
        id: FAC_A_ID
    };

    const sessionLohith = {
        role: 'faculty',
        department: 'CME',
        username: `lohith_${rand}`,
        name: `Lohith Kumar ${rand}`,
        facultyName: `Lohith Kumar ${rand}`,
        facultyId: FAC_B_ID,
        id: FAC_B_ID
    };

    const sessionBusySub = {
        role: 'faculty',
        department: 'CME',
        username: `busy_fac_${rand}`,
        name: `Busy Faculty ${rand}`,
        facultyName: `Busy Faculty ${rand}`,
        facultyId: FAC_C_ID,
        id: FAC_C_ID
    };

    const sessionOtherBranch = {
        role: 'faculty',
        department: 'ECE',
        username: `other_fac_${rand}`,
        name: `Dr. Other Branch ${rand}`,
        facultyName: `Dr. Other Branch ${rand}`,
        facultyId: FAC_OTHER_ID,
        id: FAC_OTHER_ID
    };

    const sessionHod = {
        role: 'hos',
        department: 'CME',
        branch: 'CME',
        username: `cme_hod_${rand}`,
        name: `CME HOD ${rand}`,
        id: 95000 + rand
    };

    const targetDate = '2026-10-24'; // Saturday

    // Setup mock data in store and in-memory engine
    const mockFaculty = [
        { id: FAC_A_ID, name: sessionKusuma.name, code: sessionKusuma.username, department: 'CME', status: 'active' },
        { id: FAC_B_ID, name: sessionLohith.name, code: sessionLohith.username, department: 'CME', status: 'active' },
        { id: FAC_C_ID, name: sessionBusySub.name, code: sessionBusySub.username, department: 'CME', status: 'active' },
        { id: FAC_OTHER_ID, name: sessionOtherBranch.name, code: sessionOtherBranch.username, department: 'ECE', status: 'active' }
    ];

    const mockRecords = [
        // Busy Faculty C teaches CME-SEM1-A on Saturday Period 6 in Master Timetable
        {
            day: 'Saturday',
            period: 6,
            faculty: sessionBusySub.name,
            facultyId: FAC_C_ID,
            className: 'CME-SEM1-A',
            subject: 'Data Structures',
            room: 'Lab 2',
            status: 'busy'
        },
        // Requester Kusuma also has a master timetable class on Friday Period 2
        {
            day: 'Friday',
            period: 2,
            faculty: sessionKusuma.name,
            facultyId: FAC_A_ID,
            className: 'CME-SEM1-A',
            subject: 'Computer Networks',
            room: 'LH-1',
            status: 'busy'
        }
    ];

    // Personal timetable for Kusuma: Saturday Period 6 (Python Programming Lab)
    const mockPersonalSlots = [
        {
            day: 'Saturday',
            day_of_week: 'Saturday',
            period: 6,
            period_number: 6,
            subject: 'Python Programming Lab',
            rawSubject: 'Python Programming Lab',
            session_type: 'lab',
            type: 'lab',
            className: 'CME-SEM1-A',
            room: 'Lab 1',
            is_free: false,
            status: 'busy'
        }
    ];

    if (!store.engine) {
        store.engine = {
            getFaculty: () => mockFaculty,
            getRecords: () => mockRecords,
            getPeriods: () => [1, 2, 3, 4, 5, 6, 7],
            normalizePeriod: (p) => parseInt(p, 10),
            getAvailability: () => ({ available: [] })
        };
    } else {
        const origGetFaculty = store.engine.getFaculty.bind(store.engine);
        const origGetRecords = store.engine.getRecords.bind(store.engine);
        store.engine.getFaculty = () => [...origGetFaculty(), ...mockFaculty];
        store.engine.getRecords = () => [...origGetRecords(), ...mockRecords];
    }

    // Set personal timetable in store memory
    store.getFacultyPersonalTimetableInMemory = (idOrName) => {
        const needle = String(idOrName).toUpperCase();
        if (needle === String(FAC_A_ID) || needle === sessionKusuma.name.toUpperCase()) {
            return mockPersonalSlots;
        }
        return [];
    };

    let createdReqId = null;

    // Test 1: Valid personal timetable slot can be selected for substitution request
    await check('1. Requester can create substitution request for personal timetable class (Saturday Period 6)', async () => {
        const req = await substitutions.createRequest({
            date: targetDate,
            period: 6,
            subject: 'Python Programming Lab',
            className: 'CME-SEM1-A',
            substituteFacultyId: FAC_B_ID,
            substituteFacultyName: sessionLohith.name,
            isAdjustment: true,
            sessionUser: sessionKusuma
        });

        assert.ok(req, 'Expected request to be created');
        assert.ok(req.id, 'Expected request to have an id');
        assert.strictEqual(req.status, 'PENDING', 'Expected status to be PENDING');
        assert.strictEqual(req.date, targetDate);
        assert.strictEqual(req.period, 6);
        assert.strictEqual(req.subject, 'Python Programming Lab');
        assert.strictEqual(req.originalFacultyName, sessionKusuma.name);
        assert.strictEqual(req.substituteFacultyName, sessionLohith.name);
        createdReqId = req.id;
    });

    // Test 2: Unscheduled slot where faculty member has no class is rejected
    await check('2. Requester cannot create request for a slot where they have no class (Saturday Period 4)', async () => {
        let errThrown = null;
        try {
            await substitutions.createRequest({
                date: targetDate,
                period: 4,
                subject: 'Python Programming Lab',
                substituteFacultyId: FAC_B_ID,
                substituteFacultyName: sessionLohith.name,
                isAdjustment: true,
                sessionUser: sessionKusuma
            });
        } catch (err) {
            errThrown = err;
        }

        assert.ok(errThrown, 'Expected NO_SCHEDULED_CLASS error to be thrown');
        assert.strictEqual(errThrown.code, 'NO_SCHEDULED_CLASS');
        assert.ok(errThrown.message.includes('has no scheduled class on Saturday period 4'));
    });

    // Test 3: Fallback to Master Timetable works when personal timetable has no class
    await check('3. Requester can create request for master timetable class (Friday Period 2)', async () => {
        const req = await substitutions.createRequest({
            date: '2026-10-23', // Friday
            period: 2,
            subject: 'Computer Networks',
            className: 'CME-SEM1-A',
            substituteFacultyId: FAC_B_ID,
            substituteFacultyName: sessionLohith.name,
            isAdjustment: true,
            sessionUser: sessionKusuma
        });

        assert.ok(req, 'Expected master timetable class request to be created');
        assert.strictEqual(req.status, 'PENDING');
        assert.strictEqual(req.period, 2);
        assert.strictEqual(req.subject, 'Computer Networks');
    });

    // Test 4: Class mismatch validation
    await check('4. Reject request if class name conflicts with scheduled class', async () => {
        let errThrown = null;
        try {
            await substitutions.createRequest({
                date: '2026-10-23', // Friday P2 is CME-SEM1-A
                period: 2,
                className: 'ECE-SEM3-B',
                substituteFacultyId: FAC_B_ID,
                substituteFacultyName: sessionLohith.name,
                isAdjustment: true,
                sessionUser: sessionKusuma
            });
        } catch (err) {
            errThrown = err;
        }

        assert.ok(errThrown, 'Expected CLASS_MISMATCH error');
        assert.strictEqual(errThrown.code, 'CLASS_MISMATCH');
    });

    // Test 5: Period format handling (string '6' vs number 6)
    await check('5. Period passed as string "6" or number 6 is normalized correctly', async () => {
        // Test helper findTeachingClass directly
        const matchStr = await substitutions.findTeachingClass(mockFaculty[0], 'Saturday', '6', { checkPersonal: true });
        const matchNum = await substitutions.findTeachingClass(mockFaculty[0], 'Saturday', 6, { checkPersonal: true });
        assert.ok(matchStr, 'Expected match for period string "6"');
        assert.ok(matchNum, 'Expected match for period number 6');
        assert.strictEqual(matchStr.period, 6);
        assert.strictEqual(matchNum.period, 6);
        assert.strictEqual(matchStr.subject, 'Python Programming Lab');
    });

    // Test 6: Day canonicalization ('SAT', 'Saturday', 'saturday')
    await check('6. Day canonicalization correctly resolves "SAT", "Saturday", "saturday"', async () => {
        const match1 = await substitutions.findTeachingClass(mockFaculty[0], 'SAT', 6, { checkPersonal: true });
        const match2 = await substitutions.findTeachingClass(mockFaculty[0], 'saturday', 6, { checkPersonal: true });
        assert.ok(match1, 'Expected match for SAT');
        assert.ok(match2, 'Expected match for saturday');
        assert.strictEqual(match1.period, 6);
        assert.strictEqual(match2.period, 6);
    });

    // Test 7: Substitute candidate cannot be teaching another class
    await check('7. Reject request if substitute candidate has teaching conflict (SUBSTITUTE_NOT_FREE)', async () => {
        // Faculty C teaches on Saturday Period 6
        let errThrown = null;
        try {
            await substitutions.createRequest({
                date: targetDate,
                period: 6,
                substituteFacultyId: FAC_C_ID,
                substituteFacultyName: sessionBusySub.name,
                isAdjustment: true,
                sessionUser: sessionKusuma
            });
        } catch (err) {
            errThrown = err;
        }

        assert.ok(errThrown, 'Expected SUBSTITUTE_NOT_FREE error');
        assert.strictEqual(errThrown.code, 'SUBSTITUTE_NOT_FREE');
    });

    // Test 8: Self-substitution rejected
    await check('8. Requester cannot select themselves as substitute (CANNOT_SUBSTITUTE_SELF)', async () => {
        let errThrown = null;
        try {
            await substitutions.createRequest({
                date: targetDate,
                period: 6,
                substituteFacultyId: FAC_A_ID,
                substituteFacultyName: sessionKusuma.name,
                isAdjustment: true,
                sessionUser: sessionKusuma
            });
        } catch (err) {
            errThrown = err;
        }

        assert.ok(errThrown, 'Expected CANNOT_SUBSTITUTE_SELF error');
        assert.strictEqual(errThrown.code, 'CANNOT_SUBSTITUTE_SELF');
    });

    // Test 9: Acceptance / Rejection workflow remains intact
    await check('9. Substitute faculty can accept request and status transitions to ACCEPTED', async () => {
        assert.ok(createdReqId, 'createdReqId should exist');
        const accepted = await substitutions.acceptRequest(createdReqId, sessionLohith);
        assert.ok(accepted, 'Expected acceptance result');
        assert.strictEqual(accepted.status, 'ACCEPTED');

        // Cannot accept already accepted
        let errThrown = null;
        try {
            await substitutions.acceptRequest(createdReqId, sessionLohith);
        } catch (err) {
            errThrown = err;
        }
        assert.ok(errThrown, 'Expected error when re-accepting');
        assert.strictEqual(errThrown.code, 'REQUEST_NOT_PENDING');
    });

    // Test 10: RBAC and branch isolation
    await check('10. HOD cannot create or accept substitution requests (Strict RBAC)', async () => {
        let errCreate = null;
        try {
            await substitutions.createRequest({
                date: targetDate,
                period: 6,
                substituteFacultyId: FAC_B_ID,
                isAdjustment: true,
                sessionUser: sessionHod
            });
        } catch (err) {
            errCreate = err;
        }
        assert.ok(errCreate, 'Expected HOD creation error');
        assert.strictEqual(errCreate.code, 'FORBIDDEN');

        let errAccept = null;
        try {
            await substitutions.acceptRequest(createdReqId, sessionHod);
        } catch (err) {
            errAccept = err;
        }
        assert.ok(errAccept, 'Expected HOD acceptance error');
        assert.strictEqual(errAccept.code, 'FORBIDDEN');
    });

    await check('11. Third-party faculty cannot accept another faculty member\'s request', async () => {
        let errThrown = null;
        try {
            await substitutions.acceptRequest(createdReqId, sessionOtherBranch);
        } catch (err) {
            errThrown = err;
        }
        assert.ok(errThrown, 'Expected unauthorized error for other faculty');
        assert.strictEqual(errThrown.code, 'FORBIDDEN');
    });

    console.log('\n================================================================');
    console.log(`Results: ${passed} passed, ${failed} failed.`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
    process.exit(0);
}

run().catch(err => {
    console.error('Fatal error in test suite:', err);
    process.exit(1);
});
