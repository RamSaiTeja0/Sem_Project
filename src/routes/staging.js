/**
 * Staged Timetable Review & Approval API — Phase B2.5
 *
 * Provides endpoints for an authenticated Head of Section (HOS) to:
 *   - Review valid staged timetable extractions
 *   - Map or confirm unresolved references against branch catalog
 *   - Approve and transactionally import into the live timetable
 *   - Reject staged timetables with a reason
 *
 * STRICT GOVERNANCE:
 *   - Gemini and AI extraction NEVER write directly to the live timetable.
 *   - Only an authenticated HOS matching the upload's branch can approve or reject.
 *   - Approval is BLOCKED if validation is not VALID or if unresolved entities remain.
 *   - Zero silent creation of faculty, subjects, rooms, or classes from AI output.
 */

const express = require('express');
const router = express.Router();

const db = require('../db/pool');
const store = require('../data/store');
const repository = require('../db/repository');
const {
    getUploadRecord,
    getStagedData,
    updateStagedStatus,
    listPendingStaging,
    updateUploadStatus
} = require('../data/uploads');
const { resolveContract } = require('../core/entityResolver');

/**
 * Authentication & Authorization Guard:
 * Requires authenticated session with role === 'hos'.
 */
function requireHOS(req, res, next) {
    if (!req.session || !(req.session.id || req.session.username || req.session.userId)) {
        return res.status(401).json({
            error: 'Sign in to use this endpoint.',
            code: 'UNAUTHENTICATED'
        });
    }

    if (req.session.role !== 'hos' && req.session.role !== 'coordinator') {
        return res.status(403).json({
            error: 'Forbidden: Only Head of Section (HOS) accounts can review and approve staged timetables.',
            code: 'FORBIDDEN'
        });
    }

    next();
}

// All staging management endpoints require HOS authentication
router.use(requireHOS);

/**
 * Helper: Verify upload ownership against authenticated HOS branch.
 */
async function verifyBranchOwnership(req, res, uploadId) {
    const upload = await getUploadRecord(uploadId);
    if (!upload) {
        res.status(404).json({
            error: `Upload "${uploadId}" not found.`,
            code: 'NOT_FOUND'
        });
        return null;
    }

    const hosDept = String(req.session.department || '').toUpperCase();
    const uploadDept = String(upload.departmentCode || '').toUpperCase();

    if (hosDept !== uploadDept) {
        res.status(403).json({
            error: `Cross-branch access forbidden. You are HOS of ${hosDept}, but this upload belongs to ${uploadDept}.`,
            code: 'FORBIDDEN'
        });
        return null;
    }

    return upload;
}

/**
 * GET /api/staging/pending
 * Lists all staged uploads for the authenticated HOS's department.
 */
router.get('/pending', async (req, res) => {
    try {
        const hosDept = String(req.session.department || '').toUpperCase();
        const pending = await listPendingStaging(hosDept);
        return res.json({
            count: pending.length,
            department: hosDept,
            staging: pending
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * GET /api/staging/:uploadId
 * Retrieves full staged data, B2.1 JSON, validation results, and unresolved entities.
 */
router.get('/:uploadId', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        // Re-evaluate resolution with any saved mappings
        const resolution = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        return res.json({
            uploadId: staging.uploadId,
            originalFilename: upload.originalFilename,
            departmentCode: upload.departmentCode,
            uploadType: upload.uploadType,
            validationStatus: staging.validationStatus,
            validationErrors: staging.validationErrors,
            importStatus: staging.importStatus || 'STAGED',
            reviewedBy: staging.reviewedBy || null,
            reviewedAt: staging.reviewedAt || null,
            rejectionReason: staging.rejectionReason || null,
            importedAt: staging.importedAt || null,
            importedCount: staging.importedCount || null,
            extractedJson: staging.extractedJson,
            entityMappings: staging.entityMappings || {},
            resolution: {
                ok: resolution.ok,
                unresolvedCount: resolution.unresolvedCount,
                unresolvedEntities: resolution.unresolvedEntities,
                resolvedMap: resolution.resolvedMap,
                catalogCounts: resolution.catalogCounts
            },
            createdAt: staging.createdAt,
            updatedAt: staging.updatedAt
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * POST /api/staging/:uploadId/map-entity
 * Explicitly maps an unresolved reference to an existing branch catalog entity.
 *
 * Payload: {
 *   entityType: 'faculty' | 'subject' | 'class' | 'room',
 *   extractedText: 'G.BHARATH REDDY',
 *   targetId: 5,           // optional if targetCode/targetName provided
 *   targetCode: 'EE-401',  // optional
 *   targetName: '...'      // optional
 * }
 */
router.post('/:uploadId/map-entity', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: 'Cannot modify mappings: timetable has already been imported.',
                code: 'ALREADY_IMPORTED'
            });
        }

        const { entityType, extractedText, targetId, targetCode, targetName } = req.body || {};
        if (!entityType || !extractedText) {
            return res.status(400).json({
                error: 'entityType and extractedText are required.',
                code: 'INVALID_MAPPING_REQUEST'
            });
        }

        const mappingKey = `${entityType.toLowerCase()}:${extractedText.trim()}`;
        const currentMappings = { ...(staging.entityMappings || {}) };
        currentMappings[mappingKey] = {
            entityType,
            extractedText: extractedText.trim(),
            targetId: targetId || null,
            targetCode: targetCode || null,
            targetName: targetName || null,
            mappedBy: req.session.userId || req.session.username || req.session.id,
            mappedAt: new Date().toISOString()
        };

        // Re-evaluate resolution
        const resolution = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            currentMappings
        );

        // Update staging record
        const updated = await updateStagedStatus(uploadId, {
            entityMappings: currentMappings,
            unresolvedEntities: resolution.unresolvedEntities
        });

        return res.json({
            success: true,
            uploadId,
            entityMappings: updated.entityMappings,
            resolution: {
                ok: resolution.ok,
                unresolvedCount: resolution.unresolvedCount,
                unresolvedEntities: resolution.unresolvedEntities
            },
            message: `Mapped "${extractedText}" successfully.`
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * POST /api/staging/:uploadId/approve
 * Approves and transactionally imports a VALID staged timetable into the live timetable.
 */
router.post('/:uploadId/approve', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        // 1. Validation Gate: Strictly check validation_status
        if (staging.validationStatus !== 'VALID') {
            return res.status(422).json({
                error: 'Cannot approve: Timetable failed B2.3 contract validation.',
                code: 'CANNOT_APPROVE_INVALID_DATA',
                validationErrors: staging.validationErrors
            });
        }

        // 2. Idempotency Gate: Reject if already imported
        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: `Timetable "${uploadId}" has already been approved and imported.`,
                code: 'ALREADY_IMPORTED',
                importedAt: staging.importedAt,
                importedCount: staging.importedCount
            });
        }

        // 3. Staging Status Gate: Reject if rejected
        if (staging.importStatus === 'REJECTED') {
            return res.status(409).json({
                error: `Timetable "${uploadId}" was previously rejected. Re-upload or re-process to approve.`,
                code: 'ALREADY_REJECTED',
                rejectionReason: staging.rejectionReason
            });
        }

        // 4. Entity Resolution Gate: Strictly block if unresolved entities remain
        const resolution = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        if (!resolution.ok || resolution.unresolvedCount > 0) {
            return res.status(422).json({
                error: `Cannot approve: ${resolution.unresolvedCount} extracted reference(s) are not resolved against the branch catalog. Map or register them before importing.`,
                code: 'UNRESOLVED_ENTITIES',
                unresolvedEntities: resolution.unresolvedEntities
            });
        }

        // 5. Transactional Import Execution
        const currentUserId = req.session.userId || req.session.username || req.session.id;
        let importResult;
        if (db.isConfigured() && store.usingDatabase) {
            importResult = await repository.importStagedTimetable({
                uploadRecord: upload,
                stagedContract: staging.extractedJson,
                resolvedMap: resolution.resolvedMap,
                userId: currentUserId
            });
            // Reload store cache from PostgreSQL
            await store.reloadFromDatabase();
        } else {
            importResult = store.importStagedTimetableInMemory({
                uploadRecord: upload,
                stagedContract: staging.extractedJson,
                resolvedMap: resolution.resolvedMap,
                userId: currentUserId
            });
        }

        // 6. Update Staging Record to IMPORTED
        const nowIso = new Date().toISOString();
        await updateStagedStatus(uploadId, {
            importStatus: 'IMPORTED',
            reviewedBy: currentUserId,
            reviewedAt: nowIso,
            importedAt: nowIso,
            importedCount: importResult.importedCount,
            unresolvedEntities: []
        });

        // 7. Update Upload Record status to PROCESSED
        await updateUploadStatus(uploadId, 'PROCESSED');

        return res.json({
            success: true,
            uploadId,
            importStatus: 'IMPORTED',
            importedCount: importResult.importedCount,
            targetClass: staging.extractedJson.class_name,
            department: upload.departmentCode,
            reviewedBy: currentUserId,
            importedAt: nowIso,
            message: `Timetable approved successfully. ${importResult.importedCount} period slots imported into the live schedule.`
        });
    } catch (err) {
        const status = err.status || (err.code === 'SLOT_CONFLICT' ? 409 : 500);
        return res.status(status).json({
            error: err.message || 'Failed to import timetable.',
            code: err.code || 'IMPORT_FAILED',
            details: err.details || null
        });
    }
});

/**
 * POST /api/staging/:uploadId/reject
 * Rejects a staged timetable with an optional reason. Zero writes to live timetable.
 */
router.post('/:uploadId/reject', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: 'Cannot reject: timetable has already been imported into the live schedule.',
                code: 'ALREADY_IMPORTED'
            });
        }

        const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : 'Rejected by HOS';
        const nowIso = new Date().toISOString();
        const currentUserId = req.session.userId || req.session.username || req.session.id;

        await updateStagedStatus(uploadId, {
            importStatus: 'REJECTED',
            reviewedBy: currentUserId,
            reviewedAt: nowIso,
            rejectionReason: reason
        });

        // Update upload status to FAILED or keep as historical
        try {
            await updateUploadStatus(uploadId, 'FAILED');
        } catch (e) {
            // keep rejection primary
        }

        return res.json({
            success: true,
            uploadId,
            importStatus: 'REJECTED',
            rejectionReason: reason,
            reviewedBy: currentUserId,
            reviewedAt: nowIso,
            message: 'Staged timetable rejected. No changes were made to the live timetable.'
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

module.exports = router;
