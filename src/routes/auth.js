/**
 * Authentication routes.
 *
 *   GET  /api/auth/session   who is signed in, and whether sign-in is enforced
 *   GET  /api/auth/accounts  the demo account list (never includes passwords)
 *   POST /api/auth/login     { username, password } -> sets the session cookie
 *   POST /api/auth/logout    clears it
 *
 * Sessions identify the user for the dashboard. Whether an anonymous visitor
 * is turned away is a deployment choice (`AUTH_REQUIRED`), so the demo dataset
 * stays browsable by default.
 */
const express = require('express');
const router = express.Router();

const config = require('../config');
const users = require('../data/users');

function publicUser(session) {
    if (!session) return null;
    return {
        id: session.id,
        username: session.username,
        name: session.name,
        role: session.role,
        department: session.department,
        facultyName: session.facultyName || null
    };
}

router.get('/session', (req, res) => {
    res.json({
        authenticated: Boolean(req.session),
        authRequired: config.authRequired,
        user: publicUser(req.session)
    });
});

router.get('/accounts', (req, res) => {
    res.json({
        note: 'Demo directory. Every account signs in with the same demo password.',
        // Shown on the sign-in page only while the password is the documented
        // default. Override DEMO_PASSWORD and the hint disappears.
        demoPassword: config.demoPassword === 'tecsub123' ? config.demoPassword : null,
        accounts: users.list().map(u => ({
            username: u.username, name: u.name, role: u.role, department: u.department
        }))
    });
});

router.post('/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({
            error: 'Enter both a username and a password.', code: 'MISSING_CREDENTIALS'
        });
    }

    const user = users.authenticate(username, password);
    if (!user) {
        // One message for both cases, so the response never reveals which
        // usernames exist.
        return res.status(401).json({
            error: 'Incorrect username or password.', code: 'INVALID_CREDENTIALS'
        });
    }

    res.startSession(user);
    res.json({ authenticated: true, user: publicUser(user) });
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
