/**
 * PDF.co document extraction provider.
 *
 * Turns an uploaded PDF or image into CSV table text, which is then handed to
 * the SAME table parser, normalizer and validator that Excel and CSV imports
 * use. There is deliberately no second validation path for documents.
 *
 *   upload  -> PDF.co presigned URL, then PUT the bytes
 *   image   -> /pdf/convert/from/image   (images become a PDF first)
 *   table   -> /pdf/convert/to/csv       (OCR applied for scanned pages)
 *   result  -> CSV text -> existing pipeline
 *
 * Docs: https://pdf.co/products/pdf-extractor-api
 *       https://pdf.co/tutorials/extract-tables-from-pdf-as-table-itself
 *
 * The API key comes from PDFCO_API_KEY and is used only here, server-side. It
 * is never returned in a response, logged, or sent to the browser.
 *
 * `transport` is injectable so the request/response handling can be tested
 * without calling the real service. Nothing in this module ever fabricates a
 * timetable: with no key, or on a failed call, it throws and the caller reports
 * the failure.
 */
const path = require('path');
const config = require('../../config');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PDF_EXTENSIONS = new Set(['.pdf']);

/** Default transport: plain fetch, with a timeout so a hung call cannot wedge a request. */
async function defaultTransport(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.pdfcoTimeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch (err) { body = null; }
        return { ok: response.ok, status: response.status, text, body };
    } finally {
        clearTimeout(timer);
    }
}

function providerError(message, code, status) {
    const error = new Error(message);
    error.code = code || 'PDFCO_FAILED';
    error.status = status || 502;
    return error;
}

/**
 * Build a provider bound to a key and a transport.
 * @param {{apiKey?: string, baseUrl?: string, transport?: Function}} options
 */
function createProvider(options = {}) {
    const apiKey = options.apiKey !== undefined ? options.apiKey : config.pdfcoApiKey;
    const baseUrl = (options.baseUrl || config.pdfcoBaseUrl).replace(/\/$/, '');
    const transport = options.transport || defaultTransport;

    function headers(extra) {
        return Object.assign({ 'x-api-key': apiKey }, extra || {});
    }

    /** POST a JSON body and return the parsed response, or throw with PDF.co's own message. */
    async function callJson(endpoint, payload) {
        const res = await transport(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        });

        if (!res.ok || !res.body) {
            throw providerError(
                `PDF.co ${endpoint} failed (HTTP ${res.status})` +
                (res.text ? `: ${String(res.text).slice(0, 300)}` : ''),
                'PDFCO_HTTP_ERROR');
        }
        if (res.body.error) {
            throw providerError(`PDF.co ${endpoint} reported: ${res.body.message || 'unknown error'}`,
                'PDFCO_API_ERROR');
        }
        return res.body;
    }

    /** Upload the bytes and return the URL PDF.co will read them from. */
    async function upload(buffer, filename) {
        const presigned = await callJson(
            `/file/upload/get-presigned-url?name=${encodeURIComponent(filename)}&encrypt=true`, {});
        const uploadUrl = presigned.presignedUrl;
        const fileUrl = presigned.url;
        if (!uploadUrl || !fileUrl) {
            throw providerError('PDF.co did not return an upload URL', 'PDFCO_NO_UPLOAD_URL');
        }

        const put = await transport(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buffer
        });
        if (!put.ok) {
            throw providerError(`Uploading the file to PDF.co failed (HTTP ${put.status})`, 'PDFCO_UPLOAD_FAILED');
        }
        return fileUrl;
    }

    /**
     * Extract the table as CSV text.
     * @returns {{csv: string, pdfUrl: string, converted: boolean}}
     */
    async function extractCsv(buffer, filename, extractOptions = {}) {
        const extension = path.extname(String(filename || '')).toLowerCase();
        const isImage = IMAGE_EXTENSIONS.has(extension);

        if (!isImage && !PDF_EXTENSIONS.has(extension)) {
            throw providerError(
                `PDF.co extraction supports ${[...PDF_EXTENSIONS, ...IMAGE_EXTENSIONS].join(', ')}, not "${extension}"`,
                'PDFCO_UNSUPPORTED_TYPE', 400);
        }

        let fileUrl = await upload(buffer, filename || 'timetable' + extension);
        let converted = false;

        // Images are converted to a PDF first: table extraction runs on PDFs.
        if (isImage) {
            const asPdf = await callJson('/pdf/convert/from/image', { url: fileUrl, name: 'timetable.pdf' });
            if (!asPdf.url) throw providerError('PDF.co did not return a converted PDF', 'PDFCO_NO_PDF');
            fileUrl = asPdf.url;
            converted = true;
        }

        // `inline: true` returns the CSV in the response body. OCR is applied
        // automatically for scanned pages when a language is supplied.
        const table = await callJson('/pdf/convert/to/csv', {
            url: fileUrl,
            inline: true,
            lang: extractOptions.lang || 'eng',
            pages: extractOptions.pages || ''
        });

        const csv = typeof table.body === 'string' ? table.body : null;
        if (!csv || !csv.trim()) {
            throw providerError(
                'PDF.co returned no table content for this document. It may not contain a ' +
                'recognisable table, or the scan may be too poor to read.',
                'PDFCO_EMPTY_RESULT');
        }

        return { csv, pdfUrl: fileUrl, converted };
    }

    return {
        name: 'pdf.co',
        configured: Boolean(apiKey),

        /**
         * The documentImporter contract: extract and return CSV text plus a
         * note of what was done. The caller runs it through the normal pipeline.
         */
        async extract(buffer, mimeType, extractOptions = {}) {
            if (!apiKey) {
                throw providerError(
                    'PDF/Image extraction is not configured. Add PDFCO_API_KEY to enable document extraction.',
                    'EXTRACTION_NOT_CONFIGURED', 501);
            }
            const filename = extractOptions.filename || 'timetable.pdf';
            const result = await extractCsv(buffer, filename, extractOptions);
            return {
                csv: result.csv,
                provider: 'pdf.co',
                convertedFromImage: result.converted,
                issues: []
            };
        },

        // Exposed for tests.
        _extractCsv: extractCsv,
        _upload: upload
    };
}

module.exports = { createProvider, IMAGE_EXTENSIONS, PDF_EXTENSIONS };
