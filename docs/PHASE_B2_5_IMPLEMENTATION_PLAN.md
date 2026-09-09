# Phase B2.5 Implementation Plan: HOS Staged Timetable Review & Approval

## Executive Summary
In Phase B2.4 and B2.4.1, the Google Gemini multimodal vision extraction pipeline was integrated, validated, and hardened against real-world timetables (`sample_timetable.jpeg`), generating strict B2.1 JSON contracts with 100% validation success and zero direct writes to the live timetable.

**Phase B2.5 establishes the authoritative governance boundary:**
Allows an authenticated Head of Section (HOS) to inspect, review, and explicitly **Approve** or **Reject** a `VALID` staged timetable before it is transactionally imported into the live academic timetable.

```
[ Upload (B1) ]
       │
       ▼
[ Gemini Vision Extraction (B2.4) ]
       │
       ▼
[ B2.3 Contract Validation ] ──(Invalid)──► [ Mark FAILED & Stage Errors ]
       │ (Valid)
       ▼
[ timetable_staging (STAGED) ]
       │
       ▼
[ HOS Interactive Review UI ]
       │
       ├──► [ Reject ] ──► [ Mark REJECTED, Zero Live Mutation ]
       │
       └──► [ Approve ] ──► [ Conflict Check & Transactional Live Import ] ──► [ Live Timetable (Active) ]
```

---

## 1. Staged Timetable Review UI
A dedicated, high-clarity **Staged Timetable Review Panel** embedded within the HOS Master Timetable interface (`#view-timetable`):
- **Upload Selection / Auto-Trigger**:
  - Immediately after an HOS uploads an image or PDF via the upload form, the pipeline runs extraction & validation. Upon transition to `PROCESSED`, the review panel automatically opens.
  - An HOS can also review any pending staged timetable from a "Pending Approvals" roster in the Master Timetable view.
- **Header & Meta Card**:
  - Original file name, upload ID, document type (`MASTER_TIMETABLE`).
  - Target Class (`class_name`, e.g., `DEEE-B`), Semester (`4`), Academic Year (`2025-2026`), Department (`EEE`).
  - Validation Status Badge: `VALID` (emerald badge) or `INVALID` (rose badge).
  - Review Status Badge: `PENDING REVIEW` (amber), `APPROVED` (blue), `IMPORTED` (emerald), or `REJECTED` (slate).
  - Confidence Score and Extraction Timestamp.

---

## 2. Comprehensive Schedule Display
The review panel renders the full weekly timetable schedule:
- **Matrix Grid View**:
  - Columns: Periods 1 through 7 (with extracted clock timings, e.g. `08:00 - 08:45`).
  - Rows: Days (Monday through Saturday).
  - Cell Details:
    * **Subject**: Full subject name and subject code (e.g., `Electrical Machines- II` / `EE-402(5)`).
    * **Faculty**: Assigned faculty name (e.g., `M.DALAYYA`) or *Unassigned / Activity* (e.g. for `TPC`).
    * **Room**: Room code (e.g., `C-401`) or `—` if unassigned.
    * **Session Type**: Visual pill badge (`theory` in blue, `lab` in purple, `activity` in amber).
    * **Colspan / Multi-Period Merges (`span_to`)**: Cells spanning multiple periods (e.g. periods 1 to 3 for Labs or Drawing) visually span the respective columns with a distinct border and a `Spans P1–P3` badge, showing the raw verbatim cell text (`ED`, `EM-II LAB / PE LAB`).
- **Tabular / List Inspection View**:
  - Alternate expandable table listing all 30 extracted slots with filtering by Day, Period, and Subject Type.

---

## 3. Clear Indication of Warnings & Errors
- **Validation Errors (if INVALID)**:
  - If a staged timetable is `INVALID`, the UI renders a prominent callout with exact diagnostic errors:
    * Missing required fields.
    * Schema violations.
    * Internal scheduling conflicts (`CLASS_BUSY`, `FACULTY_BUSY`).
- **Warnings & Notices**:
  - Unassigned faculty warnings (e.g. "Notice: Period 7 on Tuesday is an activity slot with no assigned faculty").
  - Legend abbreviation resolutions (e.g. "Resolved abbreviation 'HPS LAB' to 'Hybrid Power Systems Laboratory'").
- **Impact Summary**:
  - Shows total entries to be imported (e.g. "30 slots across 6 days").
  - Identifies if existing live entries for this class will be superseded.

---

## 4. Approve Action (Guarded for VALID Staging Data Only)
- The **"Approve & Import to Live Timetable"** button is:
  - **ENABLED** only when:
    1. Caller is an authenticated HOS of the matching branch (`req.session.role === 'hos'`).
    2. Staging `validation_status === 'VALID'`.
    3. Staging `import_status === 'STAGED'`.
    4. All extracted entities are resolved against the catalog (no `UNRESOLVED` items pending).
  - **DISABLED with Explanatory Tooltip** if:
    * `validation_status === 'INVALID'`: "Cannot approve: Timetable contains validation errors."
    * Contains unresolved entities: "Cannot approve: Unresolved faculty/subjects must be mapped or confirmed by HOS first."
    * `import_status === 'IMPORTED'`: "Timetable already approved and imported into live schedule."
    * `import_status === 'REJECTED'`: "This upload has been rejected."

---

## 5. Reject Action
- The **"Reject Timetable"** button:
  - Allows the HOS to decline importing the staged timetable.
  - Prompts for an optional **Rejection Reason** (e.g., "Outdated revision", "Incorrect faculty assignment on Thursday").
  - Transitions staging `import_status` to `'REJECTED'` and updates upload status to `'REJECTED'`.
  - Guarantees **zero writes** to the live timetable.
  - Retains the staging record for historical audit.

---

## 6. Safe Import into the Real Timetable
## 6. Safe Import & Strict Catalog Resolution (No Silent Master Data Creation)
- **Zero Silent Auto-Creation Rule**:
  - **AI-extracted faculty, subject, room, and class references must NEVER silently create new master-data records.**
  - Master catalog records (faculty roster, subject list, class sections, rooms) represent the branch's authoritative academic registry. Silent insertion from LLM vision output risks polluting the database with OCR typos, name permutations, or hallucinations.
- **Branch-Scoped Entity Resolution**:
  - Prior to import, every extracted entity in the B2.1 contract is verified against existing branch-scoped catalog records:
    * **Class**: Matched against existing `classes` in the department (case-insensitive code match, e.g., `DEEE-B`).
    * **Subject**: Matched against registered `subjects` belonging to the department (by code or name).
    * **Faculty**: Matched against registered `faculty` in the department (by code or name). For non-faculty activity slots (`TPC`, `Library`, `Sports`), `faculty_name === null` is valid and requires no faculty linkage.
    * **Room**: Matched against registered `rooms` (or nullable if unassigned).
- **Handling of UNRESOLVED Entities**:
  - If an extracted entity cannot be confidently resolved against the branch catalog:
    1. The entity is flagged as `UNRESOLVED` in staging metadata (e.g. `unresolved_entities: [{ entity_type: 'faculty', extracted_text: 'G.BHARATH REDDY', slots_affected: ['Monday P1', 'Saturday P1'] }]`).
    2. The review status reflects `UNRESOLVED_REFERENCES`.
    3. **Approval is STRICTLY PREVENTED**: The "Approve & Import" action is disabled until all unresolved references are explicitly mapped or confirmed by the HOS.
- **HOS Resolution Workflow in UI**:
  - In the Staging Review UI, an **"Unresolved Entities / Mapping Required"** panel clearly lists every unmapped reference.
  - For each unmapped reference, the HOS can:
    * **Map to Existing Catalog Entity**: Select from a dropdown of existing branch faculty/subjects (e.g. mapping an extracted alias or typo to the official profile).
    * **Explicitly Register as New Entity**: Deliberately click to create a new master record via an explicit HOS confirmation modal (a conscious human administrative action, never an automatic AI write).
  - Once the HOS confirms all mappings/registrations, the staging record becomes fully resolved and the "Approve & Import" button is unlocked.
- **Database Targets**:
  - Live `timetable` table (`class_id`, `day_of_week`, `period`, `subject_id`, `faculty_id`, `room_id`, `session_type`).
  - Zero silent mutations to `faculty`, `subjects`, `classes`, or `rooms`.
- **In-Memory / Fallback Targets**:
  - Updates `state.source.entries` and performs an atomic state swap via `store.replace()`.
- **Engine Synchronization**:
  - Immediately reloads the database-backed store via `store.reloadFromDatabase()`.
  - Refreshes availability lookup cache and master timetable grids instantly.

---

## 7. Handling Multi-Period `span_to` Entries
- **The Core Invariant**:
  - An extracted cell with `period: 1, span_to: 3` represents a contiguous session covering periods 1, 2, and 3.
  - The live `timetable` table requires slot-by-slot lookup for faculty availability:
    `availabilityEngine.isFree(faculty, day, period)`
  - If only period 1 was inserted, periods 2 and 3 would erroneously register as *FREE*.
- **Expansion Logic**:
  - When importing an entry with `span_to`:
    * The importer iterates from `p = entry.period` to `p = entry.span_to`.
    * For each period `p`, an atomic live row is created in `timetable` sharing the identical `class_id`, `subject_id`, `faculty_id`, `room_id`, and `session_type`.
  - When reading back the timetable, `repository.loadSource()` re-collapses contiguous identical slots into a unified visual span (`spanTo`), maintaining 100% round-trip fidelity.

---

## 8. Conflict Detection Before Import
Before committing any rows to the live database, the importer executes pre-import conflict detection:
1. **Class Clashes**:
   - Checks if the class already has scheduled periods (addressed via Policy in Section 13).
2. **Faculty Clashes**:
   - Cross-references each assigned faculty member against all *other* classes in the branch.
   - If Faculty $F$ is assigned to teach Class $B$ at Monday P2, but the live timetable already shows Faculty $F$ teaching Class $A$ at Monday P2, an unresolvable `FACULTY_BUSY` conflict is flagged.
3. **Room Clashes**:
   - If Room $R$ is assigned to Class $B$ at Monday P2, but Room $R$ is already occupied by Class $A$ at Monday P2, a `ROOM_BUSY` conflict is flagged.
4. **Behavior on Conflict**:
   - If external clashes exist, the import transaction aborts and rolls back completely, returning HTTP 409 with a detailed clash report.

---

## 9. Branch Isolation
- Strict department scoping:
  - HOS of department `EEE` can ONLY review, approve, or reject staged timetables where `upload.department_code === 'EEE'`.
  - All referenced classes, faculty, and subjects created or linked during import are constrained to `department_id` of `EEE`.
  - Cross-branch access attempts are immediately rejected with HTTP 403 `FORBIDDEN`.

---

## 10. HOS Authorization
- Only users authenticated with `role === 'hos'` are permitted to trigger approval or rejection.
- Faculty users (`role === 'faculty'`) or anonymous guests receive HTTP 403 / 401.
- The approval request captures the authenticated HOS's `user_id` and username for immutable auditing.

---

## 11. Transaction & Rollback Guarantees
- PostgreSQL Implementation:
  - Entire import is executed within a database transaction using `db.withTransaction(async client => { ... })`.
  - Sequence of Operations inside Transaction:
    ```sql
    BEGIN;
    -- 1. Lock staging row to prevent race conditions
    SELECT * FROM timetable_staging WHERE upload_id = $1 FOR UPDATE;
    -- 2. Verify status is STAGED and VALID
    -- 3. Verify all entities are resolved against existing branch catalog (auto-creation forbidden)
    -- 4. Delete existing slots for this class (replace policy)
    -- 5. Detect faculty / room collisions with other classes
    -- 6. Bulk INSERT expanded timetable rows
    -- 7. UPDATE timetable_staging SET import_status = 'IMPORTED', reviewed_by = $2, imported_at = now();
    -- 8. UPDATE timetable_uploads SET status = 'PROCESSED';
    COMMIT;
    ```
  - If any error, clash, or constraint failure occurs, `ROLLBACK` executes automatically.
  - Zero partial imports are physically possible.

---

## 12. Idempotency (Repeat Approval Prevention)
- Database level:
  - Row lock (`FOR UPDATE`) serializes concurrent requests.
  - If `import_status` is already `'IMPORTED'`, the second call immediately exits and returns HTTP 409 `ALREADY_IMPORTED` with the existing import details.
- Frontend level:
  - The "Approve" button disables immediately upon click, displaying "Importing…".
  - After success, the button is replaced by an immutable badge: `✓ Imported on [Date] by [HOS]`.

---

## 13. Handling Existing Live Timetable Entries
- **Class-Level Replacement Policy (`REPLACE_CLASS`)**:
  - In an academic institution, uploading a semester master timetable for section `DEEE-B` is intended to establish the complete schedule for `DEEE-B`.
  - The import atomically deletes prior timetable rows for `DEEE-B` within the same transaction before inserting the newly approved rows.
  - **Surgical Scoping**: Entries for other sections (`DEEE-A`, `DEEE-C`) remain 100% untouched.
  - **Pre-Confirmation Modal**: The UI modal explicitly states:
    > *"Approving will update the schedule for class DEEE-B (replacing any prior entries for this section). Schedules for other classes will not be affected."*

---

## 14. Audit & Status Information
- Database columns added to `timetable_staging`:
  - `import_status TEXT NOT NULL DEFAULT 'STAGED' CHECK (import_status IN ('STAGED', 'APPROVED', 'REJECTED', 'IMPORTED'))`
  - `reviewed_by INTEGER REFERENCES users(id)`
  - `reviewed_at TIMESTAMPTZ`
  - `rejection_reason TEXT`
  - `imported_at TIMESTAMPTZ`
  - `imported_count INTEGER`
- API audit response returns full execution provenance.

---

## 15. Comprehensive Error Handling
| Error Scenario | HTTP Status | Error Code | Response Details |
|---|---|---|---|
| Unauthenticated caller | 401 | `UNAUTHENTICATED` | Session missing |
| Faculty / Guest caller | 403 | `FORBIDDEN` | Only HOS can approve |
| Cross-branch HOS | 403 | `FORBIDDEN` | Cannot approve outside assigned branch |
| Staging data is INVALID | 422 | `CANNOT_APPROVE_INVALID_DATA` | Validation errors list |
| Staging data already imported | 409 | `ALREADY_IMPORTED` | Details of prior import |
| External faculty clash | 409 | `SLOT_CONFLICT` | Conflicting faculty, day, period, other class |
| Upload ID not found | 404 | `NOT_FOUND` | Upload record missing |
| Transaction failure / DB error | 500 | `IMPORT_TRANSACTION_FAILED` | Rollback details |

---

## 16. Test Plan
A comprehensive automated test suite (`tests/staging_approval.test.js`) covering:
1. **Authorization & Role Guards**:
   - Anonymous POST `/api/staging/:uploadId/approve` $\rightarrow$ 401.
   - Faculty POST `/api/staging/:uploadId/approve` $\rightarrow$ 403.
   - CME HOS approving EEE upload $\rightarrow$ 403 `FORBIDDEN`.
   - EEE HOS approving EEE upload $\rightarrow$ 200 `OK`.
2. **Validation Gatekeeper**:
   - Approving an `INVALID` staged record $\rightarrow$ 422 `CANNOT_APPROVE_INVALID_DATA`.
   - Staging record is untouched.
3. **Multi-Period Expansion Verification**:
   - Extracted lab with `period: 1, span_to: 3` creates 3 distinct rows in live `timetable` (`P1`, `P2`, `P3`).
   - Querying availability during P2 verifies faculty is busy.
4. **Idempotency Enforcement**:
   - Calling approve twice on the same upload $\rightarrow$ 2nd call returns 409 `ALREADY_IMPORTED`.
   - Row count in live timetable does not double.
5. **Rejection Lifecycle**:
   - Calling reject with a reason $\rightarrow$ status becomes `REJECTED`.
   - Live timetable count remains unchanged.
6. **Class-Scoping Replacement**:
   - Pre-existing entries for class `DEEE-B` are superseded; entries for `DEEE-A` remain intact.
7. **End-to-End Live Round-Trip**:
   - Real extraction data from `sample_timetable.jpeg` approved $\rightarrow$ live timetable populated with 30 slots $\rightarrow$ master timetable grid displays all slots with spans.

---

## 17. Security & Architecture Boundaries
- **No Direct AI Writes**: Google Gemini and the extraction pipeline NEVER write to the live `timetable` table. They write exclusively to `timetable_staging`.
- **Human-in-the-Loop Requirement**: A timetable becomes live ONLY when an authenticated HOS clicks "Approve".
- **Zero Schema Degradation**: B2.1 JSON schema validation and B2.3 contract validation remain strict gatekeepers.
- **Data Protection**: Gemini API keys and database connection strings remain server-side secrets.
