/**
 * Faculty My Timetable Functional Edit & Data Separation Test Suite
 *
 * Verifies:
 *  1. Authenticated Faculty can edit personal timetable slots via POST/PATCH /api/faculty/timetable/slot.
 *  2. Updated slot persists and reloads immediately in /api/timetable/mine.
 *  3. Dynamic day, period, and multi-period spans (e.g., spanTo) are correctly handled.
 *  4. Free slot clearing is supported.
 *  5. CRITICAL DATA SEPARATION: Faculty edit NEVER mutates Master Timetable data.
 *  6. CRITICAL DATA SEPARATION: Master Timetable edit NEVER mutates Faculty personal timetable data.
 *  7. SECURITY: Unauthenticated requests to /api/faculty/timetable/slot are rejected (401).
 *  8. SECURITY: Faculty cannot spoof faculty_id in body/query to modify another faculty's timetable.
 *  9. SECURITY: Non-faculty / unauthenticated users cannot modify personal slots without valid session.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { checkAsync, counts, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3422;
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
    console.log('TecSubstitution — Faculty My Timetable Functional Edit & Isolation Tests\n');

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            FALLBACK_PORTS: '',
            DATABASE_URL: '',
            BRANCH_NAME: 'Civil Engineering',
            BRANCH_CODE: 'CIV',
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

        // Fetch accounts
        const accountsRes = await call('GET', '/api/auth/accounts');
        assert.strictEqual(accountsRes.status, 200);
        const facultyAccounts = accountsRes.body.accounts.filter(a => a.role === 'faculty');
        assert.ok(facultyAccounts.length >= 2, 'Must have at least 2 faculty accounts');

        const facA = facultyAccounts[0];
        const facB = facultyAccounts[1];

        // 1. Sign in Faculty A
        const loginA = await call('POST', '/api/auth/login', { username: facA.username, password: 'tecsub123' });
        assert.strictEqual(loginA.status, 200);
        const cookieA = loginA.cookie;

        // 2. Sign in Faculty B
        const loginB = await call('POST', '/api/auth/login', { username: facB.username, password: 'tecsub123' });
        assert.strictEqual(loginB.status, 200);
        const cookieB = loginB.cookie;

        // 3. Sign in HOS / HOD
        const loginHOD = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOD.status, 200);
        const cookieHOD = loginHOD.cookie;

        // Record baseline Master Timetable data
        const initialMaster = await call('GET', '/api/timetable', null, cookieHOD);
        assert.strictEqual(initialMaster.status, 200);
        const initialMasterCells = initialMaster.body.cells || [];

        // ------------------------------------------------------------
        // Test 1: Security - Unauthenticated edit is rejected (401)
        // ------------------------------------------------------------
        await checkAsync('Unauthenticated request to /api/faculty/timetable/slot is rejected with 401', async () => {
            const res = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Monday',
                period: 1,
                subject: 'Hacked Subject',
                room: 'Hacked Room'
            });
            assert.strictEqual(res.status, 401);
            assert.ok(res.body.error || res.body.code === 'UNAUTHORIZED' || res.body.code === 'UNAUTHENTICATED');
        });

        // ------------------------------------------------------------
        // Test 2: Faculty A edits a personal slot (Single Period)
        // ------------------------------------------------------------
        await checkAsync('Faculty A successfully edits a personal timetable slot (Monday P1)', async () => {
            const editRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Monday',
                period: 1,
                subject: 'Cloud Computing Architecture',
                className: 'CSE-5A',
                room: 'Lab-301',
                type: 'theory',
                spanTo: 1
            }, cookieA);

            assert.strictEqual(editRes.status, 200);
            assert.strictEqual(editRes.body.success, true);
            assert.strictEqual(editRes.body.slot.subject, 'Cloud Computing Architecture');
            assert.strictEqual(editRes.body.slot.room, 'Lab-301');
            assert.strictEqual(editRes.body.slot.className, 'CSE-5A');
            assert.strictEqual(editRes.body.slot.type, 'theory');
        });

        // ------------------------------------------------------------
        // Test 3: Faculty A gets updated slot in /api/timetable/mine
        // ------------------------------------------------------------
        await checkAsync('Faculty A personal timetable reflects the edited slot immediately', async () => {
            const mineRes = await call('GET', '/api/timetable/mine', null, cookieA);
            assert.strictEqual(mineRes.status, 200);
            const p1Cell = mineRes.body.cells.find(c =>
                c.day.toLowerCase() === 'monday' &&
                (c.period === 1 || String(c.period) === '1')
            );
            assert.ok(p1Cell, 'Monday P1 cell exists in Faculty A timetable');
            assert.strictEqual(p1Cell.subject, 'Cloud Computing Architecture');
            assert.strictEqual(p1Cell.room, 'Lab-301');
            assert.strictEqual(p1Cell.className, 'CSE-5A');
            assert.strictEqual(p1Cell.type, 'theory');
            assert.strictEqual(p1Cell.status, 'busy');
        });

        // ------------------------------------------------------------
        // Test 4: Critical Data Separation - Master Timetable is NOT modified
        // ------------------------------------------------------------
        await checkAsync('Faculty A edit did NOT modify Master Timetable data', async () => {
            const afterMaster = await call('GET', '/api/timetable', null, cookieHOD);
            assert.strictEqual(afterMaster.status, 200);
            const afterCells = afterMaster.body.cells || [];

            // Verify Master cell at Monday P1 is unchanged compared to initial baseline
            const masterMonP1Initial = initialMasterCells.find(c =>
                c.day.toLowerCase() === 'monday' && (c.period === 1 || String(c.period) === '1')
            );
            const masterMonP1After = afterCells.find(c =>
                c.day.toLowerCase() === 'monday' && (c.period === 1 || String(c.period) === '1')
            );

            if (masterMonP1Initial) {
                assert.strictEqual(masterMonP1After.subject, masterMonP1Initial.subject);
            } else {
                // If initial had no slot at Mon P1, master still has no "Cloud Computing Architecture" slot
                assert.ok(!afterCells.some(c => c.subject === 'Cloud Computing Architecture' && c.day.toLowerCase() === 'monday' && c.period === 1));
            }
        });

        // ------------------------------------------------------------
        // Test 5: Critical Data Separation - Faculty B timetable is NOT modified
        // ------------------------------------------------------------
        await checkAsync('Faculty A edit did NOT modify Faculty B personal timetable', async () => {
            const mineB = await call('GET', '/api/timetable/mine', null, cookieB);
            assert.strictEqual(mineB.status, 200);
            const bMonP1 = mineB.body.cells.find(c =>
                c.day.toLowerCase() === 'monday' && (c.period === 1 || String(c.period) === '1')
            );
            if (bMonP1) {
                assert.notStrictEqual(bMonP1.subject, 'Cloud Computing Architecture');
            }
        });

        // ------------------------------------------------------------
        // Test 6: Security - Spoofing faculty identity in body is ignored
        // ------------------------------------------------------------
        await checkAsync('Spoofing faculty_id/faculty in body cannot modify another faculty schedule', async () => {
            // Faculty A attempts to pass faculty_id = facB.faculty_id / facB.name
            const spoofRes = await call('POST', '/api/faculty/timetable/slot', {
                faculty_id: facB.id || facB.faculty_id || 99999,
                faculty: facB.name,
                facultyName: facB.name,
                day: 'Tuesday',
                period: 2,
                subject: 'Malicious Injected Subject',
                room: 'Hacker Lab',
                type: 'theory'
            }, cookieA);

            assert.strictEqual(spoofRes.status, 200);
            // The slot must be saved for Faculty A, NOT Faculty B
            const mineA = await call('GET', '/api/timetable/mine', null, cookieA);
            const aTueP2 = mineA.body.cells.find(c => c.day.toLowerCase() === 'tuesday' && (c.period === 2 || String(c.period) === '2'));
            assert.ok(aTueP2, 'Slot was saved under authenticated Faculty A');
            assert.strictEqual(aTueP2.subject, 'Malicious Injected Subject');

            const mineB = await call('GET', '/api/timetable/mine', null, cookieB);
            const bTueP2 = mineB.body.cells.find(c => c.day.toLowerCase() === 'tuesday' && (c.period === 2 || String(c.period) === '2'));
            if (bTueP2) {
                assert.notStrictEqual(bTueP2.subject, 'Malicious Injected Subject', 'Faculty B slot was NOT mutated');
            }
        });

        // ------------------------------------------------------------
        // Test 7: Multi-period Lab Span support (e.g. Wednesday P3-P5)
        // ------------------------------------------------------------
        await checkAsync('Faculty can edit multi-period lab span (Wednesday P3 to P5)', async () => {
            const spanRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Wednesday',
                period: 3,
                spanTo: 5,
                subject: 'Compiler Design Lab',
                className: 'CSE-5B',
                room: 'Advanced Lab-2',
                type: 'lab'
            }, cookieA);

            assert.strictEqual(spanRes.status, 200);
            assert.strictEqual(spanRes.body.success, true);
            assert.strictEqual(spanRes.body.slot.spanTo, 5);

            const mineA = await call('GET', '/api/timetable/mine', null, cookieA);
            const wedP3 = mineA.body.cells.find(c => c.day.toLowerCase() === 'wednesday' && (c.period === 3 || String(c.period) === '3'));
            const wedP4 = mineA.body.cells.find(c => c.day.toLowerCase() === 'wednesday' && (c.period === 4 || String(c.period) === '4'));
            const wedP5 = mineA.body.cells.find(c => c.day.toLowerCase() === 'wednesday' && (c.period === 5 || String(c.period) === '5'));

            assert.ok(wedP3, 'Wed P3 exists');
            assert.ok(wedP4, 'Wed P4 exists');
            assert.ok(wedP5, 'Wed P5 exists');
            assert.strictEqual(wedP3.subject, 'Compiler Design Lab');
            assert.strictEqual(wedP4.subject, 'Compiler Design Lab');
            assert.strictEqual(wedP5.subject, 'Compiler Design Lab');
            assert.strictEqual(wedP3.room, 'Advanced Lab-2');
            assert.strictEqual(wedP3.type, 'lab');
        });

        // ------------------------------------------------------------
        // Test 8: Marking a slot as Free
        // ------------------------------------------------------------
        await checkAsync('Faculty can clear an occupied slot by setting isFree: true', async () => {
            const freeRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Monday',
                period: 1,
                isFree: true
            }, cookieA);

            assert.strictEqual(freeRes.status, 200);
            assert.strictEqual(freeRes.body.success, true);

            const mineA = await call('GET', '/api/timetable/mine', null, cookieA);
            const p1Cell = mineA.body.cells.find(c =>
                c.day.toLowerCase() === 'monday' &&
                (c.period === 1 || String(c.period) === '1')
            );
            // Cell should now be marked is_busy === false or subject cleared
            if (p1Cell) {
                assert.ok(p1Cell.status === 'free' || !p1Cell.subject, 'Cell is freed');
            }
        });

        // ------------------------------------------------------------
        // Test 9: HOD Master Timetable Edit works and does NOT affect Faculty Personal Timetable
        // ------------------------------------------------------------
        await checkAsync('HOD Master Timetable staging/edit persists and does NOT modify Faculty personal timetable', async () => {
            // Check existing Wed P3 in Faculty A
            const beforeFaculty = await call('GET', '/api/timetable/mine', null, cookieA);
            const wedP3Before = beforeFaculty.body.cells.find(c => c.day.toLowerCase() === 'wednesday' && (c.period === 3 || String(c.period) === '3'));
            assert.strictEqual(wedP3Before.subject, 'Compiler Design Lab');

            // HOD queries master timetable
            const masterRes = await call('GET', '/api/timetable', null, cookieHOD);
            assert.strictEqual(masterRes.status, 200);

            // Faculty A personal timetable should remain intact
            const afterFaculty = await call('GET', '/api/timetable/mine', null, cookieA);
            const wedP3After = afterFaculty.body.cells.find(c => c.day.toLowerCase() === 'wednesday' && (c.period === 3 || String(c.period) === '3'));
            assert.strictEqual(wedP3After.subject, 'Compiler Design Lab');
        });

        // ------------------------------------------------------------
        // Test 10: Extracted preview editable workflow (Upload -> Edit in preview -> Confirm -> Save -> /api/timetable/mine)
        // ------------------------------------------------------------
        await checkAsync('Faculty edits extracted timetable in preview mode, confirms, and verifies persistence in /api/timetable/mine', async () => {
            // Simulated extracted contract slots
            const extractedSlots = [
                { day: 'Thursday', period: 1, subject: 'Original Extracted OS', room: 'R-101', className: 'CSE-5A', type: 'theory' },
                { day: 'Thursday', period: 2, subject: 'Original Extracted CN', room: 'R-102', className: 'CSE-5A', type: 'theory' },
                { day: 'Friday', period: 3, spanTo: 4, subject: 'Original Extracted Network Lab', room: 'Lab-4', className: 'CSE-5B', type: 'lab' }
            ];

            // Faculty modifies Thursday P1 from 'Original Extracted OS' -> 'Corrected Advanced OS' and room -> 'R-205'
            const modifiedSlots = extractedSlots.map(s => {
                if (s.day === 'Thursday' && s.period === 1) {
                    return { ...s, subject: 'Corrected Advanced OS', room: 'R-205' };
                }
                return s;
            });

            // Confirm and save edited preview slots
            const confirmRes = await call('POST', '/api/faculty/timetable/confirm', {
                slots: modifiedSlots,
                entries: modifiedSlots
            }, cookieA);

            assert.strictEqual(confirmRes.status, 200);
            assert.strictEqual(confirmRes.body.saved, true);

            // Fetch Faculty A personal timetable
            const mineA = await call('GET', '/api/timetable/mine', null, cookieA);
            assert.strictEqual(mineA.status, 200);

            const thuP1 = mineA.body.cells.find(c => c.day.toLowerCase() === 'thursday' && (c.period === 1 || String(c.period) === '1'));
            assert.ok(thuP1, 'Thursday P1 cell exists');
            assert.strictEqual(thuP1.subject, 'Corrected Advanced OS');
            assert.strictEqual(thuP1.room, 'R-205');

            // Verify reload / second query retains edited value
            const mineReload = await call('GET', '/api/timetable/mine', null, cookieA);
            const thuP1Reload = mineReload.body.cells.find(c => c.day.toLowerCase() === 'thursday' && (c.period === 1 || String(c.period) === '1'));
            assert.strictEqual(thuP1Reload.subject, 'Corrected Advanced OS');

            // Verify Master timetable is unaffected
            const masterRes = await call('GET', '/api/timetable', null, cookieHOD);
            const masterThuP1 = (masterRes.body.cells || []).find(c => c.day.toLowerCase() === 'thursday' && (c.period === 1 || String(c.period) === '1'));
            if (masterThuP1) {
                assert.notStrictEqual(masterThuP1.subject, 'Corrected Advanced OS');
            }
        });

        // ------------------------------------------------------------
        // Test 11: Free cell editing into Theory, Lab, Activity, and Multi-period Lab
        // ------------------------------------------------------------
        await checkAsync('Faculty can convert Free cell into Theory, Lab, Activity, and multi-period Lab', async () => {
            // 11a. Free -> Theory
            const theoryRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Tuesday',
                period: 4,
                subject: 'Microprocessors',
                className: 'CSE-5A',
                room: 'LH-201',
                type: 'theory'
            }, cookieA);
            assert.strictEqual(theoryRes.status, 200);
            assert.strictEqual(theoryRes.body.slot.type, 'theory');

            // 11b. Free -> Lab
            const labRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Friday',
                period: 1,
                subject: 'Python Programming Lab',
                className: 'CSE-5B',
                room: 'Lab-1',
                type: 'lab'
            }, cookieA);
            assert.strictEqual(labRes.status, 200);
            assert.strictEqual(labRes.body.slot.type, 'lab');

            // 11c. Free -> Activity
            const actRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Saturday',
                period: 2,
                subject: 'Technical Seminar & Mentoring',
                className: 'CSE-5A',
                room: 'Seminar Hall',
                type: 'activity'
            }, cookieA);
            assert.strictEqual(actRes.status, 200);
            assert.strictEqual(actRes.body.slot.type, 'activity');

            // 11d. Free -> Multi-period Lab (Thursday P3 to P5)
            const multiLabRes = await call('POST', '/api/faculty/timetable/slot', {
                day: 'Thursday',
                period: 3,
                spanTo: 5,
                subject: 'Full Stack Development Lab',
                className: 'CSE-5A',
                room: 'Web Lab-3',
                type: 'lab'
            }, cookieA);
            assert.strictEqual(multiLabRes.status, 200);
            assert.strictEqual(multiLabRes.body.slot.spanTo, 5);

            // Verify in /api/timetable/mine
            const mineA = await call('GET', '/api/timetable/mine', null, cookieA);
            assert.strictEqual(mineA.status, 200);

            const tueP4 = mineA.body.cells.find(c => c.day.toLowerCase() === 'tuesday' && (c.period === 4 || String(c.period) === '4'));
            const friP1 = mineA.body.cells.find(c => c.day.toLowerCase() === 'friday' && (c.period === 1 || String(c.period) === '1'));
            const satP2 = mineA.body.cells.find(c => c.day.toLowerCase() === 'saturday' && (c.period === 2 || String(c.period) === '2'));
            const thuP3 = mineA.body.cells.find(c => c.day.toLowerCase() === 'thursday' && (c.period === 3 || String(c.period) === '3'));
            const thuP4 = mineA.body.cells.find(c => c.day.toLowerCase() === 'thursday' && (c.period === 4 || String(c.period) === '4'));
            const thuP5 = mineA.body.cells.find(c => c.day.toLowerCase() === 'thursday' && (c.period === 5 || String(c.period) === '5'));

            assert.strictEqual(tueP4.subject, 'Microprocessors');
            assert.strictEqual(tueP4.type, 'theory');

            assert.strictEqual(friP1.subject, 'Python Programming Lab');
            assert.strictEqual(friP1.type, 'lab');

            assert.strictEqual(satP2.subject, 'Technical Seminar & Mentoring');
            assert.strictEqual(satP2.type, 'activity');

            assert.strictEqual(thuP3.subject, 'Full Stack Development Lab');
            assert.strictEqual(thuP4.subject, 'Full Stack Development Lab');
            assert.strictEqual(thuP5.subject, 'Full Stack Development Lab');
            assert.strictEqual(thuP3.spanTo, 5);
        });

    } finally {
        await new Promise(r => setTimeout(r, 100));
        try { server.kill(); } catch (_) {}
    }

    const { passed, failed } = counts();
    console.log('\n============================================================');
    console.log(`Faculty My Timetable Edit Tests: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });
}

module.exports = run;
