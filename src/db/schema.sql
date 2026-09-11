-- TecSubstitution — PostgreSQL schema (Neon compatible).
--
-- Every statement is IF NOT EXISTS / idempotent: running this file against an
-- already-initialized database is a no-op, so startup can apply it every time.
--
-- The no-double-booking rules the validator enforces in memory are also
-- enforced here as UNIQUE constraints, so a bad row cannot reach the database
-- even if it is inserted by something other than this application.

CREATE TABLE IF NOT EXISTS departments (
    id          SERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL
);

ALTER TABLE departments ADD COLUMN IF NOT EXISTS academic_year TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS semester INTEGER;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS total_semesters INTEGER NOT NULL DEFAULT 6;

CREATE TABLE IF NOT EXISTS rooms (
    id          SERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT,
    room_type   TEXT NOT NULL DEFAULT 'classroom'
                CHECK (room_type IN ('classroom', 'lab')),
    capacity    INTEGER
);

CREATE TABLE IF NOT EXISTS faculty (
    id            SERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL UNIQUE,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    email         TEXT
);

-- Faculty profile fields, added after the first release. ADD COLUMN IF NOT
-- EXISTS upgrades an existing database in place: no table is dropped and no
-- row is rewritten, so installed data survives the upgrade untouched.
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS max_weekly_periods INTEGER;
ALTER TABLE faculty ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
    -- Guarded because a repeat ALTER ... ADD CONSTRAINT is an error, and
    -- ADD CONSTRAINT IF NOT EXISTS does not exist for CHECK constraints.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'faculty_status_check') THEN
        ALTER TABLE faculty ADD CONSTRAINT faculty_status_check
            CHECK (status IN ('active', 'on_leave', 'inactive'));
    END IF;
END $$;

-- Two faculty must not share an email address when one is given.
CREATE UNIQUE INDEX IF NOT EXISTS faculty_email_unique
    ON faculty (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS subjects (
    id            SERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    subject_type  TEXT NOT NULL DEFAULT 'theory'
                  CHECK (subject_type IN ('theory', 'lab'))
);

-- Real timetables carry non-teaching periods too — library, counselling, TPC.
-- They are neither theory nor lab, so the original two-value constraint made a
-- genuine timetable impossible to store. Widening it is idempotent: the
-- constraint is replaced by name, and re-running this file is a no-op.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subjects_subject_type_check') THEN
        ALTER TABLE subjects DROP CONSTRAINT subjects_subject_type_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subjects_type_check') THEN
        ALTER TABLE subjects ADD CONSTRAINT subjects_type_check
            CHECK (subject_type IN ('theory', 'lab', 'activity'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS classes (
    id            SERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    semester      INTEGER,
    home_room_id  INTEGER REFERENCES rooms(id) ON DELETE SET NULL
);

-- The academic year a class belongs to, shown alongside its semester.
ALTER TABLE classes ADD COLUMN IF NOT EXISTS academic_year TEXT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS section TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS classes_dept_year_sem_sec_idx
    ON classes (department_id, academic_year, semester, section)
    WHERE academic_year IS NOT NULL AND semester IS NOT NULL AND section IS NOT NULL;

-- Period definitions (start/end times shown in the grid header).
CREATE TABLE IF NOT EXISTS periods (
    period      INTEGER PRIMARY KEY,
    start_time  TEXT,
    end_time    TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'faculty'
                  CHECK (role IN ('coordinator', 'hos', 'admin', 'faculty')),
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    faculty_id    INTEGER REFERENCES faculty(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An account can be deactivated without being deleted, so who-did-what stays
-- readable after a branch is archived.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Heads of section manage one branch each. Replacing the check by name keeps
-- this idempotent; the original two-role constraint predates the role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_allowed') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_allowed
            CHECK (role IN ('coordinator', 'hos', 'faculty'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS timetable (
    id            SERIAL PRIMARY KEY,
    class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    day_of_week   TEXT NOT NULL
                  CHECK (day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
    period        INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
    subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    faculty_id    INTEGER REFERENCES faculty(id) ON DELETE RESTRICT,
    room_id       INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    session_type  TEXT NOT NULL DEFAULT 'theory'
                  CHECK (session_type IN ('theory', 'lab', 'activity')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One class sits in exactly one place at a time.
    CONSTRAINT timetable_class_slot_unique UNIQUE (class_id, day_of_week, period)
);

-- A faculty member cannot teach two classes at once (only when faculty is assigned).
CREATE UNIQUE INDEX IF NOT EXISTS timetable_faculty_slot_unique
    ON timetable (faculty_id, day_of_week, period)
    WHERE faculty_id IS NOT NULL;

-- A real timetable has periods with no teacher and no theory/lab character:
-- library, counselling, TPC. They still occupy the class's slot, so they are
-- stored rather than dropped. Both migrations are idempotent — DROP NOT NULL
-- on an already-nullable column is a no-op, and the check is replaced by name.
ALTER TABLE timetable ALTER COLUMN faculty_id DROP NOT NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'timetable_session_type_check') THEN
        ALTER TABLE timetable DROP CONSTRAINT timetable_session_type_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'timetable_type_check') THEN
        ALTER TABLE timetable ADD CONSTRAINT timetable_type_check
            CHECK (session_type IN ('theory', 'lab', 'activity'));
    END IF;
END $$;

-- A room cannot host two classes at once. Partial index rather than a UNIQUE
-- constraint so rows with no room (room_id IS NULL) stay allowed.
CREATE UNIQUE INDEX IF NOT EXISTS timetable_room_slot_unique
    ON timetable (room_id, day_of_week, period)
    WHERE room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS timetable_slot_idx ON timetable (day_of_week, period);
CREATE INDEX IF NOT EXISTS timetable_faculty_idx ON timetable (faculty_id);

-- Substitution log. Recorded only when a coordinator explicitly saves one; the
-- availability lookup never writes here.
CREATE TABLE IF NOT EXISTS substitutions (
    id                     SERIAL PRIMARY KEY,
    timetable_id           INTEGER NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
    absent_faculty_id      INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    substitute_faculty_id  INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
    day_of_week            TEXT NOT NULL,
    period                 INTEGER NOT NULL,
    date                   DATE NOT NULL,
    notes                  TEXT,
    status                 TEXT NOT NULL DEFAULT 'completed'
                           CHECK (status IN ('pending', 'completed', 'cancelled')),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migrations for existing installations
ALTER TABLE departments ADD COLUMN IF NOT EXISTS academic_year TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS semester INTEGER;
ALTER TABLE timetable ALTER COLUMN faculty_id DROP NOT NULL;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'timetable_session_type_check') THEN
        ALTER TABLE timetable DROP CONSTRAINT timetable_session_type_check;
    END IF;
    ALTER TABLE timetable ADD CONSTRAINT timetable_session_type_check
        CHECK (session_type IN ('theory', 'lab', 'activity'));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS attendance (
    id            SERIAL PRIMARY KEY,
    timetable_id  INTEGER NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
    on_date       DATE NOT NULL,
    status        TEXT NOT NULL
                  CHECK (status IN ('held', 'not_held', 'substituted')),
    marked_by     TEXT,
    marked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attendance_slot_unique UNIQUE (timetable_id, on_date)
);

-- Real account-based schema columns and faculty expertise
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_status_check
            CHECK (status IN ('active', 'inactive'));
    END IF;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;


CREATE TABLE IF NOT EXISTS faculty_subjects (
    id         SERIAL PRIMARY KEY,
    faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    subject    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT faculty_subject_unique UNIQUE (faculty_id, subject)
);

-- Timetable Uploads metadata table (Phase B1)
CREATE TABLE IF NOT EXISTS timetable_uploads (
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
    status             TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED', 'PROCESSING', 'PROCESSED', 'FAILED')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timetable_uploads_branch_idx ON timetable_uploads (department_code);
CREATE INDEX IF NOT EXISTS timetable_uploads_faculty_idx ON timetable_uploads (faculty_id);
CREATE INDEX IF NOT EXISTS timetable_uploads_status_idx ON timetable_uploads (status);

CREATE TABLE IF NOT EXISTS timetable_staging (
    id                 SERIAL PRIMARY KEY,
    upload_id          TEXT NOT NULL UNIQUE REFERENCES timetable_uploads(upload_id) ON DELETE CASCADE,
    extracted_json     JSONB,
    validation_status  TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (validation_status IN ('PENDING', 'VALID', 'INVALID')),
    validation_errors  JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timetable_staging_upload_idx ON timetable_staging (upload_id);
CREATE INDEX IF NOT EXISTS timetable_staging_status_idx ON timetable_staging (validation_status);

-- Phase B2.5 Staging review, approval & audit fields
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS import_status TEXT NOT NULL DEFAULT 'STAGED';
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS imported_count INTEGER;
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS unresolved_entities JSONB;
ALTER TABLE timetable_staging ADD COLUMN IF NOT EXISTS entity_mappings JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'timetable_staging_import_status_check') THEN
        ALTER TABLE timetable_staging ADD CONSTRAINT timetable_staging_import_status_check
            CHECK (import_status IN ('STAGED', 'APPROVED', 'REJECTED', 'IMPORTED'));
    END IF;
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;
-- Phase B7.1 Faculty Registration Requests
CREATE TABLE IF NOT EXISTS faculty_registration_requests (
    id                 SERIAL PRIMARY KEY,
    full_name          TEXT NOT NULL,
    phone              TEXT NOT NULL,
    username           TEXT NOT NULL,
    password_hash      TEXT NOT NULL,
    designation        TEXT,
    subjects           TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    branch_code        TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    rejection_reason   TEXT,
    reviewed_by        TEXT,
    reviewed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faculty_reg_req_branch_idx ON faculty_registration_requests (branch_code);
CREATE INDEX IF NOT EXISTS faculty_reg_req_status_idx ON faculty_registration_requests (status);
CREATE INDEX IF NOT EXISTS faculty_reg_req_username_idx ON faculty_registration_requests (LOWER(username));

-- Phase B7.2 Faculty Attendance / Absence
CREATE TABLE IF NOT EXISTS faculty_attendance (
    id                 SERIAL PRIMARY KEY,
    faculty_id         INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    attendance_date    DATE NOT NULL,
    status             TEXT NOT NULL DEFAULT 'ABSENT'
                       CHECK (status IN ('PRESENT', 'ABSENT')),
    marked_by          TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT faculty_attendance_unique UNIQUE (faculty_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS faculty_attendance_date_idx ON faculty_attendance (attendance_date);
CREATE INDEX IF NOT EXISTS faculty_attendance_faculty_idx ON faculty_attendance (faculty_id);

-- Phase B7.3 Exam Invigilation Requests (Faculty-submitted)
CREATE TABLE IF NOT EXISTS exam_invigilation_requests (
    id                 SERIAL PRIMARY KEY,
    faculty_id         INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    branch_code        TEXT NOT NULL,
    exam_date          DATE NOT NULL,
    periods            INTEGER[] NOT NULL,
    reason             TEXT,
    status             TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    reviewed_by        TEXT,
    reviewed_at        TIMESTAMPTZ,
    rejection_reason   TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exam_invig_req_faculty_idx ON exam_invigilation_requests (faculty_id);
CREATE INDEX IF NOT EXISTS exam_invig_req_branch_idx ON exam_invigilation_requests (branch_code);
CREATE INDEX IF NOT EXISTS exam_invig_req_status_idx ON exam_invigilation_requests (status);
CREATE INDEX IF NOT EXISTS exam_invig_req_date_idx ON exam_invigilation_requests (exam_date);

-- Phase B7.3 Active Exam Invigilation Assignments
CREATE TABLE IF NOT EXISTS exam_invigilation (
    id                 SERIAL PRIMARY KEY,
    faculty_id         INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    branch_code        TEXT NOT NULL,
    exam_date          DATE NOT NULL,
    period             INTEGER NOT NULL,
    source             TEXT NOT NULL DEFAULT 'DIRECT'
                       CHECK (source IN ('DIRECT', 'REQUEST')),
    request_id         INTEGER REFERENCES exam_invigilation_requests(id) ON DELETE SET NULL,
    assigned_by        TEXT,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT exam_invigilation_unique UNIQUE (faculty_id, exam_date, period)
);

CREATE INDEX IF NOT EXISTS exam_invig_date_period_idx ON exam_invigilation (exam_date, period);
CREATE INDEX IF NOT EXISTS exam_invig_faculty_idx ON exam_invigilation (faculty_id);
CREATE INDEX IF NOT EXISTS exam_invig_branch_idx ON exam_invigilation (branch_code);

-- Phase B7.5 Faculty-to-Faculty Substitutions
CREATE TABLE IF NOT EXISTS faculty_substitutions (
    id                      TEXT PRIMARY KEY,
    date                    DATE NOT NULL,
    day_of_week             TEXT NOT NULL,
    period                  INTEGER NOT NULL,
    class_name              TEXT,
    subject                 TEXT,
    room                    TEXT,
    original_faculty_id     INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    original_faculty_name   TEXT NOT NULL,
    original_faculty_branch TEXT NOT NULL,
    substitute_faculty_id   INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    substitute_faculty_name TEXT NOT NULL,
    substitute_faculty_branch TEXT NOT NULL,
    requested_by            TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    rejection_reason        TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at            TIMESTAMPTZ,
    cancelled_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS faculty_sub_orig_idx ON faculty_substitutions (original_faculty_id);
CREATE INDEX IF NOT EXISTS faculty_sub_subst_idx ON faculty_substitutions (substitute_faculty_id);
CREATE INDEX IF NOT EXISTS faculty_sub_date_period_idx ON faculty_substitutions (date, period);
CREATE INDEX IF NOT EXISTS faculty_sub_status_idx ON faculty_substitutions (status);
CREATE INDEX IF NOT EXISTS faculty_sub_branch_idx ON faculty_substitutions (original_faculty_branch);

-- ======================================================================
-- Branch normalization: the final active set is CME, EEE and MEC.
--
-- Everything below is idempotent and NON-DESTRUCTIVE. No table is dropped, no
-- timetable row is deleted and no faculty record is duplicated: "EE" and "EEE"
-- are two spellings of one real branch, so its records are re-pointed at the
-- single EEE department and the leftover empty EE row is removed. ECE is
-- ARCHIVED, not deleted — its faculty, classes, subjects and timetable rows
-- stay exactly where they are and simply stop being an application.
-- ======================================================================

-- An ACTIVE branch is an application someone can sign in to. Archiving is how a
-- branch leaves the application without its history leaving the database.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
DECLARE
    ee_id  INTEGER;
    eee_id INTEGER;
BEGIN
    SELECT id INTO ee_id  FROM departments WHERE UPPER(code) = 'EE';
    SELECT id INTO eee_id FROM departments WHERE UPPER(code) = 'EEE';

    IF ee_id IS NOT NULL AND eee_id IS NULL THEN
        -- Only the old spelling exists: rename it in place. Every faculty,
        -- subject, class and timetable row keeps its foreign key, so nothing
        -- moves and nothing can be lost.
        UPDATE departments
           SET code = 'EEE', name = 'Electrical and Electronics Engineering'
         WHERE id = ee_id;

    ELSIF ee_id IS NOT NULL AND eee_id IS NOT NULL THEN
        -- Both spellings exist and are the same real branch. Re-point the
        -- children at EEE, then drop the department row that is now empty.
        -- Faculty names, subject codes and class codes are all UNIQUE, so
        -- re-pointing can never create a second identity for one person.
        UPDATE faculty  SET department_id = eee_id WHERE department_id = ee_id;
        UPDATE subjects SET department_id = eee_id WHERE department_id = ee_id;
        UPDATE classes  SET department_id = eee_id WHERE department_id = ee_id;
        DELETE FROM departments WHERE id = ee_id;
    END IF;
END $$;

-- The class and lab room named after the old spelling. Renamed only when the
-- new name is free, so a database that already carries EEE-A is left alone.
UPDATE classes SET code = 'EEE-A'
 WHERE code = 'EE-A' AND NOT EXISTS (SELECT 1 FROM classes WHERE code = 'EEE-A');

UPDATE rooms SET code = 'EEE-LAB-1'
 WHERE code = 'EE-LAB-1' AND NOT EXISTS (SELECT 1 FROM rooms WHERE code = 'EEE-LAB-1');

-- ECE is archived: kept in full, but no longer an application. Re-running this
-- is a no-op, and a coordinator can reverse it with a single UPDATE.
UPDATE departments SET active = FALSE WHERE UPPER(code) = 'ECE' AND active;

-- Accounts belonging to an archived branch cannot sign in. The rows are kept
-- so the history of who did what stays readable.
UPDATE users SET active = FALSE
  FROM faculty f, departments d
 WHERE users.faculty_id = f.id
   AND f.department_id = d.id
   AND d.active = FALSE
   AND users.active;

-- ======================================================================
-- Data provenance.
--
-- Records where a class's timetable actually came from, so a placeholder week
-- can never be mistaken for a real one on screen or in an API response.
--
--   'real'        transcribed from a timetable someone supplied, or entered
--                 through the application by a person
--   'placeholder' bundled demo data, present so the branch structure works
--                 before the real timetable arrives
--
-- The default is 'real' because anything a person creates through the app is
-- real; the seeder marks the classes it inserts from the bundled dataset.
-- ======================================================================
ALTER TABLE classes ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'real';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_data_source_check') THEN
        ALTER TABLE classes ADD CONSTRAINT classes_data_source_check
            CHECK (data_source IN ('real', 'placeholder'));
    END IF;
END $$;
