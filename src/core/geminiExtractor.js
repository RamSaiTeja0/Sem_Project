/**
 * Gemini Vision Extractor — Phase B2.4 Stage 1
 *
 * Implements multimodal extraction of timetable images/PDFs using Google Gemini AI.
 * Enforces strict JSON output, bounded exponential backoff retry for transient errors,
 * model fallback on unavailable endpoints, robust markdown-fence stripping,
 * and zero logging/exposure of API secrets.
 */

const https = require('https');
const http = require('http');
const config = require('../config');
const { buildExtractionPrompt, buildVerificationPrompt } = require('./geminiPrompt');

/**
 * Strip Markdown code blocks (e.g. ```json ... ``` or ``` ... ```) from text.
 *
 * @param {string} rawText
 * @returns {string}
 */
function cleanMarkdownFences(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText.trim();
    // Match ```json ... ``` or ``` ... ```
    const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }
    return text;
}

/**
 * Custom error class for Gemini extraction errors.
 */
class GeminiExtractionError extends Error {
    constructor(message, code = 'GEMINI_ERROR', status = 500, details = null) {
        super(message);
        this.name = 'GeminiExtractionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

/**
 * Helper delay function for exponential backoff.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executes an HTTP/HTTPS POST request with timeout and response parsing.
 *
 * @param {string} urlString
 * @param {Object} headers
 * @param {string} bodyData
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: any, raw: string }>}
 */
function postJson(urlString, headers, bodyData, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyData),
                ...headers
            },
            timeout: timeoutMs
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = null;
                }
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    raw: data
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new GeminiExtractionError(
                `Gemini API request timed out after ${timeoutMs}ms.`,
                'GEMINI_TIMEOUT',
                504
            ));
        });

        req.on('error', (err) => {
            reject(new GeminiExtractionError(
                `Gemini network request failed: ${err.message}`,
                'GEMINI_NETWORK_ERROR',
                502
            ));
        });

        req.write(bodyData);
        req.end();
    });
}

/**
 * Checks whether an HTTP response or error indicates a transient condition eligible for retry.
 */
function isTransientError(status, errorBody = null) {
    if ([429, 500, 502, 503, 504].includes(status)) return true;
    if (errorBody && errorBody.error) {
        const msg = String(errorBody.error.message || '');
        if (/experiencing high demand|temporarily unavailable|resource exhausted|rate limit|quota|overloaded/i.test(msg)) {
            return true;
        }
    }
    return false;
}

/**
 * Internal executor for multimodal Gemini API requests with exponential backoff & model fallback.
 *
 * @param {Object} executionParams
 * @param {string} executionParams.promptText
 * @param {Buffer} executionParams.fileBuffer
 * @param {string} executionParams.mimeType
 * @param {number} executionParams.stage - 1 or 2
 * @param {Object} [executionParams.stage1Json]
 * @param {Object} [executionParams.uploadContext]
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function executeGeminiMultimodal(executionParams, options = {}) {
    const { promptText, fileBuffer, mimeType, stage = 1, stage1Json, uploadContext } = executionParams;

    if (!fileBuffer || !Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
        throw new GeminiExtractionError(
            'Cannot process empty or missing file buffer.',
            'EMPTY_FILE',
            400
        );
    }

    const apiKey = (options.apiKey !== undefined) ? options.apiKey : (config.geminiApiKey || process.env.GEMINI_API_KEY);
    const model = options.model || config.geminiModel || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
    const baseUrl = (options.baseUrl || config.geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const timeoutMs = options.timeoutMs || config.geminiTimeoutMs || 60000;
    const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
    const initialDelayMs = Number.isInteger(options.initialDelayMs) ? options.initialDelayMs : 1000;

    // Check custom mock transport first (allows offline testing)
    if (typeof options.customTransport === 'function') {
        const mockRaw = await options.customTransport({
            stage,
            model,
            fileBuffer,
            mimeType,
            uploadContext,
            stage1Json,
            promptText
        });
        return processGeminiOutput(mockRaw);
    }

    // Require API key for real call
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new GeminiExtractionError(
            'Gemini API key is not configured. Set GEMINI_API_KEY environment variable.',
            'GEMINI_KEY_MISSING',
            500
        );
    }

    const base64Data = fileBuffer.toString('base64');

    const requestPayload = {
        contents: [
            {
                parts: [
                    { text: promptText },
                    {
                        inlineData: {
                            mimeType: mimeType || 'image/png',
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            thinkingConfig: {
                thinkingBudget: 0
            }
        }
    };

    const targetUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const headers = {
        'x-goog-api-key': apiKey.trim()
    };

    let lastError = null;
    let response = null;

    // Bounded exponential backoff retry loop
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            response = await postJson(targetUrl, headers, JSON.stringify(requestPayload), timeoutMs);

            // Automatic fallback if model is unavailable or overloaded (404 / 503)
            if (response.body && response.body.error) {
                const msg = String(response.body.error.message || '');
                if (/is no longer available|experiencing high demand|not found/i.test(msg) || response.status === 404 || response.status === 503) {
                    const fallbackModels = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemini-3.6-flash'];
                    for (const fallbackModel of fallbackModels) {
                        if (model !== fallbackModel) {
                            const fallbackUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(fallbackModel)}:generateContent`;
                            const fallbackRes = await postJson(fallbackUrl, headers, JSON.stringify(requestPayload), timeoutMs);
                            if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
                                response = fallbackRes;
                                break;
                            }
                        }
                    }
                }
            }

            // Success condition
            if (response.status >= 200 && response.status < 300) {
                lastError = null;
                break;
            }

            // Authentication failure (non-retryable)
            if (response.status === 401 || response.status === 403) {
                throw new GeminiExtractionError(
                    'Gemini API authentication failed: invalid API key or insufficient permissions.',
                    'GEMINI_KEY_INVALID',
                    401
                );
            }

            // Check if transient error eligible for retry
            if (isTransientError(response.status, response.body)) {
                const errorMsg = (response.body && response.body.error && response.body.error.message)
                    || `Gemini API returned HTTP ${response.status}`;
                lastError = new GeminiExtractionError(
                    `Gemini API temporary error: ${errorMsg}`,
                    response.status === 429 ? 'GEMINI_RATE_LIMIT' : 'GEMINI_SERVICE_UNAVAILABLE',
                    response.status,
                    response.body
                );

                if (attempt < maxRetries) {
                    const backoffMs = initialDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
                    await sleep(backoffMs);
                    continue;
                }
            } else {
                // Non-retryable error
                const errorMsg = (response.body && response.body.error && response.body.error.message)
                    || `Gemini API returned HTTP ${response.status}`;
                throw new GeminiExtractionError(
                    `Gemini API error: ${errorMsg}`,
                    'GEMINI_API_ERROR',
                    response.status,
                    response.body
                );
            }
        } catch (netErr) {
            if (netErr instanceof GeminiExtractionError && (netErr.code === 'GEMINI_KEY_INVALID' || netErr.code === 'GEMINI_API_ERROR')) {
                throw netErr;
            }
            lastError = netErr;
            if (attempt < maxRetries) {
                const backoffMs = initialDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
                await sleep(backoffMs);
                continue;
            }
        }
    }

    if (lastError || !response || response.status < 200 || response.status >= 300) {
        throw lastError || new GeminiExtractionError('Gemini API extraction failed after retries.', 'GEMINI_EXTRACTION_FAILED', 502);
    }

    // Parse candidate text from Gemini response structure
    const candidates = response.body && response.body.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new GeminiExtractionError(
            'Gemini returned an empty candidate list.',
            'MALFORMED_RESPONSE',
            502
        );
    }

    const candidate = candidates[0];
    const parts = candidate.content && candidate.content.parts;
    if (!Array.isArray(parts) || parts.length === 0 || !parts[0].text) {
        throw new GeminiExtractionError(
            'Gemini candidate has no text output part.',
            'MALFORMED_RESPONSE',
            502
        );
    }

    return processGeminiOutput(parts[0].text);
}

/**
 * Extracts timetable data using Stage 1 Gemini Vision with bounded exponential backoff.
 *
 * @param {Object} params
 * @param {Buffer} params.fileBuffer - Raw file binary
 * @param {string} params.mimeType - 'application/pdf', 'image/png', 'image/jpeg', 'image/webp'
 * @param {Object} params.uploadContext - { departmentCode, uploadType, facultyName, className, originalFilename }
 * @param {Object} [options]
 * @param {string} [options.apiKey] - Override API key
 * @param {string} [options.model] - Override model name
 * @param {string} [options.baseUrl] - Override base URL
 * @param {number} [options.timeoutMs] - Override timeout
 * @param {number} [options.maxRetries] - Max retry attempts for transient errors (default 3)
 * @param {number} [options.initialDelayMs] - Initial delay in ms for exponential backoff (default 1000)
 * @param {Function} [options.customTransport] - Mock transport function for testing (receives request payload)
 * @returns {Promise<Object>} The parsed B2.1 JSON extracted from the document
 */
async function extractTimetableWithGemini(params, options = {}) {
    const promptText = buildExtractionPrompt(params.uploadContext || {});
    return executeGeminiMultimodal({
        promptText,
        fileBuffer: params.fileBuffer,
        mimeType: params.mimeType,
        stage: 1,
        uploadContext: params.uploadContext
    }, options);
}

/**
 * Verifies and corrects Stage 1 timetable JSON using Stage 2 Gemini Vision with the original document image.
 *
 * @param {Object} params
 * @param {Buffer} params.fileBuffer - Raw file binary of original image/PDF
 * @param {string} params.mimeType - 'application/pdf', 'image/png', 'image/jpeg', 'image/webp'
 * @param {Object|string} params.stage1Json - Stage 1 draft JSON extracted previously
 * @param {Object} params.uploadContext - { departmentCode, uploadType, facultyName, className, originalFilename }
 * @param {Object} [options]
 * @param {string} [options.apiKey] - Override API key
 * @param {string} [options.model] - Override model name
 * @param {string} [options.baseUrl] - Override base URL
 * @param {number} [options.timeoutMs] - Override timeout
 * @param {number} [options.maxRetries] - Max retry attempts for transient errors (default 3)
 * @param {number} [options.initialDelayMs] - Initial delay in ms for exponential backoff (default 1000)
 * @param {Function} [options.customTransport] - Mock transport function for testing (receives request payload)
 * @returns {Promise<Object>} The verified and corrected B2.1 JSON
 */
async function verifyTimetableWithGemini(params, options = {}) {
    if (!params.stage1Json) {
        throw new GeminiExtractionError(
            'Stage 1 JSON is required for Stage 2 verification.',
            'INVALID_STAGE1_INPUT',
            400
        );
    }
    const promptText = buildVerificationPrompt(params.uploadContext || {}, params.stage1Json);
    return executeGeminiMultimodal({
        promptText,
        fileBuffer: params.fileBuffer,
        mimeType: params.mimeType,
        stage: 2,
        stage1Json: params.stage1Json,
        uploadContext: params.uploadContext
    }, options);
}

/**
 * Strips markdown fences, parses JSON, and validates that the root output is a valid object.
 *
 * @param {string|Object} rawOutput
 * @returns {Object}
 */
function processGeminiOutput(rawOutput) {
    if (typeof rawOutput === 'object' && rawOutput !== null) {
        return rawOutput;
    }

    if (typeof rawOutput !== 'string' || rawOutput.trim().length === 0) {
        throw new GeminiExtractionError(
            'Gemini returned empty text output.',
            'MALFORMED_RESPONSE',
            502
        );
    }

    const cleanedText = cleanMarkdownFences(rawOutput);

    let parsed;
    try {
        parsed = JSON.parse(cleanedText);
    } catch (parseErr) {
        throw new GeminiExtractionError(
            `Failed to parse Gemini output as JSON: ${parseErr.message}`,
            'INVALID_JSON',
            422,
            { rawSnippet: cleanedText.slice(0, 300) }
        );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GeminiExtractionError(
            'Gemini output parsed to a non-object root.',
            'INVALID_JSON',
            422
        );
    }

    return parsed;
}

module.exports = {
    extractTimetableWithGemini,
    verifyTimetableWithGemini,
    processGeminiOutput,
    cleanMarkdownFences,
    isTransientError,
    sleep,
    GeminiExtractionError
};
