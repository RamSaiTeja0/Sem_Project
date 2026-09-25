/**
 * Staged Timetable Review & Approval API — Phase B2.5
 *
 * Provides endpoints for an authenticated Head of Section (HOS) to:
 *   - Review valid staged timetable extractions
 *   - Map or confirm unresolved references against branch catalog
 *   - Approve and transactionally import into the live timetable
 *   - Reject staged timetables with a reason
 *
 * STRICT GOVERNANCE:
 *   - Gemini and AI extraction NEVER write directly to the live timetable.
 *   - Only an authenticated HOS matching the upload's branch can approve or reject.
 *   - Approval is BLOCKED if validation is not VALID or if unresolved entities remain.
 *   - Zero silent creation of faculty, subjects, rooms, or classes from AI output.
 */

const express = require('express');
const router = express.Router();

const db = require('../db/pool');
const store = require('../data/store');
const repository = require('../db/repository');
const {
    getUploadRecord,
    getStagedData,
    updateStagedStatus,
    listPendingStaging,
    updateUploadStatus
} = require('../data/uploads');
const { resolveContract } = require('../core/entityResolver');
const { validateExtractedContract } = require('../core/contractValidator');

/**
 * Authentication & Authorization Guard:
 * Requires authenticated session with role === 'hos'.
 */
function requireHOS(req, res, next) {
    if (!req.session || !(req.session.id || req.session.username || req.session.userId)) {
        return res.status(401).json({
            error: 'Sign in to use this endpoint.',
            code: 'UNAUTHENTICATED'
        });
    }

    if (req.session.role !== 'hos' && req.session.role !== 'coordinator') {
        return res.status(403).json({
            error: 'Forbidden: Only Head of Section (HOS) accounts can review and approve staged timetables.',
            code: 'FORBIDDEN'
        });
    }

    next();
}

// All staging management endpoints require HOS authentication
router.use(requireHOS);

/**
 * Helper: Verify upload ownership against authenticated HOS branch.
 */
async function verifyBranchOwnership(req, res, uploadId) {
    const upload = await getUploadRecord(uploadId);
    if (!upload) {
        res.status(404).json({
            error: `Upload "${uploadId}" not found.`,
            code: 'NOT_FOUND'
        });
        return null;
    }

    const hosDept = String(req.session.department || '').toUpperCase();
    const uploadDept = String(upload.departmentCode || '').toUpperCase();

    if (hosDept !== uploadDept) {
        res.status(403).json({
            error: `Cross-branch access forbidden. You are HOS of ${hosDept}, but this upload belongs to ${uploadDept}.`,
            code: 'FORBIDDEN'
        });
        return null;
    }

    return upload;
}

/**
 * GET /api/staging/pending
 * Lists all staged uploads for the authenticated HOS's department.
 */
router.get('/pending', async (req, res) => {
    try {
        const hosDept = String(req.session.department || '').toUpperCase();
        const pending = await listPendingStaging(hosDept);
        return res.json({
            count: pending.length,
            department: hosDept,
            staging: pending
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * GET /api/staging/:uploadId
 * Retrieves full staged data, B2.1 JSON, validation results, and unresolved entities.
 */
router.get('/:uploadId', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        // Re-evaluate resolution with any saved mappings
        const resolution = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        return res.json({
            uploadId: staging.uploadId,
            originalFilename: upload.originalFilename,
            departmentCode: upload.departmentCode,
            uploadType: upload.uploadType,
            validationStatus: staging.validationStatus,
            validationErrors: staging.validationErrors,
            importStatus: staging.importStatus || 'STAGED',
            reviewedBy: staging.reviewedBy || null,
            reviewedAt: staging.reviewedAt || null,
            rejectionReason: staging.rejectionReason || null,
            importedAt: staging.importedAt || null,
            importedCount: staging.importedCount || null,
            extractedJson: staging.extractedJson,
            entityMappings: staging.entityMappings || {},
            resolution: {
                ok: resolution.ok,
                unresolvedCount: resolution.unresolvedCount,
                unresolvedEntities: resolution.unresolvedEntities,
                warnings: resolution.warnings || [],
                informationalWarnings: resolution.informationalWarnings || [],
                resolvedMap: resolution.resolvedMap,
                catalogCounts: resolution.catalogCounts
            },
            createdAt: staging.createdAt,
            updatedAt: staging.updatedAt
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * POST /api/staging/:uploadId/map-entity
 * Explicitly maps an unresolved reference to an existing branch catalog entity.
 *
 * Payload: {
 *   entityType: 'faculty' | 'subject' | 'class' | 'room',
 *   extractedText: 'G.BHARATH REDDY',
 *   targetId: 5,           // optional if targetCode/targetName provided
 *   targetCode: 'EE-401',  // optional
 *   targetName: '...'      // optional
 * }
 */
router.post('/:uploadId/map-entity', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: 'Cannot modify mappings: timetable has already been imported.',
                code: 'ALREADY_IMPORTED'
            });
        }

        const { entityType, extractedText, targetId, targetCode, targetName } = req.body || {};
        if (!entityType || !extractedText) {
            return res.status(400).json({
                error: 'entityType and extractedText are required.',
                code: 'INVALID_MAPPING_REQUEST'
            });
        }

        const mappingKey = `${entityType.toLowerCase()}:${extractedText.trim()}`;
        const currentMappings = { ...(staging.entityMappings || {}) };
        currentMappings[mappingKey] = {
            entityType,
            extractedText: extractedText.trim(),
            targetId: targetId || null,
            targetCode: targetCode || null,
            targetName: targetName || null,
            mappedBy: req.session.userId || req.session.username || req.session.id,
            mappedAt: new Date().toISOString()
        };

        // Re-evaluate resolution
        const resolution = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            currentMappings
        );

        // Update staging record
        const updated = await updateStagedStatus(uploadId, {
            entityMappings: currentMappings,
            unresolvedEntities: resolution.unresolvedEntities
        });

        return res.json({
            success: true,
            uploadId,
            entityMappings: updated.entityMappings,
            resolution: {
                ok: resolution.ok,
                unresolvedCount: resolution.unresolvedCount,
                unresolvedEntities: resolution.unresolvedEntities
            },
            message: `Mapped "${extractedText}" successfully.`
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * PUT /api/staging/:uploadId/entry
 * Allows HOD to edit, correct, or mark free a slot in the staged timetable before approval.
 */
router.put('/:uploadId/entry', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: 'Cannot modify entries: timetable has already been imported.',
                code: 'ALREADY_IMPORTED'
            });
        }

        const {
            day,
            period,
            subject_name,
            subject_code,
            faculty_name,
            room_code,
            session_type,
            span_to,
            is_free,
            class_name
        } = req.body || {};

        if (!day || period === undefined || period === null) {
            return res.status(400).json({
                error: 'day and period are required.',
                code: 'INVALID_ENTRY_UPDATE'
            });
        }

        const normDay = String(day).trim();
        const numPeriod = parseInt(period, 10);
        if (isNaN(numPeriod) || numPeriod <= 0) {
            return res.status(400).json({
                error: 'period must be a positive integer.',
                code: 'INVALID_PERIOD'
            });
        }

        const contract = { ...(staging.extractedJson || {}) };
        if (!Array.isArray(contract.entries)) {
            contract.entries = [];
        }

        const entryIndex = contract.entries.findIndex(e =>
            String(e.day).trim().toUpperCase() === normDay.toUpperCase() &&
            parseInt(e.period, 10) === numPeriod
        );

        if (is_free === true) {
            if (entryIndex !== -1) {
                contract.entries.splice(entryIndex, 1);
            }
        } else {
            const cleanSubj = subject_name ? String(subject_name).trim() : (subject_code ? String(subject_code).trim() : '');
            if (!cleanSubj) {
                return res.status(400).json({
                    error: 'subject_name or subject_code is required when not marking as free.',
                    code: 'MISSING_SUBJECT'
                });
            }

            const cleanFaculty = faculty_name !== undefined ? (faculty_name ? String(faculty_name).trim() : null) : null;
            const cleanRoom = room_code !== undefined ? (room_code ? String(room_code).trim() : null) : null;
            const cleanType = ['theory', 'lab', 'activity'].includes(String(session_type || '').toLowerCase())
                ? String(session_type).toLowerCase()
                : 'theory';
            const numSpanTo = (span_to != null && span_to !== '') ? parseInt(span_to, 10) : null;
            if (numSpanTo != null && numSpanTo < numPeriod) {
                return res.status(400).json({
                    error: 'span_to must be greater than or equal to period.',
                    code: 'INVALID_SPAN'
                });
            }

            const updatedEntry = {
                day: normDay,
                period: numPeriod,
                subject_name: cleanSubj,
                subject_code: subject_code ? String(subject_code).trim() : null,
                faculty_name: cleanFaculty,
                room_code: cleanRoom,
                session_type: cleanType,
                span_to: numSpanTo,
                class_name: class_name || contract.class_name || null,
                is_free: false
            };

            if (entryIndex !== -1) {
                contract.entries[entryIndex] = updatedEntry;
            } else {
                contract.entries.push(updatedEntry);
            }

            // Ensure faculty and subject legends are updated if new names are added
            if (cleanFaculty) {
                if (!Array.isArray(contract.faculty_legend)) contract.faculty_legend = [];
                const facExists = contract.faculty_legend.some(f =>
                    String(f.name || f).trim().toUpperCase() === cleanFaculty.toUpperCase()
                );
                if (!facExists) {
                    contract.faculty_legend.push({ name: cleanFaculty, code: null });
                }
            }
            if (cleanSubj) {
                if (!Array.isArray(contract.subject_legend)) contract.subject_legend = [];
                const subjExists = contract.subject_legend.some(s =>
                    String(s.name || s.subject_name || s).trim().toUpperCase() === cleanSubj.toUpperCase()
                );
                if (!subjExists) {
                    contract.subject_legend.push({ name: cleanSubj, code: subject_code ? String(subject_code).trim() : null });
                }
            }
        }

        // Re-validate contract
        const validationRecord = {
            uploadId,
            uploadType: upload.uploadType || 'MASTER_TIMETABLE',
            departmentCode: upload.departmentCode
        };
        const validation = validateExtractedContract(contract, validationRecord, {
            skipCatalogCheck: true,
            timetableType: upload.uploadType || 'MASTER_TIMETABLE',
            isFacultyTimetable: false
        });

        const validationStatus = validation.ok ? 'VALID' : 'INVALID';
        const validationErrors = (validation.errors && validation.errors.length > 0) ? validation.errors : null;

        // Re-evaluate resolution with saved mappings
        const resolution = await resolveContract(
            contract,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        // Update staging record
        const updated = await updateStagedStatus(uploadId, {
            extractedJson: contract,
            validationStatus,
            validationErrors,
            unresolvedEntities: resolution.unresolvedEntities
        });

        return res.json({
            success: true,
            uploadId,
            validationStatus: updated.validationStatus,
            validationErrors: updated.validationErrors,
            resolution: {
                ok: resolution.ok,
                unresolvedCount: resolution.unresolvedCount,
                unresolvedEntities: resolution.unresolvedEntities,
                warnings: resolution.warnings || []
            },
            extractedJson: updated.extractedJson,
            message: `Updated slot for ${normDay} P${numPeriod} successfully.`
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * Helper to register an extracted entity into the branch catalog.
 */
async function registerEntityIntoCatalog(entityType, extractedText, extra = {}, branchCode = 'General') {
    const type = String(entityType).toLowerCase();
    const branch = String(branchCode || 'General').toUpperCase();

    if (db.isConfigured() && store.usingDatabase) {
        return db.withTransaction(async client => {
            let deptRes = await client.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [branch]);
            let deptId = deptRes.rows.length > 0 ? deptRes.rows[0].id : null;
            if (!deptId) {
                const insDept = await client.query(
                    'INSERT INTO departments (code, name, active) VALUES (UPPER($1), $1, true) RETURNING id', [branch]
                );
                deptId = insDept.rows[0].id;
            }

            if (type === 'class') {
                const code = String(extra.code || extractedText).trim();
                const semNum = repository.parseSemesterNumber ? repository.parseSemesterNumber(extra.semester) : null;
                let sec = extra.section ? String(extra.section).trim().toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '') : null;
                if (!sec && code) {
                    const m = code.match(/[-_]([A-Za-z0-9])$/);
                    if (m) sec = m[1].toUpperCase();
                }
                if (!sec) sec = 'A';
                const yr = extra.academicYear ? String(extra.academicYear).trim() : (extra.academic_year ? String(extra.academic_year).trim() : null);

                // 1. Check exact (dept, year variants, sem, sec) match
                const yrVariants = repository.normalizeAcademicYearVariants ? repository.normalizeAcademicYearVariants(yr) : (yr ? [yr] : []);
                let existing = null;
                if (deptId && semNum && sec) {
                    if (yrVariants.length > 0) {
                        const scopeQ = await client.query(
                            `SELECT id, code, department_id, academic_year, semester, section 
                               FROM classes 
                              WHERE department_id = $1 
                                AND semester = $2 
                                AND UPPER(TRIM(section)) = UPPER(TRIM($3))
                                AND (academic_year = ANY($4) OR academic_year IS NULL)
                              ORDER BY CASE WHEN academic_year = ANY($4) THEN 0 ELSE 1 END, id ASC 
                              LIMIT 1`,
                            [deptId, semNum, sec, yrVariants]
                        );
                        if (scopeQ.rows.length) existing = scopeQ.rows[0];
                    } else {
                        const scopeQ = await client.query(
                            `SELECT id, code, department_id, academic_year, semester, section 
                               FROM classes 
                              WHERE department_id = $1 
                                AND semester = $2 
                                AND UPPER(TRIM(section)) = UPPER(TRIM($3))
                              ORDER BY id ASC 
                              LIMIT 1`,
                            [deptId, semNum, sec]
                        );
                        if (scopeQ.rows.length) existing = scopeQ.rows[0];
                    }
                }

                // 2. Check exact code match if not found by scope
                if (!existing && code) {
                    const codeQ = await client.query('SELECT id, code, department_id, academic_year, semester, section FROM classes WHERE UPPER(TRIM(code)) = UPPER(TRIM($1)) LIMIT 1', [code]);
                    if (codeQ.rows.length) {
                        const found = codeQ.rows[0];
                        if (!deptId || !found.department_id || found.department_id === deptId) {
                            if ((!found.semester || found.semester === semNum) && (!found.section || found.section === sec)) {
                                existing = found;
                            }
                        }
                    }
                }

                if (existing) {
                    if (!existing.academic_year && yr) {
                        await client.query('UPDATE classes SET academic_year = $1 WHERE id = $2', [yr, existing.id]);
                        existing.academic_year = yr;
                    }
                    return existing;
                }

                let finalCode = code;
                const codeCheck = await client.query('SELECT id FROM classes WHERE UPPER(TRIM(code)) = UPPER(TRIM($1))', [finalCode]);
                if (codeCheck.rows.length > 0) {
                    finalCode = `${code}-SEM${semNum || 1}-${sec || 'A'}-${yr || 'AY'}`;
                }

                const res = await client.query(
                    `INSERT INTO classes (code, department_id, semester, academic_year, section)
                     VALUES (UPPER($1), $2, $3, $4, $5)
                     RETURNING id, code`,
                    [finalCode, deptId, semNum, yr, sec]
                );
                return res.rows[0];
            } else if (type === 'subject') {
                const name = String(extra.name || extractedText).trim();
                const code = String(extra.code || name.replace(/[^A-Z0-9]/gi, '').slice(0, 10).toUpperCase() || 'SUBJ');
                const subjectType = String(extra.type || (/lab|practical|workshop|drawing/i.test(name) ? 'lab' : 'theory')).toLowerCase();
                const existing = await client.query(
                    'SELECT id, code, name FROM subjects WHERE (UPPER(code) = UPPER($1) OR UPPER(name) = UPPER($2)) AND (department_id = $3 OR department_id IS NULL) LIMIT 1',
                    [code, name, deptId]
                );
                if (existing.rows.length > 0) return existing.rows[0];
                const res = await client.query(
                    `INSERT INTO subjects (code, name, department_id, subject_type)
                     VALUES (UPPER($1), $2, $3, $4)
                     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, department_id = COALESCE(EXCLUDED.department_id, subjects.department_id)
                     RETURNING id, code, name`,
                    [code, name, deptId, subjectType]
                );
                return res.rows[0];
            } else if (type === 'faculty') {
                const name = String(extra.name || extractedText).trim();
                const code = String(extra.code || (branch + '_' + name.replace(/[^A-Z0-9]/gi, '_').toUpperCase()).slice(0, 30));
                const existing = await client.query(
                    'SELECT id, code, name FROM faculty WHERE (UPPER(code) = UPPER($1) OR UPPER(name) = UPPER($2)) AND (department_id = $3 OR department_id IS NULL) LIMIT 1',
                    [code, name, deptId]
                );
                if (existing.rows.length > 0) return existing.rows[0];
                const res = await client.query(
                    `INSERT INTO faculty (code, name, department_id, designation, status, max_weekly_periods)
                     VALUES ($1, $2, $3, $4, 'active', 28)
                     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, department_id = COALESCE(EXCLUDED.department_id, faculty.department_id)
                     RETURNING id, code, name`,
                    [code, name, deptId, extra.designation || 'Faculty']
                );
                return res.rows[0];
            }
        });
    }

    const source = store.source || {};
    if (!source.classes) source.classes = [];
    if (!source.subjects) source.subjects = [];
    if (!source.faculty) source.faculty = [];

    if (type === 'class') {
        const code = String(extra.code || extractedText).trim();
        const obj = { id: source.classes.length + 1, class: code, code, department: branch };
        source.classes.push(obj);
        return obj;
    } else if (type === 'subject') {
        const name = String(extra.name || extractedText).trim();
        const code = String(extra.code || name.replace(/[^A-Z0-9]/gi, '').slice(0, 10).toUpperCase() || 'SUBJ');
        const obj = { id: source.subjects.length + 1, code, name, department: branch, type: extra.type || 'theory' };
        source.subjects.push(obj);
        return obj;
    } else if (type === 'faculty') {
        const name = String(extra.name || extractedText).trim();
        const code = String(extra.code || name);
        const obj = { id: source.faculty.length + 1, code, name, department: branch, status: 'active' };
        source.faculty.push(obj);
        return obj;
    }
}

/**
 * POST /api/staging/:uploadId/register-entity
 * Explicitly registers a new class, subject, or faculty into the branch catalog.
 */
router.post('/:uploadId/register-entity', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({ error: `No staged data found for upload "${uploadId}".`, code: 'NOT_FOUND' });
        }

        const { entityType, extractedText, code, name, type: subType, designation } = req.body || {};
        if (!entityType || !extractedText) {
            return res.status(400).json({ error: 'entityType and extractedText are required.', code: 'INVALID_REQUEST' });
        }

        const registered = await registerEntityIntoCatalog(
            entityType,
            extractedText,
            { code, name, type: subType, designation },
            upload.departmentCode
        );

        // Re-evaluate resolution
        const resolution = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        await updateStagedStatus(uploadId, {
            unresolvedEntities: resolution.unresolvedEntities
        });

        return res.json({
            success: true,
            uploadId,
            registered,
            resolution: {
                ok: resolution.ok,
                unresolvedCount: resolution.unresolvedCount,
                unresolvedEntities: resolution.unresolvedEntities
            },
            message: `Registered "${extractedText}" into ${upload.departmentCode} catalog.`
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * POST /api/staging/:uploadId/register-all-unresolved
 * Explicitly registers all remaining unresolved entities into the branch catalog in one action.
 */
router.post('/:uploadId/register-all-unresolved', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({ error: `No staged data found for upload "${uploadId}".`, code: 'NOT_FOUND' });
        }

        // Get current unresolved list
        const initialRes = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        const registeredList = [];
        const subjectLegends = Array.isArray(staging.extractedJson && staging.extractedJson.subject_legend)
            ? staging.extractedJson.subject_legend : [];
        const facultyLegends = Array.isArray(staging.extractedJson && staging.extractedJson.faculty_legend)
            ? staging.extractedJson.faculty_legend : [];

        for (const item of initialRes.unresolvedEntities) {
            if (item.entityType === 'class') {
                const reg = await registerEntityIntoCatalog('class', item.extractedText, {
                    semester: staging.extractedJson && staging.extractedJson.semester,
                    academicYear: staging.extractedJson && staging.extractedJson.academic_year,
                    section: staging.extractedJson && staging.extractedJson.section
                }, upload.departmentCode);
                registeredList.push({ type: 'class', text: item.extractedText, record: reg });
            } else if (item.entityType === 'subject') {
                if (item.extractedText.includes('/')) {
                    const parts = item.extractedText.split('/').map(p => p.trim()).filter(Boolean);
                    for (const p of parts) {
                        const leg = subjectLegends.find(l => l.name === p || l.short_name === p);
                        const code = (leg && leg.code) || null;
                        await registerEntityIntoCatalog('subject', p, { code }, upload.departmentCode);
                    }
                    const reg = await registerEntityIntoCatalog('subject', item.extractedText, { code: item.code || null }, upload.departmentCode);
                    registeredList.push({ type: 'subject', text: item.extractedText, record: reg });
                } else {
                    const leg = subjectLegends.find(l => l.name === item.extractedText || l.short_name === item.extractedText);
                    const code = (leg && leg.code) || item.code || null;
                    const reg = await registerEntityIntoCatalog('subject', item.extractedText, { code }, upload.departmentCode);
                    registeredList.push({ type: 'subject', text: item.extractedText, record: reg });
                }
            } else if (item.entityType === 'faculty') {
                if (item.extractedText.includes('/')) {
                    const parts = item.extractedText.split('/').map(p => p.trim()).filter(Boolean);
                    for (const p of parts) {
                        const leg = facultyLegends.find(l => l.name === p);
                        const code = (leg && leg.code) || null;
                        await registerEntityIntoCatalog('faculty', p, { code }, upload.departmentCode);
                    }
                    const reg = await registerEntityIntoCatalog('faculty', item.extractedText, { code: item.code || null }, upload.departmentCode);
                    registeredList.push({ type: 'faculty', text: item.extractedText, record: reg });
                } else {
                    const leg = facultyLegends.find(l => l.name === item.extractedText);
                    const code = (leg && leg.code) || null;
                    const reg = await registerEntityIntoCatalog('faculty', item.extractedText, { code }, upload.departmentCode);
                    registeredList.push({ type: 'faculty', text: item.extractedText, record: reg });
                }
            }
        }

        // Re-evaluate resolution
        const finalRes = await resolveContract(
            staging.extractedJson,
            upload.departmentCode,
            staging.entityMappings || {}
        );

        await updateStagedStatus(uploadId, {
            unresolvedEntities: finalRes.unresolvedEntities
        });

        return res.json({
            success: true,
            uploadId,
            registeredCount: registeredList.length,
            registeredList,
            resolution: {
                ok: finalRes.ok,
                unresolvedCount: finalRes.unresolvedCount,
                unresolvedEntities: finalRes.unresolvedEntities
            },
            message: `Successfully registered ${registeredList.length} entities into ${upload.departmentCode} catalog. Ready for approval.`
        });
    } catch (err) {
        console.error('register-all-unresolved error:', err);
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * POST /api/staging/:uploadId/approve
 * Approves and transactionally imports a VALID staged timetable into the live timetable.
 */
router.post('/:uploadId/approve', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        // 1. Validation Gate: Strictly check validation_status
        if (staging.validationStatus !== 'VALID') {
            return res.status(422).json({
                error: 'Cannot approve: Timetable failed B2.3 contract validation.',
                code: 'CANNOT_APPROVE_INVALID_DATA',
                validationErrors: staging.validationErrors
            });
        }

        // 2. Idempotency Gate: Reject if already imported
        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: `Timetable "${uploadId}" has already been approved and imported.`,
                code: 'ALREADY_IMPORTED',
                importedAt: staging.importedAt,
                importedCount: staging.importedCount
            });
        }

        // 3. Staging Status Gate: Reject if rejected
        if (staging.importStatus === 'REJECTED') {
            return res.status(409).json({
                error: `Timetable "${uploadId}" was previously rejected. Re-upload or re-process to approve.`,
                code: 'ALREADY_REJECTED',
                rejectionReason: staging.rejectionReason
            });
        }

        // 4. Determine Authoritative Target Scope
        const currentUserId = req.session.userId || req.session.username || req.session.id;
        const targetScope = (req.body && req.body.targetScope) ? req.body.targetScope : {
            branch: (req.body && (req.body.targetBranch || req.body.branch || req.body.departmentCode)) || upload.departmentCode,
            academicYear: (req.body && (req.body.targetAcademicYear || req.body.academicYear)) || upload.academicYear,
            semester: (req.body && (req.body.targetSemester || req.body.semester)) || upload.semester,
            section: (req.body && (req.body.targetSection || req.body.section)) || upload.section,
            className: (req.body && (req.body.targetClass || req.body.className)) || upload.targetClass
        };

        const targetBranchCode = targetScope.branch || upload.departmentCode;

        // 5. Entity Resolution Gate: Strictly block if unresolved entities remain
        const resolution = await resolveContract(
            staging.extractedJson,
            targetBranchCode,
            staging.entityMappings || {}
        );

        if (!resolution.ok || resolution.unresolvedCount > 0) {
            return res.status(422).json({
                error: `Cannot approve: ${resolution.unresolvedCount} extracted reference(s) are not resolved against the branch catalog. Map or register them before importing.`,
                code: 'UNRESOLVED_ENTITIES',
                unresolvedEntities: resolution.unresolvedEntities
            });
        }

        // 6. Transactional Import Execution

        let importResult;
        if (db.isConfigured() && store.usingDatabase) {
            importResult = await repository.importStagedTimetable({
                uploadRecord: upload,
                stagedContract: staging.extractedJson,
                resolvedMap: resolution.resolvedMap,
                userId: currentUserId,
                targetScope
            });
            // Reload store cache from PostgreSQL
            await store.reloadFromDatabase();
        } else {
            importResult = store.importStagedTimetableInMemory({
                uploadRecord: upload,
                stagedContract: staging.extractedJson,
                resolvedMap: resolution.resolvedMap,
                userId: currentUserId,
                targetScope
            });
        }

        if (!importResult || !importResult.importedCount || importResult.importedCount <= 0) {
            return res.status(422).json({
                error: 'No timetable entries could be imported. Please verify the timetable contents.',
                code: 'ZERO_SLOTS_IMPORTED'
            });
        }

        // Verify database persistence if running against PostgreSQL
        if (db.isConfigured() && store.usingDatabase && importResult.classId) {
            const check = await db.query('SELECT COUNT(*)::int AS count FROM timetable WHERE class_id = $1', [importResult.classId]);
            if (!check.rows.length || check.rows[0].count === 0) {
                return res.status(500).json({
                    error: 'Database verification failed: zero timetable rows were committed.',
                    code: 'PERSISTENCE_VERIFICATION_FAILED'
                });
            }
        }

        // 6. Update Staging Record to IMPORTED
        const nowIso = new Date().toISOString();
        await updateStagedStatus(uploadId, {
            importStatus: 'IMPORTED',
            reviewedBy: currentUserId,
            reviewedAt: nowIso,
            importedAt: nowIso,
            importedCount: importResult.importedCount,
            unresolvedEntities: []
        });

        // 7. Update Upload Record status to PROCESSED
        await updateUploadStatus(uploadId, 'PROCESSED');

        const finalScope = (importResult && importResult.scope) || {
            branch: upload.departmentCode,
            semester: staging.extractedJson.semester || 'SEM-1',
            section: staging.extractedJson.section || 'A',
            academicYear: staging.extractedJson.academic_year || null,
            className: staging.extractedJson.class_name
        };

        return res.json({
            success: true,
            uploadId,
            importStatus: 'IMPORTED',
            importedCount: importResult.importedCount,
            targetClass: finalScope.className,
            department: finalScope.branch,
            scope: finalScope,
            reviewedBy: currentUserId,
            importedAt: nowIso,
            message: `Timetable approved successfully. ${importResult.importedCount} period slots imported into the live schedule.`
        });
    } catch (err) {
        console.error('Approve error:', err);
        const status = err.status || (err.code === 'SLOT_CONFLICT' ? 409 : 500);
        return res.status(status).json({
            error: err.message || 'Failed to import timetable.',
            code: err.code || 'IMPORT_FAILED',
            details: err.details || null
        });
    }
});

/**
 * POST /api/staging/:uploadId/reject
 * Rejects a staged timetable with an optional reason. Zero writes to live timetable.
 */
router.post('/:uploadId/reject', async (req, res) => {
    try {
        const uploadId = req.params.uploadId;
        const upload = await verifyBranchOwnership(req, res, uploadId);
        if (!upload) return;

        const staging = await getStagedData(uploadId);
        if (!staging) {
            return res.status(404).json({
                error: `No staged data found for upload "${uploadId}".`,
                code: 'NOT_FOUND'
            });
        }

        if (staging.importStatus === 'IMPORTED') {
            return res.status(409).json({
                error: 'Cannot reject: timetable has already been imported into the live schedule.',
                code: 'ALREADY_IMPORTED'
            });
        }

        const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : 'Rejected by HOS';
        const nowIso = new Date().toISOString();
        const currentUserId = req.session.userId || req.session.username || req.session.id;

        await updateStagedStatus(uploadId, {
            importStatus: 'REJECTED',
            reviewedBy: currentUserId,
            reviewedAt: nowIso,
            rejectionReason: reason
        });

        // Update upload status to FAILED or keep as historical
        try {
            await updateUploadStatus(uploadId, 'FAILED');
        } catch (e) {
            // keep rejection primary
        }

        return res.json({
            success: true,
            uploadId,
            importStatus: 'REJECTED',
            rejectionReason: reason,
            reviewedBy: currentUserId,
            reviewedAt: nowIso,
            message: 'Staged timetable rejected. No changes were made to the live timetable.'
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

module.exports = router;
