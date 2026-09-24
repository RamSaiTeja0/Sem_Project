/**
 * Faculty Personal Timetable API — Phase B8
 *
 * Dedicated workflow for faculty members to view, upload, preview, confirm,
 * and manage their own personal timetables.
 *
 * STRICT INVARIANT:
 * Faculty uploads NEVER mutate or touch the official HOD Master Timetable.
 * Master Timetable and Faculty My Timetable remain completely separate.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();

const config = require('../config');
const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const importer = require('../importers');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes || 10 * 1024 * 1024 }
});

function requireFaculty(req, res, next) {
    if (!req.session || !(req.session.id || req.session.username || req.session.userId)) {
        return res.status(401).json({ error: 'Sign in to use this endpoint.', code: 'UNAUTHENTICATED' });
    }
    if (req.session.role !== 'faculty') {
        return res.status(403).json({ error: 'Only faculty members can access personal timetable management.', code: 'FORBIDDEN' });
    }
    next();
}

router.use(requireFaculty);

const { normalizeName, nameTokensMatch } = require('../core/entityResolver');

const DAY_MAP = {
    'MON': 'Monday', 'MONDAY': 'Monday',
    'TUE': 'Tuesday', 'TUES': 'Tuesday', 'TUESDAY': 'Tuesday',
    'WED': 'Wednesday', 'WEDNESDAY': 'Wednesday',
    'THU': 'Thursday', 'THUR': 'Thursday', 'THURS': 'Thursday', 'THURSDAY': 'Thursday',
    'FRI': 'Friday', 'FRIDAY': 'Friday',
    'SAT': 'Saturday', 'SATURDAY': 'Saturday',
    'SUN': 'Sunday', 'SUNDAY': 'Sunday'
};

function normalizeDayCanonical(dayStr) {
    if (!dayStr) return null;
    const clean = String(dayStr).trim().toUpperCase();
    return DAY_MAP[clean] || (clean.charAt(0) + clean.slice(1).toLowerCase());
}

function buildCandidateNames(sessionFaculty, sessionUsername) {
    const list = new Set();
    [sessionFaculty, sessionUsername].filter(Boolean).forEach(raw => {
        const str = String(raw).trim();
        list.add(str);
        const norm = normalizeName(str);
        if (norm) {
            list.add(norm);
            const parts = norm.split(' ').filter(Boolean);
            if (parts.length > 1) {
                list.add(parts.slice().reverse().join(' '));
            }
        }
    });
    return Array.from(list);
}

function facultyMatchesCandidate(facText, candidateNames, matchedLegend = null) {
    if (!facText) return false;
    const clean = String(facText).trim();
    const cleanUpper = clean.toUpperCase();
    const cleanNorm = normalizeName(clean);
    const cleanCompact = cleanNorm.replace(/\s+/g, '');

    // Check against direct candidate names
    for (const c of candidateNames) {
        const cUpper = String(c).trim().toUpperCase();
        const cNorm = normalizeName(c);
        const cCompact = cNorm.replace(/\s+/g, '');

        if (cleanUpper === cUpper || cleanNorm === cNorm) {
            return true;
        }
        if (cleanCompact.length > 2 && cleanCompact === cCompact) {
            return true;
        }
        if (nameTokensMatch(clean, c)) {
            return true;
        }
    }

    if (matchedLegend) {
        if (matchedLegend.code && cleanUpper === String(matchedLegend.code).trim().toUpperCase()) {
            return true;
        }
        if (matchedLegend.name && (nameTokensMatch(clean, matchedLegend.name) || cleanNorm === normalizeName(matchedLegend.name))) {
            return true;
        }
    }

    // Split joint faculty (e.g. "A / B", "A & B", "A + B", "A, B", "A and B")
    if (/[\/&+,]|\s+and\s+/i.test(clean)) {
        const parts = clean.split(/[\/&+,]|\s+and\s+/i).map(p => p.trim()).filter(Boolean);
        for (const p of parts) {
            if (facultyMatchesCandidate(p, candidateNames, matchedLegend)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Matches the logged-in faculty against extracted timetable entries and legend.
 */
function matchFacultyInExtractedTimetable({ result, sessionFaculty, sessionDept, sessionUsername }) {
    const rawContract = result.rawContract || {};
    const extractedFacultySet = new Set();

    // 1. Collect all faculty names/codes present in the document
    const legendList = rawContract.faculty_legend || (rawContract.legend && rawContract.legend.faculty) || [];
    if (Array.isArray(legendList)) {
        legendList.forEach(l => {
            if (l.name) extractedFacultySet.add(String(l.name).trim());
            if (l.code) extractedFacultySet.add(String(l.code).trim());
        });
    }
    if (rawContract.faculty_name) {
        extractedFacultySet.add(String(rawContract.faculty_name).trim());
    }
    if (Array.isArray(result.faculty)) {
        result.faculty.forEach(f => {
            if (f.name) extractedFacultySet.add(String(f.name).trim());
            if (f.faculty) extractedFacultySet.add(String(f.faculty).trim());
        });
    }

    const rawEntries = Array.isArray(rawContract.entries) ? rawContract.entries :
        (result.source && Array.isArray(result.source.entries) ? result.source.entries :
        (result.source && Array.isArray(result.source.timetable) ? result.source.timetable : []));

    rawEntries.forEach(e => {
        const fac = e.faculty_name || e.faculty || e.faculty_code;
        if (fac) extractedFacultySet.add(String(fac).trim());
    });

    const extractedFacultyList = Array.from(extractedFacultySet).filter(Boolean);

    // 2. Build candidate identifiers for the authenticated faculty
    const candidateNames = buildCandidateNames(sessionFaculty, sessionUsername);

    // Find any legend entry that matches the session faculty
    let matchedLegend = null;
    if (Array.isArray(legendList)) {
        matchedLegend = legendList.find(l => {
            const lName = l.name ? String(l.name).trim() : '';
            const lCode = l.code ? String(l.code).trim() : '';
            return candidateNames.some(c =>
                nameTokensMatch(lName, c) ||
                nameTokensMatch(lCode, c) ||
                normalizeName(lName) === normalizeName(c) ||
                (lCode && lCode.toUpperCase() === c.toUpperCase())
            );
        });
    }

    // Build subject-to-faculty mapping from subject_legend if available
    const subjectLegends = rawContract.subject_legend || (rawContract.legend && rawContract.legend.subjects) || [];
    const subjectFacultyMap = new Map();
    if (Array.isArray(subjectLegends)) {
        subjectLegends.forEach(sl => {
            const fac = sl.faculty_name || sl.faculty || sl.faculty_code;
            if (fac) {
                if (sl.code) subjectFacultyMap.set(String(sl.code).trim().toUpperCase(), fac);
                if (sl.name) subjectFacultyMap.set(String(sl.name).trim().toUpperCase(), fac);
                if (sl.short_name) subjectFacultyMap.set(String(sl.short_name).trim().toUpperCase(), fac);
            }
        });
    }

    // 3. Match entries belonging to the authenticated faculty
    const matchedSlots = [];
    const isSingleFacultyDoc = (extractedFacultyList.length === 1 && !rawEntries.some(e => e.faculty_name && !facultyMatchesCandidate(e.faculty_name, [extractedFacultyList[0]])));

    rawEntries.forEach(e => {
        if (e.is_free || e.isFree) return;
        const subj = e.subject_name || e.subject_code || e.subject;
        if (!subj || String(subj).trim().toUpperCase() === 'FREE') return;

        let facText = String(e.faculty_name || e.faculty || e.faculty_code || '').trim();
        if (!facText && subjectFacultyMap.size > 0) {
            const subjCode = e.subject_code ? String(e.subject_code).trim().toUpperCase() : '';
            const subjName = e.subject_name ? String(e.subject_name).trim().toUpperCase() : '';
            const rawCell = e.raw_cell_text ? String(e.raw_cell_text).trim().toUpperCase() : '';
            facText = subjectFacultyMap.get(subjCode) || subjectFacultyMap.get(subjName) || subjectFacultyMap.get(rawCell) || '';
        }

        let isMatch = false;

        if (facText) {
            isMatch = facultyMatchesCandidate(facText, candidateNames, matchedLegend);
        } else if (isSingleFacultyDoc) {
            // Personal timetable with unannotated cell faculty belongs to the owner
            const docOwner = rawContract.faculty_name || extractedFacultyList[0] || '';
            if (!docOwner || facultyMatchesCandidate(docOwner, candidateNames, matchedLegend)) {
                isMatch = true;
            }
        }

        if (isMatch) {
            const startP = parseInt(e.period != null ? e.period : e.period_number, 10);
            if (!isNaN(startP)) {
                const endP = e.span_to != null ? parseInt(e.span_to, 10) :
                    (e.span != null ? (startP + parseInt(e.span, 10) - 1) : startP);
                const canonicalDay = normalizeDayCanonical(e.day);
                if (canonicalDay) {
                    for (let p = startP; p <= endP; p++) {
                        matchedSlots.push({
                            day: canonicalDay,
                            period: p,
                            subject: subj,
                            className: e.class_name || e.className || e.class || null,
                            room: e.room_code || e.room || null,
                            type: e.session_type || e.type || 'theory'
                        });
                    }
                }
            }
        }
    });

    return {
        matchedSlots,
        extractedFacultyList,
        matchedFacultyName: matchedLegend ? matchedLegend.name : (matchedSlots.length > 0 ? sessionFaculty : null),
        isSingleFacultyDoc
    };
}

/**
 * POST /api/faculty/timetable/preview
 * Analyzes and extracts uploaded personal timetable without modifying any records.
 */
router.post('/preview', upload.single('timetable'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No timetable file uploaded.', code: 'NO_FILE' });
        }

        const sessionDept = String(req.session.department || '').trim().toUpperCase();
        const sessionFaculty = String(req.session.facultyName || req.session.name || req.session.username || '').trim();
        const sessionUsername = String(req.session.username || '').trim();
        const facultyId = req.session.facultyId || sessionFaculty;

        console.log(`[Faculty Timetable Preview] Request from faculty="${sessionFaculty}" (ID: ${facultyId}), department="${sessionDept}", file="${req.file.originalname}" (${req.file.size} bytes)`);

        // 1. Parse using existing importer infrastructure (Gemini Vision 1+2 / CSV / Excel / PDF)
        const result = await importer.preview(req.file.buffer, req.file.originalname, {
            filename: req.file.originalname,
            mimeType: req.file.mimetype,
            session: req.session,
            departmentCode: sessionDept,
            facultyName: sessionFaculty,
            uploadType: 'FACULTY_TIMETABLE',
            isFacultyTimetable: true
        });

        // 2. Branch verification
        const docDept = (result.meta && result.meta.department) || (result.rawContract && result.rawContract.department_code) || '';
        if (docDept && sessionDept && docDept.toUpperCase() !== sessionDept && docDept.toUpperCase() !== 'GENERAL') {
            console.warn(`[Faculty Timetable Preview] Branch mismatch: detected "${docDept}", session "${sessionDept}"`);
            return res.status(403).json({
                error: `This timetable belongs to another branch and cannot be added to your My Timetable.`,
                code: 'BRANCH_MISMATCH',
                detectedBranch: docDept.toUpperCase(),
                yourBranch: sessionDept
            });
        }

        // 3. Extract and match faculty entries
        const {
            matchedSlots,
            extractedFacultyList,
            matchedFacultyName,
            isSingleFacultyDoc
        } = matchFacultyInExtractedTimetable({
            result,
            sessionFaculty,
            sessionDept,
            sessionUsername
        });

        console.log(`[Faculty Timetable Preview] Extracted faculty: [${extractedFacultyList.join(', ')}], Matched slots for "${sessionFaculty}": ${matchedSlots.length}`);

        // 4. Verify single-faculty timetable identity
        if (isSingleFacultyDoc && extractedFacultyList.length === 1 && matchedSlots.length === 0) {
            const detectedFac = extractedFacultyList[0];
            const isMatch = [sessionFaculty, sessionUsername].some(c =>
                nameTokensMatch(detectedFac, c) || normalizeName(detectedFac) === normalizeName(c)
            );
            if (!isMatch) {
                return res.status(403).json({
                    error: `This timetable belongs to another faculty member (${detectedFac}) and cannot be added to your My Timetable.`,
                    code: 'FACULTY_MISMATCH',
                    detectedFaculty: detectedFac,
                    yourFaculty: sessionFaculty
                });
            }
        }

        // 5. Construct diagnostic explanation if 0 slots matched
        let diagnosticReason = null;
        if (matchedSlots.length === 0) {
            if (extractedFacultyList.length > 0) {
                diagnosticReason = `The uploaded timetable was successfully extracted, but no teaching periods were found for ${sessionFaculty}. Extracted faculty in this timetable: ${extractedFacultyList.join(', ')}.`;
            } else {
                diagnosticReason = `The uploaded timetable does not contain any scheduled teaching entries.`;
            }
        }

        const days = (result.meta && result.meta.days) || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const periods = (result.meta && result.meta.periods) || [1, 2, 3, 4, 5, 6, 7];

        const contractEntries = matchedSlots.map(s => ({
            day: s.day,
            period: s.period,
            subject_name: s.subject,
            room_code: s.room,
            class_name: s.className,
            session_type: s.type
        }));

        return res.json({
            success: true,
            filename: req.file.originalname,
            format: result.format,
            provider: result.provider || null,
            faculty: sessionFaculty,
            branch: sessionDept,
            days,
            periods,
            periodTimings: (result.meta && result.meta.periodTimings) || {},
            slotCount: matchedSlots.length,
            totalSlots: matchedSlots.length,
            slots: matchedSlots,
            contract: {
                entries: contractEntries,
                academic_year: (result.meta && result.meta.academicYear) || (result.rawContract && result.rawContract.academic_year) || null,
                semester: (result.meta && result.meta.semester) || (result.rawContract && result.rawContract.semester) || null
            },
            extractedFacultyList,
            matchedFaculty: matchedFacultyName || null,
            diagnosticReason,
            message: matchedSlots.length > 0
                ? `Found ${matchedSlots.length} teaching slot(s) for ${sessionFaculty} in the uploaded timetable.`
                : (diagnosticReason || `No teaching slots found for ${sessionFaculty}.`)
        });
    } catch (err) {
        console.error(`[Faculty Timetable Preview Error]`, err);
        return res.status(err.status || 500).json({
            error: err.message || 'Failed to preview timetable.',
            code: err.code || 'PREVIEW_FAILED'
        });
    }
});

/**
 * POST /api/faculty/timetable/confirm
 * Saves extracted or edited personal timetable slots for the logged-in faculty member.
 */
router.post('/confirm', async (req, res) => {
    try {
        const sessionFaculty = String(req.session.facultyName || req.session.name || req.session.username || '').trim();
        const sessionDept = String(req.session.department || '').trim().toUpperCase();
        const facultyId = req.session.facultyId || sessionFaculty;

        const rawSlots = req.body && Array.isArray(req.body.slots) ? req.body.slots :
            (req.body && Array.isArray(req.body.entries) ? req.body.entries :
            (req.body && req.body.contract && Array.isArray(req.body.contract.entries) ? req.body.contract.entries : []));

        const slots = rawSlots.map(s => ({
            day: normalizeDayCanonical(s.day || s.day_of_week) || s.day,
            period: parseInt(s.period, 10),
            subject: s.subject || s.subject_name || '',
            room: s.room || s.room_code || '',
            className: s.className || s.class_name || '',
            type: s.type || s.session_type || 'theory'
        })).filter(s => s.day && !isNaN(s.period) && s.subject);

        console.log(`[Faculty Timetable Confirm] Saving ${slots.length} personal slots for faculty="${sessionFaculty}" (ID: ${facultyId})`);

        if (db.isConfigured() && store.usingDatabase) {
            const saved = await repository.saveFacultyPersonalTimetable({
                facultyId,
                slots,
                departmentCode: sessionDept
            });
            console.log(`[Faculty Timetable Confirm] Database saved: ${saved.count} rows written for facultyId=${saved.facultyId}`);
            return res.json({
                success: true,
                saved: true,
                count: saved.count,
                slotCount: saved.count,
                faculty: sessionFaculty,
                message: `Personal timetable saved successfully. ${saved.count} periods registered.`
            });
        }

        store.saveFacultyPersonalTimetableInMemory(sessionFaculty, slots);
        console.log(`[Faculty Timetable Confirm] In-memory saved: ${slots.length} slots for ${sessionFaculty}`);
        return res.json({
            success: true,
            saved: true,
            count: slots.length,
            slotCount: slots.length,
            faculty: sessionFaculty,
            message: `Personal timetable saved in-memory. ${slots.length} periods registered.`
        });
    } catch (err) {
        console.error(`[Faculty Timetable Confirm Error]`, err);
        return res.status(500).json({
            error: err.message || 'Failed to save personal timetable.',
            code: 'SAVE_FAILED'
        });
    }
});

/**
 * GET /api/faculty/timetable/mine
 * Retrieves the logged-in faculty's personal timetable (or falls back to master timetable slots).
 */
router.get('/mine', async (req, res) => {
    try {
        const sessionFaculty = req.session.facultyName || req.session.name || req.session.username;
        const facultyId = req.session.facultyId || sessionFaculty;

        let personalSlots = [];
        if (db.isConfigured() && store.usingDatabase) {
            personalSlots = await repository.getFacultyPersonalTimetable(facultyId);
        } else {
            personalSlots = store.getFacultyPersonalTimetableInMemory(sessionFaculty);
        }

        const engine = store.engine;
        const meta = engine.getMeta();
        const days = meta.days || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const periods = meta.periods || [1, 2, 3, 4, 5, 6, 7];

        if (personalSlots && personalSlots.length > 0) {
            const cells = [];
            days.forEach(day => {
                periods.forEach(period => {
                    const match = personalSlots.find(s => (s.day === day || normalizeDayCanonical(s.day) === day) && s.period === period);
                    if (match) {
                        cells.push({
                            day,
                            period,
                            subject: match.subject,
                            faculty: sessionFaculty,
                            facultyId,
                            className: match.className,
                            room: match.room,
                            type: match.type || 'theory',
                            status: 'busy',
                            isPersonal: true
                        });
                    } else {
                        cells.push({
                            day,
                            period,
                            subject: null,
                            faculty: sessionFaculty,
                            facultyId,
                            className: null,
                            room: null,
                            status: 'free',
                            isPersonal: true
                        });
                    }
                });
            });

            return res.json({
                view: 'faculty',
                name: sessionFaculty,
                faculty: sessionFaculty,
                branch: req.session.department,
                days,
                periods,
                cells,
                periodTimings: meta.periodTimings,
                isCustomPersonal: true
            });
        }

        // Fallback to Master Timetable grid for this faculty
        let grid = engine.getFacultyGrid(sessionFaculty);
        if (!grid) {
            const cells = [];
            days.forEach(day => periods.forEach(period => {
                cells.push({
                    day, period,
                    subject: null, faculty: sessionFaculty, facultyId,
                    phone: null, className: null, room: null, status: 'free'
                });
            }));
            grid = { view: 'faculty', name: sessionFaculty, days, periods, cells };
        }

        return res.json({
            ...grid,
            faculty: sessionFaculty,
            branch: req.session.department,
            periodTimings: meta.periodTimings,
            isCustomPersonal: false
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

/**
 * DELETE /api/faculty/timetable/mine
 * Resets personal timetable to Master Timetable view.
 */
router.delete('/mine', async (req, res) => {
    try {
        const sessionFaculty = req.session.facultyName || req.session.name || req.session.username;
        const facultyId = req.session.facultyId || sessionFaculty;

        if (db.isConfigured() && store.usingDatabase) {
            await repository.clearFacultyPersonalTimetable(facultyId);
        } else {
            store.clearFacultyPersonalTimetableInMemory(sessionFaculty);
        }

        return res.json({
            success: true,
            message: 'Personal timetable reset to official Master Timetable view.'
        });
    } catch (err) {
        return res.status(500).json({ error: err.message, code: 'SERVER_ERROR' });
    }
});

module.exports = router;
