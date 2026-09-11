/**
 * Faculty Registration Requests Routes (Phase B7.1).
 *
 *   POST /api/faculty-requests              Submit public faculty registration request
 *   GET  /api/faculty-requests/branches     Public list of registered branches
 *   GET  /api/faculty-requests              List requests for authenticated HOS branch
 *   GET  /api/faculty-requests/:id          View single request details (own branch only)
 *   POST /api/faculty-requests/:id/approve  Approve request -> creates faculty user account
 *   POST /api/faculty-requests/:id/reject   Reject request -> no account created
 */
const express = require('express');
const router = express.Router();

const facultyRequests = require('../data/facultyRequests');
const { getRegisteredBranchCodes, getBranch } = require('../data/departments');

/**
 * Guard for HOS-only request management endpoints.
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
            error: 'Faculty members cannot access registration requests.',
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
 * GET /api/faculty-requests/branches — Public list of registered branches.
 */
router.get('/branches', (req, res) => {
    try {
        const codes = getRegisteredBranchCodes();
        const list = codes.map(code => {
            const b = getBranch(code);
            return {
                code: b.code || code,
                name: b.name || code
            };
        });
        res.json({ count: list.length, branches: list });
    } catch (err) {
        res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * POST /api/faculty-requests — Submit a public faculty registration request.
 */
router.post('/', async (req, res) => {
    try {
        const created = await facultyRequests.submitRequest(req.body || {});
        res.status(201).json({
            success: true,
            message: `Registration request submitted successfully for Head of Section (${created.branchCode}) review.`,
            request: created
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'REQUEST_FAILED'
        });
    }
});

/**
 * GET /api/faculty-requests — List requests for authenticated HOS branch.
 */
router.get('/', requireHOS, async (req, res) => {
    try {
        const branchCode = req.session.department;
        const statusFilter = req.query.status || null;
        const list = await facultyRequests.listRequests(branchCode, statusFilter);
        res.json({
            count: list.length,
            branch: branchCode,
            requests: list
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/faculty-requests/:id — View request details (own branch only).
 */
router.get('/:id', requireHOS, async (req, res) => {
    try {
        const record = await facultyRequests.getRequestById(req.params.id);
        if (!record) {
            return res.status(404).json({
                error: `Registration request "${req.params.id}" not found.`,
                code: 'NOT_FOUND'
            });
        }

        const hosDept = String(req.session.department || '').toUpperCase();
        const reqDept = String(record.branchCode || record.branch_code).toUpperCase();

        if (hosDept !== reqDept) {
            return res.status(403).json({
                error: `Cross-branch access forbidden. You are HOS of ${hosDept}, but this request belongs to ${reqDept}.`,
                code: 'FORBIDDEN'
            });
        }

        res.json({ request: facultyRequests.sanitize(record) });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/faculty-requests/:id/approve — Approve request and create faculty account.
 */
router.post('/:id/approve', requireHOS, async (req, res) => {
    try {
        const result = await facultyRequests.approveRequest(req.params.id, req.session);
        res.json(result);
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'APPROVAL_FAILED'
        });
    }
});

/**
 * POST /api/faculty-requests/:id/reject — Reject request with optional reason.
 */
router.post('/:id/reject', requireHOS, async (req, res) => {
    try {
        const reason = req.body && (req.body.reason || req.body.rejectionReason);
        const result = await facultyRequests.rejectRequest(req.params.id, req.session, reason);
        res.json(result);
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'REJECTION_FAILED'
        });
    }
});

module.exports = router;
