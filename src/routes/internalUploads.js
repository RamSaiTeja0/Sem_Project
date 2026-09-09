/**
 * Internal Timetable Upload API — Phase B2.3
 *
 * Dedicated service-to-service endpoints for n8n automation and backend integration.
 *
 * Authentication:
 *   Requires `X-Internal-Secret` matching `INTERNAL_API_SECRET` in environment/config.
 *   Does NOT use browser session cookies.
 *
 * Security & Ownership:
 *   The upload record (uploadId) is authoritative.
 *   department_code, upload_type, and faculty_id cannot be changed by n8n or LLM.
 *
 * Endpoints:
 *   GET  /api/internal/uploads/:uploadId          — Metadata lookup
 *   GET  /api/internal/uploads/:uploadId/file     — Secure binary file retrieval
 *   POST /api/internal/uploads/:uploadId/status   — State machine status transitions
 *   POST /api/internal/uploads/:uploadId/processed— Contract validation & safe staging
 *   POST /api/internal/uploads/:uploadId/fail     — Mark extraction failure
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const config = require('../config');
const {
    getUploadRecord,
    updateUploadStatus,
    saveStagedData,
    getStagedData,
    UPLOADS_ROOT
} = require('../data/uploads');
const { validateExtractedContract } = require('../core/contractValidator');
const { resolveContract } = require('../core/entityResolver');

/**
 * Service-to-service authentication middleware.
 * Verifies X-Internal-Secret header.
 */
function requireInternalAuth(req, res, next) {
    const providedSecret = req.headers['x-internal-secret'];
    const expectedSecret = config.internalApiSecret || process.env.INTERNAL_API_SECRET;

    if (!expectedSecret || !providedSecret || String(providedSecret).trim() !== String(expectedSecret).trim()) {
        return res.status(401).json({
            error: 'Invalid or missing internal service secret.',
            code: 'UNAUTHORIZED'
        });
    }
    next();
}

// All internal upload routes require service authentication
router.use(requireInternalAuth);

/**
 * GET /api/internal/uploads/:uploadId
 * Fetches complete internal metadata for an upload.
 */
router.get('/:uploadId', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await getUploadRecord(uploadId);

        if (!upload) {
            return res.status(404).json({
                error: `Upload "${uploadId}" not found.`,
                code: 'NOT_FOUND'
            });
        }

        return res.json({
            uploadId: upload.uploadId,
            originalFilename: upload.originalFilename,
            fileType: upload.fileType,
            fileSize: upload.fileSize,
            uploadType: upload.uploadType,
            departmentCode: upload.departmentCode,
            facultyId: upload.facultyId || null,
            status: upload.status,
            createdAt: upload.createdAt
        });
    } catch (err) {
        return res.status(err.status || 500).json({
            error: err.message || 'Internal server error',
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/internal/uploads/:uploadId/file
 * Securely streams the binary uploaded file. Prevents arbitrary file access / path traversal.
 */
router.get('/:uploadId/file', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await getUploadRecord(uploadId);

        if (!upload) {
            return res.status(404).json({
                error: `Upload "${uploadId}" not found.`,
                code: 'NOT_FOUND'
            });
        }

        if (!upload.storagePath) {
            return res.status(404).json({
                error: 'No storage path recorded for upload.',
                code: 'FILE_NOT_FOUND'
            });
        }

        const targetPath = path.resolve(upload.storagePath);
        const allowedRoot = path.resolve(UPLOADS_ROOT);

        // Security / Path traversal guard
        if (!targetPath.startsWith(allowedRoot)) {
            return res.status(403).json({
                error: 'Access denied: invalid file path.',
                code: 'FORBIDDEN'
            });
        }

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({
                error: 'Uploaded file not found on disk.',
                code: 'FILE_NOT_FOUND'
            });
        }

        res.setHeader('Content-Type', upload.fileType || 'application/octet-stream');
        res.setHeader('Content-Length', upload.fileSize || fs.statSync(targetPath).size);
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(upload.originalFilename)}"`);

        const stream = fs.createReadStream(targetPath);
        stream.pipe(res);
    } catch (err) {
        return res.status(err.status || 500).json({
            error: err.message || 'Failed to retrieve file',
            code: err.code || 'FILE_RETRIEVAL_FAILED'
        });
    }
});

/**
 * POST /api/internal/uploads/:uploadId/status
 * Updates upload status following the state machine.
 */
router.post('/:uploadId/status', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const newStatus = req.body && req.body.status;

        if (!newStatus) {
            return res.status(400).json({
                error: 'Field "status" is required.',
                code: 'MISSING_STATUS'
            });
        }

        const updated = await updateUploadStatus(uploadId, newStatus);
        return res.json({
            success: true,
            uploadId: updated.uploadId,
            status: updated.status
        });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR',
            currentStatus: err.currentStatus
        });
    }
});

/**
 * POST /api/internal/uploads/:uploadId/processed
 * Validates extracted B2.1 JSON and safely stages it.
 *
 * NEVER inserts into live timetable in Phase B2.3.
 */
router.post('/:uploadId/processed', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await getUploadRecord(uploadId);

        if (!upload) {
            return res.status(404).json({
                error: `Upload "${uploadId}" not found.`,
                code: 'NOT_FOUND'
            });
        }

        // Idempotency: Reject if already processed
        if (upload.status === 'PROCESSED') {
            return res.status(409).json({
                error: `Upload "${uploadId}" is already processed. Duplicate processing rejected.`,
                code: 'ALREADY_PROCESSED',
                status: 'PROCESSED'
            });
        }

        // Verify acceptable state to process
        if (upload.status !== 'UPLOADED' && upload.status !== 'PROCESSING' && upload.status !== 'FAILED') {
            return res.status(409).json({
                error: `Cannot process upload in status "${upload.status}".`,
                code: 'INVALID_STATUS_TRANSITION',
                status: upload.status
            });
        }

        // Body consistency check if uploadId is in body
        if (req.body && req.body.uploadId && req.body.uploadId !== uploadId) {
            return res.status(400).json({
                error: `uploadId in request body ("${req.body.uploadId}") does not match URL parameter ("${uploadId}").`,
                code: 'UPLOAD_ID_MISMATCH'
            });
        }

        const payload = (req.body && (req.body.extractedData || req.body)) || {};

        // Run comprehensive validation against B2.1 schema & upload ownership
        // Note: Catalog reference resolution is delegated to Phase B2.5 resolveContract below
        const validation = validateExtractedContract(payload, upload, { skipCatalogCheck: true });

        if (!validation.ok) {
            // Update status to FAILED and stage validation errors
            try {
                await updateUploadStatus(uploadId, 'FAILED');
                await saveStagedData(uploadId, payload, 'INVALID', {
                    code: validation.code,
                    errors: validation.errors,
                    conflicts: validation.conflicts,
                    missingReferences: validation.missingReferences
                });
            } catch (statusErr) {
                // Keep original validation failure primary
            }

            return res.status(422).json({
                error: 'Timetable validation failed:\n  - ' + validation.errors.join('\n  - '),
                code: validation.code || 'VALIDATION_FAILED',
                details: {
                    errors: validation.errors,
                    conflicts: validation.conflicts,
                    missingReferences: validation.missingReferences
                }
            });
        }

        // Validation passed: Resolve entities against branch catalog and stage safely
        const resolution = await resolveContract(payload, upload.departmentCode);
        await saveStagedData(uploadId, payload, 'VALID', null, {
            importStatus: 'STAGED',
            unresolvedEntities: resolution.unresolvedEntities
        });

        // Update status to PROCESSED
        const updated = await updateUploadStatus(uploadId, 'PROCESSED');

        return res.json({
            success: true,
            uploadId: updated.uploadId,
            status: updated.status,
            department: upload.departmentCode,
            uploadType: upload.uploadType,
            entryCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
            staged: true,
            message: 'Extracted timetable validated and staged successfully.'
        });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({
            error: err.message || 'Failed to process extracted timetable data.',
            code: err.code || 'PROCESSING_FAILED'
        });
    }
});

/**
 * POST /api/internal/uploads/:uploadId/fail
 * Marks extraction as FAILED and records reason.
 */
router.post('/:uploadId/fail', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await getUploadRecord(uploadId);

        if (!upload) {
            return res.status(404).json({
                error: `Upload "${uploadId}" not found.`,
                code: 'NOT_FOUND'
            });
        }

        const body = req.body || {};
        const errorCode = body.errorCode || 'EXTRACTION_FAILED';
        const errorMessage = body.errorMessage || 'Extraction failed.';

        await updateUploadStatus(uploadId, 'FAILED');
        await saveStagedData(uploadId, null, 'INVALID', {
            errorCode,
            errorMessage,
            details: body.details || null
        });

        return res.json({
            success: true,
            uploadId,
            status: 'FAILED',
            message: 'Upload marked as FAILED.'
        });
    } catch (err) {
        return res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

module.exports = router;
