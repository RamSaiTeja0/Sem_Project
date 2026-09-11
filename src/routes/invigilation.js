/**
 * Exam Invigilation Routes (Phase B7.3).
 *
 * WORKFLOW A (HOS Direct Assignment):
 *   POST   /api/invigilation                 Create active invigilation assignments directly (HOS only)
 *   GET    /api/invigilation                 List active invigilation assignments for HOS branch (HOS only)
 *   DELETE /api/invigilation/:id             Cancel / delete active invigilation assignment (HOS only)
 *
 * WORKFLOW B (Faculty Request):
 *   POST   /api/invigilation/requests        Submit invigilation request (Faculty only)
 *   GET    /api/invigilation/requests        List branch requests (HOS only)
 *   POST   /api/invigilation/requests/:id/approve  Approve request & activate invigilations (HOS only)
 *   POST   /api/invigilation/requests/:id/reject   Reject request (HOS only)
 *
 * FACULTY VIEW:
 *   GET    /api/invigilation/my              Read-only view of own assignments & requests (Faculty)
 *
 * UTILITY:
 *   GET    /api/invigilation/periods         Dynamic list of configured timetable periods
 */
const express = require('express');
const router = express.Router();
const invigilation = require('../data/invigilation');

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
 * HOS / Coordinator / Admin authorization guard.
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
            error: 'Faculty members cannot perform HOS invigilation management actions.',
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
 * GET /api/invigilation/periods — Dynamic configured timetable periods.
 */
router.get('/periods', (req, res) => {
    try {
        const periods = invigilation.getConfiguredPeriods();
        res.json({ periods });
    } catch (err) {
        res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * GET /api/invigilation/my — Read-only self view for authenticated faculty member.
 */
router.get('/my', requireAuth, async (req, res) => {
    try {
        const data = await invigilation.getMyInvigilation(req.session);
        res.json({
            readOnly: true,
            facultyName: data.facultyName,
            assignments: data.assignments,
            requests: data.requests
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/invigilation/requests — Faculty submits an invigilation request.
 */
router.post('/requests', requireAuth, async (req, res) => {
    try {
        const { date, periods, reason } = req.body || {};
        if (!date) {
            return res.status(400).json({
                error: 'Exam date is required (YYYY-MM-DD).',
                code: 'MISSING_DATE'
            });
        }
        if (!periods || (Array.isArray(periods) && periods.length === 0)) {
            return res.status(400).json({
                error: 'At least one period must be selected.',
                code: 'MISSING_PERIODS'
            });
        }

        const request = await invigilation.submitInvigilationRequest({
            date,
            periods,
            reason,
            sessionUser: req.session
        });

        res.status(201).json({
            success: true,
            request
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR',
            conflict: err.conflict || null
        });
    }
});

/**
 * GET /api/invigilation/requests — HOS views invigilation requests for own branch.
 */
router.get('/requests', requireHOS, async (req, res) => {
    try {
        const branchCode = req.session.department;
        const status = req.query.status || null;
        const requests = await invigilation.listBranchRequests(branchCode, status);

        res.json({
            branch: branchCode,
            count: requests.length,
            requests
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/invigilation/requests/:id/approve — HOS approves invigilation request.
 */
router.post('/requests/:id/approve', requireHOS, async (req, res) => {
    try {
        const result = await invigilation.approveRequest(req.params.id, req.session);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR',
            conflict: err.conflict || null
        });
    }
});

/**
 * POST /api/invigilation/requests/:id/reject — HOS rejects invigilation request.
 */
router.post('/requests/:id/reject', requireHOS, async (req, res) => {
    try {
        const { rejectionReason, reason } = req.body || {};
        const result = await invigilation.rejectRequest(req.params.id, rejectionReason || reason || null, req.session);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/invigilation — Workflow A: HOS directly assigns invigilation.
 */
router.post('/', requireHOS, async (req, res) => {
    try {
        const { facultyId, faculty, facultyName, date, examDate, periods, period, notes, details } = req.body || {};
        const facultyIdentifier = facultyId || faculty || facultyName;
        if (!facultyIdentifier) {
            return res.status(400).json({
                error: 'Faculty identifier is required.',
                code: 'MISSING_FACULTY'
            });
        }
        const targetDate = date || examDate;
        if (!targetDate) {
            return res.status(400).json({
                error: 'Date is required (YYYY-MM-DD).',
                code: 'MISSING_DATE'
            });
        }

        const rawPeriods = periods != null ? periods : period;
        if (rawPeriods == null || (Array.isArray(rawPeriods) && rawPeriods.length === 0)) {
            return res.status(400).json({
                error: 'At least one period must be selected.',
                code: 'MISSING_PERIODS'
            });
        }

        const assignments = await invigilation.createDirectAssignment({
            facultyIdentifier,
            date: targetDate,
            periods: rawPeriods,
            notes: notes || details || null,
            sessionUser: req.session
        });

        res.status(201).json({
            success: true,
            assignments
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR',
            conflict: err.conflict || null
        });
    }
});

/**
 * GET /api/invigilation — HOS lists active invigilation assignments for own branch.
 */
router.get('/', requireHOS, async (req, res) => {
    try {
        const branchCode = req.session.department;
        const { date, period } = req.query || {};
        const assignments = await invigilation.listBranchAssignments(branchCode, date, period);

        res.json({
            branch: branchCode,
            count: assignments.length,
            assignments
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * DELETE /api/invigilation/:id — HOS deletes/cancels an active invigilation assignment.
 */
router.delete('/:id', requireHOS, async (req, res) => {
    try {
        const result = await invigilation.deleteAssignment(req.params.id, req.session);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

module.exports = router;
