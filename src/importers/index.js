/**
 * Import orchestration: file -> importer -> normalizer -> validator -> preview.
 *
 *   preview()  parses and validates, returning what WOULD be loaded. No change.
 *   commit()   does the same, then swaps the live dataset if validation passes.
 *
 * If any step fails, the currently loaded timetable is left exactly as it was.
 */
const path = require('path');

const excelImporter = require('./excelImporter');
const csvImporter = require('./csvImporter');
const documentImporter = require('./documentImporter');
const { normalize } = require('../core/normalizer');
const { validate } = require('../core/validator');
const store = require('../data/store');

const IMPORTERS = {
    '.xlsx': excelImporter,
    '.xlsm': excelImporter,
    '.xls': excelImporter,
    '.csv': csvImporter,
    // Image and PDF go to the adapter, which reports honestly that extraction
    // is not configured rather than guessing at the table.
    '.png': documentImporter,
    '.jpg': documentImporter,
    '.jpeg': documentImporter,
    '.webp': documentImporter,
    '.pdf': documentImporter
};

const SUPPORTED = ['.xlsx', '.xls', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.pdf'];
const SPREADSHEET_FORMATS = ['.xlsx', '.xls', '.csv'];

function importerFor(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    const importer = IMPORTERS[ext];
    if (!importer) {
        const error = new Error(
            `Unsupported file type "${ext || filename}". Supported: ${SUPPORTED.join(', ')}.`);
        error.code = 'UNSUPPORTED_FILE_TYPE';
        throw error;
    }
    return importer;
}

/** Day-by-day preview rows the user reviews before confirming. */
function buildPreview(normalized) {
    const meta = normalized.meta;
    const busy = new Map();
    normalized.busyRecords.forEach(r => busy.set(`${r.faculty}|${r.day}|${r.period}`, r));

    return normalized.faculty.map(member => ({
        faculty: member.name,
        department: member.department,
        slots: meta.days.flatMap(day => meta.periods.map(period => {
            const record = busy.get(`${member.name}|${day}|${period}`);
            return {
                day, period,
                subject: record ? record.subject : null,
                className: record ? record.className : null,
                status: record ? 'busy' : 'free'
            };
        }))
    }));
}

async function analyse(buffer, filename, options = {}) {
    const importer = importerFor(filename);
    // The filename decides which pipeline a document provider uses (an image
    // must be converted to a PDF first), so always pass it through rather than
    // relying on every caller to include it in options.
    const parsed = await importer.parse(buffer, { ...options, filename });

    const normalized = normalize(parsed.source);
    (parsed.issues || []).forEach(issue => normalized.issues.push(issue));
    const report = validate(normalized);

    return {
        filename,
        format: parsed.format,
        layout: parsed.layout,
        rowCount: parsed.rowCount,
        source: parsed.source,
        meta: normalized.meta,
        faculty: normalized.faculty,
        report,
        preview: buildPreview(normalized),
        // Present only for document imports: which service read the file, and
        // whether an image had to be converted to a PDF on the way.
        provider: parsed.provider || null,
        convertedFromImage: parsed.convertedFromImage || false
    };
}

async function preview(buffer, filename, options = {}) {
    const result = await analyse(buffer, filename, options);
    return { ...result, loaded: false };
}

async function commit(buffer, filename, options = {}) {
    const result = await analyse(buffer, filename, options);
    if (!result.report.ok) {
        const error = new Error('Import rejected: the timetable failed validation');
        error.code = 'VALIDATION_FAILED';
        error.report = result.report;
        throw error;
    }
    store.replace(result.source, `import:${filename}`);
    return { ...result, loaded: true };
}

module.exports = {
    preview, commit, analyse, importerFor, buildPreview,
    SUPPORTED, SPREADSHEET_FORMATS,
    documentImporter
};
