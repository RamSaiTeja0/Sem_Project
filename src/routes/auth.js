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
const db = require('../db/pool');
const repository = require('../db/repository');
const users = require('../data/users');
const { getBranch, getRegisteredBranchCodes } = require('../data/departments');
const delegations = require('../data/delegations');
const facultyRequestsRouter = require('./facultyRequests');

router.use('/faculty-requests', facultyRequestsRouter);

async function buildPublicUser(session) {
    if (!session) return null;
    let dept = session.department || '';
    let branchName = session.branchName || dept || '';
    if (!dept && session.username) {
        try {
            const userInDb = await users.findByUsernameAsync(session.username);
            if (userInDb && userInDb.department) {
                dept = userInDb.department;
                branchName = userInDb.branchName || dept;
            }
        } catch (_) {}
    }
    if (!dept && (session.role === 'hos' || session.role === 'coordinator' || session.role === 'admin')) {
        try {
            const br = getBranch();
            if (br && br.code) {
                dept = br.code;
                branchName = br.name || dept;
            }
        } catch (_) {}
    }
    const base = {
        id: session.id,
        username: session.username,
        name: session.name,
        phone: session.phone || null,
        role: session.role,
        department: dept,
        branchName: branchName,
        subjects: Array.isArray(session.subjects) ? session.subjects : [],
        facultyName: session.facultyName || (session.role === 'faculty' ? session.name : null),
        facultyId: session.facultyId || null,
        isActingHOD: false,
        actingHOD: null
    };

    if (session.role === 'faculty') {
        try {
            const active = await delegations.getActiveDelegationForFaculty(session);
            if (active) {
                base.isActingHOD = true;
                base.actingHOD = {
                    delegationId: active.id,
                    branch: active.branchCode,
                    startDate: active.startDate,
                    endDate: active.endDate,
                    hodName: active.hodName,
                    hodUsername: active.hodUsername
                };
            }
        } catch (_) {}
    }

    return base;
}

function publicUser(session) {
    if (!session) return null;
    let dept = session.department || '';
    let branchName = session.branchName || dept || '';
    if (!dept && (session.role === 'hos' || session.role === 'coordinator' || session.role === 'admin')) {
        try {
            const br = getBranch();
            if (br && br.code) {
                dept = br.code;
                branchName = br.name || dept;
            }
        } catch (_) {}
    }
    return {
        id: session.id,
        username: session.username,
        name: session.name,
        phone: session.phone || null,
        role: session.role,
        department: dept,
        branchName: branchName,
        subjects: Array.isArray(session.subjects) ? session.subjects : [],
        facultyName: session.facultyName || (session.role === 'faculty' ? session.name : null),
        facultyId: session.facultyId || null,
        isActingHOD: Boolean(session.isActingHOD),
        actingHOD: session.actingHOD || null
    };
}

router.get('/session', async (req, res) => {
    const user = await buildPublicUser(req.session);
    res.json({
        authenticated: Boolean(req.session),
        authRequired: config.authRequired,
        user
    });
});

router.get('/status', async (req, res) => {
    const isAuth = Boolean(req.session);
    const isHosSession = isAuth && (req.session.role === 'hos' || req.session.role === 'coordinator');
    let isActingHOD = false;
    if (isAuth && req.session.role === 'faculty') {
        try {
            const active = await delegations.getActiveDelegationForFaculty(req.session);
            isActingHOD = Boolean(active);
        } catch (_) {}
    }
    const branchCode = isAuth ? req.session.department : null;
    const branch = branchCode ? getBranch(branchCode) : (isAuth ? getBranch() : null);

    // If an authenticated HOS is requesting status, provide their active branch.
    // For unauthenticated public visitors, branch is empty so registration fields are never prefilled.
    res.json({
        authenticated: isAuth,
        isHOS: isHosSession || isActingHOD,
        isActingHOD,
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

router.get('/accounts', async (req, res) => {
    const branchCode = req.session ? req.session.department : (req.query.branch || null);
    if (db.isConfigured()) {
        try {
            const allUsers = await repository.loadAllUsers();
            users.syncFromDatabase(allUsers);
        } catch (_) {}
    }
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
        // If an already authenticated HOS or Acting HOD is creating a faculty account, do not overwrite their session
        const isHosCreating = req.session && (req.session.role === 'hos' || req.session.role === 'coordinator' || await delegations.isAuthorizedHOS(req.session));
        if (!isHosCreating) {
            res.startSession(user);
        }
        const pub = await buildPublicUser(user);
        res.status(201).json({
            authenticated: true,
            user: pub
        });
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message,
            code: err.code || 'REGISTRATION_FAILED'
        });
    }
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({
            error: 'Enter both a username and a password.', code: 'MISSING_CREDENTIALS'
        });
    }

    try {
        const normUser = String(username).trim().toLowerCase();
        const user = await users.authenticateAsync(username, password);
        if (!user) {
            console.log(`[AUTH-DIAGNOSTIC] PID:${process.pid} POST /api/auth/login: user="${normUser}", authResult=FAILED (Invalid Credentials), status=401`);
            return res.status(401).json({
                error: 'Incorrect username or password.', code: 'INVALID_CREDENTIALS'
            });
        }

        console.log(`[AUTH-DIAGNOSTIC] PID:${process.pid} POST /api/auth/login: user="${normUser}", role="${user.role}", dept="${user.department}", authResult=SUCCESS, status=200`);
        res.startSession(user);
        const pub = await buildPublicUser(user);
        res.json({ authenticated: true, user: pub });
    } catch (err) {
        console.log(`[AUTH-DIAGNOSTIC] PID:${process.pid} POST /api/auth/login: user="${String(username).trim().toLowerCase()}", authResult=ERROR: ${err.message}, status=${err.status || 401}`);
        return res.status(err.status || 401).json({
            error: err.message,
            code: err.code || 'INVALID_CREDENTIALS'
        });
    }
});

router.get('/profile', async (req, res) => {
    if (!req.session) {
        return res.status(401).json({ error: 'Sign in to access your profile.', code: 'UNAUTHENTICATED' });
    }
    const profile = await users.findByUsernameAsync(req.session.username);
    const pub = await buildPublicUser(profile || req.session);
    res.json({ profile: pub });
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
        res.startSession(updated);
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
