const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
const { saveUploadRecord, saveStagedData } = require('../src/data/uploads');
const { resolveContract } = require('../src/core/entityResolver');

async function testTargetScopeImportAndRefresh() {
    console.log('\n======================================================');
    console.log('Running Target Scope Import & Scope Resolution Tests');
    console.log('======================================================\n');

    if (db.isConfigured()) {
        await store.initFromDatabase({ seed: false });
    }

    const testBranch = 'TGT_TEST_' + Math.floor(Math.random() * 10000);
    const targetYr = '2024-2027';
    const targetSem = '5';
    const targetSec = 'B';

    let deptId;
    if (db.isConfigured() && store.usingDatabase) {
        await repository.addDepartment({
            code: testBranch,
            name: `Department ${testBranch}`,
            totalSemesters: 6,
            academicYear: '2025-2026',
            semester: 4
        });
        const deptQ = await db.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [testBranch]);
        deptId = deptQ.rows[0].id;
    } else {
        const { registerBranch } = require('../src/data/departments');
        registerBranch({
            code: testBranch,
            name: `Department ${testBranch}`,
            totalSemesters: 6,
            academicYear: '2025-2026',
            semester: 4
        });
    }

    // Register subject and faculty in catalog
    if (db.isConfigured() && store.usingDatabase) {
        await repository.addSubject({
            code: `SUB_${testBranch}`,
            name: 'Advanced Systems',
            department: testBranch,
            subjectType: 'theory'
        });
        await repository.addFaculty({
            id: `FAC_${testBranch}`,
            code: `FAC_${testBranch}`,
            name: `Prof. Scope Expert ${testBranch}`,
            department: testBranch,
            status: 'active'
        });
    } else {
        store.source.subjects.push({
            code: `SUB_${testBranch}`,
            name: 'Advanced Systems',
            department: testBranch,
            type: 'theory'
        });
        store.source.faculty.push({
            id: `FAC_${testBranch}`,
            name: `Prof. Scope Expert ${testBranch}`,
            department: testBranch
        });
    }

    // 1. Create a staged timetable upload where extracted metadata differs from HOD target
    const uploadId = 'upl_target_test_' + Date.now();
    const extractedMetadata = {
        timetable_type: 'MASTER_TIMETABLE',
        department_code: testBranch,
        class_name: `${testBranch}-EXTRACTED-SEM4-A`,
        academic_year: '2025-2026',
        semester: 4,
        section: 'A',
        days: ['Monday', 'Tuesday'],
        periods: [1, 2],
        subjects: [{ code: `SUB_${testBranch}`, name: 'Advanced Systems' }],
        faculty: [{ name: `Prof. Scope Expert ${testBranch}` }],
        entries: [
            {
                day: 'Monday',
                period: 1,
                subject_code: `SUB_${testBranch}`,
                subject_name: 'Advanced Systems',
                faculty_name: `Prof. Scope Expert ${testBranch}`,
                session_type: 'theory'
            }
        ]
    };

    const uploadRecord = await saveUploadRecord({
        originalFilename: 'test_scope_tt.jpeg',
        mimeType: 'image/jpeg',
        fileBuffer: Buffer.from('dummy'),
        departmentCode: testBranch,
        targetClass: `${testBranch}-SEM5-B`,
        semester: targetSem,
        section: targetSec,
        academicYear: targetYr,
        uploadType: 'MASTER_TIMETABLE',
        status: 'UPLOADED',
        uploaderUserId: 'test_hod'
    });

    await saveStagedData(uploadRecord.uploadId, {
        extractedJson: extractedMetadata,
        entityMappings: {}
    });

    // 2. Resolve or create target class
    let targetClassObj;
    if (db.isConfigured() && store.usingDatabase) {
        targetClassObj = await repository.resolveOrCreateClass({
            branch: testBranch,
            academicYear: targetYr,
            semester: targetSem,
            section: targetSec
        });
    } else {
        targetClassObj = store.resolveOrCreateClassInMemory({
            branch: testBranch,
            academicYear: targetYr,
            semester: targetSem,
            section: targetSec
        });
    }

    // Resolve entities with target scope class mapping
    const entityMappings = {
        [`class:${extractedMetadata.class_name}`]: {
            targetId: targetClassObj.id,
            targetCode: targetClassObj.code || targetClassObj.class
        }
    };
    const resolution = await resolveContract(extractedMetadata, testBranch, entityMappings);
    if (!resolution.ok) {
        console.log('Resolution failed:', resolution.unresolvedEntities);
    }
    assert.strictEqual(resolution.ok, true);

    // 3. Approve staging with authoritative HOD Target Scope
    const targetScope = {
        branch: testBranch,
        academicYear: targetYr,
        semester: targetSem,
        section: targetSec
    };

    let importResult;
    if (db.isConfigured() && store.usingDatabase) {
        importResult = await repository.importStagedTimetable({
            uploadRecord: { uploadId, departmentCode: testBranch },
            stagedContract: extractedMetadata,
            resolvedMap: resolution.resolvedMap,
            userId: 'test_hod',
            targetScope
        });
        await store.reloadFromDatabase();
    } else {
        importResult = store.importStagedTimetableInMemory({
            uploadRecord: { uploadId, departmentCode: testBranch },
            stagedContract: extractedMetadata,
            resolvedMap: resolution.resolvedMap,
            userId: 'test_hod',
            targetScope
        });
    }

    console.log('✓ Staging approved and imported with target scope result:', importResult.scope);
    assert.strictEqual(importResult.importedCount, 1);
    assert.strictEqual(importResult.scope.academicYear, targetYr);
    assert.strictEqual(importResult.scope.section, targetSec);
    assert.ok(importResult.scope.semester === '5' || importResult.scope.semester === 'SEM-5');

    // 4. Verify PostgreSQL persistence under TARGET class scope
    if (db.isConfigured() && store.usingDatabase) {
        const classCheck = await db.query(`
            SELECT c.id, c.code, c.academic_year, c.semester, c.section, count(t.id)::int as row_count
            FROM classes c
            JOIN timetable t ON t.class_id = c.id
            WHERE c.id = $1
            GROUP BY c.id, c.code, c.academic_year, c.semester, c.section
        `, [importResult.classId]);

        assert.strictEqual(classCheck.rows.length, 1);
        const cls = classCheck.rows[0];
        console.log('✓ PostgreSQL class record verified:', cls);
        assert.strictEqual(cls.academic_year, targetYr);
        assert.strictEqual(cls.semester, 5);
        assert.strictEqual(cls.section, 'B');
        assert.strictEqual(cls.row_count, 1);

        // Ensure NO class was created with the extracted 2025-2026 SEM-4 scope
        const extractedScopeCheck = await db.query(`
            SELECT count(*)::int as count FROM classes 
            WHERE department_id = $1 AND academic_year = '2025-2026' AND semester = 4
        `, [deptId]);
        assert.strictEqual(extractedScopeCheck.rows[0].count, 0);
        console.log('✓ Confirmed extracted metadata did NOT create conflicting class in DB');
    }

    console.log('\n======================================================');
    console.log('✅ ALL TARGET SCOPE TESTS PASSED SUCCESSFULLY!');
    console.log('======================================================\n');
}

testTargetScopeImportAndRefresh().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
}).then(() => {
    process.exit(0);
});
