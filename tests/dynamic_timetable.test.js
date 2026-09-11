/**
 * Phase B6.2 — Dynamic Semester + Section Timetable Management Test Suite
 *
 * Requirements:
 *  1. Existing legacy timetable still works.
 *  2. HOS can select semester dynamically.
 *  3. HOS can select section.
 *  4. Different semester/section combinations resolve to different class_ids.
 *  5. Viewing SEM-1/A does not show SEM-2/A entries.
 *  6. Viewing SEM-2/B does not show SEM-2/A entries.
 *  7. Upload/import replaces ONLY the selected class timetable.
 *  8. Other semester/section timetables remain unchanged.
 *  9. Clear/archive affects ONLY selected class.
 * 10. Other branches remain untouched.
 * 11. Cross-branch HOS access returns 403.
 * 12. New branch with totalSemesters=N receives SEM-1 ... SEM-N dynamically.
 * 13. B2.5 Gemini/staging/import tests continue passing.
 * 14. Existing faculty timetable tests continue passing.
 * 15. Existing availability tests continue passing.
 */
const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const users = require('../src/data/users');
const store = require('../src/data/store');
const { resetBranchForTesting, getBranchSemesters } = require('../src/data/departments');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
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

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { /* html */ }
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
    console.log('\n====================================');
    console.log('TecSubstitution — Phase B6.2 Dynamic Timetable Tests\n');

    await startServer();

    try {
        // Reset state
        users.resetForTesting();
        resetBranchForTesting();
        store.resetForEmptyInstance();

        // -------------------------------------------------------------
        // Setup: Register CME HOS (totalSemesters=6), EEE HOS (totalSemesters=6)
        // -------------------------------------------------------------
        console.log('[Setup] Registering HOS accounts');

        const hosCmeRes = await call('POST', '/api/auth/register', {
            username: 'hos.cme',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'hos',
            name: 'Dr. Head CME',
            phone: '9876543210',
            branchCode: 'CME',
            branchName: 'Computer Engineering',
            totalSemesters: 6
        });
        assert.strictEqual(hosCmeRes.status, 201);
        const cookieHosCme = hosCmeRes.cookie;

        const hosEeeRes = await call('POST', '/api/auth/register', {
            username: 'hos.eee',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'hos',
            name: 'Dr. Head EEE',
            phone: '9876543211',
            branchCode: 'EEE',
            branchName: 'Electrical Engineering',
            totalSemesters: 6
        });
        assert.strictEqual(hosEeeRes.status, 201);
        const cookieHosEee = hosEeeRes.cookie;

        // Create faculty for CME
        const facCmeRes = await call('POST', '/api/auth/register', {
            username: 'prof.cme1',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'faculty',
            name: 'Prof. Computer One',
            phone: '+91 98765 43210',
            subjects: ['Data Structures', 'Algorithms']
        }, cookieHosCme);
        assert.strictEqual(facCmeRes.status, 201);

        const facCme2Res = await call('POST', '/api/auth/register', {
            username: 'prof.cme2',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'faculty',
            name: 'Prof. Computer Two',
            phone: '+91 98765 43213',
            subjects: ['Algorithms', 'Operating Systems']
        }, cookieHosCme);
        assert.strictEqual(facCme2Res.status, 201);

        // -------------------------------------------------------------
        // [1] Existing Legacy Timetable Still Works
        // -------------------------------------------------------------
        console.log('\n[1] Existing Legacy Timetable Backward Compatibility');
        store.addEntryInMemory({
            className: 'CME-A',
            day: 'Monday',
            period: 1,
            subject: 'Data Structures',
            faculty: 'Prof. Computer One',
            room: 'C-101',
            type: 'theory'
        });

        const legRes = await call('GET', '/api/timetable?class=CME-A', null, cookieHosCme);
        check('Legacy class CME-A is retrievable via GET /api/timetable?class=CME-A', () => {
            assert.strictEqual(legRes.status, 200);
        });
        const p1Cell = (legRes.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
        check('Legacy timetable entries are preserved and correctly displayed', () => {
            assert.ok(p1Cell);
            assert.strictEqual(p1Cell.subject, 'Data Structures');
        });

        // -------------------------------------------------------------
        // [2] & [3] Dynamic Semester and Section Selection
        // -------------------------------------------------------------
        console.log('\n[2] & [3] Dynamic Semester and Section Selection');
        const scopesRes = await call('GET', '/api/timetable/scopes', null, cookieHosCme);
        check('HOS can fetch timetable scopes', () => {
            assert.strictEqual(scopesRes.status, 200);
        });
        check('Scopes branch matches HOS branch', () => {
            assert.strictEqual(scopesRes.body.branch, 'CME');
        });
        check('Semesters list is provided and configured with totalSemesters=6', () => {
            assert.ok(Array.isArray(scopesRes.body.semesters));
            assert.strictEqual(scopesRes.body.semesters.length, 6);
            assert.strictEqual(scopesRes.body.semesters[0], 'SEM-1');
            assert.strictEqual(scopesRes.body.semesters[5], 'SEM-6');
        });
        check('Sections list is provided and includes A and B', () => {
            assert.ok(Array.isArray(scopesRes.body.sections));
            assert.ok(scopesRes.body.sections.includes('A'));
            assert.ok(scopesRes.body.sections.includes('B'));
        });

        // -------------------------------------------------------------
        // [4] Different Semester/Section Combinations Resolve to Different Classes
        // -------------------------------------------------------------
        console.log('\n[4] Class Scope Resolution to Distinct Classes');
        const classSem1A = store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });
        const classSem2A = store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-2',
            section: 'A'
        });
        const classSem2B = store.resolveOrCreateClassInMemory({
            branch: 'CME',
            academicYear: '2026-27',
            semester: 'SEM-2',
            section: 'B'
        });

        check('SEM-1/A and SEM-2/A resolve to distinct class codes', () => {
            assert.notStrictEqual(classSem1A.code, classSem2A.code);
        });
        check('SEM-2/A and SEM-2/B resolve to distinct class codes', () => {
            assert.notStrictEqual(classSem2A.code, classSem2B.code);
        });
        check('SEM-1/A and SEM-2/A resolve to distinct class IDs', () => {
            assert.notStrictEqual(classSem1A.id, classSem2A.id);
        });

        // -------------------------------------------------------------
        // [5] & [6] Timetable Isolation Between Semesters and Sections
        // -------------------------------------------------------------
        console.log('\n[5] & [6] Timetable Isolation: SEM-1/A vs SEM-2/A vs SEM-2/B');
        // Add entry for SEM-1/A: Monday P2 (Prof. Computer One)
        store.addEntryInMemory({
            className: classSem1A.code,
            day: 'Monday',
            period: 2,
            subject: 'Data Structures',
            faculty: 'Prof. Computer One',
            room: 'C-101',
            type: 'theory'
        });

        // Add entry for SEM-2/A: Monday P2 (Prof. Computer Two - different faculty, so no conflict!)
        store.addEntryInMemory({
            className: classSem2A.code,
            day: 'Monday',
            period: 2,
            subject: 'Algorithms',
            faculty: 'Prof. Computer Two',
            room: 'C-201',
            type: 'theory'
        });

        // Add entry for SEM-2/B: Monday P3 (Prof. Computer Two)
        store.addEntryInMemory({
            className: classSem2B.code,
            day: 'Monday',
            period: 3,
            subject: 'Algorithms',
            faculty: 'Prof. Computer Two',
            room: 'C-202',
            type: 'theory'
        });

        // View SEM-1/A
        const viewSem1A = await call('GET', `/api/timetable?semester=SEM-1&section=A`, null, cookieHosCme);
        check('GET timetable for SEM-1/A returns 200', () => {
            assert.strictEqual(viewSem1A.status, 200);
        });
        const sem1Cell = (viewSem1A.body.cells || []).find(c => c.day === 'Monday' && c.period === 2);
        check('SEM-1/A shows Data Structures at Monday P2', () => {
            assert.ok(sem1Cell);
            assert.strictEqual(sem1Cell.subject, 'Data Structures');
        });

        // View SEM-2/A
        const viewSem2A = await call('GET', `/api/timetable?semester=SEM-2&section=A`, null, cookieHosCme);
        check('GET timetable for SEM-2/A returns 200', () => {
            assert.strictEqual(viewSem2A.status, 200);
        });
        const sem2ACellP2 = (viewSem2A.body.cells || []).find(c => c.day === 'Monday' && c.period === 2);
        check('SEM-2/A shows Algorithms at Monday P2 and does NOT show SEM-1/A entry', () => {
            assert.ok(sem2ACellP2);
            assert.strictEqual(sem2ACellP2.subject, 'Algorithms');
            assert.notStrictEqual(sem2ACellP2.subject, 'Data Structures');
        });

        // View SEM-2/B
        const viewSem2B = await call('GET', `/api/timetable?semester=SEM-2&section=B`, null, cookieHosCme);
        check('GET timetable for SEM-2/B returns 200', () => {
            assert.strictEqual(viewSem2B.status, 200);
        });
        const sem2BCellP2 = (viewSem2B.body.cells || []).find(c => c.day === 'Monday' && c.period === 2);
        check('SEM-2/B does NOT show SEM-2/A entry at Monday P2 (is free)', () => {
            assert.ok(sem2BCellP2);
            assert.strictEqual(sem2BCellP2.status, 'free');
        });
        const sem2BCellP3 = (viewSem2B.body.cells || []).find(c => c.day === 'Monday' && c.period === 3);
        check('SEM-2/B shows Algorithms at Monday P3', () => {
            assert.ok(sem2BCellP3);
            assert.strictEqual(sem2BCellP3.subject, 'Algorithms');
        });

        // -------------------------------------------------------------
        // [7] & [8] Staging / Import Replaces ONLY the Selected Class
        // -------------------------------------------------------------
        console.log('\n[7] & [8] Import Scoped Replacement (REPLACE_CLASS)');
        // Import new timetable specifically for SEM-2/A
        const stagedContract = {
            class_name: classSem2A.code,
            academic_year: '2026-27',
            semester: 'SEM-2',
            section: 'A',
            entries: [
                {
                    day: 'Wednesday',
                    period: 1,
                    span_to: 1,
                    subject_name: 'Algorithms',
                    faculty_name: 'Prof. Computer One',
                    room_code: 'C-205',
                    session_type: 'theory'
                }
            ]
        };

        const importResult = store.importStagedTimetableInMemory({
            uploadRecord: { departmentCode: 'CME' },
            stagedContract: stagedContract,
            resolvedMap: {},
            userId: 'hos.cme'
        });
        check('Imported 1 new slot for SEM-2/A', () => {
            assert.strictEqual(importResult.importedCount, 1);
        });

        // Verify SEM-2/A old entry on Monday P2 was replaced
        const postImportSem2A = await call('GET', `/api/timetable?semester=SEM-2&section=A`, null, cookieHosCme);
        const cellMonP2 = (postImportSem2A.body.cells || []).find(c => c.day === 'Monday' && c.period === 2);
        check('Old SEM-2/A entry on Monday P2 was replaced', () => {
            assert.ok(cellMonP2);
            assert.strictEqual(cellMonP2.status, 'free');
        });
        const cellWedP1 = (postImportSem2A.body.cells || []).find(c => c.day === 'Wednesday' && c.period === 1);
        check('New SEM-2/A entry on Wednesday P1 is present', () => {
            assert.ok(cellWedP1);
            assert.strictEqual(cellWedP1.subject, 'Algorithms');
        });

        // Verify other classes were NOT modified
        const checkSem1A = await call('GET', `/api/timetable?semester=SEM-1&section=A`, null, cookieHosCme);
        const sem1CellCheck = (checkSem1A.body.cells || []).find(c => c.day === 'Monday' && c.period === 2);
        check('SEM-1/A Monday P2 remained untouched', () => {
            assert.ok(sem1CellCheck);
            assert.strictEqual(sem1CellCheck.subject, 'Data Structures');
        });

        const checkSem2B = await call('GET', `/api/timetable?semester=SEM-2&section=B`, null, cookieHosCme);
        const sem2BCellCheck = (checkSem2B.body.cells || []).find(c => c.day === 'Monday' && c.period === 3);
        check('SEM-2/B Monday P3 remained untouched', () => {
            assert.ok(sem2BCellCheck);
            assert.strictEqual(sem2BCellCheck.subject, 'Algorithms');
        });

        // -------------------------------------------------------------
        // [9] Clear Timetable Affects ONLY Selected Class Scope
        // -------------------------------------------------------------
        console.log('\n[9] Timetable Clear Scope');
        const clearRes = await call('POST', '/api/timetable/clear', {
            semester: 'SEM-2',
            section: 'A',
            academicYear: '2026-27'
        }, cookieHosCme);

        check('POST /api/timetable/clear returns 200 and cleared: true', () => {
            assert.strictEqual(clearRes.status, 200);
            assert.strictEqual(clearRes.body.cleared, true);
        });

        // Check SEM-2/A is now empty
        const clearedSem2A = await call('GET', `/api/timetable?semester=SEM-2&section=A`, null, cookieHosCme);
        const anyBusy2A = (clearedSem2A.body.cells || []).some(c => c.status === 'busy');
        check('All entries for SEM-2/A were cleared', () => {
            assert.strictEqual(anyBusy2A, false);
        });

        // Verify SEM-1/A still has its entry
        const sem1AfterClear = await call('GET', `/api/timetable?semester=SEM-1&section=A`, null, cookieHosCme);
        const sem1P2StillThere = (sem1AfterClear.body.cells || []).find(c => c.day === 'Monday' && c.period === 2);
        check('SEM-1/A entries preserved after clearing SEM-2/A', () => {
            assert.ok(sem1P2StillThere);
            assert.strictEqual(sem1P2StillThere.subject, 'Data Structures');
        });

        // Verify faculty records and classes were NOT deleted
        const facList = await call('GET', '/api/faculty', null, cookieHosCme);
        check('Faculty records were NOT deleted on clear timetable', () => {
            assert.strictEqual(facList.status, 200);
            assert.ok(facList.body.faculty.length > 0);
        });

        // -------------------------------------------------------------
        // [10] Other Branches Remain Untouched
        // -------------------------------------------------------------
        console.log('\n[10] Branch Isolation Across Multiple Branches');
        // Add EEE timetable entry
        const classEee1A = store.resolveOrCreateClassInMemory({
            branch: 'EEE',
            academicYear: '2026-27',
            semester: 'SEM-1',
            section: 'A'
        });
        store.addEntryInMemory({
            className: classEee1A.code,
            day: 'Tuesday',
            period: 1,
            subject: 'Electrical Circuits',
            faculty: 'Prof. Spark EEE',
            room: 'E-101',
            type: 'theory'
        });

        // Clear CME SEM-1/A
        await call('POST', '/api/timetable/clear', {
            semester: 'SEM-1',
            section: 'A'
        }, cookieHosCme);

        // Verify EEE SEM-1/A is untouched
        const eeeView = await call('GET', `/api/timetable?semester=SEM-1&section=A`, null, cookieHosEee);
        const eeeCell = (eeeView.body.cells || []).find(c => c.day === 'Tuesday' && c.period === 1);
        check('EEE timetable remained completely untouched after clearing CME timetable', () => {
            assert.ok(eeeCell);
            assert.strictEqual(eeeCell.subject, 'Electrical Circuits');
        });

        // -------------------------------------------------------------
        // [11] Cross-Branch HOS Access Returns 403 Forbidden
        // -------------------------------------------------------------
        console.log('\n[11] Cross-Branch Security Gate');
        // CME HOS queries EEE branch scopes -> 403
        const crossBranchScopes = await call('GET', '/api/timetable/scopes?branch=EEE', null, cookieHosCme);
        check('CME HOS querying EEE scopes returns 403', () => {
            assert.strictEqual(crossBranchScopes.status, 403);
        });

        // CME HOS queries EEE class -> 403
        const crossBranchClass = await call('GET', `/api/timetable?class=${classEee1A.code}`, null, cookieHosCme);
        check('CME HOS querying EEE class returns 403', () => {
            assert.strictEqual(crossBranchClass.status, 403);
        });

        // CME HOS attempts to clear EEE timetable -> 403
        const crossBranchClear = await call('POST', '/api/timetable/clear', {
            branch: 'EEE',
            semester: 'SEM-1',
            section: 'A'
        }, cookieHosCme);
        check('CME HOS attempting to clear EEE timetable returns 403', () => {
            assert.strictEqual(crossBranchClear.status, 403);
        });

        // -------------------------------------------------------------
        // [12] New Branch with totalSemesters=N Receives SEM-1 ... SEM-N Dynamically
        // -------------------------------------------------------------
        console.log('\n[12] Dynamic Semester Count Configuration (B.Tech N=8)');
        // Register new B.Tech branch with 8 semesters
        const hosBtecRes = await call('POST', '/api/auth/register', {
            username: 'hos.btec',
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            role: 'hos',
            name: 'Dr. Head BTEC',
            phone: '9876543212',
            branchCode: 'BTEC',
            branchName: 'Bio Technology Engineering',
            totalSemesters: 8
        });
        check('New HOS can register with totalSemesters=8', () => {
            assert.strictEqual(hosBtecRes.status, 201);
        });
        const cookieHosBtec = hosBtecRes.cookie;

        const btecScopes = await call('GET', '/api/timetable/scopes', null, cookieHosBtec);
        check('BTEC HOS gets scopes successfully with totalSemesters=8', () => {
            assert.strictEqual(btecScopes.status, 200);
            assert.strictEqual(btecScopes.body.totalSemesters, 8);
            assert.strictEqual(btecScopes.body.semesters.length, 8);
            assert.strictEqual(btecScopes.body.semesters[6], 'SEM-7');
            assert.strictEqual(btecScopes.body.semesters[7], 'SEM-8');
        });

        // Also check getBranchSemesters directly
        const btecSems = getBranchSemesters('BTEC');
        check('getBranchSemesters("BTEC") dynamically yields 8 semesters', () => {
            assert.strictEqual(btecSems.length, 8);
        });
        const cmeSems = getBranchSemesters('CME');
        check('CME remains at 6 semesters (isolated branch configurations)', () => {
            assert.strictEqual(cmeSems.length, 6);
        });

    } finally {
        await stopServer();
    }

    console.log('------------------------------------');
    console.log(`Results: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal error in dynamic_timetable.test.js:', err);
    process.exit(1);
});
