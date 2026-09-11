# 06 — Faculty-to-Faculty Substitution Workflow Diagram

This document illustrates the complete activity and decision workflow for peer-to-peer faculty substitutions (**Option A**), detailing how an absent instructor identifies vacant periods, queries available colleagues, and completes a substitution with real-time conflict revalidation.

---

## 1. Substitution Workflow Activity Diagram (Mermaid)

```mermaid
flowchart TD
    %% Start
    START([Start: Faculty Absence or Planned Leave]) --> IDENTIFY[Faculty A views Personal Teaching Timetable]
    
    %% Identify Vacant Slot
    IDENTIFY --> FIND_SLOT[Select Target Scheduled Class Slot<br/>e.g., Friday Period 3, Class CME-A]
    
    %% Query Availability Engine
    FIND_SLOT --> QUERY_AVAIL[Trigger Availability Engine<br/>POST /api/availability]
    
    subgraph EngineEval ["Availability Engine Evaluation (Read-Only)"]
        E1[Filter out Faculty marked ABSENT on Date]
        E2[Filter out Faculty Teaching in Master Timetable on Slot]
        E3[Filter out Faculty with Active Exam Invigilation in Period]
        E4[Filter out Faculty with Accepted Substitutions in Period]
        E5[Group Available Candidates into<br/>Priority Branch & Other Branches]
        E1 --> E2 --> E3 --> E4 --> E5
    end
    
    QUERY_AVAIL --> EngineEval
    EngineEval --> DISPLAY_CANDIDATES[Display FREE Faculty Candidates List]
    
    %% Candidate Selection & Request Dispatch
    DISPLAY_CANDIDATES --> SELECT_COLLEAGUE[Faculty A selects available Faculty B]
    SELECT_COLLEAGUE --> DISPATCH_REQ[Submit Substitution Request<br/>POST /api/substitutions/requests]
    
    DISPATCH_REQ --> DB_PENDING[(Store Record in `faculty_substitutions`<br/>Status: PENDING)]
    
    %% Colleague Review
    DB_PENDING --> NOTIFY_FAC_B[Faculty B sees Incoming Request in Dashboard]
    NOTIFY_FAC_B --> DECISION{Faculty B Decision}
    
    %% Rejection Path
    DECISION -->|Decline / Reject| REJECT_FLOW[Faculty B inputs optional reason<br/>POST /api/substitutions/:id/reject]
    REJECT_FLOW --> DB_REJECTED[(Update Status: REJECTED)]
    DB_REJECTED --> NOTIFY_REJECT[Faculty A notified of Rejection]
    NOTIFY_REJECT --> SELECT_COLLEAGUE
    
    %% Acceptance Path with Live Revalidation
    DECISION -->|Accept Request| REVALIDATE[Server Revalidates Faculty B Availability<br/>POST /api/substitutions/:id/accept]
    
    subgraph AtomicRevalidation ["Real-Time Revalidation Guard"]
        R1{Is Faculty B STILL Free?}
    end
    
    REVALIDATE --> AtomicRevalidation
    
    %% Revalidation Failure Path
    R1 -->|No: Intervening Conflict Occurred| CONFLICT_ABORT[Abort Acceptance with HTTP 409 Conflict<br/>'Substitute is no longer free']
    CONFLICT_ABORT --> DB_FAILED[(Update Status: REJECTED / CANCELLED)]
    CONFLICT_ABORT --> NOTIFY_FAC_A_FAIL[Faculty A notified to select another candidate]
    NOTIFY_FAC_A_FAIL --> SELECT_COLLEAGUE
    
    %% Revalidation Success Path
    R1 -->|Yes: Genuinely Free| CONFIRM_SUB[Commit Accepted Substitution]
    CONFIRM_SUB --> DB_ACCEPTED[(Update Status: ACCEPTED<br/>in `faculty_substitutions`)]
    
    %% Post-Acceptance State
    DB_ACCEPTED --> STATE_UPDATE[Faculty B is now marked BUSY for that Slot]
    STATE_UPDATE --> PRESERVE_TT[Master Class Timetable remains 100% UNTOUCHED]
    PRESERVE_TT --> HOS_AUDIT[Visible in HOS Departmental Substitution Audit Ledger]
    HOS_AUDIT --> END_NODE([End: Class Covered Successfully])

    %% Styling
    classDef success fill:#d4edda,stroke:#c3e6cb,stroke-width:2px,color:#155724;
    classDef danger fill:#f8d7da,stroke:#f5c6cb,stroke-width:2px,color:#721c24;
    classDef action fill:#cce5ff,stroke:#b8daff,stroke-width:2px,color:#004085;
    classDef decision fill:#fff3cd,stroke:#ffeeba,stroke-width:2px,color:#856404;

    class CONFIRM_SUB,PRESERVE_TT,END_NODE success;
    class CONFLICT_ABORT,REJECT_FLOW danger;
    class DISPATCH_REQ,REVALIDATE action;
    class DECISION,R1 decision;
```

---

## 2. Key Workflow Characteristics

1. **Peer-to-Peer Initiation and Resolution**:
   - The entire request-and-acceptance lifecycle occurs strictly between the affected instructors (Faculty A and Faculty B).
   - The HOS does not act as an intermediary, avoiding administrative bottlenecks during early morning hours.

2. **Real-Time Revalidation at Acceptance**:
   - Because time may elapse between when Faculty A sends a request and when Faculty B accepts it, the system does not blindly trust the candidate's earlier availability status.
   - At the exact moment `POST /api/substitutions/:id/accept` is called, the server executes a fresh, atomic revalidation query across the master schedule, attendance, invigilations, and concurrent substitutions.

3. **Master Timetable Immutability**:
   - Accepted substitutions are stored as distinct records in the `faculty_substitutions` table.
   - The primary `timetable` table is **never mutated** during a substitution. This ensures that regular semester schedules, room allocations, and curriculum assignments remain intact for subsequent weeks.
