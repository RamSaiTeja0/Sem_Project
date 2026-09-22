/**
 * Timetable Contract Validator — Phase B2.3
 *
 * Enforces the approved Phase B2.1 LLM JSON Contract (docs/PHASE_B2_1_JSON_CONTRACT.md)
 * and verifies authoritative upload metadata ownership (branch, faculty, upload_type).
 */

const { normalizeDayName, normalizePeriodNumber, WORKING_DAYS } = require('./normalizer');
const store = require('../data/store');

const CONTRACT_VERSION = '2.1';
const ALLOWED_TIMETABLE_TYPES = new Set(['MASTER_TIMETABLE', 'FACULTY_TIMETABLE']);
const ALLOWED_SESSION_TYPES = new Set(['theory', 'lab', 'activity']);
const NON_FACULTY_PATTERN = /\b(library|counselling|counseling|tpc|placement|training|sports|games|seminar|mentoring|assembly|activity|break|lunch)\b/i;

function isNonFacultyActivity(subject, type) {
    return type === 'activity' || NON_FACULTY_PATTERN.test(subject || '');
}

/**
 * Validate extracted JSON payload against B2.1 specification and upload ownership metadata.
 *
 * @param {object} payload - The extracted JSON data
 * @param {object} uploadRecord - The authoritative upload record from timetable_uploads
 * @param {object} options - Optional flags (e.g. skipCatalogCheck)
 * @returns {{ ok: boolean, code?: string, errors: string[], conflicts: object[], missingReferences: string[] }}
 */
function validateExtractedContract(payload, uploadRecord = null, options = {}) {
    const errors = [];
    const conflicts = [];
    const missingReferences = [];
    let code = null;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return {
            ok: false,
            code: 'INVALID_JSON_STRUCTURE',
            errors: ['Extracted data must be a valid JSON object.'],
            conflicts,
            missingReferences
        };
    }

    // 1. Version check
    if (payload.contract_version !== CONTRACT_VERSION) {
        errors.push(`Invalid contract_version "${payload.contract_version}". Expected "${CONTRACT_VERSION}".`);
        code = code || 'INVALID_CONTRACT_VERSION';
    }

    // 2. Timetable type check
    if (!payload.timetable_type || !ALLOWED_TIMETABLE_TYPES.has(payload.timetable_type)) {
        errors.push(`Invalid timetable_type "${payload.timetable_type}". Must be "MASTER_TIMETABLE" or "FACULTY_TIMETABLE".`);
        code = code || 'INVALID_TIMETABLE_TYPE';
    }

    // 3. Department / Branch code check
    const deptCode = payload.department_code ? String(payload.department_code).trim().toUpperCase() : '';
    if (!deptCode || !/^[A-Z0-9-]{2,16}$/.test(deptCode)) {
        errors.push('department_code is required and must be 2–16 alphanumeric characters or hyphens.');
        code = code || 'INVALID_DEPARTMENT_CODE';
    }

    // 4. Authoritative Upload Metadata Checks
    if (uploadRecord) {
        // Branch Authority check
        if (uploadRecord.departmentCode) {
            const authDept = String(uploadRecord.departmentCode).trim().toUpperCase();
            if (deptCode && deptCode !== authDept) {
                errors.push(`Branch mismatch: document claims branch "${deptCode}", but upload belongs to branch "${authDept}".`);
                code = 'BRANCH_MISMATCH';
            }
        }

        // Upload Type Authority check
        if (uploadRecord.uploadType && payload.timetable_type) {
            if (uploadRecord.uploadType !== payload.timetable_type) {
                errors.push(`Upload type mismatch: document claims "${payload.timetable_type}", but upload is "${uploadRecord.uploadType}".`);
                code = 'TIMETABLE_TYPE_MISMATCH';
            }
        }

        // Faculty Authority check for FACULTY_TIMETABLE
        if (uploadRecord.uploadType === 'FACULTY_TIMETABLE' && uploadRecord.facultyId) {
            const authFaculty = String(uploadRecord.facultyId).trim().toUpperCase();
            if (payload.faculty_name) {
                const docFaculty = String(payload.faculty_name).trim().toUpperCase();
                if (docFaculty !== authFaculty) {
                    errors.push(`Faculty mismatch: document claims "${payload.faculty_name}", but upload belongs to "${uploadRecord.facultyId}".`);
                    code = 'FACULTY_MISMATCH';
                }
            }
        }
    }

    // 5. Grid structure checks (days, periods, entries)
    if (!Array.isArray(payload.days) || payload.days.length === 0) {
        errors.push('days array is required and must contain at least one day.');
        code = code || 'MISSING_REQUIRED_FIELDS';
    } else {
        payload.days.forEach(d => {
            const normalized = normalizeDayName(d);
            if (!normalized) {
                errors.push(`Invalid day "${d}" in days array.`);
                code = code || 'INVALID_DAY';
            }
        });
    }

    const contractMaxPeriods = Array.from({ length: 12 }, (_, i) => i + 1);

    if (!Array.isArray(payload.periods) || payload.periods.length === 0) {
        errors.push('periods array is required and must contain at least one period.');
        code = code || 'MISSING_REQUIRED_FIELDS';
    } else {
        payload.periods.forEach(p => {
            const num = normalizePeriodNumber(p, contractMaxPeriods);
            if (num == null || num < 1 || num > 12) {
                errors.push(`Invalid period "${p}" in periods array. Expected 1–12.`);
                code = code || 'INVALID_PERIOD';
            }
        });
    }

    if (!Array.isArray(payload.entries)) {
        errors.push('entries array is required.');
        code = code || 'MISSING_REQUIRED_FIELDS';
        return {
            ok: false,
            code: code || 'VALIDATION_FAILED',
            errors,
            conflicts,
            missingReferences
        };
    }

    // Optional legend validation (if present, must be arrays)
    if (payload.faculty_legend !== undefined && payload.faculty_legend !== null && !Array.isArray(payload.faculty_legend)) {
        errors.push('faculty_legend must be an array when provided.');
        code = code || 'INVALID_SCHEMA';
    }

    if (payload.subject_legend !== undefined && payload.subject_legend !== null && !Array.isArray(payload.subject_legend)) {
        errors.push('subject_legend must be an array when provided.');
        code = code || 'INVALID_SCHEMA';
    }

    // 6. Detailed Entry Validation & Internal Slot Conflict Detection
    const classSlotSeen = new Map();
    const facultySlotSeen = new Map();
    const roomSlotSeen = new Map();

    const rootClass = payload.class_name ? String(payload.class_name).trim() : null;
    const rootFaculty = payload.faculty_name ? String(payload.faculty_name).trim() : null;
    const payloadDays = Array.isArray(payload.days) && payload.days.length > 0
        ? payload.days.map(d => String(d).trim())
        : WORKING_DAYS;
    const payloadPeriods = Array.isArray(payload.periods) && payload.periods.length > 0
        ? payload.periods.map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p >= 1 && p <= 12)
        : contractMaxPeriods;

    payload.entries.forEach((entry, idx) => {
        const line = idx + 1;
        if (!entry || typeof entry !== 'object') {
            errors.push(`Entry ${line}: must be an object.`);
            code = code || 'INVALID_ENTRY';
            return;
        }

        const normDay = normalizeDayName(entry.day, payloadDays);
        if (!normDay) {
            errors.push(`Entry ${line}: invalid day "${entry.day}".`);
            code = code || 'INVALID_DAY';
        }

        const normPeriod = normalizePeriodNumber(entry.period, payloadPeriods);
        if (normPeriod == null || normPeriod < 1 || normPeriod > 12) {
            errors.push(`Entry ${line}: invalid period "${entry.period}". Expected 1–12.`);
            code = code || 'INVALID_PERIOD';
        }

        if (entry.span_to != null) {
            const span = normalizePeriodNumber(entry.span_to, contractMaxPeriods);
            if (span == null || span < normPeriod || span > 12) {
                errors.push(`Entry ${line}: span_to "${entry.span_to}" must be between period ${normPeriod} and 12.`);
                code = code || 'INVALID_PERIOD';
            }
        }

        const sessionType = entry.session_type ? String(entry.session_type).trim().toLowerCase() : 'theory';
        if (!ALLOWED_SESSION_TYPES.has(sessionType)) {
            errors.push(`Entry ${line}: invalid session_type "${entry.session_type}". Must be "theory", "lab", or "activity".`);
            code = code || 'INVALID_SESSION_TYPE';
        }

        const isFree = Boolean(entry.is_free);
        if (isFree) {
            // Free slot: skip subject & faculty requirements
            return;
        }

        // Scheduled entry: subject is required
        const subject = entry.subject_name ? String(entry.subject_name).trim() : null;
        if (!subject) {
            errors.push(`Entry ${line}: subject_name is required for scheduled slot.`);
            code = code || 'MISSING_REQUIRED_FIELDS';
        }

        // Class name resolution
        const className = (entry.class_name ? String(entry.class_name).trim() : null) || rootClass;
        if (!className) {
            errors.push(`Entry ${line}: class_name is required for scheduled slot.`);
            code = code || 'MISSING_REQUIRED_FIELDS';
        }

        // Faculty name resolution
        let faculty = entry.faculty_name ? String(entry.faculty_name).trim() : null;
        if (!faculty && payload.timetable_type === 'FACULTY_TIMETABLE') {
            faculty = rootFaculty || (uploadRecord && uploadRecord.facultyId);
        }

        const isActivity = isNonFacultyActivity(subject, sessionType);
        if (!isActivity && !faculty) {
            errors.push(`Entry ${line}: faculty_name is required for non-activity class.`);
            code = code || 'MISSING_FACULTY';
        }

        const room = entry.room_code ? String(entry.room_code).trim() : null;

        // Internal conflict checks across periods (including spans)
        if (normDay && normPeriod != null) {
            const startP = normPeriod;
            const endP = (entry.span_to != null && normalizePeriodNumber(entry.span_to)) || startP;

            for (let p = startP; p <= endP; p++) {
                const slotKey = `${normDay}|${p}`;

                // Check class clash
                if (className) {
                    const classKey = `${className.toUpperCase()}|${slotKey}`;
                    if (classSlotSeen.has(classKey)) {
                        const clash = {
                            code: 'CLASS_BUSY',
                            message: `Class "${className}" has conflicting entries at ${normDay} P${p} (${classSlotSeen.get(classKey)} vs ${subject})`
                        };
                        conflicts.push(clash);
                        code = code || 'SLOT_CONFLICT';
                    } else {
                        classSlotSeen.set(classKey, subject);
                    }
                }

                // Check faculty clash
                if (faculty) {
                    const facKey = `${faculty.toUpperCase()}|${slotKey}`;
                    if (facultySlotSeen.has(facKey)) {
                        const clash = {
                            code: 'FACULTY_BUSY',
                            message: `Faculty "${faculty}" is double-booked at ${normDay} P${p} (${facultySlotSeen.get(facKey)} vs ${subject} [${className}])`
                        };
                        conflicts.push(clash);
                        code = code || 'SLOT_CONFLICT';
                    } else {
                        facultySlotSeen.set(facKey, subject);
                    }
                }

                // Check room clash
                if (room) {
                    const roomKey = `${room.toUpperCase()}|${slotKey}`;
                    if (roomSlotSeen.has(roomKey)) {
                        const clash = {
                            code: 'ROOM_BUSY',
                            message: `Room "${room}" is double-booked at ${normDay} P${p} (${roomSlotSeen.get(roomKey)} vs ${className})`
                        };
                        conflicts.push(clash);
                        code = code || 'SLOT_CONFLICT';
                    } else {
                        roomSlotSeen.set(roomKey, className);
                    }
                }
            }
        }
    });

    // 7. Catalog Reference Checks (if catalog is populated and check not disabled)
    if (!options.skipCatalogCheck && store.engine) {
        const meta = store.engine.getMeta();
        const knownClasses = meta.classes || [];
        const knownFaculty = store.engine.getFaculty() || [];
        const declaredSubjects = (store.source && store.source.subjects) || [];

        const seenMissingClasses = new Set();
        const seenMissingSubjects = new Set();
        const seenMissingFaculty = new Set();

        payload.entries.forEach((entry, idx) => {
            if (entry.is_free) return;
            const line = idx + 1;
            const className = (entry.class_name ? String(entry.class_name).trim() : null) || rootClass;
            const subject = entry.subject_name ? String(entry.subject_name).trim() : null;
            let faculty = entry.faculty_name ? String(entry.faculty_name).trim() : null;
            if (!faculty && payload.timetable_type === 'FACULTY_TIMETABLE') {
                faculty = rootFaculty || (uploadRecord && uploadRecord.facultyId);
            }

            if (knownClasses.length > 0 && className && !knownClasses.some(c => c.toUpperCase() === className.toUpperCase())) {
                if (!seenMissingClasses.has(className)) {
                    seenMissingClasses.add(className);
                    missingReferences.push(`class "${className}"`);
                }
            }

            if (declaredSubjects.length > 0 && subject && !isNonFacultyActivity(subject, entry.session_type)) {
                const foundSubject = declaredSubjects.some(s => s.name.toUpperCase() === subject.toUpperCase() ||
                    (entry.subject_code && s.code && s.code.toUpperCase() === String(entry.subject_code).toUpperCase()));
                if (!foundSubject && !seenMissingSubjects.has(subject)) {
                    seenMissingSubjects.add(subject);
                    missingReferences.push(`subject "${subject}"`);
                }
            }

            if (knownFaculty.length > 0 && faculty && !isNonFacultyActivity(subject, entry.session_type)) {
                const foundFaculty = knownFaculty.some(f => f.name.toUpperCase() === faculty.toUpperCase());
                if (!foundFaculty && !seenMissingFaculty.has(faculty)) {
                    seenMissingFaculty.add(faculty);
                    missingReferences.push(`faculty "${faculty}"`);
                }
            }
        });

        if (missingReferences.length > 0) {
            code = code || 'UNKNOWN_REFERENCE';
            errors.push(`Unknown catalog reference(s): ${missingReferences.join(', ')}`);
        }
    }

    const ok = errors.length === 0 && conflicts.length === 0;

    return {
        ok,
        code: ok ? null : (code || 'VALIDATION_FAILED'),
        errors,
        conflicts,
        missingReferences
    };
}

module.exports = {
    validateExtractedContract,
    CONTRACT_VERSION
};
