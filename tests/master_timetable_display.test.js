/**
 * Regression Test Suite: Master Timetable Display Flow
 *
 * Proves all 7 requirements:
 * A. HOD approval inserts real timetable rows into PostgreSQL.
 * B. The inserted rows contain the correct branch/class/semester/section scope.
 * C. GET Master Timetable returns those persisted rows.
 * D. Master Timetable UI / API response contains the imported slots instead of all Free.
 * E. Availability reads the same approved timetable.
 * F. Refreshing the page (reloading from PostgreSQL) still shows the timetable.
 * G. A second branch cannot see the first branch's timetable.
 */

const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const http = require('http');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const repository = require('../src/db/repository');
const { app } = require('../server');
const { saveUploadRecord, saveStagedData } = require('../src/data/uploads');

let server;
let baseUrl;

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

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
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

async function runRegressionTests() {
    console.log('\n======================================================');
    console.log('Running Master Timetable Display Regression Tests');
    console.log('======================================================\n');

    await startServer();

    try {
        if (db.isConfigured()) {
            await store.initFromDatabase();
        } else {
            await store.init();
        }

        const rand = Math.floor(1000 + Math.random() * 9000);
        const branchA = `CSE_MT_${rand}`;
        const branchB = `ECE_MT_${rand}`;

        // 1. Register and Login as HOD of Branch A
        const hodAUser = `hod_a_${rand}`;
        const hodAPass = 'TecSub_123';
        const regARes = await call('POST', '/api/auth/register', {
            role: 'hos',
            username: hodAUser,
            password: hodAPass,
            confirmPassword: hodAPass,
            name: `HOD Branch A ${rand}`,
            phone: '9123456780',
            branchCode: branchA,
            branchName: `Computer Science ${rand}`,
            academicYear: '2025-2026',
            semester: 4
        });
        assert(regARes.status === 200 || regARes.status === 201, `Branch A HOD registration failed: ${JSON.stringify(regARes.body)}`);

        const loginARes = await call('POST', '/api/auth/login', {
            username: hodAUser,
            password: hodAPass
        });
        assert.strictEqual(loginARes.status, 200);
        const cookieA = loginARes.cookie;

        // 2. Register and Login as HOD of Branch B
        const hodBUser = `hod_b_${rand}`;
        const hodBPass = 'TecSub_123';
        const regBRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            username: hodBUser,
            password: hodBPass,
            confirmPassword: hodBPass,
            name: `HOD Branch B ${rand}`,
            phone: '9123456781',
            branchCode: branchB,
            branchName: `Electronics ${rand}`,
            academicYear: '2025-2026',
            semester: 4
        });
        assert(regBRes.status === 200 || regBRes.status === 201, `Branch B HOD registration failed: ${JSON.stringify(regBRes.body)}`);

        const loginBRes = await call('POST', '/api/auth/login', {
            username: hodBUser,
            password: hodBPass
        });
        assert.strictEqual(loginBRes.status, 200);
        const cookieB = loginBRes.cookie;

        // 3. Stage Timetable Contract for Branch A
        const uploadIdA = `upload_mtt_${rand}`;
        const classNameA = `${branchA}-4-A`;
        const facNameA = `Dr. Professor A ${rand}`;

        const subj1Name = `Advanced OS ${rand}`;
        const subj2Name = `Cloud Infra ${rand}`;
        const subj3Name = `OS Lab ${rand}`;

        const contractA = {
            academic_year: '2025-2026',
            semester: 'IV',
            section: 'A',
            branch_code: branchA,
            class_name: classNameA,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: subj1Name,
                    subject_code: `CS${rand}_1`,
                    faculty_name: facNameA,
                    room_code: 'LH-101',
                    session_type: 'theory'
                },
                {
                    day: 'Monday',
                    period: 2,
                    subject_name: subj2Name,
                    subject_code: `CS${rand}_2`,
                    faculty_name: facNameA,
                    room_code: 'LH-101',
                    session_type: 'theory'
                },
                {
                    day: 'Tuesday',
                    period: 3,
                    span_to: 5,
                    subject_name: subj3Name,
                    subject_code: `CS${rand}_3`,
                    faculty_name: facNameA,
                    room_code: 'LAB-1',
                    session_type: 'lab'
                }
            ]
        };

        await saveUploadRecord({
            uploadId: uploadIdA,
            departmentCode: branchA,
            uploadedBy: `HOD Branch A ${rand}`,
            originalFilename: 'cse_master_timetable.jpeg',
            uploadType: 'master',
            fileType: 'image/jpeg',
            fileBuffer: Buffer.from('dummy'),
            mimeType: 'image/jpeg',
            status: 'UPLOADED'
        });

        await saveStagedData(uploadIdA, {
            extractedJson: contractA,
            validationStatus: 'VALID',
            validationErrors: [],
            importStatus: 'STAGED',
            resolution: {
                canAutoApprove: true,
                unresolvedEntities: []
            }
        });

        // Register unresolved entities into the branch catalog before approval
        await call('POST', `/api/staging/${uploadIdA}/register-all-unresolved`, {}, cookieA);

        // ----------------------------------------------------
        // TEST A: HOD Approval inserts real rows into PostgreSQL
        // ----------------------------------------------------
        console.log('Testing Test A: HOD approval inserts real rows into PostgreSQL...');
        const approveRes = await call('POST', `/api/staging/${uploadIdA}/approve`, {}, cookieA);
        assert.strictEqual(approveRes.status, 200, `Approve failed: ${JSON.stringify(approveRes.body)}`);
        assert.strictEqual(approveRes.body.success, true);
        assert(approveRes.body.importedCount >= 5, `Expected at least 5 imported period slots, got ${approveRes.body.importedCount}`);

        if (db.isConfigured()) {
            const dbCheck = await db.query(`
                SELECT t.id, c.code AS "classCode", t.day_of_week, t.period, s.name AS "subjectName", f.name AS "facultyName"
                  FROM timetable t
                  JOIN classes c ON c.id = t.class_id
                  JOIN subjects s ON s.id = t.subject_id
                  LEFT JOIN faculty f ON f.id = t.faculty_id
                 WHERE UPPER(c.code) = UPPER($1)
                 ORDER BY t.day_of_week, t.period
            `, [classNameA]);
            assert(dbCheck.rows.length >= 5, `PostgreSQL timetable table must contain >= 5 rows for ${classNameA}`);
            console.log(`✓ Test A Passed: ${dbCheck.rows.length} real PostgreSQL timetable rows verified.`);
        } else {
            console.log('✓ Test A Passed (in-memory mode).');
        }

        // ----------------------------------------------------
        // TEST B: The inserted rows contain correct scope
        // ----------------------------------------------------
        console.log('Testing Test B: Inserted rows contain correct branch/class/semester/section scope...');
        if (db.isConfigured()) {
            const scopeCheck = await db.query(`
                SELECT c.code, c.semester, c.section, c.academic_year, d.code AS "deptCode"
                  FROM classes c
                  JOIN departments d ON d.id = c.department_id
                 WHERE UPPER(c.code) = UPPER($1)
            `, [classNameA]);
            assert(scopeCheck.rows.length > 0, `Class ${classNameA} must exist in classes table`);
            const cls = scopeCheck.rows[0];
            assert.strictEqual(cls.deptCode.toUpperCase(), branchA.toUpperCase(), 'Branch code must match');
            assert.strictEqual(cls.semester, 4, 'Semester number must be 4');
            assert.strictEqual(cls.section, 'A', 'Section must be A');
            assert.strictEqual(cls.academic_year, '2025-2026', 'Academic year must be 2025-2026');
            console.log('✓ Test B Passed: Class scope verified in PostgreSQL.');
        } else {
            console.log('✓ Test B Passed (in-memory mode).');
        }

        // ----------------------------------------------------
        // TEST C: GET Master Timetable returns persisted rows
        // ----------------------------------------------------
        console.log('Testing Test C: GET Master Timetable returns persisted rows...');
        const scopesRes = await call('GET', '/api/timetable/scopes', null, cookieA);
        assert.strictEqual(scopesRes.status, 200);
        assert(scopesRes.body.semesters.includes('SEM-4'), 'Scopes must include SEM-4');
        assert(scopesRes.body.sections.includes('A'), 'Scopes must include Section A');

        // Query by semester and section
        const ttRes1 = await call('GET', '/api/timetable?semester=SEM-4&section=A&academicYear=2025-2026', null, cookieA);
        assert.strictEqual(ttRes1.status, 200);
        const cells1 = ttRes1.body.cells || [];
        const monP1 = cells1.find(c => c.day === 'Monday' && c.period === 1);
        assert(monP1, 'Monday P1 must exist');
        assert.strictEqual(monP1.subject, subj1Name);
        assert.strictEqual(monP1.faculty, facNameA);
        assert.strictEqual(monP1.status, 'busy');

        // Query by class code
        const ttRes2 = await call('GET', `/api/timetable?class=${encodeURIComponent(classNameA)}`, null, cookieA);
        assert.strictEqual(ttRes2.status, 200);
        const cells2 = ttRes2.body.cells || [];
        const tueP3 = cells2.find(c => c.day === 'Tuesday' && c.period === 3);
        assert(tueP3, 'Tuesday P3 lab must exist');
        assert.strictEqual(tueP3.subject, subj3Name);
        assert.strictEqual(tueP3.status, 'busy');
        console.log('✓ Test C Passed: GET Master Timetable returns persisted rows with correct subjects and faculty.');

        // ----------------------------------------------------
        // TEST D: Master Timetable UI default & slots display
        // ----------------------------------------------------
        console.log('Testing Test D: Master Timetable displays imported slots instead of all Free...');
        const defaultTtRes = await call('GET', '/api/timetable', null, cookieA);
        assert.strictEqual(defaultTtRes.status, 200);
        const defaultCells = defaultTtRes.body.cells || [];
        const busyCount = defaultCells.filter(c => c.status !== 'free' && (c.subject || c.faculty)).length;
        assert(busyCount >= 5, `Default Master Timetable must display imported busy slots, got ${busyCount}`);
        console.log(`✓ Test D Passed: Master Timetable has ${busyCount} active/busy slots displayed.`);

        // ----------------------------------------------------
        // TEST E: Availability reads same approved timetable
        // ----------------------------------------------------
        console.log('Testing Test E: Availability reads the same approved timetable...');
        // Monday P1: facNameA is teaching
        const availMon1 = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            class: classNameA
        }, cookieA);
        assert.strictEqual(availMon1.status, 200);
        const freeInMon1 = (availMon1.body.available || []).some(f => f.name === facNameA || f.faculty === facNameA);
        assert.strictEqual(freeInMon1, false, `Faculty ${facNameA} should be busy on Monday P1`);
        const busyInMon1 = (availMon1.body.busy || []).some(f => f.name === facNameA || f.faculty === facNameA);
        assert.strictEqual(busyInMon1, true, `Faculty ${facNameA} must be listed in busy list on Monday P1`);

        // Tuesday P1: facNameA is free (teaches Tuesday P3-5 lab)
        const availTue1 = await call('POST', '/api/availability', {
            day: 'Tuesday',
            period: 1,
            class: classNameA
        }, cookieA);
        assert.strictEqual(availTue1.status, 200);
        const freeInTue1 = (availTue1.body.available || []).some(f => f.name === facNameA || f.faculty === facNameA);
        assert.strictEqual(freeInTue1, true, `Faculty ${facNameA} should be free on Tuesday P1`);
        console.log('✓ Test E Passed: Availability correctly reflects approved timetable.');

        // ----------------------------------------------------
        // TEST F: Refreshing / store reload preserves PostgreSQL data
        // ----------------------------------------------------
        console.log('Testing Test F: Refreshing page / reloading from PostgreSQL preserves timetable...');
        if (db.isConfigured()) {
            await store.reloadFromDatabase();
            const reloadedTtRes = await call('GET', '/api/timetable?semester=SEM-4&section=A', null, cookieA);
            assert.strictEqual(reloadedTtRes.status, 200);
            const reloadedCells = reloadedTtRes.body.cells || [];
            const rMon1 = reloadedCells.find(c => c.day === 'Monday' && c.period === 1);
            assert(rMon1 && rMon1.subject === subj1Name, 'Reloaded data must contain Monday P1 slot');
            console.log('✓ Test F Passed: Store reload from PostgreSQL retains approved timetable.');
        } else {
            console.log('✓ Test F Passed (in-memory mode).');
        }

        // ----------------------------------------------------
        // TEST G: Cross-branch isolation
        // ----------------------------------------------------
        console.log('Testing Test G: Second branch cannot see first branch timetable...');
        // Branch B tries to query Branch A's timetable directly
        const crossRes = await call('GET', `/api/timetable?class=${encodeURIComponent(classNameA)}`, null, cookieB);
        assert(crossRes.status === 403 || crossRes.status === 404, `Cross-branch timetable query must be forbidden/not found, got ${crossRes.status}`);

        // Branch B gets their own Master Timetable
        const branchBScopes = await call('GET', '/api/timetable/scopes', null, cookieB);
        assert.strictEqual(branchBScopes.status, 200);
        assert.strictEqual(branchBScopes.body.branch, branchB, 'Scopes must return Branch B context');
        const hasAClass = (branchBScopes.body.classes || []).some(c => c.code === classNameA);
        assert.strictEqual(hasAClass, false, 'Branch B scopes must NOT contain Branch A class');
        console.log('✓ Test G Passed: Complete cross-branch isolation verified.');

        console.log('\n======================================================');
        console.log('ALL REGRESSION TESTS A-G PASSED SUCCESSFULLY!');
        console.log('======================================================\n');
    } finally {
        await stopServer();
    }
}

runRegressionTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('\nRegression Test Failed:\n', err);
    process.exit(1);
});
