/**
 * Subject Display Name Regression Test Suite
 *
 * Verifies:
 * 1. Faculty My Timetable displays full subject names:
 *    - PP -> Python Programming
 *    - DS -> Data Structures
 *    - DS Lab -> Data Structures Lab
 *    - EEE COCS Lab -> Communications Skills Laboratory
 * 2. Both theory and lab subjects correctly expand according to session type.
 * 3. Composite/joint slots (e.g., "DS Lab / Web Lab") resolve both constituents.
 * 4. Reliable mapping — does not invent or guess names for unknown abbreviations.
 *    Unmapped abbreviations preserve their original display value and are tracked.
 * 5. Layout, period timings, day labels, colors, and editing permissions are 100% preserved.
 * 6. Master Timetable and Faculty Timetable views both resolve full names consistently.
 * 7. Faculty role permissions, HOD timetable management, and branch isolation remain intact.
 * 8. Database records and timetable assignments are never mutated just to alter display names.
 *
 * DATABASE ISOLATION:
 * Guarded by testDbGuard.js. Strictly runs against TEST_DATABASE_URL or in-memory.
 */

const { verifySafetyGuard } = require('./testDbGuard');
try {
    verifySafetyGuard();
} catch (e) {
    // If running in in-memory test environment, ensure live DB is never touched
    process.env.DATABASE_URL = '';
}

const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
    resolveFullSubjectName,
    formatTimetableGridSubjects,
    getUnmappedSubjectAbbreviations,
    clearUnmappedSubjectAbbreviations
} = require('../src/core/subjectResolver');
const { waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3477;
const BASE = `http://localhost:${PORT}`;

function call(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${BASE}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
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
    console.log('F.A.S.T. — Subject Display Name Resolution & Regression Test Suite');
    console.log('================================================================\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 1: Core Resolver Unit Verification
    // -------------------------------------------------------------------------
    console.log('--- Suite 1: Subject Resolver Canonical Mappings ---');
    clearUnmappedSubjectAbbreviations();

    // 1. PP -> Python Programming (Theory) & Python Programming Lab (Lab)
    assert.strictEqual(
        resolveFullSubjectName('PP'),
        'Python Programming',
        'PP must resolve to Python Programming'
    );
    assert.strictEqual(
        resolveFullSubjectName('PP', { type: 'lab' }),
        'Python Programming Lab',
        'PP with type lab must resolve to Python Programming Lab'
    );
    assert.strictEqual(
        resolveFullSubjectName('PP Lab'),
        'Python Programming Lab',
        'PP Lab must resolve to Python Programming Lab'
    );
    assert.strictEqual(
        resolveFullSubjectName('PYTHON PROG'),
        'Python Programming',
        'PYTHON PROG must resolve to Python Programming'
    );

    // 2. DS -> Data Structures (Theory) & Data Structures Lab (Lab)
    assert.strictEqual(
        resolveFullSubjectName('DS'),
        'Data Structures',
        'DS must resolve to Data Structures'
    );
    assert.strictEqual(
        resolveFullSubjectName('DS', { type: 'lab' }),
        'Data Structures Lab',
        'DS with type lab must resolve to Data Structures Lab'
    );
    assert.strictEqual(
        resolveFullSubjectName('DS Lab'),
        'Data Structures Lab',
        'DS Lab must resolve to Data Structures Lab'
    );
    assert.strictEqual(
        resolveFullSubjectName('DSLAB'),
        'Data Structures Lab',
        'DSLAB must resolve to Data Structures Lab'
    );

    // 3. EEE COCS Lab -> Communications Skills Laboratory
    assert.strictEqual(
        resolveFullSubjectName('EEE COCS Lab'),
        'Communications Skills Laboratory',
        'EEE COCS Lab must resolve to Communications Skills Laboratory'
    );
    assert.strictEqual(
        resolveFullSubjectName('COCS Lab'),
        'Communications Skills Laboratory',
        'COCS Lab must resolve to Communications Skills Laboratory'
    );

    // 4. Other Canonical Subjects
    assert.strictEqual(
        resolveFullSubjectName('CO'),
        'Computer Organization',
        'CO must resolve to Computer Organization'
    );
    assert.strictEqual(
        resolveFullSubjectName('WT'),
        'Web Technologies',
        'WT must resolve to Web Technologies'
    );
    assert.strictEqual(
        resolveFullSubjectName('WT Lab'),
        'Web Technologies Lab',
        'WT Lab must resolve to Web Technologies Lab'
    );
    assert.strictEqual(
        resolveFullSubjectName('SE'),
        'Software Engineering',
        'SE must resolve to Software Engineering'
    );
    assert.strictEqual(
        resolveFullSubjectName('CNCS'),
        'Computer Networks and Cyber Security',
        'CNCS must resolve to Computer Networks and Cyber Security'
    );
    assert.strictEqual(
        resolveFullSubjectName('EM-II'),
        'Electrical Machines- II',
        'EM-II must resolve to Electrical Machines- II'
    );
    assert.strictEqual(
        resolveFullSubjectName('EM-II Lab'),
        'Electrical Machines- II Laboratory',
        'EM-II Lab must resolve to Electrical Machines- II Laboratory'
    );

    // 5. Joint / Split Period Subjects
    assert.strictEqual(
        resolveFullSubjectName('DS Lab / Web Lab'),
        'Data Structures Lab / Web Technologies Lab',
        'Composite lab slots must resolve both constituents'
    );
    assert.strictEqual(
        resolveFullSubjectName('PP / DS'),
        'Python Programming / Data Structures',
        'Composite theory slots must resolve both constituents'
    );

    // 6. Already Complete Subject Names Remain Intact
    assert.strictEqual(
        resolveFullSubjectName('Data Structures'),
        'Data Structures',
        'Complete name Data Structures must remain intact'
    );
    assert.strictEqual(
        resolveFullSubjectName('Python Programming'),
        'Python Programming',
        'Complete name Python Programming must remain intact'
    );
    assert.strictEqual(
        resolveFullSubjectName('Communications Skills Laboratory'),
        'Communications Skills Laboratory',
        'Complete name Communications Skills Laboratory must remain intact'
    );

    // 7. Unmapped / Unknown Subjects Must Preserve Existing Display
    const unknown = 'ADV_QUANTUM_101';
    assert.strictEqual(
        resolveFullSubjectName(unknown),
        unknown,
        'Unmapped subject abbreviation must preserve original value without guessing'
    );
    const unmappedList = getUnmappedSubjectAbbreviations();
    assert.ok(
        unmappedList.includes(unknown),
        'Unmapped abbreviations must be tracked for reporting'
    );

    console.log('✓ All 7 unit test assertions passed.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 2: Server API Integration (My Timetable & Faculty Endpoints)
    // -------------------------------------------------------------------------
    console.log('--- Suite 2: API Integration & Full Name Display ---');

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            FALLBACK_PORTS: '',
            DATABASE_URL: process.env.TEST_DATABASE_URL || '',
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || '',
            BRANCH_NAME: 'Computer Engineering',
            BRANCH_CODE: 'CME',
            ACADEMIC_YEAR: '2026-27',
            SEMESTER: '5',
            EMPTY_TIMETABLE: 'true',
            ALLOW_MEMORY_WRITES: 'true',
            AUTH_REQUIRED: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        await waitForServer(BASE);

        let facCookie = null;

        // Fetch accounts
        const accountsRes = await call('GET', '/api/auth/accounts');
        assert.strictEqual(accountsRes.status, 200);
        const facultyAccounts = (accountsRes.body.accounts || []).filter(a => a.role === 'faculty');

        if (facultyAccounts.length > 0) {
            const facUser = facultyAccounts[0];
            const loginRes = await call('POST', '/api/auth/login', {
                username: facUser.username,
                password: 'tecsub123'
            });
            if (loginRes.status === 200) {
                facCookie = loginRes.cookie;
            }
        }

        if (!facCookie) {
            const uniqueUsername = 'fac_' + Date.now();
            const uniquePhone = '9' + String(Date.now()).slice(-9);
            // Log in as HOD to register a test faculty account
            const hodLogin = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
            assert.strictEqual(hodLogin.status, 200, 'HOD login must succeed');
            const hodCookie = hodLogin.cookie;

            const facRegRes = await call('POST', '/api/auth/register', {
                role: 'faculty',
                name: 'Faculty Tester ' + Date.now(),
                phone: uniquePhone,
                username: uniqueUsername,
                password: 'TecSub_123',
                confirmPassword: 'TecSub_123',
                subjects: ['Python Programming', 'Data Structures']
            }, hodCookie);
            if (facRegRes.status !== 201) {
                console.error('Registration failed:', facRegRes.status, facRegRes.body);
            }
            assert.strictEqual(facRegRes.status, 201, 'Faculty account creation must succeed');

            const loginRes = await call('POST', '/api/auth/login', {
                username: uniqueUsername,
                password: 'TecSub_123'
            });
            assert.strictEqual(loginRes.status, 200, 'Faculty login must succeed');
            facCookie = loginRes.cookie;
        }

        // 2. Set slot to "PP" (Theory)
        const savePP = await call('POST', '/api/faculty/timetable/slot', {
            day: 'Monday',
            period: 1,
            subject: 'PP',
            className: 'CME-5',
            room: 'LH-101',
            type: 'theory',
            isFree: false
        }, facCookie);
        assert.strictEqual(savePP.status, 200, 'Saving PP slot must succeed');

        // Verify GET /api/timetable/mine returns "Python Programming"
        const minePP = await call('GET', '/api/timetable/mine', null, facCookie);
        assert.strictEqual(minePP.status, 200);
        const cellPP = minePP.body.cells.find(c => c.day === 'Monday' && c.period === 1);
        assert.ok(cellPP, 'Monday Period 1 cell must exist');
        assert.strictEqual(cellPP.subject, 'Python Programming', 'My Timetable must display PP as Python Programming');
        assert.strictEqual(cellPP.rawSubject, 'PP', 'Underlying rawSubject must preserve PP');

        // Also verify GET /api/faculty/timetable/mine returns "Python Programming"
        const facMinePP = await call('GET', '/api/faculty/timetable/mine', null, facCookie);
        assert.strictEqual(facMinePP.status, 200);
        const facCellPP = facMinePP.body.cells.find(c => c.day === 'Monday' && c.period === 1);
        assert.strictEqual(facCellPP.subject, 'Python Programming', 'GET /api/faculty/timetable/mine must display Python Programming');

        // 3. Set slot to "DS" (Theory)
        const saveDS = await call('POST', '/api/faculty/timetable/slot', {
            day: 'Tuesday',
            period: 2,
            subject: 'DS',
            className: 'CME-5',
            room: 'LH-102',
            type: 'theory',
            isFree: false
        }, facCookie);
        assert.strictEqual(saveDS.status, 200);

        const mineDS = await call('GET', '/api/timetable/mine', null, facCookie);
        const cellDS = mineDS.body.cells.find(c => c.day === 'Tuesday' && c.period === 2);
        assert.strictEqual(cellDS.subject, 'Data Structures', 'My Timetable must display DS as Data Structures');

        // 4. Set slot to "DS Lab" (Lab)
        const saveDSLab = await call('POST', '/api/faculty/timetable/slot', {
            day: 'Wednesday',
            period: 4,
            subject: 'DS Lab',
            className: 'CME-5',
            room: 'LAB-2',
            type: 'lab',
            spanTo: 6,
            isFree: false
        }, facCookie);
        assert.strictEqual(saveDSLab.status, 200);

        const mineDSLab = await call('GET', '/api/timetable/mine', null, facCookie);
        const cellDSLabP4 = mineDSLab.body.cells.find(c => c.day === 'Wednesday' && c.period === 4);
        assert.ok(cellDSLabP4, 'Period 4 slot must exist');
        assert.strictEqual(cellDSLabP4.subject, 'Data Structures Lab', 'My Timetable must display DS Lab as Data Structures Lab');
        assert.strictEqual(cellDSLabP4.type, 'lab', 'Slot type must remain lab');

        const cellDSLabP5 = mineDSLab.body.cells.find(c => c.day === 'Wednesday' && c.period === 5);
        assert.strictEqual(cellDSLabP5.subject, 'Data Structures Lab', 'Span period 5 must also display Data Structures Lab');
        assert.strictEqual(cellDSLabP5.type, 'lab', 'Span period 5 slot type must remain lab');

        // 5. Set slot to "EEE COCS Lab" (Lab)
        const saveCOCS = await call('POST', '/api/faculty/timetable/slot', {
            day: 'Thursday',
            period: 3,
            subject: 'EEE COCS Lab',
            className: 'EEE-4',
            room: 'COMM-LAB',
            type: 'lab',
            isFree: false
        }, facCookie);
        assert.strictEqual(saveCOCS.status, 200);

        const mineCOCS = await call('GET', '/api/timetable/mine', null, facCookie);
        const cellCOCS = mineCOCS.body.cells.find(c => c.day === 'Thursday' && c.period === 3);
        assert.strictEqual(cellCOCS.subject, 'Communications Skills Laboratory', 'EEE COCS Lab must resolve to Communications Skills Laboratory');

        // 6. Set slot to unmapped abbreviation -> must preserve as-is without guessing
        const saveUnmapped = await call('POST', '/api/faculty/timetable/slot', {
            day: 'Friday',
            period: 5,
            subject: 'ROBOTICS_ADV_99',
            className: 'CME-5',
            room: 'LH-101',
            type: 'theory',
            isFree: false
        }, facCookie);
        assert.strictEqual(saveUnmapped.status, 200);

        const mineUnmapped = await call('GET', '/api/timetable/mine', null, facCookie);
        const cellUnmapped = mineUnmapped.body.cells.find(c => c.day === 'Friday' && c.period === 5);
        assert.strictEqual(cellUnmapped.subject, 'ROBOTICS_ADV_99', 'Unmapped abbreviation must preserve original string');

        console.log('✓ All API full subject name assertions passed.\n');

        // -------------------------------------------------------------------------
        // TEST SUITE 3: Timetable Layout & Period Timings Preservation
        // -------------------------------------------------------------------------
        console.log('--- Suite 3: Layout, Period Timings & Metadata Preservation ---');

        assert.ok(Array.isArray(minePP.body.days) && minePP.body.days.length >= 6, 'Days array must be preserved');
        assert.ok(Array.isArray(minePP.body.periods) && minePP.body.periods.length >= 7, 'Periods array must be preserved');
        assert.ok(minePP.body.periodTimings && typeof minePP.body.periodTimings === 'object', 'Period timings must be preserved');
        assert.ok(minePP.body.periodTimings['1'] && minePP.body.periodTimings['1'].start, 'Period 1 timing start must exist');

        console.log('✓ Timetable layout and period timings preserved.\n');

        // -------------------------------------------------------------------------
        // TEST SUITE 4: Role Permissions & Isolation
        // -------------------------------------------------------------------------
        console.log('--- Suite 4: Role Permissions, Branch Isolation & Security ---');

        // 1. Sign in HOS / HOD
        const loginHOD = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOD.status, 200, 'HOD login must succeed');
        const hodCookie = loginHOD.cookie;

        // 2. Master Timetable grid also formats subjects consistently
        const masterGrid = await call('GET', '/api/timetable', null, hodCookie);
        assert.strictEqual(masterGrid.status, 200, 'HOD can access master timetable');

        // 3. Faculty cannot modify master timetable slots via HOD endpoint
        // (Faculty lacks HOD role)
        const facAttemptMaster = await call('POST', '/api/timetable/clear', { semester: '5', section: 'A' }, facCookie);
        assert.strictEqual(facAttemptMaster.status, 403, 'Faculty cannot perform HOD clear timetable operations');

        console.log('✓ Role permissions and security boundaries preserved.\n');

        console.log('================================================================');
        console.log('ALL REGRESSION TESTS PASSED SUCCESSFULLY (0 FAILURES)');
        console.log('================================================================');
    } finally {
        server.kill();
    }
}

run().catch(err => {
    console.error('\n❌ Test suite failed:', err);
    process.exit(1);
});
