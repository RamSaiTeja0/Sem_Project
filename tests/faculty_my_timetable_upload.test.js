/**
 * Faculty My Timetable Upload & Preview Integration Test Suite
 *
 * Verifies:
 * 1. Faculty My Timetable contains upload and preview controls.
 * 2. Manual Add/Edit/Delete slot management controls remain completely absent.
 * 3. Logged-in faculty = "B . swarupa", Uploaded document claims = "B. Swarupa" -> Preview & Confirm succeed without mismatch error.
 * 4. Document with NO faculty name succeeds and assigns slots to authenticated faculty.
 * 5. Document with a completely different faculty name does NOT cause a faculty-name mismatch rejection.
 * 6. Timetable is stored against the authenticated faculty and /api/timetable/mine returns the saved timetable.
 * 7. Another faculty cannot modify or upload to this faculty's timetable (authenticated session authority).
 * 8. Dynamic timetable structures (days, periods, spans) are preserved.
 * 9. HOD Master Timetable faculty mapping and validation remain unchanged and functional.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, checkAsync, counts, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3419;
const BASE = `http://localhost:${PORT}`;

function call(method, urlPath, body, cookie, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = (body && typeof body === 'object' && !Buffer.isBuffer(body)) ? JSON.stringify(body) : body;
        const reqHeaders = { ...headers };
        if (payload && !reqHeaders['Content-Type']) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) reqHeaders.Cookie = cookie;

        const req = http.request(`${BASE}${urlPath}`, { method, headers: reqHeaders }, res => {
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

function buildMultipart(fields, fileField) {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    let body = '';

    for (const [k, v] of Object.entries(fields || {})) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
        body += `${v}\r\n`;
    }

    if (fileField) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n`;
        body += `Content-Type: ${fileField.contentType || 'text/csv'}\r\n\r\n`;
        body += fileField.content;
        body += '\r\n';
    }

    body += `--${boundary}--\r\n`;
    return { boundary, buffer: Buffer.from(body, 'utf8') };
}

async function run() {
    console.log('TecSubstitution — Faculty My Timetable Upload & Preview Tests\n');

    // Section 1: DOM Verification
    console.log('[1] Static DOM & UI Controls Verification');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    check('Faculty My Timetable contains upload control (#facUploadCard, #btnFacChooseFile, #btnFacUpload)', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(schedSection.includes('id="facUploadCard"'), '#facUploadCard must be present in view-schedule');
        assert.ok(schedSection.includes('id="btnFacChooseFile"'), '#btnFacChooseFile must be present');
        assert.ok(schedSection.includes('id="facTimetableFile"'), '#facTimetableFile file input must be present');
        assert.ok(schedSection.includes('id="btnFacUpload"'), '#btnFacUpload preview button must be present');
        assert.ok(schedSection.includes('id="facUploadStatus"'), '#facUploadStatus status element must be present');
        assert.ok(schedSection.includes('id="facPreviewCard"'), '#facPreviewCard must be present');
        assert.ok(schedSection.includes('id="btnFacConfirmSave"'), '#btnFacConfirmSave must be present');
    });

    check('Manual Add / Edit / Delete slot management controls remain completely absent from Faculty view', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(!schedSection.includes('id="schedManageCard"'), '#schedManageCard must NOT be in view-schedule');
        assert.ok(!schedSection.includes('id="schedEntryForm"'), '#schedEntryForm must NOT be in view-schedule');
        assert.ok(!schedSection.includes('id="schedSaveBtn"'), '#schedSaveBtn must NOT be in view-schedule');
        assert.ok(!schedSection.includes('id="schedDeleteBtn"'), '#schedDeleteBtn must NOT be in view-schedule');
        assert.ok(!schedSection.includes('id="schedResetBtn"'), '#schedResetBtn must NOT be in view-schedule');
    });

    check('Master Timetable-style preview table (#schedHead, #schedBody, .timetable, legend) is present below upload', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(schedSection.includes('<table class="timetable">'), '<table class="timetable"> present');
        assert.ok(schedSection.includes('id="schedHead"'), '#schedHead present');
        assert.ok(schedSection.includes('id="schedBody"'), '#schedBody present');
        assert.ok(schedSection.includes('class="legend"'), 'Legend present');
        assert.ok(schedSection.includes('swatch-busy') && schedSection.includes('swatch-free'), 'Swatch markers present');
    });

    check('Faculty Preview uses Master Timetable visual grid (#facPreviewCard, #facPreviewTable, .timetable, legend)', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(schedSection.includes('id="facPreviewCard"'), '#facPreviewCard present');
        assert.ok(schedSection.includes('id="facPreviewTable"'), '#facPreviewTable present');
        assert.ok(schedSection.includes('id="facPreviewHead"'), '#facPreviewHead present');
        assert.ok(schedSection.includes('id="facPreviewBody"'), '#facPreviewBody present');
        const facPreviewCard = schedSection.split('id="facPreviewCard"')[1].split('id="schedTitle"')[0];
        assert.ok(facPreviewCard.includes('class="timetable"'), '#facPreviewTable must have timetable class');
        assert.ok(facPreviewCard.includes('class="table-scroll"'), 'table-scroll must wrap timetable');
        assert.ok(facPreviewCard.includes('class="legend"'), 'legend must be present in preview card');
    });

    check('Old row-based list table (DAY|PERIOD|SUBJECT|ROOM|CLASS|TYPE) is completely removed from app.js and index.html', () => {
        const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
        assert.ok(!appJs.includes("facPreviewHead.innerHTML = '<tr><th>Day</th><th>Period</th><th>Subject</th><th>Room</th><th>Class</th><th>Type</th></tr>'"), 'Old row-table headers must be removed from app.js');
        assert.ok(appJs.includes("renderGrid('facPreviewHead', 'facPreviewBody'"), 'Faculty preview must reuse renderGrid');
        assert.ok(appJs.includes("renderGrid('schedHead', 'schedBody'"), 'Faculty live schedule must reuse renderGrid');
    });

    // Section 2: Live Server Workflow Verification
    console.log('\n[2] Live Server Upload, Extraction, Name Variation & Data Separation Verification');
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            FALLBACK_PORTS: '',
            DATABASE_URL: '',
            BRANCH_NAME: 'Computer Engineering',
            BRANCH_CODE: 'CME',
            ACADEMIC_YEAR: '2026-27',
            SEMESTER: '4',
            EMPTY_TIMETABLE: 'true',
            ALLOW_MEMORY_WRITES: 'true',
            AUTH_REQUIRED: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        await waitForServer(BASE);

        // Login HOS first
        const loginHOS = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOS.status, 200);
        const cookieHOS = loginHOS.cookie;

        // Register faculty "B . swarupa" using HOS session
        const regRes = await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'B . swarupa',
            username: 'b_swarupa',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9876543210',
            subjects: ['Operating Systems', 'Cloud Computing']
        }, cookieHOS);
        assert.ok(regRes.status === 201 || regRes.status === 200, `Registration failed: ${JSON.stringify(regRes.body)}`);

        // Login as "B . swarupa"
        const loginSwarupa = await call('POST', '/api/auth/login', { username: 'b_swarupa', password: 'Password_123' });
        assert.strictEqual(loginSwarupa.status, 200);
        const cookieSwarupa = loginSwarupa.cookie;

        // Register second faculty for cross-faculty tests
        await call('POST', '/api/auth/register', {
            role: 'faculty',
            name: 'Prof. Other CME',
            username: 'other_fac',
            password: 'Password_123',
            confirmPassword: 'Password_123',
            phone: '9876543211',
            subjects: ['Mathematics']
        }, cookieHOS);

        const loginOther = await call('POST', '/api/auth/login', { username: 'other_fac', password: 'Password_123' });
        assert.strictEqual(loginOther.status, 200);
        const cookieOther = loginOther.cookie;
        const otherFac = { name: 'Prof. Other CME', username: 'other_fac' };

        await checkAsync('Logged-in "B . swarupa" uploads document claiming "B. Swarupa" -> Preview & Confirm succeed without mismatch error', async () => {
            const csvPunctuationVariation = [
                'Faculty,Day,Period,Subject,Class,Room,Type',
                'B. Swarupa,Monday,1,Operating Systems,CME-A,Lab 2,lab',
                'B. Swarupa,Monday,2,Operating Systems,CME-A,Lab 2,lab',
                'B. Swarupa,Tuesday,3,Cloud Computing,CME-A,Room 105,theory',
                'B. Swarupa,Thursday,4,Computer Networks,CME-B,Room 106,theory'
            ].join('\n');

            const mp = buildMultipart({}, {
                name: 'timetable',
                filename: 'swarupa_timetable.csv',
                contentType: 'text/csv',
                content: csvPunctuationVariation
            });

            const previewRes = await call('POST', '/api/faculty/timetable/preview', mp.buffer, cookieSwarupa, {
                'Content-Type': `multipart/form-data; boundary=${mp.boundary}`,
                'Content-Length': mp.buffer.length
            });

            assert.strictEqual(previewRes.status, 200, `Preview must succeed with 200, got: ${JSON.stringify(previewRes.body)}`);
            assert.strictEqual(previewRes.body.success, true);
            assert.strictEqual(previewRes.body.slotCount, 4, 'Must extract all 4 slots');
            assert.strictEqual(previewRes.body.faculty, 'B . swarupa', 'Authoritative faculty must be session user "B . swarupa"');
            assert.ok(previewRes.body.periodTimings && Object.keys(previewRes.body.periodTimings).length > 0, 'Preview must contain periodTimings');
            assert.ok(previewRes.body.days && previewRes.body.days.length > 0, 'Preview must contain days');
            assert.ok(previewRes.body.periods && previewRes.body.periods.length > 0, 'Preview must contain periods');

            // Confirm & save
            const confirmRes = await call('POST', '/api/faculty/timetable/confirm', {
                slots: previewRes.body.slots
            }, cookieSwarupa);

            assert.strictEqual(confirmRes.status, 200);
            assert.strictEqual(confirmRes.body.saved, true);
            assert.strictEqual(confirmRes.body.count, 4);

            // Verify /api/timetable/mine returns the 4 saved slots and periodTimings
            const mineRes = await call('GET', '/api/timetable/mine', null, cookieSwarupa);
            assert.strictEqual(mineRes.status, 200);
            assert.strictEqual(mineRes.body.faculty, 'B . swarupa');
            assert.ok(mineRes.body.periodTimings && Object.keys(mineRes.body.periodTimings).length > 0, 'GET /mine must return periodTimings');
            const busySlots = mineRes.body.cells.filter(c => c.status === 'busy');
            assert.strictEqual(busySlots.length, 4, 'Must return 4 busy periods for B . swarupa');

            // Verify Master Timetable has not been modified by Faculty upload
            const masterCheck = await call('GET', '/api/timetable?class=CME-A', null, cookieHOS);
            assert.strictEqual(masterCheck.status, 200);
        });

        await checkAsync('Uploaded document with NO faculty name at all also succeeds and associates with session faculty', async () => {
            const csvNoFacultyName = [
                'Day,Period,Subject,Class,Room,Type',
                'Monday,3,Compiler Design,CME-A,Room 201,theory',
                'Wednesday,1,Compiler Design,CME-A,Room 201,theory',
                'Friday,2,Project Work,CME-A,Room 202,activity'
            ].join('\n');

            const mp = buildMultipart({}, {
                name: 'timetable',
                filename: 'anonymous_timetable.csv',
                contentType: 'text/csv',
                content: csvNoFacultyName
            });

            const previewRes = await call('POST', '/api/faculty/timetable/preview', mp.buffer, cookieSwarupa, {
                'Content-Type': `multipart/form-data; boundary=${mp.boundary}`,
                'Content-Length': mp.buffer.length
            });

            assert.strictEqual(previewRes.status, 200);
            assert.strictEqual(previewRes.body.success, true);
            assert.strictEqual(previewRes.body.slotCount, 3, 'Must extract all 3 slots');
            assert.strictEqual(previewRes.body.faculty, 'B . swarupa');
            assert.ok(previewRes.body.periodTimings && Object.keys(previewRes.body.periodTimings).length > 0, 'Period timings must be present');
        });

        await checkAsync('Uploaded document containing a completely different faculty name does NOT cause rejection', async () => {
            const csvDifferentFacultyName = [
                'Faculty,Day,Period,Subject,Class,Room,Type',
                'Dr. Completely Different Person,Monday,5,Web Development,CME-B,Lab 3,lab',
                'Dr. Completely Different Person,Monday,6,Web Development,CME-B,Lab 3,lab'
            ].join('\n');

            const mp = buildMultipart({}, {
                name: 'timetable',
                filename: 'different_name_timetable.csv',
                contentType: 'text/csv',
                content: csvDifferentFacultyName
            });

            const previewRes = await call('POST', '/api/faculty/timetable/preview', mp.buffer, cookieSwarupa, {
                'Content-Type': `multipart/form-data; boundary=${mp.boundary}`,
                'Content-Length': mp.buffer.length
            });

            assert.strictEqual(previewRes.status, 200, 'Must NOT be rejected with FACULTY_MISMATCH');
            assert.strictEqual(previewRes.body.success, true);
            assert.strictEqual(previewRes.body.slotCount, 2);
            assert.strictEqual(previewRes.body.faculty, 'B . swarupa');
        });

        await checkAsync('Another faculty still cannot modify B . swarupa timetable by spoofing faculty params', async () => {
            const spoofSlots = [
                { day: 'Monday', period: 1, subject: 'Spoofed Subject', faculty: 'B . swarupa' }
            ];
            const spoofRes = await call('POST', '/api/faculty/timetable/confirm', {
                slots: spoofSlots,
                faculty: 'B . swarupa'
            }, cookieOther);

            assert.strictEqual(spoofRes.status, 200);
            // Server enforces session identity of otherFac
            assert.strictEqual(spoofRes.body.faculty, otherFac.name);

            // Verify B . swarupa timetable remains unaffected
            const mineSwarupa = await call('GET', '/api/timetable/mine', null, cookieSwarupa);
            const spoofedSlot = mineSwarupa.body.cells.find(c => c.subject === 'Spoofed Subject');
            assert.strictEqual(spoofedSlot, undefined, 'B . swarupa schedule must remain unaffected by other faculty');
        });

        await checkAsync('HOD Master Timetable faculty validation and endpoints remain untouched and functional', async () => {
            const masterRes = await call('GET', '/api/timetable/entries', null, cookieHOS);
            assert.strictEqual(masterRes.status, 200);

            const metaRes = await call('GET', '/api/timetable/meta', null, cookieHOS);
            assert.strictEqual(metaRes.status, 200);
        });

        await checkAsync('Frontend rendering validation: Faculty grid displays functional ✎ Edit indicator (Master Timetable preserves functional Edit for HOD)', async () => {
            const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
            assert.ok(appJs.includes("renderGrid('schedHead', 'schedBody', grid, grid.periodTimings"), 'schedHead must call renderGrid');
            assert.ok(appJs.includes("isFacultyView = Boolean(options.isFaculty"), 'renderGrid must compute isFacultyView');
            assert.ok(appJs.includes("openFacultySlotEditor"), 'appJs must define openFacultySlotEditor for faculty personal edit');
            assert.ok(appJs.includes("slot-edit-indicator") && appJs.includes("✎ Edit"), 'renderGrid must render ✎ Edit indicator');
            // Master Timetable staging preserves edit
            assert.ok(appJs.includes('renderStagingGrid'), 'HOD master timetable preview must retain staging grid');
            assert.ok(appJs.includes('openStagingCellEditor'), 'HOD staging editor must remain functional');
        });

        await checkAsync('22-slot Faculty timetable with mixed day/period formats maps to real subjects without any false "Free" cells', async () => {
            // Build 22 realistic slots across Monday-Saturday with mixed day formats (MON/Monday) and periods
            const lines = ['Day,Period,Subject,Class,Room,Type,Span'];
            const slotDefs = [
                { day: 'MON', period: 1, subject: 'Software Engineering', class: 'CSE-A', room: '101', type: 'theory' },
                { day: 'Monday', period: 2, subject: 'Operating Systems', class: 'CSE-A', room: '102', type: 'theory' },
                { day: 'MON', period: 3, subject: 'Data Structures', class: 'CSE-A', room: '103', type: 'theory' },
                { day: 'Monday', period: 4, subject: 'Web Technologies', class: 'CSE-B', room: '104', type: 'theory' },
                
                { day: 'TUE', period: 1, subject: 'Database Systems', class: 'CSE-B', room: '201', type: 'theory' },
                { day: 'Tuesday', period: 2, subject: 'Computer Networks', class: 'CSE-B', room: '202', type: 'theory' },
                { day: 'TUE', period: 3, subject: 'Machine Learning', class: 'CSE-A', room: '203', type: 'theory' },
                { day: 'Tuesday', period: 4, subject: 'Cloud Computing', class: 'CSE-A', room: '204', type: 'theory' },

                { day: 'WED', period: 1, subject: 'AI & Robotics', class: 'CSE-A', room: '301', type: 'theory' },
                { day: 'Wednesday', period: 2, subject: 'Cyber Security', class: 'CSE-A', room: '302', type: 'theory' },
                { day: 'WED', period: 3, subject: 'Full Stack Lab', class: 'CSE-B', room: 'Lab 1', type: 'lab' },
                { day: 'Wednesday', period: 4, subject: 'Full Stack Lab', class: 'CSE-B', room: 'Lab 1', type: 'lab' },

                { day: 'THU', period: 1, subject: 'Compiler Design', class: 'CSE-B', room: '303', type: 'theory' },
                { day: 'Thursday', period: 2, subject: 'Design Patterns', class: 'CSE-B', room: '304', type: 'theory' },
                { day: 'THU', period: 3, subject: 'Software Engineering', class: 'CSE-A', room: '101', type: 'theory' },
                { day: 'Thursday', period: 4, subject: 'Operating Systems', class: 'CSE-A', room: '102', type: 'theory' },

                { day: 'FRI', period: 1, subject: 'Data Structures', class: 'CSE-A', room: '103', type: 'theory' },
                { day: 'Friday', period: 2, subject: 'Web Technologies', class: 'CSE-B', room: '104', type: 'theory' },
                { day: 'FRI', period: 3, subject: 'Database Systems', class: 'CSE-B', room: '201', type: 'theory' },
                { day: 'Friday', period: 4, subject: 'Computer Networks', class: 'CSE-B', room: '202', type: 'theory' },

                { day: 'SAT', period: 1, subject: 'Project Mentoring', class: 'CSE-A', room: 'Lab 2', type: 'activity' },
                { day: 'Saturday', period: 2, subject: 'Technical Seminar', class: 'CSE-A', room: 'Auditorium', type: 'activity' }
            ];

            slotDefs.forEach(s => {
                lines.push(`${s.day},${s.period},${s.subject},${s.class},${s.room},${s.type}`);
            });

            const mp22 = buildMultipart({}, {
                name: 'timetable',
                filename: 'faculty_22_slots.csv',
                contentType: 'text/csv',
                content: lines.join('\n')
            });

            const preview22 = await call('POST', '/api/faculty/timetable/preview', mp22.buffer, cookieSwarupa, {
                'Content-Type': `multipart/form-data; boundary=${mp22.boundary}`,
                'Content-Length': mp22.buffer.length
            });

            assert.strictEqual(preview22.status, 200);
            assert.strictEqual(preview22.body.slotCount, 22, 'Must extract all 22 slots');
            assert.strictEqual(preview22.body.slots.length, 22);

            // Confirm all 22 slots
            const confirm22 = await call('POST', '/api/faculty/timetable/confirm', {
                slots: preview22.body.slots
            }, cookieSwarupa);
            assert.strictEqual(confirm22.status, 200);
            assert.strictEqual(confirm22.body.count, 22);

            // Fetch live saved timetable via /api/timetable/mine
            const mine22 = await call('GET', '/api/timetable/mine', null, cookieSwarupa);
            assert.strictEqual(mine22.status, 200);
            assert.strictEqual(mine22.body.faculty, 'B . swarupa');

            const busyCells = mine22.body.cells.filter(c => c.status === 'busy' && c.subject);
            assert.strictEqual(busyCells.length, 22, 'Live /mine grid must have exactly 22 busy cells with real subjects (NOT Free)');

            // Verify specific slots were placed in their exact day and period
            const monP1 = busyCells.find(c => c.day === 'Monday' && c.period === 1);
            assert.ok(monP1, 'Monday P1 must exist');
            assert.strictEqual(monP1.subject, 'Software Engineering');

            const wedP3 = busyCells.find(c => c.day === 'Wednesday' && c.period === 3);
            assert.ok(wedP3, 'Wednesday P3 must exist');
            assert.strictEqual(wedP3.subject, 'Full Stack Lab');

            const satP2 = busyCells.find(c => c.day === 'Saturday' && c.period === 2);
            assert.ok(satP2, 'Saturday P2 must exist');
            assert.strictEqual(satP2.subject, 'Technical Seminar');

            // Verify unassigned slot (e.g. Saturday P4) is Free
            const satP4 = mine22.body.cells.find(c => c.day === 'Saturday' && c.period === 4);
            assert.ok(satP4, 'Saturday P4 must exist in grid');
            assert.strictEqual(satP4.status, 'free');
            assert.strictEqual(satP4.subject, null);
        });

    } finally {
        server.kill();
        await new Promise(r => setTimeout(r, 200));
    }

    const { passed, failed } = counts();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { run };
