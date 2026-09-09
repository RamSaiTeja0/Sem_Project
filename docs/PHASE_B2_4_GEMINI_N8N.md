# Phase B2.4 — Gemini Vision + n8n Timetable Extraction Integration

**Document Version:** 1.0.0  
**Phase:** B2.4 (Gemini Vision + n8n Integration Foundation)  
**Target Repository:** TecSubstitution (`Sem_Project`)  
**Status:** Completed & Validated  

---

## 1. Executive Summary

Phase B2.4 implements the multimodal document extraction bridge connecting the existing Phase B1/B2.3 upload system to Google Gemini Vision and n8n.

The pipeline ingests uploaded timetable images (PNG, JPEG) and PDF documents, applies a strict extraction prompt adhering to the [Phase B2.1 JSON Contract](file:///e:/Project/SEM_project/Sem_Project/docs/PHASE_B2_1_JSON_CONTRACT.md), validates the extracted schedule against authoritative upload metadata and relational rules, and safely stages the result in `timetable_staging` before transitioning the upload status to `PROCESSED` (or `FAILED`).

In accordance with strict architectural rules:
- **Provider Exclusivity:** ONLY Google Gemini AI is used.
- **Zero Live Timetable Commits:** Extraction results are written solely to `timetable_staging`; the live `timetable` table is not altered.
- **Authoritative Upload Ownership:** Branch, faculty ownership, and upload type are governed exclusively by the backend upload record and cannot be overridden by LLM output.
- **Secret Safety:** The Gemini API key and internal service secrets are stored strictly in server-side configuration and are never exposed to browser responses, frontend code, or logs.

---

## 2. Architecture Overview

```
[ HOS / Faculty Browser ]
        │  1. Upload Document (Master or Faculty)
        ▼
[ TecSubstitution Core Upload API ]
        │  2. Store file securely (uploads/timetables/) + metadata ('UPLOADED')
        │  3. Asynchronous Webhook Dispatch (fire-and-forget)
        ▼
[ n8n Automation Engine / Pipeline Runner ]
        │  4. Authenticate via X-Internal-Secret
        │  5. GET /api/internal/uploads/:uploadId (fetch metadata)
        │  6. GET /api/internal/uploads/:uploadId/file (stream raw file)
        │  7. POST /api/internal/uploads/:uploadId/status ({ status: "PROCESSING" })
        │  8. Forward binary + B2.1 extraction prompt to Gemini Vision
        ▼
[ Google Gemini AI (gemini-2.5-flash) ]
        │  9. Vision OCR & structured reasoning
        │ 10. Output strict JSON matching B2.1 schema
        ▼
[ n8n Automation Engine / Pipeline Runner ]
        │ 11. Clean markdown fences (if any) & parse JSON
        │ 12. POST /api/internal/uploads/:uploadId/processed (or /fail on error)
        ▼
[ TecSubstitution Core Backend ]
        │ 13. Verify X-Internal-Secret & match uploadId
        │ 14. Enforce upload ownership (departmentCode, uploadType, facultyId)
        │ 15. Validate schema, days, periods, session types, slot conflicts
        │ 16. Stage in timetable_staging & mark PROCESSED (or FAILED)
        ▼
[ timetable_staging ] (Ready for future review / activation phase)
```

---

## 3. Gemini Configuration & Environment Variables

### 3.1 Required Configuration Variables

Configure the following environment variables in `.env` or the hosting environment:

| Variable | Description | Default / Example | Required |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Google Gemini API Key. Kept strictly on the server. | `AIzaSy...` (Secret) | Yes (for live extraction) |
| `GEMINI_MODEL` | Supported Gemini multimodal model for image/PDF analysis. | `gemini-2.5-flash` | No (defaults to `gemini-2.5-flash`) |
| `GEMINI_BASE_URL` | Base URL for Google Generative Language API. | `https://generativelanguage.googleapis.com` | No |
| `GEMINI_TIMEOUT_MS` | API request timeout in milliseconds. | `60000` (60s) | No |
| `INTERNAL_API_SECRET` | Service-to-service secret for internal endpoints. | e.g. `tecsub_secret_token` | Yes |
| `N8N_WEBHOOK_URL` | Optional webhook endpoint for asynchronous n8n notification. | `http://127.0.0.1:5678/webhook/timetable-uploaded` | No |

> [!CAUTION]
> Never hardcode `GEMINI_API_KEY` or `INTERNAL_API_SECRET` in source code. Do not commit `.env` to Git.

### 3.2 Obtaining a Gemini API Key
1. Navigate to Google AI Studio ([https://aistudio.google.com/](https://aistudio.google.com/)).
2. Create or select a Google Cloud project.
3. Click **Get API key** and create an API key.
4. Set the key in your local or production environment:
   ```bash
   export GEMINI_API_KEY="AIzaSy..."
   ```

---

## 4. Gemini Extraction Prompt

The extraction prompt is implemented in [src/core/geminiPrompt.js](file:///e:/Project/SEM_project/Sem_Project/src/core/geminiPrompt.js) and adheres strictly to the Phase B2.1 JSON schema:

### Prompt Rules Enforced:
1. **JSON Only:** Requires direct JSON without introductory or concluding remarks.
2. **No Markdown Fences:** Prohibits wrapping in ```` ```json ````.
3. **Zero Hallucination:** Explicit prohibition on inventing faculty names, subjects, course codes, rooms, period timings, or academic calendar years. Unprinted or ambiguous data must be `null`.
4. **Working Days & Periods:** Enforces days (`Monday`..`Saturday`) and periods `1`..`12`.
5. **Session Spans:** Multicolumn/multi-period lab blocks are designated with `span_to`.
6. **Free Slots:** Blank, free, break, or recess periods are designated with `"is_free": true` and `"subject_name": null`.
7. **Raw Text Audit:** Retains verbatim cell text in `raw_cell_text` for provenance.
8. **Ownership Integrity:** Strictly informs Gemini of the authoritative `department_code` and `upload_type` registered in the backend upload record.

---

## 5. n8n Workflow Setup

An importable, valid n8n workflow definition is provided in [n8n/timetable_extraction_workflow.json](file:///e:/Project/SEM_project/Sem_Project/n8n/timetable_extraction_workflow.json).

### Workflow Structure:
1. **Webhook Trigger (`POST /webhook/timetable-uploaded`):** Listens for incoming upload notifications from TecSubstitution.
2. **Validate Webhook Payload:** Confirms `uploadId` is present and well-formed.
3. **Get Upload Metadata (`GET /api/internal/uploads/:uploadId`):** Obtains branch, upload type, and file metadata via `X-Internal-Secret`.
4. **Mark Status PROCESSING (`POST /api/internal/uploads/:uploadId/status`):** Locks the upload against concurrent processing.
5. **Download Upload File (`GET /api/internal/uploads/:uploadId/file`):** Retrieves the raw file binary stream.
6. **Gemini Vision Extraction (`POST generativelanguage.googleapis.com`):** Passes the binary file and prompt to the configured Gemini model.
7. **Clean & Parse JSON:** Strips Markdown fences (if any) and parses the JSON.
8. **Post Processed Result (`POST /api/internal/uploads/:uploadId/processed`):** Delivers extracted schedule to the backend validation and staging engine.
9. **Notify Backend Failure (`POST /api/internal/uploads/:uploadId/fail`):** Captures timeouts or errors and records the failure reason.

---

## 6. Authoritative Validation & Staging Layer

When the backend receives extracted JSON at `/api/internal/uploads/:uploadId/processed` (or via `runExtractionPipeline`):
1. **Branch Security:** If upload metadata specifies `department_code = CME` but Gemini returns `department_code = EEE`, the upload is rejected (`HTTP 422`, code `BRANCH_MISMATCH`). The document is never assigned to another branch.
2. **Faculty Security:** For `FACULTY_TIMETABLE`, the upload record's `faculty_id` is authoritative. Any discrepancy triggers `FACULTY_MISMATCH`.
3. **Upload Type Security:** A `MASTER_TIMETABLE` cannot be processed as a `FACULTY_TIMETABLE` (and vice-versa).
4. **Slot Conflicts:** The engine checks for internal clashes (duplicate room, class, or faculty assignments within the same period).
5. **Staging Persistence:** Valid payloads are saved in `timetable_staging` with `validation_status = 'VALID'`. The live `timetable` table is **not modified**.

---

## 7. Error Handling & State Transitions

The state machine strictly enforces valid transitions:
```
[ UPLOADED ] ──────► [ PROCESSING ] ──────► [ PROCESSED ] (Terminal)
                           │
                           ▼
                       [ FAILED ] ◄─────► [ PROCESSING ] (Retry allowed)
```

| Failure Mode | Status Transition | Staged Code | Description |
| :--- | :--- | :--- | :--- |
| Missing `GEMINI_API_KEY` | `FAILED` | `GEMINI_KEY_MISSING` | Extraction cannot proceed without API key. |
| Invalid API Key | `FAILED` | `GEMINI_KEY_INVALID` | 401/403 returned by Gemini API. |
| Gemini Rate Limit | `FAILED` | `GEMINI_RATE_LIMIT` | 429 returned by Gemini API. |
| Gemini Timeout | `FAILED` | `GEMINI_TIMEOUT` | Gemini request timed out (>60s). |
| Malformed Output | `FAILED` | `INVALID_JSON` | Gemini returned unparseable text. |
| Schema / Contract Error | `FAILED` | `VALIDATION_FAILED` | Missing required fields, invalid periods. |
| Branch Mismatch | `FAILED` | `BRANCH_MISMATCH` | Document department conflicts with upload context. |
| Faculty Mismatch | `FAILED` | `FACULTY_MISMATCH` | Document teacher conflicts with upload context. |
| Already Processed | Rejection (409) | `ALREADY_PROCESSED` | Successfully processed upload cannot be re-processed. |

---

## 8. Verification & Testing

### 8.1 Automated Test Suite
Run the test suite:
```bash
node tests/gemini_n8n.test.js
```
Automated tests use mocked Gemini transports to verify all 12 key scenarios offline without consuming external API quota or requiring a live key.

### 8.2 Master Test Runner
Run all repository suites:
```bash
npm test
```
Verifies zero regression across all 19 test suites.

### 8.3 Live Verification Script
Run the end-to-end live verification:
```bash
node scripts/verify_phase_b2_4_live.js
```
Exercises authentication, B1 upload, pipeline execution, staging validation, failure handling, idempotency, and confirms that live timetable entries remain untouched.
