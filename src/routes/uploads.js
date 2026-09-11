/**
 * Timetable upload routes (Phase B1).
 *
 * Provides endpoints for HOS and Faculty to upload timetable documents
 * (PNG, JPG/JPEG, PDF) with strict validation, secure non-public storage,
 * and multi-branch / role-based isolation.
 *
 *   POST /api/uploads/master-timetable   (HOS only, scoped to HOS branch)
 *   POST /api/uploads/faculty-timetable  (Faculty only, scoped to faculty identity & branch)
 *   GET  /api/uploads/:uploadId          (Metadata status for an upload)
 *   GET  /api/uploads                   (List recent uploads for authenticated branch/faculty)
 *
 * NOTE: Phase B1 does NOT perform AI / OCR processing. Uploaded files receive status 'UPLOADED'.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const router = express.Router();

const config = require('../config');
const {
    ensureUploadDir,
    generateUploadId,
    saveUploadRecord,
    getUploadRecord,
    listUploadRecords,
    UPLOADS_ROOT
} = require('../data/uploads');

ensureUploadDir();

// Allowed timetable file extensions and mime types
const ALLOWED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.pdf']);
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/pjpeg', 'application/pdf']);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        ensureUploadDir();
        cb(null, UPLOADS_ROOT);
    },
    filename: (req, file, cb) => {
        const uploadId = generateUploadId();
        req._uploadId = uploadId;
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, `${uploadId}${ext}`);
    }
});

const uploadMiddleware = multer({
    storage,
    limits: {
        fileSize: config.maxUploadBytes || 10 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const mime = (file.mimetype || '').toLowerCase();

        if (!ALLOWED_EXTS.has(ext) || !ALLOWED_MIMES.has(mime)) {
            const err = new Error('Invalid file type. Allowed formats: PNG, JPG, JPEG, PDF.');
            err.code = 'INVALID_FILE_TYPE';
            err.status = 400;
            return cb(err);
        }
        cb(null, true);
    }
});

function fileUploadHandler(req, res, next) {
    uploadMiddleware.single('timetable')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    error: `File is too large. Maximum allowed size is ${Math.round((config.maxUploadBytes || 10485760) / (1024 * 1024))} MB.`,
                    code: 'FILE_TOO_LARGE'
                });
            }
            const status = err.status || 400;
            return res.status(status).json({
                error: err.message || 'File upload error',
                code: err.code || 'UPLOAD_ERROR'
            });
        }
        next();
    });
}

/**
 * Common validation on uploaded file:
 * - Check if file exists
 * - Check if file is empty (0 bytes)
 */
function validateUploadedFile(file) {
    if (!file) {
        const err = new Error('No file uploaded. Please select a timetable file.');
        err.status = 400;
        err.code = 'NO_FILE';
        throw err;
    }
    if (file.size === 0) {
        // Cleanup 0-byte file from disk
        if (file.path && fs.existsSync(file.path)) {
            try { fs.unlinkSync(file.path); } catch (e) {}
        }
        const err = new Error('Uploaded file is empty.');
        err.status = 400;
        err.code = 'EMPTY_FILE';
        throw err;
    }
}

/**
 * Asynchronously notify n8n webhook if configured.
 * Fire-and-forget: does not block or fail user upload.
 */
function dispatchN8nWebhook(uploadRecord) {
    if (!config.n8nWebhookUrl) return;
    try {
        const payload = JSON.stringify({
            event: 'TIMETABLE_UPLOADED',
            uploadId: uploadRecord.uploadId,
            uploadType: uploadRecord.uploadType,
            departmentCode: uploadRecord.departmentCode,
            facultyId: uploadRecord.facultyId || null,
            originalFilename: uploadRecord.originalFilename,
            fileType: uploadRecord.fileType,
            fileSize: uploadRecord.fileSize,
            timestamp: uploadRecord.createdAt || new Date().toISOString()
        });

        const url = new URL(config.n8nWebhookUrl);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const req = client.request({
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 5000
        }, (res) => {
            res.resume();
        });

        req.on('error', () => {});
        req.on('timeout', () => { req.destroy(); });
        req.write(payload);
        req.end();
    } catch (e) {
        // Non-blocking fire-and-forget
    }
}

/**
 * POST /api/uploads/master-timetable
 * HOS only. Uploads a master timetable image or PDF for the HOS's branch.
 */
router.post('/master-timetable', fileUploadHandler, async (req, res) => {
    try {
        if (!req.session) {
            return res.status(401).json({ error: 'Sign in to use this endpoint.', code: 'UNAUTHENTICATED' });
        }

        const role = req.session.role;
        if (role !== 'hos' && role !== 'coordinator') {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
            }
            return res.status(403).json({
                error: 'Only Head of Section (HOS) can upload a Master Timetable.',
                code: 'FORBIDDEN'
            });
        }

        // Branch is strictly inherited from authenticated session
        const sessionDept = String(req.session.department || '').toUpperCase();
        if (!sessionDept) {
            return res.status(400).json({
                error: 'Authenticated HOS session has no associated branch.',
                code: 'NO_BRANCH'
            });
        }

        // Reject any client attempt to change branch
        const clientDept = req.body && (req.body.department || req.body.branch_id || req.body.branchCode);
        if (clientDept && String(clientDept).trim().toUpperCase() !== sessionDept) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
            }
            return res.status(403).json({
                error: `As HOS of ${sessionDept}, you cannot upload a master timetable for another branch.`,
                code: 'BRANCH_UPLOAD_MISMATCH'
            });
        }

        validateUploadedFile(req.file);

        const reqAcademicYear = req.body && req.body.academicYear ? String(req.body.academicYear).trim() : null;
        const reqSemester = req.body && req.body.semester ? String(req.body.semester).trim().toUpperCase() : null;
        const reqSection = req.body && req.body.section ? String(req.body.section).trim().toUpperCase() : null;
        const reqClass = req.body && (req.body.className || req.body.class) ? String(req.body.className || req.body.class).trim() : null;

        const uploadRecord = await saveUploadRecord({
            uploadId: req._uploadId,
            originalFilename: req.file.originalname,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            storagePath: req.file.path,
            uploaderUserId: req.session.userId || req.session.username,
            facultyId: null,
            branchId: sessionDept,
            departmentCode: sessionDept,
            academicYear: reqAcademicYear,
            semester: reqSemester,
            section: reqSection,
            targetClass: reqClass,
            uploadType: 'MASTER_TIMETABLE',
            status: 'UPLOADED'
        });

        // Trigger asynchronous n8n webhook if configured
        dispatchN8nWebhook(uploadRecord);

        return res.status(201).json({
            success: true,
            uploadId: uploadRecord.uploadId,
            originalFilename: uploadRecord.originalFilename,
            fileType: uploadRecord.fileType,
            fileSize: uploadRecord.fileSize,
            uploadType: uploadRecord.uploadType,
            department: uploadRecord.departmentCode,
            status: uploadRecord.status,
            createdAt: uploadRecord.createdAt,
            message: 'Timetable uploaded. Processing will be available in the next step.'
        });
    } catch (err) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        return res.status(err.status || 500).json({
            error: err.message || 'Failed to upload master timetable.',
            code: err.code || 'UPLOAD_FAILED'
        });
    }
});

/**
 * POST /api/uploads/faculty-timetable
 * Faculty only. Uploads personal timetable for authenticated faculty member.
 */
router.post('/faculty-timetable', fileUploadHandler, async (req, res) => {
    try {
        if (!req.session) {
            return res.status(401).json({ error: 'Sign in to use this endpoint.', code: 'UNAUTHENTICATED' });
        }

        const role = req.session.role;
        if (role !== 'faculty') {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
            }
            return res.status(403).json({
                error: 'Only faculty members can upload personal timetables here.',
                code: 'FORBIDDEN'
            });
        }

        const sessionDept = String(req.session.department || '').toUpperCase();
        const sessionFaculty = req.session.facultyName || req.session.name || req.session.username;
        const sessionFacultyId = req.session.facultyId || sessionFaculty;

        // Reject client-supplied impersonation attempts
        const clientFaculty = req.body && (req.body.faculty_id || req.body.faculty || req.body.facultyName || req.body.username);
        if (clientFaculty && String(clientFaculty).trim().toUpperCase() !== String(sessionFaculty).toUpperCase() &&
            clientFaculty !== String(req.session.userId) && clientFaculty !== String(sessionFacultyId)) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
            }
            return res.status(403).json({
                error: `You cannot upload a timetable for another faculty member.`,
                code: 'FACULTY_UPLOAD_MISMATCH'
            });
        }

        const clientDept = req.body && (req.body.department || req.body.branch_id || req.body.branchCode);
        if (clientDept && String(clientDept).trim().toUpperCase() !== sessionDept) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
            }
            return res.status(403).json({
                error: `You cannot upload a timetable for another branch.`,
                code: 'BRANCH_UPLOAD_MISMATCH'
            });
        }

        validateUploadedFile(req.file);

        const uploadRecord = await saveUploadRecord({
            uploadId: req._uploadId,
            originalFilename: req.file.originalname,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            storagePath: req.file.path,
            uploaderUserId: req.session.userId || req.session.username,
            facultyId: sessionFaculty,
            branchId: sessionDept,
            departmentCode: sessionDept,
            uploadType: 'FACULTY_TIMETABLE',
            status: 'UPLOADED'
        });

        // Trigger asynchronous n8n webhook if configured
        dispatchN8nWebhook(uploadRecord);

        return res.status(201).json({
            success: true,
            uploadId: uploadRecord.uploadId,
            originalFilename: uploadRecord.originalFilename,
            fileType: uploadRecord.fileType,
            fileSize: uploadRecord.fileSize,
            uploadType: uploadRecord.uploadType,
            department: uploadRecord.departmentCode,
            faculty: sessionFaculty,
            status: uploadRecord.status,
            createdAt: uploadRecord.createdAt,
            message: 'Timetable uploaded. Processing will be available in the next step.'
        });
    } catch (err) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        return res.status(err.status || 500).json({
            error: err.message || 'Failed to upload faculty timetable.',
            code: err.code || 'UPLOAD_FAILED'
        });
    }
});

/**
 * GET /api/uploads/:uploadId
 * Retrieve metadata of an upload, strictly isolated by branch and role.
 */
router.get('/:uploadId', async (req, res) => {
    try {
        if (!req.session) {
            return res.status(401).json({ error: 'Sign in to use this endpoint.', code: 'UNAUTHENTICATED' });
        }

        const uploadId = req.params.uploadId;
        const upload = await getUploadRecord(uploadId);

        if (!upload) {
            return res.status(404).json({ error: 'Upload not found.', code: 'NOT_FOUND' });
        }

        const sessionDept = String(req.session.department || '').toUpperCase();
        if (upload.departmentCode && upload.departmentCode !== sessionDept) {
            return res.status(403).json({
                error: 'Cross-branch upload access is forbidden.',
                code: 'FORBIDDEN'
            });
        }

        // If faculty, verify they own the upload
        if (req.session.role === 'faculty') {
            const sessionFac = String(req.session.facultyName || req.session.name || req.session.username).toUpperCase();
            if (upload.facultyId && String(upload.facultyId).toUpperCase() !== sessionFac) {
                return res.status(403).json({
                    error: 'Access forbidden: you can only view your own uploads.',
                    code: 'FORBIDDEN'
                });
            }
        }

        // Return safe metadata (never reveal full server disk storage path)
        return res.json({
            uploadId: upload.uploadId,
            originalFilename: upload.originalFilename,
            fileType: upload.fileType,
            fileSize: upload.fileSize,
            department: upload.departmentCode,
            faculty: upload.facultyId || null,
            uploadType: upload.uploadType,
            status: upload.status,
            createdAt: upload.createdAt
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * GET /api/uploads
 * List recent uploads for the authenticated branch (and faculty if faculty).
 */
router.get('/', async (req, res) => {
    try {
        if (!req.session) {
            return res.status(401).json({ error: 'Sign in to use this endpoint.', code: 'UNAUTHENTICATED' });
        }

        const sessionDept = String(req.session.department || '').toUpperCase();
        const filters = { department: sessionDept };

        if (req.session.role === 'faculty') {
            filters.facultyId = req.session.facultyName || req.session.name || req.session.username;
        }

        const records = await listUploadRecords(filters);
        const safeRecords = records.map(u => ({
            uploadId: u.uploadId,
            originalFilename: u.originalFilename,
            fileType: u.fileType,
            fileSize: u.fileSize,
            department: u.departmentCode,
            faculty: u.facultyId || null,
            uploadType: u.uploadType,
            status: u.status,
            createdAt: u.createdAt
        }));

        return res.json({ uploads: safeRecords });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

module.exports = router;
