# 07 — AI-Assisted Timetable Ingestion & Approval Workflow

This document diagrams the complete lifecycle of AI-assisted timetable extraction, schema validation, entity resolution, and human-in-the-loop HOS approval.

---

## 1. AI Timetable Ingestion Workflow Diagram (Mermaid)

```mermaid
flowchart TD
    %% Start: Upload
    START([Start: Timetable Document Upload]) --> HOS_UPLOAD[HOS Uploads Timetable Image or PDF<br/>POST /api/uploads]
    
    %% Storage & Webhook
    HOS_UPLOAD --> SAVE_FILE[Store File in uploads/timetables/<br/>Create Record in `timetable_uploads`<br/>Status: UPLOADED]
    SAVE_FILE --> DISPATCH_WH[Dispatch Asynchronous Webhook to n8n]
    
    %% n8n Orchestration
    DISPATCH_WH --> N8N_START[n8n Workflow Activated]
    N8N_START --> N8N_FETCH[n8n fetches File Binary & Metadata<br/>GET /api/internal/uploads/:id/file<br/>Auth: X-Internal-Secret]
    N8N_FETCH --> N8N_MARK_PROC[Update Upload Status to PROCESSING]
    
    %% Gemini Multimodal Processing
    N8N_MARK_PROC --> GEMINI_CALL[Forward Image/PDF Binary to Google Gemini<br/>Model: gemini-2.5-flash]
    
    subgraph GeminiOCR ["Google Gemini Multimodal Reasoning"]
        G1[Extract Class Name, Semester, Branch]
        G2[Extract Time Slots & Clock Timings]
        G3[Detect Days: Monday to Saturday]
        G4[Detect Multi-Period Blocks: Labs, Drawing]
        G5[Format Output as Strict Phase B2.1 JSON]
        G1 --> G2 --> G3 --> G4 --> G5
    end
    
    GEMINI_CALL --> GeminiOCR
    GeminiOCR --> GEMINI_RESP[Gemini returns Raw JSON Text]
    
    %% Delivery back to Server
    GEMINI_RESP --> N8N_CLEAN[n8n cleans Markdown fences & verifies JSON]
    N8N_CLEAN --> POST_INTERNAL[Deliver Extracted JSON to Core Backend<br/>POST /api/internal/uploads/:id/processed]
    
    %% Core Contract Validation Gate
    POST_INTERNAL --> CONTRACT_VAL{Phase B2.3 Contract Validation}
    
    %% Invalid Contract Path
    CONTRACT_VAL -->|Validation Discrepancies| STAGE_INVALID[Store in `timetable_staging`<br/>validation_status: INVALID<br/>Log Schema Errors]
    STAGE_INVALID --> MARK_FAILED[Update Upload Status to FAILED]
    MARK_FAILED --> HOS_NOTIFY_ERR[HOS Notified of Document Parsing Failure]
    HOS_NOTIFY_ERR --> REUPLOAD([End: Re-upload Clearer Image])
    
    %% Valid Contract Path
    CONTRACT_VAL -->|Schema Valid| STAGE_VALID[Store in `timetable_staging`<br/>validation_status: VALID<br/>import_status: STAGED]
    STAGE_VALID --> MARK_PROC[Update Upload Status to PROCESSED]
    
    %% Entity Resolution Gate
    MARK_PROC --> EVAL_ENTITIES[Evaluate Extracted References against Branch Catalog<br/>core/entityResolver.js]
    EVAL_ENTITIES --> CHECK_UNRESOLVED{Are there Unresolved Entities?}
    
    %% Interactive HOS Mapping Path
    CHECK_UNRESOLVED -->|Yes: Unmatched Faculty / Subjects| HOS_MAP_UI[HOS Review Panel Displays Unresolved Entities<br/>e.g., 'M.DALAYYA' not in catalog]
    HOS_MAP_UI --> HOS_MAP_ACTION[HOS maps entity to existing catalog item<br/>POST /api/staging/:id/map-entity]
    HOS_MAP_ACTION --> EVAL_ENTITIES
    
    %% HOS Decision Gate
    CHECK_UNRESOLVED -->|No: All Entities Resolved| HOS_DECISION_UI[HOS Reviews Full Matrix Grid Preview]
    HOS_DECISION_UI --> HOS_CHOICE{HOS Final Decision}
    
    %% Reject Path
    HOS_CHOICE -->|Reject Timetable| REJECT_STAGING[HOS enters Rejection Reason<br/>POST /api/staging/:id/reject]
    REJECT_STAGING --> DB_REJECTED[(Update `timetable_staging`<br/>import_status: REJECTED)]
    DB_REJECTED --> ZERO_MUTATION[Zero Mutation to Live Academic Timetable]
    ZERO_MUTATION --> END_REJECT([End: Staged Upload Rejected])
    
    %% Approve Path
    HOS_CHOICE -->|Approve Timetable| APPROVE_STAGING[HOS clicks Approve<br/>POST /api/staging/:id/approve]
    
    subgraph TransactionalImport ["Transactional Live Importer (repository.importStagedTimetable)"]
        T1[BEGIN Database Transaction]
        T2[Expand Multi-Period Spans into Atomic Slots]
        T3[Clear Existing Classes for Section / Academic Year]
        T4[Check Cross-Class Faculty & Room Conflicts]
        T5[Insert Atomic Rows into `timetable`]
        T6[COMMIT Transaction]
        T1 --> T2 --> T3 --> T4 --> T5 --> T6
    end
    
    APPROVE_STAGING --> TransactionalImport
    TransactionalImport --> DB_IMPORTED[(Update `timetable_staging`<br/>import_status: IMPORTED<br/>Set imported_at & imported_count)]
    DB_IMPORTED --> LIVE_ACTIVE[Extracted Timetable is now LIVE and Active]
    LIVE_ACTIVE --> END_SUCCESS([End: Timetable Activated Successfully])

    %% Styling
    classDef success fill:#d4edda,stroke:#c3e6cb,stroke-width:2px,color:#155724;
    classDef danger fill:#f8d7da,stroke:#f5c6cb,stroke-width:2px,color:#721c24;
    classDef action fill:#cce5ff,stroke:#b8daff,stroke-width:2px,color:#004085;
    classDef decision fill:#fff3cd,stroke:#ffeeba,stroke-width:2px,color:#856404;

    class LIVE_ACTIVE,END_SUCCESS,DB_IMPORTED success;
    class MARK_FAILED,STAGE_INVALID,REJECT_STAGING danger;
    class SAVE_FILE,GEMINI_CALL,POST_INTERNAL,HOS_MAP_ACTION action;
    class CONTRACT_VAL,CHECK_UNRESOLVED,HOS_CHOICE decision;
```

---

## 2. Key Safeguards of the AI Extraction Pipeline

1. **Strict Contract Validation (Phase B2.1 / B2.3)**:
   - The JSON returned by Google Gemini must pass rigid structural validation before being staged. Days must conform to institutional operational days, period numbers must be bounded (1 to 7), and session types must be classified (`theory`, `lab`, or `activity`).

2. **Decoupled Staging (`timetable_staging`)**:
   - The AI output is completely isolated in the staging database table. It has zero effect on regular faculty availability, class attendance, or student timetables while in the `STAGED` state.

3. **Zero Silent Creation Policy**:
   - Extracted faculty or subject names that do not match existing institutional records cannot be imported silently.
   - The HOS must explicitly map unrecognized strings (e.g. mapping an abbreviated teacher name to an existing faculty account) or register them beforehand.

4. **Atomic Transactional Commitment**:
   - When the HOS clicks **Approve**, the backend executes an atomic PostgreSQL transaction. If any cross-class teacher conflict or database error occurs during span expansion, the entire transaction rolls back cleanly, ensuring that partial or corrupt schedules can never exist in the live database.
