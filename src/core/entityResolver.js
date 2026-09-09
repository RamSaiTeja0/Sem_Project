/**
 * Entity Resolution Engine — Phase B2.5
 *
 * Resolves AI-extracted timetable entities (classes, subjects, faculty, rooms)
 * against the authoritative, branch-scoped master catalog.
 *
 * STRICT ARCHITECTURAL INVARIANT:
 * NEVER silently create or register new faculty, subjects, rooms, or classes
 * from Gemini vision/AI output.
 *
 * Any extracted entity that cannot be confidently matched to an existing catalog
 * entity is flagged as UNRESOLVED. Timetable approval is blocked until all
 * unresolved entities are mapped or explicitly registered by an authorized HOS.
 */

const db = require('../db/pool');
const store = require('../data/store');

/**
 * Normalizes text for comparison (case-insensitive, single spacing, stripped punctuation).
 */
function normalizeName(str) {
    if (!str) return '';
    return String(str)
        .toUpperCase()
        .replace(/^(DR|PROF|SRI|MR|MRS|MS)\.?\s+/i, '')
        .replace(/[.\-_/\\]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Retrieve current branch catalog records from PostgreSQL or in-memory store.
 */
async function fetchBranchCatalog(departmentCode) {
    const dept = String(departmentCode || '').toUpperCase();

    if (db.isConfigured() && store.usingDatabase) {
        try {
            // Find department ID
            const deptRes = await db.query('SELECT id, code, name FROM departments WHERE UPPER(code) = $1', [dept]);
            const deptId = deptRes.rows.length > 0 ? deptRes.rows[0].id : null;

            const [classRows, subjectRows, facultyRows, roomRows] = await Promise.all([
                db.query(`SELECT id, code, semester, academic_year AS "academicYear"
                            FROM classes
                           WHERE department_id = $1 OR department_id IS NULL`, [deptId]),
                db.query(`SELECT id, code, name, subject_type AS "type"
                            FROM subjects
                           WHERE department_id = $1 OR department_id IS NULL`, [deptId]),
                db.query(`SELECT id, code, name, designation, status
                            FROM faculty
                           WHERE (department_id = $1 OR department_id IS NULL) AND status <> 'inactive'`, [deptId]),
                db.query(`SELECT id, code, name, room_type AS "type" FROM rooms`)
            ]);

            return {
                classes: classRows.rows,
                subjects: subjectRows.rows,
                faculty: facultyRows.rows,
                rooms: roomRows.rows
            };
        } catch (err) {
            // Fall back to memory store below
        }
    }

    // In-memory catalog
    const source = store.source || {};
    const classes = (source.classes || [])
        .filter(c => !c.department || c.department.toUpperCase() === dept)
        .map((c, idx) => ({
            id: idx + 1,
            code: c.class || c.code || c.name,
            semester: c.semester || null,
            academicYear: c.academicYear || null
        }));

    const subjects = (source.subjects || [])
        .filter(s => !s.department || s.department.toUpperCase() === dept)
        .map((s, idx) => ({
            id: idx + 1,
            code: s.code || null,
            name: s.name,
            type: s.type || 'theory'
        }));

    const faculty = (source.faculty || [])
        .filter(f => !f.department || f.department.toUpperCase() === dept)
        .map((f, idx) => ({
            id: f.id || (idx + 1),
            code: f.id || f.code,
            name: f.name,
            status: f.status || 'active'
        }));

    const rooms = (source.rooms || []).map((r, idx) => ({
        id: idx + 1,
        code: r.code,
        name: r.name || r.code
    }));

    return { classes, subjects, faculty, rooms };
}

/**
 * Resolve an extracted B2.1 JSON contract against the branch catalog.
 *
 * @param {Object} contract - Extracted B2.1 timetable JSON
 * @param {string} departmentCode - Authoritative department/branch
 * @param {Object} [mappings] - Stored HOS entity mappings { 'type:extractedText': targetId/targetCode }
 * @returns {Promise<Object>} Resolution report
 */
async function resolveContract(contract, departmentCode, mappings = {}) {
    if (!contract || !Array.isArray(contract.entries)) {
        return {
            ok: false,
            unresolvedEntities: [{
                entityType: 'contract',
                extractedText: 'contract',
                reason: 'Invalid contract or missing entries array'
            }],
            resolvedMap: {}
        };
    }

    const catalog = await fetchBranchCatalog(departmentCode);
    const unresolvedMap = new Map(); // key -> unresolved record
    const resolvedMap = {
        class: null,
        subjects: new Map(), // extractedKey -> catalog subject
        faculty: new Map(),  // extractedKey -> catalog faculty
        rooms: new Map()     // extractedKey -> catalog room
    };

    // 1. Resolve Class
    const targetClassName = contract.class_name ? String(contract.class_name).trim() : '';
    const classMappingKey = `class:${targetClassName}`;
    let matchedClass = null;

    if (mappings && mappings[classMappingKey]) {
        const target = mappings[classMappingKey];
        matchedClass = catalog.classes.find(c =>
            String(c.id) === String(target.targetId || target.id) ||
            c.code.toUpperCase() === String(target.targetCode || target.code || '').toUpperCase()
        );
    }

    if (!matchedClass && targetClassName) {
        matchedClass = catalog.classes.find(c =>
            c.code.toUpperCase() === targetClassName.toUpperCase()
        );
    }

    if (matchedClass) {
        resolvedMap.class = matchedClass;
    } else if (targetClassName) {
        unresolvedMap.set(`class:${targetClassName}`, {
            entityType: 'class',
            extractedText: targetClassName,
            slotsAffected: ['ALL_ENTRIES'],
            reason: `Class "${targetClassName}" is not registered in the ${departmentCode} branch catalog.`
        });
    }

    // 2. Resolve Entries (Subjects, Faculty, Rooms)
    for (const entry of contract.entries) {
        if (entry.is_free) continue;

        const slotLabel = `${entry.day} P${entry.period}${entry.span_to ? `–P${entry.span_to}` : ''}`;

        // --- Subject Resolution ---
        const subjectText = (entry.subject_name || entry.subject_code || '').trim();
        const subjectCode = (entry.subject_code || '').trim();
        const subjMappingKey = `subject:${subjectText}`;

        if (subjectText) {
            let matchedSubject = null;

            if (mappings && mappings[subjMappingKey]) {
                const target = mappings[subjMappingKey];
                matchedSubject = catalog.subjects.find(s =>
                    String(s.id) === String(target.targetId || target.id) ||
                    (target.targetCode && s.code && s.code.toUpperCase() === target.targetCode.toUpperCase()) ||
                    (target.targetName && s.name && s.name.toUpperCase() === target.targetName.toUpperCase())
                );
            }

            if (!matchedSubject && subjectCode) {
                matchedSubject = catalog.subjects.find(s =>
                    s.code && s.code.toUpperCase() === subjectCode.toUpperCase()
                );
            }

            if (!matchedSubject) {
                const normExtracted = normalizeName(subjectText);
                matchedSubject = catalog.subjects.find(s =>
                    normalizeName(s.name) === normExtracted ||
                    (s.code && normalizeName(s.code) === normExtracted)
                );
            }

            if (matchedSubject) {
                resolvedMap.subjects.set(subjectText, matchedSubject);
            } else {
                const key = `subject:${subjectText}`;
                if (unresolvedMap.has(key)) {
                    unresolvedMap.get(key).slotsAffected.push(slotLabel);
                } else {
                    unresolvedMap.set(key, {
                        entityType: 'subject',
                        extractedText: subjectText,
                        code: subjectCode || null,
                        slotsAffected: [slotLabel],
                        reason: `Subject "${subjectText}" is not found in the ${departmentCode} subject catalog.`
                    });
                }
            }
        }

        // --- Faculty Resolution ---
        // Activities (TPC, Library, etc.) with no faculty are valid unassigned activities
        const isActivityWithoutFaculty = entry.session_type === 'activity' && !entry.faculty_name;
        const facultyText = (entry.faculty_name || '').trim();

        if (!isActivityWithoutFaculty && facultyText) {
            const facMappingKey = `faculty:${facultyText}`;
            let matchedFaculty = null;

            if (mappings && mappings[facMappingKey]) {
                const target = mappings[facMappingKey];
                matchedFaculty = catalog.faculty.find(f =>
                    String(f.id) === String(target.targetId || target.id) ||
                    (target.targetName && f.name && f.name.toUpperCase() === target.targetName.toUpperCase())
                );
            }

            if (!matchedFaculty) {
                matchedFaculty = catalog.faculty.find(f =>
                    f.name.toUpperCase() === facultyText.toUpperCase() ||
                    (f.code && f.code.toUpperCase() === facultyText.toUpperCase())
                );
            }

            if (!matchedFaculty) {
                const normExtracted = normalizeName(facultyText);
                matchedFaculty = catalog.faculty.find(f =>
                    normalizeName(f.name) === normExtracted
                );
            }

            if (matchedFaculty) {
                resolvedMap.faculty.set(facultyText, matchedFaculty);
            } else {
                const key = `faculty:${facultyText}`;
                if (unresolvedMap.has(key)) {
                    unresolvedMap.get(key).slotsAffected.push(slotLabel);
                } else {
                    unresolvedMap.set(key, {
                        entityType: 'faculty',
                        extractedText: facultyText,
                        slotsAffected: [slotLabel],
                        reason: `Faculty "${facultyText}" is not registered in the ${departmentCode} faculty roster.`
                    });
                }
            }
        }

        // --- Room Resolution (Nullable) ---
        const roomText = (entry.room_code || '').trim();
        if (roomText) {
            const roomMappingKey = `room:${roomText}`;
            let matchedRoom = null;

            if (mappings && mappings[roomMappingKey]) {
                const target = mappings[roomMappingKey];
                matchedRoom = catalog.rooms.find(r =>
                    String(r.id) === String(target.targetId || target.id) ||
                    r.code.toUpperCase() === String(target.targetCode || target.code || '').toUpperCase()
                );
            }

            if (!matchedRoom) {
                matchedRoom = catalog.rooms.find(r =>
                    r.code.toUpperCase() === roomText.toUpperCase()
                );
            }

            if (matchedRoom) {
                resolvedMap.rooms.set(roomText, matchedRoom);
            }
            // Room is optional in TecSubstitution schema; unlisted room can be null or mapped
        }
    }

    const unresolvedEntities = Array.from(unresolvedMap.values());

    return {
        ok: unresolvedEntities.length === 0,
        unresolvedCount: unresolvedEntities.length,
        unresolvedEntities,
        resolvedMap: {
            class: resolvedMap.class,
            subjects: Object.fromEntries(resolvedMap.subjects),
            faculty: Object.fromEntries(resolvedMap.faculty),
            rooms: Object.fromEntries(resolvedMap.rooms)
        },
        catalogCounts: {
            classes: catalog.classes.length,
            subjects: catalog.subjects.length,
            faculty: catalog.faculty.length,
            rooms: catalog.rooms.length
        }
    };
}

module.exports = {
    resolveContract,
    fetchBranchCatalog,
    normalizeName
};
