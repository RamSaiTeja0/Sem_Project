/**
 * Canonical department / branch list.
 *
 * One definition shared by the demo dataset, the database seed, the
 * departments API and every filter in the UI, so a branch can never appear in
 * one place and be missing from another.
 *
 * A department stays listed even when no faculty currently belong to it: a
 * filter that silently drops an empty branch makes it look as though the
 * branch does not exist. `GET /api/faculty/departments` reports the roster
 * count alongside each one.
 */

const DEPARTMENTS = [
    { code: 'CSE', name: 'Computer Science and Engineering' },
    { code: 'ECE', name: 'Electronics and Communication Engineering' },
    { code: 'EEE', name: 'Electrical and Electronics Engineering' },
    { code: 'CME', name: 'Computer Engineering' },
    { code: 'MEC', name: 'Mechanical Engineering' },
    { code: 'CIVIL', name: 'Civil Engineering' }
];

const BY_CODE = new Map(DEPARTMENTS.map(d => [d.code.toUpperCase(), d]));

/** Resolve a code (case-insensitively) to its record, or null. */
function find(code) {
    return BY_CODE.get(String(code || '').trim().toUpperCase()) || null;
}

/** Full name for a code, falling back to the code itself for unknown ones. */
function nameFor(code) {
    const match = find(code);
    return match ? match.name : String(code || '').trim();
}

function codes() {
    return DEPARTMENTS.map(d => d.code);
}

module.exports = { DEPARTMENTS, find, nameFor, codes };
