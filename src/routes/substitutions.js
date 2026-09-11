/**
 * Faculty-to-Faculty Substitution Routes (Phase B7.5).
 *
 * WORKFLOW:
 *   POST   /api/substitutions/requests       Faculty A creates a substitution request (Faculty only)
 *   GET    /api/substitutions/candidates     Faculty A finds FREE substitute candidates (Faculty only)
 *   GET    /api/substitutions/vacant-periods Faculty A views their vacant teaching periods (Faculty only)
 *   GET    /api/substitutions/my             Faculty views their sent/active substitutions (Faculty only)
 *   GET    /api/substitutions/incoming       Faculty B views incoming pending requests (Faculty only)
 *   POST   /api/substitutions/:id/accept     Faculty B accepts request with fresh availability check (Faculty B only)
 *   POST   /api/substitutions/:id/reject     Faculty B rejects request (Faculty B only)
 *   DELETE /api/substitutions/:id            Faculty A cancels pending request (Faculty A only)
 *
 * HOS OVERSIGHT (READ-ONLY):
 *   GET    /api/substitutions                HOS views branch substitutions (HOS only, read-only)
 *
 * STRICT GOVERNANCE RULES:
 *   - Faculty-to-faculty substitution ONLY.
 *   - HOS CANNOT create, assign, approve, or accept substitutions.
 *   - Original timetable entries remain 100% UNTOUCHED.
 *   - Real-time availability revalidation at acceptance time.
 *   - Double-booking prevention enforced.
 */
const express = require('express');
const router = express.Router();
const substitutions = require('../data/substitutions');

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
 * Faculty-only authorization guard.
 */
function requireFaculty(req, res, next) {
    if (!req.session || !req.session.username) {
        return res.status(401).json({
            error: 'Authentication required. Please sign in as faculty.',
            code: 'UNAUTHENTICATED'
        });
    }

    if (req.session.role !== 'faculty') {
        return res.status(403).json({
            error: 'This action is reserved for faculty members only. HOS cannot create, accept, or manage faculty substitutions.',
            code: 'FORBIDDEN'
        });
    }

    next();
}

/**
 * HOS-only authorization guard (read-only branch view).
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
            error: 'Faculty members cannot access the HOS substitution overview. Use /api/substitutions/my or /incoming.',
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
 * GET /api/substitutions/candidates
 * Returns available FREE candidates for Faculty A for a vacant date + period.
 * Query: date=YYYY-MM-DD, period=1..7, className=CSE-A (optional)
 */
router.get('/candidates', requireFaculty, async (req, res) => {
    try {
        const { date, period, className, class: cls } = req.query;
        const result = await substitutions.getCandidates({
            date,
            period,
            className: className || cls,
            sessionUser: req.session
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/substitutions/vacant-periods
 * Returns teaching slots for Faculty A on dates where they are marked ABSENT.
 * Query: date=YYYY-MM-DD (optional, if omitted checks today/all)
 */
router.get('/vacant-periods', requireFaculty, async (req, res) => {
    try {
        const result = await substitutions.getMyVacantPeriods({
            date: req.query.date,
            sessionUser: req.session
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/substitutions/my
 * Returns outgoing and accepted substitutions for the authenticated faculty member.
 */
router.get('/my', requireFaculty, async (req, res) => {
    try {
        const result = await substitutions.getMySubstitutions(req.session);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/substitutions/incoming
 * Returns incoming pending substitution requests directed to Faculty B.
 */
router.get('/incoming', requireFaculty, async (req, res) => {
    try {
        const result = await substitutions.getIncomingSubstitutions(req.session);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/substitutions/requests
 * Faculty A creates a substitution request directed to Faculty B.
 * Body: { date, period, className, subject, substituteFacultyId, substituteFacultyName }
 */
router.post('/requests', requireFaculty, async (req, res) => {
    try {
        const { date, period, className, subject, substituteFacultyId, substituteFacultyName } = req.body || {};
        const request = await substitutions.createRequest({
            date,
            period,
            className,
            subject,
            substituteFacultyId,
            substituteFacultyName,
            sessionUser: req.session
        });
        res.status(201).json({
            success: true,
            message: 'Substitution request sent successfully.',
            request
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/substitutions/:id/accept
 * Faculty B accepts the substitution request.
 * Enforces real-time availability revalidation and double-booking checks.
 */
router.post('/:id/accept', requireFaculty, async (req, res) => {
    try {
        const request = await substitutions.acceptRequest(req.params.id, req.session);
        res.json({
            success: true,
            message: 'Substitution accepted successfully.',
            request
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * POST /api/substitutions/:id/reject
 * Faculty B rejects the substitution request.
 * Body: { reason } (optional)
 */
router.post('/:id/reject', requireFaculty, async (req, res) => {
    try {
        const { reason } = req.body || {};
        const request = await substitutions.rejectRequest(req.params.id, reason, req.session);
        res.json({
            success: true,
            message: 'Substitution request rejected.',
            request
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * DELETE /api/substitutions/:id
 * Faculty A cancels their pending substitution request.
 */
router.delete('/:id', requireFaculty, async (req, res) => {
    try {
        const result = await substitutions.cancelRequest(req.params.id, req.session);
        res.json({
            success: true,
            message: 'Substitution request cancelled.',
            id: result.id
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

/**
 * GET /api/substitutions
 * HOS / Coordinator / Admin read-only branch overview.
 * Returns history and active substitutions for the HOS branch.
 * Query: branch (optional for admin), date (optional), status (optional)
 */
router.get('/', requireHOS, async (req, res) => {
    try {
        const { branch, date, status } = req.query;
        const result = await substitutions.getBranchSubstitutions({
            branch,
            date,
            status,
            sessionUser: req.session
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message,
            code: err.code || 'SERVER_ERROR'
        });
    }
});

module.exports = router;
