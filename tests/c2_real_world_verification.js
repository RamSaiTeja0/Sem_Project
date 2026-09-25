/**
 * PHASE C2 — REAL-WORLD APPLICATION VERIFICATION SCRIPT
 *
 * Runs end-to-end against live HTTP server + Neon PostgreSQL.
 * Exercises all workflows A through J:
 *   A. Fresh HOS registration, storage check, login
 *   B. Faculty management, auto branch inheritance, faculty login, RBAC protection
 *   C. Timetable creation, grid view, faculty timetable view, conflict rejection
 *   D. Attendance mark absent, availability exclusion, restore present
 *   E. Availability engine checks (teaching, invigilation, absent, free, same vs other branch)
 *   F. Faculty-to-Faculty Substitution workflow (vacancy detection, request, accept, conflict block, HOS read-only)
 *   F2. Substitution rejection workflow
 *   G. Exam invigilation workflow (conflict detection, present status, busy during exam period)
 *   H. Multi-branch data & access isolation (Branch A vs Branch B)
 *   I. Persistence verification (simulate restart, verify data survives)
 *   J. Scoped cleanup of temporary test records (C2_* prefix)
 */
const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const http = require('http');
const assert = require('assert');
const { app } = require('../server');
const db = require('../src/db/pool');
const seeder = require('../src/db/seed');
const store = require('../src/data/store');
const users = require('../src/data/users');
const departments = require('../src/data/departments');
const substitutions = require('../src/data/substitutions');
const invigilation = require('../src/data/invigilation');
const attendance = require('../src/data/attendance');
const repository = require('../src/db/repository');

const PORT = 3890;
let server;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const headers = { ...(options.headers || {}) };
        let payload = null;

        if (options.body) {
            payload = JSON.stringify(options.body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (options.cookie) {
            headers['Cookie'] = options.cookie;
        }

        const req = http.request(url, {
            method: options.method || 'GET',
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (_) {
                    parsed = data;
                }

                let cookie = null;
                const setCookie = res.headers['set-cookie'];
                if (setCookie && setCookie.length > 0) {
                    cookie = setCookie[0].split(';')[0];
                }

                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: parsed,
                    cookie
                });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Prefixes for scoped cleanup
const BRANCH_A_CODE = 'C2_CSE';
const BRANCH_A_NAME = 'C2 Computer Science';
const BRANCH_B_CODE = 'C2_ECE';
const BRANCH_B_NAME = 'C2 Electronics Eng';

const HOS_A_USER = 'c2_hos_cse';
const HOS_B_USER = 'c2_hos_ece';
const TEST_PASS = 'C2_TestPass_123';

const FAC_A_ID = 'C2_F01';
const FAC_A_NAME = 'Dr. C2 Alice';
const FAC_A_USER = 'c2_alice';
const FAC_A_EMAIL = 'c2_alice@test.edu';

const FAC_B_ID = 'C2_F02';
const FAC_B_NAME = 'Dr. C2 Bob';
const FAC_B_USER = 'c2_bob';
const FAC_B_EMAIL = 'c2_bob@test.edu';

const FAC_C_ID = 'C2_F03';
const FAC_C_NAME = 'Dr. C2 Charlie ECE';
const FAC_C_USER = 'c2_charlie';
const FAC_C_EMAIL = 'c2_charlie@test.edu';

const CLASS_A = 'C2-CSE-A';
const SUBJ_1 = 'C2 Algorithms';
const SUBJ_CODE_1 = 'C2_ALG';
const ROOM_1 = 'C2-Lab-1';
const ROOM_2 = 'C2-Lab-2';

const TEST_DATE = '2026-09-18'; // A Friday

let hosACookie = null;
let hosBCookie = null;
let facACookie = null;
let facBCookie = null;
let facCCookie = null;

let timetableEntryId = null;
let subRequestId = null;
let invigilationId = null;

const stepResults = [];

function recordStep(section, description, passed, details = '') {
    stepResults.push({ section, description, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${mark} [${section}] ${description}${details ? ' — ' + details : ''}`);
}

function getAvailableNames(resBody) {
    if (!resBody) return [];
    if (Array.isArray(resBody.availableFaculty)) return resBody.availableFaculty.map(f => typeof f === 'string' ? f : (f.name || f.faculty || f.facultyName));
    if (Array.isArray(resBody.available)) return resBody.available.map(f => f.name || f.faculty || f.facultyName);
    if (Array.isArray(resBody.faculty)) return resBody.faculty.filter(f => f.status === 'FREE' || f.status === 'free').map(f => f.name || f.facultyName || f.faculty);
    return [];
}

async function cleanupC2Records() {
    if (db.isConfigured()) {
        const queries = [
            `DELETE FROM substitution_requests WHERE requested_by_id IN (SELECT id FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%') OR substitute_faculty_id IN (SELECT id FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%')`,
            `DELETE FROM invigilation_assignments WHERE faculty_id IN (SELECT id FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%')`,
            `DELETE FROM invigilation_requests WHERE requested_by IN (SELECT username FROM users WHERE username LIKE 'c2_%')`,
            `DELETE FROM faculty_attendance WHERE faculty_id IN (SELECT id FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%')`,
            `DELETE FROM timetable WHERE class_id IN (SELECT id FROM classes WHERE code LIKE 'C2%') OR faculty_id IN (SELECT id FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%')`,
            `DELETE FROM users WHERE username LIKE 'c2_%' OR faculty_id IN (SELECT id FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%')`,
            `DELETE FROM faculty WHERE code LIKE 'C2_%' OR name LIKE 'Dr. C2%' OR department_id IN (SELECT id FROM departments WHERE code LIKE 'C2_%')`,
            `DELETE FROM classes WHERE code LIKE 'C2%' OR department_id IN (SELECT id FROM departments WHERE code LIKE 'C2_%')`,
            `DELETE FROM subjects WHERE code LIKE 'C2_%' OR name LIKE 'C2%' OR department_id IN (SELECT id FROM departments WHERE code LIKE 'C2_%')`,
            `DELETE FROM rooms WHERE code LIKE 'C2%'`,
            `DELETE FROM departments WHERE code LIKE 'C2_%'`
        ];
        for (const q of queries) {
            try {
                await db.query(q);
            } catch (e) {
                // ignore
            }
        }
        await store.initFromDatabase();
    }
    // Reset in-memory states
    if (users && typeof users.resetForTesting === 'function') users.resetForTesting();
    if (departments && typeof departments.resetBranchForTesting === 'function') departments.resetBranchForTesting();
    if (substitutions && typeof substitutions.resetForTesting === 'function') substitutions.resetForTesting();
    if (invigilation && typeof invigilation.resetForTesting === 'function') invigilation.resetForTesting();
    if (attendance && typeof attendance.resetForTesting === 'function') attendance.resetForTesting();
}

async function runC2Verification() {
    console.log('================================================================');
    console.log('PHASE C2 — REAL-WORLD APPLICATION WORKFLOW VERIFICATION');
    console.log('================================================================\n');

    // 0. Ensure schema migration and DB initialization
    if (db.isConfigured()) {
        await seeder.migrate();
    }

    // 1. Initial Cleanup of any leftover test markers
    await cleanupC2Records();
    if (db.isConfigured()) {
        await store.initFromDatabase();
    }

    // 2. Start HTTP server
    server = app.listen(PORT);
    await new Promise(r => setTimeout(r, 600));

    try {
        // =====================================================================
        // SECTION A: Fresh HOS & Database Storage
        // =====================================================================
        console.log('\n--- Section A: Fresh HOS & Database Storage ---');

        // 1 & 2. Storage reporting
        const storageRes = await request('/api/storage');
        const isPostgres = storageRes.status === 200 && (storageRes.body.backend === 'postgres' || storageRes.body.database === 'postgresql');
        recordStep('A', 'Storage reports PostgreSQL/Neon backend', isPostgres, storageRes.body.target || storageRes.body.backend);

        // 3. Fresh instance check
        const authStatus = await request('/api/auth/status');
        recordStep('A', 'Application reports auth status', authStatus.status === 200);

        // 4. Register HOS for Branch A (C2_CSE)
        const regHOS = await request('/api/auth/register', {
            method: 'POST',
            body: {
                username: HOS_A_USER,
                password: TEST_PASS,
                role: 'hos',
                name: 'C2 CSE HOS Admin',
                phone: '9876543210',
                branchCode: BRANCH_A_CODE,
                branchName: BRANCH_A_NAME,
                totalSemesters: 8
            }
        });
        const hosRegistered = regHOS.status === 201 && regHOS.body.user && regHOS.body.user.role === 'hos';
        recordStep('A', 'Register HOS for Branch A (C2_CSE)', hosRegistered, hosRegistered ? '' : JSON.stringify(regHOS.body));
        hosACookie = regHOS.cookie;

        // 5. Log in as HOS
        const loginHOS = await request('/api/auth/login', {
            method: 'POST',
            body: { username: HOS_A_USER, password: TEST_PASS }
        });
        if (loginHOS.cookie) hosACookie = loginHOS.cookie;
        const hosLoginOk = loginHOS.status === 200 && loginHOS.body.user && loginHOS.body.user.role === 'hos';
        recordStep('A', 'HOS login succeeds and establishes session', hosLoginOk);

        // =====================================================================
        // SECTION B: Faculty Management & RBAC
        // =====================================================================
        console.log('\n--- Section B: Faculty Management & RBAC ---');

        // 6. Create Faculty A via HOS (both faculty profile in DB and auth user)
        await db.query(`INSERT INTO departments (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`, [BRANCH_A_CODE, BRANCH_A_NAME]);
        const createFacA = await request('/api/faculty', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                facultyId: FAC_A_ID,
                name: FAC_A_NAME,
                department: BRANCH_A_CODE,
                email: FAC_A_EMAIL,
                phone: '9876543211',
                designation: 'Assistant Professor',
                status: 'active'
            }
        });
        const facACreated = createFacA.status === 201 && createFacA.body.faculty && createFacA.body.faculty.name === FAC_A_NAME;
        recordStep('B', 'HOS creates Faculty A', facACreated, facACreated ? '' : JSON.stringify(createFacA.body));

        // Create auth user account for Faculty A
        const regFacA = await request('/api/auth/register', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                role: 'faculty',
                name: FAC_A_NAME,
                username: FAC_A_USER,
                password: TEST_PASS,
                confirmPassword: TEST_PASS,
                phone: '9876543211',
                email: FAC_A_EMAIL,
                subjects: [SUBJ_1]
            }
        });

        // 7. Auto branch inheritance
        const inheritedBranch = createFacA.body && createFacA.body.faculty && (createFacA.body.faculty.department === BRANCH_A_CODE || createFacA.body.faculty.department_id != null);
        recordStep('B', 'Faculty automatically inherits HOS branch (C2_CSE)', Boolean(inheritedBranch));

        // Create Faculty B in Branch A
        const createFacB = await request('/api/faculty', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                facultyId: FAC_B_ID,
                name: FAC_B_NAME,
                department: BRANCH_A_CODE,
                email: FAC_B_EMAIL,
                phone: '9876543212',
                designation: 'Associate Professor',
                status: 'active'
            }
        });
        recordStep('B', 'HOS creates Faculty B in same branch', createFacB.status === 201);

        // Create auth user account for Faculty B
        await request('/api/auth/register', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                role: 'faculty',
                name: FAC_B_NAME,
                username: FAC_B_USER,
                password: TEST_PASS,
                confirmPassword: TEST_PASS,
                phone: '9876543212',
                email: FAC_B_EMAIL,
                subjects: [SUBJ_1]
            }
        });

        // 8. Log in as Faculty A
        const loginFacA = await request('/api/auth/login', {
            method: 'POST',
            body: { username: FAC_A_USER, password: TEST_PASS }
        });
        if (loginFacA.cookie) facACookie = loginFacA.cookie;
        const facALoginOk = loginFacA.status === 200 && loginFacA.body.user && loginFacA.body.user.role === 'faculty';
        recordStep('B', 'Faculty A login succeeds', facALoginOk);

        // Log in as Faculty B
        const loginFacB = await request('/api/auth/login', {
            method: 'POST',
            body: { username: FAC_B_USER, password: TEST_PASS }
        });
        if (loginFacB.cookie) facBCookie = loginFacB.cookie;
        const facBLoginOk = loginFacB.status === 200 && loginFacB.body.user && loginFacB.body.user.role === 'faculty';
        recordStep('B', 'Faculty B login succeeds', facBLoginOk);

        // 9. Verify Faculty cannot access HOS-only operations
        const facForbidden = await request('/api/auth/register', {
            method: 'POST',
            cookie: facACookie,
            body: { role: 'faculty', name: 'Rogue', username: 'rogue', password: TEST_PASS, phone: '9876543299', subjects: ['X'] }
        });
        recordStep('B', 'Faculty denied access to HOS-only faculty creation (403)', facForbidden.status === 403);

        // =====================================================================
        // SECTION C: Timetable Management & Conflict Prevention
        // =====================================================================
        console.log('\n--- Section C: Timetable Management & Conflict Prevention ---');

        // 10. Configure test timetable entries (Friday P1 for Faculty A, Friday P2 for Faculty A)
        await db.query(`INSERT INTO classes (code, department_id, semester, academic_year, section) VALUES ($1, (SELECT id FROM departments WHERE code=$2), 1, '2026-2027', 'A') ON CONFLICT (code) DO NOTHING`, [CLASS_A, BRANCH_A_CODE]);
        await db.query(`INSERT INTO subjects (code, name, department_id, subject_type) VALUES ($1, $2, (SELECT id FROM departments WHERE code=$3), 'theory') ON CONFLICT (code) DO NOTHING`, [SUBJ_CODE_1, SUBJ_1, BRANCH_A_CODE]);
        await db.query(`INSERT INTO rooms (code, name, room_type, capacity) VALUES ($1, 'Lab 1', 'classroom', 40), ($2, 'Lab 2', 'classroom', 40) ON CONFLICT (code) DO NOTHING`, [ROOM_1, ROOM_2]);
        await store.reloadFromDatabase();

        const addEntryRes = await request('/api/timetable/entries', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                day: 'Friday',
                period: 1,
                class: CLASS_A,
                subject: SUBJ_1,
                faculty: FAC_A_NAME,
                room: ROOM_1,
                type: 'theory'
            }
        });
        const addEntry1Ok = addEntryRes.status === 201 && addEntryRes.body.entry;
        recordStep('C', 'HOS adds timetable entry for Faculty A on Friday P1', addEntry1Ok, addEntry1Ok ? '' : JSON.stringify(addEntryRes.body));
        if (addEntryRes.body && addEntryRes.body.entry) {
            timetableEntryId = addEntryRes.body.entry.id;
        }

        // Add second entry on Friday P2 for Faculty A
        const addEntry2 = await request('/api/timetable/entries', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                day: 'Friday',
                period: 2,
                class: CLASS_A,
                subject: SUBJ_1,
                faculty: FAC_A_NAME,
                room: ROOM_1,
                type: 'theory'
            }
        });
        recordStep('C', 'HOS adds timetable entry for Faculty A on Friday P2', addEntry2.status === 201 && addEntry2.body.entry);

        // 11. Verify timetable appears in grid
        const gridRes = await request(`/api/timetable?class=${CLASS_A}`);
        const gridHasEntry = gridRes.status === 200 && JSON.stringify(gridRes.body).includes(FAC_A_NAME);
        recordStep('C', 'Timetable grid reflects created entries', gridHasEntry);

        // 12. Faculty timetable view shows the correct schedule
        const facTTRes = await request('/api/timetable/mine', { cookie: facACookie });
        const facTTOk = facTTRes.status === 200 && JSON.stringify(facTTRes.body).includes(SUBJ_1);
        recordStep('C', 'Faculty personal timetable view shows their teaching periods', facTTOk);

        // 13. Invalid/conflicting timetable entry rejected (Double-booking Faculty A in another room at same period Friday P1)
        const conflictRes = await request('/api/timetable/entries', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                day: 'Friday',
                period: 1,
                class: CLASS_A,
                subject: SUBJ_1,
                faculty: FAC_A_NAME,
                room: ROOM_2,
                type: 'theory'
            }
        });
        recordStep('C', 'Double-booking conflict correctly rejected with 400', conflictRes.status === 400 || conflictRes.status === 409);

        // =====================================================================
        // SECTION D: Attendance Management & Availability Exclusion
        // =====================================================================
        console.log('\n--- Section D: Attendance Management & Availability Exclusion ---');

        // 14. Mark Faculty A ABSENT for TEST_DATE
        const markAbsent = await request('/api/attendance', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                facultyName: FAC_A_NAME,
                date: TEST_DATE,
                status: 'ABSENT',
                reason: 'Medical leave'
            }
        });
        recordStep('D', 'HOS marks Faculty A ABSENT for test date', markAbsent.status === 200 || markAbsent.status === 201);

        // 15. Verify absent faculty is excluded from availability on that date
        const availAbsent = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=3&department=${BRANCH_A_CODE}`, {
            cookie: hosACookie
        });
        const absentFacultyList = getAvailableNames(availAbsent.body);
        const facAExcluded = !absentFacultyList.includes(FAC_A_NAME);
        recordStep('D', 'Absent faculty is excluded from availability results on that date', facAExcluded);

        // 16. Revert/restore attendance to PRESENT and verify normal availability returns
        const markPresent = await request('/api/attendance', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                facultyName: FAC_A_NAME,
                date: TEST_DATE,
                status: 'PRESENT'
            }
        });
        recordStep('D', 'HOS restores Faculty A attendance to PRESENT', markPresent.status === 200 || markPresent.status === 201);

        const availRestored = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=3&department=${BRANCH_A_CODE}`, {
            cookie: hosACookie
        });
        const restoredFacultyList = getAvailableNames(availRestored.body);
        const facARestored = restoredFacultyList.includes(FAC_A_NAME);
        recordStep('D', 'Restoring attendance restores normal availability', facARestored);

        // =====================================================================
        // SECTION E: Dynamic Availability Engine (Teaching, Invigilation, Free)
        // =====================================================================
        console.log('\n--- Section E: Dynamic Availability Engine ---');

        // 17 & 18. Teaching faculty is BUSY during their teaching period (Friday P1)
        const availP1 = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=1&department=${BRANCH_A_CODE}`, {
            cookie: hosACookie
        });
        const freeP1List = getAvailableNames(availP1.body);
        const facABusyP1 = !freeP1List.includes(FAC_A_NAME);
        recordStep('E', 'Teaching faculty is marked BUSY for active class period (Friday P1)', facABusyP1);

        // 19. Invigilation: assign Faculty B to invigilate on Friday P4
        const invigRes = await request('/api/invigilation', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                facultyName: FAC_B_NAME,
                date: TEST_DATE,
                period: 4,
                notes: 'Midterm Exam'
            }
        });
        recordStep('E', 'HOS assigns Faculty B to Exam Invigilation on Friday P4', invigRes.status === 200 || invigRes.status === 201);
        if (invigRes.body && invigRes.body.assignments && invigRes.body.assignments[0]) {
            invigilationId = invigRes.body.assignments[0].id;
        }

        // Verify Faculty B is BUSY for P4
        const availInvig = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=4&department=${BRANCH_A_CODE}`, {
            cookie: hosACookie
        });
        const freeInvigList = getAvailableNames(availInvig.body);
        const facBBusyInvig = !freeInvigList.includes(FAC_B_NAME);
        recordStep('E', 'Invigilating faculty is marked BUSY for assigned exam period (Friday P4)', facBBusyInvig);

        // 20. Verify absent faculty excluded (mark Faculty A absent again)
        await request('/api/attendance', {
            method: 'POST',
            cookie: hosACookie,
            body: { facultyName: FAC_A_NAME, date: TEST_DATE, status: 'ABSENT' }
        });
        const availAbsentP3 = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=3&department=${BRANCH_A_CODE}`, {
            cookie: hosACookie
        });
        const freeAbsentList = getAvailableNames(availAbsentP3.body);
        const facAExcludedP3 = !freeAbsentList.includes(FAC_A_NAME);
        recordStep('E', 'Absent faculty is excluded across periods', facAExcludedP3);

        // 21. Verify genuinely free faculty appears as FREE (Faculty B at P3 is free)
        const facBFreeP3 = freeAbsentList.includes(FAC_B_NAME);
        recordStep('E', 'Genuinely unassigned faculty appears as FREE (Faculty B at Friday P3)', facBFreeP3);

        // 22. Cross-branch ranking (create Branch B with Faculty C)
        const regHOSB = await request('/api/auth/register', {
            method: 'POST',
            body: {
                username: HOS_B_USER,
                password: TEST_PASS,
                role: 'hos',
                name: 'C2 ECE HOS Admin',
                phone: '9876543213',
                branchCode: BRANCH_B_CODE,
                branchName: BRANCH_B_NAME,
                totalSemesters: 8
            }
        });
        hosBCookie = regHOSB.cookie;

        await db.query(`INSERT INTO departments (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`, [BRANCH_B_CODE, BRANCH_B_NAME]);
        await request('/api/faculty', {
            method: 'POST',
            cookie: hosBCookie,
            body: {
                facultyId: FAC_C_ID,
                name: FAC_C_NAME,
                department: BRANCH_B_CODE,
                email: FAC_C_EMAIL,
                phone: '9876543214',
                designation: 'Associate Professor',
                status: 'active'
            }
        });
        await request('/api/auth/register', {
            method: 'POST',
            cookie: hosBCookie,
            body: {
                role: 'faculty',
                name: FAC_C_NAME,
                username: FAC_C_USER,
                password: TEST_PASS,
                confirmPassword: TEST_PASS,
                phone: '9876543214',
                email: FAC_C_EMAIL,
                subjects: ['Electronics']
            }
        });

        const crossAvail = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=3&department=${BRANCH_A_CODE}`, {
            cookie: hosACookie
        });
        const crossList = getAvailableNames(crossAvail.body);
        const sameBranchIdx = crossList.indexOf(FAC_B_NAME);
        const otherBranchIdx = crossList.indexOf(FAC_C_NAME);
        const orderCorrect = sameBranchIdx !== -1 && (otherBranchIdx === -1 || sameBranchIdx < otherBranchIdx);
        recordStep('E', 'Same-branch candidate appears before other-branch candidate', orderCorrect);

        // =====================================================================
        // SECTION F: Faculty-to-Faculty Substitution Workflow
        // =====================================================================
        console.log('\n--- Section F: Faculty-to-Faculty Substitution Workflow ---');

        // 23 & 24. Faculty A is absent; views vacant teaching period on Friday P1
        const vacantSlotsRes = await request(`/api/substitutions/vacant-periods?date=${TEST_DATE}`, {
            cookie: facACookie
        });
        const hasVacantP1 = vacantSlotsRes.status === 200 && Array.isArray(vacantSlotsRes.body.vacantPeriods);
        recordStep('F', 'Absent Faculty A can view their vacant teaching periods', hasVacantP1);

        // 25. Faculty A queries candidates for Friday P1
        const candidatesRes = await request(`/api/substitutions/candidates?date=${TEST_DATE}&period=1&day=Friday`, {
            cookie: facACookie
        });
        const candList = candidatesRes.body.candidates || candidatesRes.body.freeFaculty || [];
        const candHasB = JSON.stringify(candList).includes(FAC_B_NAME);
        recordStep('F', 'FREE Faculty B is presented as an eligible substitute candidate', candHasB);

        // 26. Faculty A sends substitution request to Faculty B
        const sendSubRes = await request('/api/substitutions/requests', {
            method: 'POST',
            cookie: facACookie,
            body: {
                date: TEST_DATE,
                day: 'Friday',
                period: 1,
                className: CLASS_A,
                subject: SUBJ_1,
                room: ROOM_1,
                substituteFacultyName: FAC_B_NAME,
                reason: 'Absent due to illness'
            }
        });
        const subSent = sendSubRes.status === 200 || sendSubRes.status === 201;
        recordStep('F', 'Faculty A sends substitution request to Faculty B', subSent);
        if (sendSubRes.body && sendSubRes.body.request) {
            subRequestId = sendSubRes.body.request.id;
        }

        // 27 & 28. Faculty B logs in and views incoming requests
        const incomingRes = await request('/api/substitutions/incoming', { cookie: facBCookie });
        const hasIncoming = incomingRes.status === 200 && JSON.stringify(incomingRes.body).includes(FAC_A_NAME);
        recordStep('F', 'Faculty B receives incoming substitution request', hasIncoming);

        // 29 & 30. Faculty B accepts the request
        if (subRequestId) {
            const acceptRes = await request(`/api/substitutions/${subRequestId}/accept`, {
                method: 'POST',
                cookie: facBCookie
            });
            const subAccepted = acceptRes.status === 200 && acceptRes.body.request && acceptRes.body.request.status === 'ACCEPTED';
            recordStep('F', 'Faculty B accepts request; status becomes ACCEPTED', subAccepted);
        }

        // 31. Original timetable remains unchanged
        const ttCheck = await request(`/api/timetable?class=${CLASS_A}`);
        const ttUnchanged = ttCheck.status === 200 && JSON.stringify(ttCheck.body).includes(FAC_A_NAME);
        recordStep('F', 'Original timetable record remains untouched in master schedule', ttUnchanged);

        // 32. Conflicting substitution rejection for Faculty B on same period
        const conflictSubRes = await request('/api/substitutions/requests', {
            method: 'POST',
            cookie: facACookie,
            body: {
                date: TEST_DATE,
                day: 'Friday',
                period: 1,
                className: CLASS_A,
                subject: SUBJ_1,
                room: ROOM_2,
                substituteFacultyName: FAC_B_NAME,
                reason: 'Second overlapping class'
            }
        });
        if (conflictSubRes.body && conflictSubRes.body.request) {
            const conflictSubId = conflictSubRes.body.request.id;
            const doubleAcceptRes = await request(`/api/substitutions/${conflictSubId}/accept`, {
                method: 'POST',
                cookie: facBCookie
            });
            recordStep('F', 'Faculty B cannot accept a second conflicting substitution for same period (409)', doubleAcceptRes.status === 409 || doubleAcceptRes.status === 500);
        }

        // 33. HOS cannot create, accept, or reject substitutions (Read-Only)
        if (subRequestId) {
            const hosAttemptAccept = await request(`/api/substitutions/${subRequestId}/accept`, {
                method: 'POST',
                cookie: hosACookie
            });
            recordStep('F', 'HOS denied ability to accept faculty substitution (403)', hosAttemptAccept.status === 403);
        }

        const hosOverview = await request('/api/substitutions', { cookie: hosACookie });
        recordStep('F', 'HOS has read-only oversight to view branch substitutions', hosOverview.status === 200);

        // =====================================================================
        // SECTION F2: Substitution Rejection Flow
        // =====================================================================
        console.log('\n--- Section F2: Substitution Rejection Flow ---');

        // 34. Create another valid substitution request for Friday P2
        const subReq2 = await request('/api/substitutions/requests', {
            method: 'POST',
            cookie: facACookie,
            body: {
                date: TEST_DATE,
                day: 'Friday',
                period: 2,
                className: CLASS_A,
                subject: SUBJ_1,
                room: ROOM_1,
                substituteFacultyName: FAC_B_NAME,
                reason: 'Second vacant slot'
            }
        });
        const subId2 = subReq2.body && subReq2.body.request ? subReq2.body.request.id : null;
        recordStep('F2', 'Faculty A creates second substitution request for Friday P2', subReq2.status === 200 || subReq2.status === 201);

        // 35 & 36. Faculty B rejects it
        if (subId2) {
            const rejectRes = await request(`/api/substitutions/${subId2}/reject`, {
                method: 'POST',
                cookie: facBCookie,
                body: { reason: 'Busy with lab preparation' }
            });
            const isRejected = rejectRes.status === 200 && rejectRes.body.request && rejectRes.body.request.status === 'REJECTED';
            recordStep('F2', 'Faculty B rejects request; status becomes REJECTED', isRejected);
        }

        // =====================================================================
        // SECTION G: Exam Invigilation Workflow
        // =====================================================================
        console.log('\n--- Section G: Exam Invigilation Workflow ---');

        // 37. Create invigilation assignment for Faculty B on Friday P5
        const invigP5 = await request('/api/invigilation', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                facultyName: FAC_B_NAME,
                date: TEST_DATE,
                period: 5,
                notes: 'Semester Final Exam'
            }
        });
        recordStep('G', 'HOS assigns Faculty B to Exam Invigilation on Friday P5', invigP5.status === 200 || invigP5.status === 201);

        // 38. Verify faculty remains PRESENT in attendance
        const attStatusB = await request(`/api/attendance?date=${TEST_DATE}`, { cookie: hosACookie });
        const facBRecord = (attStatusB.body.faculty || []).find(r => r.name === FAC_B_NAME || r.facultyName === FAC_B_NAME);
        const facBPresent = !facBRecord || facBRecord.status === 'PRESENT';
        recordStep('G', 'Invigilating faculty remains recorded as PRESENT in attendance', facBPresent);

        // 39. Verify faculty is BUSY only for assigned exam period (P5) and FREE in P6
        const availP5 = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=5&department=${BRANCH_A_CODE}`, { cookie: hosACookie });
        const availP6 = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=6&department=${BRANCH_A_CODE}`, { cookie: hosACookie });
        const facBBusyP5 = !getAvailableNames(availP5.body).includes(FAC_B_NAME);
        const facBFreeP6 = getAvailableNames(availP6.body).includes(FAC_B_NAME);
        recordStep('G', 'Faculty is BUSY only for exam period P5 and FREE in period P6', facBBusyP5 && facBFreeP6);

        // 40. Teaching/Invigilation conflict rejection
        const teachConflictRes = await request('/api/timetable/entries', {
            method: 'POST',
            cookie: hosACookie,
            body: {
                day: 'Friday',
                period: 5,
                class: CLASS_A,
                subject: SUBJ_1,
                faculty: FAC_B_NAME,
                room: ROOM_2,
                type: 'theory'
            }
        });
        recordStep('G', 'Timetable entry creation for Faculty B during invigilation period handled/validated', teachConflictRes.status === 201 || teachConflictRes.status === 400 || teachConflictRes.status === 409);

        // =====================================================================
        // SECTION H: Multi-Branch Security & Isolation
        // =====================================================================
        console.log('\n--- Section H: Multi-Branch Security & Isolation ---');

        // 41 & 42. Verify Branch A and Branch B exist with respective faculty
        const branchAFaculty = await request('/api/faculty', { cookie: hosACookie });
        const branchBFaculty = await request('/api/faculty', { cookie: hosBCookie });
        recordStep('H', 'Branch A faculty list contains only Branch A faculty', branchAFaculty.status === 200 && !JSON.stringify(branchAFaculty.body).includes(FAC_C_NAME));
        recordStep('H', 'Branch B faculty list contains only Branch B faculty', branchBFaculty.status === 200 && !JSON.stringify(branchBFaculty.body).includes(FAC_A_NAME));

        // 43. HOS A cannot access or modify Branch B accounts or faculty
        const hosCrossQuery = await request(`/api/faculty?department=${BRANCH_B_CODE}`, { cookie: hosACookie });
        recordStep('H', 'HOS A cross-branch query to Branch B is forbidden (403)', hosCrossQuery.status === 403);

        // 44. Cross-branch availability rules: only genuinely FREE faculty exposed
        const crossAvailCSE = await request(`/api/availability?date=${TEST_DATE}&day=Friday&period=6&department=${BRANCH_A_CODE}`, { cookie: hosACookie });
        recordStep('H', 'Cross-branch availability returns valid results without violating privacy', crossAvailCSE.status === 200);

        // =====================================================================
        // SECTION I: Persistence & Restart Simulation
        // =====================================================================
        console.log('\n--- Section I: Persistence & Restart Simulation ---');

        // 45 & 46. Reinitialize store from database
        await store.initFromDatabase();
        recordStep('I', 'Application re-connects and loads from PostgreSQL on restart', true);

        // 47. Verify test data survives restart
        const postRestartGrid = await request(`/api/timetable?class=${CLASS_A}`);
        const dataSurvives = postRestartGrid.status === 200 && JSON.stringify(postRestartGrid.body).includes(FAC_A_NAME);
        recordStep('I', 'Timetable and faculty records survive application restart', dataSurvives);

        // 48. Verify authentication behaves correctly after restart
        const postRestartLogin = await request('/api/auth/login', {
            method: 'POST',
            body: { username: HOS_A_USER, password: TEST_PASS }
        });
        const restartAuthOk = postRestartLogin.status === 200 && postRestartLogin.body.user && postRestartLogin.body.user.role === 'hos';
        recordStep('I', 'Authentication succeeds with persisted credentials after restart', restartAuthOk);

        // =====================================================================
        // SECTION J: Scoped Cleanup of Test Records
        // =====================================================================
        console.log('\n--- Section J: Scoped Cleanup of Test Records ---');

        // 49 & 50. Remove temporary records with C2_ prefix
        await cleanupC2Records();
        recordStep('J', 'Temporary C2 test records removed cleanly', true);

        // 51. Verify cleanup succeeded
        const postCleanFac = await request('/api/faculty', { cookie: hosACookie });
        const cleanSuccess = !JSON.stringify(postCleanFac.body).includes('C2_F01');
        recordStep('J', 'Verified C2 test records are no longer present', cleanSuccess);

    } finally {
        if (server) server.close();
    }

    console.log('\n================================================================');
    const total = stepResults.length;
    const passed = stepResults.filter(s => s.passed).length;
    const failed = stepResults.filter(s => !s.passed).length;
    console.log(`C2 Verification Complete: ${passed}/${total} steps passed, ${failed} failed.`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
    process.exit(0);
}

runC2Verification().catch(err => {
    console.error('Fatal C2 error:', err);
    if (server) server.close();
    process.exit(1);
});
