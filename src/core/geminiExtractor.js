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

const SUPPORTED_GEMINI_MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
    'gemini-flash-latest',
    'gemini-flash-lite-latest'
];

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
    const primaryModel = options.model || config.geminiModel || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
    const baseUrl = (options.baseUrl || config.geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const timeoutMs = options.timeoutMs || config.geminiTimeoutMs || 35000;
    const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 2;
    const initialDelayMs = Number.isInteger(options.initialDelayMs) ? options.initialDelayMs : 1000;
    const maxDurationMs = options.maxDurationMs || 65000;
    const deadline = Date.now() + maxDurationMs;

    // Check custom mock transport first (allows offline testing)
    if (typeof options.customTransport === 'function') {
        const mockRaw = await options.customTransport({
            stage,
            model: primaryModel,
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
            temperature: 0.1
        }
    };

    const headers = {
        'x-goog-api-key': apiKey.trim()
    };

    const httpPost = options.postJson || postJson;

    // Prioritized model candidate cascade
    const modelsToTry = Array.from(new Set([
        primaryModel,
        ...SUPPORTED_GEMINI_MODELS
    ]));

    let lastError = null;
    let response = null;

    // Bounded multi-round retry loop across prioritized model cascade
    retryLoop:
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
            if (Date.now() >= deadline) {
                lastError = new GeminiExtractionError(
                    'Gemini extraction is taking longer than expected. Please try again.',
                    'GEMINI_TIMEOUT',
                    504
                );
                break retryLoop;
            }

            const currentModel = modelsToTry[mIdx];
            const targetUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(currentModel)}:generateContent`;
            try {
                const res = await httpPost(targetUrl, headers, JSON.stringify(requestPayload), timeoutMs);

                // Authentication failure (non-retryable, fail immediately)
                if (res.status === 401 || res.status === 403) {
                    throw new GeminiExtractionError(
                        'Gemini API authentication failed: invalid API key or insufficient permissions.',
                        'GEMINI_KEY_INVALID',
                        401
                    );
                }

                // Success condition
                if (res.status >= 200 && res.status < 300) {
                    response = res;
                    lastError = null;
                    break retryLoop;
                }

                // Transient error / high demand: log candidate failure, pause briefly, then try next model
                if (isTransientError(res.status, res.body) || res.status === 404) {
                    const errorMsg = (res.body && res.body.error && res.body.error.message)
                        || `Gemini API returned HTTP ${res.status}`;
                    lastError = new GeminiExtractionError(
                        `Gemini API temporary error: ${errorMsg}`,
                        res.status === 429 ? 'GEMINI_RATE_LIMIT' : 'GEMINI_SERVICE_UNAVAILABLE',
                        res.status,
                        res.body
                    );

                    // Add a brief pacing delay between candidate models on transient failures to prevent bursting
                    if (mIdx < modelsToTry.length - 1 && Date.now() + 1200 < deadline) {
                        await sleep(1200);
                    }
                    continue;
                } else {
                    const errorMsg = (res.body && res.body.error && res.body.error.message)
                        || `Gemini API returned HTTP ${res.status}`;
                    lastError = new GeminiExtractionError(
                        `Gemini API error: ${errorMsg}`,
                        'GEMINI_API_ERROR',
                        res.status,
                        res.body
                    );
                    continue;
                }
            } catch (netErr) {
                if (netErr instanceof GeminiExtractionError && (netErr.code === 'GEMINI_KEY_INVALID' || netErr.code === 'GEMINI_API_ERROR')) {
                    throw netErr;
                }
                lastError = netErr;
                if (mIdx < modelsToTry.length - 1 && Date.now() + 1000 < deadline) {
                    await sleep(1000);
                }
                continue;
            }
        }

        // If all models in the cascade failed on this attempt, back off before the next attempt round
        if (attempt < maxRetries && Date.now() + 1500 < deadline) {
            const backoffMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), 4000) + Math.floor(Math.random() * 300);
            await sleep(backoffMs);
        }
    }

    if (lastError || !response || response.status < 200 || response.status >= 300) {
        throw lastError || new GeminiExtractionError('Gemini extraction is taking longer than expected. Please try again.', 'GEMINI_EXTRACTION_FAILED', 502);
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
