# Phase B2.1 — Timetable Data Model Inspection & LLM JSON Contract

**Document Version:** 1.0.0  
**Phase:** B2.1 (Inspection + Schema Design Only)  
**Target Repository:** TecSubstitution (`Sem_Project`)  
**Status:** Completed & Validated  

---

## Executive Summary

This document establishes the official JSON Contract for Phase B2 (n8n → LLM / Vision Timetable Extraction). It is based strictly and exclusively on the inspection of the active codebase, database schema, route handlers, data stores, normalizers, and automated test suites in the TecSubstitution repository.

No LLM, OCR, n8n workflow, or database migration is implemented in this phase. This document serves as the ground-truth specification for validating structured JSON produced by downstream AI/Vision pipelines.

---

## Files Inspected

The following 25 repository files were directly inspected to establish this contract:

1. **Database Schema & Seeding:**
   - `src/db/schema.sql` — PostgreSQL DDL, constraints, partial indexes, table definitions.
   - `src/db/pool.js` — PostgreSQL client connection configuration.
   - `src/db/repository.js` — All production SQL queries, conflict detection, reference resolution, and relational mappings.
   - `src/db/seed.js` — Database migration and initial seeding logic.

2. **Data Stores & Models:**
   - `src/data/store.js` — The dual-backing data seam (PostgreSQL vs. In-Memory fallback), live engine lifecycle.
   - `src/data/departments.js` — Multi-branch registry, branch configuration, and single-branch isolation rules.
   - `src/data/uploads.js` — Phase B1 upload metadata persistence (`timetable_uploads` table and memory store).
   - `src/data/users.js` — Account management and faculty user mapping.
   - `src/data/demoTimetable.js` — Canonical working dataset demonstrating the complete Shape B hierarchical timetable.

3. **Core Engine & Normalizers:**
   - `src/core/normalizer.js` — Canonical day normalization, period normalization, session type classification, Shape A & Shape B parsing.
   - `src/core/validator.js` — Double-booking detection, room clash checks, uncovered slot warnings, error classification.
   - `src/core/availabilityEngine.js` — Availability computation, grid generation (`classGrid`, `facultyGrid`), free/busy indexing.

4. **API Route Handlers:**
   - `src/routes/entries.js` — Timetable entry CRUD (`GET/POST/PUT/DELETE /api/timetable/entries`), reference lookups, slot validation.
   - `src/routes/timetable.js` — Timetable views (`GET /api/timetable`, `GET /api/timetable/mine`, `/meta`, `/records`).
   - `src/routes/faculty.js` — Faculty directory, departmental filtering, availability slot lookups.
   - `src/routes/catalog.js` — Catalog CRUD for branches (`/api/branches`), subjects (`/api/subjects`), and classes (`/api/classes`).
   - `src/routes/import.js` — Spreadsheet and document upload orchestration (`/api/timetable/import`).
   - `src/routes/uploads.js` — Phase B1 document upload endpoints (`/api/uploads/master-timetable`, `/api/uploads/faculty-timetable`).
   - `src/routes/availability.js` — Read-only availability engine endpoints and slot resolution.

5. **Importers & Providers:**
   - `src/importers/index.js` — Import orchestrator (`preview`, `commit`, `analyse`).
   - `src/importers/tableParser.js` — Rectangular table parser (Matrix vs. Long layout detection).
   - `src/importers/documentImporter.js` — Document import adapter and provider boundary.
   - `src/importers/providers/pdfcoProvider.js` — Existing document provider integration.

6. **Automated Test Suites:**
   - `tests/dayparsing.test.js` — Working day validation, Saturday regression tests, alias handling.
   - `tests/mastertimetable.test.js` — Phase A2 HOS master timetable CRUD, authorization, and conflict tests.
   - `tests/uploads.test.js` — Phase B1 file upload, MIME validation, and branch-isolation tests.
   - `tests/availability.test.js` — Phase A4 availability engine and role permission tests.

---

## 1. Existing Timetable Data Model

The application operates on a dual-backing architecture: PostgreSQL (Neon compatible) when configured, falling back to an in-memory store (`src/data/store.js`). Both backings conform to identical entity models.

### PostgreSQL Relational Schema (`src/db/schema.sql`)

```sql
-- Departments / Branches
CREATE TABLE departments (
    id             SERIAL PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,     -- e.g. 'CME', 'EEE', 'CIV'
    name           TEXT NOT NULL,            -- e.g. 'Computer Engineering'
    academic_year  TEXT,                     -- e.g. '2026-27'
    semester       INTEGER                   -- e.g. 5
);

-- Rooms
CREATE TABLE rooms (
    id             SERIAL PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,     -- e.g. 'C-401', 'CM-LAB-1'
    name           TEXT,                     -- e.g. 'Block C — Room 401'
    room_type      TEXT NOT NULL DEFAULT 'classroom'
                   CHECK (room_type IN ('classroom', 'lab')),
    capacity       INTEGER
);

-- Faculty
CREATE TABLE faculty (
    id                 SERIAL PRIMARY KEY,
    code               TEXT NOT NULL UNIQUE, -- e.g. 'FAC001', 'CIV_F1'
    name               TEXT NOT NULL UNIQUE, -- e.g. 'Sri B. Gopala Rao'
    department_id      INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    email              TEXT,
    designation        TEXT,                 -- e.g. 'Professor', 'Assistant Professor'
    phone              TEXT,
    max_weekly_periods INTEGER,
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'on_leave', 'inactive'))
);

-- Subjects
CREATE TABLE subjects (
    id             SERIAL PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,     -- e.g. 'CM-501'
    name           TEXT NOT NULL,            -- unique per department in repo
    department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    subject_type   TEXT NOT NULL DEFAULT 'theory'
                   CHECK (subject_type IN ('theory', 'lab'))
);

-- Classes
CREATE TABLE classes (
    id             SERIAL PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,     -- e.g. 'CME-A', 'EEE-B'
    department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    semester       INTEGER,                  -- 1 to 12
    home_room_id   INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    academic_year  TEXT                      -- e.g. '2026-27'
);

-- Period timing metadata
CREATE TABLE periods (
    period         INTEGER PRIMARY KEY,      -- e.g. 1, 2, 3...
    start_time     TEXT,                     -- e.g. '08:00'
    end_time       TEXT                      -- e.g. '08:45'
);

-- Timetable Entries (The core relational table)
CREATE TABLE timetable (
    id             SERIAL PRIMARY KEY,
    class_id       INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    day_of_week    TEXT NOT NULL
                   CHECK (day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
    period         INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
    subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    faculty_id     INTEGER REFERENCES faculty(id) ON DELETE RESTRICT, -- NULLABLE for activities
    room_id        INTEGER REFERENCES rooms(id) ON DELETE SET NULL,     -- NULLABLE
    session_type   TEXT NOT NULL DEFAULT 'theory'
                   CHECK (session_type IN ('theory', 'lab', 'activity')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Constraints
    CONSTRAINT timetable_class_slot_unique UNIQUE (class_id, day_of_week, period)
);

-- Partial Unique Indexes preventing double-booking:
CREATE UNIQUE INDEX timetable_faculty_slot_unique
    ON timetable (faculty_id, day_of_week, period)
    WHERE faculty_id IS NOT NULL;

CREATE UNIQUE INDEX timetable_room_slot_unique
    ON timetable (room_id, day_of_week, period)
    WHERE room_id IS NOT NULL;
```

### Upload Storage Table (`timetable_uploads`) — Phase B1 Foundation
```sql
CREATE TABLE timetable_uploads (
    id                 SERIAL PRIMARY KEY,
    upload_id          TEXT NOT NULL UNIQUE,
    original_filename  TEXT NOT NULL,
    file_type          TEXT NOT NULL,
    file_size          INTEGER NOT NULL,
    storage_path       TEXT NOT NULL,
    uploader_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    faculty_id         INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
    branch_id          INTEGER REFERENCES departments(id) ON DELETE CASCADE,
    department_code    TEXT NOT NULL,
    upload_type        TEXT NOT NULL CHECK (upload_type IN ('MASTER_TIMETABLE', 'FACULTY_TIMETABLE')),
    status             TEXT NOT NULL DEFAULT 'UPLOADED'
                       CHECK (status IN ('UPLOADED', 'PROCESSING', 'PROCESSED', 'FAILED')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### In-Memory & Normalized Record Model (`src/core/normalizer.js`)
Internal records compiled by `normalize()` take the shape:
```javascript
{
    id: Number || null,
    faculty: String || null,        // e.g. "Sri B. Gopala Rao" (null for activities)
    facultyId: String || null,      // e.g. "FAC001"
    department: String || null,     // e.g. "CME"
    phone: String || null,
    day: String,                    // Canonical day name: "Monday"
    period: Number,                 // Integer 1..12
    subject: String || null,        // Subject name (null when free)
    className: String || null,      // Class code: "CME-A"
    room: String || null,           // Room code: "C-401"
    type: 'theory' | 'lab' | 'activity',
    status: 'busy' | 'free' | 'activity'
}
```

---

## 2. Existing Day and Period Representation

### Days of the Week
1. **Canonical Set (`WORKING_DAYS` in `src/core/normalizer.js`):**
   ```javascript
   ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
   ```
   *CRITICAL RULE:* Saturday is explicitly a standard teaching day. Sunday is valid in aliases and database checks but excluded from default schedules.
2. **Day Aliases (`DAY_ALIASES`):**
   `MON`, `MONDAY`, `TUE`, `TUES`, `TUESDAY`, `WED`, `WEDS`, `WEDNESDAY`, `THU`, `THUR`, `THURS`, `THURSDAY`, `FRI`, `FRIDAY`, `SAT`, `SATURDAY`, `SUN`, `SUNDAY`.
3. **Normalization Function (`normalizeDayName(input)`):**
   Trims, strips whitespace, converts aliases to canonical TitleCase (`"Monday"`, `"Tuesday"`, etc.). Unrecognized strings return `null` and trigger `INVALID_DAY`. It **never** guesses.

### Periods
1. **Integer Representation:** Period numbers are strictly 1-based integers (`1, 2, 3, 4, 5, 6, 7...`).
2. **Bounds:**
   - Database constraint: `period BETWEEN 1 AND 12`.
   - Default configured range: `[1, 2, 3, 4, 5, 6, 7]`.
   - Importer range: `1` to `10`.
3. **Parsing (`normalizePeriodNumber(input)`):** Extracts integer from strings like `"P1"`, `"Period 2"`, `"3"`.

### Period Start & End Times
Period start and end timings **already exist** in both database and demo dataset:
- In DB: Table `periods (period, start_time, end_time)`.
- In Source Meta: `meta.periodTimings`:
  ```json
  {
    "1": { "start": "08:00", "end": "08:45" },
    "2": { "start": "08:45", "end": "09:30" },
    "3": { "start": "09:30", "end": "10:15" },
    "4": { "start": "10:30", "end": "11:15" },
    "5": { "start": "11:15", "end": "12:00" },
    "6": { "start": "12:00", "end": "12:45" },
    "7": { "start": "12:45", "end": "13:30" }
  }
  ```

### Multi-Period Spans (e.g. 3-Period Labs)
- In the DB `timetable` table, multi-period sessions are stored as individual slot rows (e.g., period 5, period 6, and period 7 each have a row).
- In Shape B / `demoTimetable.js`, a multi-period cell uses `period` (start) and `spanTo` (end):
  ```javascript
  { period: 5, spanTo: 7, subject: "Android Programming Lab", faculty: "Ms. Debadatta Bhattacharya", room: "CM-LAB-1", type: "lab" }
  ```
- `repository.loadSource()` automatically collapses consecutive identical slots into `spanTo` blocks when generating grids.

---

## 3. Existing Faculty, Subject, Class, and Room Representation

| Entity | Identifier in DB | Primary Lookup in API / Writes | Code Format | Name Format | Nullable in Timetable? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Branch / Department** | `id` (SERIAL), `code` (UNIQUE) | `code` (UPPERCASE) | `CME`, `EEE`, `CIV`, `MEC` (2–16 chars) | `Computer Engineering` | Foreign key in `classes`, `subjects`, `faculty` |
| **Faculty** | `id` (SERIAL), `code` (UNIQUE) | `name` (case-insensitive) | `FAC001`, `CIV_F1` | `Sri B. Gopala Rao`, `Ms. B. Kusuma` | **YES** (NULL for activities like Library, Sports, Counselling) |
| **Subject** | `id` (SERIAL), `code` (UNIQUE) | `name` (case-insensitive) | `CM-501`, `EE-402` | `Python Programming`, `Power Systems` | **NO** (Every scheduled slot requires a subject) |
| **Class** | `id` (SERIAL), `code` (UNIQUE) | `code` (case-insensitive) | `CME-A`, `EEE-B`, `MEC-A` | Same as code (branch + section) | **NO** (Every timetable entry belongs to a class section) |
| **Room** | `id` (SERIAL), `code` (UNIQUE) | `code` (case-insensitive) | `C-401`, `CM-LAB-1`, `E-201` | `Block C — Room 401` | **YES** (Can be null if unassigned or regular classroom assumed) |

### Non-Faculty Activity Sessions
The system includes built-in support for activities that have no faculty assigned:
- Matching regex: `/\b(library|counselling|counseling|tpc|placement|training|sports|games|seminar|mentoring|assembly|activity|break|lunch)\b/i`.
- Session type becomes `'activity'`.
- `faculty_id` is set to `NULL`.

---

## 4. Existing Master vs. Faculty Timetable Representation

### Single Storage vs. Multiple Views
In the database, there is **no separate table** for master timetables versus faculty timetables. Every entry is stored in the unified `timetable` table.
- **Master Timetable View:** Generated per **Class Section** (`GET /api/timetable?class=CME-A`). Represents the complete weekly grid of all periods for that section, showing the subject, room, and assigned faculty for each slot.
- **Faculty Timetable View:** Generated per **Faculty Member** (`GET /api/timetable?faculty=Ms.+B.+Kusuma` or `GET /api/timetable/mine`). Slices across all classes to show the specific slots where that instructor is teaching, and fills the remaining slots as `'free'`.

### Upload Distinction (Phase B1 Foundation)
In `src/routes/uploads.js`, document uploads are partitioned by role:
1. `MASTER_TIMETABLE`:
   - Role authorized: `hos` (Head of Section) or `coordinator`.
   - Payload: Scope is the entire branch (`department_code`).
   - Document layout: Typically a class timetable grid (e.g. `CME-A` week schedule) or combined branch master grid.
2. `FACULTY_TIMETABLE`:
   - Role authorized: `faculty`.
   - Payload: Scoped to the authenticated faculty member's identity (`faculty_id` / `facultyName`) and branch.
   - Document layout: Personal weekly schedule showing which class sections the faculty member teaches in each period.

---

## 5. Existing Importer Structures

The repository already defines two distinct intermediate shapes in `src/core/normalizer.js` and `src/importers/tableParser.js`:

### Shape A: Flat Long-Form (`entries` array)
```javascript
{
    meta: { title, days, periods },
    faculty: [{ id, name, department }],
    entries: [
        {
            faculty: "Dr. A Rao",
            day: "Monday",
            period: 1,
            subject: "DBMS",
            class: "CME-A",
            room: "C-401",
            type: "theory"
        }
    ]
}
```

### Shape B: Hierarchical Per-Class Grids (`classes` array)
```javascript
{
    meta: { institution, title, days, periods, periodTimings, primaryClass },
    departments: [...],
    rooms: [...],
    subjects: [...],
    faculty: [...],
    classes: [
        {
            class: "CME-A",
            department: "CME",
            semester: 5,
            academicYear: "2026-27",
            room: "C-401",
            rows: {
                Monday: [
                    { period: 1, spanTo: 2, subject: "Python Programming", faculty: "Ms. B. Kusuma", room: "C-401", type: "theory" }
                ]
            }
        }
    ]
}
```

### Free Tokens
The parser explicitly recognizes tokens indicating an unscheduled or free period:
`FREE_TOKENS = ['', '-', '--', 'FREE', 'NIL', 'NONE', 'N/A', 'NA', 'X']`.

---

## 6. Proposed LLM JSON Schema

This JSON schema is designed for the **n8n → LLM/Vision workflow** to extract timetable data from scanned PDFs or images.

### Design Principles
1. **Deterministic & Strict:** Uses explicit keys, standardized enums, and clear nullability.
2. **Dual-Mode (Master & Faculty):** Controlled by the discriminator `timetable_type`.
3. **Atomic Period Slots:** Multi-period blocks are broken into individual periods or explicit `span_to` ranges compatible with `normalizer.js`.
4. **No Guessed Data:** Missing values are strictly `null`.
5. **Direct Backend Alignment:** Every property maps directly to an existing column in `src/db/schema.sql` or field in `normalizer.js`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TimetableExtractionPayload",
  "description": "Standardized output contract for n8n LLM/Vision timetable document extraction.",
  "type": "object",
  "required": [
    "contract_version",
    "timetable_type",
    "department_code",
    "days",
    "periods",
    "entries"
  ],
  "additionalProperties": false,
  "properties": {
    "contract_version": {
      "type": "string",
      "const": "2.1"
    },
    "timetable_type": {
      "type": "string",
      "enum": ["MASTER_TIMETABLE", "FACULTY_TIMETABLE"],
      "description": "Indicates whether the document represents a class/master timetable or a personal faculty timetable."
    },
    "institution_name": {
      "type": ["string", "null"],
      "description": "Name of college or institute from header, or null if absent."
    },
    "title": {
      "type": ["string", "null"],
      "description": "Timetable title printed on document, or null if absent."
    },
    "department_code": {
      "type": "string",
      "pattern": "^[A-Za-z0-9-]{2,16}$",
      "description": "Standard branch/department code (e.g., CME, EEE, MEC, CIV)."
    },
    "academic_year": {
      "type": ["string", "null"],
      "pattern": "^[0-9]{4}-[0-9]{2,4}$",
      "description": "Academic year string (e.g., '2026-27'), or null if unstated."
    },
    "semester": {
      "type": ["integer", "null"],
      "minimum": 1,
      "maximum": 12,
      "description": "Semester number (1-12), or null if unstated."
    },
    "class_name": {
      "type": ["string", "null"],
      "description": "Class/section code (e.g., 'CME-A'). Required for single-class MASTER_TIMETABLE; null if multi-class master or personal faculty timetable."
    },
    "faculty_name": {
      "type": ["string", "null"],
      "description": "Full name of faculty member. Required for FACULTY_TIMETABLE; null for MASTER_TIMETABLE."
    },
    "faculty_code": {
      "type": ["string", "null"],
      "description": "Official faculty ID/code if printed on document (e.g., 'FAC001'), or null."
    },
    "default_room": {
      "type": ["string", "null"],
      "description": "Home classroom for the section if printed in header (e.g., 'C-401'), or null."
    },
    "days": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
      },
      "minItems": 1,
      "uniqueItems": true,
      "description": "Days explicitly covered in the document grid."
    },
    "periods": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 1,
        "maximum": 12
      },
      "minItems": 1,
      "uniqueItems": true,
      "description": "Sorted list of period numbers found in the document header."
    },
    "period_timings": {
      "type": ["object", "null"],
      "description": "Start and end times per period, or null if not printed.",
      "additionalProperties": {
        "type": "object",
        "required": ["start", "end"],
        "additionalProperties": false,
        "properties": {
          "start": { "type": "string", "pattern": "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" },
          "end": { "type": "string", "pattern": "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }
        }
      }
    },
    "entries": {
      "type": "array",
      "description": "List of scheduled timetable cells extracted from the document.",
      "items": {
        "type": "object",
        "required": [
          "day",
          "period",
          "subject_name",
          "session_type",
          "is_free"
        ],
        "additionalProperties": false,
        "properties": {
          "day": {
            "type": "string",
            "enum": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
          },
          "period": {
            "type": "integer",
            "minimum": 1,
            "maximum": 12,
            "description": "Starting period number for this cell."
          },
          "span_to": {
            "type": ["integer", "null"],
            "minimum": 1,
            "maximum": 12,
            "description": "Ending period number if this slot spans multiple periods (e.g. 3-period lab: period=5, span_to=7). Null if single period."
          },
          "subject_name": {
            "type": ["string", "null"],
            "description": "Full or short subject name as printed. Null if free/recess slot."
          },
          "subject_code": {
            "type": ["string", "null"],
            "description": "Subject curriculum code (e.g., 'CM-501') if printed in the cell or legend; otherwise null."
          },
          "faculty_name": {
            "type": ["string", "null"],
            "description": "Name of the teacher for this slot. Null for non-faculty activities (Library, Sports) or free slots. For FACULTY_TIMETABLE, matches document owner."
          },
          "class_name": {
            "type": ["string", "null"],
            "description": "Class section for this slot (e.g., 'CME-A'). For MASTER_TIMETABLE, defaults to document class_name if not specified per cell."
          },
          "room_code": {
            "type": ["string", "null"],
            "description": "Room/lab identifier (e.g., 'C-401', 'CM-LAB-1'). Null if not stated."
          },
          "session_type": {
            "type": "string",
            "enum": ["theory", "lab", "activity"],
            "description": "Session type. Automatically categorized or explicit."
          },
          "is_free": {
            "type": "boolean",
            "description": "True if this period is marked FREE, blank, break, or recess. False if scheduled."
          },
          "raw_cell_text": {
            "type": ["string", "null"],
            "description": "Exact text from the document cell before parsing, for audit/verification."
          }
        }
      }
    },
    "extraction_metadata": {
      "type": "object",
      "required": ["confidence_score", "warnings"],
      "additionalProperties": false,
      "properties": {
        "confidence_score": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 1.0,
          "description": "Overall OCR/Vision model confidence score."
        },
        "warnings": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Extraction ambiguity notes, occluded text, or cell split warnings."
        }
      }
    }
  }
}
```

---

## 7. Complete MASTER Timetable JSON Example

Below is a complete, production-grade payload for a Class Section Master Timetable (`CME-A`):

```json
{
  "contract_version": "2.1",
  "timetable_type": "MASTER_TIMETABLE",
  "institution_name": "ADITYA INSTITUTE OF TECHNOLOGY AND MANAGEMENT",
  "title": "POLYTECHNIC C23 - V SEM TIME TABLE",
  "department_code": "CME",
  "academic_year": "2026-27",
  "semester": 5,
  "class_name": "CME-A",
  "faculty_name": null,
  "faculty_code": null,
  "default_room": "C-401",
  "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  "periods": [1, 2, 3, 4, 5, 6, 7],
  "period_timings": {
    "1": { "start": "08:00", "end": "08:45" },
    "2": { "start": "08:45", "end": "09:30" },
    "3": { "start": "09:30", "end": "10:15" },
    "4": { "start": "10:30", "end": "11:15" },
    "5": { "start": "11:15", "end": "12:00" },
    "6": { "start": "12:00", "end": "12:45" },
    "7": { "start": "12:45", "end": "13:30" }
  },
  "entries": [
    {
      "day": "Monday",
      "period": 1,
      "span_to": 2,
      "subject_name": "Python Programming",
      "subject_code": "CM-505",
      "faculty_name": "Ms. B. Kusuma",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "PP - Ms. B. Kusuma (C-401)"
    },
    {
      "day": "Monday",
      "period": 3,
      "span_to": null,
      "subject_name": "Industrial Management and Entrepreneurship",
      "subject_code": "CM-501",
      "faculty_name": "Sri B. Gopala Rao",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "IME - Sri B. Gopala Rao"
    },
    {
      "day": "Monday",
      "period": 4,
      "span_to": null,
      "subject_name": "Big Data & Cloud Computing",
      "subject_code": "CM-502",
      "faculty_name": "Ms. G. Sandhya Rani",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "BD&CC - Ms. G. Sandhya Rani"
    },
    {
      "day": "Monday",
      "period": 5,
      "span_to": 7,
      "subject_name": "Android Programming Lab",
      "subject_code": "CM-506",
      "faculty_name": "Ms. Debadatta Bhattacharya",
      "class_name": "CME-A",
      "room_code": "CM-LAB-1",
      "session_type": "lab",
      "is_free": false,
      "raw_cell_text": "Android Lab (P5-P7) - CM-LAB-1"
    },
    {
      "day": "Tuesday",
      "period": 1,
      "span_to": null,
      "subject_name": "Big Data & Cloud Computing",
      "subject_code": "CM-502",
      "faculty_name": "Ms. G. Sandhya Rani",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "BD&CC"
    },
    {
      "day": "Tuesday",
      "period": 2,
      "span_to": null,
      "subject_name": "Internet Of Things",
      "subject_code": "CM-504",
      "faculty_name": "Mrs. A. Sravanthi",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "IOT"
    },
    {
      "day": "Tuesday",
      "period": 7,
      "span_to": null,
      "subject_name": "Library",
      "subject_code": null,
      "faculty_name": null,
      "class_name": "CME-A",
      "room_code": null,
      "session_type": "activity",
      "is_free": false,
      "raw_cell_text": "LIBRARY"
    },
    {
      "day": "Saturday",
      "period": 7,
      "span_to": null,
      "subject_name": null,
      "subject_code": null,
      "faculty_name": null,
      "class_name": "CME-A",
      "room_code": null,
      "session_type": "activity",
      "is_free": true,
      "raw_cell_text": "FREE"
    }
  ],
  "extraction_metadata": {
    "confidence_score": 0.98,
    "warnings": []
  }
}
```

---

## 8. Complete FACULTY Timetable JSON Example

Below is a complete, production-grade payload for a personal Faculty Timetable (`Ms. B. Kusuma`, CME department):

```json
{
  "contract_version": "2.1",
  "timetable_type": "FACULTY_TIMETABLE",
  "institution_name": "ADITYA INSTITUTE OF TECHNOLOGY AND MANAGEMENT",
  "title": "FACULTY INDIVIDUAL WORKLOAD TIMETABLE",
  "department_code": "CME",
  "academic_year": "2026-27",
  "semester": null,
  "class_name": null,
  "faculty_name": "Ms. B. Kusuma",
  "faculty_code": "FAC005",
  "default_room": null,
  "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  "periods": [1, 2, 3, 4, 5, 6, 7],
  "period_timings": {
    "1": { "start": "08:00", "end": "08:45" },
    "2": { "start": "08:45", "end": "09:30" },
    "3": { "start": "09:30", "end": "10:15" },
    "4": { "start": "10:30", "end": "11:15" },
    "5": { "start": "11:15", "end": "12:00" },
    "6": { "start": "12:00", "end": "12:45" },
    "7": { "start": "12:45", "end": "13:30" }
  },
  "entries": [
    {
      "day": "Monday",
      "period": 1,
      "span_to": 2,
      "subject_name": "Python Programming",
      "subject_code": "CM-505",
      "faculty_name": "Ms. B. Kusuma",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "CME-A (Python Prog) C-401"
    },
    {
      "day": "Monday",
      "period": 3,
      "span_to": null,
      "subject_name": null,
      "subject_code": null,
      "faculty_name": "Ms. B. Kusuma",
      "class_name": null,
      "room_code": null,
      "session_type": "theory",
      "is_free": true,
      "raw_cell_text": "FREE"
    },
    {
      "day": "Tuesday",
      "period": 6,
      "span_to": null,
      "subject_name": "Python Programming",
      "subject_code": "CM-505",
      "faculty_name": "Ms. B. Kusuma",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "CME-A (Python)"
    },
    {
      "day": "Wednesday",
      "period": 2,
      "span_to": null,
      "subject_name": "Python Programming",
      "subject_code": "CM-505",
      "faculty_name": "Ms. B. Kusuma",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "CME-A (Python)"
    },
    {
      "day": "Wednesday",
      "period": 5,
      "span_to": 7,
      "subject_name": "Python Programming Lab",
      "subject_code": "CM-507",
      "faculty_name": "Ms. B. Kusuma",
      "class_name": "CME-A",
      "room_code": "CM-LAB-1",
      "session_type": "lab",
      "is_free": false,
      "raw_cell_text": "Python Lab (CM-LAB-1)"
    },
    {
      "day": "Saturday",
      "period": 4,
      "span_to": null,
      "subject_name": "Python Programming",
      "subject_code": "CM-505",
      "faculty_name": "Ms. B. Kusuma",
      "class_name": "CME-A",
      "room_code": "C-401",
      "session_type": "theory",
      "is_free": false,
      "raw_cell_text": "CME-A (Python)"
    }
  ],
  "extraction_metadata": {
    "confidence_score": 0.95,
    "warnings": [
      "Saturday P7 was unannotated; marked as is_free=true."
    ]
  }
}
```

---

## 9. Field-by-Field Explanation

### Document Root Properties

| Field | Type | Nullable? | Purpose & Validation | Mapping to Existing Repo |
| :--- | :--- | :--- | :--- | :--- |
| `contract_version` | String | No | Must be `"2.1"`. Prevents pipeline schema drift. | Pipeline version check |
| `timetable_type` | Enum String | No | Must be `"MASTER_TIMETABLE"` or `"FACULTY_TIMETABLE"`. | Matches `timetable_uploads.upload_type` |
| `institution_name` | String | Yes | Name of college (e.g. from document header). | `demoTimetable.meta.institution` |
| `title` | String | Yes | Document title (e.g. `"V SEM TIME TABLE"`). | `demoTimetable.meta.title` |
| `department_code` | String | No | Academic branch code (e.g. `CME`, `EEE`). Upper-cased. | `departments.code`, `timetable_uploads.department_code` |
| `academic_year` | String | Yes | Format `"YYYY-YY"` or `"YYYY-YYYY"`. | `departments.academic_year`, `classes.academic_year` |
| `semester` | Integer | Yes | Value between 1 and 12. | `departments.semester`, `classes.semester` |
| `class_name` | String | Yes | Section code (`CME-A`). Required if master timetable for a single class. | `classes.code` |
| `faculty_name` | String | Yes | Name of instructor. Required if personal faculty timetable. | `faculty.name` |
| `faculty_code` | String | Yes | Faculty identifier code (e.g. `FAC001`). | `faculty.code` |
| `default_room` | String | Yes | Home classroom printed in document header. | `classes.home_room_id` / `demoTimetable.classes[].room` |
| `days` | Array of Strings| No | Canonical list of days found in the grid. | `meta.days`, `normalizer.DEFAULT_DAYS` |
| `periods` | Array of Ints | No | Ascending array of integers (`1..7`, `1..12`). | `meta.periods`, `periods.period` |
| `period_timings` | Object | Yes | Map of period number to `{ start: "HH:MM", end: "HH:MM" }`. | `periods (start_time, end_time)`, `meta.periodTimings` |
| `entries` | Array of Objects| No | Array of slot records. | Source for `timetable` rows / `normalizer.records` |
| `extraction_metadata`| Object | No | Confidence score (0.0–1.0) and model warnings. | Audit logging and threshold validation |

### Entry Object Properties

| Field | Type | Nullable? | Description | Backend Mapping |
| :--- | :--- | :--- | :--- | :--- |
| `day` | String | No | Canonical TitleCase day (`"Monday"`, `"Tuesday"`, etc.). | `timetable.day_of_week` |
| `period` | Integer | No | Starting period index (`1` to `12`). | `timetable.period` |
| `span_to` | Integer | Yes | End period for multi-period blocks (e.g. 7 for lab spanning 5-7). `null` for 1-period slots. | Shape B `spanTo` / converted to discrete periods in DB |
| `subject_name` | String | Yes | Subject name as printed. `null` for free slots. | Looked up in `subjects.name` |
| `subject_code` | String | Yes | Curriculum code (e.g. `CM-505`). `null` if unstated. | Looked up in `subjects.code` |
| `faculty_name` | String | Yes | Instructor full name. `null` for activities and free slots. | Looked up in `faculty.name` |
| `class_name` | String | Yes | Class section code (`CME-A`). Defaults to header `class_name` in master. | Looked up in `classes.code` |
| `room_code` | String | Yes | Room/lab code (`C-401`). `null` if unstated. | Looked up in `rooms.code` |
| `session_type` | Enum String | No | `"theory"`, `"lab"`, or `"activity"`. | `timetable.session_type` |
| `is_free` | Boolean | No | `true` if recess, lunch, free, or blank. `false` if scheduled. | Filters out free entries before DB insertion |
| `raw_cell_text` | String | Yes | Exact text inside cell. Useful for audit and debug. | Not persisted; used during validation |

---

## 10. Validation Rules the Backend Must Enforce

When the backend receives the JSON payload from the n8n webhook, it must execute the following validations in sequence:

### Rule 1: Schema & Version Integrity
- Reject if `contract_version !== "2.1"`.
- Reject if `timetable_type` is not `"MASTER_TIMETABLE"` or `"FACULTY_TIMETABLE"`.
- Reject if `department_code` is missing or does not match the active session / upload token branch (`403 FORBIDDEN`).

### Rule 2: Role & Identity Enforcement (from `src/routes/uploads.js` & `entries.js`)
- If `timetable_type === "MASTER_TIMETABLE"`:
  - Uploader role must be `hos` or `coordinator`.
  - `department_code` must match `req.session.department`.
- If `timetable_type === "FACULTY_TIMETABLE"`:
  - Uploader role must be `faculty`.
  - Payload `faculty_name` must match the authenticated `req.session.facultyName` (case-insensitive).
  - Cross-faculty upload attempts must return `403 FORBIDDEN` (`FACULTY_UPLOAD_MISMATCH`).

### Rule 3: Day and Period Resolution (`src/core/normalizer.js`)
- Every day must resolve via `normalizeDayName(day)` to a valid day in `WORKING_DAYS`.
- Any day resolving to `null` fails immediately with `400 INVALID_DAY`.
- Every period must resolve via `normalizePeriodNumber(period)` to an integer between 1 and 12.
- If `span_to` is provided, verify `span_to >= period` and `span_to <= 12`.

### Rule 4: Catalog Reference Verification (`src/db/repository.js: resolveRefs`)
- **Class Reference:** Look up `class_name` in `classes (code)`. If missing, reject with `400 UNKNOWN_REFERENCE` (`class "..."`).
- **Subject Reference:**
  - If `is_free === true`, skip.
  - If `session_type === 'activity'` (Library, Sports, TPC, etc.), allow non-catalog activity name.
  - Otherwise, resolve `subject_name` in `subjects (name)`. If `subject_code` is present, corroborate against `subjects (code)`. If neither exists, fail with `400 UNKNOWN_REFERENCE`.
- **Faculty Reference:**
  - If `session_type === 'activity'`, faculty is allowed to be `null`.
  - Otherwise, resolve `faculty_name` in `faculty (name)`. If absent, fail with `400 UNKNOWN_REFERENCE`.
- **Room Reference:**
  - If `room_code` is provided, look up in `rooms (code)`. If not found, fail with `400 UNKNOWN_REFERENCE`.

### Rule 5: Double-Booking & Conflict Check (`src/db/repository.js: findSlotConflicts`)
Before committing any entry to the database:
- **Class Conflict (`CLASS_BUSY`):** Ensure the target `class_name` has no other entry at `(day, period)`.
- **Faculty Conflict (`FACULTY_BUSY`):** Ensure `faculty_name` is not teaching another class at `(day, period)`.
- **Room Conflict (`ROOM_BUSY`):** Ensure `room_code` is not hosting another section at `(day, period)`.

---

## 11. Fields the LLM Must Never Guess

To guarantee data integrity, the LLM / Vision model prompt must enforce the following negative constraints:

1. **NEVER guess Faculty Name:** If a cell displays `"DBMS"` without an instructor name, the LLM must output `"faculty_name": null`. It must never invent an instructor.
2. **NEVER guess Subject Code:** If the cell reads `"Python"`, the LLM must set `"subject_code": null`. It must never fabricate `"CM-505"` unless that code appears on the page.
3. **NEVER guess Room:** If no room number or lab name is stated in the cell or class header, output `"room_code": null`.
4. **NEVER guess Period Timings:** If clock times (e.g. `08:00 - 08:45`) are not printed in the column headers, `"period_timings"` must be `null`.
5. **NEVER guess Academic Year or Semester:** If unstated in the header block, set `"academic_year": null` and `"semester": null`.
6. **NEVER convert Free/Blank Slots into Subjects:** If a cell is blank or says `"FREE"`, `"LUNCH"`, or `"-"`, the LLM must mark `"is_free": true` and `"subject_name": null`. It must never carry forward the subject from an adjacent cell.
7. **NEVER guess Department Code:** If the document header does not specify the department, it must be provided to the LLM as execution context from the upload session; the LLM must not invent arbitrary branch codes.

---

## 12. Unresolved Questions & Architectural Notes in the Codebase

During the inspection of the active codebase, the following noteworthy characteristics and edge cases were identified:

1. **Subject Matching by Name vs. Code:**
   In `schema.sql`, both `code` and `name` exist on `subjects`. However, in `repository.js (resolveRefs)` and `entries.js`, timetable entries map subjects by **subject name**:
   ```sql
   SELECT id FROM subjects WHERE UPPER(name) = UPPER($1) LIMIT 1
   ```
   *Recommendation for B2:* The JSON contract captures both `subject_name` and `subject_code` (if visible). The backend will match primarily on `subject_name`, falling back to `subject_code` when ambiguous.
2. **Multi-Class Timetable Sheets:**
   Some physical college timetables display multiple sections side-by-side (e.g., CME-A and CME-B on one sheet).
   *Contract handling:* The proposed contract places `class_name` at both the root level (default) and inside each entry. In multi-section sheets, the LLM sets the root `class_name` to `null` and assigns `class_name` per entry.
3. **Faculty Name Variants and Titles:**
   The database stores full names with formal prefixes (e.g., `"Sri B. Gopala Rao"`, `"Ms. G. Sandhya Rani"`), whereas timetables may print abbreviations (e.g., `"B.G. Rao"`, `"G.S. Rani"`).
   *Contract handling:* The LLM extracts the exact string as printed in `raw_cell_text` and the closest full title in `faculty_name`. The backend reconciliation layer will handle alias matching using the existing username/name resolver.
4. **Lab Spanning Storage:**
   In `schema.sql`, each period has an individual row in `timetable`. In `demoTimetable.js`, multi-period labs use `period` and `spanTo`.
   *Contract handling:* The proposed contract accepts `period` and `span_to`. The backend ingest handler will automatically expand `period: 5, span_to: 7` into discrete rows for periods 5, 6, and 7 upon database insertion, keeping it 100% compatible with both models.
