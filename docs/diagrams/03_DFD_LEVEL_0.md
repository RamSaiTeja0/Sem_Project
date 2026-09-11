# 03 — Data Flow Diagram (DFD Level 0: Context Diagram)

This document presents the **DFD Level 0 (Context Diagram)** for the **TecSubstitution** system. The context diagram outlines the system boundaries, the external entities (actors and external automation pipelines), and the primary data flows entering and leaving the system.

---

## 1. Context Diagram (Mermaid)

```mermaid
flowchart TD
    %% External Entities
    HOS["Head of Section (HOS)<br/>(Department Administrator)"]
    FAC["Faculty Member<br/>(Teaching Staff)"]
    AI["n8n & Google Gemini Vision<br/>(External AI Automation Pipeline)"]

    %% Central System Boundary
    SYS(("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.0&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<br/>TecSubstitution<br/>System"))

    %% Data Flows: HOS <-> System
    HOS -->|"1. Credentials & Branch Setup<br/>2. Faculty Roster & Accounts<br/>3. Master Timetable Entries<br/>4. Daily Absence / Attendance Logs<br/>5. Direct Exam Invigilation Assignments<br/>6. Timetable Images/PDFs<br/>7. Entity Mappings & Staging Approvals"| SYS
    
    SYS -->|"8. Auth Session & Profile<br/>9. Master Timetable Grids<br/>10. Branch Faculty & Accounts Directory<br/>11. Branch Attendance Roster<br/>12. Active Exam Invigilations<br/>13. Staged Extracted Timetables<br/>14. Read-Only Substitution Audit Logs"| HOS

    %% Data Flows: Faculty <-> System
    FAC -->|"15. Credentials & Profile Updates<br/>16. Availability Search Criteria<br/>17. Peer Substitution Requests<br/>18. Substitution Decisions (Accept / Reject)<br/>19. Exam Invigilation Requests"| SYS
    
    SYS -->|"20. Auth Session & Profile<br/>21. Personal Weekly Teaching Timetable<br/>22. Vacant Teaching Periods<br/>23. Filtered Free Substitute Candidates<br/>24. Incoming Peer Substitution Requests<br/>25. Read-Only Attendance History<br/>26. Assigned Exam Invigilations"| FAC

    %% Data Flows: AI Automation Pipeline <-> System
    SYS -->|"27. Webhook Event Notification<br/>28. Timetable Binary (Image / PDF)<br/>29. Extraction Schema & Prompt (B2.1)"| AI
    
    AI -->|"30. Structured JSON Contract<br/>31. Extraction Processing Status / Errors"| SYS
```

---

## 2. Explanation of External Entity Interactions

### 1. Head of Section (HOS)
- **Inputs to System**:
  - Department configuration (branch code, academic year, semester counts).
  - Faculty account details (name, designation, email, initial password).
  - Class timetable slots (class, day, period, subject, assigned teacher, classroom).
  - Daily faculty absence markers (Present/Absent, leave reasons).
  - Direct examination invigilation schedules.
  - Timetable document uploads (JPEG, PNG, PDF).
  - Manual entity mappings and final staged timetable approval/rejection decisions.
- **Outputs from System**:
  - Visual master class timetable grids with conflict highlights.
  - Departmental faculty directory and account rosters.
  - Real-time daily attendance rosters.
  - Active exam invigilation coverage lists.
  - Extracted timetable preview matrices with resolution statuses.
  - Read-only historical logs of peer substitutions.

### 2. Faculty Member
- **Inputs to System**:
  - Sign-in credentials and permitted profile updates (phone number, subject competencies).
  - Target day, period, and calendar date for substitute availability searches.
  - Peer substitution requests dispatched to selected free colleagues.
  - Explicit acceptance or rejection of incoming substitution invitations.
  - Submission of voluntary exam invigilation requests.
- **Outputs from System**:
  - Personalized weekly timetable grid.
  - List of vacant instructional periods.
  - Ranked list of free peer instructors (local department prioritized).
  - Real-time notification cards of incoming substitution requests.
  - Personal historical attendance ledger.
  - Personal exam invigilation duty assignments.

### 3. n8n & Google Gemini Vision Automation Pipeline
- **Inputs from System**:
  - Asynchronous webhook dispatch carrying the newly generated `uploadId`.
  - Secure internal endpoint streaming the uploaded document binary along with the strict Phase B2.1 JSON contract prompt.
- **Outputs to System**:
  - Multimodal OCR output formatted strictly as a structured JSON object.
  - Pipeline status callbacks (`PROCESSING`, `PROCESSED`, or `FAILED`) authenticated via `X-Internal-Secret`.
