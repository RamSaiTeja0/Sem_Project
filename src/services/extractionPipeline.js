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
const { extractTimetableWithGemini, GeminiExtractionError } = require('../core/geminiExtractor');
const { resolveContract } = require('../core/entityResolver');

/**
 * Runs the extraction pipeline for an upload.
 *
 * @param {string} uploadId
 * @param {Object} [options]
 * @param {Function} [options.geminiTransport] - Custom mock transport for testing
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

    // Call Gemini Vision
    let extractedJson;
    try {
        extractedJson = await extractTimetableWithGemini({
            fileBuffer,
            mimeType: upload.fileType || 'application/pdf',
            uploadContext: {
                departmentCode: upload.departmentCode,
                uploadType: upload.uploadType,
                facultyName: upload.facultyId,
                className: options.className || upload.className || null,
                originalFilename: upload.originalFilename
            }
        }, {
            apiKey: options.apiKey,
            model: options.model,
            customTransport: options.geminiTransport
        });
    } catch (geminiErr) {
        const errorCode = geminiErr.code || 'GEMINI_EXTRACTION_FAILED';
        const errorMessage = geminiErr.message || 'Gemini extraction failed.';
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

    // Validate extracted JSON against B2.1 schema & authoritative upload metadata
    // Note: Catalog reference resolution is delegated to Phase B2.5 resolveContract below
    const validation = validateExtractedContract(extractedJson, upload, { skipCatalogCheck: true });

    if (!validation.ok) {
        await markFailed(uploadId, validation.code || 'VALIDATION_FAILED', validation.errors.join('; '), {
            errors: validation.errors,
            conflicts: validation.conflicts,
            missingReferences: validation.missingReferences
        }, extractedJson);

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

    // Staging: Save validated JSON and resolve against branch catalog (zero silent creation)
    const resolution = await resolveContract(extractedJson, upload.departmentCode);
    await saveStagedData(uploadId, extractedJson, 'VALID', null, {
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
        entryCount: Array.isArray(extractedJson.entries) ? extractedJson.entries.length : 0,
        staged: true,
        message: 'Extracted timetable validated and staged successfully.'
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
