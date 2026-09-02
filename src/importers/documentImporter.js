/**
 * Image / PDF timetable import — ADAPTER ONLY.
 *
 * A timetable in a photo or a PDF is a structured table, not free text.
 * Ordinary OCR (Tesseract and friends) reads it as a stream of words and loses
 * the row/column geometry, which produces a plausible-looking timetable with
 * cells in the wrong places — worse than no import at all, because the error is
 * invisible until someone is sent to the wrong room.
 *
 * So this module extracts nothing by itself. It defines the boundary a real
 * document/table-extraction provider plugs into, and until one is configured it
 * says so plainly and points the user at Excel, CSV, Quick Paste or manual
 * entry. It never fabricates a result.
 *
 * Configuring a provider
 * ----------------------
 * Set DOCUMENT_EXTRACTION_PROVIDER (and whatever credentials that provider
 * needs) and register an implementation at startup:
 *
 *   documentImporter.setProvider({
 *       name: 'my-provider',
 *       async extract(buffer, mimeType, options) {
 *           return { source: <timetable source object>, confidence: 0.9 };
 *       }
 *   });
 *
 * `source` is the same shape src/data/demoTimetable.js uses, so the normalizer,
 * validator, store, availability engine and UI need no changes at all.
 */

const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];

const ALTERNATIVES = [
    'Import from Excel (.xlsx / .xls)',
    'Import from CSV',
    'Quick Paste (paste the table as text)',
    'Manual Timetable Entry'
];

let provider = null;

/** Register an extraction provider. Pass null to unregister. */
function setProvider(next) {
    if (next != null && typeof next.extract !== 'function') {
        throw new Error('A document extraction provider must expose an async extract(buffer, mimeType, options) method');
    }
    provider = next;
}

function hasProvider() {
    return provider != null;
}

/** What the UI shows on the Image/PDF tab. */
function status() {
    return {
        available: hasProvider(),
        provider: provider ? (provider.name || 'custom') : null,
        configuredVia: 'DOCUMENT_EXTRACTION_PROVIDER',
        supported: SUPPORTED_EXTENSIONS,
        alternatives: ALTERNATIVES,
        message: hasProvider()
            ? `Document extraction is available via "${provider.name || 'custom'}".`
            : 'Document extraction is not configured, so timetables cannot be read from an ' +
              'image or PDF yet. No extraction has been attempted and no data was produced.'
    };
}

async function parse(buffer, options = {}) {
    if (!provider) {
        const error = new Error(
            'Document extraction is not configured, so this image/PDF cannot be read. ' +
            'Nothing was extracted. Use ' + ALTERNATIVES.join(', ') + ' instead.');
        error.code = 'EXTRACTION_NOT_CONFIGURED';
        error.status = 501;
        error.alternatives = ALTERNATIVES;
        throw error;
    }

    const result = await provider.extract(buffer, options.mimeType || null, options);
    if (!result || typeof result !== 'object' || !result.source) {
        const error = new Error('The document extraction provider returned no timetable data');
        error.code = 'EXTRACTION_FAILED';
        error.status = 502;
        throw error;
    }

    return {
        source: result.source,
        format: 'document',
        provider: provider.name || 'custom',
        confidence: typeof result.confidence === 'number' ? result.confidence : null,
        rowCount: null,
        layout: 'document',
        issues: Array.isArray(result.issues) ? result.issues : []
    };
}

module.exports = { parse, setProvider, hasProvider, status, SUPPORTED_EXTENSIONS, ALTERNATIVES };
