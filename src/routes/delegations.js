/**
 * HOD Delegation / Acting HOD Routes (Phase B9).
 *
 *   GET    /api/delegations              List all delegations for authenticated branch
 *   GET    /api/delegations/active       Get current active delegation for branch
 *   POST   /api/delegations              Create new delegation (Permanent HOD only)
 *   POST   /api/delegations/:id/cancel   Cancel active/future delegation (Permanent HOD only)
 *   DELETE /api/delegations/:id          Cancel active/future delegation (Permanent HOD only)
 */
const express = require('express');
const router = express.Router();
const delegations = require('../data/delegations');

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
 * Strict Permanent HOD guard for delegation management.
 * Acting HOD is explicitly FORBIDDEN from creating or cancelling delegations.
 */
function requirePermanentHOS(req, res, next) {
    if (!req.session || !req.session.username) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in.',
            code: 'UNAUTHENTICATED'
        });
    }

    if (req.session.role === 'faculty') {
        return res.status(403).json({
            error: 'Acting HOD cannot manage HOD delegations. Only the permanent Head of Department (HOD) can assign or cancel delegations.',
            code: 'FORBIDDEN'
        });
    }

    if (!['hos', 'coordinator', 'admin'].includes(req.session.role)) {
        return res.status(403).json({
            error: 'This action requires permanent Head of Department (HOD) role.',
            code: 'FORBIDDEN'
        });
    }

    next();
}

/**
 * GET /api/delegations — List delegations for authenticated branch.
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const branch = req.session.department;
        const list = await delegations.listDelegations(branch, req.session);
        res.json({
            count: list.length,
            branch,
            delegations: list
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/delegations/active — Get current active delegation for branch/faculty.
 */
router.get('/active', requireAuth, async (req, res) => {
    try {
        const branch = req.session.department;
        const dateStr = req.query.date || null;
        const active = await delegations.getActiveDelegationForBranch(branch, dateStr);
        const myActive = await delegations.getActiveDelegationForFaculty(req.session, dateStr);

        res.json({
            branch,
            date: dateStr || delegations.getTodayDateString(),
            branchActiveDelegation: active,
            myActiveDelegation: myActive,
            isActingHOD: Boolean(myActive)
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/delegations/candidates — Get active faculty members with login accounts eligible for Acting HOD.
 * Permanent HOD only.
 */
router.get('/candidates', requirePermanentHOS, async (req, res) => {
    try {
        const branch = req.session.department;
        const candidates = await delegations.listActingHODCandidates(req.session);
        res.json({
            count: candidates.length,
            branch,
            candidates
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/delegations — Create a new HOD delegation.
 * Permanent HOD only.
 */
router.post('/', requirePermanentHOS, async (req, res) => {
    try {
        const result = await delegations.createDelegation(req.body || {}, req.session);
        res.status(201).json({
            success: true,
            message: `Acting HOD successfully assigned to ${result.actingFacultyName} from ${result.startDate} to ${result.endDate}.`,
            delegation: result
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'DELEGATION_FAILED'
        });
    }
});

/**
 * POST /api/delegations/:id/cancel — Cancel an active or future delegation.
 * Permanent HOD only.
 */
router.post('/:id/cancel', requirePermanentHOS, async (req, res) => {
    try {
        const result = await delegations.cancelDelegation(req.params.id, req.session);
        res.json({
            success: true,
            message: 'Delegation cancelled successfully.',
            ...result
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'CANCELLATION_FAILED'
        });
    }
});

/**
 * DELETE /api/delegations/:id — Cancel an active or future delegation.
 * Permanent HOD only.
 */
router.delete('/:id', requirePermanentHOS, async (req, res) => {
    try {
        const result = await delegations.cancelDelegation(req.params.id, req.session);
        res.json({
            success: true,
            message: 'Delegation cancelled successfully.',
            ...result
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'CANCELLATION_FAILED'
        });
    }
});

/**
 * GET /api/delegations/transfers — List historical role transfers and departures for authenticated branch.
 */
router.get('/transfers', requireAuth, async (req, res) => {
    try {
        const branch = req.session.department;
        const list = await delegations.listHODTransfers(branch, req.session);
        res.json({
            count: list.length,
            branch,
            transfers: list
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/delegations/transfer-role — Permanent HOD role transfer (Outgoing HOD becomes Faculty).
 * Permanent HOD only.
 */
router.post('/transfer-role', requirePermanentHOS, async (req, res) => {
    try {
        const result = await delegations.transferHODRole(req.body || {}, req.session);
        res.json({
            success: true,
            message: `HOD role successfully transferred to ${result.newHOD.name}. You are now registered as Faculty.`,
            ...result
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'ROLE_TRANSFER_FAILED'
        });
    }
});

/**
 * POST /api/delegations/leave-college — HOD Leaving College (Authority transferred, outgoing HOD deactivated).
 * Permanent HOD only.
 */
router.post('/leave-college', requirePermanentHOS, async (req, res) => {
    try {
        const result = await delegations.hodLeaveCollege(req.body || {}, req.session);
        res.json({
            success: true,
            message: `HOD role transferred to ${result.newHOD.name}. Outgoing HOD access has been revoked and deactivated.`,
            ...result
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'LEAVING_COLLEGE_FAILED'
        });
    }
});

module.exports = router;

