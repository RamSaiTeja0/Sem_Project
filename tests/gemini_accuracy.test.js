/**
 * Phase B2.4.1 — Gemini Timetable Extraction Accuracy & Stage 1 Tests
 *
 * Verifies:
 *   1. Stage 1 extraction prompt is generic (no hardcoded EEE/sample faculty/subjects/branches).
 *   2. Dynamic days support (5 days, 6 days, 7 days).
 *   3. Dynamic period counts support (6 periods, 7 periods, 8 periods).
 *   4. Dynamic period timings support (custom clock timings).
 *   5. Dynamic faculty legend and subject legend structures are valid B2.1.
 *   6. Multi-period lab extraction with span_to and NO duplicate entries passes validation.
 *   7. Multi-period lab with duplicate entry for subsequent period is caught by validator (CLASS_BUSY).
 *   8. Merged non-lab cells (e.g. drawing ED spanning P1-P2) with span_to and NO duplicate entries passes validation.
 *   9. Scheduled activity (e.g. TPC, Library) with non-null subject_name and null faculty passes validation.
 *  10. Activity with erroneous null subject_name is caught by validator (MISSING_REQUIRED_FIELDS).
 *  11. Blank/free slots (is_free: true, subject_name: null) pass validation.
 *  12. Normal single-period theory slots pass validation.
 *  13. Complete realistic schedule runs through pipeline, validates, stages as VALID, marks PROCESSED, and leaves live timetable untouched.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { check, checkAsync, counts } = require('./helpers');
const config = require('../src/config');
const store = require('../src/data/store');
const { resetBranchForTesting, setBranch } = require('../src/data/departments');
const {
    clearUploads,
    saveUploadRecord,
    getUploadRecord,
    getStagedData,
    UPLOADS_ROOT
} = require('../src/data/uploads');
const { validateExtractedContract } = require('../src/core/contractValidator');
const { runExtractionPipeline } = require('../src/services/extractionPipeline');
const { buildExtractionPrompt, buildVerificationPrompt } = require('../src/core/geminiPrompt');
const { extractTimetableWithGemini, verifyTimetableWithGemini, GeminiExtractionError } = require('../src/core/geminiExtractor');

function createPayload(entries = [], overrides = {}) {
    return {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        institution_name: 'Engineering College',
        title: 'CLASS TIME TABLE',
        department_code: 'EEE',
        academic_year: '2025-2026',
        semester: 4,
        class_name: 'DEEE-B',
        faculty_name: null,
        faculty_code: null,
        default_room: null,
        days: overrides.days || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: overrides.periods || [1, 2, 3, 4, 5, 6, 7],
        period_timings: overrides.period_timings || {
            '1': { start: '08:00', end: '08:45' },
            '2': { start: '08:45', end: '09:30' },
            '3': { start: '09:30', end: '10:15' },
            '4': { start: '10:30', end: '11:15' },
            '5': { start: '11:15', end: '12:00' },
            '6': { start: '12:00', end: '12:45' },
            '7': { start: '12:45', end: '13:30' }
        },
        faculty_legend: overrides.faculty_legend || [],
        subject_legend: overrides.subject_legend || [],
        entries,
        extraction_metadata: {
            confidence_score: 0.98,
            warnings: []
        }
    };
}

async function run() {
    console.log('TecSubstitution — Phase B2.4.1 Extraction Accuracy & Stage 1 Tests\n');

    clearUploads();
    resetBranchForTesting();
    setBranch({ code: 'EEE', name: 'Electrical and Electronics Engineering' });

    if (!fs.existsSync(UPLOADS_ROOT)) {
        fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
    }

    const dummyFile = path.join(UPLOADS_ROOT, 'test_b241_sample.jpeg');
    fs.writeFileSync(dummyFile, 'dummy binary JPEG content');

    const uploadRecord = {
        uploadId: 'upl_b241_test_01',
        originalFilename: 'sample_timetable.jpeg',
        fileType: 'image/jpeg',
        fileSize: 1024,
        storagePath: dummyFile,
        uploaderUserId: 1,
        facultyId: null,
        branchId: 'EEE',
        departmentCode: 'EEE',
        uploadType: 'MASTER_TIMETABLE',
        status: 'UPLOADED'
    };

    // ---------------------------------------------------------------------
    console.log('[1] Generic Prompt & Dynamic Legend Verification');
    // ---------------------------------------------------------------------
    check('Stage 1 prompt is generic and contains zero hardcoded college/faculty data', () => {
        const prompt = buildExtractionPrompt({ departmentCode: 'CSE', uploadType: 'MASTER_TIMETABLE' });
        assert.ok(prompt.includes('CSE'), 'Prompt should use upload context department');
        assert.strictEqual(prompt.includes('D.SAGAR KUMAR'), false, 'Prompt must not contain hardcoded D.SAGAR KUMAR');
        assert.strictEqual(prompt.includes('M.DALAYYA'), false, 'Prompt must not contain hardcoded M.DALAYYA');
        assert.strictEqual(prompt.includes('Aditya Institute'), false, 'Prompt must not contain hardcoded institution');
        assert.strictEqual(prompt.includes('EE-404(4)'), false, 'Prompt must not contain hardcoded course code');
        assert.ok(prompt.includes('faculty_legend'), 'Prompt must instruct dynamic faculty legend extraction');
        assert.ok(prompt.includes('subject_legend'), 'Prompt must instruct dynamic subject legend extraction');
    });

    check('Dynamic days (5-day week) pass B2.1 validation', () => {
        const payload = createPayload([
            {
                day: 'Monday',
                period: 1,
                span_to: null,
                subject_name: 'Circuits',
                faculty_name: 'Dr. Smith',
                class_name: 'DEEE-B',
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'Circuits'
            }
        ], {
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
        });

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    check('Dynamic periods (8 periods) with period timings pass B2.1 validation', () => {
        const payload = createPayload([
            {
                day: 'Monday',
                period: 8,
                span_to: null,
                subject_name: 'Tutorial',
                faculty_name: 'Dr. Smith',
                class_name: 'DEEE-B',
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'Tut'
            }
        ], {
            periods: [1, 2, 3, 4, 5, 6, 7, 8],
            period_timings: {
                '8': { start: '13:30', end: '14:15' }
            }
        });

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    check('Payload with extracted dynamic faculty_legend and subject_legend passes B2.1 validation', () => {
        const payload = createPayload([
            {
                day: 'Monday',
                period: 1,
                span_to: null,
                subject_name: 'Power Electronics',
                subject_code: 'PE101',
                faculty_name: 'D. Sagar Kumar',
                faculty_code: 'DSK',
                class_name: 'DEEE-B',
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'PE'
            }
        ], {
            faculty_legend: [
                { code: 'DSK', name: 'D. Sagar Kumar', designation: 'Assistant Professor', department: 'EEE' }
            ],
            subject_legend: [
                { code: 'PE101', name: 'Power Electronics', short_name: 'PE' }
            ]
        });

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    // ---------------------------------------------------------------------
    console.log('\n[2] Multi-Period Lab & Merged Cell Extraction');
    // ---------------------------------------------------------------------
    check('Multi-period lab with span_to and NO duplicate entry passes validation', () => {
        const payload = createPayload([
            {
                day: 'Tuesday',
                period: 1,
                span_to: 2,
                subject_name: 'Electrical Machines- II Laboratory',
                subject_code: 'EE-407(3)',
                faculty_name: 'M.DALAYYA',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'lab',
                is_free: false,
                raw_cell_text: 'EM-II LAB'
            },
            {
                day: 'Tuesday',
                period: 3,
                span_to: null,
                subject_name: null,
                subject_code: null,
                faculty_name: null,
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: true,
                raw_cell_text: ''
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
        assert.strictEqual(result.conflicts.length, 0);
    });

    check('Multi-period lab with duplicate entry for period 2 triggers CLASS_BUSY conflict', () => {
        const payload = createPayload([
            {
                day: 'Tuesday',
                period: 1,
                span_to: 2,
                subject_name: 'Electrical Machines- II Laboratory',
                subject_code: 'EE-407(3)',
                faculty_name: 'M.DALAYYA',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'lab',
                is_free: false,
                raw_cell_text: 'EM-II LAB'
            },
            {
                day: 'Tuesday',
                period: 2,
                span_to: null,
                subject_name: 'Electrical Machines- II Laboratory',
                subject_code: 'EE-407(3)',
                faculty_name: 'M.DALAYYA',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'lab',
                is_free: false,
                raw_cell_text: 'EM-II LAB'
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, false);
        assert.ok(result.conflicts.some(c => c.code === 'CLASS_BUSY'));
        assert.ok(result.conflicts.some(c => c.message.includes('Tuesday P2')));
    });

    check('Merged non-lab cell (e.g. Electrical Engineering Drawing P1-P2) passes validation with span_to', () => {
        const payload = createPayload([
            {
                day: 'Monday',
                period: 1,
                span_to: 2,
                subject_name: 'Electrical Engineering Drawing',
                subject_code: 'EE-406(6)',
                faculty_name: 'G.BHARATH REDDY',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'ED'
            },
            {
                day: 'Monday',
                period: 3,
                span_to: null,
                subject_name: null,
                subject_code: null,
                faculty_name: null,
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: true,
                raw_cell_text: ''
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
        assert.strictEqual(result.conflicts.length, 0);
    });

    // ---------------------------------------------------------------------
    console.log('\n[3] Scheduled Activities vs. Free Cells');
    // ---------------------------------------------------------------------
    check('Scheduled activity "TPC" with non-null subject_name and null faculty passes validation', () => {
        const payload = createPayload([
            {
                day: 'Tuesday',
                period: 7,
                span_to: null,
                subject_name: 'TPC',
                subject_code: null,
                faculty_name: null,
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'activity',
                is_free: false,
                raw_cell_text: 'TPC'
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    check('Scheduled activity with erroneous null subject_name is rejected with MISSING_REQUIRED_FIELDS', () => {
        const payload = createPayload([
            {
                day: 'Tuesday',
                period: 7,
                span_to: null,
                subject_name: null,
                subject_code: null,
                faculty_name: null,
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'activity',
                is_free: false,
                raw_cell_text: 'TPC'
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.some(e => e.includes('subject_name is required for scheduled slot')));
    });

    check('Blank / free slot (is_free: true, subject_name: null) passes validation', () => {
        const payload = createPayload([
            {
                day: 'Wednesday',
                period: 5,
                span_to: null,
                subject_name: null,
                subject_code: null,
                faculty_name: null,
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: true,
                raw_cell_text: ''
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    // ---------------------------------------------------------------------
    console.log('\n[4] Normal Theory Cells');
    // ---------------------------------------------------------------------
    check('Standard theory cell with subject, code, faculty passes validation', () => {
        const payload = createPayload([
            {
                day: 'Thursday',
                period: 1,
                span_to: null,
                subject_name: 'Power Electronics & PLC',
                subject_code: 'EE-404(4)',
                faculty_name: 'D.SAGAR KUMAR',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'PE'
            }
        ]);

        const result = validateExtractedContract(payload, uploadRecord);
        assert.strictEqual(result.ok, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    // ---------------------------------------------------------------------
    console.log('\n[5] Full Realistic Schedule Pipeline Staging Verification');
    // ---------------------------------------------------------------------
    await checkAsync('Full realistic schedule stages safely and preserves live timetable (0 entries)', async () => {
        const initialLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);

        const uploadRec = await saveUploadRecord({
            uploadId: 'upl_b241_full_01',
            originalFilename: 'sample_timetable.jpeg',
            fileType: 'image/jpeg',
            fileSize: 1024,
            storagePath: dummyFile,
            uploaderUserId: 1,
            facultyId: null,
            branchId: 'EEE',
            departmentCode: 'EEE',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        const realisticPayload = createPayload([
            // Mon: ED (P1-P2), Free (P3), EM-II (P4), GME (P5), EI&E (P6), PS-I (P7)
            { day: 'Monday', period: 1, span_to: 2, subject_name: 'Electrical Engineering Drawing', subject_code: 'EE-406(6)', faculty_name: 'G.BHARATH REDDY', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'ED' },
            { day: 'Monday', period: 3, span_to: null, subject_name: null, subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Monday', period: 4, span_to: null, subject_name: 'Electrical Machines- II', subject_code: 'EE-402(5)', faculty_name: 'M.DALAYYA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EM-II' },
            { day: 'Monday', period: 5, span_to: null, subject_name: 'General Mechanical Engineering', subject_code: 'EE-405(4)', faculty_name: 'P.DAMODHARARAO', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'GME' },
            { day: 'Monday', period: 6, span_to: null, subject_name: 'Electrical Installation & Estimation', subject_code: 'EE-401(4)', faculty_name: 'A.MANINDRA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EI & E' },
            { day: 'Monday', period: 7, span_to: null, subject_name: 'Power Systems - I', subject_code: 'EE-403(4)', faculty_name: 'T.RAJENDRA PRASAD', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PS-I' },

            // Tue: Lab (P1-P2), Free (P3), PE (P4), GME (P5), PS-I (P6), TPC (P7)
            { day: 'Tuesday', period: 1, span_to: 2, subject_name: 'Electrical Machines- II Laboratory / Power Electronics Laboratory', subject_code: 'EE-407(3) / EE-409(3)', faculty_name: 'M.DALAYYA / T.RAJENDRA PRASAD', class_name: 'DEEE-B', room_code: null, session_type: 'lab', is_free: false, raw_cell_text: 'EM-II LAB / PE LAB' },
            { day: 'Tuesday', period: 3, span_to: null, subject_name: null, subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Tuesday', period: 4, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404(4)', faculty_name: 'D.SAGAR KUMAR', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PE' },
            { day: 'Tuesday', period: 5, span_to: null, subject_name: 'General Mechanical Engineering', subject_code: 'EE-405(4)', faculty_name: 'P.DAMODHARARAO', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'GME' },
            { day: 'Tuesday', period: 6, span_to: null, subject_name: 'Power Systems - I', subject_code: 'EE-403(4)', faculty_name: 'T.RAJENDRA PRASAD', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PS-I' },
            { day: 'Tuesday', period: 7, span_to: null, subject_name: 'TPC', subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'activity', is_free: false, raw_cell_text: 'TPC' },

            // Wed: EM-II (P1), EI&E (P2), PE (P3), PS-I (P4), Free (P5), HPS LAB (P6-P7)
            { day: 'Wednesday', period: 1, span_to: null, subject_name: 'Electrical Machines- II', subject_code: 'EE-402(5)', faculty_name: 'M.DALAYYA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EM-II' },
            { day: 'Wednesday', period: 2, span_to: null, subject_name: 'Electrical Installation & Estimation', subject_code: 'EE-401(4)', faculty_name: 'A.MANINDRA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EI & E' },
            { day: 'Wednesday', period: 3, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404(4)', faculty_name: 'D.SAGAR KUMAR', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PE' },
            { day: 'Wednesday', period: 4, span_to: null, subject_name: 'Power Systems - I', subject_code: 'EE-403(4)', faculty_name: 'T.RAJENDRA PRASAD', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PS-I' },
            { day: 'Wednesday', period: 5, span_to: null, subject_name: null, subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Wednesday', period: 6, span_to: 7, subject_name: 'Hybrid Power Systems Laboratory', subject_code: 'EE-410(3)', faculty_name: 'A.MANINDRA', class_name: 'DEEE-B', room_code: null, session_type: 'lab', is_free: false, raw_cell_text: 'HPS LAB' },

            // Thu: PE (P1), EM-II (P2), GME (P3), EI&E (P4), Free (P5), CS LAB (P6-P7)
            { day: 'Thursday', period: 1, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404(4)', faculty_name: 'D.SAGAR KUMAR', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PE' },
            { day: 'Thursday', period: 2, span_to: null, subject_name: 'Electrical Machines- II', subject_code: 'EE-402(5)', faculty_name: 'M.DALAYYA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EM-II' },
            { day: 'Thursday', period: 3, span_to: null, subject_name: 'General Mechanical Engineering', subject_code: 'EE-405(4)', faculty_name: 'P.DAMODHARARAO', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'GME' },
            { day: 'Thursday', period: 4, span_to: null, subject_name: 'Electrical Installation & Estimation', subject_code: 'EE-401(4)', faculty_name: 'A.MANINDRA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EI & E' },
            { day: 'Thursday', period: 5, span_to: null, subject_name: null, subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Thursday', period: 6, span_to: 7, subject_name: 'Communications Skills Laboratory', subject_code: 'EE-408(3)', faculty_name: 'T.PAVAN VARMA', class_name: 'DEEE-B', room_code: null, session_type: 'lab', is_free: false, raw_cell_text: 'CS LAB' },

            // Fri: Lab (P1-P2), Free (P3), PE (P4), EI&E (P5), EM-II (P6), GME (P7)
            { day: 'Friday', period: 1, span_to: 2, subject_name: 'Electrical Machines- II Laboratory / Power Electronics Laboratory', subject_code: 'EE-407(3) / EE-409(3)', faculty_name: 'M.DALAYYA / T.RAJENDRA PRASAD', class_name: 'DEEE-B', room_code: null, session_type: 'lab', is_free: false, raw_cell_text: 'EM-II LAB / PE LAB' },
            { day: 'Friday', period: 3, span_to: null, subject_name: null, subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Friday', period: 4, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404(4)', faculty_name: 'D.SAGAR KUMAR', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PE' },
            { day: 'Friday', period: 5, span_to: null, subject_name: 'Electrical Installation & Estimation', subject_code: 'EE-401(4)', faculty_name: 'A.MANINDRA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EI & E' },
            { day: 'Friday', period: 6, span_to: null, subject_name: 'Electrical Machines- II', subject_code: 'EE-402(5)', faculty_name: 'M.DALAYYA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EM-II' },
            { day: 'Friday', period: 7, span_to: null, subject_name: 'General Mechanical Engineering', subject_code: 'EE-405(4)', faculty_name: 'P.DAMODHARARAO', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'GME' },

            // Sat: ED (P1-P2), Free (P3), PE (P4), PS-I (P5), GME (P6), EM-II (P7)
            { day: 'Saturday', period: 1, span_to: 2, subject_name: 'Electrical Engineering Drawing', subject_code: 'EE-406(6)', faculty_name: 'G.BHARATH REDDY', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'ED' },
            { day: 'Saturday', period: 3, span_to: null, subject_name: null, subject_code: null, faculty_name: null, class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Saturday', period: 4, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404(4)', faculty_name: 'D.SAGAR KUMAR', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PE' },
            { day: 'Saturday', period: 5, span_to: null, subject_name: 'Power Systems - I', subject_code: 'EE-403(4)', faculty_name: 'T.RAJENDRA PRASAD', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'PS-I' },
            { day: 'Saturday', period: 6, span_to: null, subject_name: 'General Mechanical Engineering', subject_code: 'EE-405(4)', faculty_name: 'P.DAMODHARARAO', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'GME' },
            { day: 'Saturday', period: 7, span_to: null, subject_name: 'Electrical Machines- II', subject_code: 'EE-402(5)', faculty_name: 'M.DALAYYA', class_name: 'DEEE-B', room_code: null, session_type: 'theory', is_free: false, raw_cell_text: 'EM-II' }
        ]);

        const pipelineResult = await runExtractionPipeline('upl_b241_full_01', {
            geminiTransport: async () => JSON.stringify(realisticPayload),
            className: 'DEEE-B'
        });

        assert.strictEqual(pipelineResult.success, true);
        assert.strictEqual(pipelineResult.status, 'PROCESSED');
        assert.strictEqual(pipelineResult.entryCount, 36);

        const staged = await getStagedData('upl_b241_full_01');
        assert.ok(staged);
        assert.strictEqual(staged.validationStatus, 'VALID');

        const rec = await getUploadRecord('upl_b241_full_01');
        assert.strictEqual(rec.status, 'PROCESSED');

        const postLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
        assert.strictEqual(postLiveCount, initialLiveCount, 'Live timetable entries must remain untouched');
    });

    // ---------------------------------------------------------------------
    console.log('\n[6] Stage 2 Gemini Multimodal Verification & Structure Preservation');
    // ---------------------------------------------------------------------
    await checkAsync('TEST 1, 2, 3: Stage 2 receives BOTH original image buffer and Stage 1 JSON in multimodal payload', async () => {
        let receivedParams = null;
        const testImageBuffer = Buffer.from('TEST_IMAGE_BINARY_DATA');
        const draftStage1 = createPayload([
            { day: 'Friday', period: 1, span_to: null, subject_name: 'PE', faculty_name: null, class_name: 'DEEE-B', session_type: 'theory', is_free: false, raw_cell_text: 'PE' }
        ]);

        const verifiedResult = await verifyTimetableWithGemini({
            fileBuffer: testImageBuffer,
            mimeType: 'image/jpeg',
            stage1Json: draftStage1,
            uploadContext: { departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }
        }, {
            customTransport: async (transportPayload) => {
                receivedParams = transportPayload;
                return draftStage1;
            }
        });

        assert.ok(receivedParams, 'Stage 2 transport must be invoked');
        assert.strictEqual(receivedParams.stage, 2, 'Stage identifier must be 2');
        assert.ok(Buffer.isBuffer(receivedParams.fileBuffer), 'TEST 1: Must receive original image Buffer');
        assert.strictEqual(receivedParams.fileBuffer.toString(), 'TEST_IMAGE_BINARY_DATA');
        assert.strictEqual(receivedParams.mimeType, 'image/jpeg');
        assert.ok(receivedParams.stage1Json, 'TEST 2: Must receive Stage 1 JSON');
        assert.strictEqual(receivedParams.stage1Json.contract_version, '2.1');
        assert.ok(receivedParams.promptText.includes('STAGE 1 DRAFT JSON TO VERIFY'), 'TEST 3: Multimodal prompt must include Stage 1 JSON');
        assert.strictEqual(verifiedResult.contract_version, '2.1');
    });

    await checkAsync('TEST 4: Stage 2 resolves faculty abbreviation dynamically using faculty legend', async () => {
        const testImageBuffer = Buffer.from('TEST_TIMETABLE_IMAGE');
        const unverifiedStage1 = createPayload([
            {
                day: 'Friday',
                period: 1,
                span_to: null,
                subject_name: 'Power Electronics & PLC',
                subject_code: 'EE-404(4)',
                faculty_name: null, // missing in stage 1
                faculty_code: null,
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'PE'
            }
        ], {
            faculty_legend: [
                { code: 'DSK', name: 'D.SAGAR KUMAR', designation: 'Assistant Professor', department: 'EEE' }
            ],
            subject_legend: [
                { code: 'EE-404(4)', name: 'Power Electronics & PLC', short_name: 'PE' }
            ]
        });

        // Stage 2 resolves faculty_name from the legend evidence
        const verifiedResult = await verifyTimetableWithGemini({
            fileBuffer: testImageBuffer,
            mimeType: 'image/jpeg',
            stage1Json: unverifiedStage1,
            uploadContext: { departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }
        }, {
            customTransport: async ({ stage1Json }) => {
                const corrected = JSON.parse(JSON.stringify(stage1Json));
                // Resolve entry 0 faculty using faculty_legend
                corrected.entries[0].faculty_name = 'D.SAGAR KUMAR';
                corrected.entries[0].faculty_code = 'DSK';
                return corrected;
            }
        });

        assert.strictEqual(verifiedResult.entries[0].faculty_name, 'D.SAGAR KUMAR');
        assert.strictEqual(verifiedResult.entries[0].faculty_code, 'DSK');

        const val = validateExtractedContract(verifiedResult, uploadRecord);
        assert.strictEqual(val.ok, true, `Validation failed: ${val.errors.join(', ')}`);
    });

    await checkAsync('TEST 5: Stage 2 resolves subject abbreviation dynamically using subject legend', async () => {
        const testImageBuffer = Buffer.from('TEST_TIMETABLE_IMAGE');
        const unverifiedStage1 = createPayload([
            {
                day: 'Tuesday',
                period: 4,
                span_to: null,
                subject_name: 'EM-II', // abbreviated in stage 1
                subject_code: null,
                faculty_name: 'M.DALAYYA',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'EM-II'
            }
        ], {
            subject_legend: [
                { code: 'EE-402(5)', name: 'Electrical Machines- II', short_name: 'EM-II' }
            ]
        });

        const verifiedResult = await verifyTimetableWithGemini({
            fileBuffer: testImageBuffer,
            mimeType: 'image/jpeg',
            stage1Json: unverifiedStage1,
            uploadContext: { departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }
        }, {
            customTransport: async ({ stage1Json }) => {
                const corrected = JSON.parse(JSON.stringify(stage1Json));
                corrected.entries[0].subject_name = 'Electrical Machines- II';
                corrected.entries[0].subject_code = 'EE-402(5)';
                return corrected;
            }
        });

        assert.strictEqual(verifiedResult.entries[0].subject_name, 'Electrical Machines- II');
        assert.strictEqual(verifiedResult.entries[0].subject_code, 'EE-402(5)');
    });

    await checkAsync('TEST 6 & 7: Stage 2 preserves correct Stage 1 values and corrects discrepancies', async () => {
        const testImageBuffer = Buffer.from('TEST_IMAGE');
        const stage1WithDiscrepancy = createPayload([
            // Correct entry:
            { day: 'Monday', period: 4, span_to: null, subject_name: 'Electrical Machines- II', subject_code: 'EE-402(5)', faculty_name: 'M.DALAYYA', class_name: 'DEEE-B', session_type: 'theory', is_free: false, raw_cell_text: 'EM-II' },
            // Discrepancy: period misread as 5 instead of 6 in stage 1
            { day: 'Monday', period: 5, span_to: null, subject_name: 'Power Systems - I', subject_code: 'EE-403(4)', faculty_name: 'T.RAJENDRA PRASAD', class_name: 'DEEE-B', session_type: 'theory', is_free: false, raw_cell_text: 'PS-I' }
        ]);

        const verifiedResult = await verifyTimetableWithGemini({
            fileBuffer: testImageBuffer,
            mimeType: 'image/jpeg',
            stage1Json: stage1WithDiscrepancy,
            uploadContext: { departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }
        }, {
            customTransport: async ({ stage1Json }) => {
                const corrected = JSON.parse(JSON.stringify(stage1Json));
                // Entry 0 preserved
                // Entry 1 period corrected to 7 based on image evidence
                corrected.entries[1].period = 7;
                return corrected;
            }
        });

        assert.strictEqual(verifiedResult.entries[0].subject_name, 'Electrical Machines- II', 'TEST 6: Correct entry preserved');
        assert.strictEqual(verifiedResult.entries[0].period, 4);
        assert.strictEqual(verifiedResult.entries[1].period, 7, 'TEST 7: Discrepancy corrected');
    });

    check('TEST 8: Stage 2 does not invent missing information (unresolved fields remain null)', () => {
        const prompt = buildVerificationPrompt({ departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }, {
            contract_version: '2.1',
            department_code: 'EEE'
        });
        assert.ok(prompt.includes('ZERO-HALLUCINATION CONSTRAINT'), 'Prompt must enforce zero hallucination');
        assert.ok(prompt.includes('NEVER invent faculty names'), 'Prompt must instruct never to invent faculty');
        assert.ok(prompt.includes('preserve null / unresolved'), 'Prompt must instruct preserving null/unresolved');
    });

    await checkAsync('TEST 9: Merged multi-period spans are preserved in Stage 2', async () => {
        const testImageBuffer = Buffer.from('TEST_IMAGE');
        const stage1Span = createPayload([
            {
                day: 'Wednesday',
                period: 6,
                span_to: 7,
                subject_name: 'Hybrid Power Systems Laboratory',
                subject_code: 'EE-410(3)',
                faculty_name: 'A.MANINDRA',
                class_name: 'DEEE-B',
                room_code: null,
                session_type: 'lab',
                is_free: false,
                raw_cell_text: 'HPS LAB'
            }
        ]);

        const verifiedResult = await verifyTimetableWithGemini({
            fileBuffer: testImageBuffer,
            mimeType: 'image/jpeg',
            stage1Json: stage1Span,
            uploadContext: { departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }
        }, {
            customTransport: async ({ stage1Json }) => stage1Json
        });

        assert.strictEqual(verifiedResult.entries[0].period, 6);
        assert.strictEqual(verifiedResult.entries[0].span_to, 7);
        assert.strictEqual(verifiedResult.entries[0].session_type, 'lab');
    });

    await checkAsync('TEST 10 & 11: Free slots remain free and activities remain activities in Stage 2', async () => {
        const testImageBuffer = Buffer.from('TEST_IMAGE');
        const stage1Slots = createPayload([
            { day: 'Monday', period: 3, span_to: null, subject_name: null, faculty_name: null, class_name: 'DEEE-B', session_type: 'theory', is_free: true, raw_cell_text: '' },
            { day: 'Tuesday', period: 7, span_to: null, subject_name: 'TPC', faculty_name: null, class_name: 'DEEE-B', session_type: 'activity', is_free: false, raw_cell_text: 'TPC' }
        ]);

        const verifiedResult = await verifyTimetableWithGemini({
            fileBuffer: testImageBuffer,
            mimeType: 'image/jpeg',
            stage1Json: stage1Slots,
            uploadContext: { departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }
        }, {
            customTransport: async ({ stage1Json }) => stage1Json
        });

        assert.strictEqual(verifiedResult.entries[0].is_free, true, 'TEST 10: Free slot is_free must be true');
        assert.strictEqual(verifiedResult.entries[0].subject_name, null);
        assert.strictEqual(verifiedResult.entries[1].is_free, false, 'TEST 11: Activity is_free must be false');
        assert.strictEqual(verifiedResult.entries[1].session_type, 'activity');
        assert.strictEqual(verifiedResult.entries[1].subject_name, 'TPC');
    });

    check('TEST 12 & 13: Non-standard dimensions and dynamic orientation prompt verification', () => {
        const prompt = buildVerificationPrompt({ departmentCode: 'EEE', uploadType: 'MASTER_TIMETABLE' }, {
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            periods: [1, 2, 3, 4, 5, 6, 7, 8]
        });
        assert.ok(prompt.includes('ARBITRARY TIMETABLE LAYOUTS'), 'Prompt must instruct arbitrary layouts support');
        assert.ok(prompt.includes('DO NOT assume or force any fixed timetable template'), 'Prompt must forbid fixed templates');
        assert.ok(prompt.includes('horizontal days, vertical days, transposed period axes'), 'Prompt must support dynamic axes');
    });

    await checkAsync('TEST 14 & 15: Pipeline Stage 2 -> Validation -> Staging and safe failure handling', async () => {
        const uploadValid = await saveUploadRecord({
            uploadId: 'upl_stage2_pipeline_01',
            originalFilename: 'sample_stage2.jpeg',
            fileType: 'image/jpeg',
            fileSize: 1024,
            storagePath: dummyFile,
            uploaderUserId: 1,
            facultyId: null,
            branchId: 'EEE',
            departmentCode: 'EEE',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        // Stage 1 draft has missing faculty; Stage 2 fixes it dynamically
        const draftStage1 = createPayload([
            { day: 'Monday', period: 1, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404', faculty_name: null, class_name: 'DEEE-B', session_type: 'theory', is_free: false, raw_cell_text: 'PE' }
        ], {
            faculty_legend: [{ code: 'DSK', name: 'D.SAGAR KUMAR', designation: 'Asst Prof', department: 'EEE' }]
        });

        const verifiedStage2 = createPayload([
            { day: 'Monday', period: 1, span_to: null, subject_name: 'Power Electronics & PLC', subject_code: 'EE-404', faculty_name: 'D.SAGAR KUMAR', faculty_code: 'DSK', class_name: 'DEEE-B', session_type: 'theory', is_free: false, raw_cell_text: 'PE' }
        ], {
            faculty_legend: [{ code: 'DSK', name: 'D.SAGAR KUMAR', designation: 'Asst Prof', department: 'EEE' }]
        });

        const result = await runExtractionPipeline('upl_stage2_pipeline_01', {
            stage1Transport: async () => JSON.stringify(draftStage1),
            stage2Transport: async () => JSON.stringify(verifiedStage2)
        });

        assert.strictEqual(result.success, true, 'TEST 14: Pipeline must succeed when Stage 2 corrects draft');
        assert.strictEqual(result.status, 'PROCESSED');

        const staged = await getStagedData('upl_stage2_pipeline_01');
        assert.strictEqual(staged.extractedJson.entries[0].faculty_name, 'D.SAGAR KUMAR');

        // TEST 15: Stage 2 failure is handled safely
        const uploadFail = await saveUploadRecord({
            uploadId: 'upl_stage2_pipeline_fail',
            originalFilename: 'sample_fail.jpeg',
            fileType: 'image/jpeg',
            fileSize: 1024,
            storagePath: dummyFile,
            uploaderUserId: 1,
            facultyId: null,
            branchId: 'EEE',
            departmentCode: 'EEE',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        const failResult = await runExtractionPipeline('upl_stage2_pipeline_fail', {
            stage1Transport: async () => JSON.stringify(draftStage1),
            stage2Transport: async () => {
                throw new GeminiExtractionError('Verification service rate limited', 'GEMINI_RATE_LIMIT', 429);
            }
        });

        assert.strictEqual(failResult.success, false, 'TEST 15: Must return failure object');
        assert.strictEqual(failResult.status, 'FAILED');
        assert.strictEqual(failResult.code, 'GEMINI_RATE_LIMIT');

        const failRec = await getUploadRecord('upl_stage2_pipeline_fail');
        assert.strictEqual(failRec.status, 'FAILED');
    });

    // Cleanup
    if (fs.existsSync(dummyFile)) {
        try { fs.unlinkSync(dummyFile); } catch (e) {}
    }

    console.log(`\n====================================`);
    const c = counts();
    console.log(`Phase B2.4.1 Tests finished: ${c.passed} passed, ${c.failed} failed.`);
    console.log(`====================================\n`);

    if (c.failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Test runner failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
