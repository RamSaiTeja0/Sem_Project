/**
 * Import routes.
 *
 *   GET  /api/timetable/import/formats  what can be uploaded
 *   POST /api/timetable/import/preview  parse + validate. Changes nothing.
 *   POST /api/timetable/import          parse, validate, then load it
 *
 * Import is the only way the live timetable changes, and only on an explicit
 * request. A failed import leaves the previous timetable in place.
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();

const importer = require('../importers');
const config = require('../config');
const store = require('../data/store');
const db = require('../db/pool');
const repository = require('../db/repository');
const { saveUploadRecord, saveStagedData } = require('../data/uploads');
const { resolveContract } = require('../core/entityResolver');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes }
});

router.get('/formats', (req, res) => {
    res.json({
        supported: importer.SUPPORTED,
        spreadsheet: importer.SPREADSHEET_FORMATS,
        primary: '.xlsx',
        layouts: {
            image: 'Upload a timetable image, Excel, CSV, or PDF. The system will automatically detect and extract the timetable structure.',
            matrix: 'Faculty | Monday P1 | Monday P2 | ... — a cell reading FREE or blank means not teaching',
            long: 'Faculty | Day | Period | Subject | Class | Room'
        },
        maxUploadMB: Math.round(config.maxUploadBytes / (1024 * 1024)),
        note: 'Upload a timetable image, Excel, CSV, or PDF. The system will automatically detect and extract the timetable structure.',
        // Image/PDF is served by a pluggable provider; the UI shows this
        // verbatim so it can never imply extraction works when it does not.
        document: importer.documentImporter.status()
    });
});

/** Extraction status on its own, for the Image/PDF tab. */
router.get('/document-status', (req, res) => {
    res.json(importer.documentImporter.status());
});

/**
 * Resolve the class name the user typed against the real class catalog.
 *
 * Typing a branch code such as "cme" must not quietly create a class called
 * "cme" alongside the real CME-A — that produces a timetable nothing else can
 * find. A case difference is corrected silently; anything with no match is
 * refused with the list of classes that do exist.
 *
 * @returns {{ code: string|null }} or {{ error, code, choices }}
 */
async function resolveClass(requested) {
    const wanted = String(requested == null ? '' : requested).trim();
    if (!wanted) return { code: null };   // optional: the file may name its own classes

    let classes = [];
    try {
        classes = db.isConfigured() && store.usingDatabase
            ? (await repository.listClasses()).map(c => c.code)
            : store.engine.getMeta().classes;
    } catch (err) {
        classes = store.engine.getMeta().classes;
    }

    const exact = classes.find(code => code === wanted);
    if (exact) return { code: exact };

    // Same class, different capitalisation — accept it and use the real code.
    const insensitive = classes.find(code => code.toUpperCase() === wanted.toUpperCase());
    if (insensitive) return { code: insensitive };

    // If catalog is currently empty (0 classes registered), accept the requested class code
    if (classes.length === 0) {
        return { code: wanted.toUpperCase() };
    }

    // A branch code rather than a class: name the sections so the user can pick.
    const sections = classes.filter(code => code.toUpperCase().startsWith(wanted.toUpperCase() + '-'));
    if (sections.length) {
        return {
            error: `"${wanted}" is a branch, not a class. Choose one of its classes: ${sections.join(', ')}`,
            code: 'AMBIGUOUS_CLASS',
            choices: sections
        };
    }

    return {
        error: `Unknown class "${wanted}". Existing classes: ${classes.join(', ') || 'none'}`,
        code: 'UNKNOWN_CLASS',
        choices: classes
    };
}

function handleUpload(action) {
    return async (req, res) => {
        if (action === 'commit') {
            if (req.session && req.session.role === 'faculty') {
                return res.status(403).json({
                    error: 'Forbidden: Only Head of Section (HOD) can import a Master Timetable.',
                    code: 'FORBIDDEN'
                });
            }
            if (config.authRequired && (!req.session || (req.session.role !== 'hos' && req.session.role !== 'coordinator' && req.session.role !== 'admin'))) {
                return res.status(403).json({
                    error: 'Forbidden: Only Head of Section (HOD) can import a Master Timetable.',
                    code: 'FORBIDDEN'
                });
            }
        }
        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded. Send the file in the "timetable" field.',
                code: 'NO_FILE'
            });
        }
        const resolved = await resolveClass(req.body && req.body.defaultClass);
        if (resolved.error) {
            return res.status(400).json({
                error: resolved.error, code: resolved.code, choices: resolved.choices
            });
        }

        try {
            const reqSem = req.body && req.body.semester ? String(req.body.semester).trim() : null;
            const reqSec = req.body && req.body.section ? String(req.body.section).trim().toUpperCase() : null;
            const reqYear = req.body && req.body.academicYear ? String(req.body.academicYear).trim() : null;
            const reqClass = req.body && (req.body.targetClass || req.body.className || req.body.defaultClass) ? String(req.body.targetClass || req.body.className || req.body.defaultClass).trim() : null;
            const sessionDept = (req.session && req.session.department) ? String(req.session.department).toUpperCase() : ((req.body && (req.body.departmentCode || req.body.department || req.body.branch)) ? String(req.body.departmentCode || req.body.department || req.body.branch).toUpperCase() : null);

            const result = await importer[action](req.file.buffer, req.file.originalname, {
                defaultClass: resolved.code || reqClass,
                targetClass: reqClass || resolved.code,
                semester: reqSem,
                section: reqSec,
                academicYear: reqYear,
                departmentCode: sessionDept,
                uploadType: (req.session && req.session.role === 'faculty') ? 'FACULTY_TIMETABLE' : 'MASTER_TIMETABLE',
                filename: req.file.originalname,
                mimeType: req.file.mimetype,
                session: req.session
            });

            // Enforce upload boundaries: faculty can only upload their own timetable
            if (req.session && req.session.role === 'faculty' && req.session.facultyName) {
                const loggedFaculty = req.session.facultyName.toUpperCase();
                const fileFaculty = (result.faculty || []).map(f => f.name.toUpperCase());
                if (fileFaculty.length > 0 && !fileFaculty.includes(loggedFaculty)) {
                    return res.status(403).json({
                        error: `You are signed in as "${req.session.facultyName}". Faculty members can only upload their own timetable.`,
                        code: 'FACULTY_UPLOAD_MISMATCH'
                    });
                }
            }

            // HOS can only upload for their own branch
            if (req.session && req.session.role === 'hos' && req.session.department) {
                const hosDept = req.session.department.toUpperCase();
                const otherBranchFaculty = (result.faculty || []).filter(f => f.department && f.department.toUpperCase() !== hosDept);
                if (otherBranchFaculty.length > 0) {
                    return res.status(403).json({
                        error: `As HOS of ${hosDept}, you can only upload timetables for your own branch.`,
                        code: 'BRANCH_UPLOAD_MISMATCH'
                    });
                }
            }

            // If staging record was not created by image importer (e.g. spreadsheet), create it for HOS review
            if (!result.uploadId && req.session && (req.session.role === 'hos' || req.session.role === 'coordinator')) {
                try {
                    const uploadRec = await saveUploadRecord({
                        originalFilename: req.file.originalname,
                        fileType: req.file.mimetype || 'text/csv',
                        fileSize: (req.file.buffer && req.file.buffer.length) || req.file.size || 0,
                        uploaderUserId: req.session.userId || req.session.username,
                        branchId: sessionDept,
                        departmentCode: sessionDept,
                        academicYear: reqYear,
                        semester: reqSem,
                        section: reqSec,
                        targetClass: resolved.code || (result.meta && result.meta.classes && result.meta.classes[0]) || null,
                        uploadType: 'MASTER_TIMETABLE',
                        status: 'PROCESSING'
                    });
                    const uploadId = uploadRec.uploadId;
                    result.uploadId = uploadId;

                    const entries = (result.source && result.source.entries) ? result.source.entries.map(e => ({
                        day: e.day,
                        period: e.period,
                        subject_name: e.subject,
                        faculty_name: e.faculty,
                        room_code: e.room,
                        class_name: e.className || resolved.code || (result.meta && result.meta.classes && result.meta.classes[0]) || null,
                        session_type: e.type || 'theory',
                        is_free: false
                    })) : [];

                    const contract = result.rawContract || {
                        timetable_type: 'MASTER_TIMETABLE',
                        department_code: sessionDept,
                        academic_year: (result.meta && result.meta.academicYear) || reqYear || null,
                        semester: (result.meta && result.meta.semester) || reqSem || null,
                        section: reqSec || null,
                        class_name: resolved.code || (result.meta && result.meta.classes && result.meta.classes[0]) || null,
                        days: (result.meta && result.meta.days) || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
                        periods: (result.meta && result.meta.periods) || [1, 2, 3, 4, 5, 6, 7],
                        period_timings: (result.meta && result.meta.periodTimings) || {},
                        entries,
                        faculty_legend: (result.faculty || []).map(f => ({ name: f.name || f, code: f.code || null })),
                        subject_legend: []
                    };

                    const resCheck = await resolveContract(contract, sessionDept);
                    await saveStagedData(
                        uploadId,
                        contract,
                        (result.report && result.report.ok) ? 'VALID' : 'INVALID',
                        (result.report && !result.report.ok) ? (result.report.issues || []).map(i => i.message || i) : null,
                        { unresolvedEntities: resCheck.unresolvedEntities || [] }
                    );
                    result.unresolvedEntities = resCheck.unresolvedEntities || [];
                    result.rawContract = contract;
                } catch (e) {
                    console.warn('Could not stage spreadsheet import:', e.message);
                }
            }

            res.json({
                success: true,
                filename: result.filename,
                format: result.format,
                layout: result.layout,
                provider: result.provider,
                convertedFromImage: result.convertedFromImage,
                rowCount: result.rowCount,
                loaded: Boolean(result.loaded),
                uploadId: result.uploadId || null,
                meta: result.meta,
                faculty: result.faculty,
                report: result.report,
                preview: result.preview,
                rawContract: result.rawContract || null,
                unresolvedEntities: result.unresolvedEntities || [],
                origin: store.origin
            });
        } catch (err) {
            const status = err.status || (err.code === 'VALIDATION_FAILED' ? 422 : 400);
            res.status(status).json({
                error: err.message,
                code: err.code || 'IMPORT_FAILED',
                report: err.report || null,
                alternatives: err.alternatives || null
            });
        }
    };
}

router.post('/preview', upload.single('timetable'), handleUpload('preview'));
router.post('/', upload.single('timetable'), handleUpload('commit'));

module.exports = router;
