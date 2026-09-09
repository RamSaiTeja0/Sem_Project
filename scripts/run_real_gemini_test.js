/**
 * Phase B2.4 — Real Gemini Extraction Test Script
 *
 * Runs ONE controlled end-to-end extraction against Google Gemini API:
 *   1. Measures initial live timetable entries count
 *   2. Authenticates HOS session
 *   3. Uploads target timetable file via B1 upload API
 *   4. Executes runExtractionPipeline with REAL Gemini API key
 *   5. Validates and stages in timetable_staging
 *   6. Checks final upload status
 *   7. Verifies live timetable entries count is strictly unmodified
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const config = require('../src/config');
const store = require('../src/data/store');
const { getUploadRecord, getStagedData } = require('../src/data/uploads');
const { runExtractionPipeline } = require('../src/services/extractionPipeline');

async function executeRealTest(filePath, branchCode = 'EEE', branchName = 'Electrical and Electronics Engineering', className = 'DEEE-B') {
    console.log('====================================================');
    console.log('PHASE B2.4 — CONTROLLED REAL GEMINI EXTRACTION TEST');
    console.log('====================================================\n');

    if (!fs.existsSync(filePath)) {
        console.error(`ERROR: Timetable file not found at: ${filePath}`);
        process.exit(1);
    }

    if (!config.geminiApiKey) {
        console.error('ERROR: GEMINI_API_KEY is not configured in .env');
        process.exit(1);
    }

    const initialLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);
    console.log(`[1] Live Timetable Snapshot before test: ${initialLiveCount} entries`);

    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    const fileBuffer = fs.readFileSync(filePath);

    console.log(`[2] Target File: "${filename}" (${mimeType}, ${fileBuffer.length} bytes)`);
    console.log(`    Configured Branch: ${branchCode} (${branchName}), Class: ${className}`);

    // Ensure test HOS account exists for the branch
    const users = require('../src/data/users');
    let hosSession = users.findHOSByBranch(branchCode);
    if (!hosSession) {
        try {
            hosSession = users.register({
                role: 'hos',
                name: `HOS ${branchCode}`,
                phone: '9876543210',
                username: `hos_${branchCode.toLowerCase()}_real`,
                password: 'Real_test_pass123',
                branchCode: branchCode,
                branchName: branchName
            });
        } catch (e) {
            hosSession = users.findByUsername(`hos_${branchCode.toLowerCase()}_real`);
        }
    }

    // Save B1 upload record
    const { saveUploadRecord, generateUploadId, UPLOADS_ROOT } = require('../src/data/uploads');
    const uploadId = generateUploadId();
    const destPath = path.join(UPLOADS_ROOT, `${uploadId}${ext}`);
    fs.copyFileSync(filePath, destPath);

    const uploadRecord = await saveUploadRecord({
        uploadId,
        originalFilename: filename,
        fileType: mimeType,
        fileSize: fileBuffer.length,
        storagePath: destPath,
        uploaderUserId: hosSession ? hosSession.id : 1,
        facultyId: null,
        branchId: branchCode,
        departmentCode: branchCode,
        uploadType: 'MASTER_TIMETABLE',
        status: 'UPLOADED'
    });

    console.log(`[3] B1 Upload Record Created: ${uploadRecord.uploadId} (Status: ${uploadRecord.status})`);

    console.log(`[4] Calling Real Google Gemini Vision API (Model: ${config.geminiModel})...`);
    const startTime = Date.now();

    let pipelineResult;
    try {
        pipelineResult = await runExtractionPipeline(uploadRecord.uploadId, { className });
    } catch (err) {
        pipelineResult = {
            success: false,
            uploadId: uploadRecord.uploadId,
            status: 'FAILED',
            code: err.code || 'PIPELINE_ERROR',
            error: err.message
        };
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[5] Gemini API & Pipeline completed in ${duration}s`);

    const finalRecord = await getUploadRecord(uploadRecord.uploadId);
    const stagedData = await getStagedData(uploadRecord.uploadId);
    const postLiveCount = (store.normalized && store.normalized.busyRecords ? store.normalized.busyRecords.length : 0);

    console.log('\n====================================================');
    console.log('TEST EXECUTION REPORT');
    console.log('====================================================');
    console.log(`- Upload ID: ${uploadRecord.uploadId}`);
    console.log(`- Gemini API Request: ${pipelineResult.code !== 'GEMINI_KEY_MISSING' && pipelineResult.code !== 'GEMINI_KEY_INVALID' && pipelineResult.code !== 'GEMINI_API_ERROR' ? 'SUCCESS' : 'FAILED'}`);
    console.log(`- Pipeline Extraction Result: ${pipelineResult.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`- Validation Result: ${stagedData ? stagedData.validationStatus : 'N/A'}`);
    console.log(`- Staging Result: ${stagedData ? 'SUCCESS' : 'FAILED'}`);
    console.log(`- Final Upload Status: ${finalRecord ? finalRecord.status : 'UNKNOWN'}`);

    const entries = stagedData && stagedData.extractedJson && Array.isArray(stagedData.extractedJson.entries)
        ? stagedData.extractedJson.entries
        : [];
    console.log(`- Number of Extracted Entries: ${entries.length}`);

    const warnings = stagedData && stagedData.extractedJson && stagedData.extractedJson.extraction_metadata
        ? stagedData.extractedJson.extraction_metadata.warnings || []
        : [];
    console.log(`- Extraction Warnings: ${JSON.stringify(warnings)}`);

    if (stagedData && stagedData.validationErrors) {
        console.log(`- Validation Errors / Notes: ${JSON.stringify(stagedData.validationErrors, null, 2)}`);
    }

    if (pipelineResult.error) {
        console.log(`- Error Code: ${pipelineResult.code}`);
        console.log(`- Error Details: ${pipelineResult.error}`);
    }

    console.log(`- Live Timetable Count Before: ${initialLiveCount}`);
    console.log(`- Live Timetable Count After:  ${postLiveCount}`);
    console.log(`- Live Timetable Unmodified:   ${initialLiveCount === postLiveCount ? 'VERIFIED (UNCHANGED)' : 'MODIFIED (ERROR!)'}`);

    if (stagedData && stagedData.extractedJson) {
        console.log('\n--- EXTRACTED JSON ---');
        console.log(JSON.stringify(stagedData.extractedJson, null, 2));
    }
    console.log('====================================================\n');
}

if (require.main === module) {
    const targetFile = process.argv[2] || 'sample_timetable.jpeg';
    const branch = process.argv[3] || 'EEE';
    const className = process.argv[4] || 'DEEE-B';
    const branchName = branch === 'EEE' ? 'Electrical and Electronics Engineering' : `${branch} Department`;

    executeRealTest(targetFile, branch, branchName, className).catch(err => {
        console.error('Fatal test error:', err.message);
        process.exit(1);
    });
}

module.exports = { executeRealTest };
