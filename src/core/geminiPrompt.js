/**
 * Gemini Timetable Extraction Prompt — Phase B2.4
 *
 * Implements strict extraction prompt adhering to Phase B2.1 JSON contract
 * (docs/PHASE_B2_1_JSON_CONTRACT.md).
 *
 * Enforces zero-hallucination rules, exact schema compliance, and
 * authoritative context alignment.
 */

const B2_1_SAMPLE_SCHEMA = {
    contract_version: "2.1",
    timetable_type: "MASTER_TIMETABLE", // or "FACULTY_TIMETABLE"
    institution_name: "Aditya Institute of Technology and Management",
    title: "V SEM TIME TABLE",
    department_code: "EEE",
    academic_year: "2025-2026",
    semester: 4, // Integer 1-12, NOT Roman numeral string
    class_name: "DEEE-B",
    faculty_name: null,
    faculty_code: null,
    default_room: null,
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    periods: [1, 2, 3, 4, 5, 6, 7],
    period_timings: {
        "1": { "start": "08:00", "end": "08:45" },
        "2": { "start": "08:45", "end": "09:30" }
    },
    entries: [
        {
            day: "Monday",
            period: 1,
            span_to: null,
            subject_name: "Power Electronics & PLC",
            subject_code: "EE-404(4)",
            faculty_name: "D.SAGAR KUMAR",
            class_name: "DEEE-B",
            room_code: null,
            session_type: "theory",
            is_free: false,
            raw_cell_text: "PE"
        },
        {
            day: "Monday",
            period: 2,
            span_to: null,
            subject_name: null,
            subject_code: null,
            faculty_name: null,
            class_name: "DEEE-B",
            room_code: null,
            session_type: "theory",
            is_free: true,
            raw_cell_text: ""
        },
        {
            day: "Tuesday",
            period: 1,
            span_to: 2,
            subject_name: "Electrical Machines- II Laboratory",
            subject_code: "EE-407(3)",
            faculty_name: "M.DALAYYA",
            class_name: "DEEE-B",
            room_code: null,
            session_type: "lab",
            is_free: false,
            raw_cell_text: "EM-II LAB"
        },
        {
            day: "Tuesday",
            period: 7,
            span_to: null,
            subject_name: "TPC",
            subject_code: null,
            faculty_name: null,
            class_name: "DEEE-B",
            room_code: null,
            session_type: "activity",
            is_free: false,
            raw_cell_text: "TPC"
        }
    ],
    extraction_metadata: {
        confidence_score: 0.95,
        warnings: []
    }
};

/**
 * Builds the strict Gemini system and user prompt for extracting timetable data.
 *
 * @param {Object} uploadContext
 * @param {string} uploadContext.departmentCode - Authoritative branch code (e.g. "EEE")
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

AUTHORITATIVE UPLOAD CONTEXT (DO NOT OVERRIDE):
- Expected Timetable Type: "${uploadType}"
- Expected Department/Branch Code: "${dept}"
${faculty ? `- Authoritative Faculty Name: "${faculty}"\n` : ''}${className ? `- Expected Class/Section Name: "${className}" (belongs under branch "${dept}")\n` : ''}
CRITICAL RULES & GENERAL EXTRACTION INSTRUCTIONS:

1. OUTPUT FORMAT:
   - OUTPUT ONLY VALID JSON.
   - DO NOT wrap the output in Markdown code blocks (do NOT use \`\`\`json or \`\`\`).
   - DO NOT include introductory, explanatory, or concluding text. Output JSON only.

2. MULTI-PERIOD SESSIONS & MERGED CELLS (COLSPAN / ROWSPAN):
   - When a session, lab, practical, drawing, workshop, or lecture spans multiple consecutive periods (merged cell horizontally across columns):
     * Emit EXACTLY ONE entry for that cell.
     * Set "period" to the start period of the cell (e.g., 1, 5, or 6).
     * Set "span_to" to the ending period of the cell (e.g., 2, 7).
     * CRITICAL NEGATIVE CONSTRAINT: DO NOT emit separate or duplicate entries for any of the periods covered by the span (e.g., if a cell spans period 1 to 2, emit ONE entry with period=1 and span_to=2; DO NOT emit an entry for period 2).
   - For single-period cells, "span_to" MUST be null.
   - If a cell is merged vertically across days for the same period, emit one entry for each day.

3. SCHEDULED ACTIVITIES vs. FREE / RECESS SLOTS:
   - SCHEDULED ACTIVITIES (e.g., TPC, Library, Sports, Mentoring, Placement, Training, Seminar, Counselling, Assembly, Games):
     * If a cell contains a scheduled activity label, it is a scheduled period:
       - Set "session_type": "activity"
       - Set "is_free": false
       - Set "subject_name": to the visible activity name (e.g., "TPC", "Library", "Sports", "Mentoring", "Placement"). "subject_name" MUST NEVER be null for a scheduled slot.
       - Set "faculty_name": the instructor's name if printed; otherwise null.
   - BLANK, FREE, RECESS, OR BREAK SLOTS:
     * ONLY cells that are genuinely unscheduled, blank, or marked as break/recess/lunch (e.g., empty cell, "-", "--", "FREE", "NIL", "RECESS", "BREAK", "LUNCH"):
       - Set "is_free": true
       - Set "subject_name": null
       - Set "faculty_name": null
       - Set "session_type": "theory" (or "activity" if break)

4. ABBREVIATIONS & SUBJECT / FACULTY LEGENDS:
   - Timetable grids often use abbreviations or short codes inside cells (e.g., 'EM-II', 'PE', 'ED', 'EI & E', 'PS-I', 'GME', 'HPS LAB', 'CS LAB') and provide a subject/faculty mapping table or legend elsewhere on the page.
   - When a subject/faculty legend or staff list is present on the document:
     * Cross-reference abbreviations in the grid with the legend to resolve full "subject_name", "subject_code", and "faculty_name".
     * If a cell lists multiple lab options or combined batches (e.g., "EM-II LAB / PE LAB"), resolve the names and codes from the legend.
   - In "raw_cell_text", ALWAYS preserve the exact verbatim text as printed inside the timetable grid cell.

5. ZERO-HALLUCINATION NEGATIVE CONSTRAINTS:
   - DO NOT invent faculty names if not printed in the cell or legend.
   - DO NOT invent subjects or subject codes.
   - DO NOT invent classrooms or room numbers (set "room_code": null if unstated).
   - DO NOT invent period timings if clock times are not printed in column headers.
   - If any field is not clearly visible in the document or legend, you MUST set its value to null.

6. SEMESTER, ACADEMIC YEAR & PERIOD TIMINGS:
   - "semester": Must be an integer between 1 and 12. Convert Roman numerals to integers (e.g. "IV SEM" -> 4, "V SEM" -> 5, "VI" -> 6). If unstated, set to null.
   - "academic_year": Format "YYYY-YY" or "YYYY-YYYY" (e.g., "2025-2026"), or null if unstated.
   - "period_timings": If period column headers contain clock times (e.g., '8.00-8.45' or '10.30-11.15'), map period strings to objects with "start" and "end" in "HH:MM" format (e.g., { "1": { "start": "08:00", "end": "08:45" } }). If no times are printed, set to null.

7. SESSION TYPE:
   - "theory" for standard classroom lectures.
   - "lab" for laboratory, workshop, drawing, or practical sessions.
   - "activity" for sports, library, mentoring, TPC, placement, counselling, or non-curricular periods.

8. OWNERSHIP FIDELITY:
   - The document is registered under branch "${dept}". You must set "department_code": "${dept}".
   - Set "timetable_type": "${uploadType}".${className ? `\n   - Set "class_name": "${className}".` : ''}

EXACT REQUIRED JSON SCHEMA AND STRUCTURE:
${JSON.stringify(B2_1_SAMPLE_SCHEMA, null, 2)}

Now, examine the document carefully and output the extracted JSON:`;
}

module.exports = {
    buildExtractionPrompt,
    B2_1_SAMPLE_SCHEMA
};
