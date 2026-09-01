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
