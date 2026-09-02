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
                  CHECK (role IN ('coordinator', 'faculty')),
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
    faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT,
    room_id       INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    session_type  TEXT NOT NULL DEFAULT 'theory'
                  CHECK (session_type IN ('theory', 'lab')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One class sits in exactly one place at a time.
    CONSTRAINT timetable_class_slot_unique UNIQUE (class_id, day_of_week, period),
    -- A faculty member cannot teach two classes at once.
    CONSTRAINT timetable_faculty_slot_unique UNIQUE (faculty_id, day_of_week, period)
);

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
    on_date                DATE NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed', 'confirmed', 'cancelled')),
    note                   TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT substitutions_slot_unique UNIQUE (timetable_id, on_date)
);

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
