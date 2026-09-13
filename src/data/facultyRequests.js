/**
 * Faculty Self-Registration Requests Store & Service (Phase B7.1).
 *
 * Implements:
 *   - Public faculty registration request submission
 *   - Strict validation (branch existence, password policy, phone, username uniqueness)
 *   - Secure cryptographic password hashing (plaintext passwords never stored)
 *   - Request lifecycle: PENDING -> APPROVED / REJECTED
 *   - Branch-isolated HOS review, approval, and rejection
 *   - Sensible handling of previous rejected requests (no ambiguous duplicates)
 *   - Transactional account creation upon HOS approval
 */
const crypto = require('crypto');
const db = require('../db/pool');
const repository = require('../db/repository');
const { isBranchRegistered, getBranch } = require('./departments');
const users = require('./users');
const {
    hashPassword,
    validatePhone,
    validateUsername,
    validatePassword,
    PASSWORD_ERROR_MESSAGE
} = require('../core/authSecurity');

// In-memory request store for fallback / testing
let inMemoryRequests = [];

function generateRequestId() {
    return 'freq_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function sanitize(req) {
    if (!req) return null;
    return {
        id: req.id,
        fullName: req.fullName || req.full_name,
        name: req.fullName || req.full_name,
        phone: req.phone,
        username: req.username,
        designation: req.designation || null,
        subjects: Array.isArray(req.subjects) ? req.subjects : [],
        branchCode: req.branchCode || req.branch_code,
        status: req.status,
        rejectionReason: req.rejectionReason || req.rejection_reason || null,
        reviewedBy: req.reviewedBy || req.reviewed_by || null,
        reviewedAt: req.reviewedAt || req.reviewed_at || null,
        createdAt: req.createdAt || req.created_at
    };
}

/**
 * Checks whether a branch code resolves to an existing registered branch.
 */
async function verifyBranchExists(code) {
    if (!code) return false;
    const raw = String(code).trim().toUpperCase();

    if (isBranchRegistered(raw)) {
        return true;
    }

    if (db.isConfigured()) {
        try {
            const { rows } = await db.query('SELECT 1 FROM departments WHERE UPPER(code) = UPPER($1)', [raw]);
            if (rows.length > 0) return true;
        } catch (_) {}
    }

    return false;
}

/**
 * Submit a public faculty registration request.
 * Starts as PENDING. No faculty user account is created.
 */
async function submitRequest(data = {}) {
    const fullName = String(data.name || data.fullName || data.full_name || '').trim();
    if (!fullName || fullName.length < 2) {
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

    const rawBranchCode = String(data.branchCode || data.branch_code || data.department || '').trim().toUpperCase();
    if (!rawBranchCode) {
        const err = new Error('Branch code is required.');
        err.status = 400; err.code = 'INVALID_BRANCH';
        throw err;
    }

    const branchValid = await verifyBranchExists(rawBranchCode);
    if (!branchValid) {
        const err = new Error(`Branch code "${rawBranchCode}" does not exist. Please select a registered branch.`);
        err.status = 400; err.code = 'INVALID_BRANCH';
        throw err;
    }

    const rawUsername = String(data.username || '').trim();
    if (!validateUsername(rawUsername)) {
        const err = new Error('Username must be 3–30 characters and contain only letters, numbers, dots, dashes, or underscores.');
        err.status = 400; err.code = 'INVALID_USERNAME';
        throw err;
    }
    const username = rawUsername.toLowerCase();

    // 1. Check duplicate username among active existing users
    const existingUser = users.findByUsername(username);
    if (existingUser) {
        const err = new Error(`Username "${rawUsername}" is already taken.`);
        err.status = 409; err.code = 'USERNAME_EXISTS';
        throw err;
    }

    // 2. Check duplicate username among pending requests
    const pendingRequest = inMemoryRequests.find(r => r.username === username && r.status === 'PENDING');
    if (pendingRequest) {
        const err = new Error(`A registration request for username "${rawUsername}" is already pending review.`);
        err.status = 409; err.code = 'REQUEST_EXISTS';
        throw err;
    }

    // 3. Password validation
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

    // 4. Subjects / Expertise validation
    const rawSubjects = Array.isArray(data.subjects)
        ? data.subjects
        : String(data.subjects || '').split(',').map(s => s.trim()).filter(Boolean);
    const subjects = rawSubjects.map(s => String(s).trim()).filter(s => s.length > 0);
    if (!subjects.length) {
        const err = new Error('Faculty registration requests must specify at least one subject or area of expertise.');
        err.status = 400; err.code = 'SUBJECTS_REQUIRED';
        throw err;
    }

    const designation = data.designation ? String(data.designation).trim() : null;

    // Cryptographically hash password (NEVER store plaintext password!)
    const passwordHash = hashPassword(password);

    // If a previous request for this username was REJECTED, remove it so the new request replaces it cleanly
    inMemoryRequests = inMemoryRequests.filter(r => !(r.username === username && r.status === 'REJECTED'));

    const newRecord = {
        id: generateRequestId(),
        fullName,
        phone,
        username,
        passwordHash,
        designation,
        subjects,
        branchCode: rawBranchCode,
        status: 'PENDING',
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date().toISOString()
    };

    if (db.isConfigured()) {
        try {
            const dbRow = await repository.createFacultyRequest({
                fullName,
                phone,
                username,
                passwordHash,
                designation,
                subjects,
                branchCode: rawBranchCode
            });
            if (dbRow && dbRow.id) {
                newRecord.id = dbRow.id;
            }
        } catch (err) {
            // If DB insert fails, keep in-memory for resilience
        }
    }

    inMemoryRequests.unshift(newRecord);
    return sanitize(newRecord);
}

/**
 * List requests for an authenticated HOS's branch.
 */
async function listRequests(branchCode, status = null) {
    if (!branchCode) return [];
    const targetBranch = String(branchCode).trim().toUpperCase();

    if (db.isConfigured()) {
        try {
            const rows = await repository.listFacultyRequests(targetBranch, status);
            return rows.map(sanitize);
        } catch (_) {}
    }

    let results = inMemoryRequests.filter(r => r.branchCode.toUpperCase() === targetBranch);
    if (status) {
        const filterStatus = String(status).trim().toUpperCase();
        results = results.filter(r => r.status === filterStatus);
    }
    return results.map(sanitize);
}

/**
 * Get single request by ID.
 */
async function getRequestById(id) {
    if (!id) return null;
    const strId = String(id).trim();

    if (db.isConfigured()) {
        try {
            const row = await repository.getFacultyRequestById(strId);
            if (row) return row;
        } catch (_) {}
    }

    const found = inMemoryRequests.find(r => String(r.id) === strId);
    return found || null;
}

/**
 * Approve a registration request.
 * Creates the actual faculty user account with role 'faculty', active status,
 * and inherits the branch from the request.
 */
async function approveRequest(id, sessionUser) {
    const targetId = String(id || '').trim();
    const req = await getRequestById(targetId);
    if (!req) {
        const err = new Error(`Faculty registration request "${targetId}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const hosDept = sessionUser && sessionUser.department ? String(sessionUser.department).trim().toUpperCase() : null;
    const reqDept = String(req.branchCode || req.branch_code).trim().toUpperCase();

    // Strict branch ownership verification
    if (!hosDept || hosDept !== reqDept) {
        const err = new Error(`Cross-branch access forbidden. You are HOS of ${hosDept}, but this request belongs to ${reqDept}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    // Idempotency / state checks
    if (req.status === 'APPROVED') {
        const err = new Error('This registration request has already been approved.');
        err.status = 409; err.code = 'ALREADY_APPROVED';
        throw err;
    }

    if (req.status === 'REJECTED') {
        const err = new Error('Cannot approve a rejected registration request.');
        err.status = 409; err.code = 'ALREADY_REJECTED';
        throw err;
    }

    // Check username availability again before creation
    const existingUser = users.findByUsername(req.username);
    if (existingUser) {
        const err = new Error(`Username "${req.username}" is already taken.`);
        err.status = 409; err.code = 'USERNAME_EXISTS';
        throw err;
    }

    const reviewer = sessionUser.username || sessionUser.name || 'HOS';
    const reviewedAt = new Date().toISOString();

    // Transactionally create the actual faculty user account
    const createdUser = await users.createApprovedFacultyUser({
        username: req.username,
        name: req.fullName || req.full_name,
        phone: req.phone,
        department: reqDept,
        passwordHash: req.passwordHash || req.password_hash,
        designation: req.designation,
        subjects: req.subjects
    });

    // Update in-memory record
    req.status = 'APPROVED';
    req.reviewedBy = reviewer;
    req.reviewedAt = reviewedAt;

    const memApprove = inMemoryRequests.find(r => String(r.id) === targetId || (r.username && r.username === req.username));
    if (memApprove) {
        memApprove.status = 'APPROVED';
        memApprove.reviewedBy = reviewer;
        memApprove.reviewedAt = reviewedAt;
    }

    if (db.isConfigured()) {
        try {
            await repository.updateFacultyRequestStatus(targetId, reqDept, 'APPROVED', reviewer, null);
        } catch (_) {}
    }

    return {
        success: true,
        message: `Faculty registration request for ${req.fullName || req.full_name} approved successfully.`,
        user: createdUser,
        request: sanitize(req)
    };
}

/**
 * Reject a registration request.
 * Does NOT create any faculty account.
 */
async function rejectRequest(id, sessionUser, reason = null) {
    const targetId = String(id || '').trim();
    const req = await getRequestById(targetId);
    if (!req) {
        const err = new Error(`Faculty registration request "${targetId}" not found.`);
        err.status = 404; err.code = 'NOT_FOUND';
        throw err;
    }

    const hosDept = sessionUser && sessionUser.department ? String(sessionUser.department).trim().toUpperCase() : null;
    const reqDept = String(req.branchCode || req.branch_code).trim().toUpperCase();

    // Strict branch ownership verification
    if (!hosDept || hosDept !== reqDept) {
        const err = new Error(`Cross-branch access forbidden. You are HOS of ${hosDept}, but this request belongs to ${reqDept}.`);
        err.status = 403; err.code = 'FORBIDDEN';
        throw err;
    }

    if (req.status === 'APPROVED') {
        const err = new Error('Cannot reject an already approved registration request.');
        err.status = 409; err.code = 'ALREADY_APPROVED';
        throw err;
    }

    if (req.status === 'REJECTED') {
        const err = new Error('This registration request has already been rejected.');
        err.status = 409; err.code = 'ALREADY_REJECTED';
        throw err;
    }

    const reviewer = sessionUser.username || sessionUser.name || 'HOS';
    const reviewedAt = new Date().toISOString();
    const rejectionReason = reason ? String(reason).trim() : null;

    req.status = 'REJECTED';
    req.reviewedBy = reviewer;
    req.reviewedAt = reviewedAt;
    req.rejectionReason = rejectionReason;

    const memReject = inMemoryRequests.find(r => String(r.id) === targetId || (r.username && r.username === req.username));
    if (memReject) {
        memReject.status = 'REJECTED';
        memReject.reviewedBy = reviewer;
        memReject.reviewedAt = reviewedAt;
        memReject.rejectionReason = rejectionReason;
    }

    if (db.isConfigured()) {
        try {
            await repository.updateFacultyRequestStatus(targetId, reqDept, 'REJECTED', reviewer, rejectionReason);
        } catch (_) {}
    }

    return {
        success: true,
        message: 'Faculty registration request has been rejected.',
        request: sanitize(req)
    };
}

function resetForTesting() {
    inMemoryRequests = [];
}

module.exports = {
    submitRequest,
    listRequests,
    getRequestById,
    approveRequest,
    rejectRequest,
    verifyBranchExists,
    sanitize,
    resetForTesting
};
