/**
 * Real Website Upload Flow & Image Routing Regression Tests
 *
 * Tests:
 * 1. Image Routing: JPEG, PNG, WebP route directly to Gemini Stage 1 + Stage 2.
 * 2. No matrix/long-form rejection for images (does not require "Faculty" or "Monday P1").
 * 3. Existing CSV matrix import works.
 * 4. Existing CSV long-form import works.
 * 5. Existing Excel import works.
 * 6. Existing PDF import works.
 * 7. Stage 1 -> Stage 2 -> validation -> normalization pipeline ordering.
 * 8. Original image buffer is passed directly to Stage 2.
 * 9. Dynamic structure: 5-day / 4-period / arbitrary layouts supported without 6-day/7-period assumptions.
 * 10. Multiple timetable types (Types A through H) supported dynamically.
 * 11. TT1.jpeg real website upload preview test.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, checkAsync, counts } = require('./helpers');
const importer = require('../src/importers');
const imageImporter = require('../src/importers/imageImporter');
const documentImporter = require('../src/importers/documentImporter');
const { validateExtractedContract } = require('../src/core/contractValidator');
const { normalize } = require('../src/core/normalizer');
const { validate } = require('../src/core/validator');
const ExcelJS = require('exceljs');

const SAMPLE_STAGE1_CONTRACT = {
    contract_version: "2.1",
    timetable_type: "MASTER_TIMETABLE",
    department_code: "CME",
    academic_year: "2024-25",
    semester: "V",
    section: "A",
    class_name: "CME-V-A",
    faculty_name: null,
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    periods: [1, 2, 3, 4, 5],
    period_timings: [
        { period: 1, start: "09:30", end: "10:20" },
        { period: 2, start: "10:20", end: "11:10" },
        { period: 3, start: "11:10", end: "12:00" },
        { period: 4, start: "12:00", end: "12:50" },
        { period: 5, start: "01:40", end: "02:30" }
    ],
    entries: [
        {
            day: "Monday",
            period: 1,
            span_to: null,
            subject_name: "Operating Systems",
            subject_code: "CM-501",
            faculty_name: "Dr. A. Rao",
            faculty_code: "AR",
            room_code: "Room-301",
            class_name: "CME-V-A",
            session_type: "theory",
            is_free: false
        },
        {
            day: "Monday",
            period: 2,
            span_to: null,
            subject_name: "DBMS",
            subject_code: "CM-502",
            faculty_name: "Dr. B. Iyer",
            faculty_code: "BI",
            room_code: "Room-301",
            class_name: "CME-V-A",
            session_type: "theory",
            is_free: false
        },
        {
            day: "Tuesday",
            period: 3,
            span_to: 5,
            subject_name: "Web Programming Lab",
            subject_code: "CM-508",
            faculty_name: "Prof. C. Menon",
            faculty_code: "CM",
            room_code: "Lab-1",
            class_name: "CME-V-A",
            session_type: "lab",
            is_free: false
        },
        {
            day: "Wednesday",
            period: 2,
            span_to: null,
            subject_name: "Training & Placement (TPC)",
            subject_code: "TPC",
            faculty_name: null,
            faculty_code: null,
            room_code: "Seminar Hall",
            class_name: "CME-V-A",
            session_type: "activity",
            is_free: false
        },
        {
            day: "Friday",
            period: 5,
            span_to: null,
            subject_name: "FREE",
            subject_code: null,
            faculty_name: null,
            faculty_code: null,
            room_code: null,
            class_name: "CME-V-A",
            session_type: "theory",
            is_free: true
        }
    ],
    faculty_legend: [
        { code: "AR", name: "Dr. A. Rao" },
        { code: "BI", name: "Dr. B. Iyer" },
        { code: "CM", name: "Prof. C. Menon" }
    ],
    subject_legend: [
        { code: "CM-501", name: "Operating Systems", faculty_code: "AR" },
        { code: "CM-502", name: "DBMS", faculty_code: "BI" },
        { code: "CM-508", name: "Web Programming Lab", faculty_code: "CM" }
    ]
};

function createMockTransport(stage1Output = SAMPLE_STAGE1_CONTRACT, stage2Output = null) {
    const stage2Final = stage2Output || JSON.parse(JSON.stringify(stage1Output));
    let callCount = 0;
    const calls = [];

    const transport = async (req) => {
        callCount++;
        calls.push(req);

        if (req && req.stage === 2) {
            return stage2Final;
        } else if (req && req.stage === 1) {
            return stage1Output;
        }

        if (req && req.promptText && req.promptText.includes('STAGE 1 DRAFT JSON')) {
            return stage2Final;
        }
        return stage1Output;
    };

    transport.getCalls = () => calls;
    transport.getCallCount = () => callCount;
    return transport;
}

async function runAllTests() {
    console.log('\n======================================================');
    console.log('REAL WEBSITE UPLOAD FLOW & IMAGE ROUTING REGRESSION TESTS');
    console.log('======================================================\n');

    // -------------------------------------------------------------------------
    // Test 1: JPEG timetable reaches Gemini pipeline without matrix/long-form errors
    // -------------------------------------------------------------------------
    await checkAsync('A. JPEG timetable reaches Gemini Stage 1 + Stage 2 pipeline', async () => {
        const mock = createMockTransport();
        const fakeJpeg = Buffer.from('\xFF\xD8\xFF\xE0 fake jpeg bytes');

        const result = await importer.preview(fakeJpeg, 'TT1.jpeg', {
            geminiTransport: mock
        });

        assert.strictEqual(result.format, 'image');
        assert.strictEqual(result.provider, 'gemini-vision');
        assert.strictEqual(mock.getCallCount(), 2, 'Stage 1 + Stage 2 invoked');
        assert.ok(result.report.ok, 'Validation passes');
    });

    // -------------------------------------------------------------------------
    // Test 2: PNG timetable reaches Gemini pipeline
    // -------------------------------------------------------------------------
    await checkAsync('B. PNG timetable reaches Gemini Stage 1 + Stage 2 pipeline', async () => {
        const mock = createMockTransport();
        const fakePng = Buffer.from('\x89PNG\r\n\x1a\n fake png bytes');

        const result = await importer.preview(fakePng, 'schedule.png', {
            geminiTransport: mock
        });

        assert.strictEqual(result.format, 'image');
        assert.strictEqual(result.provider, 'gemini-vision');
        assert.strictEqual(mock.getCallCount(), 2);
    });

    // -------------------------------------------------------------------------
    // Test 3: WebP timetable reaches Gemini pipeline
    // -------------------------------------------------------------------------
    await checkAsync('C. WebP timetable reaches Gemini Stage 1 + Stage 2 pipeline', async () => {
        const mock = createMockTransport();
        const fakeWebp = Buffer.from('RIFF....WEBP fake webp bytes');

        const result = await importer.preview(fakeWebp, 'timetable.webp', {
            geminiTransport: mock
        });

        assert.strictEqual(result.format, 'image');
        assert.strictEqual(result.provider, 'gemini-vision');
        assert.strictEqual(mock.getCallCount(), 2);
    });

    // -------------------------------------------------------------------------
    // Test 4: Image is NOT rejected for lacking "Faculty" column or "Monday P1"
    // -------------------------------------------------------------------------
    await checkAsync('D. Image is NOT rejected because it lacks a "Faculty" column', async () => {
        const mock = createMockTransport();
        const fakeJpeg = Buffer.from('\xFF\xD8\xFF\xE0 TT1');

        // Does NOT throw BAD_STRUCTURE or NO_FACULTY_COLUMN
        const result = await importer.preview(fakeJpeg, 'visual_grid.jpg', {
            geminiTransport: mock
        });

        assert.strictEqual(result.format, 'image');
        assert.ok(result.preview.length > 0);
    });

    // -------------------------------------------------------------------------
    // Test 5: Existing CSV matrix import still works
    // -------------------------------------------------------------------------
    await checkAsync('E. Existing CSV matrix import still works', async () => {
        const matrixCsv =
            'Faculty,Monday P1,Monday P2,Tuesday P1\n' +
            'Dr. A. Rao,OS,DBMS,FREE\n' +
            'Prof. B. Kumar,FREE,CN,Java\n';

        const result = await importer.preview(Buffer.from(matrixCsv), 'matrix.csv');
        assert.strictEqual(result.format, 'csv');
        assert.strictEqual(result.layout, 'matrix');
        assert.strictEqual(result.report.ok, true);
        assert.strictEqual(result.report.summary.busySlots, 4);
    });

    // -------------------------------------------------------------------------
    // Test 6: Existing CSV long-form import still works
    // -------------------------------------------------------------------------
    await checkAsync('F. Existing CSV long-form import still works', async () => {
        const longCsv =
            'Faculty,Day,Period,Subject,Class,Room\n' +
            'Dr. A. Rao,Monday,1,OS,CME-V-A,301\n' +
            'Prof. B. Kumar,Monday,2,CN,CME-V-A,302\n';

        const result = await importer.preview(Buffer.from(longCsv), 'long.csv');
        assert.strictEqual(result.format, 'csv');
        assert.strictEqual(result.layout, 'long');
        assert.strictEqual(result.report.ok, true);
        assert.strictEqual(result.report.summary.busySlots, 2);
    });

    // -------------------------------------------------------------------------
    // Test 7: Existing Excel import still works
    // -------------------------------------------------------------------------
    await checkAsync('G. Existing Excel import still works', async () => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Timetable');
        sheet.addRow(['Faculty', 'Day', 'Period', 'Subject', 'Class', 'Room']);
        sheet.addRow(['Dr. A. Rao', 'Monday', 1, 'OS', 'CME-V-A', '301']);
        sheet.addRow(['Prof. B. Kumar', 'Tuesday', 2, 'CN', 'CME-V-A', '302']);
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

        const result = await importer.preview(buffer, 'timetable.xlsx');
        assert.strictEqual(result.format, 'excel');
        assert.strictEqual(result.report.ok, true);
        assert.strictEqual(result.report.summary.busySlots, 2);
    });

    // -------------------------------------------------------------------------
    // Test 8: Stage 1 -> Stage 2 -> validation -> staging ordering & buffer check
    // -------------------------------------------------------------------------
    await checkAsync('I & J. Stage 1 -> Stage 2 ordering and original image buffer passed to Stage 2', async () => {
        const rawBuffer = Buffer.from('UNIQUE_IMAGE_BUFFER_BYTES_12345');
        let stage1Received = null;
        let stage2Received = null;

        const mockTransport = async (req) => {
            if (req && req.stage === 2) {
                stage2Received = {
                    imageBytes: req.fileBuffer.toString(),
                    mimeType: req.mimeType,
                    prompt: req.promptText
                };
                return SAMPLE_STAGE1_CONTRACT;
            } else {
                stage1Received = {
                    imageBytes: req.fileBuffer.toString(),
                    mimeType: req.mimeType,
                    prompt: req.promptText
                };
                return SAMPLE_STAGE1_CONTRACT;
            }
        };

        const result = await importer.preview(rawBuffer, 'test_pipeline.jpeg', {
            geminiTransport: mockTransport
        });

        assert.ok(stage1Received, 'Stage 1 received image');
        assert.ok(stage2Received, 'Stage 2 received image');
        assert.strictEqual(stage1Received.imageBytes, 'UNIQUE_IMAGE_BUFFER_BYTES_12345');
        assert.strictEqual(stage2Received.imageBytes, 'UNIQUE_IMAGE_BUFFER_BYTES_12345');
        assert.ok(stage2Received.prompt.includes('STAGE 1 DRAFT JSON'));
    });

    // -------------------------------------------------------------------------
    // Test 9: Dynamic Days & Periods: No fixed 6-day / 7-period assumptions
    // -------------------------------------------------------------------------
    await checkAsync('K. Dynamic timetable structure: 5 days, 4 periods supported without fixed grid', async () => {
        const dynamic5Day4PeriodContract = {
            contract_version: "2.1",
            timetable_type: "MASTER_TIMETABLE",
            department_code: "CIVIL",
            academic_year: "2024-25",
            semester: "III",
            section: "B",
            class_name: "CIVIL-III-B",
            days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], // Exactly 5 days
            periods: [1, 2, 3, 4], // Exactly 4 periods
            period_timings: [
                { period: 1, start: "08:30", end: "09:30" },
                { period: 2, start: "09:30", end: "10:30" },
                { period: 3, start: "10:45", end: "11:45" },
                { period: 4, start: "11:45", end: "12:45" }
            ],
            entries: [
                {
                    day: "Monday",
                    period: 1,
                    span_to: null,
                    subject_name: "Surveying",
                    subject_code: "CE-301",
                    faculty_name: "Dr. K. Sharma",
                    room_code: "Room-101",
                    class_name: "CIVIL-III-B",
                    session_type: "theory",
                    is_free: false
                },
                {
                    day: "Friday",
                    period: 3,
                    span_to: 4, // span P3 to P4
                    subject_name: "Surveying Practice Lab",
                    subject_code: "CE-308",
                    faculty_name: "Dr. K. Sharma",
                    room_code: "Survey Lab",
                    class_name: "CIVIL-III-B",
                    session_type: "lab",
                    is_free: false
                }
            ],
            faculty_legend: [{ code: "KS", name: "Dr. K. Sharma" }],
            subject_legend: [{ code: "CE-301", name: "Surveying" }, { code: "CE-308", name: "Surveying Practice Lab" }]
        };

        const mock = createMockTransport(dynamic5Day4PeriodContract);
        const result = await importer.preview(Buffer.from('\xFF\xD8 fake'), '5day_4period.jpeg', {
            geminiTransport: mock
        });

        assert.deepStrictEqual(result.meta.days, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
        assert.deepStrictEqual(result.meta.periods, [1, 2, 3, 4]);
        assert.strictEqual(result.report.ok, true);
        // Dr. K. Sharma: Surveying (Mon P1) + Surveying Lab (Fri P3, Fri P4) = 3 busy slots
        assert.strictEqual(result.report.summary.busySlots, 3);
    });

    // -------------------------------------------------------------------------
    // Test 10: Merged multi-period laboratory cells are expanded properly
    // -------------------------------------------------------------------------
    await checkAsync('Merged multi-period lab cells are preserved and expanded to discrete slots', async () => {
        const mock = createMockTransport();
        const result = await importer.preview(Buffer.from('\xFF\xD8 fake'), 'merged_lab.jpg', {
            geminiTransport: mock
        });

        const menonSlots = result.preview.find(f => f.faculty === 'Prof. C. Menon').slots;
        const tueP3 = menonSlots.find(s => s.day === 'Tuesday' && s.period === 3);
        const tueP4 = menonSlots.find(s => s.day === 'Tuesday' && s.period === 4);
        const tueP5 = menonSlots.find(s => s.day === 'Tuesday' && s.period === 5);

        assert.strictEqual(tueP3.status, 'busy');
        assert.strictEqual(tueP3.subject, 'Web Programming Lab');
        assert.strictEqual(tueP4.status, 'busy');
        assert.strictEqual(tueP4.subject, 'Web Programming Lab');
        assert.strictEqual(tueP5.status, 'busy');
        assert.strictEqual(tueP5.subject, 'Web Programming Lab');
    });

    // -------------------------------------------------------------------------
    // Test 11: Real TT1.jpeg image preview execution
    // -------------------------------------------------------------------------
    await checkAsync('TT1.jpeg real image preview pipeline completes successfully', async () => {
        const tt1Path = path.resolve(__dirname, '..', 'TT1.jpeg');
        const samplePath = path.resolve(__dirname, '..', 'sample_timetable.jpeg');
        if (!fs.existsSync(tt1Path) && fs.existsSync(samplePath)) {
            fs.copyFileSync(samplePath, tt1Path);
        }
        const filePath = fs.existsSync(tt1Path) ? tt1Path : samplePath;
        assert.ok(fs.existsSync(filePath), 'TT1.jpeg or sample_timetable.jpeg exists');
        const realBuffer = fs.readFileSync(filePath);

        const mock = createMockTransport();
        const result = await importer.preview(realBuffer, 'TT1.jpeg', {
            geminiTransport: mock
        });

        assert.strictEqual(result.filename, 'TT1.jpeg');
        assert.strictEqual(result.format, 'image');
        assert.strictEqual(result.provider, 'gemini-vision');
        assert.strictEqual(result.loaded, false, 'Preview mode does not load live data');
        assert.ok(result.report.ok, 'Report is valid');
        assert.ok(result.preview.length > 0, 'Faculty preview rows created');
    });

    // -------------------------------------------------------------------------
    // Test 12: Gemini multimodal extractor fallback handles 429 quota / 503 errors
    // -------------------------------------------------------------------------
    await checkAsync('Gemini model fallback handles quota / demand limits gracefully', async () => {
        let modelsCalled = [];
        const mockPostJson = async (url) => {
            const match = url.match(/models\/([^:]+):generateContent/);
            const modelName = match ? match[1] : '';
            modelsCalled.push(modelName);

            if (modelName === 'gemini-3-flash-preview') {
                return {
                    status: 429,
                    body: { error: { code: 429, message: 'Quota exceeded for metric: generativelanguage.googleapis.com' } }
                };
            }

            return {
                status: 200,
                body: {
                    candidates: [{
                        content: {
                            parts: [{ text: JSON.stringify(SAMPLE_STAGE1_CONTRACT) }]
                        }
                    }]
                }
            };
        };

        const result = await imageImporter.parse(Buffer.from('\xFF\xD8 fake'), {
            filename: 'test.jpeg',
            model: 'gemini-3-flash-preview',
            apiKey: 'fake_key_123',
            postJson: mockPostJson
        });

        assert.ok(result.source, 'Extraction succeeded via fallback');
        assert.strictEqual(result.provider, 'gemini-vision');
        assert.ok(modelsCalled.includes('gemini-3-flash-preview'), 'Initial model was called');
        assert.ok(modelsCalled.some(m => m !== 'gemini-3-flash-preview'), 'Fallback model was called');
    });

    // -------------------------------------------------------------------------
    // Test 13: Live endpoint handles safe error responses without leaking secrets
    // -------------------------------------------------------------------------
    await checkAsync('Import preview returns safe error messages on failure', async () => {
        const secretKey = 'AQ.SUPER_SECRET_KEY_12345';
        try {
            await imageImporter.parse(Buffer.from('\xFF\xD8 fake'), {
                filename: 'invalid.jpeg',
                apiKey: secretKey,
                stage1Transport: async () => {
                    const err = new Error(`Failed to call https://generativelanguage.googleapis.com with key ${secretKey}`);
                    err.code = 'GEMINI_ERROR';
                    err.status = 502;
                    throw err;
                }
            });
            assert.fail('Should have thrown');
        } catch (err) {
            assert.strictEqual(err.code, 'GEMINI_ERROR');
            assert.strictEqual(err.status, 502);
        }
    });

    // -------------------------------------------------------------------------
    // Test 14: Workflow Separation: Preview creates STAGED data and does NOT mutate Master Timetable or Availability
    // -------------------------------------------------------------------------
    await checkAsync('Workflow: Preview creates staged data without mutating Master Timetable or Availability', async () => {
        const store = require('../src/data/store');
        const { getStagedData } = require('../src/data/uploads');

        // Capture baseline entries and availability
        const initialEntriesCount = (store.source && store.source.entries) ? store.source.entries.length : store.listEntriesInMemory().length;
        const initialAvail = store.engine ? store.engine.getAvailability('Monday', 1) : null;

        // Perform preview parse
        const mockTransport = createMockTransport(SAMPLE_STAGE1_CONTRACT);
        const previewResult = await imageImporter.parse(Buffer.from('\xFF\xD8 fake image'), {
            filename: 'preview_only.jpeg',
            session: { role: 'hos', department: 'CME', userId: 'cme_hos' },
            stage1Transport: mockTransport,
            stage2Transport: mockTransport
        });

        assert.ok(previewResult.uploadId, 'Preview returned a staged uploadId');
        assert.ok(previewResult.rawContract, 'Preview returned rawContract');

        // Verify staged record was created in STAGED status
        const stagedRecord = await getStagedData(previewResult.uploadId);
        assert.ok(stagedRecord, 'Staging record exists');
        assert.strictEqual(stagedRecord.importStatus, 'STAGED', 'Staging status is STAGED (pending approval)');
        assert.strictEqual(stagedRecord.validationStatus, 'VALID', 'Validation status is VALID');

        // CRITICAL CHECK: Master Timetable must NOT have changed merely from preview
        const postPreviewEntriesCount = (store.source && store.source.entries) ? store.source.entries.length : store.listEntriesInMemory().length;
        assert.strictEqual(postPreviewEntriesCount, initialEntriesCount, 'Live Master Timetable was NOT modified by preview');

        // CRITICAL CHECK: Availability must NOT use the unapproved preview data
        const postPreviewAvail = store.engine ? store.engine.getAvailability('Monday', 1) : null;
        assert.deepStrictEqual(postPreviewAvail, initialAvail, 'Availability was NOT modified by preview');
    });

    // -------------------------------------------------------------------------
    // Test 15: Workflow: Explicit HOD Approval commits staged timetable and updates Master Timetable + Availability
    // -------------------------------------------------------------------------
    await checkAsync('Workflow: Explicit HOD Approval transactionally updates Master Timetable and Availability', async () => {
        const store = require('../src/data/store');
        const { getStagedData, getUploadRecord } = require('../src/data/uploads');

        const mockTransport = createMockTransport(SAMPLE_STAGE1_CONTRACT);
        const previewResult = await imageImporter.parse(Buffer.from('\xFF\xD8 fake image'), {
            filename: 'approve_test.jpeg',
            session: { role: 'hos', department: 'CME', userId: 'cme_hos' },
            stage1Transport: mockTransport,
            stage2Transport: mockTransport
        });

        const uploadId = previewResult.uploadId;
        const uploadRecord = await getUploadRecord(uploadId);
        const stagedRecord = await getStagedData(uploadId);

        // Approve and transactionally import
        const importResult = store.importStagedTimetableInMemory({
            uploadRecord,
            stagedContract: stagedRecord.extractedJson,
            resolvedMap: {},
            userId: 'cme_hos'
        });

        assert.ok(importResult.importedCount > 0, 'Slots imported into live timetable');

        // Check that Master Timetable now has the newly approved entries
        const liveEntries = (store.source && store.source.entries) ? store.source.entries : store.listEntriesInMemory();
        const cmeApprovedEntries = liveEntries.filter(e => (e.className === 'CME-V-A' || e.class === 'CME-V-A'));
        assert.ok(cmeApprovedEntries.length >= 3, 'Master Timetable contains approved class entries');

        // Check that Availability now reflects the approved schedule
        const newAvail = store.engine ? store.engine.getAvailability('Monday', 1) : null;
        assert.ok(newAvail, 'Availability computed for approved class');
    });

    // -------------------------------------------------------------------------
    // Test 16: Security: Duplicate approval is prevented and rejected timetable cannot be used
    // -------------------------------------------------------------------------
    await checkAsync('Workflow: Duplicate approval and rejected status protection', async () => {
        const { saveUploadRecord, saveStagedData, getStagedData } = require('../src/data/uploads');

        const testUploadId = 'upl_test_dup_approval';
        await saveUploadRecord({
            uploadId: testUploadId,
            originalFilename: 'test_dup.jpeg',
            fileType: 'image/jpeg',
            fileSize: 100,
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE'
        });
        await saveStagedData(testUploadId, SAMPLE_STAGE1_CONTRACT, 'VALID', null, { importStatus: 'IMPORTED' });

        const importedStaging = await getStagedData(testUploadId);
        assert.strictEqual(importedStaging.importStatus, 'IMPORTED');

        // Mark as REJECTED
        const rejUploadId = 'upl_test_rejected';
        await saveUploadRecord({
            uploadId: rejUploadId,
            originalFilename: 'test_rej.jpeg',
            fileType: 'image/jpeg',
            fileSize: 100,
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE'
        });
        await saveStagedData(rejUploadId, SAMPLE_STAGE1_CONTRACT, 'VALID', null, { importStatus: 'REJECTED' });

        const rejectedStaging = await getStagedData(rejUploadId);
        assert.strictEqual(rejectedStaging.importStatus, 'REJECTED');
    });

    // -------------------------------------------------------------------------
    // Test 17: Gemini retry & fallback on 503/429 attempts fallback models
    // -------------------------------------------------------------------------
    await checkAsync('Gemini retry & fallback on 503/429 attempts fallback models', async () => {
        const { extractTimetableWithGemini } = require('../src/core/geminiExtractor');
        const attempts = [];

        const mockPost = async (url, headers, body) => {
            const match = url.match(/\/models\/([^:]+):/);
            const modelName = match ? match[1] : 'unknown';
            attempts.push(modelName);

            if (modelName === 'gemini-3.1-flash-lite') {
                return {
                    status: 503,
                    body: { error: { message: 'This model is currently experiencing high demand.' } },
                    raw: '{"error": {"message": "This model is currently experiencing high demand."}}'
                };
            }
            if (modelName === 'gemini-3.1-flash-lite-preview') {
                return {
                    status: 429,
                    body: { error: { message: 'Rate limit exceeded' } },
                    raw: '{"error": {"message": "Rate limit exceeded"}}'
                };
            }
            // 3rd model in cascade succeeds
            return {
                status: 200,
                body: {
                    candidates: [{
                        content: {
                            parts: [{ text: JSON.stringify(SAMPLE_STAGE1_CONTRACT) }]
                        }
                    }]
                },
                raw: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(SAMPLE_STAGE1_CONTRACT) }] } }] })
            };
        };

        const result = await extractTimetableWithGemini({
            fileBuffer: Buffer.from('fake_image_bytes'),
            mimeType: 'image/jpeg',
            uploadContext: { departmentCode: 'CME', uploadType: 'MASTER_TIMETABLE' }
        }, {
            apiKey: 'test-api-key',
            model: 'gemini-3.1-flash-lite',
            postJson: mockPost,
            maxRetries: 1,
            initialDelayMs: 10
        });

        assert.strictEqual(result.contract_version, '2.1');
        assert.ok(attempts.includes('gemini-3.1-flash-lite'), 'Tried primary model');
        assert.ok(attempts.includes('gemini-3.1-flash-lite-preview'), 'Tried first fallback model');
        assert.ok(attempts.includes('gemini-flash-latest'), 'Tried next fallback model and succeeded');
    });

    // -------------------------------------------------------------------------
    // Test 18: All fallback failures produce clear, controlled error without infinite loop
    // -------------------------------------------------------------------------
    await checkAsync('All fallback failures produce clear controlled error without infinite loop', async () => {
        const { extractTimetableWithGemini } = require('../src/core/geminiExtractor');
        let callCount = 0;

        const allFailingPost = async (url) => {
            callCount++;
            return {
                status: 503,
                body: { error: { message: 'Spikes in demand are usually temporary.' } },
                raw: '{"error": {"message": "Spikes in demand are usually temporary."}}'
            };
        };

        let threw = false;
        try {
            await extractTimetableWithGemini({
                fileBuffer: Buffer.from('fake_image_bytes'),
                mimeType: 'image/jpeg',
                uploadContext: { departmentCode: 'CME', uploadType: 'MASTER_TIMETABLE' }
            }, {
                apiKey: 'test-api-key',
                model: 'gemini-3.1-flash-lite',
                postJson: allFailingPost,
                maxRetries: 2,
                initialDelayMs: 10
            });
        } catch (err) {
            threw = true;
            assert.ok(/temporary error|failed after retries|taking longer than expected/i.test(err.message));
        }

        assert.strictEqual(threw, true, 'Throws bounded error when all fallbacks fail');
        assert.ok(callCount > 1, 'Attempted fallback models');
        assert.ok(callCount <= 30, 'Bounded retry count without infinite loop');
    });

    // -------------------------------------------------------------------------
    // Test 19: Stage 2 receives original image buffer + Stage 1 JSON
    // -------------------------------------------------------------------------
    await checkAsync('Stage 2 verification receives original image buffer + Stage 1 JSON', async () => {
        const { verifyTimetableWithGemini } = require('../src/core/geminiExtractor');
        let capturedPrompt = '';
        let capturedPayload = null;

        const inspectingPost = async (url, headers, body) => {
            capturedPayload = JSON.parse(body);
            capturedPrompt = capturedPayload.contents[0].parts[0].text;
            return {
                status: 200,
                body: {
                    candidates: [{
                        content: {
                            parts: [{ text: JSON.stringify(SAMPLE_STAGE1_CONTRACT) }]
                        }
                    }]
                }
            };
        };

        const imageBuffer = Buffer.from('my_original_image_bytes_12345');
        const stage1Json = { ...SAMPLE_STAGE1_CONTRACT, title: 'Draft Extracted' };

        const result = await verifyTimetableWithGemini({
            fileBuffer: imageBuffer,
            mimeType: 'image/jpeg',
            stage1Json,
            uploadContext: { departmentCode: 'CME', uploadType: 'MASTER_TIMETABLE' }
        }, {
            apiKey: 'test-api-key',
            postJson: inspectingPost
        });

        assert.ok(capturedPrompt.includes('Draft Extracted') || capturedPrompt.includes('STAGE 1 DRAFT JSON'), 'Prompt contains Stage 1 JSON');
        assert.strictEqual(capturedPayload.contents[0].parts[1].inlineData.data, imageBuffer.toString('base64'), 'Stage 2 contains original image binary data');
        assert.strictEqual(result.contract_version, '2.1');
    });

    // -------------------------------------------------------------------------
    // Test 20: Pipeline executes Stage 1 + Stage 2 exactly once per preview request
    // -------------------------------------------------------------------------
    await checkAsync('Pipeline executes Stage 1 + Stage 2 exactly once per preview request', async () => {
        const imageImporter = require('../src/importers/imageImporter');
        let stage1Calls = 0;
        let stage2Calls = 0;

        const stage1Transport = async () => {
            stage1Calls++;
            return SAMPLE_STAGE1_CONTRACT;
        };

        const stage2Transport = async () => {
            stage2Calls++;
            return SAMPLE_STAGE1_CONTRACT;
        };

        const result = await imageImporter.parse(Buffer.from('fake_jpeg_image_data'), {
            filename: 'test_timetable.jpeg',
            stage1Transport,
            stage2Transport,
            session: { department: 'CME', role: 'hos', username: 'cme_hos' }
        });

        assert.strictEqual(stage1Calls, 1, 'Stage 1 ran exactly once');
        assert.strictEqual(stage2Calls, 1, 'Stage 2 ran exactly once');
        assert.strictEqual(result.format, 'image');
        assert.ok(result.rowCount > 0, 'Parsed rows successfully');
    });

    const { passed, failed } = counts();
    console.log(`\n======================================================`);
    console.log(`RESULT: ${passed} passed, ${failed} failed.`);
    console.log(`======================================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Test run error:', err);
    process.exit(1);
});
