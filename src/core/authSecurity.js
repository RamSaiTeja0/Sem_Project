/**
 * Authentication and security helpers.
 *
 * Implements cryptographic password hashing using Node's native crypto.scrypt
 * with random salts, timing-safe equality verification, and phone/username validators.
 * No external dependencies required.
 */
const crypto = require('crypto');

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Hash a plaintext password with a unique cryptographic salt.
 * Format: scrypt:<hex_salt>:<hex_hash>
 */
function hashPassword(password) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const hash = crypto.scryptSync(password, salt, KEY_BYTES).toString('hex');
    return `scrypt:${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * Supports timing-safe equality and backward-compatible verification.
 */
function verifyPassword(password, storedHash, fallbackPassword = null) {
    if (!password) return false;
    const pwdStr = String(password);

    if (storedHash && storedHash.startsWith('scrypt:')) {
        const parts = storedHash.split(':');
        if (parts.length !== 3) return false;
        const salt = parts[1];
        const originalHash = parts[2];
        const computedHash = crypto.scryptSync(pwdStr, salt, KEY_BYTES).toString('hex');

        const bufA = Buffer.from(computedHash);
        const bufB = Buffer.from(originalHash);
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    }

    // Fallback comparison for demo accounts or legacy password configurations
    const expected = storedHash || fallbackPassword;
    if (expected) {
        const bufA = Buffer.from(pwdStr);
        const bufB = Buffer.from(String(expected));
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    }

    return false;
}

/**
 * Validate phone number format (allows 7-25 digits/symbols like +, -, spaces, parens).
 */
function validatePhone(phone) {
    if (!phone) return false;
    const cleaned = String(phone).trim();
    return /^[+0-9\s\-()]{7,25}$/.test(cleaned);
}

/**
 * Validate username format (3-30 alphanumeric, dots, underscores, dashes).
 */
function validateUsername(username) {
    if (!username) return false;
    const cleaned = String(username).trim();
    return /^[a-zA-Z0-9._-]{3,30}$/.test(cleaned);
}
/**
 * Password validation policy:
 * - At least ONE letter (A-Z / a-z)
 * - At least ONE number (0-9)
 * - At least ONE underscore (_)
 * - Allowed characters are ONLY: letters, numbers, and underscore
 * - DOT (.), dash (-), and all other characters are prohibited.
 */
const PASSWORD_ERROR_MESSAGE = 'Password must contain at least one letter, one number, and one underscore (_). Only letters, numbers, and underscores are allowed.';

function validatePassword(password) {
    if (!password || typeof password !== 'string') return false;
    // Allowed characters ONLY: letters, numbers, underscore
    if (!/^[A-Za-z0-9_]+$/.test(password)) return false;
    const hasLetter = /[A-Za-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasUnderscore = /_/.test(password);
    return hasLetter && hasNumber && hasUnderscore;
}

module.exports = {
    hashPassword,
    verifyPassword,
    validatePhone,
    validateUsername,
    validatePassword,
    PASSWORD_ERROR_MESSAGE
};

