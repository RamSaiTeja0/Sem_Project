/**
 * Stateless signed-cookie sessions.
 *
 * A session is a small JSON payload, base64url-encoded and signed with an
 * HMAC over the application secret. Nothing is stored server-side, so the
 * feature adds no database and no dependency, and a tampered or expired
 * cookie simply reads back as "not signed in".
 */
const crypto = require('crypto');
const config = require('../config');

const COOKIE_NAME = 'tec_session';

function b64url(buffer) {
    return Buffer.from(buffer).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value) {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded + '='.repeat((4 - padded.length % 4) % 4), 'base64');
}

function sign(payload) {
    return b64url(crypto.createHmac('sha256', config.sessionSecret).update(payload).digest());
}

/** Constant-time compare that never throws on differing lengths. */
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** @returns {string} the cookie value for this user. */
function create(user) {
    const body = {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        department: user.department,
        facultyName: user.facultyName || null,
        exp: Date.now() + config.sessionHours * 3600 * 1000
    };
    const payload = b64url(JSON.stringify(body));
    return `${payload}.${sign(payload)}`;
}

/** @returns {object|null} the session payload, or null if invalid/expired. */
function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;

    const payload = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), sign(payload))) return null;

    let body;
    try {
        body = JSON.parse(unb64url(payload).toString('utf8'));
    } catch (err) {
        return null;
    }
    if (!body || typeof body.exp !== 'number' || body.exp < Date.now()) return null;
    return body;
}

/** Minimal cookie header parser — no cookie-parser dependency needed. */
function parseCookies(header) {
    const jar = {};
    String(header || '').split(';').forEach(part => {
        const eq = part.indexOf('=');
        if (eq < 1) return;
        const key = part.slice(0, eq).trim();
        try {
            jar[key] = decodeURIComponent(part.slice(eq + 1).trim());
        } catch (err) {
            jar[key] = part.slice(eq + 1).trim();
        }
    });
    return jar;
}

/**
 * Express middleware: exposes `req.session` (payload or null) and gives the
 * response `res.startSession(user)` / `res.endSession()`.
 */
function middleware(req, res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    req.session = verify(req.cookies[COOKIE_NAME]);

    res.startSession = user => {
        const maxAge = config.sessionHours * 3600;
        res.setHeader('Set-Cookie',
            `${COOKIE_NAME}=${create(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
    };
    res.endSession = () => {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    };

    next();
}

module.exports = { COOKIE_NAME, create, verify, parseCookies, middleware };
