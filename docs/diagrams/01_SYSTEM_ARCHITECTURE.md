# 01 — System Architecture Diagram

This document presents the high-level system architecture of the **TecSubstitution** platform, illustrating the interaction between end users, client presentation, application server, business logic services, database persistence, and the decoupled AI extraction automation pipeline.

---

## 1. Architectural Overview Diagram

```mermaid
graph TD
    %% User Personas
    subgraph Clients ["Client Layer (Web Browsers)"]
        HOS["Head of Section (HOS)<br/>(Department Admin)"]
        FAC["Faculty Member<br/>(Teaching Staff)"]
    end

    %% Presentation Layer
    subgraph Frontend ["Frontend Web Interface (public/)"]
        HTML["HTML5 Views<br/>(home.html, login.html, index.html)"]
        CSS["Vanilla CSS Design System<br/>(theme.css, responsive layout)"]
        JS["Client JavaScript Controllers<br/>(app.js, register.js, fetch REST client)"]
        HTML --- CSS
        HTML --- JS
    end

    Clients -->|HTTPS Requests / Signed Cookies| Frontend

    %% Application Server Layer
    subgraph AppServer ["Application Server (Node.js + Express.js)"]
        MW["Security & Session Middleware<br/>- Signed Cookie Parser (HMAC-SHA256)<br/>- Role Guards (requireAuth, requireHOS, requireFaculty)<br/>- Department Branch Isolation Guard"]
        
        ROUTERS["REST API Routers<br/>/api/auth &nbsp;|&nbsp; /api/timetable &nbsp;|&nbsp; /api/availability<br/>/api/attendance &nbsp;|&nbsp; /api/invigilation &nbsp;|&nbsp; /api/substitutions<br/>/api/uploads &nbsp;|&nbsp; /api/staging"]
        
        MW --> ROUTERS
    end

    Frontend -->|REST API Calls (JSON)| MW

    %% Core Business Logic Layer
    subgraph LogicLayer ["Core Business Logic & Availability Engine"]
        VAL["Validation & Conflict Prevention<br/>- Class Slot Collision Check<br/>- Faculty Double-Booking Check<br/>- Room Double-Booking Check"]
        
        AVAIL["Faculty Availability Engine<br/>- Filters Active/Inactive<br/>- Cross-checks Daily Attendance (Absent)<br/>- Cross-checks Master Timetable (Teaching)<br/>- Cross-checks Active Exam Invigilations<br/>- Prioritizes Same-Branch Candidates"]
        
        STG_MGR["Staging & Approval Gatekeeper<br/>- Contract Schema Validation (Phase B2.1)<br/>- Unresolved Entity Detection<br/>- Interactive Entity Mapping<br/>- Transactional Live Importer"]
        
        ROUTERS --> VAL
        ROUTERS --> AVAIL
        ROUTERS --> STG_MGR
    end

    %% Persistence Layer
    subgraph Database ["Persistence Layer (PostgreSQL / Neon Serverless)"]
        DB_POOL["pg Connection Pool (SSL Enabled)"]
        
        subgraph Tables ["Relational Tables & Constraints"]
            T_CONF["departments, rooms, subjects, classes, periods"]
            T_USERS["users, faculty, faculty_subjects"]
            T_LIVE["timetable (Live Master Schedule)"]
            T_OPS["faculty_attendance, exam_invigilation, faculty_substitutions"]
            T_STG["timetable_uploads, timetable_staging"]
        end
        
        DB_POOL --> Tables
    end

    VAL -->|Parameterized SQL| DB_POOL
    AVAIL -->|Read-Only SQL Queries| DB_POOL
    STG_MGR -->|Transactional Import SQL| DB_POOL

    %% AI Extraction Automation Pipeline (Decoupled)
    subgraph AIPipeline ["AI Timetable Extraction Subsystem (Asynchronous / Decoupled)"]
        UPLOAD_DIR["Local Secure Storage<br/>(uploads/timetables/)"]
        WEBHOOK["Webhook Dispatcher<br/>(HTTP POST Event)"]
        N8N["n8n Automation Engine<br/>(Workflow Runner)"]
        GEMINI["Google Gemini AI<br/>(gemini-2.5-flash Vision OCR)"]
        
        UPLOAD_DIR -.-> WEBHOOK
        WEBHOOK -->|Webhook Notification| N8N
        N8N -->|Fetch Image/PDF via X-Internal-Secret| ROUTERS
        N8N -->|Document Binary + Strict Extraction Prompt| GEMINI
        GEMINI -->|Structured JSON (Phase B2.1 Contract)| N8N
        N8N -->|POST /api/internal/uploads/:id/processed| ROUTERS
    end

    ROUTERS -->|Write Uploaded File| UPLOAD_DIR
    ROUTERS -.->|Stage Extracted JSON| T_STG

    %% Critical Security Boundary Callout
    classDef safety fill:#fff3cd,stroke:#ffeeba,stroke-width:2px,color:#856404;
    classDef isolated fill:#d4edda,stroke:#c3e6cb,stroke-width:2px,color:#155724;
    classDef db fill:#d1ecf1,stroke:#bee5eb,stroke-width:2px,color:#0c5460;
```

---

## 2. Key Architectural Principles

1. **Multi-Tenant Departmental Isolation**:
   - Each Head of Section (HOS) operates within their designated branch (e.g., Computer Engineering `CME`, Electrical Engineering `EEE`).
   - The session token binds requests to `req.session.department`. All database updates are strictly scoped to the authenticated branch. Cross-branch write attempts are intercepted and rejected with `HTTP 403 Forbidden`.

2. **Decoupled AI Processing with Zero Direct Database Access**:
   - Google Gemini and n8n have **no direct connection, credentials, or write privileges** to the PostgreSQL database.
   - All AI-extracted timetable data is delivered via internal authenticated APIs (`X-Internal-Secret`) into an intermediate staging table (`timetable_staging`).
   - Staged data requires explicit human HOS inspection, entity resolution, and approval before transactional commitment to the live timetable.

3. **Stateless Cryptographic Sessions**:
   - Authentication relies on signed cookies (`tec_session`) hashed via HMAC-SHA256 using a server-side secret.
   - Constant-time string comparison (`crypto.timingSafeEqual`) prevents timing attack vulnerabilities.

4. **Guaranteed Double-Booking Prevention**:
   - Double-booking prevention is enforced at two distinct tiers:
     - **Application Tier**: In-memory conflict validation before executing database write commands.
     - **Database Tier**: Relational partial unique constraints (`timetable_faculty_slot_unique`, `timetable_room_slot_unique`, `exam_invigilation_unique`) that reject conflicting records at the SQL execution level.
