/**
 * Gemini Timetable Extraction Prompt — Phase B2.4 Stage 1
 *
 * Implements strict, generic Stage 1 extraction prompt adhering to Phase B2.1 JSON contract
 * (docs/PHASE_B2_1_JSON_CONTRACT.md).
 *
 * Enforces zero-hallucination rules, dynamic detection of days/periods/legends,
 * exact schema compliance, and zero hardcoded college/department/faculty data.
 */

const B2_1_SAMPLE_SCHEMA = {
    contract_version: "2.1",
    timetable_type: "MASTER_TIMETABLE", // or "FACULTY_TIMETABLE"
    institution_name: null, // string or null
    title: null, // string or null
    department_code: "BRANCH_CODE", // string e.g. "CME", "EEE", "MEC", "CSE"
    academic_year: null, // string e.g. "2025-2026" or null
    semester: null, // Integer 1-12, NOT Roman numeral string, or null
    class_name: null, // string e.g. "CLASS-SECTION" or null
    faculty_name: null, // string or null
    faculty_code: null, // string or null
    default_room: null, // string or null
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], // dynamically detected visible days
    periods: [1, 2, 3, 4, 5, 6, 7], // dynamically detected visible period numbers
    period_timings: {
        "1": { "start": "08:00", "end": "08:45" }
    }, // mapped if clock times are visible, otherwise null
    faculty_legend: [
        {
            code: "FAC_CODE_OR_ABBREVIATION",
            name: "Full Faculty Name",
            designation: "Designation or null",
            department: "Department or null"
        }
    ], // dynamically extracted from staff/faculty legend table if visible; otherwise []
    subject_legend: [
        {
            code: "SUBJECT_CODE_OR_NULL",
            name: "Full Subject Name",
            short_name: "ABBREVIATION_OR_NULL"
        }
    ], // dynamically extracted from subject/course legend table if visible; otherwise []
    entries: [
        {
            day: "Monday",
            period: 1,
            span_to: null, // integer end period if multi-period span/merged cell; otherwise null
            subject_name: "Subject Name",
            subject_code: null,
            faculty_name: "Faculty Name",
            class_name: "Class Name",
            room_code: null,
            session_type: "theory", // "theory", "lab", or "activity"
            is_free: false,
            raw_cell_text: "RAW TEXT"
        }
    ],
    extraction_metadata: {
        confidence_score: 0.95,
        warnings: []
    }
};

/**
 * Builds the strict Gemini system and user prompt for Stage 1 timetable extraction.
 *
 * @param {Object} uploadContext
 * @param {string} uploadContext.departmentCode - Authoritative branch code
 * @param {string} uploadContext.uploadType - "MASTER_TIMETABLE" or "FACULTY_TIMETABLE"
 * @param {string|null} [uploadContext.facultyName] - Authoritative faculty name if FACULTY_TIMETABLE
 * @param {string|null} [uploadContext.className] - Authoritative class name if known
 * @param {string|null} [uploadContext.originalFilename] - Original filename
 * @returns {string} The prompt text
 */
function buildExtractionPrompt(uploadContext = {}) {
    const dept = uploadContext.departmentCode || uploadContext.department || 'UNKNOWN';
    const uploadType = uploadContext.uploadType || 'MASTER_TIMETABLE';
    const faculty = uploadContext.facultyName || null;
    const className = uploadContext.className || null;

    return `You are a high-precision academic timetable vision and document analysis system.
Analyze the attached timetable image or PDF document and extract its complete schedule into valid JSON following the strict B2.1 JSON contract below.

AUTHORITATIVE UPLOAD CONTEXT:
- Expected Timetable Context: "${uploadType}"
- Expected Department/Branch Code: "${dept}"
${faculty ? `- Uploaded By Faculty: "${faculty}" (The image may be a multi-faculty class schedule OR a personal timetable; extract ALL entries for ALL faculty visible)\n` : ''}${className ? `- Expected Class/Section Name: "${className}" (belongs under branch "${dept}")\n` : ''}
CRITICAL RULES & GENERAL EXTRACTION INSTRUCTIONS:

1. OUTPUT FORMAT:
   - OUTPUT ONLY VALID JSON.
   - DO NOT wrap the output in Markdown code blocks (do NOT use \`\`\`json or \`\`\`).
   - DO NOT include introductory, explanatory, or concluding text. Output JSON only.

2. DYNAMIC STRUCTURE DETECTION (NO FIXED ASSUMPTIONS):
   - DAYS: Inspect the grid headers/row labels and extract ONLY the days actually present (e.g. 5 days, 6 days, or 7 days). Do NOT assume a fixed Monday-Saturday week.
   - PERIODS: Inspect the column/period headers and extract ONLY the period numbers actually present (e.g. [1..6], [1..7], [1..8], etc.). Do NOT assume a fixed period count.
   - PERIOD TIMINGS: If period headers contain visible clock times (e.g. '08:00 - 08:45', '10:30-11:15'), map period strings to objects with "start" and "end" in "HH:MM" 24h format. If no clock times are visible, set "period_timings": null.

3. DYNAMIC FACULTY & SUBJECT LEGENDS:
   - If the document contains a faculty/staff legend or list (mapping initials/codes to full names/designations):
     * Extract every entry into the "faculty_legend" array: [{ "code": "...", "name": "...", "designation": "..." or null, "department": "..." or null }].
     * If no faculty legend is present, return "faculty_legend": [].
   - If the document contains a subject/course legend or list (mapping short names/codes to full subject titles):
     * Extract every entry into the "subject_legend" array: [{ "code": "..." or null, "name": "...", "short_name": "..." or null }].
     * If no subject legend is present, return "subject_legend": [].

4. GRID CELL & LEGEND CROSS-REFERENCING:
   - Timetable grid cells often use abbreviations or short codes.
   - When abbreviations are used in grid cells:
     * Cross-reference with the extracted "subject_legend" to resolve the full "subject_name" and "subject_code".
     * Cross-reference with the extracted "faculty_legend" to resolve the full "faculty_name" and "faculty_code".
   - In "raw_cell_text", ALWAYS preserve the exact verbatim text as printed inside the timetable grid cell.
   - If an abbreviation is not found in any legend, do NOT invent a name; record the visible cell text verbatim.

5. MULTI-PERIOD SESSIONS & MERGED CELLS (COLSPAN / ROWSPAN):
   - When a lab, practical, workshop, drawing, or lecture spans multiple consecutive periods (merged cell horizontally across columns):
     * Emit EXACTLY ONE entry for that merged block.
     * Set "period" to the start period of the cell (e.g. 1, 4, 5).
     * Set "span_to" to the ending period of the cell (e.g. 2, 6, 7).
     * CRITICAL NEGATIVE CONSTRAINT: DO NOT emit separate or duplicate entries for any of the periods covered by the span (e.g. if a cell spans period 1 to 2, emit ONE entry with period=1 and span_to=2; DO NOT emit an entry for period 2).
   - For single-period cells, "span_to" MUST be null.
   - If a cell is merged vertically across days for the same period, emit one entry for each day.

6. SCHEDULED ACTIVITIES vs. FREE / RECESS SLOTS:
   - SCHEDULED ACTIVITIES (e.g., Library, Sports, Games, Mentoring, Placement, Training, Seminar, Counselling, Assembly, TPC):
     * Set "session_type": "activity"
     * Set "is_free": false
     * Set "subject_name": to the visible activity name. "subject_name" MUST NEVER be null for a scheduled slot.
     * Set "faculty_name": the instructor's name if printed; otherwise null.
   - BLANK, FREE, RECESS, OR BREAK SLOTS:
     * ONLY cells that are genuinely unscheduled, blank, or marked as break/recess/lunch (e.g. empty cell, "-", "--", "FREE", "NIL", "RECESS", "BREAK", "LUNCH"):
       - Set "is_free": true
       - Set "subject_name": null
       - Set "faculty_name": null
       - Set "session_type": "theory" (or "activity" if break)

7. SESSION TYPE CLASSIFICATION:
   - "theory" for standard classroom lectures.
   - "lab" for laboratory, workshop, drawing, or practical sessions.
   - "activity" for sports, library, mentoring, placement, counselling, or non-curricular periods.

8. ZERO-HALLUCINATION NEGATIVE CONSTRAINTS:
   - DO NOT invent faculty names if not printed in the cell or legend.
   - DO NOT invent subjects or subject codes.
   - DO NOT invent classrooms or room numbers (set "room_code": null if unstated).
   - DO NOT invent period timings if clock times are not printed in column headers.
   - If any field is not clearly visible in the document or legend, you MUST set its value to null.

9. SEMESTER, ACADEMIC YEAR & METADATA:
   - "semester": Must be an integer between 1 and 12. Convert Roman numerals to integers (e.g. "IV SEM" -> 4, "V SEM" -> 5, "VI" -> 6). If unstated, set to null.
   - "academic_year": Format "YYYY-YY" or "YYYY-YYYY" (e.g. "2025-2026"), or null if unstated.
   - "class_name": Class or section identifier if visible (e.g. from header), or upload context class name.
   - "department_code": Set to "${dept}".
   - "timetable_type": Set to "${uploadType}".

EXACT REQUIRED JSON SCHEMA AND STRUCTURE:
${JSON.stringify(B2_1_SAMPLE_SCHEMA, null, 2)}

Now, examine the document carefully and output the extracted JSON:`;
}

/**
 * Builds the strict Gemini system and user prompt for Stage 2 timetable verification and correction.
 *
 * @param {Object} uploadContext
 * @param {string} uploadContext.departmentCode - Authoritative branch code
 * @param {string} uploadContext.uploadType - "MASTER_TIMETABLE" or "FACULTY_TIMETABLE"
 * @param {string|null} [uploadContext.facultyName] - Authoritative faculty name if FACULTY_TIMETABLE
 * @param {string|null} [uploadContext.className] - Authoritative class name if known
 * @param {string|null} [uploadContext.originalFilename] - Original filename
 * @param {Object|string} stage1Json - The Stage 1 draft JSON extracted from the document
 * @returns {string} The verification prompt text
 */
function buildVerificationPrompt(uploadContext = {}, stage1Json = {}) {
    const dept = uploadContext.departmentCode || uploadContext.department || 'UNKNOWN';
    const uploadType = uploadContext.uploadType || 'MASTER_TIMETABLE';
    const faculty = uploadContext.facultyName || null;
    const className = uploadContext.className || null;
    const stage1Text = typeof stage1Json === 'string' ? stage1Json : JSON.stringify(stage1Json);

    return `You are a high-precision academic timetable verification, error-correction, and visual structure analysis system.
You are given the ORIGINAL timetable document image (attached) AND a STAGE 1 DRAFT JSON previously extracted from it.

Your objective is to inspect the original image and verify/correct the Stage 1 JSON to produce an accurate, complete, and verified B2.1 JSON representation.

AUTHORITATIVE UPLOAD CONTEXT:
- Expected Timetable Context: "${uploadType}"
- Expected Department/Branch Code: "${dept}"
${faculty ? `- Uploaded By Faculty: "${faculty}" (The image may be a multi-faculty class schedule OR a personal timetable; verify ALL entries for ALL faculty visible)\n` : ''}${className ? `- Expected Class/Section Name: "${className}" (belongs under branch "${dept}")\n` : ''}
STAGE 1 DRAFT JSON TO VERIFY:
${stage1Text}

CRITICAL VERIFICATION & STRUCTURE PRESERVATION INSTRUCTIONS:

1. MULTIMODAL SOURCE OF TRUTH:
   - The attached ORIGINAL IMAGE is the absolute source of truth for both DATA and STRUCTURE.
   - Compare every entry, header, legend, and cell in the Stage 1 JSON against what is visually present in the image.
   - Correct any extraction errors, missed cells, misaligned periods/days, or misread text.
   - Preserve correct Stage 1 values that accurately match the image.

2. STRUCTURE PRESERVATION (ARBITRARY TIMETABLE LAYOUTS):
   - DO NOT assume or force any fixed timetable template (do NOT force 7 periods, 6 days, Monday-Saturday, or fixed axes).
   - Support arbitrary layouts: horizontal days, vertical days, transposed period axes, embedded timings, custom period counts (e.g. 5, 6, 7, 8, etc.), custom day sets (e.g. 5 days, 6 days, 7 days).
   - "days": Must contain ONLY the days actually present in the source timetable.
   - "periods": Must contain ONLY the period numbers actually present in the source timetable.
   - "period_timings": Map period numbers to visible clock times ("start", "end" in 24h "HH:MM") if printed in the timetable headers; otherwise set to null.

3. DYNAMIC FACULTY & SUBJECT LEGEND RESOLUTION:
   - Carefully inspect any staff/faculty legend and subject/course legend visible in the image (at the bottom, side, or top).
   - Update "faculty_legend" and "subject_legend" arrays with all items visible in the document.
   - RESOLVE GRID ABBREVIATIONS:
     * If a timetable cell contains a subject abbreviation (e.g. "PE", "EM-II", "GME", "ED", "EI&E", "PS-I", "CS LAB") and the image contains a subject legend mapping it to a full title, resolve "subject_name" to the full title and "subject_code" to the official course code.
     * If a timetable cell has a missing or abbreviated faculty name (e.g. cell has only subject "PE" or abbreviation "DSK"), cross-reference the subject or initials with the visible faculty/staff legend to resolve the full "faculty_name" and "faculty_code".
     * NEVER hardcode any specific faculty name or subject code; resolve strictly from the visual evidence in the image and legends.

4. MULTI-PERIOD SESSIONS & MERGED CELLS (SPANS):
   - For lab, practical, workshop, drawing, or multi-period lecture sessions that span multiple periods:
     * Emit EXACTLY ONE entry for the entire span.
     * Set "period" to the start period of the merged cell.
     * Set "span_to" to the ending period of the merged cell.
     * CRITICAL CONSTRAINT: DO NOT emit separate or duplicate entries for subsequent periods covered by the span.
   - For single-period cells, "span_to" MUST be null.

5. SCHEDULED ACTIVITIES vs. FREE / RECESS / BREAK SLOTS:
   - ACTIVITIES (e.g., TPC, Library, Sports, Games, Mentoring, Placement, Seminar, Counselling, Assembly):
     * Set "session_type": "activity"
     * Set "is_free": false
     * Set "subject_name": to the visible activity name. "subject_name" MUST NOT be null for a scheduled activity.
     * Set "faculty_name": instructor name if printed; otherwise null.
   - FREE / BREAK / RECESS / LUNCH SLOTS:
     * Set "is_free": true
     * Set "subject_name": null
     * Set "faculty_name": null
     * Set "session_type": "theory" (or "activity" if break)

6. ZERO-HALLUCINATION CONSTRAINT:
   - NEVER invent faculty names, faculty codes, subjects, subject codes, rooms, or period timings not supported by the image or legends.
   - If information is not visible or cannot be resolved, preserve null / unresolved according to the B2.1 contract.

7. OUTPUT FORMAT:
   - OUTPUT ONLY VALID JSON adhering to the Phase B2.1 JSON schema.
   - DO NOT wrap the output in Markdown code blocks (do NOT use \`\`\`json or \`\`\`).
   - DO NOT include introductory, explanatory, or concluding text. Output JSON only.

Examine the attached original image and Stage 1 JSON draft, perform complete verification and legend resolution, and output the corrected B2.1 JSON:`;
}

module.exports = {
    buildExtractionPrompt,
    buildVerificationPrompt,
    B2_1_SAMPLE_SCHEMA
};
