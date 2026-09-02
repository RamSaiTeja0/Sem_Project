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

function handleUpload(action) {
    return async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded. Send the file in the "timetable" field.',
                code: 'NO_FILE'
            });
        }
        try {
            const result = await importer[action](req.file.buffer, req.file.originalname, {
                defaultClass: (req.body && req.body.defaultClass) || null
            });
            res.json({
                filename: result.filename,
                format: result.format,
                layout: result.layout,
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
