/**
 * Upload management and metadata storage (Phase B1).
 *
 * Stores timetable uploads (PDF, PNG, JPG/JPEG) on the filesystem outside
 * public/static serving, and maintains upload metadata both in PostgreSQL
 * (when configured) and in memory (fallback).
 *
 * Tracks:
 *   - upload_id (UUID/unique identifier)
 *   - original_filename
 *   - file_type (MIME type)
 *   - file_size (bytes)
 *   - storage_path (on disk, non-public)
 *   - uploader_user_id
 *   - faculty_id (if faculty upload)
 *   - branch_id / department_code
 *   - upload_type ('MASTER_TIMETABLE' | 'FACULTY_TIMETABLE')
 *   - status ('UPLOADED' initially)
 *   - created_at
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/pool');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads', 'timetables');

/**
 * Ensure storage directory exists on disk.
 */
function ensureUploadDir() {
    if (!fs.existsSync(UPLOADS_ROOT)) {
        fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
    }
    return UPLOADS_ROOT;
}

// In-memory upload store for fallback / testing
let inMemoryUploads = [];

function generateUploadId() {
    return 'upl_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Save upload metadata record.
 */
async function saveUploadRecord(record) {
    const uploadRecord = {
        uploadId: record.uploadId || generateUploadId(),
        originalFilename: record.originalFilename,
        fileType: record.fileType,
        fileSize: Number(record.fileSize || 0),
        storagePath: record.storagePath,
        uploaderUserId: record.uploaderUserId != null ? String(record.uploaderUserId) : null,
        facultyId: record.facultyId != null ? String(record.facultyId) : null,
        branchId: record.branchId != null ? String(record.branchId) : null,
        departmentCode: String(record.departmentCode || '').toUpperCase(),
        academicYear: record.academicYear || null,
        semester: record.semester || null,
        section: record.section || null,
        targetClass: record.targetClass || null,
        uploadType: record.uploadType, // 'MASTER_TIMETABLE' or 'FACULTY_TIMETABLE'
        status: record.status || 'UPLOADED',
        createdAt: record.createdAt || new Date().toISOString()
    };

    inMemoryUploads.unshift(uploadRecord);

    // If PostgreSQL is active, also persist to database
    if (db.isConfigured()) {
        try {
            // Find department_id and user_id if integers
            const deptRes = await db.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [uploadRecord.departmentCode]);
            const deptId = deptRes.rows.length > 0 ? deptRes.rows[0].id : null;

            let uploaderId = null;
            if (uploadRecord.uploaderUserId && /^\d+$/.test(uploadRecord.uploaderUserId)) {
                uploaderId = parseInt(uploadRecord.uploaderUserId, 10);
            }

            let facId = null;
            if (uploadRecord.facultyId && /^\d+$/.test(uploadRecord.facultyId)) {
                facId = parseInt(uploadRecord.facultyId, 10);
            } else if (uploadRecord.facultyId) {
                const facRes = await db.query('SELECT id FROM faculty WHERE code = $1 OR UPPER(name) = UPPER($1)', [uploadRecord.facultyId]);
                if (facRes.rows.length > 0) facId = facRes.rows[0].id;
            }

            await db.query(`
                INSERT INTO timetable_uploads (
                    upload_id, original_filename, file_type, file_size, storage_path,
                    uploader_user_id, faculty_id, branch_id, department_code,
                    upload_type, status, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (upload_id) DO UPDATE SET
                    status = EXCLUDED.status
            `, [
                uploadRecord.uploadId,
                uploadRecord.originalFilename,
                uploadRecord.fileType,
                uploadRecord.fileSize,
                uploadRecord.storagePath,
                uploaderId,
                facId,
                deptId,
                uploadRecord.departmentCode,
                uploadRecord.uploadType,
                uploadRecord.status,
                uploadRecord.createdAt
            ]);
        } catch (err) {
            // In-memory record is already stored; log warning if db fails
            console.warn('Could not persist upload to database, saved in memory:', err.message);
        }
    }

    return uploadRecord;
}

/**
 * Retrieve upload record by upload ID.
 */
async function getUploadRecord(uploadId) {
    if (!uploadId) return null;

    if (db.isConfigured()) {
        try {
            const { rows } = await db.query(`
                SELECT upload_id AS "uploadId", original_filename AS "originalFilename",
                       file_type AS "fileType", file_size AS "fileSize",
                       storage_path AS "storagePath", uploader_user_id AS "uploaderUserId",
                       faculty_id AS "facultyId", department_code AS "departmentCode",
                       upload_type AS "uploadType", status, created_at AS "createdAt"
                  FROM timetable_uploads
                 WHERE upload_id = $1
            `, [uploadId]);
            if (rows.length > 0) return rows[0];
        } catch (err) {
            // Fall back to in-memory lookup
        }
    }

    const found = inMemoryUploads.find(u => u.uploadId === uploadId);
    return found ? { ...found } : null;
}

/**
 * List uploads filtered by department and optional faculty.
 */
async function listUploadRecords(filters = {}) {
    const dept = filters.department ? String(filters.department).toUpperCase() : null;
    const facId = filters.facultyId ? String(filters.facultyId) : null;
    const type = filters.uploadType ? String(filters.uploadType) : null;

    if (db.isConfigured()) {
        try {
            let query = `
                SELECT upload_id AS "uploadId", original_filename AS "originalFilename",
                       file_type AS "fileType", file_size AS "fileSize",
                       storage_path AS "storagePath", uploader_user_id AS "uploaderUserId",
                       faculty_id AS "facultyId", department_code AS "departmentCode",
                       upload_type AS "uploadType", status, created_at AS "createdAt"
                  FROM timetable_uploads
                 WHERE 1=1
            `;
            const params = [];
            if (dept) {
                params.push(dept);
                query += ` AND UPPER(department_code) = $${params.length}`;
            }
            if (facId) {
                params.push(facId);
                query += ` AND (faculty_id::text = $${params.length} OR faculty_id IS NULL)`;
            }
            if (type) {
                params.push(type);
                query += ` AND upload_type = $${params.length}`;
            }
            query += ` ORDER BY created_at DESC LIMIT 50`;

            const { rows } = await db.query(query, params);
            return rows;
        } catch (err) {
            // Fall back to in-memory filter
        }
    }

    return inMemoryUploads.filter(u => {
        if (dept && u.departmentCode !== dept) return false;
        if (facId && u.facultyId && u.facultyId !== facId) return false;
        if (type && u.uploadType !== type) return false;
        return true;
    });
}

/**
 * In-memory staging store for fallback / testing.
 */
let inMemoryStaging = new Map();

const VALID_STATUSES = new Set(['UPLOADED', 'PROCESSING', 'PROCESSED', 'FAILED']);

/**
 * Validates allowed status state machine transitions.
 */
function isValidStatusTransition(currentStatus, newStatus) {
    if (currentStatus === newStatus) return true; // Idempotent no-op
    switch (currentStatus) {
        case 'UPLOADED':
            return newStatus === 'PROCESSING' || newStatus === 'PROCESSED' || newStatus === 'FAILED';
        case 'PROCESSING':
            return newStatus === 'PROCESSED' || newStatus === 'FAILED';
        case 'FAILED':
            return newStatus === 'PROCESSING' || newStatus === 'PROCESSED' || newStatus === 'FAILED'; // Allowed retry
        case 'PROCESSED':
            return false; // Terminal state: cannot be moved back to processing
        default:
            return false;
    }
}

/**
 * Update the status of an existing upload.
 */
async function updateUploadStatus(uploadId, newStatus) {
    if (!VALID_STATUSES.has(newStatus)) {
        const err = new Error(`Invalid status "${newStatus}". Allowed: ${[...VALID_STATUSES].join(', ')}`);
        err.code = 'INVALID_STATUS';
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

    if (!isValidStatusTransition(upload.status, newStatus)) {
        const err = new Error(`Cannot transition upload status from "${upload.status}" to "${newStatus}".`);
        err.code = upload.status === 'PROCESSED' ? 'ALREADY_PROCESSED' : 'INVALID_STATUS_TRANSITION';
        err.status = 409;
        err.currentStatus = upload.status;
        throw err;
    }

    // Update in-memory
    const memIndex = inMemoryUploads.findIndex(u => u.uploadId === uploadId);
    if (memIndex !== -1) {
        inMemoryUploads[memIndex].status = newStatus;
    }

    // Update in database if configured
    if (db.isConfigured()) {
        try {
            await db.query(`
                UPDATE timetable_uploads
                   SET status = $1
                 WHERE upload_id = $2
            `, [newStatus, uploadId]);
        } catch (err) {
            console.warn('Could not update upload status in database:', err.message);
        }
    }

    upload.status = newStatus;
    return upload;
}

/**
 * Save extracted timetable JSON into the staging store.
 */
async function saveStagedData(uploadId, extractedJson, validationStatus = 'VALID', validationErrors = null, extra = {}) {
    const existing = inMemoryStaging.get(uploadId) || {};
    const record = {
        uploadId,
        extractedJson,
        validationStatus,
        validationErrors,
        importStatus: extra.importStatus || existing.importStatus || 'STAGED',
        reviewedBy: extra.reviewedBy !== undefined ? extra.reviewedBy : (existing.reviewedBy || null),
        reviewedAt: extra.reviewedAt !== undefined ? extra.reviewedAt : (existing.reviewedAt || null),
        rejectionReason: extra.rejectionReason !== undefined ? extra.rejectionReason : (existing.rejectionReason || null),
        importedAt: extra.importedAt !== undefined ? extra.importedAt : (existing.importedAt || null),
        importedCount: extra.importedCount !== undefined ? extra.importedCount : (existing.importedCount || null),
        unresolvedEntities: extra.unresolvedEntities !== undefined ? extra.unresolvedEntities : (existing.unresolvedEntities || []),
        entityMappings: extra.entityMappings !== undefined ? extra.entityMappings : (existing.entityMappings || {}),
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    inMemoryStaging.set(uploadId, record);

    if (db.isConfigured()) {
        try {
            await db.query(`
                INSERT INTO timetable_staging (
                    upload_id, extracted_json, validation_status, validation_errors,
                    import_status, reviewed_by, reviewed_at, rejection_reason,
                    imported_at, imported_count, unresolved_entities, entity_mappings,
                    updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
                ON CONFLICT (upload_id) DO UPDATE SET
                    extracted_json = EXCLUDED.extracted_json,
                    validation_status = EXCLUDED.validation_status,
                    validation_errors = EXCLUDED.validation_errors,
                    import_status = EXCLUDED.import_status,
                    reviewed_by = EXCLUDED.reviewed_by,
                    reviewed_at = EXCLUDED.reviewed_at,
                    rejection_reason = EXCLUDED.rejection_reason,
                    imported_at = EXCLUDED.imported_at,
                    imported_count = EXCLUDED.imported_count,
                    unresolved_entities = EXCLUDED.unresolved_entities,
                    entity_mappings = EXCLUDED.entity_mappings,
                    updated_at = now()
            `, [
                uploadId,
                JSON.stringify(extractedJson),
                validationStatus,
                validationErrors ? JSON.stringify(validationErrors) : null,
                record.importStatus,
                record.reviewedBy,
                record.reviewedAt,
                record.rejectionReason,
                record.importedAt,
                record.importedCount,
                JSON.stringify(record.unresolvedEntities),
                JSON.stringify(record.entityMappings)
            ]);
        } catch (err) {
            console.warn('Could not persist staged data to database:', err.message);
        }
    }

    return record;
}

/**
 * Retrieve staged data for an upload.
 */
async function getStagedData(uploadId) {
    if (!uploadId) return null;

    if (db.isConfigured()) {
        try {
            const { rows } = await db.query(`
                SELECT upload_id AS "uploadId", extracted_json AS "extractedJson",
                       validation_status AS "validationStatus", validation_errors AS "validationErrors",
                       import_status AS "importStatus", reviewed_by AS "reviewedBy",
                       reviewed_at AS "reviewedAt", rejection_reason AS "rejectionReason",
                       imported_at AS "importedAt", imported_count AS "importedCount",
                       unresolved_entities AS "unresolvedEntities", entity_mappings AS "entityMappings",
                       created_at AS "createdAt", updated_at AS "updatedAt"
                  FROM timetable_staging
                 WHERE upload_id = $1
            `, [uploadId]);
            if (rows.length > 0) {
                const r = rows[0];
                return {
                    ...r,
                    unresolvedEntities: Array.isArray(r.unresolvedEntities) ? r.unresolvedEntities : (r.unresolvedEntities || []),
                    entityMappings: r.entityMappings || {}
                };
            }
        } catch (err) {
            // Fall back to in-memory lookup
        }
    }

    return inMemoryStaging.get(uploadId) || null;
}

/**
 * Update staging review status, mappings, or import outcome.
 */
async function updateStagedStatus(uploadId, updates = {}) {
    const current = await getStagedData(uploadId);
    if (!current) {
        const err = new Error(`Staged data for upload "${uploadId}" not found.`);
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
    }

    const updatedRecord = {
        ...current,
        importStatus: updates.importStatus || current.importStatus,
        reviewedBy: updates.reviewedBy !== undefined ? updates.reviewedBy : current.reviewedBy,
        reviewedAt: updates.reviewedAt !== undefined ? updates.reviewedAt : current.reviewedAt,
        rejectionReason: updates.rejectionReason !== undefined ? updates.rejectionReason : current.rejectionReason,
        importedAt: updates.importedAt !== undefined ? updates.importedAt : current.importedAt,
        importedCount: updates.importedCount !== undefined ? updates.importedCount : current.importedCount,
        unresolvedEntities: updates.unresolvedEntities !== undefined ? updates.unresolvedEntities : current.unresolvedEntities,
        entityMappings: updates.entityMappings !== undefined ? updates.entityMappings : current.entityMappings,
        updatedAt: new Date().toISOString()
    };

    inMemoryStaging.set(uploadId, updatedRecord);

    if (db.isConfigured()) {
        try {
            await db.query(`
                UPDATE timetable_staging
                   SET import_status = $1,
                       reviewed_by = $2,
                       reviewed_at = $3,
                       rejection_reason = $4,
                       imported_at = $5,
                       imported_count = $6,
                       unresolved_entities = $7,
                       entity_mappings = $8,
                       updated_at = now()
                 WHERE upload_id = $9
            `, [
                updatedRecord.importStatus,
                updatedRecord.reviewedBy,
                updatedRecord.reviewedAt,
                updatedRecord.rejectionReason,
                updatedRecord.importedAt,
                updatedRecord.importedCount,
                JSON.stringify(updatedRecord.unresolvedEntities),
                JSON.stringify(updatedRecord.entityMappings),
                uploadId
            ]);
        } catch (err) {
            console.warn('Could not update staged status in database:', err.message);
        }
    }

    return updatedRecord;
}

/**
 * List pending staged records for a department.
 */
async function listPendingStaging(departmentCode) {
    const dept = String(departmentCode || '').toUpperCase();
    if (db.isConfigured()) {
        try {
            const { rows } = await db.query(`
                SELECT s.upload_id AS "uploadId", s.extracted_json AS "extractedJson",
                       s.validation_status AS "validationStatus", s.validation_errors AS "validationErrors",
                       s.import_status AS "importStatus", s.reviewed_by AS "reviewedBy",
                       s.reviewed_at AS "reviewedAt", s.imported_at AS "importedAt",
                       s.imported_count AS "importedCount", s.unresolved_entities AS "unresolvedEntities",
                       u.original_filename AS "originalFilename", u.department_code AS "departmentCode",
                       u.upload_type AS "uploadType", u.status AS "uploadStatus",
                       s.created_at AS "createdAt"
                  FROM timetable_staging s
                  JOIN timetable_uploads u ON u.upload_id = s.upload_id
                 WHERE UPPER(u.department_code) = $1
                 ORDER BY s.created_at DESC
                 LIMIT 50
            `, [dept]);
            return rows;
        } catch (err) {
            // fallback
        }
    }

    const results = [];
    for (const [uploadId, record] of inMemoryStaging.entries()) {
        const upload = inMemoryUploads.find(u => u.uploadId === uploadId);
        if (upload && (!dept || upload.departmentCode === dept)) {
            results.push({
                ...record,
                originalFilename: upload.originalFilename,
                departmentCode: upload.departmentCode,
                uploadType: upload.uploadType,
                uploadStatus: upload.status
            });
        }
    }
    return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Clear in-memory uploads and staging (primarily for testing).
 */
function clearUploads() {
    inMemoryUploads = [];
    inMemoryStaging.clear();
}

module.exports = {
    UPLOADS_ROOT,
    ensureUploadDir,
    generateUploadId,
    saveUploadRecord,
    getUploadRecord,
    listUploadRecords,
    updateUploadStatus,
    saveStagedData,
    getStagedData,
    updateStagedStatus,
    listPendingStaging,
    isValidStatusTransition,
    clearUploads
};

