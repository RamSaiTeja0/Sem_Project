/**
 * Faculty Attendance Routes (Phase B7.2).
 *
 *   GET    /api/attendance?date=YYYY-MM-DD   List faculty attendance for HOS branch (HOS only)
 *   POST   /api/attendance                   Mark faculty ABSENT or PRESENT (HOS only)
 *   PUT    /api/attendance                   Update faculty attendance (HOS only)
 *   DELETE /api/attendance/:id               Remove attendance record, restoring default PRESENT (HOS only)
 *   GET    /api/attendance/my                Read-only self-view of attendance history for signed-in faculty
 */
const express = require('express');
const router = express.Router();
const attendance = require('../data/attendance');

/**
 * Authentication guard.
 */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.username) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in.',
            code: 'UNAUTHENTICATED'
        });
    }
    next();
}

/**
 * Guard for HOS-only attendance management operations.
 */
function requireHOS(req, res, next) {
    if (!req.session || !req.session.username) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in.',
            code: 'UNAUTHENTICATED'
        });
    }

    if (req.session.role === 'faculty') {
        return res.status(403).json({
            error: 'Faculty members cannot manage faculty attendance.',
            code: 'FORBIDDEN'
        });
    }

    if (!['hos', 'coordinator', 'admin'].includes(req.session.role)) {
        return res.status(403).json({
            error: 'This action requires Head of Section (HOS) or Administrator role.',
            code: 'FORBIDDEN'
        });
    }

    next();
}

/**
 * GET /api/attendance/my — Read-only self-view for signed-in faculty member.
 */
router.get('/my', requireAuth, async (req, res) => {
    try {
        const result = await attendance.getMyAttendance(req.session);
        res.json({
            readOnly: true,
            facultyName: result.facultyName,
            records: result.records
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/attendance?date=YYYY-MM-DD — List branch faculty attendance for date.
 */
router.get('/', requireHOS, async (req, res) => {
    try {
        const date = req.query.date;
        if (!date) {
            return res.status(400).json({
                error: 'Date query parameter is required (format: YYYY-MM-DD).',
                code: 'INVALID_DATE'
            });
        }

        const parsed = attendance.parseDateString(date);
        if (!parsed) {
            return res.status(400).json({
                error: `Invalid date format "${date}". Expected YYYY-MM-DD.`,
                code: 'INVALID_DATE'
            });
        }

        const branchCode = req.session.department;
        const facultyList = await attendance.listBranchAttendance(branchCode, date);

        res.json({
            date: parsed.dateStr,
            dayOfWeek: parsed.dayOfWeek,
            branch: branchCode,
            count: facultyList.length,
            faculty: facultyList
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/attendance — Mark faculty ABSENT or PRESENT on date.
 */
router.post('/', requireHOS, async (req, res) => {
    try {
        const body = req.body || {};
        const facultyIdentifier = body.facultyId || body.id || body.faculty || body.facultyName;
        if (!facultyIdentifier) {
            return res.status(400).json({
                error: 'Faculty ID or name is required.',
                code: 'MISSING_FACULTY'
            });
        }

        const date = body.date;
        if (!date) {
            return res.status(400).json({
                error: 'Date is required (format: YYYY-MM-DD).',
                code: 'INVALID_DATE'
            });
        }

        const status = body.status ? String(body.status).toUpperCase() : 'ABSENT';

        const record = await attendance.markAttendance({
            facultyIdentifier,
            date,
            status,
            sessionUser: req.session
        });

        res.status(200).json({
            success: true,
            message: `Faculty marked ${record.status}.`,
            record
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'ATTENDANCE_FAILED'
        });
    }
});

/**
 * PUT /api/attendance — Update faculty attendance on date.
 */
router.put('/', requireHOS, async (req, res) => {
    try {
        const body = req.body || {};
        const facultyIdentifier = body.facultyId || body.id || body.faculty || body.facultyName;
        if (!facultyIdentifier) {
            return res.status(400).json({
                error: 'Faculty ID or name is required.',
                code: 'MISSING_FACULTY'
            });
        }

        const date = body.date;
        if (!date) {
            return res.status(400).json({
                error: 'Date is required (format: YYYY-MM-DD).',
                code: 'INVALID_DATE'
            });
        }

        const status = body.status ? String(body.status).toUpperCase() : 'ABSENT';

        const record = await attendance.markAttendance({
            facultyIdentifier,
            date,
            status,
            sessionUser: req.session
        });

        res.status(200).json({
            success: true,
            message: `Faculty attendance updated to ${record.status}.`,
            record
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'ATTENDANCE_FAILED'
        });
    }
});

/**
 * DELETE /api/attendance/:id — Delete attendance record (marking faculty default PRESENT).
 */
router.delete('/:id', requireHOS, async (req, res) => {
    try {
        const result = await attendance.deleteAttendance(req.params.id, req.session);
        res.json({
            success: true,
            message: 'Faculty attendance record removed (marked PRESENT).',
            id: result.id,
            status: result.status
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'DELETE_FAILED'
        });
    }
});

module.exports = router;
