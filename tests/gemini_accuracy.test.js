/**
 * Phase B2.4.1 — Gemini Timetable Extraction Accuracy Tests
 *
 * Verifies:
 *   1. Multi-period lab extraction with span_to and NO duplicate entries passes validation.
 *   2. Multi-period lab with erroneous duplicate entry for subsequent period is caught by validator (CLASS_BUSY).
 *   3. Merged non-lab cells (e.g. drawing ED spanning P1-P2) with span_to and NO duplicate entries passes validation.
 *   4. Scheduled activity (e.g. TPC, Library) with non-null subject_name and null faculty passes validation.
 *   5. Activity with erroneous null subject_name is caught by validator (MISSING_REQUIRED_FIELDS).
 *   6. Blank/free slots (is_free: true, subject_name: null) pass validation.
 *   7. Normal single-period theory slots pass validation.
 *   8. Complete realistic schedule runs through pipeline, validates, stages as VALID, marks PROCESSED, and leaves live timetable untouched.
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

function createPayload(entries = []) {
    return {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        institution_name: 'Aditya Institute of Technology and Management',
        title: 'C23 - IV SEM TIME TABLE',
        department_code: 'EEE',
        academic_year: '2025-2026',
        semester: 4,
        class_name: 'DEEE-B',
        faculty_name: null,
        faculty_code: null,
        default_room: null,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        period_timings: {
            '1': { start: '08:00', end: '08:45' },
            '2': { start: '08:45', end: '09:30' },
            '3': { start: '09:30', end: '10:15' },
            '4': { start: '10:30', end: '11:15' },
            '5': { start: '11:15', end: '12:00' },
            '6': { start: '12:00', end: '12:45' },
            '7': { start: '12:45', end: '13:30' }
        },
        entries,
        extraction_metadata: {
            confidence_score: 0.98,
            warnings: []
        }
    };
}

async function run() {
    console.log('TecSubstitution — Phase B2.4.1 Extraction Accuracy Tests\n');

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
    console.log('[1] Multi-Period Lab & Merged Cell Extraction');
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
                // Erroneous duplicate entry for the covered period
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
    console.log('\n[2] Scheduled Activities vs. Free Cells');
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
                subject_name: null, // Erroneous null
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
    console.log('\n[3] Normal Theory Cells');
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
    console.log('\n[4] Full Realistic Schedule Pipeline Staging Verification');
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
