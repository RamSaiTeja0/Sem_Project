/**
 * Demo account directory.
 *
 * Accounts are derived from the loaded faculty roster, so signing in as a
 * faculty member lines the dashboard up with that person's own timetable.
 * There is no user database yet: this module is the seam where one would go,
 * exactly as `store.js` is the seam for timetable storage.
 *
 * Passwords are compared against `config.demoPassword`. Nothing here is a
 * production credential store, and the README says so.
 */
const crypto = require('crypto');
const config = require('../config');
const store = require('./store');

function slug(name) {
    return String(name)
        .toLowerCase()
        .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.|\.$/g, '');
}

const ADMIN = {
    id: 'ADMIN',
    username: 'admin',
    name: 'Timetable Coordinator',
    role: 'coordinator',
    department: 'Administration',
    facultyName: null
};

/** Every account that can sign in: the coordinator plus one per faculty. */
function list() {
    const faculty = store.engine.getFaculty().map(member => ({
        id: member.id,
        username: slug(member.name),
        name: member.name,
        role: 'faculty',
        department: member.department,
        facultyName: member.name
    }));
    return [ADMIN].concat(faculty);
}

function findByUsername(username) {
    const wanted = String(username || '').trim().toLowerCase();
    if (!wanted) return null;
    return list().find(user => user.username === wanted || user.id.toLowerCase() === wanted) || null;
}

function constantTimeEquals(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** @returns {object|null} the account when the credentials match. */
function authenticate(username, password) {
    const user = findByUsername(username);
    if (!user) return null;
    if (!constantTimeEquals(password == null ? '' : password, config.demoPassword)) return null;
    return user;
}

module.exports = { list, findByUsername, authenticate, ADMIN };
