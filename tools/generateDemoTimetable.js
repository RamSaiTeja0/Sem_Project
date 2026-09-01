/**
 * Demo timetable generator.
 *
 * Builds the committed demo dataset in src/data/demoTimetable.js. Placing a
 * conflict-free week for five classes by hand is unreliable, so the schedule is
 * searched here once and the *result* is committed as plain data — the app
 * never runs this file.
 *
 * Constraints enforced by construction:
 *   - no faculty teaches two classes in the same day + period
 *   - no room hosts two classes in the same day + period
 *   - a lab occupies a contiguous 3-period afternoon block
 *   - a class sees a given subject at most once a day
 *
 * Run:  node tools/generateDemoTimetable.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7];
const LAB_STARTS = [5];               // labs run P5-P7, after lunch

// Deterministic RNG so regenerating produces byte-identical output.
function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const FACULTY = [
    { id: 'FAC01', name: 'Dr. Arjun Rao', department: 'CSE' },
    { id: 'FAC02', name: 'Dr. Priya Sharma', department: 'CSE' },
    { id: 'FAC03', name: 'Prof. Kiran Reddy', department: 'CSE' },
    { id: 'FAC04', name: 'Dr. Ananya Iyer', department: 'CSE' },
    { id: 'FAC05', name: 'Dr. Rahul Varma', department: 'CSE' },
    { id: 'FAC06', name: 'Prof. Sneha Nair', department: 'CSE' },
    { id: 'FAC07', name: 'Dr. Vikram Kumar', department: 'CSE' },
    { id: 'FAC08', name: 'Prof. Meera Joshi', department: 'CSE' },
    { id: 'FAC09', name: 'Prof. Naveen Reddy', department: 'ECE' },
    { id: 'FAC10', name: 'Dr. Kavya Rao', department: 'ECE' },
    { id: 'FAC11', name: 'Dr. Anitha Menon', department: 'ECE' },
    { id: 'FAC12', name: 'Prof. Ravi Teja', department: 'ECE' }
];

const ROOMS = [
    { code: 'A-101', name: 'Block A — Room 101', type: 'classroom', capacity: 60 },
    { code: 'A-102', name: 'Block A — Room 102', type: 'classroom', capacity: 60 },
    { code: 'A-103', name: 'Block A — Room 103', type: 'classroom', capacity: 60 },
    { code: 'E-201', name: 'Block E — Room 201', type: 'classroom', capacity: 60 },
    { code: 'E-202', name: 'Block E — Room 202', type: 'classroom', capacity: 60 },
    { code: 'CS-LAB-1', name: 'Computer Lab 1', type: 'lab', capacity: 35 },
    { code: 'CS-LAB-2', name: 'Computer Lab 2', type: 'lab', capacity: 35 },
    { code: 'CS-LAB-3', name: 'Computer Lab 3', type: 'lab', capacity: 35 },
    { code: 'EC-LAB-1', name: 'Electronics Lab 1', type: 'lab', capacity: 30 },
    { code: 'EC-LAB-2', name: 'Embedded Systems Lab', type: 'lab', capacity: 30 }
];

const SUBJECTS = [
    { code: 'CS501', name: 'Data Structures', department: 'CSE', type: 'theory' },
    { code: 'CS502', name: 'Database Management Systems', department: 'CSE', type: 'theory' },
    { code: 'CS503', name: 'Operating Systems', department: 'CSE', type: 'theory' },
    { code: 'CS504', name: 'Computer Networks', department: 'CSE', type: 'theory' },
    { code: 'CS505', name: 'Java Programming', department: 'CSE', type: 'theory' },
    { code: 'CS506', name: 'Web Technologies', department: 'CSE', type: 'theory' },
    { code: 'CS507', name: 'Software Engineering', department: 'CSE', type: 'theory' },
    { code: 'CS508', name: 'Machine Learning', department: 'CSE', type: 'theory' },
    { code: 'CS551', name: 'Data Structures Lab', department: 'CSE', type: 'lab' },
    { code: 'CS552', name: 'DBMS Lab', department: 'CSE', type: 'lab' },
    { code: 'CS553', name: 'Operating Systems Lab', department: 'CSE', type: 'lab' },
    { code: 'CS554', name: 'Java Programming Lab', department: 'CSE', type: 'lab' },
    { code: 'CS555', name: 'Web Technologies Lab', department: 'CSE', type: 'lab' },
    { code: 'CS556', name: 'Machine Learning Lab', department: 'CSE', type: 'lab' },
    { code: 'EC501', name: 'Digital Electronics', department: 'ECE', type: 'theory' },
    { code: 'EC502', name: 'Microprocessors', department: 'ECE', type: 'theory' },
    { code: 'EC503', name: 'Signals and Systems', department: 'ECE', type: 'theory' },
    { code: 'EC504', name: 'Communication Systems', department: 'ECE', type: 'theory' },
    { code: 'EC505', name: 'Embedded Systems', department: 'ECE', type: 'theory' },
    { code: 'EC551', name: 'Digital Electronics Lab', department: 'ECE', type: 'lab' },
    { code: 'EC552', name: 'Microprocessors Lab', department: 'ECE', type: 'lab' },
    { code: 'EC553', name: 'Embedded Systems Lab', department: 'ECE', type: 'lab' }
];

const CLASSES = [
    { class: 'CSE-A', department: 'CSE', semester: 5, room: 'A-101', labRooms: ['CS-LAB-1', 'CS-LAB-2'] },
    { class: 'CSE-B', department: 'CSE', semester: 5, room: 'A-102', labRooms: ['CS-LAB-2', 'CS-LAB-3'] },
    { class: 'CSE-C', department: 'CSE', semester: 5, room: 'A-103', labRooms: ['CS-LAB-3', 'CS-LAB-1'] },
    { class: 'ECE-A', department: 'ECE', semester: 5, room: 'E-201', labRooms: ['EC-LAB-1', 'EC-LAB-2'] },
    { class: 'ECE-B', department: 'ECE', semester: 5, room: 'E-202', labRooms: ['EC-LAB-2', 'EC-LAB-1'] }
];

/** Weekly load per class: subject -> faculty -> periods per week. */
const PLAN = {
    'CSE-A': [
        ['Data Structures', 'Dr. Arjun Rao', 4],
        ['Database Management Systems', 'Dr. Priya Sharma', 4],
        ['Operating Systems', 'Prof. Kiran Reddy', 4],
        ['Computer Networks', 'Dr. Ananya Iyer', 4],
        ['Java Programming', 'Dr. Rahul Varma', 4],
        ['Software Engineering', 'Prof. Sneha Nair', 3],
        ['Machine Learning', 'Dr. Vikram Kumar', 3],
        ['DBMS Lab', 'Dr. Priya Sharma', 3],
        ['Java Programming Lab', 'Dr. Rahul Varma', 3]
    ],
    'CSE-B': [
        ['Data Structures', 'Prof. Meera Joshi', 4],
        ['Database Management Systems', 'Dr. Arjun Rao', 4],
        ['Operating Systems', 'Dr. Priya Sharma', 4],
        ['Computer Networks', 'Prof. Kiran Reddy', 4],
        ['Web Technologies', 'Dr. Ananya Iyer', 4],
        ['Java Programming', 'Prof. Sneha Nair', 3],
        ['Machine Learning', 'Dr. Vikram Kumar', 3],
        ['Data Structures Lab', 'Prof. Meera Joshi', 3],
        ['Web Technologies Lab', 'Dr. Ananya Iyer', 3]
    ],
    'CSE-C': [
        ['Data Structures', 'Dr. Rahul Varma', 4],
        ['Operating Systems', 'Prof. Meera Joshi', 4],
        ['Computer Networks', 'Dr. Arjun Rao', 4],
        ['Java Programming', 'Dr. Vikram Kumar', 4],
        ['Web Technologies', 'Prof. Sneha Nair', 4],
        ['Software Engineering', 'Prof. Kiran Reddy', 3],
        ['Machine Learning', 'Dr. Priya Sharma', 3],
        ['Operating Systems Lab', 'Prof. Meera Joshi', 3],
        ['Machine Learning Lab', 'Dr. Priya Sharma', 3]
    ],
    'ECE-A': [
        ['Digital Electronics', 'Prof. Naveen Reddy', 4],
        ['Microprocessors', 'Dr. Kavya Rao', 4],
        ['Signals and Systems', 'Dr. Anitha Menon', 4],
        ['Communication Systems', 'Prof. Ravi Teja', 4],
        ['Embedded Systems', 'Prof. Naveen Reddy', 3],
        ['Digital Electronics Lab', 'Prof. Naveen Reddy', 3],
        ['Microprocessors Lab', 'Dr. Kavya Rao', 3],
        ['Embedded Systems Lab', 'Prof. Ravi Teja', 3]
    ],
    'ECE-B': [
        ['Digital Electronics', 'Dr. Kavya Rao', 4],
        ['Microprocessors', 'Prof. Ravi Teja', 4],
        ['Signals and Systems', 'Prof. Naveen Reddy', 4],
        ['Communication Systems', 'Dr. Anitha Menon', 4],
        ['Embedded Systems', 'Dr. Kavya Rao', 3],
        ['Digital Electronics Lab', 'Dr. Anitha Menon', 3],
        ['Microprocessors Lab', 'Prof. Ravi Teja', 3],
        ['Embedded Systems Lab', 'Prof. Ravi Teja', 3]
    ]
};

const subjectByName = new Map(SUBJECTS.map(s => [s.name, s]));

function shuffle(list, rand) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function solve(seed) {
    const rand = rng(seed);
    const facultyBusy = new Set();   // "faculty|day|period"
    const roomBusy = new Set();      // "room|day|period"
    const placed = [];               // { className, day, period, subject, faculty, room, type }

    // Labs first: they are the least flexible (a contiguous block, a lab room).
    const labTasks = [];
    const theoryTasks = [];
    CLASSES.forEach(cls => {
        PLAN[cls.class].forEach(([subject, faculty, count]) => {
            const meta = subjectByName.get(subject);
            if (!meta) throw new Error('Unknown subject in plan: ' + subject);
            if (meta.type === 'lab') labTasks.push({ cls, subject, faculty, count });
            else theoryTasks.push({ cls, subject, faculty, count });
        });
    });

    function freeFor(faculty, room, day, period) {
        return !facultyBusy.has(`${faculty}|${day}|${period}`) &&
               !roomBusy.has(`${room}|${day}|${period}`);
    }

    function take(className, day, period, subject, faculty, room, type) {
        facultyBusy.add(`${faculty}|${day}|${period}`);
        roomBusy.add(`${room}|${day}|${period}`);
        placed.push({ className, day, period, subject, faculty, room, type });
    }

    // --- labs ---
    for (const task of shuffle(labTasks, rand)) {
        const days = shuffle(DAYS, rand);
        let done = false;
        for (const day of days) {
            // one lab per class per day
            if (placed.some(p => p.className === task.cls.class && p.day === day && p.type === 'lab')) continue;
            for (const start of LAB_STARTS) {
                const periods = [];
                for (let i = 0; i < task.count; i++) periods.push(start + i);
                if (periods.some(p => !PERIODS.includes(p))) continue;
                for (const room of task.cls.labRooms) {
                    const classFree = periods.every(p =>
                        !placed.some(x => x.className === task.cls.class && x.day === day && x.period === p));
                    if (!classFree) continue;
                    if (!periods.every(p => freeFor(task.faculty, room, day, p))) continue;
                    periods.forEach(p => take(task.cls.class, day, p, task.subject, task.faculty, room, 'lab'));
                    done = true;
                    break;
                }
                if (done) break;
            }
            if (done) break;
        }
        if (!done) return null;
    }

    // --- theory, most-constrained first ---
    const expanded = [];
    theoryTasks.forEach(t => { for (let i = 0; i < t.count; i++) expanded.push(t); });

    for (const task of shuffle(expanded, rand)) {
        const room = task.cls.room;
        const slots = [];
        DAYS.forEach(day => PERIODS.forEach(period => slots.push({ day, period })));
        let done = false;
        for (const { day, period } of shuffle(slots, rand)) {
            // class must be free, and must not already see this subject today
            if (placed.some(p => p.className === task.cls.class && p.day === day && p.period === period)) continue;
            if (placed.some(p => p.className === task.cls.class && p.day === day && p.subject === task.subject)) continue;
            if (!freeFor(task.faculty, room, day, period)) continue;
            take(task.cls.class, day, period, task.subject, task.faculty, room, 'theory');
            done = true;
            break;
        }
        if (!done) return null;
    }

    return placed;
}

let solution = null;
let usedSeed = 0;
for (let seed = 1; seed <= 4000 && !solution; seed++) {
    solution = solve(seed);
    if (solution) usedSeed = seed;
}
if (!solution) {
    console.error('No conflict-free schedule found. Loosen the plan and retry.');
    process.exit(1);
}

// ---------------------------- verification ------------------------------
const problems = [];
const facSeen = new Map();
const roomSeen = new Map();
const classSeen = new Map();
solution.forEach(r => {
    const fk = `${r.faculty}|${r.day}|${r.period}`;
    if (facSeen.has(fk)) problems.push(`faculty clash: ${fk} (${facSeen.get(fk).className} / ${r.className})`);
    facSeen.set(fk, r);
    const rk = `${r.room}|${r.day}|${r.period}`;
    if (roomSeen.has(rk)) problems.push(`room clash: ${rk} (${roomSeen.get(rk).className} / ${r.className})`);
    roomSeen.set(rk, r);
    const ck = `${r.className}|${r.day}|${r.period}`;
    if (classSeen.has(ck)) problems.push(`class clash: ${ck}`);
    classSeen.set(ck, r);
});
const total = DAYS.length * PERIODS.length;
FACULTY.forEach(f => {
    const busy = solution.filter(r => r.faculty === f.name).length;
    if (busy === 0) problems.push(`${f.name} has no busy period`);
    if (busy >= total) problems.push(`${f.name} has no free period`);
});
if (problems.length) {
    console.error('Verification failed:\n  ' + problems.join('\n  '));
    process.exit(1);
}

// ---------------------------- emit --------------------------------------
// Collapse consecutive same-subject periods into spanTo blocks, matching the
// shape the normalizer already understands.
function rowsFor(className) {
    const rows = {};
    DAYS.forEach(day => {
        const dayCells = solution
            .filter(r => r.className === className && r.day === day)
            .sort((a, b) => a.period - b.period);
        const out = [];
        let i = 0;
        while (i < dayCells.length) {
            const cell = dayCells[i];
            let end = cell.period;
            let j = i + 1;
            while (j < dayCells.length &&
                   dayCells[j].subject === cell.subject &&
                   dayCells[j].faculty === cell.faculty &&
                   dayCells[j].room === cell.room &&
                   dayCells[j].period === end + 1) { end = dayCells[j].period; j++; }
            const entry = { period: cell.period };
            if (end !== cell.period) entry.spanTo = end;
            entry.subject = cell.subject;
            entry.faculty = cell.faculty;
            entry.room = cell.room;
            entry.type = cell.type;
            out.push(entry);
            i = j;
        }
        if (out.length) rows[day] = out;
    });
    return rows;
}

const dataset = {
    meta: {
        institution: 'Institute of Engineering & Technology',
        title: 'Semester V — Working Timetable (Demo Data)',
        primaryClass: 'CSE-A',
        days: DAYS,
        periods: PERIODS,
        periodTimings: {
            '1': { start: '09:00', end: '09:50' },
            '2': { start: '09:50', end: '10:40' },
            '3': { start: '10:50', end: '11:40' },
            '4': { start: '11:40', end: '12:30' },
            '5': { start: '13:20', end: '14:10' },
            '6': { start: '14:10', end: '15:00' },
            '7': { start: '15:10', end: '16:00' }
        }
    },
    departments: [
        { code: 'CSE', name: 'Computer Science & Engineering' },
        { code: 'ECE', name: 'Electronics & Communication Engineering' }
    ],
    rooms: ROOMS,
    subjects: SUBJECTS,
    faculty: FACULTY,
    classes: CLASSES.map(c => ({
        class: c.class,
        department: c.department,
        semester: c.semester,
        room: c.room,
        rows: rowsFor(c.class)
    }))
};

function js(value, indent) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const flat = value.every(v => typeof v !== 'object' || v === null);
        if (flat) return '[' + value.map(v => JSON.stringify(v)).join(', ') + ']';
        return '[\n' + value.map(v => pad + '    ' + js(v, indent + 4)).join(',\n') + '\n' + pad + ']';
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) return '{}';
        const inline = keys.every(k => typeof value[k] !== 'object' || value[k] === null);
        const body = keys.map(k => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${js(value[k], indent + 4)}`);
        if (inline && body.join(', ').length < 110) return '{ ' + body.join(', ') + ' }';
        return '{\n' + body.map(b => pad + '    ' + b).join(',\n') + '\n' + pad + '}';
    }
    return JSON.stringify(value);
}

const header = `/**
 * Demo academic dataset — realistic fictional data for demonstrating the app.
 *
 * ${FACULTY.length} faculty across ${dataset.departments.length} departments, ${CLASSES.length} classes, ${SUBJECTS.length} subjects,
 * ${ROOMS.length} rooms, Monday-Friday, periods 1-7.
 *
 * GENERATED FILE — produced by tools/generateDemoTimetable.js and committed as
 * plain data. Edit the plan in that script and re-run it rather than editing
 * the schedule here by hand; the generator is what guarantees that:
 *   - no faculty is scheduled in two classes at the same day + period
 *   - no room hosts two classes at the same day + period
 *   - every faculty member has both busy and free periods, so the
 *     substitution lookup always has something to show
 *
 * All names are fictional and exist only for this demonstration.
 *
 * This module is the fallback dataset. When DATABASE_URL is configured the
 * store loads the timetable from PostgreSQL instead and seeds it from here.
 */

module.exports = `;

const out = header + js(dataset, 0) + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'src', 'data', 'demoTimetable.js'), out);

const labCount = solution.filter(r => r.type === 'lab').length;
console.log(`seed ${usedSeed}: ${solution.length} scheduled periods ` +
    `(${solution.length - labCount} theory, ${labCount} lab) across ${CLASSES.length} classes.`);
FACULTY.forEach(f => {
    const busy = solution.filter(r => r.faculty === f.name).length;
    console.log(`  ${f.name.padEnd(20)} ${String(busy).padStart(2)} busy / ${total - busy} free`);
});
