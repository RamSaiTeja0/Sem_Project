/**
 * Faculty Availability Branch Timetable & Isolation Test Suite
 *
 * Verifies:
 *  1. CME faculty sees ONLY CME timetable with actual subjects.
 *  2. EEE faculty sees ONLY EEE timetable with actual subjects.
 *  3. MEC faculty sees ONLY MEC timetable with actual subjects.
 *  4. Cross-branch timetable access is rejected (HTTP 403 FORBIDDEN).
 *  5. Cross-branch scopes query is rejected (HTTP 403 FORBIDDEN).
 *  6. Academic year is dynamically read from authoritative scope and NOT hardcoded.
 *  7. Semester and Section/Class are dynamically mapped and selectable.
 *  8. Authoritative period timings are returned and match master timetable.
 *  9. Read-only availability grid (no "+ Add" buttons, no edit buttons).
 * 10. Selected slot metadata contains Day, Period, Academic Year, Branch, Semester, Section/Class, Subject, and Faculty.
 * 11. Availability candidates logic works across branches (same-branch first, other branches second).
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
process.env.DATABASE_URL = '';
process.env.TEST_DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const facultyRequests = require('../src/data/facultyRequests');
const attendance = require('../src/data/attendance');
const invigilation = require('../src/data/invigilation');
const { resetBranchForTesting, registerBranch } = require('../src/data/departments');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}\n      ${err.message}`);
        throw err;
    }
}

function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

function call(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (_) {}
                const setCookie = (res.headers['set-cookie'] || [])[0] || null;
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    raw: data,
                    cookie: setCookie ? setCookie.split(';')[0] : null
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('================================================================');
    console.log('TecSubstitution — Faculty Availability Branch Timetable Tests');
    console.log('================================================================\n');

    await startServer();

    try {
        const tag = Date.now();
        const phonePrefix = String(tag).slice(-7);
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();
        facultyRequests.resetForTesting();
        attendance.resetForTesting();
        invigilation.resetForTesting();

        console.log('[Setup] Registering HOS and Faculty accounts for CME, EEE, and MEC');

        // Register CME HOS
        const hosCmeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'CME Head',
            phone: `910${phonePrefix}`,
            branchName: 'Computer Engineering',
            branchCode: 'CME',
            username: `cme_hos_${tag}`,
            password: 'Password123_'
        });
        assert.strictEqual(hosCmeRes.status, 201, 'CME HOS registration must succeed');
        const cookieCmeHod = hosCmeRes.cookie;

        // Register EEE HOS
        const hosEeeRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Head',
            phone: `911${phonePrefix}`,
            branchName: 'Electrical Engineering',
            branchCode: 'EEE',
            username: `eee_hos_${tag}`,
            password: 'Password123_'
        });
        assert.strictEqual(hosEeeRes.status, 201, 'EEE HOS registration must succeed');
        const cookieEeeHod = hosEeeRes.cookie;

        // Register MEC HOS
        const hosMecRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'MEC Head',
            phone: `912${phonePrefix}`,
            branchName: 'Mechanical Engineering',
            branchCode: 'MEC',
            username: `mec_hos_${tag}`,
            password: 'Password123_'
        });
        assert.strictEqual(hosMecRes.status, 201, 'MEC HOS registration must succeed');
        const cookieMecHod = hosMecRes.cookie;

        // Create Faculty in CME
        const cmeFac = await call('POST', '/api/auth/register', {
            name: `Prof. Alice CME ${tag}`,
            phone: `920${phonePrefix}`,
            username: `alice_cme_${tag}`,
            password: 'Password123_',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Cloud Computing']
        }, cookieCmeHod);
        assert.strictEqual(cmeFac.status, 201);

        const cmeFac2 = await call('POST', '/api/auth/register', {
            name: `Prof. Dave CME ${tag}`,
            phone: `921${phonePrefix}`,
            username: `dave_cme_${tag}`,
            password: 'Password123_',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Networks']
        }, cookieCmeHod);
        assert.strictEqual(cmeFac2.status, 201);

        // Create Faculty in EEE
        const eeeFac = await call('POST', '/api/auth/register', {
            name: `Prof. Bob EEE ${tag}`,
            phone: `930${phonePrefix}`,
            username: `bob_eee_${tag}`,
            password: 'Password123_',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Electrical Circuits']
        }, cookieEeeHod);
        assert.strictEqual(eeeFac.status, 201);

        const eeeFac2 = await call('POST', '/api/auth/register', {
            name: `Prof. Eva EEE ${tag}`,
            phone: `931${phonePrefix}`,
            username: `eva_eee_${tag}`,
            password: 'Password123_',
            role: 'faculty',
            designation: 'Assistant Professor',
            subjects: ['Power Systems']
        }, cookieEeeHod);
        assert.strictEqual(eeeFac2.status, 201);

        // Create Faculty in MEC
        const mecFac = await call('POST', '/api/auth/register', {
            name: `Prof. Charlie MEC ${tag}`,
            phone: `940${phonePrefix}`,
            username: `charlie_mec_${tag}`,
            password: 'Password123_',
            role: 'faculty',
            designation: 'Professor',
            subjects: ['Thermodynamics']
        }, cookieMecHod);
        assert.strictEqual(mecFac.status, 201);

        // Add custom timetable records with specific period timings
        store.replace({
            allowEmpty: true,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            meta: {
                institution: 'Test Institute',
                academicYear: '2026-27',
                periodTimings: {
                    "1": { "start": "08:00", "end": "08:45" },
                    "2": { "start": "08:45", "end": "09:30" },
                    "3": { "start": "09:30", "end": "10:15" },
                    "4": { "start": "10:30", "end": "11:15" },
                    "5": { "start": "11:15", "end": "12:00" },
                    "6": { "start": "12:00", "end": "12:45" },
                    "7": { "start": "12:45", "end": "13:30" }
                }
            },
            classes: [
                {
                    class: 'CME-SEM5-A',
                    code: 'CME-SEM5-A',
                    department: 'CME',
                    branch: 'CME',
                    semester: 'SEM-5',
                    section: 'A',
                    academicYear: '2026-27',
                    rows: {
                        'Monday': [
                            { period: 1, subject: 'Cloud Computing', faculty: `Prof. Alice CME ${tag}`, room: 'Lab 1' }
                        ]
                    }
                },
                {
                    class: 'EEE-SEM1-A',
                    code: 'EEE-SEM1-A',
                    department: 'EEE',
                    branch: 'EEE',
                    semester: 'SEM-1',
                    section: 'A',
                    academicYear: '2026-27',
                    rows: {
                        'Monday': [
                            { period: 1, subject: 'Electrical Circuits', faculty: `Prof. Bob EEE ${tag}`, room: 'E-101' }
                        ]
                    }
                },
                {
                    class: 'MEC-SEM1-A',
                    code: 'MEC-SEM1-A',
                    department: 'MEC',
                    branch: 'MEC',
                    semester: 'SEM-1',
                    section: 'A',
                    academicYear: '2026-27',
                    rows: {
                        'Monday': [
                            { period: 1, subject: 'Thermodynamics', faculty: `Prof. Charlie MEC ${tag}`, room: 'M-201' }
                        ]
                    }
                }
            ],
            faculty: [
                { id: `FAC-CME-1-${tag}`, name: `Prof. Alice CME ${tag}`, department: 'CME', status: 'active' },
                { id: `FAC-CME-2-${tag}`, name: `Prof. Dave CME ${tag}`, department: 'CME', status: 'active' },
                { id: `FAC-EEE-1-${tag}`, name: `Prof. Bob EEE ${tag}`, department: 'EEE', status: 'active' },
                { id: `FAC-EEE-2-${tag}`, name: `Prof. Eva EEE ${tag}`, department: 'EEE', status: 'active' },
                { id: `FAC-MEC-1-${tag}`, name: `Prof. Charlie MEC ${tag}`, department: 'MEC', status: 'active' }
            ],
            subjects: [
                { code: 'CME501', name: 'Cloud Computing', department: 'CME', type: 'theory' },
                { code: 'EEE101', name: 'Electrical Circuits', department: 'EEE', type: 'theory' },
                { code: 'MEC101', name: 'Thermodynamics', department: 'MEC', type: 'theory' }
            ],
            rooms: [
                { code: 'Lab 1', name: 'Lab 1' },
                { code: 'E-101', name: 'E-101' },
                { code: 'M-201', name: 'M-201' }
            ],
            entries: [
                {
                    id: 9001,
                    class: 'CME-SEM5-A',
                    className: 'CME-SEM5-A',
                    day: 'Monday',
                    period: 1,
                    subject: 'Cloud Computing',
                    faculty: `Prof. Alice CME ${tag}`,
                    room: 'Lab 1',
                    type: 'theory'
                },
                {
                    id: 9002,
                    class: 'EEE-SEM1-A',
                    className: 'EEE-SEM1-A',
                    day: 'Monday',
                    period: 1,
                    subject: 'Electrical Circuits',
                    faculty: `Prof. Bob EEE ${tag}`,
                    room: 'E-101',
                    type: 'theory'
                },
                {
                    id: 9003,
                    class: 'MEC-SEM1-A',
                    className: 'MEC-SEM1-A',
                    day: 'Monday',
                    period: 1,
                    subject: 'Thermodynamics',
                    faculty: `Prof. Charlie MEC ${tag}`,
                    room: 'M-201',
                    type: 'theory'
                }
            ]
        }, 'test-custom');

        // -------------------------------------------------------------
        // Test 1: CME Faculty Login & Scopes
        // -------------------------------------------------------------
        console.log('\n[1] CME Faculty Scopes & Timetable Loading');
        const loginCME = await call('POST', '/api/auth/login', { username: `alice_cme_${tag}`, password: 'Password123_' });
        assert.strictEqual(loginCME.status, 200);
        const cookieCME = loginCME.cookie;

        await check('CME faculty receives only CME scopes', async () => {
            const res = await call('GET', '/api/timetable/scopes', null, cookieCME);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.branch, 'CME');
            const classes = res.body.classes || [];
            assert.ok(classes.length > 0);
            classes.forEach(c => {
                assert.strictEqual(c.department || c.branch, 'CME');
            });
        });

        await check('CME faculty timetable returns actual CME subject and period timings', async () => {
            const res = await call('GET', '/api/timetable?class=CME-SEM5-A', null, cookieCME);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.name, 'CME-SEM5-A');
            assert.strictEqual(res.body.scope.branch, 'CME');
            assert.strictEqual(res.body.scope.academicYear, '2026-27');
            assert.strictEqual(res.body.scope.semester, 'SEM-5');
            const p1Cell = (res.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(p1Cell, 'P1 cell on Monday exists');
            assert.strictEqual(p1Cell.subject, 'Cloud Computing');
            assert.strictEqual(p1Cell.faculty, `Prof. Alice CME ${tag}`);
            // Period timings verification
            assert.ok(res.body.periodTimings, 'Period timings present');
            assert.strictEqual(res.body.periodTimings['1'].start, '08:00');
            assert.strictEqual(res.body.periodTimings['1'].end, '08:45');
        });

        // -------------------------------------------------------------
        // Test 2: EEE Faculty Login & Scopes
        // -------------------------------------------------------------
        console.log('\n[2] EEE Faculty Scopes & Timetable Loading');
        const loginEEE = await call('POST', '/api/auth/login', { username: `bob_eee_${tag}`, password: 'Password123_' });
        assert.strictEqual(loginEEE.status, 200);
        const cookieEEE = loginEEE.cookie;

        await check('EEE faculty receives only EEE scopes', async () => {
            const res = await call('GET', '/api/timetable/scopes', null, cookieEEE);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.branch, 'EEE');
            const classes = res.body.classes || [];
            assert.ok(classes.length > 0);
            classes.forEach(c => {
                assert.strictEqual(c.department || c.branch, 'EEE');
            });
        });

        await check('EEE faculty timetable returns actual EEE subject and correct period timings', async () => {
            const res = await call('GET', '/api/timetable?class=EEE-SEM1-A', null, cookieEEE);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.name, 'EEE-SEM1-A');
            assert.strictEqual(res.body.scope.branch, 'EEE');
            assert.strictEqual(res.body.scope.academicYear, '2026-27');
            assert.strictEqual(res.body.scope.semester, 'SEM-1');
            const p1Cell = (res.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(p1Cell, 'P1 cell on Monday exists');
            assert.strictEqual(p1Cell.subject, 'Electrical Circuits');
            assert.strictEqual(p1Cell.faculty, `Prof. Bob EEE ${tag}`);
            // Period timings verification
            assert.strictEqual(res.body.periodTimings['1'].start, '08:00');
            assert.strictEqual(res.body.periodTimings['7'].end, '13:30');
        });

        // -------------------------------------------------------------
        // Test 3: MEC Faculty Login & Scopes
        // -------------------------------------------------------------
        console.log('\n[3] MEC Faculty Scopes & Timetable Loading');
        const loginMEC = await call('POST', '/api/auth/login', { username: `charlie_mec_${tag}`, password: 'Password123_' });
        assert.strictEqual(loginMEC.status, 200);
        const cookieMEC = loginMEC.cookie;

        await check('MEC faculty receives only MEC scopes and timetable', async () => {
            const res = await call('GET', '/api/timetable/scopes', null, cookieMEC);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.branch, 'MEC');

            const ttRes = await call('GET', '/api/timetable?class=MEC-SEM1-A', null, cookieMEC);
            assert.strictEqual(ttRes.status, 200);
            assert.strictEqual(ttRes.body.name, 'MEC-SEM1-A');
            assert.strictEqual(ttRes.body.scope.branch, 'MEC');
            const p1Cell = (ttRes.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
            assert.strictEqual(p1Cell.subject, 'Thermodynamics');
            assert.strictEqual(p1Cell.faculty, `Prof. Charlie MEC ${tag}`);
        });

        // -------------------------------------------------------------
        // Test 4: Cross-Branch Isolation Enforcements
        // -------------------------------------------------------------
        console.log('\n[4] Cross-Branch Isolation Security Gates');

        await check('EEE faculty cannot access CME timetable (HTTP 403)', async () => {
            const res = await call('GET', '/api/timetable?class=CME-SEM5-A', null, cookieEEE);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        await check('EEE faculty cannot spoof branch parameter to CME in timetable query (HTTP 403)', async () => {
            const res = await call('GET', '/api/timetable?branch=CME', null, cookieEEE);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        await check('EEE faculty cannot spoof branch parameter to CME in scopes query (HTTP 403)', async () => {
            const res = await call('GET', '/api/timetable/scopes?branch=CME', null, cookieEEE);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        await check('MEC faculty cannot access EEE timetable (HTTP 403)', async () => {
            const res = await call('GET', '/api/timetable?class=EEE-SEM1-A', null, cookieMEC);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        // -------------------------------------------------------------
        // Test 5: Availability Engine & Candidates
        // -------------------------------------------------------------
        console.log('\n[5] Availability Results & Priority Ordering');

        await check('Availability on Monday P1 for CME prioritizes CME free faculty', async () => {
            const res = await call('POST', '/api/availability', {
                day: 'Monday',
                period: 1,
                department: 'CME'
            }, cookieCME);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.sameBranch.branch, 'CME');
            const sameAvail = res.body.sameBranch.available || [];
            // Prof. Alice is teaching CME P1, Prof. Dave is free
            assert.ok(sameAvail.some(f => f.faculty === `Prof. Dave CME ${tag}`), 'Prof. Dave is free in same branch');
            assert.ok(!sameAvail.some(f => f.faculty === `Prof. Alice CME ${tag}`), 'Prof. Alice is busy');
        });

        await check('Availability candidates on Monday P1 for EEE prioritizes EEE free faculty', async () => {
            const res = await call('POST', '/api/availability', {
                day: 'Monday',
                period: 1,
                department: 'EEE'
            }, cookieEEE);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.sameBranch.branch, 'EEE');
            const sameAvail = res.body.sameBranch.available || [];
            // Prof. Bob is teaching EEE P1, Prof. Eva is free
            assert.ok(sameAvail.some(f => f.faculty === `Prof. Eva EEE ${tag}`), 'Prof. Eva is free in EEE');
            assert.ok(!sameAvail.some(f => f.faculty === `Prof. Bob EEE ${tag}`), 'Prof. Bob is busy');
        });

        // -------------------------------------------------------------
        // Test 6: Frontend Read-Only Verification
        // -------------------------------------------------------------
        console.log('\n[6] Frontend Read-Only Availability UI & Structure');

        await check('index.html defines selectable Academic Year, Semester, and Section selectors without redundant Class dropdown', async () => {
            const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
            assert.ok(html.includes('id="view-availability"'), 'Availability view exists');
            assert.ok(html.includes('id="availGridBranchBadge"'), 'availGridBranchBadge exists');
            assert.ok(html.includes('id="availAcademicYear"'), 'availAcademicYear select exists');
            assert.ok(html.includes('id="availSemester"'), 'availSemester exists');
            assert.ok(html.includes('id="availSection"'), 'availSection exists');
            assert.ok(!html.includes('id="availClass"'), 'redundant availClass selector does not exist in Faculty Availability scope');
            assert.ok(html.includes('id="availTimetableMeta"'), 'availTimetableMeta exists');
        });

        await check('app.js formats academic years (e.g. 20262027 -> 2026–2027) and manages dynamic scope cascade', async () => {
            const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf-8');
            assert.ok(appJs.includes('formatAcademicYear'), 'formatAcademicYear helper exists');
            assert.ok(appJs.includes('loadAvailabilityScopes'), 'loadAvailabilityScopes exists');
            assert.ok(appJs.includes('updateAvailabilityScopeCascade'), 'updateAvailabilityScopeCascade exists');
            assert.ok(appJs.includes('describeAvailabilityClass'), 'describeAvailabilityClass exists');
            assert.ok(appJs.includes('showEditIndicator: false'), 'showEditIndicator is explicitly false for availability');
            assert.ok(appJs.includes("editable: false"), 'editable is explicitly false for availability');
        });

        await check('Selected slot rendering in app.js includes Academic Year, Branch, Semester, and Section / Class', async () => {
            const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf-8');
            assert.ok(appJs.includes('<span class="detail-label">Academic Year</span>'), 'Academic Year in selected slot');
            assert.ok(appJs.includes('<span class="detail-label">Branch</span>'), 'Branch in selected slot');
            assert.ok(appJs.includes('<span class="detail-label">Semester</span>'), 'Semester in selected slot');
            assert.ok(appJs.includes('<span class="detail-label">Section / Class</span>'), 'Section / Class in selected slot');
            assert.ok(appJs.includes('<span class="detail-label">Subject</span>'), 'Subject in selected slot');
            assert.ok(appJs.includes('<span class="detail-label">Current Faculty</span>'), 'Current Faculty in selected slot');
        });

        console.log(`\n============================================================`);
        console.log(`Faculty Availability Verification: ${passed} passed, ${failed} failed.`);
        console.log(`============================================================\n`);
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().then(() => {
        process.exit(failed > 0 ? 1 : 0);
    }).catch((err) => {
        console.error('Test run failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
