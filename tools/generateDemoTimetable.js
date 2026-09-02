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
 *   - a class sees a given subject at most once a day (unless planned)
 *
 * Run:  node tools/generateDemoTimetable.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DEPARTMENTS } = require('../src/data/departments');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7];
const LAB_STARTS = [5];               // labs run P5-P7, after lunch

// Deterministic RNG so regenerating produces byte-identical output.
function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const FACULTY = [
    // CME
    { id: 'FAC001', name: 'Sri B. Gopala Rao', department: 'CME', designation: 'Professor', phone: '+91 90000 10001' },
    { id: 'FAC002', name: 'Ms. G. Sandhya Rani', department: 'CME', designation: 'Associate Professor', phone: '+91 90000 10002' },
    { id: 'FAC003', name: 'Ms. Debadatta Bhattacharya', department: 'CME', designation: 'Assistant Professor', phone: '+91 90000 10003' },
    { id: 'FAC004', name: 'Mrs. A. Sravanthi', department: 'CME', designation: 'Assistant Professor', phone: '+91 90000 10004' },
    { id: 'FAC005', name: 'Ms. B. Kusuma', department: 'CME', designation: 'Assistant Professor', phone: '+91 90000 10005' },
    { id: 'FAC006', name: 'Mrs. K. Anitha', department: 'CME', designation: 'Assistant Professor', phone: '+91 90000 10006' },
    { id: 'FAC007', name: 'Mr. Ch. Sai Kishore', department: 'CME', designation: 'Assistant Professor', phone: '+91 90000 10007' },
    // EEE
    { id: 'FAC008', name: 'Dr. Suresh Babu', department: 'EEE', designation: 'Professor', phone: '+91 90000 10008' },
    { id: 'FAC009', name: 'Prof. Lakshmi Devi', department: 'EEE', designation: 'Associate Professor', phone: '+91 90000 10009' },
    { id: 'FAC010', name: 'Dr. Mahesh Gupta', department: 'EEE', designation: 'Assistant Professor', phone: '+91 90000 10010' },
    // ECE
    { id: 'FAC011', name: 'Prof. Naveen Reddy', department: 'ECE', designation: 'Professor', phone: '+91 90000 10011' },
    { id: 'FAC012', name: 'Dr. Kavya Rao', department: 'ECE', designation: 'Associate Professor', phone: '+91 90000 10012' },
    { id: 'FAC013', name: 'Dr. Anitha Menon', department: 'ECE', designation: 'Assistant Professor', phone: '+91 90000 10013' },
    { id: 'FAC014', name: 'Prof. Ravi Teja', department: 'ECE', designation: 'Assistant Professor', phone: '+91 90000 10014' },
    // MEC
    { id: 'FAC015', name: 'Dr. Rajesh Pillai', department: 'MEC', designation: 'Professor', phone: '+91 90000 10015' },
    { id: 'FAC016', name: 'Prof. Harish Chandra', department: 'MEC', designation: 'Associate Professor', phone: '+91 90000 10016' },
    { id: 'FAC017', name: 'Dr. Sunita Rani', department: 'MEC', designation: 'Assistant Professor', phone: '+91 90000 10017' }
].map(member => ({
    ...member,
    // Fictional addresses on an example domain — no real mailbox exists.
    email: member.name
        .replace(/^(Dr|Prof|Mr|Mrs|Ms|Sri)\.?\s+/, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '.') + '@college.edu',
    status: 'active',
    maxWeeklyPeriods: 20
}));

const ROOMS = [
    { code: 'C-401', name: 'Block C — Room 401', type: 'classroom', capacity: 60 },
    { code: 'P-301', name: 'Block P — Room 301', type: 'classroom', capacity: 60 },
    { code: 'E-201', name: 'Block E — Room 201', type: 'classroom', capacity: 60 },
    { code: 'E-202', name: 'Block E — Room 202', type: 'classroom', capacity: 60 },
    { code: 'M-501', name: 'Block M — Room 501', type: 'classroom', capacity: 60 },
    { code: 'CM-LAB-1', name: 'Computer Engineering Lab', type: 'lab', capacity: 35 },
    { code: 'EEE-LAB-1', name: 'Electrical Machines Lab', type: 'lab', capacity: 30 },
    { code: 'EC-LAB-1', name: 'Electronics Lab 1', type: 'lab', capacity: 30 },
    { code: 'EC-LAB-2', name: 'Electronics Lab 2', type: 'lab', capacity: 30 },
    { code: 'ME-WORKSHOP', name: 'Mechanical Workshop', type: 'lab', capacity: 40 }
];

const SUBJECTS = [
    // CME — 9 Master Subjects exactly as required
    { code: 'CM-501', name: 'Industrial Management and Entrepreneurship', department: 'CME', type: 'theory' },
    { code: 'CM-502', name: 'Big Data & Cloud Computing', department: 'CME', type: 'theory' },
    { code: 'CM-503', name: 'Android Programming', department: 'CME', type: 'theory' },
    { code: 'CM-504', name: 'Internet Of Things', department: 'CME', type: 'theory' },
    { code: 'CM-505', name: 'Python Programming', department: 'CME', type: 'theory' },
    { code: 'CM-506', name: 'Android Programming Lab', department: 'CME', type: 'lab' },
    { code: 'CM-507', name: 'Python Programming Lab', department: 'CME', type: 'lab' },
    { code: 'CM-508', name: 'Life Skills', department: 'CME', type: 'theory' },
    { code: 'CM-509', name: 'Project work', department: 'CME', type: 'theory' },
    // EEE
    { code: 'EE501', name: 'Power Systems', department: 'EEE', type: 'theory' },
    { code: 'EE502', name: 'Electrical Machines', department: 'EEE', type: 'theory' },
    { code: 'EE503', name: 'Control Systems', department: 'EEE', type: 'theory' },
    { code: 'EE504', name: 'Power Electronics', department: 'EEE', type: 'theory' },
    { code: 'EE505', name: 'Electromagnetic Fields', department: 'EEE', type: 'theory' },
    { code: 'EE506', name: 'Transmission and Distribution', department: 'EEE', type: 'theory' },
    { code: 'EE551', name: 'Electrical Machines Lab', department: 'EEE', type: 'lab' },
    { code: 'EE552', name: 'Power Systems Lab', department: 'EEE', type: 'lab' },
    // ECE
    { code: 'EC501', name: 'Digital Electronics', department: 'ECE', type: 'theory' },
    { code: 'EC502', name: 'Signals and Systems', department: 'ECE', type: 'theory' },
    { code: 'EC503', name: 'Microprocessors', department: 'ECE', type: 'theory' },
    { code: 'EC504', name: 'Communication Systems', department: 'ECE', type: 'theory' },
    { code: 'EC505', name: 'VLSI Design', department: 'ECE', type: 'theory' },
    { code: 'EC506', name: 'Linear Control Systems', department: 'ECE', type: 'theory' },
    { code: 'EC551', name: 'Digital Electronics Lab', department: 'ECE', type: 'lab' },
    { code: 'EC552', name: 'Microprocessors Lab', department: 'ECE', type: 'lab' },
    { code: 'EC553', name: 'Communication Systems Lab', department: 'ECE', type: 'lab' },
    // MEC
    { code: 'ME501', name: 'Engineering Mechanics', department: 'MEC', type: 'theory' },
    { code: 'ME502', name: 'Thermodynamics', department: 'MEC', type: 'theory' },
    { code: 'ME503', name: 'Manufacturing Technology', department: 'MEC', type: 'theory' },
    { code: 'ME504', name: 'Fluid Mechanics', department: 'MEC', type: 'theory' },
    { code: 'ME505', name: 'Kinematics of Machinery', department: 'MEC', type: 'theory' },
    { code: 'ME506', name: 'Material Science', department: 'MEC', type: 'theory' },
    { code: 'ME551', name: 'Manufacturing Technology Lab', department: 'MEC', type: 'lab' },
    { code: 'ME552', name: 'Thermodynamics Lab', department: 'MEC', type: 'lab' }
];

const ACADEMIC_YEAR = '2026-27';

const CLASSES = [
    { class: 'CME-A', department: 'CME', semester: 5, room: 'C-401', labRooms: ['CM-LAB-1'] },
    { class: 'EEE-A', department: 'EEE', semester: 5, room: 'P-301', labRooms: ['EEE-LAB-1'] },
    { class: 'ECE-A', department: 'ECE', semester: 5, room: 'E-201', labRooms: ['EC-LAB-1', 'EC-LAB-2'] },
    { class: 'ECE-B', department: 'ECE', semester: 5, room: 'E-202', labRooms: ['EC-LAB-2', 'EC-LAB-1'] },
    { class: 'MEC-A', department: 'MEC', semester: 5, room: 'M-501', labRooms: ['ME-WORKSHOP'] }
];

// Exact CME-A schedule from the provided timetable image
const CME_A_ROWS = {
    Monday: [
        { period: 1, spanTo: 2, subject: 'Python Programming', faculty: 'Ms. B. Kusuma', room: 'C-401', type: 'theory' },
        { period: 3, subject: 'Industrial Management and Entrepreneurship', faculty: 'Sri B. Gopala Rao', room: 'C-401', type: 'theory' },
        { period: 4, subject: 'Big Data & Cloud Computing', faculty: 'Ms. G. Sandhya Rani', room: 'C-401', type: 'theory' },
        { period: 5, spanTo: 7, subject: 'Android Programming Lab', faculty: 'Ms. Debadatta Bhattacharya', room: 'CM-LAB-1', type: 'lab' }
    ],
    Tuesday: [
        { period: 1, subject: 'Big Data & Cloud Computing', faculty: 'Ms. G. Sandhya Rani', room: 'C-401', type: 'theory' },
        { period: 2, subject: 'Internet Of Things', faculty: 'Mrs. A. Sravanthi', room: 'C-401', type: 'theory' },
        { period: 3, subject: 'Big Data & Cloud Computing', faculty: 'Ms. G. Sandhya Rani', room: 'C-401', type: 'theory' },
        { period: 4, subject: 'Internet Of Things', faculty: 'Mrs. A. Sravanthi', room: 'C-401', type: 'theory' },
        { period: 5, subject: 'Android Programming', faculty: 'Ms. Debadatta Bhattacharya', room: 'C-401', type: 'theory' },
        { period: 6, subject: 'Python Programming', faculty: 'Ms. B. Kusuma', room: 'C-401', type: 'theory' },
        { period: 7, subject: 'Project work', faculty: 'Mr. Ch. Sai Kishore', room: 'C-401', type: 'theory' }
    ],
    Wednesday: [
        { period: 1, subject: 'Big Data & Cloud Computing', faculty: 'Ms. G. Sandhya Rani', room: 'C-401', type: 'theory' },
        { period: 2, subject: 'Python Programming', faculty: 'Ms. B. Kusuma', room: 'C-401', type: 'theory' },
        { period: 3, subject: 'Android Programming', faculty: 'Ms. Debadatta Bhattacharya', room: 'C-401', type: 'theory' },
        { period: 4, subject: 'Industrial Management and Entrepreneurship', faculty: 'Sri B. Gopala Rao', room: 'C-401', type: 'theory' },
        { period: 5, spanTo: 7, subject: 'Life Skills Lab', faculty: 'Mrs. K. Anitha', room: 'CM-LAB-1', type: 'lab' }
    ],
    Thursday: [
        { period: 1, subject: 'Industrial Management and Entrepreneurship', faculty: 'Sri B. Gopala Rao', room: 'C-401', type: 'theory' },
        { period: 2, subject: 'Python Programming', faculty: 'Ms. B. Kusuma', room: 'C-401', type: 'theory' },
        { period: 3, subject: 'Big Data & Cloud Computing', faculty: 'Ms. G. Sandhya Rani', room: 'C-401', type: 'theory' },
        { period: 4, subject: 'Internet Of Things', faculty: 'Mrs. A. Sravanthi', room: 'C-401', type: 'theory' },
        { period: 5, subject: 'Android Programming', faculty: 'Ms. Debadatta Bhattacharya', room: 'C-401', type: 'theory' },
        { period: 6, subject: 'Industrial Management and Entrepreneurship', faculty: 'Sri B. Gopala Rao', room: 'C-401', type: 'theory' },
        { period: 7, subject: 'Library / Counselling', faculty: null, room: 'C-401', type: 'activity' }
    ],
    Friday: [
        { period: 1, subject: 'Big Data & Cloud Computing', faculty: 'Ms. G. Sandhya Rani', room: 'C-401', type: 'theory' },
        { period: 2, subject: 'Python Programming', faculty: 'Ms. B. Kusuma', room: 'C-401', type: 'theory' },
        { period: 3, subject: 'Android Programming', faculty: 'Ms. Debadatta Bhattacharya', room: 'C-401', type: 'theory' },
        { period: 4, subject: 'Industrial Management and Entrepreneurship', faculty: 'Sri B. Gopala Rao', room: 'C-401', type: 'theory' },
        { period: 5, subject: 'Internet Of Things', faculty: 'Mrs. A. Sravanthi', room: 'C-401', type: 'theory' },
        { period: 6, subject: 'TPC', faculty: null, room: 'C-401', type: 'activity' },
        { period: 7, subject: 'Project work', faculty: 'Mr. Ch. Sai Kishore', room: 'C-401', type: 'theory' }
    ],
    Saturday: [
        { period: 1, spanTo: 2, subject: 'Internet Of Things', faculty: 'Mrs. A. Sravanthi', room: 'C-401', type: 'theory' },
        { period: 3, spanTo: 4, subject: 'Android Programming', faculty: 'Ms. Debadatta Bhattacharya', room: 'C-401', type: 'theory' },
        { period: 5, spanTo: 7, subject: 'Python Programming Lab', faculty: 'Ms. B. Kusuma', room: 'CM-LAB-1', type: 'lab' }
    ]
};

const PLAN = {
    'EEE-A': [
        ['Power Systems', 'Dr. Suresh Babu', 5],
        ['Electrical Machines', 'Prof. Lakshmi Devi', 5],
        ['Control Systems', 'Dr. Mahesh Gupta', 5],
        ['Power Electronics', 'Dr. Suresh Babu', 5],
        ['Electromagnetic Fields', 'Prof. Lakshmi Devi', 5],
        ['Transmission and Distribution', 'Dr. Mahesh Gupta', 5],
        ['Electrical Machines Lab', 'Prof. Lakshmi Devi', 3],
        ['Power Systems Lab', 'Dr. Suresh Babu', 3]
    ],
    'ECE-A': [
        ['Digital Electronics', 'Prof. Naveen Reddy', 5],
        ['Signals and Systems', 'Dr. Kavya Rao', 5],
        ['Microprocessors', 'Dr. Anitha Menon', 5],
        ['Communication Systems', 'Prof. Ravi Teja', 5],
        ['VLSI Design', 'Dr. Kavya Rao', 5],
        ['Linear Control Systems', 'Prof. Naveen Reddy', 5],
        ['Digital Electronics Lab', 'Prof. Naveen Reddy', 3],
        ['Microprocessors Lab', 'Dr. Anitha Menon', 3]
    ],
    'ECE-B': [
        ['Digital Electronics', 'Dr. Kavya Rao', 5],
        ['Signals and Systems', 'Prof. Naveen Reddy', 5],
        ['Microprocessors', 'Prof. Ravi Teja', 5],
        ['Communication Systems', 'Dr. Anitha Menon', 5],
        ['VLSI Design', 'Prof. Ravi Teja', 5],
        ['Linear Control Systems', 'Dr. Anitha Menon', 5],
        ['Microprocessors Lab', 'Prof. Ravi Teja', 3],
        ['Communication Systems Lab', 'Dr. Kavya Rao', 3]
    ],
    'MEC-A': [
        ['Engineering Mechanics', 'Dr. Rajesh Pillai', 5],
        ['Thermodynamics', 'Prof. Harish Chandra', 5],
        ['Manufacturing Technology', 'Dr. Sunita Rani', 5],
        ['Fluid Mechanics', 'Dr. Rajesh Pillai', 5],
        ['Kinematics of Machinery', 'Prof. Harish Chandra', 5],
        ['Material Science', 'Dr. Sunita Rani', 5],
        ['Manufacturing Technology Lab', 'Dr. Sunita Rani', 3],
        ['Thermodynamics Lab', 'Prof. Harish Chandra', 3]
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

    function freeFor(faculty, room, day, period) {
        if (faculty && facultyBusy.has(`${faculty}|${day}|${period}`)) return false;
        if (room && roomBusy.has(`${room}|${day}|${period}`)) return false;
        return true;
    }

    function take(className, day, period, subject, faculty, room, type) {
        if (faculty) facultyBusy.add(`${faculty}|${day}|${period}`);
        if (room) roomBusy.add(`${room}|${day}|${period}`);
        placed.push({ className, day, period, subject, faculty, room, type });
    }

    // Place CME-A entries first
    Object.keys(CME_A_ROWS).forEach(day => {
        CME_A_ROWS[day].forEach(cell => {
            const start = cell.period;
            const end = cell.spanTo != null ? cell.spanTo : start;
            for (let p = start; p <= end; p++) {
                take('CME-A', day, p, cell.subject, cell.faculty, cell.room, cell.type);
            }
        });
    });

    // Pinned demo slots for deterministic test verification:
    // ECE-A Monday P5-P7 is Digital Electronics Lab (Prof. Naveen Reddy, EC-LAB-1)
    take('ECE-A', 'Monday', 5, 'Digital Electronics Lab', 'Prof. Naveen Reddy', 'EC-LAB-1', 'lab');
    take('ECE-A', 'Monday', 6, 'Digital Electronics Lab', 'Prof. Naveen Reddy', 'EC-LAB-1', 'lab');
    take('ECE-A', 'Monday', 7, 'Digital Electronics Lab', 'Prof. Naveen Reddy', 'EC-LAB-1', 'lab');

    // Labs first: they are the least flexible (a contiguous block, a lab room).
    const otherClasses = CLASSES.filter(c => c.class !== 'CME-A');
    const labTasks = [];
    const theoryTasks = [];
    otherClasses.forEach(cls => {
        PLAN[cls.class].forEach(([subject, faculty, count]) => {
            const meta = subjectByName.get(subject);
            if (!meta) throw new Error('Unknown subject in plan: ' + subject);
            let remaining = count;
            if (cls.class === 'ECE-A' && subject === 'Digital Electronics Lab') remaining -= 3;
            if (remaining <= 0) return;
            if (meta.type === 'lab') labTasks.push({ cls, subject, faculty, count: remaining });
            else theoryTasks.push({ cls, subject, faculty, count: remaining });
        });
    });

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
            // class must be free, and must not exceed daily quota for this subject
            if (placed.some(p => p.className === task.cls.class && p.day === day && p.period === period)) continue;
            const seenToday = placed.filter(p => p.className === task.cls.class && p.day === day && p.subject === task.subject).length;
            if (seenToday >= (task.count >= 5 ? 2 : 1)) continue;
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
    if (r.faculty) {
        const fk = `${r.faculty}|${r.day}|${r.period}`;
        if (facSeen.has(fk)) problems.push(`faculty clash: ${fk} (${facSeen.get(fk).className} / ${r.className})`);
        facSeen.set(fk, r);
    }
    if (r.room) {
        const rk = `${r.room}|${r.day}|${r.period}`;
        if (roomSeen.has(rk) && roomSeen.get(rk).className !== r.className) {
            problems.push(`room clash: ${rk} (${roomSeen.get(rk).className} / ${r.className})`);
        }
        roomSeen.set(rk, r);
    }
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
function rowsFor(className) {
    if (className === 'CME-A') return CME_A_ROWS;
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
        institution: 'ADITYA INSTITUTE OF TECHNOLOGY AND MANAGEMENT',
        title: `II SHIFT POLYTECHNIC C23 - V SEM TIME TABLE`,
        academicYear: ACADEMIC_YEAR,
        wef: '08-06-2026',
        primaryClass: 'CME-A',
        days: DAYS,
        periods: PERIODS,
        periodTimings: {
            '1': { start: '08:00', end: '08:45' },
            '2': { start: '08:45', end: '09:30' },
            '3': { start: '09:30', end: '10:15' },
            '4': { start: '10:30', end: '11:15' },
            '5': { start: '11:15', end: '12:00' },
            '6': { start: '12:00', end: '12:45' },
            '7': { start: '12:45', end: '13:30' }
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
 * Demo academic dataset — realistic academic data for demonstrating the app.
 *
 * ${FACULTY.length} faculty across ${dataset.departments.length} branches, ${CLASSES.length} classes, ${SUBJECTS.length} subjects,
 * ${ROOMS.length} rooms, Monday-Saturday, periods 1-7.
 *
 * GENERATED FILE — produced by tools/generateDemoTimetable.js and committed as
 * plain data. Edit the plan in that script and re-run it rather than editing
 * the schedule here by hand; the generator is what guarantees that:
 *   - no faculty is scheduled in two classes at the same day + period
 *   - no room hosts two classes at the same day + period
 *   - every faculty member has both busy and free periods, so the
 *     substitution lookup always has something to show
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
    console.log(`  ${f.name.padEnd(28)} ${String(busy).padStart(2)} busy / ${total - busy} free`);
});
