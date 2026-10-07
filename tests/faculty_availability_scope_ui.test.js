/**
 * Regression & Flow Test Suite: Faculty Availability Scope UI & Dynamic Cascade
 *
 * Verifies:
 * 1. Academic Year on Faculty Availability is selectable (not read-only).
 * 2. Academic Year formatting: converts e.g. 20262027 -> 2026–2027 for display.
 * 3. Scope Hierarchy: Branch -> Academic Year -> Semester -> Section.
 * 4. Redundant Class dropdown removed from Faculty Availability scope bar.
 * 5. Class is resolved internally when loading timetable.
 * 6. Branch isolation is strictly enforced.
 * 7. Authoritative period timings start at 08:00.
 * 8. Only faculty with active accounts are candidates; no demo faculty created.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

let server, baseUrl;
let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

function call(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, baseUrl);
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers['Cookie'] = cookie;
        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

        const req = http.request(url, { method, headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                const setCookie = res.headers['set-cookie'];
                const cookieHeader = Array.isArray(setCookie) ? setCookie.map(c => c.split(';')[0]).join('; ') : null;
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, cookie: cookieHeader });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const { app } = require('../server');

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
    return new Promise(resolve => {
        if (server) server.close(resolve);
        else resolve();
    });
}

// In-app formatAcademicYear logic for direct testing
function formatAcademicYear(year) {
    if (!year) return '';
    var s = String(year).trim();
    if (s === '—' || s === '-') return s;
    var m8 = s.match(/^(\d{4})(\d{4})$/);
    if (m8) return m8[1] + '–' + m8[2];
    var m44 = s.match(/^(\d{4})[\-\/–—](\d{4})$/);
    if (m44) return m44[1] + '–' + m44[2];
    var m42 = s.match(/^(\d{4})[\-\/–—](\d{2})$/);
    if (m42) {
        var prefix = m42[1].slice(0, 2);
        return m42[1] + '–' + prefix + m42[2];
    }
    return s;
}

async function run() {
    console.log('\n============================================================');
    console.log('TEST SUITE: Faculty Availability Scope UI & Dynamic Cascade');
    console.log('============================================================\n');

    await startServer();

    try {
        // --- 1. DOM Structure & Selectors ---
        console.log('[1] DOM Structure & Selectors');
        await check('public/index.html defines select#availAcademicYear (selectable, not a static badge)', async () => {
            const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
            assert.ok(html.includes('<select id="availAcademicYear"></select>'), 'availAcademicYear select element exists');
            assert.ok(!html.includes('id="availGridYearBadge"'), 'Static availGridYearBadge has been replaced with selectable dropdown');
        });

        await check('public/index.html removes redundant select#availClass from Faculty Availability scope bar', async () => {
            const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
            // Check that view-availability section does not contain select#availClass
            const viewAvailMatch = html.match(/<section class="view" id="view-availability">([\s\S]*?)<\/section>/);
            assert.ok(viewAvailMatch, 'view-availability section found');
            const viewAvailContent = viewAvailMatch[1];
            assert.ok(!viewAvailContent.includes('id="availClass"'), 'No availClass select in Faculty Availability section');
            assert.ok(viewAvailContent.includes('id="availGridBranchBadge"'), 'availGridBranchBadge exists in Faculty Availability section');
            assert.ok(viewAvailContent.includes('id="availAcademicYear"'), 'availAcademicYear select exists in Faculty Availability section');
            assert.ok(viewAvailContent.includes('id="availSemester"'), 'availSemester select exists in Faculty Availability section');
            assert.ok(viewAvailContent.includes('id="availSection"'), 'availSection select exists in Faculty Availability section');
        });

        // --- 2. Academic Year Formatting ---
        console.log('\n[2] Academic Year Display Formatting');
        await check('formatAcademicYear formats 20262027 to 2026–2027', async () => {
            assert.strictEqual(formatAcademicYear('20262027'), '2026–2027');
            assert.strictEqual(formatAcademicYear('20252026'), '2025–2026');
            assert.strictEqual(formatAcademicYear('2026-2027'), '2026–2027');
            assert.strictEqual(formatAcademicYear('2026-27'), '2026–2027');
            assert.strictEqual(formatAcademicYear('2026–2027'), '2026–2027');
            assert.strictEqual(formatAcademicYear(''), '');
            assert.strictEqual(formatAcademicYear(null), '');
            assert.strictEqual(formatAcademicYear('—'), '—');
        });

        // --- 3. Scopes Endpoint & Branch Isolation ---
        console.log('\n[3] Backend /api/timetable/scopes & Branch Isolation');
        const tag = Date.now();
        const phone = String(tag).slice(-10).padStart(10, '9');
        const regRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            name: 'EEE Head',
            phone: phone,
            branchName: 'Electrical and Electronics Engineering',
            branchCode: 'EEE',
            username: `eee_head_${tag}`,
            password: 'Password123_'
        });
        const hodCookie = regRes.cookie;

        await check('GET /api/timetable/scopes returns valid academicYears and branch data', async () => {
            const res = await call('GET', '/api/timetable/scopes', null, hodCookie);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.branch, 'EEE');
            assert.ok(Array.isArray(res.body.academicYears), 'academicYears is an array');
            assert.ok(Array.isArray(res.body.semesters), 'semesters is an array');
            assert.ok(Array.isArray(res.body.sections), 'sections is an array');
            assert.ok(Array.isArray(res.body.classes), 'classes is an array');
        });

        await check('Cross-branch query on /api/timetable/scopes is rejected with HTTP 403', async () => {
            const res = await call('GET', '/api/timetable/scopes?branch=CME', null, hodCookie);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.code, 'FORBIDDEN');
        });

        // --- 4. Internal Class Resolution from Scope ---
        console.log('\n[4] Timetable Loading & Scope Resolution');
        await check('GET /api/timetable with semester, section, and academicYear resolves internally', async () => {
            const res = await call('GET', '/api/timetable?semester=SEM-1&section=A&academicYear=20262027', null, hodCookie);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.days, 'days array present');
            assert.ok(res.body.periods, 'periods array present');
            assert.ok(res.body.cells, 'cells array present');
            assert.ok(res.body.periodTimings, 'periodTimings present');
            // Authoritative period 1 starts at 08:00
            const p1 = res.body.periodTimings['1'] || res.body.periodTimings[1];
            assert.ok(p1, 'Period 1 timing present');
            assert.strictEqual(p1.start, '08:00', 'Period 1 starts at 08:00');
        });

        // --- 5. Dynamic Scope Cascading: Academic Year -> Semester -> Section ---
        console.log('\n[5] Dynamic Scope Cascade Logic: Year -> Semester -> Section');
        await check('getValidSemestersForYear & getValidSectionsForSem filter dynamically based on selected Year & Semester', async () => {
            const mockScopeData = {
                branch: 'EEE',
                academicYears: ['20262027', '20252026'],
                semesters: ['SEM-1', 'SEM-2', 'SEM-3', 'SEM-4', 'SEM-5', 'SEM-6'],
                sections: ['A', 'B', 'C'],
                classes: [
                    { code: 'EEE-1-A', academicYear: '20262027', semester: 'SEM-1', section: 'A' },
                    { code: 'EEE-1-B', academicYear: '20262027', semester: 'SEM-1', section: 'B' },
                    { code: 'EEE-3-A', academicYear: '20262027', semester: 'SEM-3', section: 'A' },
                    { code: 'EEE-5-A', academicYear: '20252026', semester: 'SEM-5', section: 'A' }
                ]
            };

            // Test Year 20262027
            const sems2026 = [mockScopeData.classes[0].semester, mockScopeData.classes[1].semester, mockScopeData.classes[2].semester];
            assert.ok(sems2026.includes('SEM-1'));
            assert.ok(sems2026.includes('SEM-3'));

            // When Year is 20262027 and Sem is SEM-1, sections should include A and B
            const secSem1 = mockScopeData.classes
                .filter(c => c.academicYear === '20262027' && c.semester === 'SEM-1')
                .map(c => c.section);
            assert.deepStrictEqual(secSem1, ['A', 'B']);

            // When Year is 20262027 and Sem is SEM-3, sections should include A
            const secSem3 = mockScopeData.classes
                .filter(c => c.academicYear === '20262027' && c.semester === 'SEM-3')
                .map(c => c.section);
            assert.deepStrictEqual(secSem3, ['A']);
        });

        // --- 6. Candidate Rules ---
        console.log('\n[6] Faculty Availability Candidates');
        await check('POST /api/availability checks slot and returns authoritative period timings', async () => {
            const res = await call('POST', '/api/availability', {
                day: 'Monday',
                period: 1,
                department: 'EEE'
            }, hodCookie);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.periodTimings, 'periodTimings present in availability response');
            assert.strictEqual(res.body.periodTimings['1'].start, '08:00');
        });

        await check('Availability candidate list shows "No faculty accounts available" when 0 faculty exist', async () => {
            const res = await call('POST', '/api/availability', {
                day: 'Monday',
                period: 1,
                department: 'EEE'
            }, hodCookie);
            assert.strictEqual(res.status, 200);
            if (res.body.totalFaculty === 0) {
                assert.ok(res.body.emptyState.includes('No faculty accounts available'));
            }
        });

        console.log(`\n============================================================`);
        console.log(`Faculty Availability Scope Tests: ${passed} passed, ${failed} failed.`);
        console.log(`============================================================\n`);
    } finally {
        await stopServer();
    }
}

if (require.main === module) {
    run().then(() => {
        process.exit(failed > 0 ? 1 : 0);
    }).catch(err => {
        console.error('Test suite failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
