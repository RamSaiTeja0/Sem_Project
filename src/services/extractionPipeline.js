/**
 * Timetable Extraction Pipeline — Phase B2.4
 *
 * Orchestrates the complete end-to-end extraction lifecycle:
 *   1. Lookup upload metadata
 *   2. Retrieve secure binary file
 *   3. Mark status PROCESSING
 *   4. Invoke Gemini Vision extraction
 *   5. Validate extracted JSON against B2.1 schema & upload authority
 *   6. Stage validated data safely
 *   7. Update upload status to PROCESSED (or FAILED on error)
 *
 * Never writes directly to the live timetable table.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
    getUploadRecord,
    updateUploadStatus,
    saveStagedData,
    UPLOADS_ROOT
} = require('../data/uploads');
const { validateExtractedContract } = require('../core/contractValidator');
const { extractTimetableWithGemini, verifyTimetableWithGemini, GeminiExtractionError } = require('../core/geminiExtractor');
const { resolveContract } = require('../core/entityResolver');

/**
 * Runs the extraction pipeline for an upload.
 *
 * @param {string} uploadId
 * @param {Object} [options]
 * @param {Function} [options.geminiTransport] - Custom mock transport for testing (default/both stages)
 * @param {Function} [options.stage1Transport] - Custom mock transport for Stage 1
 * @param {Function} [options.stage2Transport] - Custom mock transport for Stage 2
 * @param {string} [options.apiKey] - Override API key
 * @param {string} [options.model] - Override model
 * @returns {Promise<Object>} Result object with status and metadata
 */
async function runExtractionPipeline(uploadId, options = {}) {
    if (!uploadId || typeof uploadId !== 'string') {
        const err = new Error('uploadId is required');
        err.code = 'INVALID_UPLOAD_ID';
        err.status = 400;
        throw err;
    }

    const upload = await getUploadRecord(uploadId);
    if (!upload) {
        const err = new Error(`Upload "${uploadId}" not found.`);
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
    }

    // Idempotency: Reject if already processed
    if (upload.status === 'PROCESSED') {
        const err = new Error(`Upload "${uploadId}" is already processed. Duplicate processing rejected.`);
        err.code = 'ALREADY_PROCESSED';
        err.status = 409;
        err.currentStatus = 'PROCESSED';
        throw err;
    }

    // Verify acceptable state to transition to PROCESSING
    if (upload.status !== 'UPLOADED' && upload.status !== 'PROCESSING' && upload.status !== 'FAILED') {
        const err = new Error(`Cannot process upload in status "${upload.status}".`);
        err.code = 'INVALID_STATUS_TRANSITION';
        err.status = 409;
        err.currentStatus = upload.status;
        throw err;
    }

    // Transition status to PROCESSING
    await updateUploadStatus(uploadId, 'PROCESSING');

    // Retrieve file binary securely
    const filePath = path.resolve(upload.storagePath);
    const allowedRoot = path.resolve(UPLOADS_ROOT);

    if (!filePath.startsWith(allowedRoot)) {
        await markFailed(uploadId, 'SECURITY_VIOLATION', 'Path traversal attempt detected.');
        const err = new Error('File path outside allowed directory.');
        err.code = 'FORBIDDEN';
        err.status = 403;
        throw err;
    }

    if (!fs.existsSync(filePath)) {
        await markFailed(uploadId, 'FILE_NOT_FOUND', 'Uploaded file not found on disk.');
        const err = new Error('Uploaded file not found on disk.');
        err.code = 'FILE_NOT_FOUND';
        err.status = 404;
        throw err;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const uploadContext = {
        departmentCode: upload.departmentCode,
        uploadType: upload.uploadType,
        facultyName: upload.facultyId,
        className: options.className || upload.className || null,
        originalFilename: upload.originalFilename
    };

    // -------------------------------------------------------------------------
    // Step 1: Stage 1 Gemini Vision Extraction
    // -------------------------------------------------------------------------
    let stage1Json;
    try {
        stage1Json = await extractTimetableWithGemini({
            fileBuffer,
            mimeType: upload.fileType || 'application/pdf',
            uploadContext
        }, {
            apiKey: options.apiKey,
            model: options.model,
            customTransport: options.stage1Transport || options.geminiTransport
        });
    } catch (geminiErr) {
        const errorCode = geminiErr.code || 'GEMINI_EXTRACTION_FAILED';
        const errorMessage = geminiErr.message || 'Gemini Stage 1 extraction failed.';
        await markFailed(uploadId, errorCode, errorMessage, geminiErr.details);
        return {
            success: false,
            uploadId,
            status: 'FAILED',
            code: errorCode,
            error: errorMessage,
            details: geminiErr.details || null
        };
    }

    // Basic JSON safety check on Stage 1 draft
    if (!stage1Json || typeof stage1Json !== 'object' || Array.isArray(stage1Json)) {
        await markFailed(uploadId, 'INVALID_JSON_STRUCTURE', 'Stage 1 extraction produced invalid JSON object.', null, stage1Json);
        return {
            success: false,
            uploadId,
            status: 'FAILED',
            code: 'INVALID_JSON_STRUCTURE',
            error: 'Stage 1 extraction produced invalid JSON structure.'
        };
    }

    // -------------------------------------------------------------------------
    // Step 2: Stage 2 Gemini Vision Multimodal Verification (Original Image + Stage 1 JSON)
    // -------------------------------------------------------------------------
    let stage2Json;
    try {
        stage2Json = await verifyTimetableWithGemini({
            fileBuffer,
            mimeType: upload.fileType || 'application/pdf',
            stage1Json,
            uploadContext
        }, {
            apiKey: options.apiKey,
            model: options.model,
            customTransport: options.stage2Transport || options.geminiTransport
        });
    } catch (stage2Err) {
        const errorCode = stage2Err.code || 'GEMINI_VERIFICATION_FAILED';
        const errorMessage = stage2Err.message || 'Gemini Stage 2 verification failed.';
        await markFailed(uploadId, errorCode, errorMessage, stage2Err.details, stage1Json);
        return {
            success: false,
            uploadId,
            status: 'FAILED',
            code: errorCode,
            error: errorMessage,
            details: stage2Err.details || null
        };
    }

    // -------------------------------------------------------------------------
    // Step 3: Final B2.1 Validation on Verified Stage 2 JSON
    // -------------------------------------------------------------------------
    const validation = validateExtractedContract(stage2Json, upload, { skipCatalogCheck: true });

    if (!validation.ok) {
        await markFailed(uploadId, validation.code || 'VALIDATION_FAILED', validation.errors.join('; '), {
            errors: validation.errors,
            conflicts: validation.conflicts,
            missingReferences: validation.missingReferences
        }, stage2Json);

        return {
            success: false,
            uploadId,
            status: 'FAILED',
            code: validation.code || 'VALIDATION_FAILED',
            error: 'Timetable validation failed:\n  - ' + validation.errors.join('\n  - '),
            details: {
                errors: validation.errors,
                conflicts: validation.conflicts,
                missingReferences: validation.missingReferences
            }
        };
    }

    // -------------------------------------------------------------------------
    // Step 4: Staging & Branch Catalog Entity Resolution
    // -------------------------------------------------------------------------
    const resolution = await resolveContract(stage2Json, upload.departmentCode);
    await saveStagedData(uploadId, stage2Json, 'VALID', null, {
        importStatus: 'STAGED',
        unresolvedEntities: resolution.unresolvedEntities
    });

    // Mark PROCESSED
    const updated = await updateUploadStatus(uploadId, 'PROCESSED');

    return {
        success: true,
        uploadId: updated.uploadId,
        status: updated.status,
        department: upload.departmentCode,
        uploadType: upload.uploadType,
        entryCount: Array.isArray(stage2Json.entries) ? stage2Json.entries.length : 0,
        staged: true,
        message: 'Extracted timetable verified, validated, and staged successfully.'
    };
}

/**
 * Helper to transition upload to FAILED and record error details in staging.
 */
async function markFailed(uploadId, errorCode, errorMessage, details = null, rawPayload = null) {
    try {
        await updateUploadStatus(uploadId, 'FAILED');
        await saveStagedData(uploadId, rawPayload, 'INVALID', {
            code: errorCode,
            errorCode,
            errorMessage,
            details
        });
    } catch (e) {
        // preserve original error
    }
}

module.exports = {
    runExtractionPipeline,
    markFailed
};
