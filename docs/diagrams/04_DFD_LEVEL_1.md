# 04 — Data Flow Diagram (DFD Level 1)

This document breaks down the TecSubstitution system into its core functional sub-processes, depicting how data flows between actors, internal processes, and relational data stores.

---

## 1. DFD Level 1 Diagram (Mermaid)

```mermaid
flowchart TD
    %% External Entities
    HOS["Head of Section (HOS)"]
    FAC["Faculty Member"]
    AI["n8n / Gemini Vision Pipeline"]

    %% Data Stores
    subgraph Stores ["Data Stores (PostgreSQL / Neon)"]
        D1[("D1: users & departments")]
        D2[("D2: faculty & subjects")]
        D3[("D3: classes, rooms & periods")]
        D4[("D4: timetable (Live Schedule)")]
        D5[("D5: timetable_uploads & staging")]
        D6[("D6: faculty_attendance")]
        D7[("D7: exam_invigilation & requests")]
        D8[("D8: faculty_substitutions")]
    end

    %% Sub-Processes
    P1(("1.0<br/>Authentication &<br/>Account Mgmt"))
    P2(("2.0<br/>Master Timetable<br/>& Catalog Mgmt"))
    P3(("3.0<br/>AI Extraction,<br/>Staging & Approval"))
    P4(("4.0<br/>Daily Attendance<br/>Logging"))
    P5(("5.0<br/>Availability<br/>Calculation Engine"))
    P6(("6.0<br/>Exam Invigilation<br/>Management"))
    P7(("7.0<br/>Peer Substitution<br/>Workflow"))

    %% Process 1.0 Flows
    HOS -->|Credentials / Register Faculty| P1
    FAC -->|Login Credentials| P1
    P1 <-->|Read / Write Accounts| D1
    P1 <-->|Sync Faculty Profiles| D2
    P1 -->|Session Cookie| HOS
    P1 -->|Session Cookie| FAC

    %% Process 2.0 Flows
    HOS -->|Class / Room / Subject Config| P2
    HOS -->|Add / Edit / Delete Timetable Slot| P2
    P2 <-->|Read Catalog Records| D3
    P2 <-->|Read / Write Live Schedule| D4
    P2 -->|Master Timetable Grid| HOS
    P2 -->|Personal Teaching Schedule| FAC

    %% Process 3.0 Flows
    HOS -->|Upload Timetable Image/PDF| P3
    P3 -->|Store File & Dispatch Webhook| D5
    P3 <-->|Fetch Binary / Submit JSON| AI
    HOS -->|Entity Mappings & Approval| P3
    P3 <-->|Read / Update Staging Record| D5
    P3 -->|Transactional Import (Live Commit)| D4

    %% Process 4.0 Flows
    HOS -->|Mark Faculty ABSENT / PRESENT| P4
    P4 -->|Write Daily Absence Record| D6
    P4 -->|Read Personal Attendance History| FAC

    %% Process 5.0 Flows (Availability Engine)
    FAC -->|Query Free Faculty (Date & Period)| P5
    HOS -->|Query Slot Availability| P5
    P5 -.->|Read Faculty Roster| D2
    P5 -.->|Read Scheduled Classes| D4
    P5 -.->|Read Absence Markers| D6
    P5 -.->|Read Exam Duties| D7
    P5 -.->|Read Active Substitutions| D8
    P5 -->|Categorized Candidate List| FAC
    P5 -->|Availability Summary| HOS

    %% Process 6.0 Flows
    HOS -->|Direct Invigilation Assignment| P6
    FAC -->|Submit Invigilation Request| P6
    HOS -->|Approve / Reject Request| P6
    P6 <-->|Read / Write Invigilations| D7
    P6 -->|Assigned Duties Display| FAC

    %% Process 7.0 Flows
    FAC -->|Initiate Substitution Request| P7
    P7 -->|Store Pending Request| D8
    D8 -->|Incoming Request Alert| FAC
    FAC -->|Accept / Reject Request| P7
    P7 -->|Trigger Availability Revalidation| P5
    P7 -->|Update Substitution Status| D8
    P7 -.->|Read-Only Audit Log| HOS
```

---

## 2. Process Descriptions and Data Stores

| Process | Process Name | Primary Function | Primary Inputs / Outputs |
| :--- | :--- | :--- | :--- |
| **1.0** | Authentication & Account Mgmt | Verifies login credentials, issues signed `tec_session` cookies, and manages faculty user accounts. | In: Login forms, user registration.<br/>Out: Signed session cookies, user profiles. |
| **2.0** | Master Timetable & Catalog Mgmt | Coordinates class sections, rooms, subject catalogs, and weekly period slots (1–7). | In: Class slot definitions, edit/delete actions.<br/>Out: Conflict-free weekly class grids. |
| **3.0** | AI Extraction, Staging & Approval | Ingests timetable images/PDFs, coordinates with Gemini Vision via n8n, stages JSON, and executes transactional HOS approval. | In: PDF/Image files, B2.1 JSON, HOS approvals.<br/>Out: Validated staging rows, live timetable commits. |
| **4.0** | Daily Attendance Logging | Allows the HOS to mark faculty members absent on specific calendar dates with leave remarks. | In: Date, faculty ID, status (ABSENT/PRESENT).<br/>Out: Date-indexed attendance records. |
| **5.0** | Availability Calculation Engine | Multi-dimensional read-only evaluator determining free faculty for any day/period by screening out teaching, absence, and exam duties. | In: Date, day, period, absent faculty.<br/>Out: Filtered lists of available candidates. |
| **6.0** | Exam Invigilation Management | Administers examination hall supervision duties through direct HOS assignment or faculty requests. | In: Exam date, periods, faculty assignment.<br/>Out: Active invigilation records. |
| **7.0** | Peer Substitution Workflow | Governs the faculty-to-faculty substitution lifecycle (creation, colleague review, acceptance with revalidation). | In: Target slot, selected colleague, decision.<br/>Out: Persistent substitution records. |

### Data Stores
- **D1 (`users & departments`)**: Stores user credentials, password hashes, roles, and branch configuration.
- **D2 (`faculty & subjects`)**: Stores faculty member profiles, contact info, and subject catalog definitions.
- **D3 (`classes, rooms & periods`)**: Stores class sections, physical rooms, and period start/end timings.
- **D4 (`timetable`)**: Stores live, active class schedule records.
- **D5 (`timetable_uploads & staging`)**: Tracks uploaded file metadata and intermediate AI extraction JSON payloads.
- **D6 (`faculty_attendance`)**: Stores daily attendance and absence statuses indexed by faculty and date.
- **D7 (`exam_invigilation & requests`)**: Tracks active invigilations and pending faculty requests.
- **D8 (`faculty_substitutions`)**: Stores peer-to-peer substitution request states (`PENDING`, `ACCEPTED`, `REJECTED`, `CANCELLED`).
