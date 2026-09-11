/**
 * User accounts and authentication management.
 *
 * Implements real account-based registration, safe first-time HOS setup,
 * faculty accounts with multiple subjects/expertise, password hashing via scrypt,
 * and single-branch context binding.
 */
const { getBranch, setBranch, registerBranch, isBranchRegistered } = require('./departments');
const store = require('./store');
const config = require('../config');
const db = require('../db/pool');
const repository = require('../db/repository');
const { hashPassword, verifyPassword, validatePhone, validateUsername, validatePassword, PASSWORD_ERROR_MESSAGE } = require('../core/authSecurity');

/**
 * In-memory storage for registered accounts.
 */
let registeredUsers = [];

function syncFromDatabase(dbUsers = []) {
    if (!Array.isArray(dbUsers)) return;
    for (const u of dbUsers) {
        const uname = String(u.username || '').toLowerCase();
        const existingIdx = registeredUsers.findIndex(r => r.username.toLowerCase() === uname);
        const item = {
            id: u.id,
            username: uname,
            name: u.name,
            phone: u.phone || null,
            role: u.role,
            department: u.department || '',
            branchName: u.branchName || u.department || '',
            passwordHash: u.passwordHash,
            subjects: Array.isArray(u.subjects) ? u.subjects : [],
            facultyId: u.facultyId || null,
            facultyName: u.facultyName || (u.role === 'faculty' ? u.name : null),
            status: u.status || 'active',
            createdAt: u.createdAt || new Date().toISOString()
        };
        if (existingIdx >= 0) {
            registeredUsers[existingIdx] = item;
        } else {
            registeredUsers.push(item);
        }
    }
}

function slug(name) {
    return String(name)
        .toLowerCase()
        .replace(/^(dr|prof|mr|mrs|ms|sri)\.?\s+/, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.|\.$/g, '');
}

/**
 * Checks whether an HOS account is already configured for a specific branch (or any branch).
 */
function hasHOSForBranch(branchCode) {
    if (!branchCode) return false;
    const code = String(branchCode).trim().toUpperCase();
    const foundRegistered = registeredUsers.some(u =>
        (u.role === 'hos' || u.role === 'coordinator') &&
        u.department && u.department.toUpperCase() === code
    );
    if (foundRegistered) return true;

    if (process.env.EMPTY_INSTANCE === 'true') {
        return false;
    }

    if (config.loadDemoData || Boolean(config.branchCode && config.branchName)) {
        if (config.branchCode && config.branchCode.toUpperCase() === code) {
            return true;
        }
    }

    return false;
}

function hasHOS(branchCode = null) {
    if (branchCode) {
        return hasHOSForBranch(branchCode);
    }
    const foundRegistered = registeredUsers.some(u => u.role === 'hos' || u.role === 'coordinator');
    if (foundRegistered) return true;

    if (process.env.EMPTY_INSTANCE === 'true') {
        return false;
    }

    if (config.loadDemoData || Boolean(config.branchCode && config.branchName)) {
        return true;
    }

    return false;
}

function findHOSByBranch(branchCode) {
    if (branchCode) {
        const code = String(branchCode).trim().toUpperCase();
        const found = registeredUsers.find(u =>
            (u.role === 'hos' || u.role === 'coordinator') &&
            u.department && u.department.toUpperCase() === code
        );
        if (found) return toPublicUser(found);
    }
    const firstHos = registeredUsers.find(u => u.role === 'hos' || u.role === 'coordinator');
    if (firstHos) return toPublicUser(firstHos);
    return findByUsername('hos');
}

/**
 * Safe first-time setup check.
 */
function isInitialSetupAllowed() {
    return !hasHOS();
}

/**
 * Register a new user account.
 *
 * Enforces:
 *   - Name, phone, username, password validation
 *   - Password policy: letter + number + underscore only
 *   - HOS registration creates/selects branch context
 *   - Faculty creation by authenticated HOS inherits HOS branch context strictly
 *   - Cryptographic password hashing
 */
function register(data, sessionUser = null) {
    const name = String(data.name || '').trim();
    if (!name || name.length < 2) {
        const err = new Error('Full name is required (minimum 2 characters).');
        err.status = 400; err.code = 'INVALID_NAME';
        throw err;
    }

    const phone = String(data.phone || '').trim();
    if (!validatePhone(phone)) {
        const err = new Error('A valid phone number is required (e.g. 9493438305 or +91 94934 38305).');
        err.status = 400; err.code = 'INVALID_PHONE';
        throw err;
    }

    const rawUsername = String(data.username || '').trim();
    if (!validateUsername(rawUsername)) {
        const err = new Error('Username must be 3–30 characters and contain only letters, numbers, dots, dashes, or underscores.');
        err.status = 400; err.code = 'INVALID_USERNAME';
        throw err;
    }
    const username = rawUsername.toLowerCase();

    // Check duplicate username
    if (registeredUsers.some(u => u.username === username)) {
        const err = new Error(`Username "${rawUsername}" is already taken.`);
        err.status = 409; err.code = 'USERNAME_EXISTS';
        throw err;
    }

    const password = String(data.password || '');
    if (!validatePassword(password)) {
        const err = new Error(PASSWORD_ERROR_MESSAGE);
        err.status = 400; err.code = 'INVALID_PASSWORD';
        throw err;
    }

    if (data.confirmPassword != null && String(data.confirmPassword) !== password) {
        const err = new Error('Passwords do not match.');
        err.status = 400; err.code = 'PASSWORD_MISMATCH';
        throw err;
    }

    const role = String(data.role || 'faculty').toLowerCase();
    if (!['hos', 'faculty'].includes(role)) {
        const err = new Error('Role must be either "hos" or "faculty".');
        err.status = 400; err.code = 'INVALID_ROLE';
        throw err;
    }

    let targetBranchCode = '';
    let targetBranchName = '';

    if (role === 'hos') {
        const bCode = data.branchCode ? String(data.branchCode).trim().toUpperCase() : '';
        const bName = data.branchName ? String(data.branchName).trim() : '';
        if (!bCode || !bName) {
            const err = new Error('Branch Name and Branch Code are required to set up an HOS account.');
            err.status = 400; err.code = 'INVALID_BRANCH';
            throw err;
        }

        // Branch code must uniquely identify a branch.
        // If someone attempts: Branch Code = CME when CME already exists:
        // Reject the creation with a clear message: "Branch code CME already exists."
        if (hasHOSForBranch(bCode) || isBranchRegistered(bCode)) {
            const err = new Error(`Branch code ${bCode} already exists.`);
            err.status = 403; err.code = 'FORBIDDEN';
            throw err;
        }

        targetBranchCode = bCode;
        targetBranchName = bName;

        registerBranch({
            code: targetBranchCode,
            name: targetBranchName,
            academicYear: data.academicYear || null,
            semester: data.semester || null,
            totalSemesters: data.totalSemesters || data.total_semesters || 6
        });
    } else if (role === 'faculty') {
        // Faculty accounts MUST be created by an authenticated HOS session
        const isAuthorizedHOS = sessionUser && (sessionUser.role === 'hos' || sessionUser.role === 'coordinator');
        if (!isAuthorizedHOS) {
            const err = new Error('Public faculty creation is not allowed. Faculty accounts must be created by the Head of Section (HOS) for your branch.');
            err.status = 403; err.code = 'FORBIDDEN';
            throw err;
        }
        targetBranchCode = sessionUser.department ? sessionUser.department.toUpperCase() : '';
        const hosBranch = getBranch(targetBranchCode);
        targetBranchName = hosBranch && hosBranch.name ? hosBranch.name : targetBranchCode;

        if (!targetBranchCode) {
            const err = new Error('Could not inherit branch from your authenticated HOS session.');
            err.status = 400; err.code = 'MISSING_BRANCH_CONTEXT';
            throw err;
        }
    }

    // Faculty-specific validation: Subjects / Expertise
    let subjects = [];
    let facultyRecord = null;

    if (role === 'faculty') {
        const rawSubjects = Array.isArray(data.subjects)
            ? data.subjects
            : String(data.subjects || '').split(',').map(s => s.trim()).filter(Boolean);

        subjects = rawSubjects.map(s => String(s).trim()).filter(s => s.length > 0);
        if (!subjects.length) {
            const err = new Error('Faculty accounts must specify at least one subject or area of expertise.');
            err.status = 400; err.code = 'SUBJECTS_REQUIRED';
            throw err;
        }

        // Add or synchronize faculty record in branch roster
        const facultyId = data.facultyId || `${targetBranchCode}_${username.replace(/[^a-z0-9]/g, '_').toUpperCase()}`;
        facultyRecord = store.addFacultyInMemory({
            id: facultyId,
            name: name,
            department: targetBranchCode,
            phone: phone,
            subjects: subjects,
            status: 'active'
        });
    }

    // Hash password securely with cryptographic salt
    const passwordHash = hashPassword(password);

    const newUser = {
        id: role === 'hos' ? `HOS_${targetBranchCode}` : (facultyRecord ? facultyRecord.id : `USER_${Date.now()}`),
        username,
        name,
        phone,
        role,
        department: targetBranchCode,
        branchName: targetBranchName,
        passwordHash,
        subjects: role === 'faculty' ? subjects : [],
        facultyId: facultyRecord ? facultyRecord.id : null,
        facultyName: role === 'faculty' ? name : null,
        status: 'active',
        createdAt: new Date().toISOString()
    };

    registeredUsers.push(newUser);

    if (db.isConfigured() && store.usingDatabase) {
        try {
            repository.saveUser({
                username: newUser.username,
                name: newUser.name,
                phone: newUser.phone,
                role: newUser.role,
                departmentCode: newUser.department,
                passwordHash: newUser.passwordHash,
                status: newUser.status,
                facultyId: newUser.facultyId,
                subjects: newUser.subjects
            }).catch(() => {});
        } catch (_) {}
    }

    return toPublicUser(newUser);
}

function toPublicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        name: user.name,
        phone: user.phone || null,
        role: user.role,
        department: user.department,
        branchName: user.branchName || user.department,
        subjects: Array.isArray(user.subjects) ? user.subjects : [],
        facultyName: user.facultyName || (user.role === 'faculty' ? user.name : null),
        facultyId: user.facultyId || null,
        status: user.status || 'active'
    };
}

/**
 * Authenticate credentials.
 * Supports hashed passwords and legacy demo credentials for test harness.
 */
function authenticate(username, password) {
    const wanted = String(username || '').trim().toLowerCase();
    if (!wanted || password == null) return null;

    // 1. Search registered users
    const registered = registeredUsers.find(u => u.username === wanted);
    if (registered) {
        if (registered.status === 'inactive') {
            const err = new Error('Account is deactivated. Please contact your Head of Section.');
            err.status = 403;
            err.code = 'ACCOUNT_DEACTIVATED';
            throw err;
        }
        if (registered.facultyId && store.engine) {
            const fac = store.engine.getFaculty().find(f =>
                (f.id && String(f.id).toLowerCase() === String(registered.facultyId).toLowerCase()) ||
                (f.name && f.name.toLowerCase() === registered.name.toLowerCase())
            );
            if (fac && fac.status === 'inactive') {
                const err = new Error('Account is deactivated. Please contact your Head of Section.');
                err.status = 403;
                err.code = 'ACCOUNT_DEACTIVATED';
                throw err;
            }
        }
        if (verifyPassword(password, registered.passwordHash)) {
            return toPublicUser(registered);
        }
        return null;
    }

    // 2. Demo accounts fallback (when loadDemoData is true OR when pre-configured via environment variables)
    if (config.loadDemoData || Boolean(config.branchCode && config.branchName)) {
        const branch = getBranch();
        if (wanted === 'hos' || (branch.code && wanted === `hos.${branch.code.toLowerCase()}`)) {
            if (verifyPassword(password, null, config.demoPassword)) {
                return {
                    id: `HOS_${branch.code || 'DEMO'}`,
                    username: 'hos',
                    name: `HOS (${branch.code || 'Demo'})`,
                    phone: null,
                    role: 'hos',
                    department: branch.code || 'DEMO',
                    branchName: branch.name || 'Demo Branch',
                    subjects: [],
                    facultyName: null,
                    facultyId: null
                };
            }
        }

        if (wanted === 'admin') {
            if (verifyPassword(password, null, config.demoPassword)) {
                return {
                    id: 'ADMIN',
                    username: 'admin',
                    name: 'Timetable Coordinator',
                    phone: null,
                    role: 'coordinator',
                    department: branch.code || 'DEMO',
                    branchName: branch.name || 'Demo Branch',
                    subjects: [],
                    facultyName: null,
                    facultyId: null
                };
            }
        }

        // Check faculty roster in store.engine for legacy demo accounts
        const faculty = store.engine ? store.engine.getFaculty() : [];
        const member = faculty.find(f => slug(f.name) === wanted || (f.id && String(f.id).toLowerCase() === wanted));
        if (member) {
            if (member.status === 'inactive') {
                const err = new Error('Account is deactivated. Please contact your Head of Section.');
                err.status = 403;
                err.code = 'ACCOUNT_DEACTIVATED';
                throw err;
            }
            if (verifyPassword(password, null, config.demoPassword)) {
                return {
                    id: member.id,
                    username: slug(member.name),
                    name: member.name,
                    phone: member.phone || null,
                    role: 'faculty',
                    department: branch.code || member.department,
                    branchName: branch.name || member.department,
                    subjects: member.subjects || [],
                    facultyName: member.name,
                    facultyId: member.id,
                    status: member.status || 'active'
                };
            }
        }
    }

    return null;
}

function findByUsername(username) {
    const wanted = String(username || '').trim().toLowerCase();
    if (!wanted) return null;
    const branch = getBranch();

    const registered = registeredUsers.find(u => u.username === wanted);
    if (registered) return toPublicUser(registered);

    if (config.loadDemoData || Boolean(config.branchCode && config.branchName)) {
        if (wanted === 'hos' || (branch.code && wanted === `hos.${branch.code.toLowerCase()}`)) {
            return {
                id: `HOS_${branch.code || 'DEMO'}`,
                username: 'hos',
                name: `HOS (${branch.code || 'Demo'})`,
                phone: null,
                role: 'hos',
                department: branch.code || 'DEMO',
                branchName: branch.name || 'Demo Branch',
                subjects: [],
                facultyName: null
            };
        }

        if (wanted === 'admin') {
            return {
                id: 'ADMIN',
                username: 'admin',
                name: 'Timetable Coordinator',
                phone: null,
                role: 'coordinator',
                department: branch.code || 'DEMO',
                branchName: branch.name || 'Demo Branch',
                subjects: [],
                facultyName: null
            };
        }

        const faculty = store.engine ? store.engine.getFaculty() : [];
        const member = faculty.find(f => slug(f.name) === wanted || (f.id && String(f.id).toLowerCase() === wanted));
        if (member) {
            return {
                id: member.id,
                username: slug(member.name),
                name: member.name,
                phone: member.phone || null,
                role: 'faculty',
                department: branch.code || member.department,
                branchName: branch.name || member.department,
                subjects: member.subjects || [],
                facultyName: member.name
            };
        }
    }

    return null;
}

function list(branchCode = null) {
    const code = branchCode ? String(branchCode).trim().toUpperCase() : null;

    // If accounts have been registered, report those
    if (registeredUsers.length > 0) {
        if (code) {
            return registeredUsers
                .filter(u => u.department && u.department.toUpperCase() === code)
                .map(toPublicUser);
        }
        return registeredUsers.map(toPublicUser);
    }

    // In a fresh installation without loadDemoData or env branch, there are 0 users
    if ((!config.loadDemoData && !Boolean(config.branchCode && config.branchName)) || process.env.EMPTY_INSTANCE === 'true') {
        return [];
    }

    const branch = getBranch(code);

    // Otherwise report the demo accounts only when loadDemoData is active
    const admin = {
        id: 'ADMIN',
        username: 'admin',
        name: 'Timetable Coordinator',
        phone: null,
        role: 'coordinator',
        department: branch.code || 'DEMO',
        branchName: branch.name || 'Demo Branch',
        subjects: [],
        facultyName: null
    };

    const faculty = (store.engine ? store.engine.getFaculty() : [])
        .filter(member => !code || (member.department && member.department.toUpperCase() === code))
        .map(member => ({
            id: member.id,
            username: slug(member.name),
            name: member.name,
            phone: member.phone || null,
            role: 'faculty',
            department: branch.code || member.department,
            branchName: branch.name || member.department,
            subjects: member.subjects || [],
            facultyName: member.name
        }));

    return [admin].concat(faculty);
}

function getProfile(username) {
    const user = findByUsername(username);
    if (!user) return null;
    return toPublicUser(user);
}

function updateProfile(username, changes = {}) {
    const wanted = String(username || '').trim().toLowerCase();
    const idx = registeredUsers.findIndex(u => u.username === wanted);
    if (idx === -1) {
        const err = new Error(`User "${username}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    if (changes.phone) {
        if (!validatePhone(changes.phone)) {
            const err = new Error('Invalid phone number format.');
            err.status = 400; err.code = 'INVALID_PHONE';
            throw err;
        }
        registeredUsers[idx].phone = String(changes.phone).trim();
    }

    if (Array.isArray(changes.subjects)) {
        const cleaned = changes.subjects.map(s => String(s).trim()).filter(Boolean);
        if (registeredUsers[idx].role === 'faculty' && cleaned.length === 0) {
            const err = new Error('Faculty must maintain at least one subject/expertise.');
            err.status = 400; err.code = 'SUBJECTS_REQUIRED';
            throw err;
        }
        registeredUsers[idx].subjects = cleaned;
    }

    return toPublicUser(registeredUsers[idx]);
}

function updateFacultyUser(facultyIdOrUsername, updates = {}) {
    const needle = String(facultyIdOrUsername).trim().toLowerCase();
    const idx = registeredUsers.findIndex(u =>
        (u.facultyId && String(u.facultyId).toLowerCase() === needle) ||
        (u.id && String(u.id).toLowerCase() === needle) ||
        (u.username && u.username.toLowerCase() === needle) ||
        (u.name && u.name.toLowerCase() === needle)
    );
    if (idx !== -1) {
        if (updates.name && String(updates.name).trim().length >= 2) {
            registeredUsers[idx].name = String(updates.name).trim();
            if (registeredUsers[idx].facultyName) registeredUsers[idx].facultyName = registeredUsers[idx].name;
        }
        if (updates.phone !== undefined) {
            registeredUsers[idx].phone = updates.phone ? String(updates.phone).trim() : null;
        }
        if (Array.isArray(updates.subjects)) {
            registeredUsers[idx].subjects = updates.subjects.map(s => String(s).trim()).filter(Boolean);
        }
        if (updates.status) {
            registeredUsers[idx].status = updates.status;
        }
        return toPublicUser(registeredUsers[idx]);
    }
    return null;
}

function createApprovedFacultyUser(data) {
    const username = String(data.username || '').trim().toLowerCase();
    const name = String(data.name || data.fullName || '').trim();
    const phone = String(data.phone || '').trim();
    const targetBranchCode = String(data.branchCode || data.department || '').trim().toUpperCase();
    const hosBranch = getBranch(targetBranchCode);
    const targetBranchName = hosBranch && hosBranch.name ? hosBranch.name : targetBranchCode;
    const designation = data.designation ? String(data.designation).trim() : null;

    // Check duplicate username
    if (registeredUsers.some(u => u.username === username)) {
        const err = new Error(`Username "${username}" is already taken.`);
        err.status = 409; err.code = 'USERNAME_EXISTS';
        throw err;
    }

    const rawSubjects = Array.isArray(data.subjects)
        ? data.subjects
        : String(data.subjects || '').split(',').map(s => s.trim()).filter(Boolean);
    const subjects = rawSubjects.map(s => String(s).trim()).filter(s => s.length > 0);

    const facultyId = data.facultyId || `${targetBranchCode}_${username.replace(/[^a-z0-9]/g, '_').toUpperCase()}`;

    const facultyRecord = store.addFacultyInMemory({
        id: facultyId,
        name: name,
        department: targetBranchCode,
        phone: phone,
        designation: designation,
        subjects: subjects,
        status: 'active'
    });

    const newUser = {
        id: facultyRecord ? facultyRecord.id : `USER_${Date.now()}`,
        username,
        name,
        phone,
        role: 'faculty',
        department: targetBranchCode,
        branchName: targetBranchName,
        passwordHash: data.passwordHash,
        designation: designation,
        subjects,
        facultyId: facultyRecord ? facultyRecord.id : null,
        facultyName: name,
        status: 'active',
        createdAt: new Date().toISOString()
    };

    registeredUsers.push(newUser);

    if (db.isConfigured() && store.usingDatabase) {
        try {
            repository.saveUser({
                username: newUser.username,
                name: newUser.name,
                phone: newUser.phone,
                role: newUser.role,
                departmentCode: newUser.department,
                passwordHash: newUser.passwordHash,
                status: newUser.status,
                facultyId: newUser.facultyId,
                subjects: newUser.subjects
            }).catch(() => {});
        } catch (_) {}
    }

    return toPublicUser(newUser);
}

function resetForTesting() {
    registeredUsers = [];
}

module.exports = {
    list,
    findByUsername,
    findHOSByBranch,
    authenticate,
    register,
    createApprovedFacultyUser,
    hasHOS,
    hasHOSForBranch,
    isInitialSetupAllowed,
    getProfile,
    updateProfile,
    updateFacultyUser,
    syncFromDatabase,
    resetForTesting,
    toPublicUser
};


