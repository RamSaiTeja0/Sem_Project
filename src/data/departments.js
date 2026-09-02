/**
 * Canonical department / branch list.
 *
 * One definition shared by the demo dataset, the database seed, the
 * departments API and every filter in the UI, so a branch can never appear in
 * one place and be missing from another.
 *
 * ACTIVE vs ARCHIVED
 * ------------------
 * An ACTIVE branch is an application someone can sign in to. An ARCHIVED one
 * keeps its historical records — nothing is deleted — but is not an
 * application: it has no accounts, appears in no list, and cannot be reached
 * through any API a normal user can call.
 *
 * The final active set is CME, EEE and MEC. "EE" was an older spelling of EEE
 * and is not a separate branch; see the EE -> EEE normalization in
 * src/db/schema.sql, which merges any surviving EE records into EEE.
 *
 * A department stays listed even when no faculty currently belong to it: a
 * filter that silently drops an empty branch makes it look as though the
 * branch does not exist. `GET /api/faculty/departments` reports the roster
 * count alongside each one.
 */

const DEPARTMENTS = [
    { code: 'CME', name: 'Computer Engineering', active: true },
    { code: 'EEE', name: 'Electrical and Electronics Engineering', active: true },
    { code: 'MEC', name: 'Mechanical Engineering', active: true },
    // Archived. Its records are preserved and still resolve to a readable name
    // so old data never renders as a bare code, but it is not an application.
    { code: 'ECE', name: 'Electronics and Communication Engineering', active: false }
];

/** Older spellings that mean an existing branch rather than a new one. */
const ALIASES = { EE: 'EEE' };

const BY_CODE = new Map(DEPARTMENTS.map(d => [d.code.toUpperCase(), d]));

/** The canonical code for a branch, resolving a known alias. */
function canonical(code) {
    const upper = String(code || '').trim().toUpperCase();
    return ALIASES[upper] || upper;
}

/** Resolve a code (case-insensitively, aliases included) to its record, or null. */
function find(code) {
    return BY_CODE.get(canonical(code)) || null;
}

/** Full name for a code, falling back to the code itself for unknown ones. */
function nameFor(code) {
    const match = find(code);
    return match ? match.name : String(code || '').trim();
}

function codes() {
    return DEPARTMENTS.map(d => d.code);
}

/** The branches that are applications people can sign in to. */
function activeCodes() {
    return DEPARTMENTS.filter(d => d.active !== false).map(d => d.code);
}

/**
 * Is this branch an application?
 *
 * Unknown codes are treated as active: a branch created at runtime through
 * /api/branches is not in this bundled list, and refusing it here would make
 * the feature silently useless. Archiving is an explicit decision recorded
 * either here or in the database's departments.active column.
 */
function isActive(code) {
    const match = find(code);
    return match ? match.active !== false : true;
}

module.exports = { DEPARTMENTS, ALIASES, find, nameFor, codes, canonical, activeCodes, isActive };
