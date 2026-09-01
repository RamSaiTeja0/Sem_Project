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
const { DEPARTMENTS } = require('../src/data/departments');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7];
const LAB_STARTS = [5];               // labs run P5-P7, after lunch

// Deterministic RNG so regenerating produces byte-identical output.
function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const FACULTY = [
    // CSE
    { id: 'FAC001', name: 'Dr. Arjun Rao', department: 'CSE', designation: 'Professor' },
    { id: 'FAC002', name: 'Dr. Priya Sharma', department: 'CSE', designation: 'Associate Professor' },
    { id: 'FAC003', name: 'Prof. Kiran Reddy', department: 'CSE', designation: 'Assistant Professor' },
    { id: 'FAC004', name: 'Dr. Ananya Iyer', department: 'CSE', designation: 'Associate Professor' },
    { id: 'FAC005', name: 'Dr. Rahul Varma', department: 'CSE', designation: 'Assistant Professor' },
    // ECE
    { id: 'FAC006', name: 'Prof. Naveen Reddy', department: 'ECE', designation: 'Professor' },
    { id: 'FAC007', name: 'Dr. Kavya Rao', department: 'ECE', designation: 'Associate Professor' },
    { id: 'FAC008', name: 'Dr. Anitha Menon', department: 'ECE', designation: 'Assistant Professor' },
    { id: 'FAC009', name: 'Prof. Ravi Teja', department: 'ECE', designation: 'Assistant Professor' },
    // EEE
    { id: 'FAC010', name: 'Dr. Suresh Babu', department: 'EEE', designation: 'Professor' },
    { id: 'FAC011', name: 'Prof. Lakshmi Devi', department: 'EEE', designation: 'Associate Professor' },
    { id: 'FAC012', name: 'Dr. Mahesh Gupta', department: 'EEE', designation: 'Assistant Professor' },
    // CME
    { id: 'FAC013', name: 'Dr. Sneha Nair', department: 'CME', designation: 'Professor' },
    { id: 'FAC014', name: 'Prof. Vikram Kumar', department: 'CME', designation: 'Associate Professor' },
    { id: 'FAC015', name: 'Dr. Meera Joshi', department: 'CME', designation: 'Assistant Professor' },
    // MEC
    { id: 'FAC016', name: 'Dr. Rajesh Pillai', department: 'MEC', designation: 'Professor' },
    { id: 'FAC017', name: 'Prof. Harish Chandra', department: 'MEC', designation: 'Associate Professor' },
    { id: 'FAC018', name: 'Dr. Sunita Rani', department: 'MEC', designation: 'Assistant Professor' },
    // CIVIL
    { id: 'FAC019', name: 'Dr. Venkat Prasad', department: 'CIVIL', designation: 'Professor' },
    { id: 'FAC020', name: 'Prof. Deepak Sinha', department: 'CIVIL', designation: 'Associate Professor' },
    { id: 'FAC021', name: 'Dr. Neha Kulkarni', department: 'CIVIL', designation: 'Assistant Professor' }
].map(member => ({
    ...member,
    // Fictional addresses on an example domain — no real mailbox exists.
    email: member.name
        .replace(/^(Dr|Prof|Mr|Mrs|Ms)\.?\s+/, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '.') + '@college.edu',
    status: 'active',
    maxWeeklyPeriods: 20
}));

const ROOMS = [
    { code: 'A-101', name: 'Block A — Room 101', type: 'classroom', capacity: 60 },
    { code: 'A-102', name: 'Block A — Room 102', type: 'classroom', capacity: 60 },
    { code: 'E-201', name: 'Block E — Room 201', type: 'classroom', capacity: 60 },
    { code: 'E-202', name: 'Block E — Room 202', type: 'classroom', capacity: 60 },
    { code: 'P-301', name: 'Block P — Room 301', type: 'classroom', capacity: 60 },
    { code: 'C-401', name: 'Block C — Room 401', type: 'classroom', capacity: 60 },
    { code: 'M-501', name: 'Block M — Room 501', type: 'classroom', capacity: 60 },
    { code: 'V-601', name: 'Block V — Room 601', type: 'classroom', capacity: 60 },
    { code: 'CS-LAB-1', name: 'Computer Lab 1', type: 'lab', capacity: 35 },
    { code: 'CS-LAB-2', name: 'Computer Lab 2', type: 'lab', capacity: 35 },
    { code: 'EC-LAB-1', name: 'Electronics Lab 1', type: 'lab', capacity: 30 },
    { code: 'EC-LAB-2', name: 'Electronics Lab 2', type: 'lab', capacity: 30 },
    { code: 'EE-LAB-1', name: 'Electrical Machines Lab', type: 'lab', capacity: 30 },
    { code: 'CM-LAB-1', name: 'Computer Engineering Lab', type: 'lab', capacity: 35 },
    { code: 'ME-WORKSHOP', name: 'Mechanical Workshop', type: 'lab', capacity: 40 },
    { code: 'CV-LAB-1', name: 'Civil Engineering Lab', type: 'lab', capacity: 30 }
];

const SUBJECTS = [
    // CSE
    { code: 'CS501', name: 'Data Structures', department: 'CSE', type: 'theory' },
    { code: 'CS502', name: 'Database Management Systems', department: 'CSE', type: 'theory' },
    { code: 'CS503', name: 'Operating Systems', department: 'CSE', type: 'theory' },
    { code: 'CS504', name: 'Computer Networks', department: 'CSE', type: 'theory' },
    { code: 'CS505', name: 'Web Technologies', department: 'CSE', type: 'theory' },
    { code: 'CS551', name: 'Data Structures Lab', department: 'CSE', type: 'lab' },
    { code: 'CS552', name: 'DBMS Lab', department: 'CSE', type: 'lab' },
    { code: 'CS553', name: 'Web Technologies Lab', department: 'CSE', type: 'lab' },
    // ECE
    { code: 'EC501', name: 'Digital Electronics', department: 'ECE', type: 'theory' },
    { code: 'EC502', name: 'Signals and Systems', department: 'ECE', type: 'theory' },
    { code: 'EC503', name: 'Microprocessors', department: 'ECE', type: 'theory' },
    { code: 'EC504', name: 'Communication Systems', department: 'ECE', type: 'theory' },
    { code: 'EC551', name: 'Digital Electronics Lab', department: 'ECE', type: 'lab' },
    { code: 'EC552', name: 'Microprocessors Lab', department: 'ECE', type: 'lab' },
    // EEE
    { code: 'EE501', name: 'Power Systems', department: 'EEE', type: 'theory' },
    { code: 'EE502', name: 'Electrical Machines', department: 'EEE', type: 'theory' },
    { code: 'EE503', name: 'Control Systems', department: 'EEE', type: 'theory' },
    { code: 'EE551', name: 'Electrical Machines Lab', department: 'EEE', type: 'lab' },
    { code: 'EE552', name: 'Power Systems Lab', department: 'EEE', type: 'lab' },
    // CME
    { code: 'CM501', name: 'Computer Architecture', department: 'CME', type: 'theory' },
    { code: 'CM502', name: 'Programming', department: 'CME', type: 'theory' },
    { code: 'CM503', name: 'Software Engineering', department: 'CME', type: 'theory' },
    { code: 'CM551', name: 'Programming Lab', department: 'CME', type: 'lab' },
    { code: 'CM552', name: 'Computer Architecture Lab', department: 'CME', type: 'lab' },
    // MEC
    { code: 'ME501', name: 'Engineering Mechanics', department: 'MEC', type: 'theory' },
    { code: 'ME502', name: 'Thermodynamics', department: 'MEC', type: 'theory' },
    { code: 'ME503', name: 'Manufacturing Technology', department: 'MEC', type: 'theory' },
    { code: 'ME551', name: 'Manufacturing Technology Lab', department: 'MEC', type: 'lab' },
    { code: 'ME552', name: 'Thermodynamics Lab', department: 'MEC', type: 'lab' },
    // CIVIL
    { code: 'CV501', name: 'Structural Engineering', department: 'CIVIL', type: 'theory' },
    { code: 'CV502', name: 'Surveying', department: 'CIVIL', type: 'theory' },
    { code: 'CV503', name: 'Concrete Technology', department: 'CIVIL', type: 'theory' },
    { code: 'CV551', name: 'Surveying Lab', department: 'CIVIL', type: 'lab' },
    { code: 'CV552', name: 'Concrete Technology Lab', department: 'CIVIL', type: 'lab' }
];

const ACADEMIC_YEAR = '2025-26';

const CLASSES = [
    { class: 'CSE-A', department: 'CSE', semester: 5, room: 'A-101', labRooms: ['CS-LAB-1', 'CS-LAB-2'] },
    { class: 'CSE-B', department: 'CSE', semester: 5, room: 'A-102', labRooms: ['CS-LAB-2', 'CS-LAB-1'] },
    { class: 'ECE-A', department: 'ECE', semester: 5, room: 'E-201', labRooms: ['EC-LAB-1', 'EC-LAB-2'] },
    { class: 'ECE-B', department: 'ECE', semester: 5, room: 'E-202', labRooms: ['EC-LAB-2', 'EC-LAB-1'] },
    { class: 'EEE-A', department: 'EEE', semester: 5, room: 'P-301', labRooms: ['EE-LAB-1'] },
    { class: 'CME-A', department: 'CME', semester: 5, room: 'C-401', labRooms: ['CM-LAB-1'] },
    { class: 'MEC-A', department: 'MEC', semester: 5, room: 'M-501', labRooms: ['ME-WORKSHOP'] },
    { class: 'CIVIL-A', department: 'CIVIL', semester: 5, room: 'V-601', labRooms: ['CV-LAB-1'] }
];

/** Weekly load per class: subject -> faculty -> periods per week. */
const PLAN = {
    'CSE-A': [
        ['Data Structures', 'Dr. Arjun Rao', 5],
        ['Database Management Systems', 'Dr. Priya Sharma', 5],
        ['Operating Systems', 'Prof. Kiran Reddy', 5],
        ['Computer Networks', 'Dr. Ananya Iyer', 4],
        ['Web Technologies', 'Dr. Rahul Varma', 4],
        ['Data Structures Lab', 'Dr. Arjun Rao', 3],
        ['DBMS Lab', 'Dr. Priya Sharma', 3]
    ],
    'CSE-B': [
        ['Data Structures', 'Dr. Priya Sharma', 5],
        ['Database Management Systems', 'Dr. Ananya Iyer', 5],
        ['Operating Systems', 'Dr. Rahul Varma', 4],
        ['Computer Networks', 'Dr. Arjun Rao', 4],
        ['Web Technologies', 'Prof. Kiran Reddy', 4],
        ['Web Technologies Lab', 'Prof. Kiran Reddy', 3],
        ['DBMS Lab', 'Dr. Ananya Iyer', 3]
    ],
    'ECE-A': [
        ['Digital Electronics', 'Prof. Naveen Reddy', 5],
        ['Signals and Systems', 'Dr. Kavya Rao', 5],
        ['Microprocessors', 'Dr. Anitha Menon', 5],
        ['Communication Systems', 'Prof. Ravi Teja', 5],
        ['Digital Electronics Lab', 'Prof. Naveen Reddy', 3],
        ['Microprocessors Lab', 'Dr. Anitha Menon', 3]
    ],
    'ECE-B': [
        ['Digital Electronics', 'Dr. Kavya Rao', 5],
        ['Signals and Systems', 'Prof. Naveen Reddy', 5],
        ['Microprocessors', 'Prof. Ravi Teja', 5],
        ['Communication Systems', 'Dr. Anitha Menon', 4],
        ['Microprocessors Lab', 'Prof. Ravi Teja', 3],
        ['Digital Electronics Lab', 'Dr. Kavya Rao', 3]
    ],
    'EEE-A': [
        ['Power Systems', 'Dr. Suresh Babu', 5],
        ['Electrical Machines', 'Prof. Lakshmi Devi', 5],
        ['Control Systems', 'Dr. Mahesh Gupta', 5],
        ['Electrical Machines Lab', 'Prof. Lakshmi Devi', 3],
        ['Power Systems Lab', 'Dr. Suresh Babu', 3]
    ],
    'CME-A': [
        ['Computer Architecture', 'Dr. Sneha Nair', 5],
        ['Programming', 'Prof. Vikram Kumar', 5],
        ['Software Engineering', 'Dr. Meera Joshi', 5],
        ['Programming Lab', 'Prof. Vikram Kumar', 3],
        ['Computer Architecture Lab', 'Dr. Sneha Nair', 3]
    ],
    'MEC-A': [
        ['Engineering Mechanics', 'Dr. Rajesh Pillai', 5],
        ['Thermodynamics', 'Prof. Harish Chandra', 5],
        ['Manufacturing Technology', 'Dr. Sunita Rani', 5],
        ['Manufacturing Technology Lab', 'Dr. Sunita Rani', 3],
        ['Thermodynamics Lab', 'Prof. Harish Chandra', 3]
    ],
    'CIVIL-A': [
        ['Structural Engineering', 'Dr. Venkat Prasad', 5],
        ['Surveying', 'Prof. Deepak Sinha', 5],
        ['Concrete Technology', 'Dr. Neha Kulkarni', 5],
        ['Surveying Lab', 'Prof. Deepak Sinha', 3],
        ['Concrete Technology Lab', 'Dr. Neha Kulkarni', 3]
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
        title: `Semester V — Working Timetable ${ACADEMIC_YEAR} (Demo Data)`,
        academicYear: ACADEMIC_YEAR,
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
    departments: DEPARTMENTS,
    rooms: ROOMS,
    subjects: SUBJECTS,
    faculty: FACULTY,
    classes: CLASSES.map(c => ({
        class: c.class,
        department: c.department,
        semester: c.semester,
        academicYear: ACADEMIC_YEAR,
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
 * ${FACULTY.length} faculty across ${dataset.departments.length} branches, ${CLASSES.length} classes, ${SUBJECTS.length} subjects,
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
