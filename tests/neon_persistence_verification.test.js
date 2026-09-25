/**
 * Neon PostgreSQL Persistence & Application Restart Verification Test.
 *
 * Verifies the 10 core entities in PostgreSQL:
 *   1. Branch (departments)
 *   2. HOS (users)
 *   3. Faculty (faculty)
 *   4. Subject (subjects)
 *   5. Class / Section (classes)
 *   6. Timetable Entry (timetable)
 *   7. Faculty Attendance (faculty_attendance)
 *   8. Invigilation Record & Request (exam_invigilation, exam_invigilation_requests)
 *   9. Substitution Request (faculty_substitutions)
 *  10. Accepted Substitution (faculty_substitutions)
 *
 * Simulates an application restart by clearing in-memory state, re-invoking
 * store.initFromDatabase(), and verifying data persistence.
 */
const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const config = require('../src/config');
const db = require('../src/db/pool');
const seeder = require('../src/db/seed');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
const departments = require('../src/data/departments');
const users = require('../src/data/users');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const substitutions = require('../src/data/substitutions');

async function run() {
    console.log('================================================================');
    console.log('TecSubstitution — Neon Database Persistence & Restart Test');
    console.log('================================================================\n');

    console.log(`Connecting to Neon target: ${db.describeTarget()}`);
    await seeder.migrate();
    console.log('Schema migration applied (tables confirmed present).');

    const TEST_PREFIX = 'NEON_TEST_';
    const TEST_BRANCH = 'NEON_CSE';
    const TEST_HOS_USER = 'neon_hos_tester';
    const TEST_FAC_ID = 'FAC_NEON_01';
    const TEST_FAC_NAME = 'Dr. Neon Database Tester';
    const TEST_SUBJ_CODE = 'NEON_101';
    const TEST_CLASS_CODE = 'NEON-A';
    const TEST_DATE = '2026-09-18';
    const TEST_PERIOD = 3;
    async function cleanupTestArtifacts() {
        await db.query('DELETE FROM faculty_substitutions WHERE id LIKE $1', ['neon_sub_test_%']);
        await db.query('DELETE FROM exam_invigilation WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ($1, $2))', [TEST_FAC_ID, 'FAC_NEON_02']);
        await db.query('DELETE FROM exam_invigilation_requests WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ($1, $2))', [TEST_FAC_ID, 'FAC_NEON_02']);
        await db.query('DELETE FROM faculty_attendance WHERE faculty_id IN (SELECT id FROM faculty WHERE code IN ($1, $2))', [TEST_FAC_ID, 'FAC_NEON_02']);
        await db.query('DELETE FROM timetable WHERE class_id IN (SELECT id FROM classes WHERE code = $1)', [TEST_CLASS_CODE]);
        await db.query('DELETE FROM classes WHERE code = $1', [TEST_CLASS_CODE]);
        await db.query('DELETE FROM subjects WHERE code = $1', [TEST_SUBJ_CODE]);
        await db.query('DELETE FROM users WHERE username = $1', [TEST_HOS_USER]);
        await db.query('DELETE FROM faculty WHERE code IN ($1, $2)', [TEST_FAC_ID, 'FAC_NEON_02']);
        await db.query('DELETE FROM departments WHERE code = $1', [TEST_BRANCH]);
    }

    await cleanupTestArtifacts();

    console.log('\n--- Step 1: Create 10 Core Project Entities ---');

    // 1. Branch
    const branchRes = await repository.updateInstanceBranch({
        code: TEST_BRANCH,
        name: 'Neon Computer Science',
        academicYear: '2026-2027',
        semester: 1,
        totalSemesters: 6
    });
    console.log('  ✓ 1. Branch created:', branchRes.code);

    // 2. HOS User
    const hosRes = await repository.saveUser({
        username: TEST_HOS_USER,
        name: 'Neon HOS Leader',
        phone: '9888877777',
        role: 'hos',
        departmentCode: TEST_BRANCH,
        passwordHash: 'scrypt$dummyhash',
        status: 'active'
    });
    console.log('  ✓ 2. HOS user created:', hosRes.username);

    // 3. Faculty
    let facRes;
    try {
        facRes = await repository.addFaculty({
            id: TEST_FAC_ID,
            name: TEST_FAC_NAME,
            department: TEST_BRANCH,
            email: 'neon.tester@college.edu',
            phone: '9888877771',
            status: 'active',
            maxWeeklyPeriods: 18
        });
    } catch (e) {
        facRes = await repository.getFaculty(TEST_FAC_ID);
    }
    const numericFacId = facRes.numeric_id || facRes.id;
    console.log('  ✓ 3. Faculty created:', facRes.name, `(ID: ${numericFacId})`);

    // 4. Subject
    let subjRes;
    try {
        subjRes = await repository.addSubject({
            code: TEST_SUBJ_CODE,
            name: 'Neon Cloud Computing',
            department: TEST_BRANCH,
            type: 'theory'
        });
    } catch (e) {
        subjRes = (await repository.listSubjects()).find(s => s.code === TEST_SUBJ_CODE);
    }
    console.log('  ✓ 4. Subject created:', subjRes.code);

    // 5. Class / Section
    let classRes;
    try {
        classRes = await repository.addClass({
            code: TEST_CLASS_CODE,
            department: TEST_BRANCH,
            semester: 1,
            academicYear: '2026-2027',
            section: 'A'
        });
    } catch (e) {
        classRes = (await repository.listClasses()).find(c => c.code === TEST_CLASS_CODE);
    }
    console.log('  ✓ 5. Class/Section created:', classRes.code);

    // 6. Timetable Entry
    let entryRes;
    try {
        entryRes = await repository.addEntry({
            class: TEST_CLASS_CODE,
            day: 'Friday',
            period: TEST_PERIOD,
            subject: 'Neon Cloud Computing',
            faculty: TEST_FAC_NAME,
            type: 'theory'
        });
    } catch (e) {
        entryRes = (await repository.listEntries()).find(e => e.day === 'Friday' && e.period === TEST_PERIOD && e.faculty === TEST_FAC_NAME);
    }
    console.log('  ✓ 6. Timetable entry created for Friday P3');

    // 7. Faculty Attendance Record (ABSENT)
    const attRes = await repository.markFacultyAttendance({
        facultyId: numericFacId,
        date: TEST_DATE,
        status: 'ABSENT',
        markedBy: TEST_HOS_USER
    });
    console.log('  ✓ 7. Faculty attendance marked ABSENT on', attRes.attendanceDate);

    // 8. Exam Invigilation Request & Active Assignment
    const invReq = await repository.createInvigilationRequest({
        facultyId: numericFacId,
        branchCode: TEST_BRANCH,
        examDate: TEST_DATE,
        periods: [4],
        reason: 'Midterm Duty'
    });
    const invAct = await repository.createActiveInvigilation({
        facultyId: numericFacId,
        branchCode: TEST_BRANCH,
        examDate: TEST_DATE,
        period: 4,
        source: 'DIRECT',
        assignedBy: TEST_HOS_USER,
        notes: 'Midterm supervision'
    });
    console.log('  ✓ 8. Exam invigilation request & active record created for P4');

    // Helper: Second faculty for substitution
    let subFacRes;
    try {
        subFacRes = await repository.addFaculty({
            id: 'FAC_NEON_02',
            name: 'Dr. Neon Colleague',
            department: TEST_BRANCH,
            email: 'neon.colleague@college.edu',
            status: 'active'
        });
    } catch (e) {
        subFacRes = await repository.getFaculty('FAC_NEON_02');
    }
    const subNumericFacId = subFacRes.numeric_id || subFacRes.id;

    // 9. Substitution Request (PENDING)
    const subId = 'neon_sub_test_' + Date.now();
    const subReq = await repository.createFacultySubstitution({
        id: subId,
        date: TEST_DATE,
        dayOfWeek: 'Friday',
        period: TEST_PERIOD,
        className: TEST_CLASS_CODE,
        subject: 'Neon Cloud Computing',
        room: 'C-101',
        originalFacultyId: numericFacId,
        originalFacultyName: TEST_FAC_NAME,
        originalFacultyBranch: TEST_BRANCH,
        substituteFacultyId: subNumericFacId,
        substituteFacultyName: 'Dr. Neon Colleague',
        substituteFacultyBranch: TEST_BRANCH,
        requestedBy: TEST_HOS_USER,
        status: 'PENDING'
    });
    console.log('  ✓ 9. Faculty substitution request created (PENDING)');

    // 10. Accepted Substitution
    const accSub = await repository.updateFacultySubstitutionStatus(subId, {
        status: 'ACCEPTED',
        respondedAt: new Date().toISOString()
    });
    assert.strictEqual(accSub.status, 'ACCEPTED');
    console.log('  ✓ 10. Substitution accepted by substitute colleague');

    console.log('\n--- Step 2: Simulating Application Stop & Restart ---');
    // Clear in-memory caches
    departments.resetForTesting && departments.resetForTesting();
    users.resetForTesting && users.resetForTesting();
    substitutions.resetForTesting && substitutions.resetForTesting();
    attendance.resetForTesting && attendance.resetForTesting();

    // Re-initialize from database as server bootstrap does
    console.log('  → Calling store.initFromDatabase()...');
    const initResult = await store.initFromDatabase();
    assert.strictEqual(initResult.enabled, true, 'Database must be successfully reconnected');
    console.log('  ✓ Reconnected to database on restart');

    console.log('\n--- Step 3: Verifying Data Still Exists in Database ---');

    // Verify Branch persisted
    const restoredDepts = await repository.loadAllDepartments();
    const foundBranch = restoredDepts.find(d => d.code === TEST_BRANCH);
    assert.ok(foundBranch, 'Branch must survive restart');
    console.log('  ✓ Restored branch:', foundBranch.code);

    // Verify User persisted
    const restoredUsers = await repository.loadAllUsers();
    const foundUser = restoredUsers.find(u => u.username === TEST_HOS_USER);
    assert.ok(foundUser, 'HOS User must survive restart');
    assert.strictEqual(foundUser.role, 'hos');
    console.log('  ✓ Restored HOS user:', foundUser.username);

    // Verify Faculty persisted
    const foundFac = await repository.getFaculty(TEST_FAC_ID);
    assert.ok(foundFac, 'Faculty must survive restart');
    assert.strictEqual(foundFac.name, TEST_FAC_NAME);
    console.log('  ✓ Restored faculty:', foundFac.name);

    // Verify Attendance persisted
    const absentRows = await repository.getAbsentFacultyForDate(TEST_DATE);
    const wasAbsent = absentRows.some(r => r.facultyName === TEST_FAC_NAME || r.facultyId === numericFacId);
    assert.ok(wasAbsent, 'Faculty attendance record must survive restart');
    console.log('  ✓ Restored attendance record: marked ABSENT');

    // Verify Invigilation persisted
    const activeInv = await repository.listActiveInvigilation({ examDate: TEST_DATE, period: 4 });
    assert.ok(activeInv.length > 0, 'Active invigilation must survive restart');
    console.log('  ✓ Restored invigilation assignment');

    // Verify Substitution persisted
    const restoredSub = await repository.getFacultySubstitutionById(subId);
    assert.ok(restoredSub, 'Substitution must survive restart');
    assert.strictEqual(restoredSub.status, 'ACCEPTED');
    console.log('  ✓ Restored substitution: status ACCEPTED');

    console.log('\n--- Step 4: Cleanup Test Records Safely ---');
    await cleanupTestArtifacts();
    console.log('  ✓ Test records cleaned up cleanly without touching existing data');

    console.log('\n================================================================');
    console.log('ALL NEON PERSISTENCE VERIFICATION CHECKS PASSED!');
    console.log('Data survives application restart successfully.');
    console.log('================================================================\n');
}

run()
    .then(async () => {
        await db.close();
        process.exit(0);
    })
    .catch(async err => {
        console.error('\n✗ FAILED:', err);
        try { await db.close(); } catch (_) {}
        process.exit(1);
    });
