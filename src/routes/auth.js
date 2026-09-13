/**
 * Authentication routes.
 *
 *   GET  /api/auth/session   who is signed in, and whether sign-in is enforced
 *   GET  /api/auth/status    setup status: hasHOS, branch, allowHOSCreation
 *   POST /api/auth/register  create HOS or Faculty account (hashes password, sets session)
 *   POST /api/auth/login     { username, password } -> sets the session cookie
 *   GET  /api/auth/profile   authenticated user's full profile
 *   PUT  /api/auth/profile   update permitted profile fields (phone, subjects)
 *   POST /api/auth/logout    clears it
 */
const express = require('express');
const router = express.Router();

const config = require('../config');
const users = require('../data/users');
const { getBranch, getRegisteredBranchCodes } = require('../data/departments');
const facultyRequestsRouter = require('./facultyRequests');

router.use('/faculty-requests', facultyRequestsRouter);

function publicUser(session) {
    if (!session) return null;
    return {
        id: session.id,
        username: session.username,
        name: session.name,
        phone: session.phone || null,
        role: session.role,
        department: session.department,
        branchName: session.branchName || session.department,
        subjects: Array.isArray(session.subjects) ? session.subjects : [],
        facultyName: session.facultyName || null,
        facultyId: session.facultyId || null
    };
}

router.get('/session', (req, res) => {
    res.json({
        authenticated: Boolean(req.session),
        authRequired: config.authRequired,
        user: publicUser(req.session)
    });
});

router.get('/status', (req, res) => {
    const isAuth = Boolean(req.session);
    const isHosSession = isAuth && (req.session.role === 'hos' || req.session.role === 'coordinator');
    const branchCode = isAuth ? req.session.department : null;
    const branch = branchCode ? getBranch(branchCode) : (isAuth ? getBranch() : null);

    // If an authenticated HOS is requesting status, provide their active branch.
    // For unauthenticated public visitors, branch is empty so registration fields are never prefilled.
    res.json({
        authenticated: isAuth,
        isHOS: isHosSession,
        hasHOS: users.hasHOS(),
        allowHOSCreation: !isHosSession,
        branch: (branch && branch.configured) ? {
            configured: true,
            code: branch.code,
            name: branch.name,
            academicYear: branch.academicYear,
            semester: branch.semester,
            totalSemesters: branch.totalSemesters || 6
        } : {
            configured: false,
            code: '',
            name: '',
            academicYear: '',
            semester: null,
            totalSemesters: 6
        },
        userCount: users.list(branchCode).length
    });
});

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

router.get('/accounts', (req, res) => {
    const branchCode = req.session ? req.session.department : (req.query.branch || null);
    const hosUser = users.findHOSByBranch(branchCode);
    res.json({
        note: 'Account directory for the branch.',
        branch: branchCode,
        hos: hosUser ? { username: hosUser.username, name: hosUser.name, role: hosUser.role, department: hosUser.department } : null,
        accounts: users.list(branchCode).map(u => ({
            username: u.username,
            name: u.name,
            role: u.role,
            department: u.department,
            phone: u.phone || null,
            subjects: u.subjects || []
        }))
    });
});

router.post('/register', async (req, res) => {
    try {
        const user = await users.register(req.body || {}, req.session);
        // If an already authenticated HOS is creating a faculty account, do not overwrite their session
        const isHosCreating = req.session && (req.session.role === 'hos' || req.session.role === 'coordinator');
        if (!isHosCreating) {
            res.startSession(user);
        }
        res.status(201).json({
            authenticated: true,
            user: publicUser(user)
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'REGISTRATION_FAILED'
        });
    }
});

router.post('/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({
            error: 'Enter both a username and a password.', code: 'MISSING_CREDENTIALS'
        });
    }

    try {
        const user = users.authenticate(username, password);
        if (!user) {
            return res.status(401).json({
                error: 'Incorrect username or password.', code: 'INVALID_CREDENTIALS'
            });
        }

        res.startSession(user);
        res.json({ authenticated: true, user: publicUser(user) });
    } catch (err) {
        return res.status(err.status || 401).json({
            error: err.message,
            code: err.code || 'INVALID_CREDENTIALS'
        });
    }
});

router.get('/profile', (req, res) => {
    if (!req.session) {
        return res.status(401).json({ error: 'Sign in to access your profile.', code: 'UNAUTHENTICATED' });
    }
    const profile = users.getProfile(req.session.username);
    res.json({ profile: publicUser(profile || req.session) });
});

router.put('/profile', async (req, res) => {
    if (!req.session) {
        return res.status(401).json({ error: 'Sign in to update your profile.', code: 'UNAUTHENTICATED' });
    }
    try {
        const updated = await users.updateProfile(req.session.username, req.body || {});
        if (updated.phone) req.session.phone = updated.phone;
        if (updated.subjects) req.session.subjects = updated.subjects;
        if (updated.name) req.session.name = updated.name;
        res.json({ profile: publicUser(updated) });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message, code: err.code || 'PROFILE_UPDATE_FAILED' });
    }
});

router.post('/logout', (req, res) => {
    res.endSession();
    res.json({ authenticated: false, user: null });
});

router.use((req, res) => {
    res.status(404).json({
        error: `Unknown auth endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND'
    });
});

module.exports = router;
