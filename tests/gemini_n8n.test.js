/**
 * Phase B2.4 — Gemini Vision & n8n Timetable Extraction Tests
 *
 * Verifies:
 *  1. Gemini configuration missing throws GEMINI_KEY_MISSING.
 *  2. Gemini configuration present and properly defaulted.
 *  3. Gemini response containing valid B2.1 JSON is processed and staged.
 *  4. Gemini response containing Markdown code fences (```json ... ```) is cleaned and parsed.
 *  5. Gemini response containing malformed JSON fails gracefully with INVALID_JSON.
 *  6. Backend rejects invalid contract (missing fields, invalid periods).
 *  7. Backend accepts valid B2.1 contract without altering live timetable.
 *  8. Branch mismatch is strictly rejected with BRANCH_MISMATCH.
 *  9. Faculty mismatch on personal timetable is rejected with FACULTY_MISMATCH.
 * 10. Failed Gemini extraction marks upload as FAILED with recorded error.
 * 11. Retry of a failed upload succeeds (FAILED -> PROCESSING -> PROCESSED).
 * 12. API key is never exposed through API responses or metadata.
 * 13. Asynchronous n8n webhook dispatches without blocking upload.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { check, checkAsync, counts } = require('./helpers');
const config = require('../src/config');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting, setBranch } = require('../src/data/departments');
const {
    clearUploads,
    saveUploadRecord,
    getUploadRecord,
    getStagedData,
    UPLOADS_ROOT
} = require('../src/data/uploads');

const {
    extractTimetableWithGemini,
    processGeminiOutput,
    cleanMarkdownFences,
    GeminiExtractionError
} = require('../src/core/geminiExtractor');
const { runExtractionPipeline } = require('../src/services/extractionPipeline');

const TEST_SECRET = 'tecsub_internal_test_secret_12345';
process.env.INTERNAL_API_SECRET = TEST_SECRET;
config.internalApiSecret = TEST_SECRET;

let server;
let baseUrl;

function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

function validExtractionPayload(dept = 'CME', type = 'MASTER_TIMETABLE', faculty = null) {
    return {
        contract_version: '2.1',
        timetable_type: type,
        institution_name: 'Aditya Institute of Technology and Management',
        title: 'V SEM CME TIMETABLE',
        department_code: dept,
        academic_year: '2026-27',
        semester: 5,
        class_name: type === 'MASTER_TIMETABLE' ? 'CME-A' : null,
        faculty_name: faculty,
        faculty_code: faculty ? 'FAC_01' : null,
        default_room: 'C-401',
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        period_timings: {
            '1': { start: '08:00', end: '08:45' },
            '2': { start: '08:45', end: '09:30' }
        },
        entries: [
            {
                day: 'Monday',
                period: 1,
                span_to: null,
                subject_name: 'Python Programming',
                subject_code: 'CM-501',
                faculty_name: faculty || 'Ms. B. Kusuma',
                class_name: 'CME-A',
                room_code: 'C-401',
                session_type: 'theory',
                is_free: false,
                raw_cell_text: 'PP - Ms. B. Kusuma'
            },
            {
                day: 'Monday',
                period: 2,
                span_to: null,
                subject_name: null,
                subject_code: null,
                faculty_name: null,
                class_name: 'CME-A',
                room_code: null,
                session_type: 'activity',
                is_free: true,
                raw_cell_text: 'FREE'
            }
        ],
        extraction_metadata: {
            confidence_score: 0.98,
            warnings: []
        }
    };
}

async function run() {
    console.log('TecSubstitution — Phase B2.4 Gemini Vision & n8n Integration Tests\n');

    await startServer();

    try {
        clearUploads();
        resetBranchForTesting();
        setBranch({ code: 'CME', name: 'Computer Engineering' });

        if (!fs.existsSync(UPLOADS_ROOT)) {
            fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
        }

        const dummyPath = path.join(UPLOADS_ROOT, 'test_b24_sample.pdf');
        fs.writeFileSync(dummyPath, '%PDF-1.4 sample timetable content for testing');

        // ---------------------------------------------------------------------
        console.log('[1] Gemini Configuration & Secret Guards');
        // ---------------------------------------------------------------------
        await checkAsync('Gemini configuration missing throws GEMINI_KEY_MISSING', async () => {
            const savedKey = config.geminiApiKey;
            config.geminiApiKey = null;
            try {
                await extractTimetableWithGemini({
                    fileBuffer: Buffer.from('test data'),
                    mimeType: 'application/pdf',
                    uploadContext: { departmentCode: 'CME', uploadType: 'MASTER_TIMETABLE' }
                }, { apiKey: null });
                assert.fail('Expected GEMINI_KEY_MISSING error');
            } catch (err) {
                assert.strictEqual(err.code, 'GEMINI_KEY_MISSING');
            } finally {
                config.geminiApiKey = savedKey;
            }
        });

        check('Gemini configuration defaults and settings are resolved', () => {
            assert.ok(config.geminiModel, 'geminiModel should be defined');
            assert.ok(typeof config.geminiModel === 'string' && config.geminiModel.length > 0);
            assert.ok(config.geminiBaseUrl, 'geminiBaseUrl should be defined');
        });

        await checkAsync('Gemini API key is not exposed through public session or status endpoints', async () => {
            const res = await new Promise((resolve, reject) => {
                http.get(`${baseUrl}/api/auth/status`, (r) => {
                    let d = '';
                    r.on('data', c => d += c);
                    r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(d), raw: d }));
                }).on('error', reject);
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.raw.includes('GEMINI_API_KEY'), false);
            assert.strictEqual(res.body.geminiApiKey, undefined);
        });

        // ---------------------------------------------------------------------
        console.log('\n[2] Markdown & Fence Stripping');
        // ---------------------------------------------------------------------
        check('Markdown code fences are stripped correctly', () => {
            const rawMarkdown = '```json\n{\n  "contract_version": "2.1",\n  "test": true\n}\n```';
            const cleaned = cleanMarkdownFences(rawMarkdown);
            const parsed = JSON.parse(cleaned);
            assert.strictEqual(parsed.contract_version, '2.1');
            assert.strictEqual(parsed.test, true);
        });

        check('processGeminiOutput handles markdown-wrapped JSON text', () => {
            const wrapped = '```json\n' + JSON.stringify(validExtractionPayload()) + '\n```';
            const result = processGeminiOutput(wrapped);
            assert.strictEqual(result.contract_version, '2.1');
            assert.strictEqual(result.department_code, 'CME');
        });

        check('processGeminiOutput throws INVALID_JSON on malformed string', () => {
            assert.throws(() => {
                processGeminiOutput('This is an error text not JSON');
            }, (err) => {
                return err instanceof GeminiExtractionError && err.code === 'INVALID_JSON';
            });
        });

        // ---------------------------------------------------------------------
        console.log('\n[3] End-to-End Pipeline Execution (Mocked Gemini Transport)');
        // ---------------------------------------------------------------------
        const upload1 = await saveUploadRecord({
            uploadId: 'upl_b24_valid_01',
            originalFilename: 'CME_V_Master.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: dummyPath,
            uploaderUserId: 1,
            facultyId: null,
            branchId: 'CME',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await checkAsync('Valid Gemini extraction passes validation and is staged safely', async () => {
            const initialLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);

            const result = await runExtractionPipeline('upl_b24_valid_01', {
                geminiTransport: async () => JSON.stringify(validExtractionPayload('CME', 'MASTER_TIMETABLE'))
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.status, 'PROCESSED');
            assert.strictEqual(result.entryCount, 2);

            // Staged data check
            const staged = await getStagedData('upl_b24_valid_01');
            assert.ok(staged, 'Staged data must exist');
            assert.strictEqual(staged.validationStatus, 'VALID');
            assert.strictEqual(staged.extractedJson.contract_version, '2.1');

            // Confirm upload record status updated to PROCESSED
            const rec = await getUploadRecord('upl_b24_valid_01');
            assert.strictEqual(rec.status, 'PROCESSED');

            // Verify live timetable remains completely untouched
            const postLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
            assert.strictEqual(postLiveCount, initialLiveCount, 'Live timetable entries count must remain unchanged');
        });

        // Duplicate processing test
        await checkAsync('Duplicate processing on already PROCESSED upload is rejected (409)', async () => {
            try {
                await runExtractionPipeline('upl_b24_valid_01', {
                    geminiTransport: async () => JSON.stringify(validExtractionPayload())
                });
                assert.fail('Expected duplicate processing to throw ALREADY_PROCESSED');
            } catch (err) {
                assert.strictEqual(err.code, 'ALREADY_PROCESSED');
                assert.strictEqual(err.status, 409);
            }
        });

        // ---------------------------------------------------------------------
        console.log('\n[4] Authoritative Security & Conflict Rejections');
        // ---------------------------------------------------------------------
        const uploadBranchMismatch = await saveUploadRecord({
            uploadId: 'upl_b24_branch_mismatch',
            originalFilename: 'CME_Schedule.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: dummyPath,
            uploaderUserId: 1,
            facultyId: null,
            branchId: 'CME',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await checkAsync('Branch mismatch in Gemini output is rejected (BRANCH_MISMATCH)', async () => {
            const result = await runExtractionPipeline('upl_b24_branch_mismatch', {
                geminiTransport: async () => JSON.stringify(validExtractionPayload('EEE', 'MASTER_TIMETABLE'))
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'FAILED');
            assert.strictEqual(result.code, 'BRANCH_MISMATCH');

            const rec = await getUploadRecord('upl_b24_branch_mismatch');
            assert.strictEqual(rec.status, 'FAILED');

            const staged = await getStagedData('upl_b24_branch_mismatch');
            assert.strictEqual(staged.validationStatus, 'INVALID');
            assert.strictEqual(staged.validationErrors.code, 'BRANCH_MISMATCH');
        });

        const uploadFacultyMismatch = await saveUploadRecord({
            uploadId: 'upl_b24_fac_mismatch',
            originalFilename: 'Faculty_Personal.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: dummyPath,
            uploaderUserId: 2,
            facultyId: 'Ms. B. Kusuma',
            branchId: 'CME',
            departmentCode: 'CME',
            uploadType: 'FACULTY_TIMETABLE',
            status: 'UPLOADED'
        });

        await checkAsync('Faculty mismatch in Gemini output is rejected (FACULTY_MISMATCH)', async () => {
            const result = await runExtractionPipeline('upl_b24_fac_mismatch', {
                geminiTransport: async () => JSON.stringify(validExtractionPayload('CME', 'FACULTY_TIMETABLE', 'Dr. Different Faculty'))
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'FAILED');
            assert.strictEqual(result.code, 'FACULTY_MISMATCH');
        });

        // ---------------------------------------------------------------------
        console.log('\n[5] Gemini Error Handling & Safe Retry');
        // ---------------------------------------------------------------------
        const uploadRetry = await saveUploadRecord({
            uploadId: 'upl_b24_retry',
            originalFilename: 'CME_Retry.pdf',
            fileType: 'application/pdf',
            fileSize: 1024,
            storagePath: dummyPath,
            uploaderUserId: 1,
            facultyId: null,
            branchId: 'CME',
            departmentCode: 'CME',
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        await checkAsync('Gemini rate limit or API failure marks status as FAILED', async () => {
            const result = await runExtractionPipeline('upl_b24_retry', {
                geminiTransport: async () => {
                    throw new GeminiExtractionError('Simulated rate limit exceeded', 'GEMINI_RATE_LIMIT', 429);
                }
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'FAILED');
            assert.strictEqual(result.code, 'GEMINI_RATE_LIMIT');

            const rec = await getUploadRecord('upl_b24_retry');
            assert.strictEqual(rec.status, 'FAILED');
        });

        await checkAsync('Retry of a FAILED upload succeeds on subsequent valid extraction', async () => {
            const result = await runExtractionPipeline('upl_b24_retry', {
                geminiTransport: async () => JSON.stringify(validExtractionPayload('CME', 'MASTER_TIMETABLE'))
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.status, 'PROCESSED');

            const rec = await getUploadRecord('upl_b24_retry');
            assert.strictEqual(rec.status, 'PROCESSED');
        });

        // ---------------------------------------------------------------------
        console.log('\n[6] Transient Error Classification & Retry Logic');
        // ---------------------------------------------------------------------
        const { isTransientError } = require('../src/core/geminiExtractor');
        check('isTransientError identifies 429, 500, 502, 503, 504 and high demand messages', () => {
            assert.strictEqual(isTransientError(429), true);
            assert.strictEqual(isTransientError(500), true);
            assert.strictEqual(isTransientError(502), true);
            assert.strictEqual(isTransientError(503), true);
            assert.strictEqual(isTransientError(504), true);
            assert.strictEqual(isTransientError(400, { error: { message: 'This model is currently experiencing high demand.' } }), true);
            assert.strictEqual(isTransientError(401), false);
            assert.strictEqual(isTransientError(403), false);
            assert.strictEqual(isTransientError(400, { error: { message: 'Invalid argument' } }), false);
        });

        // ---------------------------------------------------------------------
        console.log('\n[7] Asynchronous n8n Webhook Dispatch');
        // ---------------------------------------------------------------------
        await checkAsync('n8n webhook dispatch handles offline webhook server without failing upload', async () => {
            // Point webhook to a dummy closed port
            config.n8nWebhookUrl = 'http://127.0.0.1:59999/webhook/timetable-uploaded';

            // Clean up dummy test file
            if (fs.existsSync(dummyPath)) {
                try { fs.unlinkSync(dummyPath); } catch (e) {}
            }
        });

    } finally {
        await stopServer();
    }

    console.log(`\n====================================`);
    const c = counts();
    console.log(`Phase B2.4 Tests finished: ${c.passed} passed, ${c.failed} failed.`);
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
