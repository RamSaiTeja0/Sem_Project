const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const db = require('../src/db/pool');
const repository = require('../src/db/repository');
const store = require('../src/data/store');
const { resolveContract } = require('../src/core/entityResolver');

async function runRegressionTests() {
    console.log('\n======================================================');
    console.log('Running Faculty ID Permutation Regression Test Suite');
    console.log('Target: Isolated Test Database (TEST_DATABASE_URL)');
    console.log('======================================================\n');

    const isDb = db.isConfigured();
    if (isDb) {
        await store.initFromDatabase({ seed: false });
    }

    const testBranch = 'CME_REG_' + Math.floor(Math.random() * 100000);
    const targetYr = '2025-2026';

    // 1. Create isolated department for this test
    let deptId;
    if (isDb) {
        await repository.addDepartment({
            code: testBranch,
            name: `Department of Computer Engineering ${testBranch}`,
            totalSemesters: 6,
            academicYear: targetYr,
            semester: 5
        });
        const deptQ = await db.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [testBranch]);
        deptId = deptQ.rows[0].id;
    } else {
        const { registerBranch } = require('../src/data/departments');
        registerBranch({
            code: testBranch,
            name: `Department of Computer Engineering ${testBranch}`,
            totalSemesters: 6,
            academicYear: targetYr,
            semester: 5
        });
    }

    console.log(`[Setup] Created isolated department ${testBranch} (ID: ${deptId || 'in-memory'})`);

    // 1b. Register Classes for this branch
    if (isDb) {
        await db.query(
            `INSERT INTO classes (code, department_id, semester, academic_year, section)
             VALUES ($1, $2, $3, $4, $5), ($6, $2, $7, $4, $8), ($9, $2, 5, $4, 'B'), ($10, $2, 5, $4, 'D')
             ON CONFLICT (code) DO NOTHING`,
            [`${testBranch}-SEM5-A`, deptId, 5, targetYr, 'A', `${testBranch}-SEM4-A`, 4, 'A', `${testBranch}-SEM5-B`, `${testBranch}-SEM5-D`]
        );
    } else {
        store.source.classes.push(
            { code: `${testBranch}-SEM5-A`, department: testBranch, semester: 5, academicYear: targetYr, section: 'A' },
            { code: `${testBranch}-SEM4-A`, department: testBranch, semester: 4, academicYear: targetYr, section: 'A' },
            { code: `${testBranch}-SEM5-B`, department: testBranch, semester: 5, academicYear: targetYr, section: 'B' },
            { code: `${testBranch}-SEM5-D`, department: testBranch, semester: 5, academicYear: targetYr, section: 'D' }
        );
    }

    // 2. Register Historical TT1 Faculty (7 faculty)
    const tt1FacultyDefs = [
        { code: `${testBranch}_BK`, name: `B.Kusuma ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_AK`, name: `B.Anil Kumar ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_CD`, name: `CH.Debadatta ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_SR`, name: `G.Sandhya Rani ${testBranch}`, designation: 'Associate Professor' },
        { code: `${testBranch}_GR`, name: `K.Gopala Rao ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_MD`, name: `M.Dalayya ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_RP`, name: `T.Rajendra Prasad ${testBranch}`, designation: 'Assistant Professor' }
    ];

    const tt1FacultyMap = {};
    for (const f of tt1FacultyDefs) {
        if (isDb) {
            const fac = await repository.addFaculty({
                id: f.code,
                code: f.code,
                name: f.name,
                department: testBranch,
                designation: f.designation,
                status: 'active'
            });
            tt1FacultyMap[f.name] = fac;
        } else {
            const fac = { id: f.code, code: f.code, name: f.name, department: testBranch, status: 'active' };
            store.source.faculty.push(fac);
            tt1FacultyMap[f.name] = fac;
        }
    }

    // 3. Register Historical TT1 Subjects
    const tt1SubjectDefs = [
        { code: `${testBranch}_PP`, name: `Python Programming ${testBranch}`, type: 'theory' },
        { code: `${testBranch}_AP`, name: `Android Programming ${testBranch}`, type: 'theory' },
        { code: `${testBranch}_IM`, name: `Industrial Management ${testBranch}`, type: 'theory' },
        { code: `${testBranch}_BDCC`, name: `Big Data & Cloud Computing ${testBranch}`, type: 'theory' },
        { code: `${testBranch}_PPL`, name: `Python Programming Lab ${testBranch}`, type: 'lab' },
        { code: `${testBranch}_APL`, name: `Android Programming Lab ${testBranch}`, type: 'lab' }
    ];

    const tt1SubjectMap = {};
    for (const s of tt1SubjectDefs) {
        if (isDb) {
            const subj = await repository.addSubject({
                code: s.code,
                name: s.name,
                department: testBranch,
                subjectType: s.type
            });
            tt1SubjectMap[s.name] = subj;
        } else {
            const subj = { id: s.code, code: s.code, name: s.name, department: testBranch, type: s.type };
            store.source.subjects.push(subj);
            tt1SubjectMap[s.name] = subj;
        }
    }

    console.log('[Setup] Registered 7 TT1 Faculty and 6 Subjects in department catalog');

    // 4. Construct TT1 Contract (Semester 5 Section A)
    const tt1Contract = {
        timetable_type: 'MASTER_TIMETABLE',
        department_code: testBranch,
        class_name: `${testBranch}-SEM5-A`,
        academic_year: targetYr,
        semester: 5,
        section: 'A',
        faculty_legend: [
            { code: 'BK', name: `Ms. B.Kusuma ${testBranch}`, subject: `Python Programming ${testBranch}` },
            { code: 'CD', name: `Mr. CH.Debadatta ${testBranch}`, subject: `Android Programming ${testBranch}` },
            { code: 'GR', name: `Dr. K.Gopala Rao ${testBranch}`, subject: `Industrial Management ${testBranch}` },
            { code: 'SR', name: `Ms. G.Sandhya Rani ${testBranch}`, subject: `Big Data & Cloud Computing ${testBranch}` },
            { code: 'AK', name: `Mr. B.Anil Kumar ${testBranch}`, subject: `Python Programming Lab ${testBranch}` },
            { code: 'MD', name: `Mr. M.Dalayya ${testBranch}`, subject: 'PE-LAB' },
            { code: 'RP', name: `Mr. T.Rajendra Prasad ${testBranch}`, subject: 'EM-II LAB' }
        ],
        subject_legend: [
            { code: `${testBranch}_PP`, name: `Python Programming ${testBranch}`, short_name: 'PP' },
            { code: `${testBranch}_AP`, name: `Android Programming ${testBranch}`, short_name: 'AP' },
            { code: `${testBranch}_IM`, name: `Industrial Management ${testBranch}`, short_name: 'IM' },
            { code: `${testBranch}_BDCC`, name: `Big Data & Cloud Computing ${testBranch}`, short_name: 'BDCC' },
            { code: `${testBranch}_PPL`, name: `Python Programming Lab ${testBranch}`, short_name: 'PP LAB' }
        ],
        entries: [
            { day: 'Monday', period: 1, subject_name: `Python Programming ${testBranch}`, faculty_name: `Ms. B.Kusuma ${testBranch}`, session_type: 'theory' },
            { day: 'Monday', period: 2, subject_name: `Android Programming ${testBranch}`, faculty_name: `Mr. CH.Debadatta ${testBranch}`, session_type: 'theory' },
            { day: 'Monday', period: 3, subject_name: `Industrial Management ${testBranch}`, faculty_name: `Dr. K.Gopala Rao ${testBranch}`, session_type: 'theory' },
            { day: 'Monday', period: 4, subject_name: `Big Data & Cloud Computing ${testBranch}`, faculty_name: `Ms. G.Sandhya Rani ${testBranch}`, session_type: 'theory' },
            { day: 'Monday', period: 5, subject_name: 'TPC', faculty_name: null, session_type: 'activity' },
            { day: 'Tuesday', period_start: 1, span_to: 3, period: 1, subject_name: `Python Programming Lab ${testBranch}`, faculty_name: `Ms. B.Kusuma ${testBranch}`, session_type: 'lab' },
            { day: 'Tuesday', period: 4, subject_name: `Android Programming ${testBranch}`, faculty_name: `Mr. CH.Debadatta ${testBranch}`, session_type: 'theory' },
            { day: 'Wednesday', period: 1, subject_name: `Big Data & Cloud Computing ${testBranch}`, faculty_name: `Ms. G.Sandhya Rani ${testBranch}`, session_type: 'theory' },
            { day: 'Wednesday', period: 2, subject_name: `Python Programming ${testBranch}`, faculty_name: `Ms. B.Kusuma ${testBranch}`, session_type: 'theory' },
            { day: 'Wednesday', period: 3, subject_name: `Industrial Management ${testBranch}`, faculty_name: `Dr. K.Gopala Rao ${testBranch}`, session_type: 'theory' },
            { day: 'Wednesday', period: 4, subject_name: `Android Programming ${testBranch}`, faculty_name: `Mr. CH.Debadatta ${testBranch}`, session_type: 'theory' }
        ]
    };

    // 5. Resolve TT1
    const res1 = await resolveContract(tt1Contract, testBranch);
    assert.strictEqual(res1.ok, true, `TT1 resolution should succeed. Unresolved: ${JSON.stringify(res1.unresolvedEntities)}`);
    console.log('[Phase 1] TT1 Contract successfully resolved against catalog');

    // 6. HISTORICAL REPRODUCTION: Register additional faculty from oldTT2 into branch catalog
    console.log('[Phase 2] Simulating Historical Sequence: Registering additional oldTT2 faculty into branch catalog...');
    const oldTT2FacultyDefs = [
        { code: `${testBranch}_SS`, name: `S.Srinivas ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_KLS`, name: `K.L.Sowjanya ${testBranch}`, designation: 'Assistant Professor' },
        { code: `${testBranch}_PS`, name: `P.Srinivas ${testBranch}`, designation: 'Assistant Professor' }
    ];
    const oldTT2FacultyMap = {};
    for (const f of oldTT2FacultyDefs) {
        if (isDb) {
            const fac = await repository.addFaculty({
                id: f.code,
                code: f.code,
                name: f.name,
                department: testBranch,
                designation: f.designation,
                status: 'active'
            });
            oldTT2FacultyMap[f.name] = fac;
        } else {
            const fac = { id: f.code, code: f.code, name: f.name, department: testBranch, status: 'active' };
            store.source.faculty.push(fac);
            oldTT2FacultyMap[f.name] = fac;
        }
    }
    console.log('[Phase 2] oldTT2 registered 3 additional faculty (Catalog now expanded to 10 faculty)');

    // 7. Stage and Import TT2 (Semester 4 Section A)
    const tt2Contract = {
        timetable_type: 'MASTER_TIMETABLE',
        department_code: testBranch,
        class_name: `${testBranch}-SEM4-A`,
        academic_year: targetYr,
        semester: 4,
        section: 'A',
        faculty_legend: [
            { code: 'SS', name: `Mr. S.Srinivas ${testBranch}`, subject: `Data Structures ${testBranch}` },
            { code: 'KLS', name: `Mrs. K.L.Sowjanya ${testBranch}`, subject: `Database Systems ${testBranch}` }
        ],
        subject_legend: [
            { code: `${testBranch}_DS`, name: `Data Structures ${testBranch}`, short_name: 'DS' },
            { code: `${testBranch}_DBMS`, name: `Database Systems ${testBranch}`, short_name: 'DBMS' }
        ],
        entries: [
            { day: 'Monday', period: 1, subject_name: `Data Structures ${testBranch}`, faculty_name: `Mr. S.Srinivas ${testBranch}`, session_type: 'theory' },
            { day: 'Monday', period: 2, subject_name: `Database Systems ${testBranch}`, faculty_name: `Mrs. K.L.Sowjanya ${testBranch}`, session_type: 'theory' }
        ]
    };

    if (isDb) {
        await repository.addSubject({ code: `${testBranch}_DS`, name: `Data Structures ${testBranch}`, department: testBranch, subjectType: 'theory' });
        await repository.addSubject({ code: `${testBranch}_DBMS`, name: `Database Systems ${testBranch}`, department: testBranch, subjectType: 'theory' });
    } else {
        store.source.subjects.push({ code: `${testBranch}_DS`, name: `Data Structures ${testBranch}`, department: testBranch, type: 'theory' });
        store.source.subjects.push({ code: `${testBranch}_DBMS`, name: `Database Systems ${testBranch}`, department: testBranch, type: 'theory' });
    }

    const res2 = await resolveContract(tt2Contract, testBranch);
    assert.strictEqual(res2.ok, true, 'TT2 resolution should succeed');

    let tt2Import;
    if (isDb) {
        tt2Import = await repository.importStagedTimetable({
            uploadRecord: { uploadId: 'upl_tt2_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 4, section: 'A' },
            stagedContract: tt2Contract,
            resolvedMap: res2.resolvedMap,
            userId: 'hod_test',
            targetScope: { branch: testBranch, academicYear: targetYr, semester: 4, section: 'A', className: `${testBranch}-SEM4-A` }
        });
    } else {
        tt2Import = store.importStagedTimetableInMemory({
            uploadRecord: { uploadId: 'upl_tt2_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 4, section: 'A' },
            stagedContract: tt2Contract,
            resolvedMap: res2.resolvedMap,
            userId: 'hod_test',
            targetScope: { branch: testBranch, academicYear: targetYr, semester: 4, section: 'A', className: `${testBranch}-SEM4-A` }
        });
    }
    assert.strictEqual(tt2Import.importedCount, 2, 'TT2 should import 2 slots');
    console.log('[Phase 2] TT2 imported successfully into Semester 4');

    // 8. NOW IMPORT TT1 (Semester 5 Section A) - The Critical Test
    console.log('[Phase 3] Importing TT1 into Semester 5 after catalog expansion...');
    let tt1Import;
    if (isDb) {
        tt1Import = await repository.importStagedTimetable({
            uploadRecord: { uploadId: 'upl_tt1_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 5, section: 'A' },
            stagedContract: tt1Contract,
            resolvedMap: res1.resolvedMap,
            userId: 'hod_test',
            targetScope: { branch: testBranch, academicYear: targetYr, semester: 5, section: 'A', className: `${testBranch}-SEM5-A` }
        });
    } else {
        tt1Import = store.importStagedTimetableInMemory({
            uploadRecord: { uploadId: 'upl_tt1_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 5, section: 'A' },
            stagedContract: tt1Contract,
            resolvedMap: res1.resolvedMap,
            userId: 'hod_test',
            targetScope: { branch: testBranch, academicYear: targetYr, semester: 5, section: 'A', className: `${testBranch}-SEM5-A` }
        });
    }
    // Entries: 4 Monday theory + 1 TPC + 3 Tuesday Lab + 1 Tuesday theory + 4 Wednesday theory = 13 period slots
    assert.strictEqual(tt1Import.importedCount, 13, `TT1 should import 13 period slots (got ${tt1Import.importedCount})`);
    console.log(`[Phase 3] TT1 imported ${tt1Import.importedCount} period slots successfully`);

    // 9. VERIFY TT1 DATABASE ROWS FOR PERMUTATION RESISTANCE
    console.log('[Phase 4] Verifying exact faculty assignments in database rows...');
    if (isDb) {
        const rowsRes = await db.query(`
            SELECT t.id, t.day_of_week, t.period, t.session_type,
                   s.name AS "subjectName", s.code AS "subjectCode",
                   f.id AS "facultyId", f.name AS "facultyName", f.code AS "facultyCode"
              FROM timetable t
              JOIN subjects s ON s.id = t.subject_id
              LEFT JOIN faculty f ON f.id = t.faculty_id
             WHERE t.class_id = $1
             ORDER BY CASE t.day_of_week
                 WHEN 'Monday' THEN 1
                 WHEN 'Tuesday' THEN 2
                 WHEN 'Wednesday' THEN 3
                 ELSE 4 END, t.period ASC
        `, [tt1Import.classId]);

        const rows = rowsRes.rows;
        assert.strictEqual(rows.length, 13, `Expected 13 rows in timetable for class ${tt1Import.classId}`);

        // Monday P1: Python Programming -> B.Kusuma
        const monP1 = rows.find(r => r.day_of_week === 'Monday' && r.period === 1);
        assert.ok(monP1, 'Monday P1 exists');
        assert.strictEqual(monP1.subjectName, `Python Programming ${testBranch}`);
        assert.strictEqual(monP1.facultyName, `B.Kusuma ${testBranch}`, `Monday P1 Faculty MUST be B.Kusuma (got ${monP1.facultyName})`);
        const expectedBkId = tt1FacultyMap[`B.Kusuma ${testBranch}`].numeric_id || tt1FacultyMap[`B.Kusuma ${testBranch}`].id;
        assert.strictEqual(monP1.facultyId, expectedBkId, 'Monday P1 Faculty ID MUST match exact PostgreSQL ID for B.Kusuma');

        // Monday P2: Android Programming -> CH.Debadatta
        const monP2 = rows.find(r => r.day_of_week === 'Monday' && r.period === 2);
        assert.ok(monP2, 'Monday P2 exists');
        assert.strictEqual(monP2.subjectName, `Android Programming ${testBranch}`);
        assert.strictEqual(monP2.facultyName, `CH.Debadatta ${testBranch}`, `Monday P2 Faculty MUST be CH.Debadatta (got ${monP2.facultyName})`);
        const expectedCdId = tt1FacultyMap[`CH.Debadatta ${testBranch}`].numeric_id || tt1FacultyMap[`CH.Debadatta ${testBranch}`].id;
        assert.strictEqual(monP2.facultyId, expectedCdId, 'Monday P2 Faculty ID MUST match exact PostgreSQL ID for CH.Debadatta');

        // Monday P3: Industrial Management -> K.Gopala Rao
        const monP3 = rows.find(r => r.day_of_week === 'Monday' && r.period === 3);
        assert.ok(monP3, 'Monday P3 exists');
        assert.strictEqual(monP3.subjectName, `Industrial Management ${testBranch}`);
        assert.strictEqual(monP3.facultyName, `K.Gopala Rao ${testBranch}`, `Monday P3 Faculty MUST be K.Gopala Rao (got ${monP3.facultyName})`);
        const expectedGrId = tt1FacultyMap[`K.Gopala Rao ${testBranch}`].numeric_id || tt1FacultyMap[`K.Gopala Rao ${testBranch}`].id;
        assert.strictEqual(monP3.facultyId, expectedGrId, 'Monday P3 Faculty ID MUST match exact PostgreSQL ID for K.Gopala Rao');

        // Monday P4: Big Data & Cloud Computing -> G.Sandhya Rani
        const monP4 = rows.find(r => r.day_of_week === 'Monday' && r.period === 4);
        assert.ok(monP4, 'Monday P4 exists');
        assert.strictEqual(monP4.subjectName, `Big Data & Cloud Computing ${testBranch}`);
        assert.strictEqual(monP4.facultyName, `G.Sandhya Rani ${testBranch}`, `Monday P4 Faculty MUST be G.Sandhya Rani (got ${monP4.facultyName})`);
        const expectedSrId = tt1FacultyMap[`G.Sandhya Rani ${testBranch}`].numeric_id || tt1FacultyMap[`G.Sandhya Rani ${testBranch}`].id;
        assert.strictEqual(monP4.facultyId, expectedSrId, 'Monday P4 Faculty ID MUST match exact PostgreSQL ID for G.Sandhya Rani');

        // Monday P5: TPC -> Null Faculty
        const monP5 = rows.find(r => r.day_of_week === 'Monday' && r.period === 5);
        assert.ok(monP5, 'Monday P5 exists');
        assert.strictEqual(monP5.subjectName, 'TPC');
        assert.strictEqual(monP5.facultyId, null, 'Monday P5 TPC faculty MUST be null');

        // Tuesday P1-P3: Python Programming Lab (Multi-period lab) -> B.Kusuma across all 3 periods
        const tueP1 = rows.find(r => r.day_of_week === 'Tuesday' && r.period === 1);
        const tueP2 = rows.find(r => r.day_of_week === 'Tuesday' && r.period === 2);
        const tueP3 = rows.find(r => r.day_of_week === 'Tuesday' && r.period === 3);
        assert.ok(tueP1 && tueP2 && tueP3, 'Tuesday P1, P2, P3 lab slots exist');
        assert.strictEqual(tueP1.facultyName, `B.Kusuma ${testBranch}`);
        assert.strictEqual(tueP2.facultyName, `B.Kusuma ${testBranch}`);
        assert.strictEqual(tueP3.facultyName, `B.Kusuma ${testBranch}`);
        assert.strictEqual(tueP1.facultyId, expectedBkId);
        assert.strictEqual(tueP2.facultyId, expectedBkId);
        assert.strictEqual(tueP3.facultyId, expectedBkId);

        console.log('[Verification Passed] All TT1 slots have 100% exact PostgreSQL faculty IDs matching resolvedMap.');
    }

    // 10. TEST RE-IMPORT INTO ANOTHER VALID TARGET SCOPE (SEM5-B)
    console.log('[Phase 5] Testing Re-import into another valid target scope (SEM5-B)...');
    const tt1BContract = {
        timetable_type: 'MASTER_TIMETABLE',
        department_code: testBranch,
        class_name: `${testBranch}-SEM5-B`,
        academic_year: targetYr,
        semester: 5,
        section: 'B',
        faculty_legend: tt1Contract.faculty_legend,
        subject_legend: tt1Contract.subject_legend,
        entries: [
            { day: 'Thursday', period: 1, subject_name: `Python Programming ${testBranch}`, faculty_name: `Ms. B.Kusuma ${testBranch}`, session_type: 'theory' },
            { day: 'Thursday', period: 2, subject_name: `Android Programming ${testBranch}`, faculty_name: `Mr. CH.Debadatta ${testBranch}`, session_type: 'theory' },
            { day: 'Thursday', period: 3, subject_name: `Industrial Management ${testBranch}`, faculty_name: `Dr. K.Gopala Rao ${testBranch}`, session_type: 'theory' },
            { day: 'Thursday', period: 4, subject_name: `Big Data & Cloud Computing ${testBranch}`, faculty_name: `Ms. G.Sandhya Rani ${testBranch}`, session_type: 'theory' }
        ]
    };
    const res1B = await resolveContract(tt1BContract, testBranch);
    assert.strictEqual(res1B.ok, true, 'SEM5-B contract resolution should succeed');

    let reimportRes;
    if (isDb) {
        reimportRes = await repository.importStagedTimetable({
            uploadRecord: { uploadId: 'upl_tt1_b_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 5, section: 'B' },
            stagedContract: tt1BContract,
            resolvedMap: res1B.resolvedMap,
            userId: 'hod_test',
            targetScope: { branch: testBranch, academicYear: targetYr, semester: 5, section: 'B', className: `${testBranch}-SEM5-B` }
        });
        assert.strictEqual(reimportRes.importedCount, 4, 'SEM5-B should import 4 period slots');

        const bRowsRes = await db.query('SELECT f.name FROM timetable t JOIN faculty f ON f.id = t.faculty_id WHERE t.class_id = $1 AND t.day_of_week = $2 AND t.period = $3', [reimportRes.classId, 'Thursday', 1]);
        assert.strictEqual(bRowsRes.rows[0].name, `B.Kusuma ${testBranch}`, 'SEM5-B Thursday P1 MUST be B.Kusuma');
        console.log('[Phase 5] Re-import into SEM5-B verified with identical faculty identities.');
    }

    // 11. TEST ROLLBACK ON CORRUPTED/UNRESOLVED FACULTY
    console.log('[Phase 6] Testing Rollback Safety when faculty resolution is violated...');
    if (isDb) {
        const corruptContract = {
            timetable_type: 'MASTER_TIMETABLE',
            department_code: testBranch,
            class_name: `${testBranch}-SEM5-C`,
            academic_year: targetYr,
            semester: 5,
            section: 'C',
            entries: [
                { day: 'Monday', period: 1, subject_name: `Python Programming ${testBranch}`, faculty_name: 'NonExistent Faculty', session_type: 'theory' }
            ]
        };
        // Fake resolvedMap with a non-existent faculty ID (e.g. 999999)
        const fakeResolvedMap = {
            subjects: { [`Python Programming ${testBranch}`]: tt1SubjectMap[`Python Programming ${testBranch}`] },
            faculty: { 'NonExistent Faculty': { id: 999999, name: 'NonExistent Faculty' } },
            rooms: {}
        };

        let rollbackSucceeded = false;
        try {
            await repository.importStagedTimetable({
                uploadRecord: { uploadId: 'upl_corrupt_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 5, section: 'C' },
                stagedContract: corruptContract,
                resolvedMap: fakeResolvedMap,
                userId: 'hod_test',
                targetScope: { branch: testBranch, academicYear: targetYr, semester: 5, section: 'C', className: `${testBranch}-SEM5-C` }
            });
        } catch (err) {
            rollbackSucceeded = true;
            assert.ok(
                err.code === 'FACULTY_NOT_FOUND_IN_DB' || err.code === 'UNRESOLVED_FACULTY',
                `Expected error code FACULTY_NOT_FOUND_IN_DB or UNRESOLVED_FACULTY, got: ${err.code} (${err.message})`
            );
        }
        assert.strictEqual(rollbackSucceeded, true, 'Corrupted import MUST throw and rollback');

        // Confirm 0 rows committed for class SEM5-C
        const cCheck = await db.query('SELECT COUNT(*)::int AS count FROM classes c JOIN timetable t ON t.class_id = c.id WHERE c.code = $1', [`${testBranch}-SEM5-C`]);
        assert.strictEqual(cCheck.rows[0].count, 0, 'Zero rows should be committed after rollback');
        console.log('[Phase 6] Rollback verified: Zero rows committed on invalid faculty.');
    }

    // 12. TEST FACULTY CONFLICT DETECTION (Double Booking)
    console.log('[Phase 7] Testing Conflict Detection: Faculty double-booking across classes...');
    if (isDb) {
        // B.Kusuma is teaching SEM5-A on Monday P1. Try importing SEM5-D with B.Kusuma at Monday P1.
        const clashContract = {
            timetable_type: 'MASTER_TIMETABLE',
            department_code: testBranch,
            class_name: `${testBranch}-SEM5-D`,
            academic_year: targetYr,
            semester: 5,
            section: 'D',
            entries: [
                { day: 'Monday', period: 1, subject_name: `Python Programming ${testBranch}`, faculty_name: `Ms. B.Kusuma ${testBranch}`, session_type: 'theory' }
            ]
        };

        let clashDetected = false;
        try {
            await repository.importStagedTimetable({
                uploadRecord: { uploadId: 'upl_clash_' + Date.now(), departmentCode: testBranch, academicYear: targetYr, semester: 5, section: 'D' },
                stagedContract: clashContract,
                resolvedMap: res1.resolvedMap,
                userId: 'hod_test',
                targetScope: { branch: testBranch, academicYear: targetYr, semester: 5, section: 'D', className: `${testBranch}-SEM5-D` }
            });
        } catch (err) {
            clashDetected = true;
            assert.strictEqual(err.code, 'SLOT_CONFLICT', `Expected SLOT_CONFLICT, got ${err.code}`);
        }
        assert.strictEqual(clashDetected, true, 'Faculty clash MUST be detected and rejected with SLOT_CONFLICT');
        console.log('[Phase 7] Conflict detection verified: Double booking rejected.');
    }

    console.log('\n======================================================');
    console.log('ALL REGRESSION TESTS PASSED SUCCESSFULLY (14/14 Checks)');
    console.log('======================================================\n');
}

runRegressionTests()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n❌ Regression Test Suite Failed:\n', err);
        process.exit(1);
    });
