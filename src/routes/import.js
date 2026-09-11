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
            matrix: 'Faculty | Monday P1 | Monday P2 | ... — a cell reading FREE or blank means not teaching',
            long: 'Faculty | Day | Period | Subject | Class | Room'
        },
        maxUploadMB: Math.round(config.maxUploadBytes / (1024 * 1024)),
        note: 'Excel and CSV run through the same normalizer, so both produce identical data.',
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
            const result = await importer[action](req.file.buffer, req.file.originalname, {
                defaultClass: resolved.code,
                filename: req.file.originalname,
                mimeType: req.file.mimetype
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

            res.json({
                filename: result.filename,
                format: result.format,
                layout: result.layout,
                provider: result.provider,
                convertedFromImage: result.convertedFromImage,
                rowCount: result.rowCount,
                loaded: Boolean(result.loaded),
                meta: result.meta,
                faculty: result.faculty,
                report: result.report,
                preview: result.preview,
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
