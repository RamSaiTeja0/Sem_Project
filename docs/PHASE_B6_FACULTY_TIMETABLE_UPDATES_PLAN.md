# Phase B6 Architecture & Implementation Plan: Faculty Management, Multi-Semester Timetables & Cross-Branch Availability Priority

**Document ID**: `docs/PHASE_B6_FACULTY_TIMETABLE_UPDATES_PLAN.md`  
**Status**: DRAFT (Planning Only — No Code Implemented)  
**Target Milestone**: Phase B6 (Pre-Phase C Product Updates)  
**Parent Checkpoint**: Commit `ce48b05` (*Complete timetable AI extraction and HOS approval pipeline*)

---

## Executive Summary

Before Phase C, three critical operational product enhancements are planned for the TecSubstitution platform:

1. **HOS Faculty Management**: Full CRUD capabilities for faculty within an HOS's branch, emphasizing **safe deactivation** (`status: 'inactive'`) rather than physical database deletion to protect historical timetable slots and past substitution records. Inactive faculty are automatically excluded from availability and substitution selection while remaining available for historical audits.
2. **Multi-Semester & Multi-Section Timetable Management (Dynamic / Configurable Semesters)**: Timetables are uniquely and authoritatively scoped by the 4-tuple:
   $$\mathbf{Scope} = \big\langle \mathbf{Branch/Program},\ \mathbf{Academic\ Year},\ \mathbf{Semester},\ \mathbf{Section} \big\rangle$$
   - **No combined string identifiers** (e.g. do *not* use synthetic composite codes like `CME-S1-A`).
   - The fields remain strictly separate: **Branch/Program** (`CME`), **Academic Year** (`2026-27`), **Semester** (`SEM-1`, `SEM-2`, etc.), and **Section** (`A`, `B`, etc.).
   - The database/internal identifier remains **`class_id`** (`classes.id`).
   - **Dynamic & Configurable Semesters (No Hard-Coded SEM-6 Limit)**: The platform supports both Diploma programs (`SEM-1` through `SEM-6`) and B.Tech/BTEC programs (`SEM-1` through `SEM-8`), as well as future/custom programs. Semesters are **dynamic and configured per branch/program** rather than hard-coded globally.
   - **New Branch Creation Support**: During new HOS registration, the HOS specifies the branch program type and number of semesters ($N$). The system dynamically initializes and scopes `SEM-1 ... SEM-N` for that branch without affecting any other branch.
   - **Strict Legacy Safety & Zero Guessing**: Existing legacy class codes (`CME-A`, `CME-B`, `EEE-B`, `DEEE-B`) are **never deleted or blindly renamed**. Crucially, the system will **never automatically guess or assume a semester or academic year** during migration. If reliable data does not exist, fields remain `NULL` and the class is flagged as requiring explicit HOS confirmation.
   - Existing timetable rows are preserved 100% with zero duplication.
   - An HOS can view, upload, replace, or archive/delete a specific semester/section timetable with zero side effects on other semesters, sections, or branches.
3. **Cross-Branch Faculty Availability with Priority**: When an HOS needs a substitute for an absent faculty member, the availability engine evaluates both the home branch and other registered branches:
   - **Priority 1**: Free active faculty from the absent member's home branch.
   - **Priority 2**: Free active faculty from other registered branches (EEE, ECE, MEC, etc.).  
   All candidates must be genuinely free at that slot across all classes in the college. Branch priority never overrides a timetable conflict. The final substitute assignment remains an explicit, manual decision by the HOS (strictly zero AI, zero automated assignment).

---

## 1. Current Architecture Review

### 1.1 Database Schema (`src/db/schema.sql`)
- **`departments`**: Stores branch records (`id, code, name, academic_year, semester`).
- **`faculty`**: Stores faculty roster (`id, code, name, department_id, email, designation, phone, max_weekly_periods, status`).
  - Column `status TEXT NOT NULL DEFAULT 'active'` with check constraint `CHECK (status IN ('active', 'on_leave', 'inactive'))` already exists at the SQL schema level.
- **`users`**: Stores authentication credentials and role affiliations (`id, username, name, role, department_id, faculty_id, phone, password_hash`).
- **`faculty_subjects`**: Links `(faculty_id, subject)` for specialized expertise.
- **`classes`**: Currently stores `(id, code, department_id, semester, academic_year, home_room_id)` with `code UNIQUE`.
  - `id`: Internal primary key (`class_id`).
  - `code`: Textual identifier (e.g. `CME-A`, `CME-B`, `EEE-B`, `DEEE-B`).
  - `department_id`: References `departments(id)` (Branch).
  - `semester`: INTEGER column (nullable).
  - `academic_year`: TEXT column (nullable).
- **`timetable`**: Stores atomic slots `(id, class_id, day_of_week, period, subject_id, faculty_id, room_id, session_type)` with unique constraint on `(class_id, day_of_week, period)`.
- **`substitutions`**: Stores recorded substitutions `(id, timetable_id, absent_faculty_id, substitute_faculty_id, day_of_week, period, date, notes, status)`.
- **`timetable_uploads` & `timetable_staging`**: Tracks uploaded documents, extracted contracts, entity mappings, and approval audits.

### 1.2 In-Memory Store & Fallback (`src/data/store.js`)
- `state.source.faculty`: In-memory array of faculty profiles (`id, name, department, designation, email, phone, subjects, status, maxWeeklyPeriods`).
- `state.source.classes`: In-memory array of class objects (`class, department, semester, academicYear, room, rows`).
- `state.source.entries`: Flat list of timetable slots `(id, className, day, period, subject, faculty, room, type)`.
- `importStagedTimetableInMemory`: Implements `REPLACE_CLASS` behavior, deleting prior entries for the target class before inserting newly approved slots.

### 1.3 Faculty Lifecycle & Accounts (`src/data/users.js` & `src/routes/faculty.js`)
- Currently, faculty accounts are created via `/api/auth/register` (when called by an authenticated HOS session) or `/api/faculty` (which requires PostgreSQL backing).
- There is currently **no route to update** faculty details (except self-profile updates via `/api/auth/profile`) and **no route to deactivate** a faculty member who leaves the institution.

### 1.4 Timetable & Class Architecture
- Currently, classes are queried via `?class=CODE` (e.g. `CME-A`, `CME-B`) or `?faculty=NAME`.
- The Master Timetable UI (`public/index.html`) currently has a single flat view selector (`#ttView`), lacking separate semester and section controls.

### 1.5 Availability Engine (`src/core/availabilityEngine.js` & `src/routes/availability.js`)
- `availabilityEngine.js` indexes every normalized record into a slot map `day|period -> { busy: [], free: [] }`.
- In `src/routes/availability.js`, an HOS query currently restricts evaluation strictly to `sessionDept`:
  ```javascript
  if (sessionDept && input.department && input.department !== sessionDept) {
      return res.status(403).json({ error: 'Cross-branch queries are not allowed.', code: 'FORBIDDEN' });
  }
  ```
- As a result, only faculty from the authenticated branch are queried. Other registered branches are blocked from substitution consideration.

---

## 2. Required Changes for Faculty Management (Update 1)

### 2.1 Functional Objectives
1. **View Faculty**: HOS can view all faculty in their branch, including active and inactive members, with their status clearly badged.
2. **Create Faculty**: HOS can register a new faculty member with name, phone, username, password, designation, and multiple subjects of expertise (inheriting branch automatically).
3. **Edit Faculty Details**: HOS can update an existing faculty member's:
   - Full Name
   - Phone Number
   - Subjects / Areas of Expertise
   - Designation / Category (Professor, Associate Professor, Assistant Professor, Lecturer, etc.)
   - Maximum Weekly Periods
4. **Safe Deactivation**:
   - When a faculty member departs, the HOS selects "Deactivate Faculty".
   - The faculty status is updated to `'inactive'`.
   - The associated user account is disabled from logging in.
   - Historical timetable slots, historical attendance, and past substitutions remain 100% intact, maintaining relational integrity without cascade deletions or orphaned records.
5. **Availability & Substitution Exclusion**:
   - Inactive faculty must **never** appear in the `availableFaculty` list.
   - Inactive faculty must **never** be suggested or selectable for substitutions.
   - Inactive faculty remain viewable in historical grids and directory filters (with a clear `Inactive` badge).

### 2.2 Model & Repository Methods
- **In-Memory (`src/data/store.js` & `src/data/users.js`)**:
  - `updateFacultyInMemory(facultyId, updates)`
  - `setFacultyStatusInMemory(facultyId, status)`
  - `users.updateFacultyUser(facultyId, updates)`
- **Database Repository (`src/db/repository.js`)**:
  - `updateFaculty(facultyId, branchCode, updates)`
  - `deactivateFaculty(facultyId, branchCode)`
  - `activateFaculty(facultyId, branchCode)`

---

## 3. Required Changes for Multi-Semester & Section Timetable Management (Update 2)

### 3.1 Discrete Scope Model (Authoritative 4-Tuple)
Rather than synthesizing artificial composite string identifiers (e.g. do **not** use `CME-S1-A` or `EEE-S4-B`), the authoritative timetable scope is strictly defined by 4 separate, first-class fields:

$$\mathbf{Scope} = \big\langle \text{Branch/Program},\ \text{Academic Year},\ \text{Semester},\ \text{Section} \big\rangle$$

- **`branch`**: Department / Program code (e.g. `CME`, `EEE`, `MEC`, `CSE`).
- **`academic_year`**: Academic year string (e.g. `2026-27`, `2025-26`).
- **`semester`**: Dynamic semester designation using format **`SEM-<number>`** (e.g. `SEM-1`, `SEM-2` ... `SEM-8`).
- **`section`**: Section identifier (e.g. `A`, `B`, `C`, `D`).
- **`class_id`**: The database/internal integer identifier (`classes.id`).

#### Illustrative Scope Examples across Programs:

| Branch / Program | Program Type | Academic Year | Semester | Section | Internal `class_id` | Legacy / Display Code | Scoping Status |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| `CME` | Diploma (6 Sems) | `2026-27` | `SEM-5` | `A` | `1` | `CME-A` | Confirmed (from declared dataset) |
| `CME` | Diploma (6 Sems) | `2026-27` | `SEM-1` | `A` | `2` | `CME 1A` | Confirmed |
| `CME` | Diploma (6 Sems) | `2026-27` | `SEM-2` | `A` | `3` | `CME 2A` | Confirmed |
| `EEE` | Diploma (6 Sems) | `2025-26` | `SEM-4` | `B` | `4` | `EEE-B` (or `DEEE-B`) | Confirmed (from declared dataset) |
| `CSE` | B.Tech (8 Sems) | `2026-27` | `SEM-7` | `A` | `5` | `CSE-7A` | Confirmed |
| `CSE` | B.Tech (8 Sems) | `2026-27` | `SEM-8` | `B` | `6` | `CSE-8B` | Confirmed |
| `CME` | Diploma | *Unstated* | *Unstated* | `B` | `7` | `CME-B` | **Requires HOS Confirmation** |

---

### 3.2 Dynamic Semester Model & Per-Branch/Program Configuration

#### 1. Unbounded / Dynamic Semester Pattern (`SEM-<number>`)
- The system **does NOT impose an arbitrary maximum limit of SEM-6**.
- Any valid academic term is represented as `SEM-k` ($k \ge 1$).
  - Diploma programs (e.g. State Board of Technical Education): `SEM-1` through `SEM-6`.
  - B.Tech / BTEC engineering programs: `SEM-1` through `SEM-8`.
  - Post-graduate or customized programs: can extend to `SEM-4`, `SEM-10`, etc.
- Bidirectional normalizer:
  - Input `1`, `'1'`, `'SEM-1'`, `'sem-1'`, `'Semester 1'` $\longrightarrow$ Canonical `'SEM-1'` (integer `1`).
  - Input `7`, `'7'`, `'SEM-7'`, `'VII'` $\longrightarrow$ Canonical `'SEM-7'` (integer `7`).
  - Input `8`, `'8'`, `'SEM-8'`, `'VIII'` $\longrightarrow$ Canonical `'SEM-8'` (integer `8`).
  - Input `null`, `undefined`, `''` $\longrightarrow$ returns `null` (never defaults or guesses).

#### 2. Per-Branch / Program Configuration
- Semesters are configured dynamically per branch/department:
  - In `departments` table and in-memory branch models, the following configuration is maintained:
    - `program_type`: e.g. `'diploma'`, `'btech'`, `'general'`.
    - `total_semesters`: integer (e.g., `6` for Diploma, `8` for B.Tech, or custom $N$).
    - `configured_semesters`: optional explicit array (e.g. `['SEM-1', 'SEM-2', ..., 'SEM-8']`). If omitted, automatically derived as `SEM-1` .. `SEM-N` from `total_semesters`.
- In the HOS Dashboard UI:
  - The Semester dropdown dynamically queries the branch's active semester list:
    - An HOS managing a **Diploma branch** sees: `SEM-1`, `SEM-2`, `SEM-3`, `SEM-4`, `SEM-5`, `SEM-6`.
    - An HOS managing a **B.Tech branch** sees: `SEM-1`, `SEM-2`, `SEM-3`, `SEM-4`, `SEM-5`, `SEM-6`, `SEM-7`, `SEM-8`.
  - HOS can view or adjust the branch program type / semester count in branch settings if institutional curriculum regulations change.

---

### 3.3 New Branch Creation & Dynamic Semester Configuration Model

When a new HOS signs up and registers a new branch/program during initial setup or branch registration (`/register`):

#### 1. Branch Initialized with Program / Semester Configuration:
- When creating a new branch, the branch is immediately initialized with its program type and semester configuration.
- The registration flow (`public/register.html` $\rightarrow$ `POST /api/auth/register`) captures:
  - **Branch Name**: (e.g., `Computer Science and Engineering`, `Civil Engineering`)
  - **Branch Code**: (e.g., `CSE`, `CIV`, `MECH`)
  - **Academic Year**: (e.g., `2026-27`)
  - **Program Type**: Selectable preset (`Diploma`, `B.Tech / BTEC`, or `Custom Program`)
  - **Configured Semester Count ($N$)**: Total number of semesters applicable to this branch.
- Payload format:
  ```json
  {
    "name": "Dr. Ananya Sharma",
    "phone": "9876543210",
    "username": "hos_cse",
    "password": "Secure_Password_123",
    "role": "hos",
    "branchName": "Computer Science and Engineering",
    "branchCode": "CSE",
    "academicYear": "2026-27",
    "programType": "btech",
    "totalSemesters": 8
  }
  ```
- The branch is persisted in `departments` with `program_type = 'btech'` and `total_semesters = 8`.

#### 2. Zero Global Hardcoding:
- Semesters are **never hard-coded globally** in application constants, database enum types, or shared UI arrays.
- There is no global assumption of 6 semesters or 8 semesters across the codebase.
- Each branch maintains its own semester configuration in storage and in-memory stores.

#### 3. HOS-Configured Number of Semesters:
- The HOS has explicit authority to specify/configure the number of semesters applicable to that branch/program.
- Presets provide convenient defaults (e.g., Diploma sets 6, B.Tech/BTEC sets 8), but the HOS can configure any positive integer $N$.
- The configured count is stored per branch: `departments.total_semesters = N`.

#### 4. Dynamic Provisioning of `SEM-1 ... SEM-N`:
- The system dynamically generates and provides the semester sequence:
  $$\text{Semesters} = \big[ \text{SEM-1},\ \text{SEM-2},\ \dots,\ \text{SEM-}N \big]$$
  derived directly from that branch's configured semester count.
- UI dropdowns, catalog registration APIs, timetable upload modals, and validation schemas dynamically query this sequence:
  - `GET /api/branch/semesters?branch=CSE` $\longrightarrow$ returns `['SEM-1', 'SEM-2', ..., 'SEM-8']`
  - `GET /api/branch/semesters?branch=CME` $\longrightarrow$ returns `['SEM-1', 'SEM-2', ..., 'SEM-6']`

#### 5. Concrete Program Examples:
- **Diploma Branch**:
  - `program_type`: `'diploma'`
  - `total_semesters`: `6`
  - Dynamically provides: `SEM-1`, `SEM-2`, `SEM-3`, `SEM-4`, `SEM-5`, `SEM-6`
- **B.Tech / BTEC Branch**:
  - `program_type`: `'btech'`
  - `total_semesters`: `8`
  - Dynamically provides: `SEM-1`, `SEM-2`, `SEM-3`, `SEM-4`, `SEM-5`, `SEM-6`, `SEM-7`, `SEM-8`
- **Future / Custom Program**:
  - `program_type`: `'custom'` (or e.g. `'mtech'`, `'pharmacy'`, `'architecture'`)
  - `total_semesters`: any configured $N$ (e.g. $N = 4 \implies$ `SEM-1 ... SEM-4`; $N = 10 \implies$ `SEM-1 ... SEM-10`).

#### 6. Backward Compatibility for Existing Branches & Timetables:
- Pre-existing branches (`CME`, `EEE`, `MEC`) and existing class/timetable data remain 100% backward compatible.
- Existing branches without an explicit `total_semesters` column default cleanly to their verified institutional count (`6` for existing diploma departments).
- Existing legacy class codes (`CME-A`, `CME-B`, `EEE-B`, `DEEE-B`) and all historical timetable records are preserved 100% without modification or duplication.

#### 7. Strict Branch Isolation (No Cross-Branch Interference):
- Changing one branch's semester configuration must **NOT** affect another branch.
- Example: Configuring or updating `CSE` to have `total_semesters = 8` has zero impact on `CME` (`total_semesters = 6`) or `EEE` (`total_semesters = 6`).
- Each branch's semester list, classes, and timetables are completely isolated and independent.

#### 8. Branch/Program-Scoped Semester Architecture:
- Semester configuration is strictly **branch/program scoped**:
  - **Database Persistence**: Stored in `departments(id, code, name, academic_year, program_type, total_semesters)`.
  - **In-Memory Store**: Stored in `state.source.departments` with individual `{ code, programType, totalSemesters }`.
  - **APIs**: Lookups and mutations are scoped to the branch (`GET /api/branch/semesters?branch=...`, `PUT /api/branch/program`).
  - **UI**: Dashboard controls automatically query and render the active HOS's branch semester configuration.

---

### 3.4 Safe Backward-Compatible Migration Strategy for Legacy Class Codes

#### Critical Safety Rules:
1. **Preserve `classes.code` Exactly**: Do **NOT** rename, reformat, or delete existing legacy class codes (`CME-A`, `CME-B`, `EEE-B`, `DEEE-B`).
2. **Preserve `class_id`**: The internal primary key `classes.id` remains completely unchanged.
3. **Preserve All Existing Timetable Rows**: Not a single row in `timetable` is rewritten, duplicated, or deleted during migration.
4. **Zero Guessing / Zero Silent Assumptions**:
   - Do **NOT** automatically assign a semester to an existing legacy class merely because it has a legacy code such as `CME-A`, `CME-B`, `EEE-B`, or `DEEE-B`.
   - Do **NOT** silently assume `SEM-1` or `SEM-5`.
   - The migration must determine semester and academic year **only from reliable existing project data** (e.g. existing non-null columns in `classes.semester`, `classes.academic_year`, or explicit declared metadata in `demoTimetable.js`).
5. **Handling Unresolved / Incomplete Legacy Data**:
   - If the existing project data does not contain enough information to determine the semester or academic year, leave the new field **`NULL` / unresolved** where the schema permits.
   - Mark the class record with `needs_scoping_confirmation = true`.
   - In the HOS dashboard, an informational notice alerts the HOS: *"Class [Code] requires semester and academic year confirmation before new timetable uploads or imports can target it."*
   - Until confirmed by the HOS, legacy classes remain accessible for reading existing timetable slots via their legacy `classes.code` (e.g. `GET /api/timetable?class=CME-A`), ensuring zero breakage for existing views, historical queries, and test assertions.

#### Source Data Verification (Reliable vs Unresolved Data):
- **Reliable Data in Bundled Fixtures (`src/data/demoTimetable.js`)**:
  - `CME-A`: explicitly declares `academicYear: "2026-27"` and `semester: 5` $\longrightarrow$ reliably mapped to `SEM-5` and `2026-27`.
  - `EEE-B`: explicitly declares `academicYear: "2025-2026"` and `semester: 4` $\longrightarrow$ reliably mapped to `SEM-4` and `2025-2026`.
  - `MEC-A`: explicitly declares `academicYear: "2026-27"` and `semester: 5` $\longrightarrow$ reliably mapped to `SEM-5` and `2026-27`.
  - Section extraction: only if `code` clearly ends with a standard section delimiter (e.g. `CME-A` $\longrightarrow$ section `'A'`); otherwise left `NULL` for HOS confirmation.
- **Unresolved / Unstated Database Records**:
  - Any custom or imported database class where `semester IS NULL` or `academic_year IS NULL` is **NOT assigned a default value**.
  - It remains `NULL` with `needs_scoping_confirmation = true` until the branch HOS explicitly confirms the scoping in the UI or via API.

#### Gemini Entity Resolution & B2.5 Staging Safety:
- `entityResolver.js` resolves extracted text against `classes.code` first (exact match against legacy codes like `DEEE-B` or `CME-A`).
- If a class has both `code` and confirmed discrete scope fields `(branch, academic_year, semester, section)`, resolution can match on either identifier without friction.
- Existing tests (`staging_approval.test.js`, `mastertimetable.test.js`, `api.test.js`) continue to pass 100% because `classes.code` and `class_id` remain intact.

---

### 3.5 Independent Scoped Timetable Operations
Each operation is strictly isolated by the 4-tuple $\langle\text{Branch/Program}, \text{Academic Year}, \text{Semester}, \text{Section}\rangle$ (mapped to `class_id`):

1. **Viewing Timetables**:
   - HOS selects **Semester** (from branch's dynamic list: `SEM-1` .. `SEM-N`) and **Section** (`A`, `B` ..).
   - System resolves the unique `class_id` for that combination and renders its specific weekly grid.
2. **Uploading / Replacing a Timetable**:
   - HOS specifies the target Semester (e.g. `SEM-7` for B.Tech or `SEM-2` for Diploma) and Section (`A`) for the upload.
   - When the staged timetable is approved, `REPLACE_CLASS` executes:
     ```sql
     DELETE FROM timetable WHERE class_id = :target_class_id;
     ```
   - **Zero Impact on Other Classes**: Timetables for other semesters, other sections, and other branches/programs are 100% untouched.
3. **Archiving / Clearing a Timetable**:
   - HOS can explicitly click *"Clear / Archive Timetable"* for the currently selected semester/section.
   - Operates strictly on the selected `class_id`.
   - Timetable slots for that specific semester/section are cleared, while historical upload and staging records remain in `timetable_uploads` and `timetable_staging` for historical auditability.

---

## 4. Required Changes for Cross-Branch Availability with Priority (Update 3)

### 4.1 Functional Objectives
1. **Cross-Branch Evaluation**:
   - When an HOS requests substitution cover for an absent faculty member at `(day, period)`:
     - **Home Branch Candidates**: Evaluates all active faculty belonging to the absent faculty's branch.
     - **Other Branch Candidates**: Evaluates all active faculty belonging to other registered branches in the institution (e.g. EEE, ECE, MEC, CSE).
2. **Two-Tier Priority Stratification**:
   - **Priority 1 — Same Branch (Home Branch)**:
     - Free faculty who share the absent member's department.
     - Preferred for course curriculum familiarity and departmental alignment.
   - **Priority 2 — Other Registered Branches**:
     - Free faculty from other branches who have no teaching commitments at that `day + period`.
     - Grouped or tagged by their respective branch (e.g., `[EEE] Prof. C. Rao`).
3. **Hard Conflict Guarantee**:
   - Priority never overrides a timetable conflict.
   - If a faculty member from another branch has a scheduled class in their own branch (or in any shared facility) at that day/period, they are marked **BUSY** and excluded from the free list.
4. **Manual Decision Workflow**:
   - The system displays the prioritized list with clear visual distinctions.
   - The HOS manually reviews the list and selects a candidate.
   - **No automated assignments**: The system does not write to the live timetable without explicit HOS submission.
   - **No AI substitute selection**: Strict algorithmic evaluation based on verifiable calendar availability.

### 4.2 Algorithm Design
```
Function getPrioritizedAvailability(day, period, targetBranch, absentFacultyName):
    1. Resolve slotKey = day + "|" + period
    2. Retrieve all active faculty members across all registered branches:
       activeFaculty = faculty.filter(f => f.status === 'active')
    3. Identify absent faculty's department = targetBranch
    4. For each faculty member 'f' in activeFaculty:
       a. If f.name == absentFacultyName: SKIP
       b. Check if 'f' has any busyRecord at (day, period) across all loaded class timetables:
          isBusy = exists(busyRecords where faculty == f.name and day == day and period == period)
       c. If isBusy: Mark as BUSY (record for conflict audit)
       d. Else (f is FREE):
          If f.department == targetBranch:
              Add 'f' to Priority_1_SameBranch
          Else:
              Add 'f' to Priority_2_OtherBranches
    5. Sort Priority_1 by name (or teaching load)
    6. Sort Priority_2 by department, then name
    7. Return {
          day, period, targetBranch,
          priority1: Priority_1_SameBranch,
          priority2: Priority_2_OtherBranches,
          totalAvailable: Priority_1.length + Priority_2.length,
          busy: Busy_Faculty_List
       }
```

---

## 5. Database Changes (PostgreSQL Schema)

All schema changes are additive, backward-compatible, and guarded with `IF NOT EXISTS` / idempotent blocks:

```sql
-- 1. Departments Table: Program Type & Configurable Semesters
ALTER TABLE departments ADD COLUMN IF NOT EXISTS program_type TEXT DEFAULT 'diploma';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS total_semesters INTEGER DEFAULT 6;

-- 2. Classes Table Enhancements (Discrete Scope Fields)
ALTER TABLE classes ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS needs_scoping_confirmation BOOLEAN NOT NULL DEFAULT false;

-- Safe data migration: Only infer section where an explicit delimiter exists in code
UPDATE classes 
   SET section = UPPER(SUBSTRING(code FROM '[- ]([A-Za-z])$'))
 WHERE section IS NULL AND code ~ '[- ][A-Za-z]$';

-- For any class where semester or academic_year is missing, flag for HOS confirmation (do NOT guess!)
UPDATE classes
   SET needs_scoping_confirmation = true
 WHERE semester IS NULL OR academic_year IS NULL OR section IS NULL;

-- Authoritative composite unique constraint: branch + academic_year + semester + section
-- Only enforced when all 4 discrete scope fields are present and non-null
CREATE UNIQUE INDEX IF NOT EXISTS classes_authoritative_scope_unique
    ON classes (department_id, academic_year, semester, UPPER(section))
    WHERE department_id IS NOT NULL AND academic_year IS NOT NULL AND semester IS NOT NULL AND section IS NOT NULL;

-- 3. Faculty Table Enhancements
CREATE INDEX IF NOT EXISTS faculty_status_idx ON faculty (status);
CREATE INDEX IF NOT EXISTS faculty_dept_status_idx ON faculty (department_id, status);

-- 4. Users Table Status Support
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_status_check
            CHECK (status IN ('active', 'inactive'));
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
```

---

## 6. API Changes

### 6.1 Faculty Management Endpoints

| Method | Endpoint | Auth / Role | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/faculty` | HOS / Faculty | Returns faculty list. Supports `?status=active`, `?status=all`, `?department=CME`. Excludes inactive faculty by default from public views. |
| `GET` | `/api/faculty/:id` | HOS | Returns detailed profile of a specific faculty member (including subjects and active status). |
| `PUT` | `/api/faculty/:id` | HOS (Own Branch) | Updates faculty name, phone, subjects, designation, max weekly periods. |
| `POST` | `/api/faculty/:id/deactivate` | HOS (Own Branch) | Sets faculty `status = 'inactive'`, disables user login, preserves historical timetable data. |
| `POST` | `/api/faculty/:id/activate` | HOS (Own Branch) | Restores faculty `status = 'active'`, re-enabling them for new scheduling. |

### 6.2 Multi-Semester & Section Timetable Endpoints

| Method | Endpoint | Auth / Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Public / HOS | Enhanced HOS registration: accepts `programType` (`diploma`, `btech`, `custom`) and `totalSemesters` ($N$). Initializes branch with dynamic semester range `SEM-1..SEM-N`. |
| `GET` | `/api/branch/semesters` | All | Returns active branch's configured semester list (e.g. `SEM-1` .. `SEM-6` for Diploma or `SEM-1` .. `SEM-8` for B.Tech). |
| `PUT` | `/api/branch/program` | HOS (Own Branch) | Updates branch program type (`diploma`, `btech`, `custom`) and total semesters ($N$). |
| `GET` | `/api/catalog/classes` | HOS / Faculty | Lists all classes for branch with discrete fields: `class_id`, `code`, `branch`, `academic_year`, `semester` (`SEM-1`), `section`, `needs_scoping_confirmation`. |
| `POST` | `/api/catalog/classes` | HOS (Own Branch) | Registers a new class/section with body: `{ semester: 'SEM-7', section: 'B', academicYear: '2026-27' }`. Generates internal `class_id`. |
| `PUT` | `/api/catalog/classes/:classId/confirm-scoping` | HOS (Own Branch) | Allows HOS to explicitly set or confirm `academic_year`, `semester` (`SEM-k`), and `section` for a legacy class. Clears `needs_scoping_confirmation`. |
| `GET` | `/api/timetable` | HOS / Faculty | Query options:<br>1. Legacy: `?class=CME-A`<br>2. Scoped: `?semester=SEM-1&section=A&academic_year=2026-27`<br>3. By ID: `?class_id=1` |
| `DELETE` | `/api/timetable/class/:classId` | HOS (Own Branch) | Clears all timetable slots for the specified `class_id`. Scoped delete leaves all other semesters/sections/branches untouched. |

### 6.3 Cross-Branch Prioritized Availability Endpoints

| Method | Endpoint | Auth / Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/availability/prioritized` | HOS | Body: `{ day, period, absentFaculty, department }`. Returns two-tier prioritized free faculty: `priority1` (same branch) and `priority2` (other registered branches). |
| `POST` | `/api/availability` | All | Enhanced response: retains `available` for backward compatibility, while appending `priority1` and `priority2` sections. |

---

## 7. Frontend UI Changes

### 7.1 HOS Registration UI (`public/register.html`)
1. **Branch Program & Semester Controls**:
   - In the HOS registration section, alongside Branch Name and Branch Code:
     - **Program Type Dropdown / Radios**:
       - `Diploma (6 Semesters)` $\longrightarrow$ sets total semesters to 6.
       - `B.Tech / BTEC Engineering (8 Semesters)` $\longrightarrow$ sets total semesters to 8.
       - `Custom / Other Program` $\longrightarrow$ displays numeric input for total semesters.
     - **Total Semesters Input**: Configurable integer (defaults based on program type).
   - On submission, initializes the branch with its discrete semester count.

### 7.2 Faculty Management UI (`#view-faculty`)
1. **Actions Column in Faculty Directory Table**:
   - Added to directory table header and row items.
   - Action buttons: `[Edit Details]` and `[Deactivate]` (or `[Reactivate]` if already inactive).
2. **Edit Faculty Modal**:
   - Accessible from the Edit button on each row.
   - Form fields: Name, Phone, Designation dropdown, Comma-separated Subjects.
   - Submits `PUT /api/faculty/:id` and refreshes directory without full page reload.
3. **Deactivation Confirmation Dialog**:
   - Explicit confirmation warning: *"Deactivating will remove [Name] from availability checks and substitution candidate lists. All historical timetable entries and past substitutions are safely preserved."*

### 7.3 Multi-Semester & Section Controls (`#view-timetable`)
1. **Dynamic Dual Selectors**:
   - **Semester Selector**: Dropdown dynamically populated from branch configuration (e.g. `SEM-1` to `SEM-6` for Diploma, `SEM-1` to `SEM-8` for B.Tech).
   - **Section Selector**: Dropdown showing available sections (`Section A`, `Section B`, etc.).
   - Selecting a semester and section immediately displays the authoritative scope badge:  
     $$\text{Branch} \cdot \text{Academic Year} \cdot \text{SEM-}k \cdot \text{Section}$$
   - If an active class has `needs_scoping_confirmation: true`, a yellow alert chip appears: *"Requires Scope Confirmation"* with an easy one-click modal for HOS to confirm the semester and section.
2. **Class-Scoped Actions**:
   - `[Upload Timetable]` button: Opens upload modal pre-scoped to the active Semester (`SEM-1` .. `SEM-N`) and Section (`A`).
   - `[Clear / Archive Schedule]` button: Triggers modal to delete slots only for the active `class_id`.

### 7.4 Prioritized Substitution UI (`#view-substitute` & Availability Card)
1. **Two-Tier Results Panel**:
   - **Section 1: Priority 1 — Same Branch Candidates (`<BRANCH>`)**
     - Renders free faculty cards from the home branch with phone numbers and subject expertise.
   - **Section 2: Priority 2 — Other Registered Branches**
     - Renders free faculty cards from other branches with clear branch badges (e.g. `[EEE] Prof. C. Rao`).
2. **Candidate Selection & Contact Sheet**:
   - Clicking a candidate displays a summary card: *"Selected Substitute: [Name] ([Branch]) for [Day] P[Period]"*.
   - Includes manual contact helper and action button to record the substitution.

---

## 8. Security & Branch Isolation Rules

1. **Strict Write Isolation**:
   - An HOS can only create, edit, or deactivate faculty belonging to their authenticated `session.department`.
   - An HOS can only upload, replace, or clear timetables belonging to classes registered under their authenticated `session.department`.
   - An HOS can only modify the program/semester configuration of their own branch.
2. **Safe Read Visibility**:
   - For regular timetable viewing, branch isolation remains enforced.
   - For **substitution availability only**, cross-branch reading of **free periods** is permitted strictly to find available cover. Other branches' private faculty notes or personal credentials remain completely inaccessible.
3. **No Foreign Password Leaks**:
   - Cross-branch availability returns only `name`, `department`, `phone`, and `status = 'FREE'`. Password hashes, user account IDs, and auth tokens are never exposed.

---

## 9. Backward Compatibility Considerations

1. **Legacy Class Codes Preserved**:
   - `CME-A`, `CME-B`, `EEE-B`, and `DEEE-B` remain valid and accessible by their original names.
   - Legacy routes like `GET /api/timetable?class=CME-A` continue to return the expected class grid.
2. **Zero Data Duplication & Zero Guessing**:
   - Existing timetable entries keep their existing `class_id`. No duplicate records are created.
   - Semesters/academic years are never fabricated or guessed during migration.
3. **Existing Branches & Test Suites**:
   - Existing single-branch tests, database tests, and B2.5 staging approval tests that use `CME-A` or `DEEE-B` continue to pass without modification.

---

## 10. Comprehensive Test Matrix

| Category | Test Suite File | Test Scenarios |
| :--- | :--- | :--- |
| **Faculty Management** | `tests/faculty_management.test.js` | 1. HOS creates faculty with subjects & designation.<br>2. HOS edits faculty details (name, phone, subjects).<br>3. Cross-branch edit attempt rejected with HTTP 403.<br>4. Safe deactivation sets `status: 'inactive'`.<br>5. Inactive faculty excluded from `GET /api/availability`.<br>6. Inactive faculty cannot be assigned new substitutions.<br>7. Reactivation restores faculty to availability. |
| **Branch Creation & Semesters** | `tests/branch_semesters.test.js` | 1. Register new Diploma HOS: verify `total_semesters = 6` generates `SEM-1` .. `SEM-6`.<br>2. Register new B.Tech HOS: verify `total_semesters = 8` generates `SEM-1` .. `SEM-8`.<br>3. Verify branch semester isolation: changing B.Tech semester does not alter Diploma semester range.<br>4. Custom program registration: verify custom $N$ (e.g. 4) generates `SEM-1` .. `SEM-4`. |
| **Multi-Semester Timetables** | `tests/multisemester_timetable.test.js` | 1. Verify discrete scoping fields: branch, academic_year, semester (`SEM-1` .. `SEM-8`), section (`A`, `B`), `class_id`.<br>2. Legacy codes (`CME-A`, `CME-B`, `EEE-B`) preserve `classes.code` and `class_id` without guessing missing semesters.<br>3. Upload and approve timetable for CME SEM-1 Section A.<br>4. Upload and approve timetable for B.Tech CSE SEM-7 Section A.<br>5. Verify CME SEM-1 slots are not affected by other uploads.<br>6. Scoped clear: deleting CME SEM-1 Section A deletes only that `class_id`'s slots.<br>7. Cross-branch isolation: EEE HOS cannot delete CME timetable. |
| **Cross-Branch Availability** | `tests/crossbranch_availability.test.js` | 1. CME faculty absent at Monday P3.<br>2. Priority 1 returns free CME faculty.<br>3. Priority 2 returns free EEE/MEC faculty.<br>4. EEE faculty who is busy at Monday P3 is strictly excluded from Priority 2.<br>5. Inactive faculty from any branch is strictly excluded.<br>6. Timetable conflicts strictly take precedence over priority. |
| **Regression Suite** | `tests/run.js` | All 19 existing test suites (`accounts`, `singlebranch`, `mastertimetable`, `staging_approval`, etc.) must pass with 0 failures. |

---

## 11. End-to-End Verification Plan

1. **Live Server HOS Faculty Flow**:
   - Launch server on test port.
   - Log in as CME HOS.
   - Create faculty `Prof. X` (CME, Subjects: "AI, ML").
   - Edit `Prof. X` phone number and designation.
   - Deactivate `Prof. X`.
   - Query availability for a period: verify `Prof. X` is omitted.
2. **Live Server Dynamic Branch Registration & Multi-Semester Flow**:
   - Register new B.Tech HOS (`CSE`, `programType: 'btech'`, `totalSemesters: 8`).
   - Verify semester dropdown dynamically offers `SEM-1` through `SEM-8`.
   - Log in as existing Diploma CME HOS: verify semester dropdown offers `SEM-1` through `SEM-6`.
   - Select Semester `SEM-7`, Section `A` on B.Tech branch: verify timetable grid loads.
   - Populate `SEM-7` Section `A`: verify lower semester slot counts are unchanged.
   - Clear `SEM-7` Section `A`: verify other semesters remain intact.
3. **Live Server Cross-Branch Availability Flow**:
   - Log in as CME HOS.
   - Mark a CME faculty absent on Wednesday P2.
   - Verify UI displays:
     - Priority 1: Free CME faculty.
     - Priority 2: Free EEE and MEC faculty with clear branch labels.
   - Check that busy faculty from other branches do not appear in either list.

---

## 12. Risks & Edge Cases

1. **Cross-Branch Scheduling Clashes**:
   - *Risk*: A faculty member teaching in EEE might be assigned in CME at the same slot.
   - *Mitigation*: The availability engine verifies all classes across all branches before designating any faculty member as free.
2. **Historical Orphan Records**:
   - *Risk*: Hard-deleting faculty would cause `FOREIGN KEY` constraint violations or cascade-delete past attendance/substitutions.
   - *Mitigation*: Strictly enforce **safe deactivation** (`status = 'inactive'`). Deletion is prohibited on faculty with historical associations.
3. **Unresolved Legacy Scope Handling**:
   - *Risk*: An unconfirmed legacy class might cause ambiguous queries if multiple sections exist.
   - *Mitigation*: Unresolved classes are explicitly flagged with `needs_scoping_confirmation = true`, while maintaining legacy code lookup (`classes.code = 'CME-A'`) as the deterministic fallback.
4. **Program Semester Count Discrepancies**:
   - *Risk*: A B.Tech class uploaded with `SEM-7` might be rejected if a hard-coded 6-semester cap existed.
   - *Mitigation*: Dynamic per-branch semester configuration completely eliminates hard-coded upper limits.

---

## 13. Boundaries: What Should NOT Be Changed

1. **Do NOT use combined canonical class identifiers**: Do not synthesize strings like `CME-S1-A` or `EEE-S4-B`. Use discrete fields: `branch/program`, `academic_year`, `semester` (`SEM-<number>`), `section` (`A`), and internal `class_id`.
2. **Do NOT hard-code semester limits**: Do not restrict semesters to `SEM-1..SEM-6`. Semesters are dynamic and configured per branch/program (e.g. up to `SEM-8` for B.Tech).
3. **Do NOT delete or blindly rename legacy class codes**: Existing codes (`CME-A`, `CME-B`, `EEE-B`, `DEEE-B`) must remain intact and functional.
4. **Do NOT guess semester or academic year during migration**: If existing records do not have verified semester/year data, leave fields `NULL` and flag for HOS confirmation.
5. **Do NOT alter existing authentication logic**: scrypt hashing, password validation policy (`authSecurity.js`), and session cookies remain untouched.
6. **Do NOT alter the Gemini multimodal vision extraction pipeline**: `geminiExtractor.js`, `geminiPrompt.js`, and `extractionPipeline.js` remain intact.
7. **Do NOT alter B2 staging and JSON contract validation**: `contractValidator.js` and the canonical B2.1 JSON schema remain the source of truth.
8. **Do NOT automate substitute assignment**: The availability engine remains pure and read-only. Final substitution assignments require explicit manual HOS confirmation.
9. **Do NOT use AI for substitute selection**: Priority sorting and candidate filtering remain 100% deterministic and rule-based.

---

*Plan updated and recorded in `docs/PHASE_B6_FACULTY_TIMETABLE_UPDATES_PLAN.md`. No application code modified. No git commits created.*
