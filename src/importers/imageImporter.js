/**
 * Image Timetable Importer (Phase B2)
 *
 * Direct Gemini Vision Stage 1 + Stage 2 multimodal timetable extraction.
 *
 * Routing:
 *   IMAGE (JPG, JPEG, PNG, WebP)
 *     -> original image buffer
 *     -> Gemini Stage 1 (Initial draft)
 *     -> Stage 1 JSON safety check
 *     -> Gemini Stage 2 (Original Image + Stage 1 JSON)
 *     -> B2.1 contract validation
 *     -> normalization (contractToSource)
 *     -> entity resolution
 *     -> preview / staging
 *     -> HOD preview & approval
 *
 * Does NOT convert images to PDF or CSV.
 * Does NOT assume a fixed timetable grid, fixed 6-day, or fixed 7-period schedule.
 * Does NOT require "Faculty" or "Monday P1" spreadsheet column headers.
 */

const path = require('path');
const config = require('../config');
const {
    extractTimetableWithGemini,
    verifyTimetableWithGemini,
    GeminiExtractionError
} = require('../core/geminiExtractor');
const { validateExtractedContract } = require('../core/contractValidator');
const { resolveContract } = require('../core/entityResolver');
const { saveUploadRecord, saveStagedData } = require('../data/uploads');

const SUPPORTED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

const ALTERNATIVES = [
    'Import from Excel (.xlsx / .xls)',
    'Import from CSV',
    'Quick Paste (paste the table as text)',
    'Manual Timetable Entry'
];

function mimeTypeFor(filename, fallbackMime) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return MIME_TYPES[ext] || fallbackMime || 'image/jpeg';
}

/**
 * Converts a verified Phase B2.1 LLM JSON Contract into the internal timetable source shape
 * expected by normalizer.normalize(source).
 *
 * Preserves dynamic days, periods, timings, merged spans, activities, and faculty roster.
 */
function contractToSource(payload, uploadContext = {}) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid contract JSON payload');
    }

    const isFacultyTimetable = payload.timetable_type === 'FACULTY_TIMETABLE' || (uploadContext && uploadContext.uploadType === 'FACULTY_TIMETABLE');
    const defaultClass = payload.class_name || (uploadContext && uploadContext.className) || null;
    const department = payload.department_code || (uploadContext && uploadContext.departmentCode) || 'General';

    // Dynamic Meta: Preserve exact days and periods from source
    const rawDays = Array.isArray(payload.days) && payload.days.length > 0
        ? payload.days.map(d => String(d).trim())
        : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const rawPeriods = Array.isArray(payload.periods) && payload.periods.length > 0
        ? payload.periods.map(p => typeof p === 'object' && p !== null ? parseInt(p.period || p.period_number, 10) : parseInt(p, 10)).filter(p => !isNaN(p))
        : [1, 2, 3, 4, 5, 6, 7];

    const periodTimings = Array.isArray(payload.period_timings)
        ? payload.period_timings.map(p => (typeof p === 'object' && p !== null && p.start && p.end) ? `${p.start}-${p.end}` : '')
        : (Array.isArray(payload.periods) && typeof payload.periods[0] === 'object' ? payload.periods.map(p => `${p.start_time || ''}-${p.end_time || ''}`) : []);

    const meta = {
        days: rawDays,
        periods: rawPeriods,
        periodTimings,
        classes: defaultClass ? [defaultClass] : [],
        department,
        academicYear: payload.academic_year || null,
        semester: payload.semester || null
    };

    // Faculty Roster: populated from legend and entries
    const facultyMap = new Map();

    const facultyLegends = payload.faculty_legend || (payload.legend && payload.legend.faculty) || [];
    if (Array.isArray(facultyLegends)) {
        facultyLegends.forEach(f => {
            const name = f.name ? String(f.name).trim() : null;
            if (name) {
                facultyMap.set(name.toUpperCase(), {
                    id: f.code ? String(f.code).trim() : name,
                    name,
                    department: f.department || department
                });
            }
        });
    }

    if (payload.faculty_name) {
        const name = String(payload.faculty_name).trim();
        if (name && !facultyMap.has(name.toUpperCase())) {
            facultyMap.set(name.toUpperCase(), {
                id: name,
                name,
                department
            });
        }
    }

    if (uploadContext && uploadContext.facultyName) {
        const name = String(uploadContext.facultyName).trim();
        if (name && !facultyMap.has(name.toUpperCase())) {
            facultyMap.set(name.toUpperCase(), {
                id: name,
                name,
                department
            });
        }
    }

    // Timetable Entries
    const entries = [];
    const rawEntries = Array.isArray(payload.entries) ? payload.entries : [];

    rawEntries.forEach(e => {
        if (!e || typeof e !== 'object') return;

        const day = e.day ? String(e.day).trim() : null;
        const startPeriod = parseInt(e.period != null ? e.period : e.period_number, 10);
        if (!day || isNaN(startPeriod)) return;

        const endPeriod = e.span_to != null ? parseInt(e.span_to, 10) : (e.span != null ? (startPeriod + parseInt(e.span, 10) - 1) : startPeriod);
        const subject = e.is_free ? 'FREE' : (e.subject_name ? String(e.subject_name).trim() : (e.subject_code ? String(e.subject_code).trim() : ''));
        const facultyName = e.faculty_name ? String(e.faculty_name).trim() : (isFacultyTimetable ? (payload.faculty_name || (uploadContext && uploadContext.facultyName)) : null);
        const className = (e.class_name ? String(e.class_name).trim() : null) || defaultClass;
        const room = e.room_code || e.room || null;
        const sessionType = e.session_type ? String(e.session_type).trim().toLowerCase() : 'theory';
        const isFree = Boolean(e.is_free) || !subject || subject.toUpperCase() === 'FREE';

        if (facultyName && !facultyMap.has(facultyName.toUpperCase()) && !isFree) {
            facultyMap.set(facultyName.toUpperCase(), {
                id: e.faculty_code ? String(e.faculty_code).trim() : facultyName,
                name: facultyName,
                department
            });
        }

        // Expand multi-period spans to discrete slot records for normalization
        for (let p = startPeriod; p <= endPeriod; p++) {
            entries.push({
                faculty: isFree ? null : facultyName,
                day,
                period: p,
                subject: isFree ? 'FREE' : subject,
                class: className,
                room,
                type: sessionType,
                status: isFree ? 'free' : (facultyName ? 'busy' : 'activity')
            });
        }
    });

    const faculty = Array.from(facultyMap.values());

    return {
        meta,
        faculty,
        entries
    };
}

/**
 * Parses an image timetable directly using Gemini Stage 1 + Stage 2 Vision pipeline.
 */
async function parse(buffer, options = {}) {
    if (!buffer || buffer.length === 0) {
        const error = new Error('The uploaded image is empty');
        error.code = 'EMPTY_FILE';
        throw error;
    }

    const filename = options.filename || 'timetable.jpeg';
    const mimeType = mimeTypeFor(filename, options.mimeType);

    const documentImporter = require('./documentImporter');
    if (documentImporter.isOverridden && documentImporter.isOverridden() && !options.geminiTransport && !options.stage1Transport) {
        return documentImporter.parse(buffer, options);
    }

    const hasGeminiKey = Boolean(config.geminiApiKey || options.apiKey);
    const hasCustomTransport = Boolean(options.geminiTransport || options.stage1Transport);

    if (!hasGeminiKey && !hasCustomTransport) {
        const error = new Error(
            'Gemini Vision extraction is not configured. Add GEMINI_API_KEY to enable image ' +
            'timetable extraction. Use ' + ALTERNATIVES.join(', ') + ' instead.');
        error.code = 'EXTRACTION_NOT_CONFIGURED';
        error.status = 501;
        error.alternatives = ALTERNATIVES;
        throw error;
    }

    const isFaculty = (options.session && options.session.role === 'faculty') || options.uploadType === 'FACULTY_TIMETABLE' || options.isFacultyTimetable === true;
    const uploadContext = {
        departmentCode: (options.session && options.session.department) || options.departmentCode || config.branchCode || 'CME',
        uploadType: isFaculty ? 'FACULTY_TIMETABLE' : (options.uploadType || 'MASTER_TIMETABLE'),
        facultyName: isFaculty ? ((options.session && (options.session.facultyName || options.session.username)) || options.facultyName || null) : (options.facultyName || null),
        className: options.defaultClass || options.className || null,
        originalFilename: filename
    };

    let uploadId = options.uploadId;
    if (!uploadId) {
        try {
            const record = await saveUploadRecord({
                originalFilename: filename,
                fileType: mimeType,
                fileSize: buffer.length,
                uploaderUserId: options.session ? (options.session.userId || options.session.username) : null,
                departmentCode: uploadContext.departmentCode,
                academicYear: options.academicYear || (options.session && options.session.academicYear) || null,
                semester: options.semester || (options.session && options.session.semester) || null,
                section: options.section || null,
                targetClass: options.defaultClass || options.targetClass || null,
                uploadType: uploadContext.uploadType,
                status: 'PROCESSING'
            });
            uploadId = record.uploadId;
        } catch (e) {
            // Non-blocking fallback for offline/isolated tests
        }
    }

    // Stage 1: Initial Vision Draft Extraction
    const stage1Json = await extractTimetableWithGemini({
        fileBuffer: buffer,
        mimeType,
        uploadContext
    }, {
        apiKey: options.apiKey,
        model: options.model,
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        postJson: options.postJson,
        customTransport: options.stage1Transport || options.geminiTransport || options.customTransport
    });

    if (!stage1Json || typeof stage1Json !== 'object' || Array.isArray(stage1Json)) {
        const error = new Error('Gemini Stage 1 extraction returned an invalid structure');
        error.code = 'INVALID_JSON_STRUCTURE';
        throw error;
    }

    // Stage 2: Multimodal Verification (Original Image + Stage 1 JSON)
    const stage2Json = await verifyTimetableWithGemini({
        fileBuffer: buffer,
        mimeType,
        stage1Json,
        uploadContext
    }, {
        apiKey: options.apiKey,
        model: options.model,
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        postJson: options.postJson,
        customTransport: options.stage2Transport || options.geminiTransport || options.customTransport
    });

    // Final B2.1 Contract Validation
    const validationRecord = {
        uploadId: uploadId || null,
        uploadType: uploadContext.uploadType,
        facultyId: uploadContext.facultyName,
        ...(options.session && options.session.department ? { departmentCode: options.session.department } : {})
    };

    const validation = validateExtractedContract(stage2Json, validationRecord, {
        skipCatalogCheck: true,
        timetableType: uploadContext.uploadType,
        facultyName: uploadContext.facultyName,
        isFacultyTimetable: isFaculty
    });
    if (!validation.ok) {
        const error = new Error('Timetable validation failed:\n  - ' + validation.errors.join('\n  - '));
        error.code = validation.code || 'VALIDATION_FAILED';
        error.status = 422;
        error.details = validation.errors;
        throw error;
    }

    // Catalog Entity Resolution
    let resolution = { ok: true, unresolvedEntities: [], unresolvedCount: 0 };
    try {
        resolution = await resolveContract(stage2Json, uploadContext.departmentCode);
    } catch (e) {
        // Non-blocking for preview
    }

    // Persist staged data for HOD review & explicit approval gate
    if (uploadId) {
        try {
            await saveStagedData(
                uploadId,
                stage2Json,
                validation.ok ? 'VALID' : 'INVALID',
                validation.errors && validation.errors.length > 0 ? validation.errors : null,
                {
                    unresolvedEntities: resolution.unresolvedEntities || []
                }
            );
        } catch (e) {
            // Non-blocking fallback
        }
    }

    const source = contractToSource(stage2Json, uploadContext);

    return {
        source,
        format: 'image',
        provider: 'gemini-vision',
        layout: stage2Json.timetable_type || 'visual',
        rowCount: source.entries ? source.entries.length : 0,
        rawContract: stage2Json,
        uploadId: uploadId || null,
        unresolvedEntities: resolution.unresolvedEntities || [],
        issues: (validation.errors || []).map(msg => ({ severity: 'warning', code: 'VALIDATION_WARNING', message: msg }))
    };
}

module.exports = {
    parse,
    contractToSource,
    SUPPORTED_IMAGE_EXTS
};
