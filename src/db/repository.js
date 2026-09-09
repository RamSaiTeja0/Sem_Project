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
            (SELECT COUNT(*)::int FROM attendance)    AS attendance
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
        db.query(`SELECT f.code, f.name, COALESCE(d.code, 'General') AS department,
                         f.designation, f.email, f.phone, f.max_weekly_periods, f.status
                    FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
                   ORDER BY f.code`),
        db.query(`SELECT c.code, c.semester, c.academic_year,
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
                    JOIN faculty f ON f.id = t.faculty_id
                    LEFT JOIN rooms r ON r.id = t.room_id`),
        db.query('SELECT period, start_time, end_time FROM periods ORDER BY period'),
        db.query('SELECT code, name, room_type, capacity FROM rooms ORDER BY code'),
        db.query(`SELECT s.code, s.name, s.subject_type, COALESCE(d.code, 'General') AS department
                    FROM subjects s LEFT JOIN departments d ON d.id = s.department_id
                   ORDER BY s.code`),
        db.query('SELECT code, name FROM departments ORDER BY code')
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
        departments: deptRows.rows.map(d => ({ code: d.code, name: d.name })),
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
    const classId = await lookupId(client, 'classes', 'code', entry.className);
    const subjectId = await lookupId(client, 'subjects', 'name', entry.subject);
    const facultyId = entry.faculty ? await lookupId(client, 'faculty', 'name', entry.faculty) : null;
    const roomId = entry.room ? await lookupId(client, 'rooms', 'code', entry.room) : null;

    const missing = [];
    if (!classId) missing.push(`class "${entry.className}"`);
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
        SELECT c.code, c.semester, c.academic_year AS "academicYear",
               COALESCE(d.code, 'General') AS department, r.code AS room
          FROM classes c
          LEFT JOIN departments d ON d.id = c.department_id
          LEFT JOIN rooms r ON r.id = c.home_room_id
         ORDER BY c.code`);
    return rows;
}

async function listDepartments() {
    const branch = getBranch();
    try {
        const { rows } = await db.query(`
            SELECT d.code, d.name, d.academic_year AS "academicYear", d.semester,
                   COUNT(f.id)::int AS "facultyCount"
              FROM departments d
              LEFT JOIN faculty f ON f.department_id = d.id
             WHERE UPPER(d.code) = UPPER($1)
             GROUP BY d.code, d.name, d.academic_year, d.semester
             ORDER BY d.code`, [branch.code]);
        if (rows.length) return rows;
    } catch (err) {
        // Return default if query fails
    }
    return [{
        code: branch.code,
        name: branch.name,
        academicYear: branch.academicYear,
        semester: branch.semester,
        facultyCount: 0
    }];
}

async function getInstanceBranch(branchCode = null) {
    const branch = getBranch(branchCode);
    try {
        const lookupCode = branch.code || branchCode;
        if (!lookupCode) return { ...branch, facultyCount: 0 };
        const { rows } = await db.query(`
            SELECT d.code, d.name, d.academic_year AS "academicYear", d.semester,
                   COUNT(f.id)::int AS "facultyCount"
              FROM departments d
              LEFT JOIN faculty f ON f.department_id = d.id
             WHERE UPPER(d.code) = UPPER($1)
             GROUP BY d.code, d.name, d.academic_year, d.semester`, [lookupCode]);
        if (rows.length) {
            return {
                code: rows[0].code,
                name: rows[0].name,
                academicYear: rows[0].academicYear || branch.academicYear,
                semester: rows[0].semester != null ? rows[0].semester : branch.semester,
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

    return db.withTransaction(async client => {
        const { rows } = await client.query(`
            INSERT INTO departments (code, name, academic_year, semester)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (code) DO UPDATE SET
                name = EXCLUDED.name,
                academic_year = EXCLUDED.academic_year,
                semester = EXCLUDED.semester
            RETURNING code, name, academic_year AS "academicYear", semester`,
            [newCode, newName, newYear, newSem]
        );
        setBranch({ code: newCode, name: newName, academicYear: newYear, semester: newSem });
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
            INSERT INTO classes (code, department_id, semester, academic_year, home_room_id)
            VALUES (UPPER($1), $2, $3, $4, $5)
            RETURNING code, semester, academic_year AS "academicYear"`,
            [section.code, deptId, section.semester || null,
             section.academicYear || null, roomId]);
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
                   academic_year = COALESCE($4, academic_year)
             WHERE id = $1
            RETURNING code, semester, academic_year AS "academicYear",
                      (SELECT COALESCE(code, 'General') FROM departments WHERE id = classes.department_id) AS department`,
            [id, deptId, changes.semester || null, changes.academicYear || null]);
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
        SELECT f.code AS id, f.name, COALESCE(d.code, 'General') AS department,
               f.designation, f.email, f.phone,
               f.max_weekly_periods AS "maxWeeklyPeriods", f.status
          FROM faculty f LEFT JOIN departments d ON d.id = f.department_id
         WHERE f.id = $1`, [id]);
    return rows[0] || null;
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

module.exports = {
    isEmpty, counts, loadSource,
    listEntries, getEntry, addEntry, updateEntry, deleteEntry,
    listRooms, listSubjects, listClasses, listDepartments,
    addDepartment, updateDepartment, deleteDepartment,
    addSubject, updateSubject, deleteSubject,
    addClass, updateClass, deleteClass,
    addFaculty, getFaculty, usernameFor,
    getInstanceBranch, updateInstanceBranch,
    importStagedTimetable,
    DAY_ORDER
};
