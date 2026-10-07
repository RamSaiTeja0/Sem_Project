const assert = require('assert');
const { resolveContract, fetchBranchCatalog } = require('../src/core/entityResolver');
const { normalizeExtractedContract } = require('../src/services/extractionPipeline');
const store = require('../src/data/store');

async function runTests() {
    console.log('======================================================');
    console.log('Running Real-Pipeline Subject->Faculty Resolution Regression Tests');
    console.log('======================================================\n');

    let passed = 0;
    let failed = 0;

    function check(description, fn) {
        return Promise.resolve()
            .then(fn)
            .then(() => {
                console.log(`✓ ${description}`);
                passed++;
            })
            .catch(err => {
                console.error(`✗ ${description}`);
                console.error('  Error:', err.message || err);
                failed++;
            });
    }

    // Set up in-memory store fixture
    store.replace({
        allowEmpty: true,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        classes: [
            { code: 'EEE', class: 'EEE', semester: 1, section: 'A', department: 'EEE' },
            { code: 'CME', class: 'CME', semester: 1, section: 'A', department: 'CME' },
            { code: 'MEC', class: 'MEC', semester: 1, section: 'A', department: 'MEC' }
        ],
        subjects: [
            { name: 'Engineering Mathematics-I', code: 'EM-1', department: 'EEE' },
            { name: 'Electrical Measurements Lab', code: 'EM-LAB', department: 'EEE' },
            { name: 'Physics Lab', code: 'PHY-LAB', department: 'EEE' },
            { name: 'Engineering Physics', code: 'EP', department: 'EEE' }
        ],
        faculty: [
            { id: 1, code: 'EEE-F1', name: 'EEE-F1', department: 'EEE', status: 'active' },
            { id: 2, code: 'EEE-F2', name: 'EEE-F2', department: 'EEE', status: 'active' },
            { id: 3, code: 'EEE-F4', name: 'EEE-F4', department: 'EEE', status: 'active' }
        ],
        rooms: [],
        timetable: []
    }, 'test');

    const realEeeExtractedJson = {
        contract_version: "2.1",
        timetable_type: "MASTER_TIMETABLE",
        institution_name: null,
        department_code: "EEE",
        academic_year: "2026-2027",
        semester: 1,
        class_name: "EEE",
        default_room: null,
        days: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
        periods: [1, 2, 3, 4, 5, 6, 7],
        period_timings: {
            "1": { "start": "08:00", "end": "08:45" },
            "2": { "start": "08:45", "end": "09:30" },
            "3": { "start": "09:30", "end": "10:15" },
            "4": { "start": "10:30", "end": "11:15" },
            "5": { "start": "11:15", "end": "12:00" },
            "6": { "start": "12:00", "end": "12:45" },
            "7": { "start": "12:45", "end": "13:30" }
        },
        subject_legend: [
            { "code": null, "name": "Engineering Mathematics-I", "short_name": "EEE-F1" },
            { "code": null, "name": "Electrical Measurements Lab", "short_name": "EEE-F1" },
            { "code": null, "name": "Physics Lab", "short_name": "EEE-F4" },
            { "code": null, "name": "Engineering Physics", "short_name": "EEE-F2" }
        ],
        faculty_legend: [],
        entries: [
            {
                day: "MON",
                period: 1,
                span_to: null,
                room_code: null,
                class_name: "EEE",
                faculty_name: null,
                session_type: "theory",
                subject_code: null,
                subject_name: "Engineering Mathematics-I",
                raw_cell_text: "Engineering Mathematics-I EEE-F1",
                is_free: false
            },
            {
                day: "MON",
                period: 2,
                span_to: null,
                room_code: null,
                class_name: "EEE",
                faculty_name: null,
                session_type: "theory",
                subject_code: null,
                subject_name: "Engineering Mathematics-I",
                raw_cell_text: "Engineering Mathematics-I EEE-F1",
                is_free: false
            },
            {
                day: "MON",
                period: 3,
                span_to: 5,
                room_code: null,
                class_name: "EEE",
                faculty_name: null,
                session_type: "lab",
                subject_code: null,
                subject_name: "Electrical Measurements Lab",
                raw_cell_text: "Electrical Measurements Lab EEE-F1",
                is_free: false
            },
            {
                day: "THU",
                period: 3,
                span_to: 5,
                room_code: null,
                class_name: "EEE",
                faculty_name: null,
                session_type: "lab",
                subject_code: null,
                subject_name: "Physics Lab",
                raw_cell_text: "Physics Lab EEE-F4",
                is_free: false
            },
            {
                day: "FRI",
                period: 3,
                span_to: 5,
                room_code: null,
                class_name: "EEE",
                faculty_name: null,
                session_type: "theory",
                subject_code: null,
                subject_name: "Engineering Physics",
                raw_cell_text: "Engineering Physics EEE-F2",
                is_free: false
            }
        ],
        extraction_metadata: {
            warnings: [],
            confidence_score: 1
        }
    };

    // Test 1: Normalization pipeline extracts subject->faculty mapping and populates entries
    await check('Test 1: normalizeExtractedContract populates faculty_subject_mapping and entries', () => {
        const cloned = JSON.parse(JSON.stringify(realEeeExtractedJson));
        const normalized = normalizeExtractedContract(cloned, { departmentCode: 'EEE' });

        assert.strictEqual(normalized.faculty_subject_mapping['Engineering Mathematics-I'], 'EEE-F1');
        assert.strictEqual(normalized.faculty_subject_mapping['Electrical Measurements Lab'], 'EEE-F1');
        assert.strictEqual(normalized.faculty_subject_mapping['Physics Lab'], 'EEE-F4');
        assert.strictEqual(normalized.faculty_subject_mapping['Engineering Physics'], 'EEE-F2');

        assert.strictEqual(normalized.entries[0].faculty_name, 'EEE-F1');
        assert.strictEqual(normalized.entries[1].faculty_name, 'EEE-F1');
        assert.strictEqual(normalized.entries[2].faculty_name, 'EEE-F1');
        assert.strictEqual(normalized.entries[3].faculty_name, 'EEE-F4');
        assert.strictEqual(normalized.entries[4].faculty_name, 'EEE-F2');
    });

    // Test 2: In-memory resolution of real EEE staging contract produces 0 unresolved entities
    await check('Test 2: resolveContract on real EEE contract resolves all faculty to EEE catalog', async () => {
        const cloned = JSON.parse(JSON.stringify(realEeeExtractedJson));
        const resolution = await resolveContract(cloned, 'EEE', {}, { useDatabase: false });

        assert.strictEqual(resolution.ok, true);
        assert.strictEqual(resolution.unresolvedCount, 0);
        assert.strictEqual(resolution.unresolvedEntities.length, 0);
        assert.ok(resolution.resolvedMap.faculty['EEE-F1'], 'EEE-F1 must be in resolvedMap');
        assert.ok(resolution.resolvedMap.faculty['EEE-F4'], 'EEE-F4 must be in resolvedMap');
        assert.ok(resolution.resolvedMap.faculty['EEE-F2'], 'EEE-F2 must be in resolvedMap');
    });

    // Test 3: Specific reproduction: Engineering Mathematics-I at MON P1 resolves to EEE-F1
    await check('Test 3: Engineering Mathematics-I at MON P1 deterministically resolves to EEE-F1', async () => {
        const singleSlotContract = {
            contract_version: "2.1",
            timetable_type: "MASTER_TIMETABLE",
            department_code: "EEE",
            class_name: "EEE",
            days: ["MON"],
            periods: [1],
            subject_legend: [
                { name: "Engineering Mathematics-I", short_name: "EEE-F1" }
            ],
            entries: [
                {
                    day: "MON",
                    period: 1,
                    subject_name: "Engineering Mathematics-I",
                    raw_cell_text: "Engineering Mathematics-I EEE-F1",
                    class_name: "EEE",
                    is_free: false
                }
            ]
        };

        const resolution = await resolveContract(singleSlotContract, 'EEE', {}, { useDatabase: false });
        assert.strictEqual(resolution.unresolvedCount, 0);
        assert.strictEqual(singleSlotContract.entries[0].faculty_name, 'EEE-F1');
        assert.strictEqual(resolution.resolvedMap.faculty['EEE-F1'].code, 'EEE-F1');
    });

    // Test 4: 3-period lab Electrical Measurements Lab MON P3-P5 has ONE faculty assignment and 0 unresolved
    await check('Test 4: Electrical Measurements Lab MON P3-P5 resolves to single faculty EEE-F1', async () => {
        const labContract = {
            contract_version: "2.1",
            timetable_type: "MASTER_TIMETABLE",
            department_code: "EEE",
            class_name: "EEE",
            days: ["MON"],
            periods: [1, 2, 3, 4, 5],
            subject_legend: [
                { name: "Electrical Measurements Lab", short_name: "EEE-F1" }
            ],
            entries: [
                {
                    day: "MON",
                    period: 3,
                    span_to: 5,
                    session_type: "lab",
                    subject_name: "Electrical Measurements Lab",
                    raw_cell_text: "Electrical Measurements Lab EEE-F1",
                    class_name: "EEE",
                    is_free: false
                }
            ]
        };

        const resolution = await resolveContract(labContract, 'EEE', {}, { useDatabase: false });
        assert.strictEqual(resolution.unresolvedCount, 0);
        assert.strictEqual(labContract.entries.length, 1);
        assert.strictEqual(labContract.entries[0].faculty_name, 'EEE-F1');
        assert.strictEqual(labContract.entries[0].span_to, 5);
    });

    // Test 5: Branch Isolation — CME, EEE, MEC
    await check('Test 5: CME, EEE, and MEC branch isolation is strictly preserved', async () => {
        store.replace({
            allowEmpty: true,
            classes: [],
            subjects: [],
            faculty: [
                { id: 'CME_F1', code: 'CME_F1', name: 'Dr. CME One', department: 'CME', status: 'active' },
                { id: 'EEE_F1', code: 'EEE_F1', name: 'Dr. EEE One', department: 'EEE', status: 'active' },
                { id: 'MEC_F1', code: 'MEC_F1', name: 'Dr. MEC One', department: 'MEC', status: 'active' }
            ],
            rooms: [],
            timetable: []
        }, 'test');

        const cmeCatalog = await fetchBranchCatalog('CME', { useDatabase: false });
        assert.ok(cmeCatalog.faculty.some(f => f.name === 'Dr. CME One' || f.code === 'CME_F1'));
        assert.ok(!cmeCatalog.faculty.some(f => f.name === 'Dr. EEE One'), 'CME catalog must NOT contain EEE faculty');
        assert.ok(!cmeCatalog.faculty.some(f => f.name === 'Dr. MEC One'), 'CME catalog must NOT contain MEC faculty');

        const eeeCatalog = await fetchBranchCatalog('EEE', { useDatabase: false });
        assert.ok(eeeCatalog.faculty.some(f => f.name === 'Dr. EEE One' || f.code === 'EEE_F1'));
        assert.ok(!eeeCatalog.faculty.some(f => f.name === 'Dr. CME One'), 'EEE catalog must NOT contain CME faculty');
        assert.ok(!eeeCatalog.faculty.some(f => f.name === 'Dr. MEC One'), 'EEE catalog must NOT contain MEC faculty');

        const mecCatalog = await fetchBranchCatalog('MEC', { useDatabase: false });
        assert.ok(mecCatalog.faculty.some(f => f.name === 'Dr. MEC One' || f.code === 'MEC_F1'));
        assert.ok(!mecCatalog.faculty.some(f => f.name === 'Dr. CME One'), 'MEC catalog must NOT contain CME faculty');
        assert.ok(!mecCatalog.faculty.some(f => f.name === 'Dr. EEE One'), 'MEC catalog must NOT contain EEE faculty');
    });

    // Test 6: "Needs review" is NEVER used as an extracted faculty name
    await check('Test 6: "Needs review" placeholder is never created as a faculty entity', async () => {
        store.replace({
            allowEmpty: true,
            classes: [{ code: 'EEE', class: 'EEE', semester: 1, section: 'A', department: 'EEE' }],
            subjects: [{ name: 'Mystery Subject', code: 'MYS', department: 'EEE' }],
            faculty: [],
            rooms: [],
            timetable: []
        }, 'test');

        const unmappedContract = {
            contract_version: "2.1",
            timetable_type: "MASTER_TIMETABLE",
            department_code: "EEE",
            class_name: "EEE",
            days: ["MON"],
            periods: [1],
            subject_legend: [],
            entries: [
                {
                    day: "MON",
                    period: 1,
                    subject_name: "Mystery Subject",
                    raw_cell_text: "Mystery Subject",
                    faculty_name: null,
                    class_name: "EEE",
                    is_free: false
                }
            ]
        };

        const resolution = await resolveContract(unmappedContract, 'EEE', {}, { useDatabase: false });
        assert.strictEqual(resolution.ok, false);
        assert.strictEqual(resolution.unresolvedCount > 0, true);
        const facUnresolved = resolution.unresolvedEntities.find(e => e.entityType === 'faculty');
        assert.ok(facUnresolved, 'Should have unresolved faculty');
        assert.notStrictEqual(facUnresolved.extractedText, 'Needs review', 'extractedText must NOT be "Needs review"');
    });

    console.log('\n======================================================');
    console.log(`Regression Test Results: ${passed} passed, ${failed} failed.`);
    console.log('======================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal error in regression test suite:', err);
    process.exit(1);
});
