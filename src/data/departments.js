/**
 * Department and Branch Management.
 *
 * Supports independent branch accounts and contexts:
 *   Branch CME -> HOS CME -> Faculty, Timetable
 *   Branch EEE -> HOS EEE -> Faculty, Timetable
 *   Branch MEC -> HOS MEC -> Faculty, Timetable
 * Each branch context is preserved as entered and remains isolated.
 */
const config = require('../config');
// Stores registered branches keyed by uppercase code
const branches = new Map();
const DEPARTMENTS = [];

function syncDepartments() {
    DEPARTMENTS.length = 0;
    for (const b of branches.values()) {
        DEPARTMENTS.push(b);
    }
}

// Pre-populate branch if configured via environment
if (config.branchCode && config.branchName) {
    const envBranch = {
        configured: true,
        code: config.branchCode.toUpperCase(),
        name: config.branchName,
        academicYear: config.academicYear || null,
        semester: config.semester || null,
        totalSemesters: config.totalSemesters ? parseInt(config.totalSemesters, 10) : 6
    };
    branches.set(envBranch.code, envBranch);
    syncDepartments();
}

function registerBranch(branchData = {}) {
    const code = String(branchData.code || '').trim().toUpperCase();
    const name = String(branchData.name || '').trim();
    if (!code || !name) return null;

    const academicYear = branchData.academicYear ? String(branchData.academicYear).trim() : null;
    const parsedSem = branchData.semester != null ? parseInt(branchData.semester, 10) : null;
    const semester = Number.isFinite(parsedSem) ? parsedSem : null;
    const rawTotal = branchData.totalSemesters != null ? branchData.totalSemesters : branchData.total_semesters;
    const parsedTotal = rawTotal != null ? parseInt(rawTotal, 10) : null;
    const totalSemesters = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : 6;

    const b = {
        configured: true,
        code,
        name,
        academicYear,
        semester,
        totalSemesters
    };
    branches.set(code, b);
    syncDepartments();
    return b;
}

function getRegisteredBranchCodes() {
    const set = new Set();
    for (const code of branches.keys()) {
        if (code) set.add(code.toUpperCase());
    }
    return Array.from(set);
}

function isBranchRegistered(code) {
    if (!code) return false;
    const raw = String(code).trim().toUpperCase();
    return branches.has(raw) || (raw.startsWith('D') && branches.has(raw.slice(1)));
}

function isConfigured(code) {
    if (code) {
        const raw = String(code).trim().toUpperCase();
        return branches.has(raw) || (raw.startsWith('D') && branches.has(raw.slice(1)));
    }
    return branches.size > 0;
}

function getBranch(code = null) {
    if (code) {
        const raw = String(code).trim().toUpperCase();
        if (branches.has(raw)) return branches.get(raw);
        if (raw.startsWith('D') && branches.has(raw.slice(1))) return branches.get(raw.slice(1));
    }
    // If environment branch exists, return it
    if (config.branchCode && branches.has(config.branchCode.toUpperCase())) {
        return branches.get(config.branchCode.toUpperCase());
    }
    // Return first registered branch ONLY if exactly one branch is registered and no code was specified
    if (!code && branches.size === 1) {
        return branches.values().next().value;
    }

    return {
        configured: false,
        code: null,
        name: null,
        academicYear: null,
        semester: null,
        totalSemesters: 6
    };
}

function setBranch(changes = {}) {
    const code = changes.code ? String(changes.code).trim().toUpperCase() : null;
    const name = changes.name ? String(changes.name).trim() : null;

    if (code && name) {
        return registerBranch(changes);
    }
    if (code && branches.has(code)) {
        const existing = branches.get(code);
        if (name) existing.name = name;
        if (changes.academicYear) existing.academicYear = String(changes.academicYear).trim();
        if (changes.semester != null) {
            const parsed = parseInt(changes.semester, 10);
            if (Number.isFinite(parsed)) existing.semester = parsed;
        }
        const rawTotal = changes.totalSemesters != null ? changes.totalSemesters : changes.total_semesters;
        if (rawTotal != null) {
            const parsed = parseInt(rawTotal, 10);
            if (Number.isFinite(parsed) && parsed > 0) existing.totalSemesters = parsed;
        }
        syncDepartments();
        return existing;
    }

    const first = branches.values().next().value;
    if (first) {
        if (name) first.name = name;
        if (changes.academicYear) first.academicYear = String(changes.academicYear).trim();
        if (changes.semester != null) {
            const parsed = parseInt(changes.semester, 10);
            if (Number.isFinite(parsed)) first.semester = parsed;
        }
        const rawTotal = changes.totalSemesters != null ? changes.totalSemesters : changes.total_semesters;
        if (rawTotal != null) {
            const parsed = parseInt(rawTotal, 10);
            if (Number.isFinite(parsed) && parsed > 0) first.totalSemesters = parsed;
        }
        syncDepartments();
        return first;
    }

    if (code || name) {
        return registerBranch({
            code: code || 'BRANCH',
            name: name || 'Branch',
            academicYear: changes.academicYear,
            semester: changes.semester,
            totalSemesters: changes.totalSemesters || changes.total_semesters || 6
        });
    }

    return getBranch();
}

function resetBranchForTesting() {
    branches.clear();
    DEPARTMENTS.length = 0;
    if (config.branchCode && config.branchName) {
        const envBranch = {
            configured: true,
            code: config.branchCode.toUpperCase(),
            name: config.branchName,
            academicYear: config.academicYear || null,
            semester: config.semester || null,
            totalSemesters: config.totalSemesters ? parseInt(config.totalSemesters, 10) : 6
        };
        branches.set(envBranch.code, envBranch);
        syncDepartments();
    }
    return getBranch();
}

function getBranchSemesters(branchCode = null) {
    const branch = getBranch(branchCode);
    const count = (branch && branch.totalSemesters && branch.totalSemesters > 0) ? branch.totalSemesters : 6;
    return Array.from({ length: count }, (_, i) => `SEM-${i + 1}`);
}

const ALIASES = { EE: 'EEE' };

function canonical(code) {
    const upper = String(code || '').trim().toUpperCase();
    return ALIASES[upper] || upper;
}

function find(code) {
    if (!code) return null;
    const raw = canonical(code);
    if (branches.has(raw)) return branches.get(raw);
    if (raw.startsWith('D') && branches.has(raw.slice(1))) return branches.get(raw.slice(1));
    return null;
}

function nameFor(code) {
    const match = find(code);
    if (match) return match.name;
    return String(code || 'Unconfigured Branch').trim();
}

function codes() {
    return Array.from(branches.keys());
}

function list() {
    return Array.from(branches.values());
}

function activeCodes() {
    return codes();
}

function isActive(code) {
    const match = find(code);
    return match ? match.active !== false : true;
}

module.exports = {
    DEPARTMENTS,
    ALIASES,
    registerBranch,
    getBranch,
    setBranch,
    resetBranchForTesting,
    getBranchSemesters,
    find,
    nameFor,
    codes,
    list,
    canonical,
    activeCodes,
    isActive,
    isConfigured,
    isBranchRegistered,
    getRegisteredBranchCodes
};
