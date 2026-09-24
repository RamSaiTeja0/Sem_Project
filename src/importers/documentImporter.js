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

const config = require('../config');
const { createProvider } = require('./providers/pdfcoProvider');

const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];

const ALTERNATIVES = [
    'Import from Excel (.xlsx / .xls)',
    'Import from CSV',
    'Quick Paste (paste the table as text)',
    'Manual Timetable Entry'
];

let provider = null;
let overridden = false;

/**
 * The provider in force: an explicitly registered one, otherwise PDF.co when
 * PDFCO_API_KEY is set. With no key at all this stays null and every caller
 * reports that extraction is unavailable.
 */
function activeProvider() {
    if (overridden) return provider;
    if (!provider && config.pdfcoApiKey) provider = createProvider();
    return provider && provider.configured !== false ? provider : null;
}

/** Register an extraction provider, replacing the default. Pass null to reset. */
function setProvider(next) {
    if (next != null && typeof next.extract !== 'function') {
        throw new Error('A document extraction provider must expose an async extract(buffer, mimeType, options) method');
    }
    provider = next;
    overridden = next != null;
}

function hasProvider() {
    return activeProvider() != null;
}

/** What the UI shows on the Image/PDF tab. */
function status() {
    const active = activeProvider();
    return {
        available: Boolean(active),
        provider: active ? (active.name || 'custom') : null,
        // Named so the operator knows exactly which variable to set. The key
        // itself is never included here — this response reaches the browser.
        configuredVia: 'PDFCO_API_KEY',
        supported: SUPPORTED_EXTENSIONS,
        alternatives: ALTERNATIVES,
        message: active
            ? `Document extraction is available via "${active.name || 'custom'}". ` +
              'PDFs and images are read as tables and run through the same validation as Excel and CSV.'
            : 'PDF/Image extraction is not configured. Add PDFCO_API_KEY to enable document extraction. ' +
              'No extraction has been attempted and no data was produced.'
    };
}

/**
 * Extract a timetable from a PDF or image.
 *
 * A provider may return either CSV table text (PDF.co does) or an already-built
 * timetable source. CSV goes through the SAME table parser Excel and CSV
 * imports use, so documents get identical layout detection, day normalization
 * and validation — there is no separate document validation path.
 */
const path = require('path');

function isImageFile(filename, mimeType) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || (mimeType && String(mimeType).startsWith('image/'));
}

async function parse(buffer, options = {}) {
    const filename = options.filename || '';
    const mimeType = options.mimeType || null;

    // Route image uploads directly to Gemini Vision Stage 1 + Stage 2 pipeline
    if (isImageFile(filename, mimeType) && (!overridden || options.geminiTransport || options.stage1Transport)) {
        const imageImporter = require('./imageImporter');
        return imageImporter.parse(buffer, options);
    }

    const active = activeProvider();

    if (!active) {
        const error = new Error(
            'PDF/Image extraction is not configured. Add PDFCO_API_KEY to enable document ' +
            'extraction. Nothing was extracted. Use ' + ALTERNATIVES.join(', ') + ' instead.');
        error.code = 'EXTRACTION_NOT_CONFIGURED';
        error.status = 501;
        error.alternatives = ALTERNATIVES;
        throw error;
    }

    const result = await active.extract(buffer, options.mimeType || null, options);
    if (!result || typeof result !== 'object') {
        const error = new Error('The document extraction provider returned nothing');
        error.code = 'EXTRACTION_FAILED';
        error.status = 502;
        throw error;
    }

    const providerName = result.provider || active.name || 'custom';

    // --- CSV text: reuse the shared parser, exactly as a .csv upload would ---
    if (typeof result.csv === 'string' && result.csv.trim()) {
        // Required lazily: tableParser and this module would otherwise form a
        // require cycle through the importer registry.
        const { parseTable } = require('./tableParser');
        const { parseCsvText } = require('./csvImporter');

        const rows = parseCsvText(result.csv);
        const parsed = parseTable(rows, options);
        return {
            ...parsed,
            format: 'document',
            provider: providerName,
            convertedFromImage: Boolean(result.convertedFromImage),
            issues: (parsed.issues || []).concat(Array.isArray(result.issues) ? result.issues : [])
        };
    }

    // --- or a source object built by the provider itself ---
    if (result.source) {
        return {
            source: result.source,
            format: 'document',
            provider: providerName,
            confidence: typeof result.confidence === 'number' ? result.confidence : null,
            rowCount: null,
            layout: 'document',
            issues: Array.isArray(result.issues) ? result.issues : []
        };
    }

    const error = new Error(
        'The document extraction provider returned no table content. Nothing was imported.');
    error.code = 'EXTRACTION_EMPTY';
    error.status = 502;
    throw error;
}

module.exports = {
    parse, setProvider, hasProvider, activeProvider, status,
    isOverridden: () => overridden,
    SUPPORTED_EXTENSIONS, ALTERNATIVES
};
