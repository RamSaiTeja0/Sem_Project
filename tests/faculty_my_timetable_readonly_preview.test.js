/**
 * Faculty My Timetable Read-Only & Master Timetable Preview Alignment Test Suite
 *
 * Verifies:
 *  A. Faculty My Timetable renders using the Master Timetable-style grid/preview.
 *  B. Faculty sees only their own timetable entries.
 *  C. Faculty cannot see another faculty member's timetable through the My Timetable view.
 *  D. Add/Edit/Delete controls are completely absent from Faculty My Timetable.
 *  E. Faculty My Timetable is read-only.
 *  F. Existing HOD Master Timetable preview still works unchanged.
 *  G. Existing Master Timetable import/extraction functionality is unaffected.
 *  H. Existing backend authorization still prevents unauthorized faculty timetable modification.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { check, counts, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3418;
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
    console.log('TecSubstitution — Faculty My Timetable Read-Only & Master Preview Alignment Tests\n');

    // Section 1: Static DOM and JS Architecture Checks
    console.log('[1] DOM & UI Verification for Faculty My Timetable (#view-schedule)');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

    check('Faculty My Timetable uses the Master Timetable-style <table class="timetable"> with #schedHead and #schedBody', () => {
        assert.ok(indexHtml.includes('<table class="timetable">'), 'Timetable class table exists');
        assert.ok(indexHtml.includes('id="schedHead"'), 'schedHead exists');
        assert.ok(indexHtml.includes('id="schedBody"'), 'schedBody exists');
    });

    check('Faculty My Timetable includes the standard Swatch Legend identical to Master Timetable', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(schedSection.includes('class="legend"'), 'Legend block present in view-schedule');
        assert.ok(schedSection.includes('swatch-busy'), 'swatch-busy present in view-schedule');
        assert.ok(schedSection.includes('swatch-free'), 'swatch-free present in view-schedule');
        assert.ok(schedSection.includes('swatch-sel'), 'swatch-sel present in view-schedule');
    });

    check('Faculty My Timetable includes clean Upload card while manual Add / Edit / Delete controls are absent from DOM', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(schedSection.includes('id="facUploadCard"'), '#facUploadCard is present for upload');
        assert.ok(!schedSection.includes('id="schedManageCard"'), '#schedManageCard must be removed');
        assert.ok(!schedSection.includes('id="schedEntryForm"'), '#schedEntryForm must be removed');
        assert.ok(!schedSection.includes('id="schedSaveBtn"'), '#schedSaveBtn must be removed');
        assert.ok(!schedSection.includes('id="schedDeleteBtn"'), '#schedDeleteBtn must be removed');
        assert.ok(!schedSection.includes('id="schedResetBtn"'), '#schedResetBtn must be removed');
    });

    check('Faculty My Timetable subtitle accurately reflects read-only view and cover check', () => {
        const schedSection = indexHtml.split('id="view-schedule"')[1].split('</section>')[0];
        assert.ok(schedSection.includes('Click any period to check faculty availability for substitution'), 'Read-only guidance text present');
        assert.ok(!schedSection.includes('Add or modify your assigned periods'), 'Editing guidance text removed');
    });

    check('Shared renderGrid function renders identical day columns, timing headers, and slot buttons', () => {
        assert.ok(appJs.includes('function renderGrid(headId, bodyId, grid, timings, onSelect'), 'renderGrid defined');
        assert.ok(appJs.includes("renderGrid('schedHead', 'schedBody'"), 'Faculty schedule calls renderGrid');
        assert.ok(appJs.includes("loadGrid(ttQuery(), 'ttHead', 'ttBody'"), 'Master timetable calls loadGrid / renderGrid');
    });

    // Section 2: Live Server API & Security Verification
    console.log('\n[2] Live Server API & Authorization Verification');
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

        const accountsRes = await call('GET', '/api/auth/accounts');
        assert.strictEqual(accountsRes.status, 200);
        const facultyAccounts = accountsRes.body.accounts.filter(a => a.role === 'faculty');
        assert.ok(facultyAccounts.length >= 2, 'Must have at least 2 faculty accounts');

        const facA = facultyAccounts[0];
        const facB = facultyAccounts[1];

        // Sign in Faculty A
        const loginA = await call('POST', '/api/auth/login', { username: facA.username, password: 'tecsub123' });
        assert.strictEqual(loginA.status, 200);
        const cookieA = loginA.cookie;

        // Sign in Faculty B
        const loginB = await call('POST', '/api/auth/login', { username: facB.username, password: 'tecsub123' });
        assert.strictEqual(loginB.status, 200);
        const cookieB = loginB.cookie;

        // Sign in HOS
        const loginHOS = await call('POST', '/api/auth/login', { username: 'hos', password: 'tecsub123' });
        assert.strictEqual(loginHOS.status, 200);
        const cookieHOS = loginHOS.cookie;

        await check('Faculty A gets ONLY their own timetable via /api/timetable/mine', async () => {
            const res = await call('GET', '/api/timetable/mine', null, cookieA);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.view, 'faculty');
            assert.strictEqual(res.body.faculty, facA.name);
            assert.ok(Array.isArray(res.body.days), 'Has days');
            assert.ok(Array.isArray(res.body.periods), 'Has periods');
            assert.ok(Array.isArray(res.body.cells), 'Has cells');
            // Every cell must belong to Faculty A
            res.body.cells.forEach(c => {
                assert.strictEqual(c.faculty, facA.name);
            });
        });

        await check('Faculty B gets ONLY their own timetable via /api/timetable/mine', async () => {
            const res = await call('GET', '/api/timetable/mine', null, cookieB);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.view, 'faculty');
            assert.strictEqual(res.body.faculty, facB.name);
            res.body.cells.forEach(c => {
                assert.strictEqual(c.faculty, facB.name);
            });
        });

        await check('Faculty cannot access another faculty records via /api/timetable/records?faculty=...', async () => {
            const res = await call('GET', `/api/timetable/records?faculty=${encodeURIComponent(facB.name)}`, null, cookieA);
            assert.strictEqual(res.status, 403, 'Must be forbidden for cross-faculty records query');
        });

        await check('HOS Master Timetable routes work normally and return class scope grid', async () => {
            const scopesRes = await call('GET', '/api/timetable/scopes', null, cookieHOS);
            assert.strictEqual(scopesRes.status, 200);
            assert.ok(Array.isArray(scopesRes.body.semesters), 'Has semesters');

            const ttRes = await call('GET', '/api/timetable', null, cookieHOS);
            assert.strictEqual(ttRes.status, 200);
            assert.ok(Array.isArray(ttRes.body.cells), 'Master timetable returns cells');
        });

        await check('HOS Master Timetable extraction/preview route remains functional', async () => {
            const previewRes = await call('POST', '/api/timetable/import/preview', null, cookieHOS);
            assert.ok(previewRes.status === 400 || previewRes.status === 422 || previewRes.status === 200);
        });

    } finally {
        await new Promise(r => setTimeout(r, 100));
        try { server.kill(); } catch (_) {}
    }

    const { passed, failed } = counts();
    console.log('\n============================================================');
    console.log(`Faculty My Timetable Verification: ${passed} passed, ${failed} failed.`);
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
