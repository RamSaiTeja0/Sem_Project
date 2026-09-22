/**
 * Timetable repository — every SQL statement the application runs.
 *
 * `loadSource()` returns the SAME source shape the bundled demo module exports,
 * so the normalizer, validator, availability engine, API and UI are identical
 * whether the data came from PostgreSQL or from the in-memory fallback. That is
 * the whole point of the seam described in src/data/store.js.
 *
 * Writes go through addEntry/updateEntry/deleteEntry, which validate against
 * the live data first and are then protected a second time by the UNIQUE
 * constraints in schema.sql.
 */
const db = require('./pool');
const { getBranch, setBranch } = require('../data/departments');

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Is there anything in the database yet? Drives "seed only when empty". */
async function isEmpty() {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM timetable');
    return rows[0].n === 0;
}

async function counts() {
    const { rows } = await db.query(`
        SELECT
            (SELECT COUNT(*)::int FROM departments)   AS departments,
            (SELECT COUNT(*)::int FROM faculty)       AS faculty,
            (SELECT COUNT(*)::int FROM classes)       AS classes,
            (SELECT COUNT(*)::int FROM subjects)      AS subjects,
            (SELECT COUNT(*)::int FROM rooms)         AS rooms,
            (SELECT COUNT(*)::int FROM timetable)     AS timetable,
            (SELECT COUNT(*)::int FROM users)         AS users,
            (SELECT COUNT(*)::int FROM substitutions) AS substitutions,
            (SELECT COUNT(*)::int FROM attendance)    AS attendance,
            (SELECT COUNT(*)::int FROM faculty_attendance) AS faculty_attendance,
            (SELECT COUNT(*)::int FROM exam_invigilation)  AS exam_invigilation,
            (SELECT COUNT(*)::int FROM faculty_substitutions) AS faculty_substitutions,
            (SELECT COUNT(*)::int FROM faculty_registration_requests) AS faculty_registration_requests
    `);
    return rows[0];
}

/**
 * Read the whole timetable back as a normalizer source (shape B: per-class
 * grids). Consecutive periods of the same subject/faculty/room collapse into a
 * spanTo block so a 3-period lab renders as one cell, matching the demo module.
 */
async function loadSource(meta) {
    const [facultyRows, classRows, entryRows, periodRows, roomRows, subjectRows, deptRows] = await Promise.all([
        db.query(`SELECT f.id, f.code, f.name, COALESCE(d.code, 'General') AS department,
                         f.designation, f.email, f.phone, f.max_weekly_periods, f.status,
                         COALESCE((SELECT array_agg(subject) FROM faculty_subjects WHERE faculty_id = f.id), ARRAY[]::text[]) AS subjects
                    FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
                   ORDER BY f.code`),
        db.query(`SELECT c.code, c.semester, c.academic_year, c.data_source,
                         COALESCE(d.code, 'General') AS department, r.code AS room
                    FROM classes c
                    LEFT JOIN departments d ON d.id = c.department_id
                    LEFT JOIN rooms r ON r.id = c.home_room_id
                   ORDER BY c.code`),
        db.query(`SELECT t.id, c.code AS class_code, t.day_of_week, t.period,
                         s.name AS subject, f.name AS faculty, r.code AS room, t.session_type
                    FROM timetable t
                    JOIN classes c ON c.id = t.class_id
                    JOIN subjects s ON s.id = t.subject_id
                    LEFT JOIN faculty f ON f.id = t.faculty_id
                    LEFT JOIN rooms r ON r.id = t.room_id`),
        db.query('SELECT period, start_time, end_time FROM periods ORDER BY period'),
        db.query('SELECT code, name, room_type, capacity FROM rooms ORDER BY code'),
        db.query(`SELECT s.code, s.name, s.subject_type, COALESCE(d.code, 'General') AS department
                    FROM subjects s LEFT JOIN departments d ON d.id = s.department_id
                   ORDER BY s.code`),
        db.query('SELECT code, name, active FROM departments ORDER BY code')
    ]);

    const days = [...new Set(entryRows.rows.map(r => r.day_of_week))]
        .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    const periods = periodRows.rows.length
        ? periodRows.rows.map(r => r.period)
        : [...new Set(entryRows.rows.map(r => r.period))].sort((a, b) => a - b);

    const periodTimings = {};
    periodRows.rows.forEach(r => {
        periodTimings[String(r.period)] = { start: r.start_time, end: r.end_time };
    });

    const classes = classRows.rows.map(cls => {
        const rows = {};
        (days.length ? days : DAY_ORDER).forEach(day => {
            const cells = entryRows.rows
                .filter(e => e.class_code === cls.code && e.day_of_week === day)
                .sort((a, b) => a.period - b.period);

            const out = [];
            let i = 0;
            while (i < cells.length) {
                const cell = cells[i];
                let end = cell.period;
                let j = i + 1;
                while (j < cells.length &&
                       cells[j].subject === cell.subject &&
                       cells[j].faculty === cell.faculty &&
                       cells[j].room === cell.room &&
                       cells[j].period === end + 1) { end = cells[j].period; j++; }

                const entry = { period: cell.period };
                if (end !== cell.period) entry.spanTo = end;
                entry.subject = cell.subject;
                entry.faculty = cell.faculty;
                entry.room = cell.room;
                entry.type = cell.session_type;
                out.push(entry);
                i = j;
            }
            if (out.length) rows[day] = out;
        });
        return {
            class: cls.code,
            department: cls.department,
            semester: cls.semester,
            academicYear: cls.academic_year,
            room: cls.room,
            dataSource: cls.data_source || 'real',
            rows
        };
    });

    const base = meta || {};
    return {
        meta: {
            institution: base.institution || 'Institute of Engineering & Technology',
            title: base.title || 'Working Timetable',
            primaryClass: base.primaryClass && classes.some(c => c.class === base.primaryClass)
                ? base.primaryClass
                : (classes[0] && classes[0].class) || null,
            days: days.length ? days : (base.days || DAY_ORDER.slice(0, 5)),
            periods: periods.length ? periods : (base.periods || [1, 2, 3, 4, 5, 6, 7]),
            periodTimings: Object.keys(periodTimings).length ? periodTimings : (base.periodTimings || {})
        },
        departments: deptRows.rows.map(d => ({ code: d.code, name: d.name, active: d.active !== false })),
        rooms: roomRows.rows.map(r => ({ code: r.code, name: r.name, type: r.room_type, capacity: r.capacity })),
        subjects: subjectRows.rows.map(s => ({
            code: s.code, name: s.name, department: s.department, type: s.subject_type
        })),
        faculty: facultyRows.rows.map(f => ({
            id: f.code,
            name: f.name,
            department: f.department,
            designation: f.designation,
            email: f.email,
            phone: f.phone,
            subjects: f.subjects || [],
            maxWeeklyPeriods: f.max_weekly_periods,
            status: f.status
        })),
        classes
    };
}

// --------------------------------------------------------------- lookups

async function lookupId(client, table, column, value) {
    const { rows } = await client.query(
        `SELECT id FROM ${table} WHERE UPPER(${column}) = UPPER($1) LIMIT 1`, [value]);
    return rows.length ? rows[0].id : null;
}

/** Resolve the names an entry refers to into row ids, reporting what is missing. */
async function resolveRefs(client, entry) {
    // Sequential, not Promise.all: a single pg client runs one query at a time.
    const className = entry.className || entry.class;
    const classId = await lookupId(client, 'classes', 'code', className);
    const subjectId = await lookupId(client, 'subjects', 'name', entry.subject);
    const facultyId = entry.faculty ? await lookupId(client, 'faculty', 'name', entry.faculty) : null;
    const roomId = entry.room ? await lookupId(client, 'rooms', 'code', entry.room) : null;

    const missing = [];
    if (!classId) missing.push(`class "${className || 'unspecified'}"`);
    if (!subjectId) missing.push(`subject "${entry.subject}"`);
    if (entry.faculty && !facultyId) missing.push(`faculty "${entry.faculty}"`);
    if (entry.room && !roomId) missing.push(`room "${entry.room}"`);

    return { classId, subjectId, facultyId, roomId, missing };
}

/** Shape one joined timetable row the way the API returns it. */
const ENTRY_SELECT = `
    SELECT t.id, c.code AS "className", t.day_of_week AS day, t.period,
           s.name AS subject, f.name AS faculty, r.code AS room,
           t.session_type AS type
      FROM timetable t
      JOIN classes c ON c.id = t.class_id
      JOIN subjects s ON s.id = t.subject_id
      LEFT JOIN faculty f ON f.id = t.faculty_id
      LEFT JOIN rooms r ON r.id = t.room_id`;

async function listEntries(filters = {}) {
    const where = [];
    const params = [];
    if (filters.className) { params.push(filters.className); where.push(`c.code = $${params.length}`); }
    if (filters.day) { params.push(filters.day); where.push(`t.day_of_week = $${params.length}`); }
    if (filters.period) { params.push(filters.period); where.push(`t.period = $${params.length}`); }
    if (filters.faculty) { params.push(filters.faculty); where.push(`f.name = $${params.length}`); }

    const sql = ENTRY_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY c.code, t.day_of_week, t.period';
    const { rows } = await db.query(sql, params);
    return rows;
}

/**
 * @param id       timetable row id
 * @param client   optional open transaction client. Reading an uncommitted
 *                 INSERT through the pool would return nothing, so a write
 *                 must pass its own client here.
 */
async function getEntry(id, client) {
    const runner = client || db;
    const { rows } = await runner.query(ENTRY_SELECT + ' WHERE t.id = $1', [id]);
    return rows[0] || null;
}

/**
 * What already occupies this slot, ignoring `excludeId` (the row being edited).
 * Returns the conflicts as plain objects so the caller can report all of them
 * at once rather than surfacing whichever constraint the database hit first.
 */
async function findSlotConflicts(client, { classId, facultyId, roomId, day, period, excludeId }) {
    const params = [day, period, classId, facultyId || null, roomId || null, excludeId || 0];
    const { rows } = await client.query(`
        SELECT t.id,
               t.class_id = $3   AS class_clash,
               ($4::int IS NOT NULL AND t.faculty_id = $4) AS faculty_clash,
               ($5::int IS NOT NULL AND t.room_id = $5) AS room_clash,
               c.code AS "className", f.name AS faculty, r.code AS room, s.name AS subject
          FROM timetable t
          JOIN classes c ON c.id = t.class_id
          LEFT JOIN faculty f ON f.id = t.faculty_id
          JOIN subjects s ON s.id = t.subject_id
          LEFT JOIN rooms r ON r.id = t.room_id
         WHERE t.day_of_week = $1 AND t.period = $2 AND t.id <> $6
           AND (t.class_id = $3 OR ($4::int IS NOT NULL AND t.faculty_id = $4) OR ($5::int IS NOT NULL AND t.room_id = $5))
    `, params);

    return rows.map(row => {
        if (row.class_clash) {
            return { code: 'CLASS_BUSY', message: `${row.className} already has ${row.subject} at ${day} P${period}` };
        }
        if (row.faculty_clash) {
            return { code: 'FACULTY_BUSY', message: `${row.faculty} already teaches ${row.subject} (${row.className}) at ${day} P${period}` };
        }
        return { code: 'ROOM_BUSY', message: `Room ${row.room} is already used by ${row.className} at ${day} P${period}` };
    });
}

/** Raised for anything the caller can fix by changing the request. */
function badRequest(message, code, details) {
    const error = new Error(message);
    error.code = code;
    error.status = 400;
    if (details) error.details = details;
    return error;
}

async function addEntry(entry) {
    return db.withTransaction(async client => {
        const refs = await resolveRefs(client, entry);
        if (refs.missing.length) {
            throw badRequest(`Unknown ${refs.missing.join(', ')}`, 'UNKNOWN_REFERENCE', refs.missing);
        }
        const conflicts = await findSlotConflicts(client, {
            classId: refs.classId, facultyId: refs.facultyId, roomId: refs.roomId,
            day: entry.day, period: entry.period
        });
        if (conflicts.length) {
            throw badRequest(conflicts.map(c => c.message).join('; '), 'SLOT_CONFLICT', conflicts);
        }
        const { rows } = await client.query(`
            INSERT INTO timetable (class_id, day_of_week, period, subject_id, faculty_id, room_id, session_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [refs.classId, entry.day, entry.period, refs.subjectId, refs.facultyId, refs.roomId, entry.type]);
        return getEntry(rows[0].id, client);
    });
}

/**
 * Write a whole set of entries for ONE faculty member, in a single transaction.
 *
 * This is the structured-upload path: a faculty member submitting their own
 * week, and later the same shape arriving from an automated extractor. It is
 * all-or-nothing — one bad row rejects the upload rather than leaving a
 * half-written timetable behind.
 *
 * `mode: 'replace'` clears that faculty member's existing periods first, so an
 * upload is a statement of their whole week rather than an append. It only ever
 * touches rows whose faculty_id is this person: a colleague's periods, and the
 * class's other periods taught by someone else, are never removed.
 *
 * @param {string} facultyName  resolved from the session by the caller, never
 *                              from the request body
 */
async function replaceFacultyEntries(facultyName, entries, options = {}) {
    const mode = options.mode === 'replace' ? 'replace' : 'merge';

    return db.withTransaction(async client => {
        const facultyId = await lookupId(client, 'faculty', 'name', facultyName);
        if (!facultyId) {
            throw badRequest(`Unknown faculty "${facultyName}"`, 'UNKNOWN_REFERENCE',
                [`faculty "${facultyName}"`]);
        }

        let removed = 0;
        if (mode === 'replace') {
            const cleared = await client.query(
                'DELETE FROM timetable WHERE faculty_id = $1 RETURNING id', [facultyId]);
            removed = cleared.rowCount;
        }

        const written = [];
        for (const entry of entries) {
            const refs = await resolveRefs(client, { ...entry, faculty: facultyName });
            if (refs.missing.length) {
                throw badRequest(
                    `${entry.day} P${entry.period}: unknown ${refs.missing.join(', ')}`,
                    'UNKNOWN_REFERENCE', refs.missing);
            }
            const conflicts = await findSlotConflicts(client, {
                classId: refs.classId, facultyId: refs.facultyId, roomId: refs.roomId,
                day: entry.day, period: entry.period
            });
            if (conflicts.length) {
                throw badRequest(
                    `${entry.day} P${entry.period}: ${conflicts.map(c => c.message).join('; ')}`,
                    'SLOT_CONFLICT', conflicts);
            }
            const { rows } = await client.query(`
                INSERT INTO timetable (class_id, day_of_week, period, subject_id, faculty_id, room_id, session_type)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [refs.classId, entry.day, entry.period, refs.subjectId, facultyId,
                 refs.roomId, entry.type]);
            written.push(rows[0].id);
        }

        const saved = [];
        for (const id of written) saved.push(await getEntry(id, client));
        return { mode, removed, created: saved.length, entries: saved };
    });
}

async function updateEntry(id, entry) {
    return db.withTransaction(async client => {
        const existing = await client.query('SELECT id FROM timetable WHERE id = $1', [id]);
        if (!existing.rows.length) {
            const err = new Error(`No timetable entry with id ${id}`);
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }
        const refs = await resolveRefs(client, entry);
        if (refs.missing.length) {
            throw badRequest(`Unknown ${refs.missing.join(', ')}`, 'UNKNOWN_REFERENCE', refs.missing);
        }
        const conflicts = await findSlotConflicts(client, {
            classId: refs.classId, facultyId: refs.facultyId, roomId: refs.roomId,
            day: entry.day, period: entry.period, excludeId: id
        });
        if (conflicts.length) {
            throw badRequest(conflicts.map(c => c.message).join('; '), 'SLOT_CONFLICT', conflicts);
        }
        await client.query(`
            UPDATE timetable
               SET class_id = $1, day_of_week = $2, period = $3, subject_id = $4,
                   faculty_id = $5, room_id = $6, session_type = $7
             WHERE id = $8`,
            [refs.classId, entry.day, entry.period, refs.subjectId, refs.facultyId,
             refs.roomId, entry.type, id]);
        return getEntry(id, client);
    });
}

async function deleteEntry(id) {
    const { rows } = await db.query(
        'DELETE FROM timetable WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
}

// ------------------------------------------------- reference-data listings

async function listRooms() {
    const { rows } = await db.query(
        'SELECT code, name, room_type AS type, capacity FROM rooms ORDER BY code');
    return rows;
}

async function listSubjects() {
    const { rows } = await db.query(`
        SELECT s.code, s.name, s.subject_type AS type, COALESCE(d.code, 'General') AS department
          FROM subjects s LEFT JOIN departments d ON d.id = s.department_id
         ORDER BY s.name`);
    return rows;
}

async function listClasses() {
    const { rows } = await db.query(`
        SELECT c.id, c.code, c.semester, c.academic_year AS "academicYear",
               c.section, COALESCE(d.code, 'General') AS department, r.code AS room,
               c.data_source AS "dataSource"
          FROM classes c
          LEFT JOIN departments d ON d.id = c.department_id
          LEFT JOIN rooms r ON r.id = c.home_room_id
         ORDER BY c.code`);
    return rows.map(r => {
        let sec = r.section;
        if (!sec && r.code) {
            const m = r.code.match(/-([A-Za-z0-9])$/);
            if (m) sec = m[1].toUpperCase();
        }
        return {
            ...r,
            section: sec || null
        };
    });
}

async function listDepartments() {
    const branch = getBranch();
    try {
        const queryText = branch.code
            ? `SELECT d.code, d.name, d.academic_year AS "academicYear", d.semester,
                      COALESCE(d.total_semesters, 6) AS "totalSemesters",
                      COALESCE(d.active, true) AS active,
                      COUNT(f.id)::int AS "facultyCount"
                 FROM departments d
                 LEFT JOIN faculty f ON f.department_id = d.id
                WHERE UPPER(d.code) = UPPER($1)
                GROUP BY d.code, d.name, d.academic_year, d.semester, d.total_semesters, d.active
                ORDER BY d.code`
            : `SELECT d.code, d.name, d.academic_year AS "academicYear", d.semester,
                      COALESCE(d.total_semesters, 6) AS "totalSemesters",
                      COALESCE(d.active, true) AS active,
                      COUNT(f.id)::int AS "facultyCount"
                 FROM departments d
                 LEFT JOIN faculty f ON f.department_id = d.id
                GROUP BY d.code, d.name, d.academic_year, d.semester, d.total_semesters, d.active
                ORDER BY d.code`;
        const params = branch.code ? [branch.code] : [];
        const { rows } = await db.query(queryText, params);
        if (rows.length) return rows;
    } catch (err) {
        // Return default if query fails
    }
    if (branch.code) {
        return [{
            code: branch.code,
            name: branch.name,
            academicYear: branch.academicYear,
            semester: branch.semester,
            totalSemesters: branch.totalSemesters || 6,
            active: true,
            facultyCount: 0
        }];
    }
    return [];
}

async function getInstanceBranch(branchCode = null) {
    const branch = getBranch(branchCode);
    try {
        const lookupCode = branch.code || branchCode;
        if (!lookupCode) return { ...branch, facultyCount: 0 };
        const { rows } = await db.query(`
            SELECT d.code, d.name, d.academic_year AS "academicYear", d.semester,
                   COALESCE(d.total_semesters, 6) AS "totalSemesters",
                   COUNT(f.id)::int AS "facultyCount"
              FROM departments d
              LEFT JOIN faculty f ON f.department_id = d.id
             WHERE UPPER(d.code) = UPPER($1)
             GROUP BY d.code, d.name, d.academic_year, d.semester, d.total_semesters`, [lookupCode]);
        if (rows.length) {
            return {
                code: rows[0].code,
                name: rows[0].name,
                academicYear: rows[0].academicYear || branch.academicYear,
                semester: rows[0].semester != null ? rows[0].semester : branch.semester,
                totalSemesters: rows[0].totalSemesters != null ? rows[0].totalSemesters : (branch.totalSemesters || 6),
                facultyCount: rows[0].facultyCount || 0
            };
        }
    } catch (err) {
        // Fall back to in-memory branch
    }
    return { ...branch, facultyCount: 0 };
}

async function updateInstanceBranch(changes = {}) {
    const branch = getBranch();
    const newCode = changes.code ? String(changes.code).trim().toUpperCase() : branch.code;
    const newName = changes.name ? String(changes.name).trim() : branch.name;
    const newYear = changes.academicYear ? String(changes.academicYear).trim() : branch.academicYear;
    const newSem = changes.semester != null && !isNaN(parseInt(changes.semester, 10))
        ? parseInt(changes.semester, 10) : branch.semester;
    const newTotalSemesters = changes.totalSemesters != null && !isNaN(parseInt(changes.totalSemesters, 10))
        ? parseInt(changes.totalSemesters, 10) : (branch.totalSemesters || 6);

    return db.withTransaction(async client => {
        const { rows } = await client.query(`
            INSERT INTO departments (code, name, academic_year, semester, total_semesters)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (code) DO UPDATE SET
                name = EXCLUDED.name,
                academic_year = EXCLUDED.academic_year,
                semester = EXCLUDED.semester,
                total_semesters = EXCLUDED.total_semesters
            RETURNING code, name, academic_year AS "academicYear", semester, total_semesters AS "totalSemesters"`,
            [newCode, newName, newYear, newSem, newTotalSemesters]
        );
        setBranch({ code: newCode, name: newName, academicYear: newYear, semester: newSem, totalSemesters: newTotalSemesters });
        return rows[0];
    });
}

/* ======================================================================
 * Catalog writes — branches, subjects and classes.
 *
 * A branch (department) is an academic programme such as CSE. A class is a
 * section inside it, such as CSE-A. They are separate records and the API
 * keeps them separate.
 *
 * Deletes are refused while anything still references the record, so removing
 * a branch can never orphan its subjects, classes or faculty.
 * ====================================================================== */

function conflict(message, code, status) {
    const error = new Error(message);
    error.code = code || 'CONFLICT';
    error.status = status || 409;
    return error;
}

/** Look up a department id by code, throwing a clear 400 when it is unknown. */
async function departmentId(client, code) {
    const { rows } = await client.query(
        'SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [code]);
    if (!rows.length) throw conflict(`Unknown branch "${code}"`, 'UNKNOWN_DEPARTMENT', 400);
    return rows[0].id;
}

async function addDepartment(branch) {
    return db.withTransaction(async client => {
        const problems = [];

        const byCode = await client.query(
            'SELECT 1 FROM departments WHERE UPPER(code) = UPPER($1)', [branch.code]);
        if (byCode.rows.length) problems.push(`Branch code "${branch.code}" already exists`);

        const byName = await client.query(
            'SELECT 1 FROM departments WHERE UPPER(name) = UPPER($1)', [branch.name]);
        if (byName.rows.length) problems.push(`A branch named "${branch.name}" already exists`);

        if (problems.length) {
            const error = conflict(problems.join('; '), 'DUPLICATE_DEPARTMENT');
            error.details = problems;
            throw error;
        }

        const { rows } = await client.query(
            'INSERT INTO departments (code, name) VALUES (UPPER($1), $2) RETURNING code, name',
            [branch.code, branch.name]);
        return { ...rows[0], facultyCount: 0 };
    });
}

async function updateDepartment(code, changes) {
    return db.withTransaction(async client => {
        const id = await departmentId(client, code);
        if (changes.name) {
            const clash = await client.query(
                'SELECT 1 FROM departments WHERE UPPER(name) = UPPER($1) AND id <> $2',
                [changes.name, id]);
            if (clash.rows.length) {
                throw conflict(`A branch named "${changes.name}" already exists`, 'DUPLICATE_DEPARTMENT');
            }
        }
        const { rows } = await client.query(
            'UPDATE departments SET name = COALESCE($2, name) WHERE id = $1 RETURNING code, name',
            [id, changes.name || null]);
        return rows[0];
    });
}

/** Remove a branch, but only once nothing else points at it. */
async function deleteDepartment(code) {
    return db.withTransaction(async client => {
        const id = await departmentId(client, code);

        const counts = await client.query(`
            SELECT (SELECT COUNT(*) FROM faculty  WHERE department_id = $1)::int AS faculty,
                   (SELECT COUNT(*) FROM subjects WHERE department_id = $1)::int AS subjects,
                   (SELECT COUNT(*) FROM classes  WHERE department_id = $1)::int AS classes`, [id]);
        const { faculty, subjects, classes } = counts.rows[0];

        if (faculty || subjects || classes) {
            const parts = [];
            if (faculty) parts.push(`${faculty} faculty`);
            if (subjects) parts.push(`${subjects} subject(s)`);
            if (classes) parts.push(`${classes} class(es)`);
            throw conflict(
                `Branch "${code}" still has ${parts.join(', ')}. Remove or reassign them first.`,
                'DEPARTMENT_IN_USE');
        }

        await client.query('DELETE FROM departments WHERE id = $1', [id]);
        return { code };
    });
}

async function addSubject(subject) {
    return db.withTransaction(async client => {
        const problems = [];

        const byCode = await client.query(
            'SELECT 1 FROM subjects WHERE UPPER(code) = UPPER($1)', [subject.code]);
        if (byCode.rows.length) problems.push(`Subject code "${subject.code}" already exists`);

        // A subject name is unique within its branch, not globally: two branches
        // may each legitimately teach "Data Structures".
        const deptRow = await client.query(
            'SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [subject.department]);
        if (!deptRow.rows.length) {
            problems.push(`Unknown branch "${subject.department}"`);
        } else {
            const byName = await client.query(
                'SELECT 1 FROM subjects WHERE UPPER(name) = UPPER($1) AND department_id = $2',
                [subject.name, deptRow.rows[0].id]);
            if (byName.rows.length) {
                problems.push(`"${subject.name}" already exists in ${subject.department}`);
            }
        }

        if (problems.length) {
            const error = conflict(problems.join('; '), 'DUPLICATE_SUBJECT');
            error.details = problems;
            throw error;
        }

        const { rows } = await client.query(`
            INSERT INTO subjects (code, name, department_id, subject_type)
            VALUES (UPPER($1), $2, $3, $4)
            RETURNING code, name, subject_type AS type`,
            [subject.code, subject.name, deptRow.rows[0].id, subject.type || 'theory']);
        return { ...rows[0], department: String(subject.department).toUpperCase() };
    });
}

async function updateSubject(code, changes) {
    return db.withTransaction(async client => {
        const found = await client.query(
            'SELECT id FROM subjects WHERE UPPER(code) = UPPER($1)', [code]);
        if (!found.rows.length) throw conflict(`Unknown subject "${code}"`, 'NOT_FOUND', 404);
        const id = found.rows[0].id;

        const deptId = changes.department ? await departmentId(client, changes.department) : null;

        const { rows } = await client.query(`
            UPDATE subjects
               SET name = COALESCE($2, name),
                   subject_type = COALESCE($3, subject_type),
                   department_id = COALESCE($4, department_id)
             WHERE id = $1
            RETURNING code, name, subject_type AS type,
                      (SELECT COALESCE(code, 'General') FROM departments WHERE id = subjects.department_id) AS department`,
            [id, changes.name || null, changes.type || null, deptId]);
        return rows[0];
    });
}

async function deleteSubject(code) {
    return db.withTransaction(async client => {
        const found = await client.query(
            'SELECT id FROM subjects WHERE UPPER(code) = UPPER($1)', [code]);
        if (!found.rows.length) throw conflict(`Unknown subject "${code}"`, 'NOT_FOUND', 404);
        const id = found.rows[0].id;

        const used = await client.query(
            'SELECT COUNT(*)::int AS n FROM timetable WHERE subject_id = $1', [id]);
        if (used.rows[0].n) {
            throw conflict(
                `Subject "${code}" is used by ${used.rows[0].n} timetable entry(ies). Remove them first.`,
                'SUBJECT_IN_USE');
        }

        await client.query('DELETE FROM subjects WHERE id = $1', [id]);
        return { code };
    });
}

async function addClass(section) {
    return db.withTransaction(async client => {
        const byCode = await client.query(
            'SELECT 1 FROM classes WHERE UPPER(code) = UPPER($1)', [section.code]);
        if (byCode.rows.length) {
            throw conflict(`Class "${section.code}" already exists`, 'DUPLICATE_CLASS');
        }

        const deptId = await departmentId(client, section.department);

        let roomId = null;
        if (section.room) {
            const room = await client.query(
                'SELECT id FROM rooms WHERE UPPER(code) = UPPER($1)', [section.room]);
            if (!room.rows.length) {
                throw conflict(`Unknown room "${section.room}"`, 'UNKNOWN_ROOM', 400);
            }
            roomId = room.rows[0].id;
        }

        const { rows } = await client.query(`
            INSERT INTO classes (code, department_id, semester, academic_year, home_room_id, section)
            VALUES (UPPER($1), $2, $3, $4, $5, $6)
            RETURNING id, code, semester, academic_year AS "academicYear", section`,
            [section.code, deptId, section.semester || null,
             section.academicYear || null, roomId, section.section || null]);
        return { ...rows[0], department: String(section.department).toUpperCase(), room: section.room || null };
    });
}

async function updateClass(code, changes) {
    return db.withTransaction(async client => {
        const found = await client.query(
            'SELECT id FROM classes WHERE UPPER(code) = UPPER($1)', [code]);
        if (!found.rows.length) throw conflict(`Unknown class "${code}"`, 'NOT_FOUND', 404);
        const id = found.rows[0].id;

        const deptId = changes.department ? await departmentId(client, changes.department) : null;

        const { rows } = await client.query(`
            UPDATE classes
               SET department_id = COALESCE($2, department_id),
                   semester = COALESCE($3, semester),
                   academic_year = COALESCE($4, academic_year),
                   section = COALESCE($5, section)
             WHERE id = $1
            RETURNING id, code, semester, academic_year AS "academicYear", section,
                      (SELECT COALESCE(code, 'General') FROM departments WHERE id = classes.department_id) AS department`,
            [id, deptId, changes.semester || null, changes.academicYear || null, changes.section || null]);
        return rows[0];
    });
}

async function deleteClass(code) {
    return db.withTransaction(async client => {
        const found = await client.query(
            'SELECT id FROM classes WHERE UPPER(code) = UPPER($1)', [code]);
        if (!found.rows.length) throw conflict(`Unknown class "${code}"`, 'NOT_FOUND', 404);
        const id = found.rows[0].id;

        const used = await client.query(
            'SELECT COUNT(*)::int AS n FROM timetable WHERE class_id = $1', [id]);
        if (used.rows[0].n) {
            throw conflict(
                `Class "${code}" still has ${used.rows[0].n} timetable entry(ies). Remove them first.`,
                'CLASS_IN_USE');
        }

        await client.query('DELETE FROM classes WHERE id = $1', [id]);
        return { code };
    });
}

async function resolveOrCreateClass({ branch, academicYear, semester, section }) {
    return db.withTransaction(async client => {
        const branchCode = String(branch || '').trim().toUpperCase();
        const semStr = semester ? String(semester).trim().toUpperCase() : null;
        const secStr = section ? String(section).trim().toUpperCase() : null;
        const yrStr = academicYear ? String(academicYear).trim() : null;

        // 1. Match by department + semester + section
        const q = await client.query(`
            SELECT c.id, c.code, c.semester, c.academic_year AS "academicYear", c.section,
                   d.code AS department
              FROM classes c
              JOIN departments d ON d.id = c.department_id
             WHERE UPPER(d.code) = UPPER($1)
               AND (c.semester = $2 OR ($2 IS NULL AND c.semester IS NULL))
               AND (UPPER(c.section) = UPPER($3) OR ($3 IS NULL AND c.section IS NULL))
             LIMIT 1
        `, [branchCode, semStr ? (parseInt(semStr, 10) || null) : null, secStr]);

        if (q.rows.length) {
            return q.rows[0];
        }

        // 2. Fallback check for legacy classes (e.g. CME-A) if semStr is null or matches
        if (secStr) {
            const legacyCode = `${branchCode}-${secStr}`;
            const legQ = await client.query(`
                SELECT c.id, c.code, c.semester, c.academic_year AS "academicYear", c.section,
                       d.code AS department
                  FROM classes c
                  JOIN departments d ON d.id = c.department_id
                 WHERE UPPER(d.code) = UPPER($1)
                   AND UPPER(c.code) = UPPER($2)
                 LIMIT 1
            `, [branchCode, legacyCode]);

            if (legQ.rows.length) {
                const legClass = legQ.rows[0];
                if (!semStr || String(legClass.semester) === semStr) {
                    return legClass;
                }
            }
        }

        // 3. Resolve department ID
        const deptQ = await client.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [branchCode]);
        let deptId;
        if (deptQ.rows.length) {
            deptId = deptQ.rows[0].id;
        } else {
            const newDept = await client.query(`
                INSERT INTO departments (code, name, total_semesters)
                VALUES ($1, $1, 6)
                RETURNING id
            `, [branchCode]);
            deptId = newDept.rows[0].id;
        }

        const semClean = semStr ? semStr.replace(/[^A-Za-z0-9]/g, '') : '';
        const generatedCode = `${branchCode}${semClean ? '-' + semClean : ''}${secStr ? '-' + secStr : ''}`;
        const semInt = semStr ? (parseInt(semStr, 10) || null) : null;

        const ins = await client.query(`
            INSERT INTO classes (code, department_id, semester, academic_year, section)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (code) DO UPDATE SET
                semester = COALESCE(EXCLUDED.semester, classes.semester),
                academic_year = COALESCE(EXCLUDED.academic_year, classes.academic_year),
                section = COALESCE(EXCLUDED.section, classes.section)
            RETURNING id, code, semester, academic_year AS "academicYear", section
        `, [generatedCode, deptId, semInt, yrStr, secStr]);

        return {
            ...ins.rows[0],
            department: branchCode
        };
    });
}

async function clearTimetable({ classId, className, branchCode }) {
    return db.withTransaction(async client => {
        let targetClass = null;
        if (classId) {
            const res = await client.query(`
                SELECT c.id, c.code, d.code AS department
                  FROM classes c
                  JOIN departments d ON d.id = c.department_id
                 WHERE c.id = $1
            `, [classId]);
            if (res.rows.length) targetClass = res.rows[0];
        } else if (className) {
            const res = await client.query(`
                SELECT c.id, c.code, d.code AS department
                  FROM classes c
                  JOIN departments d ON d.id = c.department_id
                 WHERE UPPER(c.code) = UPPER($1)
            `, [className]);
            if (res.rows.length) targetClass = res.rows[0];
        }

        if (!targetClass) {
            const err = new Error(`Class not found for clear timetable.`);
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        if (branchCode && targetClass.department.toUpperCase() !== branchCode.toUpperCase()) {
            const err = new Error(`Cross-branch timetable management is not allowed. Target class belongs to ${targetClass.department}, but current branch is ${branchCode}.`);
            err.code = 'FORBIDDEN';
            err.status = 403;
            throw err;
        }

        const del = await client.query(`
            DELETE FROM timetable WHERE class_id = $1
        `, [targetClass.id]);

        return {
            cleared: true,
            classId: targetClass.id,
            className: targetClass.code,
            clearedCount: del.rowCount
        };
    });
}

/**
 * Insert one faculty member.
 *
 * Uniqueness of the code and the email is checked here so both can be
 * reported together, and is guaranteed by the UNIQUE constraints regardless.
 */
async function addFaculty(member) {
    return db.withTransaction(async client => {
        const problems = [];

        const byCode = await client.query('SELECT 1 FROM faculty WHERE UPPER(code) = UPPER($1)', [member.id]);
        if (byCode.rows.length) problems.push(`Faculty ID "${member.id}" is already in use`);

        const byName = await client.query('SELECT 1 FROM faculty WHERE UPPER(name) = UPPER($1)', [member.name]);
        if (byName.rows.length) problems.push(`A faculty member named "${member.name}" already exists`);

        if (member.email) {
            const byEmail = await client.query(
                'SELECT 1 FROM faculty WHERE LOWER(email) = LOWER($1)', [member.email]);
            if (byEmail.rows.length) problems.push(`Email "${member.email}" is already in use`);
        }

        const dept = await client.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)',
            [member.department]);
        if (!dept.rows.length) problems.push(`Unknown department "${member.department}"`);

        if (problems.length) {
            const error = new Error(problems.join('; '));
            error.code = 'DUPLICATE_FACULTY';
            error.status = 409;
            error.details = problems;
            throw error;
        }

        const { rows } = await client.query(`
            INSERT INTO faculty (code, name, department_id, designation, email, phone,
                                 max_weekly_periods, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id`,
            [member.id, member.name, dept.rows[0].id, member.designation, member.email,
             member.phone, member.maxWeeklyPeriods, member.status]);

        // A sign-in account, matching how the demo directory derives one per
        // faculty member, so a new arrival can sign in like everybody else.
        await client.query(`
            INSERT INTO users (username, name, role, department_id, faculty_id)
            VALUES ($1, $2, 'faculty', $3, $4)
            ON CONFLICT (username) DO NOTHING`,
            [usernameFor(member.name), member.name, dept.rows[0].id, rows[0].id]);

        return getFaculty(rows[0].id, client);
    });
}

/** The username convention shared with src/data/users.js. */
function usernameFor(name) {
    return String(name).toLowerCase()
        .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.|\.$/g, '');
}

async function getFaculty(id, client) {
    const runner = client || db;
    const { rows } = await runner.query(`
        SELECT f.id AS numeric_id, f.code AS id, f.name, COALESCE(d.code, 'General') AS department,
               f.designation, f.email, f.phone,
               f.max_weekly_periods AS "maxWeeklyPeriods", f.status,
               COALESCE((SELECT array_agg(subject) FROM faculty_subjects WHERE faculty_id = f.id), ARRAY[]::text[]) AS subjects
          FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
         WHERE f.id::text = $1::text OR UPPER(f.code) = UPPER($1::text) OR UPPER(f.name) = UPPER($1::text)`, [String(id)]);
    return rows[0] || null;
}

async function updateFaculty(id, branchCode, updates) {
    return db.withTransaction(async client => {
        const found = await client.query(`
            SELECT f.id, f.code, f.name, f.status, COALESCE(d.code, 'General') AS department
              FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
             WHERE f.id::text = $1::text OR UPPER(f.code) = UPPER($1::text) OR UPPER(f.name) = UPPER($1::text)
        `, [String(id)]);

        if (!found.rows.length) {
            const err = new Error(`Faculty "${id}" not found.`);
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const fac = found.rows[0];
        if (branchCode && fac.department.toUpperCase() !== branchCode.toUpperCase()) {
            const err = new Error(`Cross-branch faculty management is not allowed. Faculty belongs to ${fac.department}, but current branch is ${branchCode}.`);
            err.code = 'FORBIDDEN';
            err.status = 403;
            throw err;
        }

        const newName = (updates.name && String(updates.name).trim().length >= 2) ? String(updates.name).trim() : fac.name;
        const newPhone = updates.phone !== undefined ? (updates.phone ? String(updates.phone).trim() : null) : undefined;
        const newDesignation = updates.designation !== undefined ? (updates.designation ? String(updates.designation).trim() : null) : undefined;
        const newMaxWeeklyPeriods = updates.maxWeeklyPeriods !== undefined ? parseInt(updates.maxWeeklyPeriods, 10) : undefined;

        await client.query(`
            UPDATE faculty
               SET name = COALESCE($2, name),
                   phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                   designation = CASE WHEN $5::boolean THEN $6 ELSE designation END,
                   max_weekly_periods = CASE WHEN $7::boolean THEN $8 ELSE max_weekly_periods END
             WHERE id = $1
        `, [
            fac.id,
            newName,
            newPhone !== undefined, newPhone || null,
            newDesignation !== undefined, newDesignation || null,
            newMaxWeeklyPeriods !== undefined && Number.isFinite(newMaxWeeklyPeriods), newMaxWeeklyPeriods || null
        ]);

        if (Array.isArray(updates.subjects)) {
            await client.query('DELETE FROM faculty_subjects WHERE faculty_id = $1', [fac.id]);
            const subjects = updates.subjects.map(s => String(s).trim()).filter(Boolean);
            for (const subj of subjects) {
                await client.query(`
                    INSERT INTO faculty_subjects (faculty_id, subject)
                    VALUES ($1, $2)
                    ON CONFLICT (faculty_id, subject) DO NOTHING
                `, [fac.id, subj]);
            }
        }

        await client.query(`
            UPDATE users
               SET name = $2,
                   phone = CASE WHEN $3::boolean THEN $4 ELSE phone END
             WHERE faculty_id = $1
        `, [fac.id, newName, newPhone !== undefined, newPhone || null]);

        return getFaculty(fac.id, client);
    });
}

async function deactivateFaculty(id, branchCode) {
    return db.withTransaction(async client => {
        const found = await client.query(`
            SELECT f.id, f.code, f.name, f.status, COALESCE(d.code, 'General') AS department
              FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
             WHERE f.id::text = $1::text OR UPPER(f.code) = UPPER($1::text) OR UPPER(f.name) = UPPER($1::text)
        `, [String(id)]);

        if (!found.rows.length) {
            const err = new Error(`Faculty "${id}" not found.`);
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const fac = found.rows[0];
        if (branchCode && fac.department.toUpperCase() !== branchCode.toUpperCase()) {
            const err = new Error(`Cross-branch faculty management is not allowed. Faculty belongs to ${fac.department}, but current branch is ${branchCode}.`);
            err.code = 'FORBIDDEN';
            err.status = 403;
            throw err;
        }

        await client.query(`UPDATE faculty SET status = 'inactive' WHERE id = $1`, [fac.id]);
        await client.query(`UPDATE users SET status = 'inactive' WHERE faculty_id = $1`, [fac.id]);

        return { id: fac.code, name: fac.name, department: fac.department, status: 'inactive' };
    });
}

async function activateFaculty(id, branchCode) {
    return db.withTransaction(async client => {
        const found = await client.query(`
            SELECT f.id, f.code, f.name, f.status, COALESCE(d.code, 'General') AS department
              FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
             WHERE f.id::text = $1::text OR UPPER(f.code) = UPPER($1::text) OR UPPER(f.name) = UPPER($1::text)
        `, [String(id)]);

        if (!found.rows.length) {
            const err = new Error(`Faculty "${id}" not found.`);
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const fac = found.rows[0];
        if (branchCode && fac.department.toUpperCase() !== branchCode.toUpperCase()) {
            const err = new Error(`Cross-branch faculty management is not allowed. Faculty belongs to ${fac.department}, but current branch is ${branchCode}.`);
            err.code = 'FORBIDDEN';
            err.status = 403;
            throw err;
        }

        await client.query(`UPDATE faculty SET status = 'active' WHERE id = $1`, [fac.id]);
        await client.query(`UPDATE users SET status = 'active' WHERE faculty_id = $1`, [fac.id]);

        return { id: fac.code, name: fac.name, department: fac.department, status: 'active' };
    });
}

async function importStagedTimetable({ uploadRecord, stagedContract, resolvedMap, userId }) {
    return db.withTransaction(async client => {
        const className = stagedContract.class_name;
        const targetDept = String(uploadRecord.departmentCode || '').toUpperCase();

        // 1. Lock staging row to ensure idempotency
        const stagingLock = await client.query(
            'SELECT upload_id, import_status FROM timetable_staging WHERE upload_id = $1 FOR UPDATE',
            [uploadRecord.uploadId]
        );
        if (stagingLock.rows.length && stagingLock.rows[0].import_status === 'IMPORTED') {
            const err = new Error(`Timetable "${uploadRecord.uploadId}" has already been imported.`);
            err.code = 'ALREADY_IMPORTED';
            err.status = 409;
            throw err;
        }

        // 2. Resolve class ID (class must already exist or be in resolvedMap)
        let classId = resolvedMap.class && resolvedMap.class.id;
        if (!classId) {
            const clsRes = await client.query(
                'SELECT id FROM classes WHERE UPPER(code) = UPPER($1)', [className]
            );
            if (!clsRes.rows.length) {
                const err = new Error(`Class "${className}" must be resolved or registered before import.`);
                err.code = 'UNRESOLVED_CLASS';
                err.status = 422;
                throw err;
            }
            classId = clsRes.rows[0].id;
        }

        // 3. Scoped replacement: delete prior entries for this class only
        await client.query('DELETE FROM timetable WHERE class_id = $1', [classId]);

        // 4. Expand slots & check cross-class conflicts
        let totalInserted = 0;
        const entries = stagedContract.entries || [];
        for (const entry of entries) {
            if (entry.is_free) continue;

            // Resolve subject
            const subjObj = resolvedMap.subjects && (resolvedMap.subjects[entry.subject_name] || resolvedMap.subjects[entry.subject_code]);
            let subjectId = subjObj && subjObj.id;
            if (!subjectId) {
                const sRes = await client.query(
                    'SELECT id FROM subjects WHERE UPPER(name) = UPPER($1) OR (code IS NOT NULL AND UPPER(code) = UPPER($2))',
                    [entry.subject_name, entry.subject_code || '']
                );
                if (!sRes.rows.length) {
                    const err = new Error(`Subject "${entry.subject_name}" must be resolved before import.`);
                    err.code = 'UNRESOLVED_SUBJECT';
                    err.status = 422;
                    throw err;
                }
                subjectId = sRes.rows[0].id;
            }

            // Resolve faculty (nullable for activities)
            let facultyId = null;
            if (entry.faculty_name) {
                const facObj = resolvedMap.faculty && resolvedMap.faculty[entry.faculty_name];
                facultyId = facObj && facObj.id;
                if (!facultyId) {
                    const fRes = await client.query(
                        'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) OR (code IS NOT NULL AND UPPER(code) = UPPER($1))',
                        [entry.faculty_name]
                    );
                    if (!fRes.rows.length) {
                        const err = new Error(`Faculty "${entry.faculty_name}" must be resolved before import.`);
                        err.code = 'UNRESOLVED_FACULTY';
                        err.status = 422;
                        throw err;
                    }
                    facultyId = fRes.rows[0].id;
                }
            }

            // Resolve room (nullable)
            let roomId = null;
            if (entry.room_code) {
                const rObj = resolvedMap.rooms && resolvedMap.rooms[entry.room_code];
                roomId = rObj && rObj.id;
                if (!roomId) {
                    const rRes = await client.query('SELECT id FROM rooms WHERE UPPER(code) = UPPER($1)', [entry.room_code]);
                    if (rRes.rows.length) roomId = rRes.rows[0].id;
                }
            }

            const startP = entry.period;
            const endP = entry.span_to || entry.period;

            for (let p = startP; p <= endP; p++) {
                // Conflict check: faculty busy in another class
                if (facultyId) {
                    const facClash = await client.query(`
                        SELECT t.id, c.code AS "className", f.name AS "facultyName", s.name AS "subjectName"
                          FROM timetable t
                          JOIN classes c ON c.id = t.class_id
                          JOIN faculty f ON f.id = t.faculty_id
                          JOIN subjects s ON s.id = t.subject_id
                         WHERE t.day_of_week = $1 AND t.period = $2 AND t.faculty_id = $3 AND t.class_id <> $4
                    `, [entry.day, p, facultyId, classId]);

                    if (facClash.rows.length) {
                        const row = facClash.rows[0];
                        const err = new Error(`Faculty ${row.facultyName} already teaches ${row.subjectName} (${row.className}) at ${entry.day} P${p}`);
                        err.code = 'SLOT_CONFLICT';
                        err.status = 409;
                        err.details = [{
                            code: 'FACULTY_BUSY',
                            message: err.message,
                            day: entry.day,
                            period: p,
                            faculty: row.facultyName,
                            conflictingClass: row.className
                        }];
                        throw err;
                    }
                }

                // Conflict check: room busy in another class
                if (roomId) {
                    const roomClash = await client.query(`
                        SELECT t.id, c.code AS "className", r.code AS "roomCode"
                          FROM timetable t
                          JOIN classes c ON c.id = t.class_id
                          JOIN rooms r ON r.id = t.room_id
                         WHERE t.day_of_week = $1 AND t.period = $2 AND t.room_id = $3 AND t.class_id <> $4
                    `, [entry.day, p, roomId, classId]);

                    if (roomClash.rows.length) {
                        const row = roomClash.rows[0];
                        const err = new Error(`Room ${row.roomCode} is already used by ${row.className} at ${entry.day} P${p}`);
                        err.code = 'SLOT_CONFLICT';
                        err.status = 409;
                        err.details = [{
                            code: 'ROOM_BUSY',
                            message: err.message,
                            day: entry.day,
                            period: p,
                            room: row.roomCode,
                            conflictingClass: row.className
                        }];
                        throw err;
                    }
                }

                await client.query(`
                    INSERT INTO timetable (class_id, day_of_week, period, subject_id, faculty_id, room_id, session_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [classId, entry.day, p, subjectId, facultyId, roomId, entry.session_type || 'theory']);

                totalInserted++;
            }
        }

        return { importedCount: totalInserted };
    });
}

// ------------------------------------------------ Phase B7.1 Faculty Registration Requests

async function createFacultyRequest(data) {
    const { fullName, phone, username, passwordHash, designation, subjects, branchCode } = data;
    const { rows } = await db.query(`
        INSERT INTO faculty_registration_requests
            (full_name, phone, username, password_hash, designation, subjects, branch_code, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
        RETURNING id, full_name AS "fullName", phone, username, designation, subjects,
                  branch_code AS "branchCode", status, rejection_reason AS "rejectionReason",
                  reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt", created_at AS "createdAt"
    `, [fullName, phone, username.toLowerCase(), passwordHash, designation || null, subjects || [], branchCode.toUpperCase()]);
    return rows[0];
}

async function listFacultyRequests(branchCode, status = null) {
    let sql = `
        SELECT id, full_name AS "fullName", phone, username, designation, subjects,
               branch_code AS "branchCode", status, rejection_reason AS "rejectionReason",
               reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt", created_at AS "createdAt"
          FROM faculty_registration_requests
         WHERE UPPER(branch_code) = UPPER($1)
    `;
    const params = [branchCode];
    if (status) {
        sql += ` AND status = $2`;
        params.push(status);
    }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await db.query(sql, params);
    return rows;
}

async function getFacultyRequestById(id) {
    const { rows } = await db.query(`
        SELECT id, full_name AS "fullName", phone, username, password_hash AS "passwordHash",
               designation, subjects, branch_code AS "branchCode", status,
               rejection_reason AS "rejectionReason", reviewed_by AS "reviewedBy",
               reviewed_at AS "reviewedAt", created_at AS "createdAt"
          FROM faculty_registration_requests
         WHERE id = $1
    `, [id]);
    return rows[0] || null;
}

async function updateFacultyRequestStatus(id, branchCode, status, reviewedBy, rejectionReason = null) {
    const { rows } = await db.query(`
        UPDATE faculty_registration_requests
           SET status = $1,
               reviewed_by = $2,
               reviewed_at = now(),
               rejection_reason = $3
         WHERE id = $4 AND UPPER(branch_code) = UPPER($5)
        RETURNING id, full_name AS "fullName", phone, username, designation, subjects,
                  branch_code AS "branchCode", status, rejection_reason AS "rejectionReason",
                  reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt", created_at AS "createdAt"
    `, [status, reviewedBy, rejectionReason, id, branchCode]);
    return rows[0] || null;
}

// ------------------------------------------------ Phase B7.2 Faculty Attendance / Absence

async function listFacultyAttendanceForDate(branchCode, date) {
    const { rows } = await db.query(`
        SELECT f.id, f.code, f.name, f.designation, f.phone, f.status AS "facultyStatus",
               d.code AS department,
               COALESCE(fa.status, 'PRESENT') AS status,
               fa.id AS "attendanceId",
               fa.marked_by AS "markedBy",
               fa.updated_at AS "updatedAt"
          FROM faculty f
          JOIN departments d ON f.department_id = d.id
          LEFT JOIN faculty_attendance fa
            ON fa.faculty_id = f.id AND fa.attendance_date = $2
         WHERE UPPER(d.code) = UPPER($1)
           AND f.status = 'active'
         ORDER BY f.name ASC
    `, [branchCode, date]);
    return rows;
}

async function markFacultyAttendance({ facultyId, date, status, markedBy }) {
    const { rows } = await db.query(`
        INSERT INTO faculty_attendance (faculty_id, attendance_date, status, marked_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, now(), now())
        ON CONFLICT (faculty_id, attendance_date)
        DO UPDATE SET status = EXCLUDED.status,
                      marked_by = EXCLUDED.marked_by,
                      updated_at = now()
        RETURNING id, faculty_id AS "facultyId", attendance_date AS "attendanceDate",
                  status, marked_by AS "markedBy", created_at AS "createdAt", updated_at AS "updatedAt"
    `, [facultyId, date, status, markedBy]);
    return rows[0];
}

async function deleteFacultyAttendance(id, branchCode) {
    const { rows } = await db.query(`
        DELETE FROM faculty_attendance fa
         USING faculty f, departments d
         WHERE fa.faculty_id = f.id
           AND f.department_id = d.id
           AND fa.id = $1
           AND UPPER(d.code) = UPPER($2)
        RETURNING fa.id, fa.faculty_id AS "facultyId", fa.attendance_date AS "attendanceDate", fa.status
    `, [id, branchCode]);
    return rows[0] || null;
}

async function getAbsentFacultyForDate(date) {
    const { rows } = await db.query(`
        SELECT fa.id, fa.faculty_id AS "facultyId", f.name AS "facultyName", f.code AS "facultyCode",
               d.code AS department, fa.attendance_date AS "date", fa.status
          FROM faculty_attendance fa
          JOIN faculty f ON fa.faculty_id = f.id
          JOIN departments d ON f.department_id = d.id
         WHERE fa.attendance_date = $1
           AND fa.status = 'ABSENT'
    `, [date]);
    return rows;
}

async function getFacultyAttendanceHistory(facultyId, limit = 50) {
    const { rows } = await db.query(`
        SELECT id, faculty_id AS "facultyId", attendance_date AS "date",
               status, marked_by AS "markedBy", created_at AS "createdAt", updated_at AS "updatedAt"
          FROM faculty_attendance
         WHERE faculty_id = $1
         ORDER BY attendance_date DESC
         LIMIT $2
    `, [facultyId, limit]);
    return rows;
}

// Phase B7.3 Exam Invigilation Requests & Assignments
async function createInvigilationRequest({ facultyId, branchCode, examDate, periods, reason }) {
    const { rows } = await db.query(`
        INSERT INTO exam_invigilation_requests (faculty_id, branch_code, exam_date, periods, reason, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', now(), now())
        RETURNING id, faculty_id AS "facultyId", branch_code AS "branchCode", exam_date AS "examDate",
                  periods, reason, status, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [facultyId, branchCode, examDate, periods, reason || null]);
    return rows[0];
}

async function listInvigilationRequests({ branchCode, status, facultyId } = {}) {
    let query = `
        SELECT r.id, r.faculty_id AS "facultyId", f.name AS "facultyName", f.code AS "facultyCode",
               r.branch_code AS "branchCode", r.exam_date AS "examDate", r.periods, r.reason,
               r.status, r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt",
               r.rejection_reason AS "rejectionReason", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
          FROM exam_invigilation_requests r
          JOIN faculty f ON r.faculty_id = f.id
         WHERE 1=1
    `;
    const params = [];
    if (branchCode) {
        params.push(branchCode);
        query += ` AND UPPER(r.branch_code) = UPPER($${params.length})`;
    }
    if (status) {
        params.push(status);
        query += ` AND UPPER(r.status) = UPPER($${params.length})`;
    }
    if (facultyId) {
        params.push(facultyId);
        query += ` AND r.faculty_id = $${params.length}`;
    }
    query += ` ORDER BY r.created_at DESC`;
    const { rows } = await db.query(query, params);
    return rows;
}

async function getInvigilationRequestById(id) {
    const { rows } = await db.query(`
        SELECT r.id, r.faculty_id AS "facultyId", f.name AS "facultyName", f.code AS "facultyCode",
               r.branch_code AS "branchCode", r.exam_date AS "examDate", r.periods, r.reason,
               r.status, r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt",
               r.rejection_reason AS "rejectionReason", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
          FROM exam_invigilation_requests r
          JOIN faculty f ON r.faculty_id = f.id
         WHERE r.id = $1
    `, [id]);
    return rows[0] || null;
}

async function updateInvigilationRequestStatus(id, { status, reviewedBy, rejectionReason }) {
    const { rows } = await db.query(`
        UPDATE exam_invigilation_requests
           SET status = $2,
               reviewed_by = $3,
               reviewed_at = now(),
               rejection_reason = $4,
               updated_at = now()
         WHERE id = $1
        RETURNING id, faculty_id AS "facultyId", branch_code AS "branchCode", exam_date AS "examDate",
                  periods, reason, status, reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt",
                  rejection_reason AS "rejectionReason", updated_at AS "updatedAt"
    `, [id, status, reviewedBy, rejectionReason || null]);
    return rows[0] || null;
}

async function createActiveInvigilation({ facultyId, branchCode, examDate, period, source, requestId, assignedBy, notes }) {
    const { rows } = await db.query(`
        INSERT INTO exam_invigilation (faculty_id, branch_code, exam_date, period, source, request_id, assigned_by, notes, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
        RETURNING id, faculty_id AS "facultyId", branch_code AS "branchCode", exam_date AS "examDate",
                  period, source, request_id AS "requestId", assigned_by AS "assignedBy", notes,
                  created_at AS "createdAt", updated_at AS "updatedAt"
    `, [facultyId, branchCode, examDate, period, source || 'DIRECT', requestId || null, assignedBy || null, notes || null]);
    return rows[0];
}

async function listActiveInvigilation({ branchCode, examDate, period, facultyId } = {}) {
    let query = `
        SELECT ei.id, ei.faculty_id AS "facultyId", f.name AS "facultyName", f.code AS "facultyCode",
               ei.branch_code AS "branchCode", ei.exam_date AS "examDate", ei.period,
               ei.source, ei.request_id AS "requestId", ei.assigned_by AS "assignedBy",
               ei.notes, ei.created_at AS "createdAt", ei.updated_at AS "updatedAt"
          FROM exam_invigilation ei
          JOIN faculty f ON ei.faculty_id = f.id
         WHERE 1=1
    `;
    const params = [];
    if (branchCode) {
        params.push(branchCode);
        query += ` AND UPPER(ei.branch_code) = UPPER($${params.length})`;
    }
    if (examDate) {
        params.push(examDate);
        query += ` AND ei.exam_date = $${params.length}`;
    }
    if (period !== undefined && period !== null) {
        params.push(period);
        query += ` AND ei.period = $${params.length}`;
    }
    if (facultyId) {
        params.push(facultyId);
        query += ` AND ei.faculty_id = $${params.length}`;
    }
    query += ` ORDER BY ei.exam_date ASC, ei.period ASC`;
    const { rows } = await db.query(query, params);
    return rows;
}

async function deleteActiveInvigilation(id, branchCode) {
    const { rows } = await db.query(`
        DELETE FROM exam_invigilation ei
         USING faculty f, departments d
         WHERE ei.faculty_id = f.id
           AND f.department_id = d.id
           AND ei.id = $1
           AND UPPER(d.code) = UPPER($2)
        RETURNING ei.id, ei.faculty_id AS "facultyId", ei.exam_date AS "examDate", ei.period
    `, [id, branchCode]);
    return rows[0] || null;
}

/* ======================================================================
 * Faculty Substitutions (Phase B7.5) & User Persistence
 * ====================================================================== */

async function resolveFacultyDbId(clientOrDb, identifier, name = null) {
    const runner = clientOrDb || db;
    if (identifier !== undefined && identifier !== null && !isNaN(parseInt(identifier, 10))) {
        const res = await runner.query('SELECT id FROM faculty WHERE id = $1', [parseInt(identifier, 10)]);
        if (res.rows.length) return res.rows[0].id;
    }
    const lookupStr = String(identifier || name || '').trim();
    if (lookupStr) {
        const res = await runner.query(
            'SELECT id FROM faculty WHERE UPPER(code) = UPPER($1) OR UPPER(name) = UPPER($1) LIMIT 1',
            [lookupStr]
        );
        if (res.rows.length) return res.rows[0].id;
    }
    if (name) {
        const res = await runner.query(
            'SELECT id FROM faculty WHERE UPPER(name) = UPPER($1) LIMIT 1',
            [String(name).trim()]
        );
        if (res.rows.length) return res.rows[0].id;
    }
    return null;
}

async function ensureFacultyDbRecord(clientOrDb, { id, name, department, phone, status }) {
    const runner = clientOrDb || db;
    const existingId = await resolveFacultyDbId(runner, id, name);
    if (existingId) return existingId;

    let deptId = null;
    if (department) {
        const dRes = await runner.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [department]);
        if (dRes.rows.length) {
            deptId = dRes.rows[0].id;
        } else {
            const insD = await runner.query(
                'INSERT INTO departments (code, name, total_semesters) VALUES ($1, $1, 6) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id',
                [department]
            );
            deptId = insD.rows[0].id;
        }
    }

    const facCode = id ? String(id) : `FAC_${Date.now()}`;
    const facName = name ? String(name) : facCode;
    const ins = await runner.query(`
        INSERT INTO faculty (code, name, department_id, phone, status)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
    `, [facCode, facName, deptId, phone || null, status || 'active']);
    return ins.rows[0].id;
}

async function createFacultySubstitution({
    id, date, dayOfWeek, period, className, subject, room,
    originalFacultyId, originalFacultyName, originalFacultyBranch,
    substituteFacultyId, substituteFacultyName, substituteFacultyBranch,
    requestedBy, status
}) {
    return db.withTransaction(async client => {
        const origId = await ensureFacultyDbRecord(client, {
            id: originalFacultyId,
            name: originalFacultyName,
            department: originalFacultyBranch
        });
        const subId = await ensureFacultyDbRecord(client, {
            id: substituteFacultyId,
            name: substituteFacultyName,
            department: substituteFacultyBranch
        });

        const { rows } = await client.query(`
            INSERT INTO faculty_substitutions (
                id, date, day_of_week, period, class_name, subject, room,
                original_faculty_id, original_faculty_name, original_faculty_branch,
                substitute_faculty_id, substitute_faculty_name, substitute_faculty_branch,
                requested_by, status, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                rejection_reason = EXCLUDED.rejection_reason
            RETURNING
                id, date::text, day_of_week AS "dayOfWeek", period,
                class_name AS "className", subject, room,
                original_faculty_id AS "originalFacultyId",
                original_faculty_name AS "originalFacultyName",
                original_faculty_branch AS "originalFacultyBranch",
                substitute_faculty_id AS "substituteFacultyId",
                substitute_faculty_name AS "substituteFacultyName",
                substitute_faculty_branch AS "substituteFacultyBranch",
                requested_by AS "requestedBy",
                status, rejection_reason AS "rejectionReason",
                created_at AS "createdAt",
                responded_at AS "respondedAt",
                cancelled_at AS "cancelledAt"
        `, [
            id, date, dayOfWeek, period, className || null, subject || null, room || null,
            origId, originalFacultyName, originalFacultyBranch,
            subId, substituteFacultyName, substituteFacultyBranch,
            requestedBy, status || 'PENDING'
        ]);

        return rows[0];
    });
}

async function getFacultySubstitutionById(id) {
    const { rows } = await db.query(`
        SELECT
            id, date::text, day_of_week AS "dayOfWeek", period,
            class_name AS "className", subject, room,
            original_faculty_id AS "originalFacultyId",
            original_faculty_name AS "originalFacultyName",
            original_faculty_branch AS "originalFacultyBranch",
            substitute_faculty_id AS "substituteFacultyId",
            substitute_faculty_name AS "substituteFacultyName",
            substitute_faculty_branch AS "substituteFacultyBranch",
            requested_by AS "requestedBy",
            status, rejection_reason AS "rejectionReason",
            created_at AS "createdAt",
            responded_at AS "respondedAt",
            cancelled_at AS "cancelledAt"
        FROM faculty_substitutions
        WHERE id = $1
    `, [id]);
    return rows[0] || null;
}

async function updateFacultySubstitutionStatus(id, { status, rejectionReason, respondedAt, cancelledAt }) {
    const { rows } = await db.query(`
        UPDATE faculty_substitutions
           SET status = $2,
               rejection_reason = COALESCE($3, rejection_reason),
               responded_at = COALESCE($4, responded_at),
               cancelled_at = COALESCE($5, cancelled_at)
         WHERE id = $1
        RETURNING
            id, date::text, day_of_week AS "dayOfWeek", period,
            class_name AS "className", subject, room,
            original_faculty_id AS "originalFacultyId",
            original_faculty_name AS "originalFacultyName",
            original_faculty_branch AS "originalFacultyBranch",
            substitute_faculty_id AS "substituteFacultyId",
            substitute_faculty_name AS "substituteFacultyName",
            substitute_faculty_branch AS "substituteFacultyBranch",
            requested_by AS "requestedBy",
            status, rejection_reason AS "rejectionReason",
            created_at AS "createdAt",
            responded_at AS "respondedAt",
            cancelled_at AS "cancelledAt"
    `, [id, status, rejectionReason || null, respondedAt || null, cancelledAt || null]);
    return rows[0] || null;
}

async function listFacultySubstitutions({ branchCode, date, period, originalFacultyId, substituteFacultyId, requestedBy, status } = {}) {
    let query = `
        SELECT
            id, date::text, day_of_week AS "dayOfWeek", period,
            class_name AS "className", subject, room,
            original_faculty_id AS "originalFacultyId",
            original_faculty_name AS "originalFacultyName",
            original_faculty_branch AS "originalFacultyBranch",
            substitute_faculty_id AS "substituteFacultyId",
            substitute_faculty_name AS "substituteFacultyName",
            substitute_faculty_branch AS "substituteFacultyBranch",
            requested_by AS "requestedBy",
            status, rejection_reason AS "rejectionReason",
            created_at AS "createdAt",
            responded_at AS "respondedAt",
            cancelled_at AS "cancelledAt"
        FROM faculty_substitutions
        WHERE 1=1
    `;
    const params = [];
    if (branchCode) {
        params.push(branchCode);
        query += ` AND UPPER(original_faculty_branch) = UPPER($${params.length})`;
    }
    if (date) {
        params.push(date);
        query += ` AND date = $${params.length}`;
    }
    if (period != null) {
        params.push(period);
        query += ` AND period = $${params.length}`;
    }
    if (originalFacultyId) {
        params.push(String(originalFacultyId));
        query += ` AND (original_faculty_id::text = $${params.length} OR UPPER(original_faculty_name) = UPPER($${params.length}))`;
    }
    if (substituteFacultyId) {
        params.push(String(substituteFacultyId));
        query += ` AND (substitute_faculty_id::text = $${params.length} OR UPPER(substitute_faculty_name) = UPPER($${params.length}))`;
    }
    if (requestedBy) {
        params.push(String(requestedBy));
        query += ` AND requested_by = $${params.length}`;
    }
    if (status) {
        params.push(String(status).toUpperCase());
        query += ` AND status = $${params.length}`;
    }
    query += ` ORDER BY date DESC, period ASC, created_at DESC`;

    const { rows } = await db.query(query, params);
    return rows;
}

async function hasAcceptedFacultySubstitution({ substituteFacultyId, substituteFacultyName, date, period }) {
    const query = `
        SELECT 1 FROM faculty_substitutions
         WHERE status = 'ACCEPTED'
           AND date = $1
           AND period = $2
           AND (
               ($3::text IS NOT NULL AND substitute_faculty_id::text = $3)
               OR ($4::text IS NOT NULL AND UPPER(substitute_faculty_name) = UPPER($4))
           )
         LIMIT 1
    `;
    const { rows } = await db.query(query, [
        date,
        period,
        substituteFacultyId ? String(substituteFacultyId) : null,
        substituteFacultyName ? String(substituteFacultyName) : null
    ]);
    return rows.length > 0;
}

async function saveUser({ username, name, phone, role, departmentCode, passwordHash, status, facultyId, subjects }) {
    return db.withTransaction(async client => {
        let deptId = null;
        if (departmentCode) {
            const dRes = await client.query('SELECT id FROM departments WHERE UPPER(code) = UPPER($1)', [departmentCode]);
            if (dRes.rows.length) {
                deptId = dRes.rows[0].id;
            } else {
                const insD = await client.query(
                    'INSERT INTO departments (code, name, total_semesters) VALUES ($1, $1, 6) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id',
                    [departmentCode]
                );
                deptId = insD.rows[0].id;
            }
        }

        let facId = null;
        if (facultyId) {
            facId = await resolveFacultyDbId(client, facultyId, name);
            if (!facId) {
                facId = await ensureFacultyDbRecord(client, {
                    id: facultyId,
                    name: name,
                    department: departmentCode,
                    phone: phone,
                    status: status || 'active'
                });
            }
        }

        const { rows } = await client.query(`
            INSERT INTO users (username, name, phone, role, department_id, faculty_id, password_hash, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
            ON CONFLICT (username) DO UPDATE SET
                name = EXCLUDED.name,
                phone = COALESCE(EXCLUDED.phone, users.phone),
                role = EXCLUDED.role,
                department_id = COALESCE(EXCLUDED.department_id, users.department_id),
                faculty_id = COALESCE(EXCLUDED.faculty_id, users.faculty_id),
                password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
                status = COALESCE(EXCLUDED.status, users.status)
            RETURNING id, username, name, phone, role, status, created_at AS "createdAt"
        `, [
            String(username).toLowerCase(),
            name,
            phone || null,
            role || 'faculty',
            deptId,
            facId,
            passwordHash || null,
            status || 'active'
        ]);

        if (facId && Array.isArray(subjects) && subjects.length > 0) {
            for (const subj of subjects) {
                await client.query(`
                    INSERT INTO faculty_subjects (faculty_id, subject)
                    VALUES ($1, $2)
                    ON CONFLICT (faculty_id, subject) DO NOTHING
                `, [facId, subj]);
            }
        }

        return rows[0];
    });
}

async function updateUserProfile({ username, phone, subjects, name }) {
    return db.withTransaction(async client => {
        const uRes = await client.query(`
            SELECT u.id, u.username, u.name, u.phone, u.role, u.department_id, u.faculty_id
              FROM users u
             WHERE LOWER(u.username) = LOWER($1)
        `, [String(username).trim()]);

        if (!uRes.rows.length) {
            const err = new Error(`User "${username}" not found.`);
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        const user = uRes.rows[0];
        let facId = user.faculty_id;
        if (!facId && user.role === 'faculty') {
            facId = await resolveFacultyDbId(client, user.username, user.name);
            if (facId) {
                await client.query('UPDATE users SET faculty_id = $2 WHERE id = $1', [user.id, facId]);
            }
        }

        const updates = [];
        const params = [user.id];

        if (name && String(name).trim().length >= 2) {
            params.push(String(name).trim());
            updates.push(`name = $${params.length}`);
            if (facId) {
                await client.query('UPDATE faculty SET name = $2 WHERE id = $1', [facId, String(name).trim()]);
            }
        }

        if (phone !== undefined) {
            const pVal = phone ? String(phone).trim() : null;
            params.push(pVal);
            updates.push(`phone = $${params.length}`);
            if (facId) {
                await client.query('UPDATE faculty SET phone = $2 WHERE id = $1', [facId, pVal]);
            }
        }

        if (updates.length > 0) {
            await client.query(`
                UPDATE users
                   SET ${updates.join(', ')}
                 WHERE id = $1
            `, params);
        }

        if (Array.isArray(subjects) && facId) {
            await client.query('DELETE FROM faculty_subjects WHERE faculty_id = $1', [facId]);
            const cleaned = subjects.map(s => String(s).trim()).filter(Boolean);
            for (const subj of cleaned) {
                await client.query(`
                    INSERT INTO faculty_subjects (faculty_id, subject)
                    VALUES ($1, $2)
                    ON CONFLICT (faculty_id, subject) DO NOTHING
                `, [facId, subj]);
            }
        }

        return {
            id: user.id,
            username: user.username
        };
    });
}

async function loadAllUsers() {
    const { rows } = await db.query(`
        SELECT u.id, u.username, u.name, u.phone, u.role, u.status, u.password_hash AS "passwordHash",
               u.created_at AS "createdAt",
               d.code AS department, d.name AS "branchName",
               f.id AS "facultyId", f.name AS "facultyName",
               COALESCE((SELECT array_agg(subject) FROM faculty_subjects WHERE faculty_id = f.id), ARRAY[]::text[]) AS subjects
          FROM users u
          LEFT JOIN departments d ON d.id = u.department_id
          LEFT JOIN faculty f ON f.id = u.faculty_id
         ORDER BY u.id ASC
    `);
    return rows;
}

async function loadAllDepartments() {
    const { rows } = await db.query(`
        SELECT code, name, academic_year AS "academicYear", semester,
               COALESCE(total_semesters, 6) AS "totalSemesters"
          FROM departments
         ORDER BY code ASC
    `);
    return rows;
}

module.exports = {
    isEmpty, counts, loadSource,
    listEntries, getEntry, addEntry, updateEntry, deleteEntry, replaceFacultyEntries,
    listRooms, listSubjects, listClasses, listDepartments,
    addDepartment, updateDepartment, deleteDepartment,
    addSubject, updateSubject, deleteSubject,
    addClass, updateClass, deleteClass, resolveOrCreateClass, clearTimetable,
    addFaculty, getFaculty, updateFaculty, deactivateFaculty, activateFaculty, usernameFor,
    getInstanceBranch, updateInstanceBranch,
    importStagedTimetable,
    createFacultyRequest, listFacultyRequests, getFacultyRequestById, updateFacultyRequestStatus,
    listFacultyAttendanceForDate, markFacultyAttendance, deleteFacultyAttendance, getAbsentFacultyForDate, getFacultyAttendanceHistory,
    createInvigilationRequest, listInvigilationRequests, getInvigilationRequestById, updateInvigilationRequestStatus,
    createActiveInvigilation, listActiveInvigilation, deleteActiveInvigilation,
    createFacultySubstitution, getFacultySubstitutionById, updateFacultySubstitutionStatus,
    listFacultySubstitutions, hasAcceptedFacultySubstitution,
    saveUser, updateUserProfile, loadAllUsers, loadAllDepartments,
    resolveFacultyDbId, ensureFacultyDbRecord,
    DAY_ORDER
};




