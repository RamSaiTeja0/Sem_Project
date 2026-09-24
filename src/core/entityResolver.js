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
 * entity is flagged as UNRESOLVED with clear categories: Class, Faculty, Subject, Room.
 * Timetable approval is blocked until all unresolved entities are mapped or explicitly
 * registered by an authorized HOS.
 */

const db = require('../db/pool');
const store = require('../data/store');

const STANDARD_ACTIVITIES = new Set([
    'TPC', 'LIBRARY', 'SPORTS', 'GAMES', 'MENTORING', 'PLACEMENT', 'TRAINING',
    'SEMINAR', 'COUNSELLING', 'ASSEMBLY', 'REMEDIAL', 'TUTORIAL', 'PROJECT',
    'NSS', 'YOGA', 'NCC', 'CLUB', 'BREAK', 'LUNCH', 'RECESS', 'FREE', 'NIL'
]);

/**
 * Checks if a subject or session text corresponds to a scheduled non-curricular activity.
 */
function isScheduledActivity(text, sessionType) {
    if (sessionType === 'activity') return true;
    if (!text || typeof text !== 'string') return false;
    const clean = text.toUpperCase().replace(/[.\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (STANDARD_ACTIVITIES.has(clean)) return true;
    for (const act of STANDARD_ACTIVITIES) {
        if (clean === act || clean.startsWith(act + ' ') || clean.endsWith(' ' + act)) {
            return true;
        }
    }
    return false;
}

/**
 * Normalizes faculty name for comparison (strips honorifics, dots, hyphens, extra spaces).
 */
function normalizeName(str) {
    if (!str) return '';
    return String(str)
        .toUpperCase()
        .replace(/^(DR|PROF|SRI|MR|MRS|MS)\.?\s+/i, '')
        .replace(/[.\-_/\\,]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Checks if two faculty names match under normalized initial ordering or abbreviation rules.
 */
function nameTokensMatch(nameA, nameB) {
    if (!nameA || !nameB) return false;
    const normA = normalizeName(nameA);
    const normB = normalizeName(nameB);
    if (normA === normB) return true;

    const tokensA = normA.split(' ').filter(Boolean);
    const tokensB = normB.split(' ').filter(Boolean);
    if (tokensA.slice().sort().join(' ') === tokensB.slice().sort().join(' ')) return true;

    // Matches initials e.g. "G BHARATH REDDY" vs "BHARATH REDDY G"
    if (tokensA.length >= 2 && tokensB.length >= 2) {
        const longer = tokensA.length >= tokensB.length ? tokensA : tokensB;
        const shorter = tokensA.length < tokensB.length ? tokensA : tokensB;
        if (shorter.every(t => longer.includes(t))) return true;
    }
    return false;
}

/**
 * Normalizes subject string (ampersands, roman numerals, punctuation, Laboratory vs Lab).
 */
function normalizeSubject(str) {
    if (!str) return '';
    return String(str)
        .toUpperCase()
        .replace(/&/g, ' AND ')
        .replace(/\bLABORATORY\b/g, 'LAB')
        .replace(/\bII\b/g, '2')
        .replace(/\bIII\b/g, '3')
        .replace(/\bIV\b/g, '4')
        .replace(/\bV\b/g, '5')
        .replace(/\bVI\b/g, '6')
        .replace(/[.\-_/\\,()]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Checks if two subject representations match (by normalized name, code, or abbreviation).
 */
function subjectTokensMatch(subjA, subjB) {
    if (!subjA || !subjB) return false;
    const normA = normalizeSubject(subjA);
    const normB = normalizeSubject(subjB);
    if (normA === normB) return true;

    const tokA = normA.split(' ').filter(Boolean).sort().join(' ');
    const tokB = normB.split(' ').filter(Boolean).sort().join(' ');
    return tokA === tokB;
}

/**
 * Normalizes class code (removes dashes, spaces, punctuation).
 */
function normalizeClass(str) {
    if (!str) return '';
    return String(str)
        .toUpperCase()
        .replace(/[.\-_/\\,\s]+/g, '')
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
                db.query(`SELECT id, code, semester, academic_year AS "academicYear", department_id
                            FROM classes
                           WHERE department_id = $1 OR department_id IS NULL`, [deptId]),
                db.query(`SELECT id, code, name, subject_type AS "type", department_id
                            FROM subjects`),
                db.query(`SELECT f.id, f.code, f.name, f.designation, f.status, f.department_id,
                                 (u.id IS NOT NULL) AS "hasUserAccount"
                            FROM faculty f
                            LEFT JOIN users u ON (u.faculty_id = f.id OR UPPER(u.username) = UPPER(f.code) OR UPPER(u.name) = UPPER(f.name))
                           WHERE f.status <> 'inactive'`),
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
    const users = source.users || [];
    const classes = (source.classes || [])
        .filter(c => !c.department || c.department.toUpperCase() === dept)
        .map((c, idx) => ({
            id: idx + 1,
            code: c.class || c.code || c.name,
            semester: c.semester || null,
            academicYear: c.academicYear || null
        }));

    const subjects = (source.subjects || [])
        .map((s, idx) => ({
            id: idx + 1,
            code: s.code || null,
            name: s.name,
            type: s.type || 'theory'
        }));

    const faculty = (source.faculty || [])
        .map((f, idx) => ({
            id: f.id || (idx + 1),
            code: f.id || f.code,
            name: f.name,
            status: f.status || 'active',
            hasUserAccount: users.some(u => u.faculty_id === f.id || (u.name && u.name.toUpperCase() === f.name.toUpperCase()) || (u.username && u.username.toUpperCase() === String(f.code || f.name).toUpperCase()))
        }));

    const rooms = (source.rooms || []).map((r, idx) => ({
        id: idx + 1,
        code: r.code,
        name: r.name || r.code
    }));

    return { classes, subjects, faculty, rooms };
}

/**
 * Auto-registers an extracted faculty name into the branch faculty catalog
 * as a catalog reference (WITHOUT creating any user login accounts or credentials).
 */
async function registerFacultyCatalogReference(facultyText, departmentCode, catalog) {
    const dept = String(departmentCode || 'General').toUpperCase();
    const cleanName = String(facultyText).trim();
    if (!cleanName) return null;

    if (db.isConfigured() && store.usingDatabase) {
        let deptRes = await db.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [dept]);
        let deptId = deptRes.rows.length > 0 ? deptRes.rows[0].id : null;
        if (!deptId) {
            const insDept = await db.query(
                'INSERT INTO departments (code, name, active) VALUES (UPPER($1), $1, true) RETURNING id', [dept]
            );
            deptId = insDept.rows[0].id;
        }

        const code = (dept + '_' + cleanName.replace(/[^A-Z0-9]/gi, '_').toUpperCase()).slice(0, 30);
        const existing = await db.query(
            'SELECT id, code, name, designation, status, department_id, false AS "hasUserAccount" FROM faculty WHERE UPPER(name) = UPPER($1) OR UPPER(code) = UPPER($2) LIMIT 1',
            [cleanName, code]
        );
        if (existing.rows.length > 0) {
            if (catalog && Array.isArray(catalog.faculty) && !catalog.faculty.some(f => f.id === existing.rows[0].id)) {
                catalog.faculty.push(existing.rows[0]);
            }
            return existing.rows[0];
        }

        const res = await db.query(
            `INSERT INTO faculty (code, name, department_id, designation, status, max_weekly_periods)
             VALUES ($1, $2, $3, 'Faculty', 'active', 28)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, department_id = COALESCE(faculty.department_id, EXCLUDED.department_id)
             RETURNING id, code, name, designation, status, department_id, false AS "hasUserAccount"`,
            [code, cleanName, deptId]
        );
        const newRecord = res.rows[0];
        if (catalog && Array.isArray(catalog.faculty)) {
            catalog.faculty.push(newRecord);
        }
        return newRecord;
    }

    // In-memory catalog
    const source = store.source || {};
    if (!source.faculty) source.faculty = [];
    let existingMem = source.faculty.find(f => f.name && f.name.toUpperCase() === cleanName.toUpperCase());
    if (existingMem) {
        return existingMem;
    }
    const newId = source.faculty.length + 1;
    const newRecord = {
        id: newId,
        code: cleanName,
        name: cleanName,
        department: dept,
        status: 'active',
        hasUserAccount: false
    };
    source.faculty.push(newRecord);
    if (catalog && Array.isArray(catalog.faculty)) {
        catalog.faculty.push(newRecord);
    }
    return newRecord;
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
            unresolvedCount: 1,
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
    const informationalWarnings = new Set(); // set of non-blocking informational notes
    const resolvedMap = {
        class: null,
        subjects: new Map(), // extractedKey -> catalog subject
        faculty: new Map(),  // extractedKey -> catalog faculty
        rooms: new Map()     // extractedKey -> catalog room
    };

    // Prepare legend lookups if present in contract
    const subjectLegends = Array.isArray(contract.subject_legend) ? contract.subject_legend : [];
    const facultyLegends = Array.isArray(contract.faculty_legend) ? contract.faculty_legend : [];

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
            c.code.toUpperCase() === targetClassName.toUpperCase() ||
            normalizeClass(c.code) === normalizeClass(targetClassName)
        );
    }

    if (matchedClass) {
        resolvedMap.class = matchedClass;
    } else if (targetClassName) {
        unresolvedMap.set(`class:${targetClassName}`, {
            entityType: 'class',
            category: 'Class',
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
        const isActivity = isScheduledActivity(subjectText, entry.session_type);
        const subjMappingKey = `subject:${subjectText}`;

        if (isActivity) {
            // Scheduled non-curricular activity (TPC, Library, Sports, etc.)
            resolvedMap.subjects.set(subjectText, {
                id: null,
                code: subjectCode || subjectText,
                name: subjectText,
                type: 'activity',
                isActivity: true
            });
        } else if (subjectText) {
            let matchedSubject = null;

            // Check explicit HOD mapping
            if (mappings && mappings[subjMappingKey]) {
                const target = mappings[subjMappingKey];
                matchedSubject = catalog.subjects.find(s =>
                    String(s.id) === String(target.targetId || target.id) ||
                    (target.targetCode && s.code && s.code.toUpperCase() === target.targetCode.toUpperCase()) ||
                    (target.targetName && s.name && s.name.toUpperCase() === target.targetName.toUpperCase())
                );
            }

            // Direct code match
            if (!matchedSubject && subjectCode) {
                matchedSubject = catalog.subjects.find(s =>
                    s.code && s.code.toUpperCase() === subjectCode.toUpperCase()
                );
            }

            // Normalized name / code match
            if (!matchedSubject) {
                matchedSubject = catalog.subjects.find(s =>
                    subjectTokensMatch(s.name, subjectText) ||
                    (s.code && subjectTokensMatch(s.code, subjectText)) ||
                    (s.code && subjectCode && subjectTokensMatch(s.code, subjectCode))
                );
            }

            // Cross-reference with contract subject legend
            if (!matchedSubject && subjectLegends.length > 0) {
                const legendEntry = subjectLegends.find(l =>
                    (l.name && subjectTokensMatch(l.name, subjectText)) ||
                    (l.short_name && subjectTokensMatch(l.short_name, subjectText)) ||
                    (l.code && subjectCode && subjectTokensMatch(l.code, subjectCode))
                );
                if (legendEntry) {
                    matchedSubject = catalog.subjects.find(s =>
                        (legendEntry.name && subjectTokensMatch(s.name, legendEntry.name)) ||
                        (legendEntry.short_name && subjectTokensMatch(s.name, legendEntry.short_name)) ||
                        (legendEntry.code && s.code && subjectTokensMatch(s.code, legendEntry.code))
                    );
                }
            }

            // Check composite / dual lab splitting (e.g. "EM-II LAB / PE LAB")
            if (!matchedSubject && subjectText.includes('/')) {
                const parts = subjectText.split('/').map(p => p.trim()).filter(Boolean);
                const matchedParts = parts.map(p =>
                    catalog.subjects.find(s => subjectTokensMatch(s.name, p) || (s.code && subjectTokensMatch(s.code, p)))
                );
                if (matchedParts.every(Boolean)) {
                    matchedSubject = {
                        id: null,
                        code: matchedParts.map(p => p.code || p.name).join(' / '),
                        name: subjectText,
                        type: 'lab',
                        isJoint: true,
                        constituents: matchedParts
                    };
                }
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
                        category: 'Subject',
                        extractedText: subjectText,
                        code: subjectCode || null,
                        slotsAffected: [slotLabel],
                        reason: `Subject "${subjectText}" is not found in the ${departmentCode} subject catalog.`
                    });
                }
            }
        }

        // --- Faculty Resolution ---
        const facultyText = (entry.faculty_name || '').trim();
        const isActivityWithoutFaculty = isActivity && !facultyText;

        if (!isActivityWithoutFaculty && facultyText) {
            const facMappingKey = `faculty:${facultyText}`;
            let matchedFaculty = null;

            // Check explicit HOD mapping
            if (mappings && mappings[facMappingKey]) {
                const target = mappings[facMappingKey];
                matchedFaculty = catalog.faculty.find(f =>
                    String(f.id) === String(target.targetId || target.id) ||
                    (target.targetName && f.name && String(f.name).toUpperCase() === String(target.targetName).toUpperCase()) ||
                    (target.targetCode && f.code && String(f.code).toUpperCase() === String(target.targetCode).toUpperCase())
                );
            }

            // Direct name / code match
            if (!matchedFaculty) {
                matchedFaculty = catalog.faculty.find(f =>
                    (f.name && String(f.name).toUpperCase() === facultyText.toUpperCase()) ||
                    (f.code != null && String(f.code).toUpperCase() === facultyText.toUpperCase())
                );
            }

            // Normalized token match
            if (!matchedFaculty) {
                matchedFaculty = catalog.faculty.find(f =>
                    (f.name && nameTokensMatch(f.name, facultyText)) ||
                    (f.code != null && nameTokensMatch(String(f.code), facultyText))
                );
            }

            // Cross-reference with contract faculty legend
            if (!matchedFaculty && facultyLegends.length > 0) {
                const legendEntry = facultyLegends.find(l =>
                    (l.name && nameTokensMatch(l.name, facultyText)) ||
                    (l.code && nameTokensMatch(l.code, facultyText))
                );
                if (legendEntry) {
                    matchedFaculty = catalog.faculty.find(f =>
                        (legendEntry.name && nameTokensMatch(f.name, legendEntry.name)) ||
                        (legendEntry.code && f.code && nameTokensMatch(f.code, legendEntry.code))
                    );
                }
            }

            if (!matchedFaculty && facultyText) {
                // Check composite joint faculty splitting (e.g. "M.DALAYYA / T.RAJENDRA PRASAD")
                if (facultyText.includes('/')) {
                    const parts = facultyText.split('/').map(p => p.trim()).filter(Boolean);
                    const matchedParts = [];
                    for (const p of parts) {
                        let m = catalog.faculty.find(f => nameTokensMatch(f.name, p) || (f.code && nameTokensMatch(f.code, p)));
                        if (!m) {
                            try {
                                m = await registerFacultyCatalogReference(p, departmentCode, catalog);
                                if (m) {
                                    informationalWarnings.add(`Faculty '${p}' was found in the uploaded timetable but does not have an account in this branch. The timetable entry was registered, but the faculty account is not available.`);
                                }
                            } catch (_) {}
                        }
                        if (m) matchedParts.push(m);
                    }
                    if (matchedParts.length === parts.length) {
                        matchedFaculty = {
                            id: null,
                            code: matchedParts.map(p => p.code || p.name).join(' / '),
                            name: facultyText,
                            isJoint: true,
                            constituents: matchedParts
                        };
                    }
                }

                if (!matchedFaculty) {
                    try {
                        matchedFaculty = await registerFacultyCatalogReference(facultyText, departmentCode, catalog);
                        if (matchedFaculty) {
                            informationalWarnings.add(`Faculty '${facultyText}' was found in the uploaded timetable but does not have an account in this branch. The timetable entry was registered, but the faculty account is not available.`);
                        }
                    } catch (_) {}
                }
            }

            if (matchedFaculty) {
                if (matchedFaculty.hasUserAccount === false) {
                    informationalWarnings.add(`Faculty '${matchedFaculty.name || facultyText}' was found in the uploaded timetable but does not have an account in this branch. The timetable entry was registered, but the faculty account is not available.`);
                }
                resolvedMap.faculty.set(facultyText, matchedFaculty);
            } else {
                const key = `faculty:${facultyText}`;
                if (unresolvedMap.has(key)) {
                    unresolvedMap.get(key).slotsAffected.push(slotLabel);
                } else {
                    unresolvedMap.set(key, {
                        entityType: 'faculty',
                        category: 'Faculty',
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
        }
    }

    const unresolvedEntities = Array.from(unresolvedMap.values());
    const warningsList = Array.from(informationalWarnings);

    return {
        ok: unresolvedEntities.length === 0,
        unresolvedCount: unresolvedEntities.length,
        unresolvedEntities,
        warnings: warningsList,
        informationalWarnings: warningsList,
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
    normalizeName,
    normalizeSubject,
    normalizeClass,
    nameTokensMatch,
    subjectTokensMatch,
    isScheduledActivity
};
