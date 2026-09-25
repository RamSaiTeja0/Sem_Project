const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');
const store = require('../src/data/store');

async function testClassReuse() {
    console.log('\n======================================================');
    console.log('Running Class Reuse & Unique Constraint Regression Tests');
    console.log('======================================================\n');

    if (!db.isConfigured()) {
        console.log('Database not configured, skipping DB-specific tests.');
        return;
    }

    const testBranch = 'TEST_REUSE_' + Math.floor(Math.random() * 10000);
    await repository.addDepartment({
        code: testBranch,
        name: `Department ${testBranch}`,
        totalSemesters: 6,
        academicYear: '2025-2026',
        semester: 4
    });
    const deptQ = await db.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [testBranch]);
    const deptId = deptQ.rows[0].id;

    console.log(`[1] Created test branch: ${testBranch} (Dept ID: ${deptId})`);

    // Create initial class for Semester 4, Section A, Academic Year 2025-2026
    const initialClass = await repository.addClass({
        code: `${testBranch}-4-A`,
        department: testBranch,
        semester: 4,
        section: 'A',
        academicYear: '2025-2026'
    });

    console.log(`[2] Created initial class: ${initialClass.code} (Class ID: ${initialClass.id})`);

    // Verify exactly 1 class exists
    const classesBefore = await db.query('SELECT * FROM classes WHERE department_id = $1', [deptId]);
    assert.strictEqual(classesBefore.rows.length, 1);
    const initialClassId = classesBefore.rows[0].id;

    await repository.addSubject({ code: `ME_401_${testBranch}`, name: `Thermodynamics ${testBranch}`, department: testBranch, subjectType: 'theory' });
    await repository.addSubject({ code: `ME_402_${testBranch}`, name: `Fluid Mechanics ${testBranch}`, department: testBranch, subjectType: 'theory' });
    await repository.addFaculty({ id: `CARNOT_${testBranch}`, code: `CARNOT_${testBranch}`, name: `Prof. Carnot ${testBranch}`, department: testBranch, status: 'active' });
    await repository.addFaculty({ id: `BERNOULLI_${testBranch}`, code: `BERNOULLI_${testBranch}`, name: `Prof. Bernoulli ${testBranch}`, department: testBranch, status: 'active' });

    // Simulate import of a staged contract with different class_name ('DME' or 'DIFF_CODE') for the same (Dept, Year, Sem, Sec)
    const stagedContract = {
        class_name: 'DME_DIFFERENT_CODE',
        academic_year: '2025-2026',
        semester: 4,
        section: 'A',
        entries: [
            {
                day: 'Monday',
                period: 1,
                subject_name: `Thermodynamics ${testBranch}`,
                subject_code: `ME_401_${testBranch}`,
                faculty_name: `Prof. Carnot ${testBranch}`,
                session_type: 'theory'
            },
            {
                day: 'Tuesday',
                period: 2,
                subject_name: `Fluid Mechanics ${testBranch}`,
                subject_code: `ME_402_${testBranch}`,
                faculty_name: `Prof. Bernoulli ${testBranch}`,
                session_type: 'theory'
            }
        ]
    };

    const uploadsData = require('../src/data/uploads');
    const uploadRecord = await uploadsData.saveUploadRecord({
        originalFilename: 'test.csv',
        mimeType: 'text/csv',
        departmentCode: testBranch,
        status: 'UPLOADED',
        uploaderUserId: 'tester'
    });

    // Staging mock row in DB
    await db.query(`
        INSERT INTO timetable_staging (upload_id, validation_status, import_status, extracted_json)
        VALUES ($1, 'VALID', 'STAGED', $2)
    `, [uploadRecord.uploadId, JSON.stringify(stagedContract)]);

    console.log(`[3] Attempting importStagedTimetable with class_name="DME_DIFFERENT_CODE" for existing scope...`);

    const result = await repository.importStagedTimetable({
        uploadRecord: uploadRecord,
        stagedContract,
        resolvedMap: {},
        userId: 'tester'
    });

    console.log(`    Import Status: SUCCESS, Imported Count: ${result.importedCount}`);
    assert.strictEqual(result.importedCount, 2);

    // Verify that NO duplicate class was created and existing class ID was reused
    const classesAfter = await db.query('SELECT * FROM classes WHERE department_id = $1', [deptId]);
    console.log(`[4] Classes in DB for ${testBranch} after import: ${classesAfter.rows.length}`);
    assert.strictEqual(classesAfter.rows.length, 1, 'Exactly one class should exist, no duplicate created');
    assert.strictEqual(classesAfter.rows[0].id, initialClassId, 'Initial class ID must be reused');

    // Verify timetable entries point to initialClassId
    const ttEntries = await db.query('SELECT * FROM timetable WHERE class_id = $1', [initialClassId]);
    console.log(`[5] Timetable entries in DB for class ${initialClassId}: ${ttEntries.rows.length}`);
    assert.strictEqual(ttEntries.rows.length, 2);

    // Test resolveOrCreateClass with the same scope
    const resolved = await repository.resolveOrCreateClass({
        branch: testBranch,
        academicYear: '2025-2026',
        semester: 'SEM-4',
        section: 'A'
    });
    console.log(`[6] resolveOrCreateClass returned class ID: ${resolved.id} (${resolved.code})`);
    assert.strictEqual(resolved.id, initialClassId, 'resolveOrCreateClass must reuse initialClassId');

    // Clean up test records safely
    await db.query('DELETE FROM timetable WHERE class_id = $1', [initialClassId]);
    await db.query('DELETE FROM classes WHERE department_id = $1', [deptId]);
    await db.query('DELETE FROM timetable_staging WHERE upload_id = $1', [uploadRecord.uploadId]);
    await db.query('DELETE FROM timetable_uploads WHERE upload_id = $1', [uploadRecord.uploadId]);
    await db.query('DELETE FROM departments WHERE id = $1', [deptId]);

    // =========================================================================
    // PART 4 REGRESSION SCENARIO:
    // Create CME + 2026-27 + SEM-5 + A (code: CME-A).
    // Import into CME + 2026-27 + SEM-5 + Section A -> reuses CME-A.
    // Import into CME + 2026-27 + SEM-4 + Section A -> creates exactly one new SEM-4 class.
    // Re-import into CME + 2026-27 + SEM-5 + Section A -> reuses CME-A without duplicate constraint error.
    // =========================================================================
    console.log('\n--- PART 4 REGRESSION SCENARIO ---');
    const cmeBranch = 'CME_P4_' + Math.floor(Math.random() * 10000);
    await repository.addDepartment({
        code: cmeBranch,
        name: `Department ${cmeBranch}`,
        totalSemesters: 6,
        academicYear: '2026-27',
        semester: 5
    });
    const cmeDeptQ = await db.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [cmeBranch]);
    const cmeDeptId = cmeDeptQ.rows[0].id;

    // 1. Create existing class CME-A for SEM-5, 2026-27, Section A
    const cmeClass5A = await repository.addClass({
        code: `${cmeBranch}-A`,
        department: cmeBranch,
        semester: 5,
        section: 'A',
        academicYear: '2026-27'
    });
    console.log(`[P4.1] Pre-created class ${cmeClass5A.code} (ID: ${cmeClass5A.id}) for SEM-5`);

    await repository.addSubject({ code: `PY_${cmeBranch}`, name: `Python ${cmeBranch}`, department: cmeBranch, subjectType: 'theory' });
    await repository.addFaculty({ id: `KUSUMA_${cmeBranch}`, code: `KUSUMA_${cmeBranch}`, name: `Ms. B.Kusuma ${cmeBranch}`, department: cmeBranch, status: 'active' });

    // 2. Upload/import timetable targeting CME + 2026-27 + SEM-5 + A
    const upload1 = await uploadsData.saveUploadRecord({
        originalFilename: 'sem5_tt.csv',
        mimeType: 'text/csv',
        departmentCode: cmeBranch,
        status: 'UPLOADED',
        uploaderUserId: 'tester'
    });
    const sem5Contract = {
        class_name: 'DCME', // AI extracted class name different from code 'CME-A'
        academic_year: '2026-2027', // Variant of 2026-27
        semester: 5,
        section: 'A',
        entries: [
            {
                day: 'Monday',
                period: 1,
                subject_name: `Python ${cmeBranch}`,
                subject_code: `PY_${cmeBranch}`,
                faculty_name: `Ms. B.Kusuma ${cmeBranch}`,
                session_type: 'theory'
            }
        ]
    };
    await db.query(`
        INSERT INTO timetable_staging (upload_id, validation_status, import_status, extracted_json)
        VALUES ($1, 'VALID', 'STAGED', $2)
    `, [upload1.uploadId, JSON.stringify(sem5Contract)]);

    const imp1 = await repository.importStagedTimetable({
        uploadRecord: upload1,
        stagedContract: sem5Contract,
        resolvedMap: {},
        userId: 'tester',
        targetScope: {
            branch: cmeBranch,
            academicYear: '2026-27',
            semester: 5,
            section: 'A'
        }
    });
    console.log(`[P4.2] First SEM-5 import completed: ${imp1.importedCount} rows, classId: ${imp1.classId}`);
    assert.strictEqual(imp1.classId, cmeClass5A.id, 'First SEM-5 import MUST reuse existing class CME-A');

    // Verify class count is still 1
    const cmeClassesAfter1 = await db.query('SELECT * FROM classes WHERE department_id = $1', [cmeDeptId]);
    assert.strictEqual(cmeClassesAfter1.rows.length, 1, 'Only 1 class should exist');

    // 3. Import timetable into CME + 2026-27 + SEM-4 + A
    const upload2 = await uploadsData.saveUploadRecord({
        originalFilename: 'sem4_tt.csv',
        mimeType: 'text/csv',
        departmentCode: cmeBranch,
        status: 'UPLOADED',
        uploaderUserId: 'tester'
    });
    const sem4Contract = {
        class_name: 'DCME-4',
        academic_year: '2026-27',
        semester: 4,
        section: 'A',
        entries: [
            {
                day: 'Tuesday',
                period: 2,
                subject_name: `Python ${cmeBranch}`,
                subject_code: `PY_${cmeBranch}`,
                faculty_name: `Ms. B.Kusuma ${cmeBranch}`,
                session_type: 'theory'
            }
        ]
    };
    await db.query(`
        INSERT INTO timetable_staging (upload_id, validation_status, import_status, extracted_json)
        VALUES ($1, 'VALID', 'STAGED', $2)
    `, [upload2.uploadId, JSON.stringify(sem4Contract)]);

    const imp2 = await repository.importStagedTimetable({
        uploadRecord: upload2,
        stagedContract: sem4Contract,
        resolvedMap: {},
        userId: 'tester',
        targetScope: {
            branch: cmeBranch,
            academicYear: '2026-27',
            semester: 4,
            section: 'A'
        }
    });
    console.log(`[P4.3] SEM-4 import completed: ${imp2.importedCount} rows, classId: ${imp2.classId}`);
    assert.notStrictEqual(imp2.classId, cmeClass5A.id, 'SEM-4 must get a new/distinct class ID');

    // Verify exactly 2 classes now exist
    const cmeClassesAfter2 = await db.query('SELECT * FROM classes WHERE department_id = $1', [cmeDeptId]);
    assert.strictEqual(cmeClassesAfter2.rows.length, 2, 'Exactly 2 classes should now exist');

    // 4. Re-import again into SEM-5 + A
    const upload3 = await uploadsData.saveUploadRecord({
        originalFilename: 'sem5_reimport.csv',
        mimeType: 'text/csv',
        departmentCode: cmeBranch,
        status: 'UPLOADED',
        uploaderUserId: 'tester'
    });
    await db.query(`
        INSERT INTO timetable_staging (upload_id, validation_status, import_status, extracted_json)
        VALUES ($1, 'VALID', 'STAGED', $2)
    `, [upload3.uploadId, JSON.stringify(sem5Contract)]);

    const imp3 = await repository.importStagedTimetable({
        uploadRecord: upload3,
        stagedContract: sem5Contract,
        resolvedMap: {},
        userId: 'tester',
        targetScope: {
            branch: cmeBranch,
            academicYear: '2026-27',
            semester: 5,
            section: 'A'
        }
    });
    console.log(`[P4.4] Second SEM-5 re-import completed: ${imp3.importedCount} rows, classId: ${imp3.classId}`);
    assert.strictEqual(imp3.classId, cmeClass5A.id, 'Re-import into SEM-5 MUST reuse same original class_id');

    // Verify still exactly 2 classes exist
    const cmeClassesAfter3 = await db.query('SELECT * FROM classes WHERE department_id = $1', [cmeDeptId]);
    assert.strictEqual(cmeClassesAfter3.rows.length, 2, 'Still exactly 2 classes should exist');

    // Clean up P4 test records
    await db.query('DELETE FROM timetable WHERE class_id IN ($1, $2)', [cmeClass5A.id, imp2.classId]);
    await db.query('DELETE FROM classes WHERE department_id = $1', [cmeDeptId]);
    await db.query('DELETE FROM timetable_staging WHERE upload_id IN ($1, $2, $3)', [upload1.uploadId, upload2.uploadId, upload3.uploadId]);
    await db.query('DELETE FROM timetable_uploads WHERE upload_id IN ($1, $2, $3)', [upload1.uploadId, upload2.uploadId, upload3.uploadId]);
    await db.query('DELETE FROM departments WHERE id = $1', [cmeDeptId]);

    console.log('\n======================================================');
    console.log('✅ ALL CLASS REUSE & UNIQUE CONSTRAINT CHECKS PASSED!');
    console.log('======================================================\n');
}

testClassReuse().then(() => process.exit(0)).catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
