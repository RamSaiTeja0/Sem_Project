/**
 * End-to-end test: the full click -> API -> engine -> displayed result path.
 *
 * Runs headless in a real browser when Playwright is available; otherwise it
 * exercises the same path over HTTP and says so, rather than silently skipping.
 *
 * Usage: node tests/e2e.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { check, checkAsync, counts, request, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3392;
const BASE = `http://localhost:${PORT}`;

function loadPlaywright() {
    try {
        return require('playwright');
    } catch (err) {
        return null;
    }
}

/**
 * Playwright's own browser download is often skipped in CI images that ship a
 * Chromium of their own. Honour CHROMIUM_PATH, then look for one under
 * PLAYWRIGHT_BROWSERS_PATH, before falling back to Playwright's bundled build.
 */
function findChromium() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!root) return null;
    try {
        const candidates = fs.readdirSync(root)
            .filter(name => /^chromium/.test(name))
            .map(name => path.join(root, name, 'chrome-linux', 'chrome'))
            .filter(file => fs.existsSync(file));
        return candidates[0] || null;
    } catch (err) {
        return null;
    }
}

/** Headless-browser run: clicks real cells and reads the rendered result. */
async function browserRun(playwright) {
    const executablePath = findChromium();
    const browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

    const requests = [];
    page.on('request', r => requests.push({ method: r.method(), url: r.url(), body: r.postData() }));

    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push(err.message));

    try {
        // ------------------------------------------------------ landing page
        await page.goto(BASE + '/', { waitUntil: 'networkidle' });

        await checkAsync('the home page leads with the product promise', async () => {
            const heading = await page.locator('h1').first().textContent();
            assert.match(heading, /Smart Faculty Scheduling/);
            assert.match(heading, /Made Simple/);
            const lede = (await page.locator('.lede').textContent()).replace(/\s+/g, ' ').trim();
            assert.strictEqual(lede,
                'TecSubstitution is a smart platform for managing faculty timetables, ' +
                'substitutions and academic schedules efficiently.');

            for (const id of ['home', 'about', 'features', 'how-it-works']) {
                assert.strictEqual(await page.locator('#' + id).count(), 1, 'missing section #' + id);
            }
            assert.ok((await page.locator('.feature').count()) >= 9, 'feature cards');
        });

        await checkAsync('the header carries the documented navigation and a Login button', async () => {
            const links = (await page.locator('.site-nav a').allTextContents()).map(t => t.trim());
            assert.deepStrictEqual(links, ['Home', 'About', 'Features', 'How It Works', 'Login']);
            assert.strictEqual(await page.locator('.site-nav a[href="/login"]').count(), 1);
        });

        await checkAsync('the hero states the three highlights and both calls to action', async () => {
            const highlights = (await page.locator('.hero-highlights li').allTextContents())
                .map(t => t.replace(/✓/g, '').trim());
            assert.deepStrictEqual(highlights, [
                'Centralized Master Timetable',
                '1-Click Substitute Finding',
                'AI-Assisted Paper Extraction'
            ]);
            const actions = (await page.locator('.hero-actions .btn').allTextContents()).map(t => t.trim());
            assert.deepStrictEqual(actions.slice(0, 2), ['Get Started', 'Explore Features']);
        });

        await checkAsync('the hero preview card shows a real timetable table', async () => {
            const headers = (await page.locator('.preview-table thead th').allTextContents())
                .map(t => t.trim());
            assert.deepStrictEqual(headers, ['Faculty', 'Period', 'Subject', 'Room', 'Status']);
            assert.strictEqual(await page.locator('.preview-table tbody tr').count(), 5);
            const statuses = (await page.locator('.preview-table tbody .badge').allTextContents())
                .map(t => t.trim());
            assert.ok(statuses.includes('Assigned'), 'an assigned row');
            assert.ok(statuses.includes('Substitution'), 'a substitution row');
        });

        await checkAsync('How It Works lists the five numbered steps in order', async () => {
            const numbers = (await page.locator('#how-it-works .step-n').allTextContents())
                .map(t => t.trim());
            assert.deepStrictEqual(numbers, ['01', '02', '03', '04', '05']);
            const titles = (await page.locator('#how-it-works .step h3').allTextContents())
                .map(t => t.trim());
            assert.deepStrictEqual(titles, [
                'Upload Timetable',
                'Extract Timetable Data',
                'Validate Information',
                'Find Substitute Faculty',
                'Review and Manage Timetable'
            ]);
        });

        await checkAsync('the final CTA and footer close the page', async () => {
            assert.strictEqual(await page.locator('.cta').count(), 1);
            assert.match(await page.locator('.site-footer').textContent(),
                /Faculty Substitution Management System/);
        });

        // -------------------------------------------------------- sign-in
        await checkAsync('the Login button opens the sign-in page and a demo account works', async () => {
            await page.click('.site-nav a[href="/login"]');
            await page.waitForSelector('#loginForm');

            // A wrong password is refused, and no session is started.
            await page.fill('#username', 'admin');
            await page.fill('#password', 'definitely-wrong');
            await page.click('#loginSubmit');
            await page.waitForSelector('#loginMessage.is-error');
            assert.match(await page.locator('#loginMessage').textContent(), /Incorrect username or password/);

            // The demo chip fills the form; the right password signs in.
            await page.click('.demo-chip[data-user="kiran.reddy"]');
            await page.click('#loginSubmit');
            await page.waitForURL(/\/dashboard/);
            await page.waitForSelector('#ttBody .slot-btn', { state: 'attached' });
        });

        await checkAsync('the top bar shows who is signed in, with a logout control', async () => {
            assert.strictEqual(await page.locator('#userName').textContent(), 'Prof. Kiran Reddy');
            assert.match(await page.locator('#userRole').textContent(), /Faculty · CSE/);
            assert.strictEqual(await page.locator('#userAvatar').textContent(), 'KR');
            assert.ok(await page.locator('#logoutBtn').isVisible(), 'the logout button is shown');
            assert.ok(!(await page.locator('#loginLink').isVisible()), 'the login link is hidden');
        });

        // ------------------------------------------------------- dashboard
        await checkAsync('the dashboard sidebar keeps every feature reachable', async () => {
            const items = (await page.locator('.nav-item[data-view]').allTextContents()).map(t => t.trim());
            assert.deepStrictEqual(items, [
                'Dashboard', 'My Schedule', 'Adjust / Substitute', 'Faculty Availability',
                'Upload Paper Sheet', 'Attendance Track',
                'Master Timetable', 'Add Timetable', 'Faculty Directory',
                'Availability Summary', 'Settings / About'
            ]);
            assert.strictEqual(await page.locator('.nav a[href="/"]').count(), 1, 'a Home link');
            assert.strictEqual(await page.locator('#sidebarLogout').count(), 1, 'a Logout control');
        });

        await checkAsync('the dashboard shows the professional stat cards', async () => {
            await page.click('.nav-item[data-view="dashboard"]');
            await page.waitForSelector('#dashboardStats .stat');
            const labels = (await page.locator('#dashboardStats .stat-label').allTextContents())
                .map(t => t.trim());
            ['Total faculty', 'Available faculty', 'Busy faculty', 'Timetable slots', 'Conflicts']
                .forEach(label => assert.ok(labels.includes(label), 'missing stat card: ' + label));
            assert.match(await page.locator('#topbarMeta').textContent(), /12 faculty/);
            assert.ok((await page.locator('#workloadCard table.data tbody tr').count()) > 0, 'workload rows');
        });

        await checkAsync('checking a slot from the dashboard updates the cards and activity', async () => {
            await page.selectOption('#dashDay', 'Monday');
            await page.selectOption('#dashPeriod', '2');
            await page.click('#dashCheck');
            await page.waitForSelector('#dashResult .faculty-list');
            await page.waitForFunction(() =>
                !document.querySelector('#activityList .activity-empty'));
            assert.match(await page.locator('#activityList').textContent(), /Checked Monday P2/);
        });

        // -------------------------------------------------- master timetable
        await checkAsync('the master timetable renders 35 clickable cells', async () => {
            await page.click('.nav-item[data-view="timetable"]');
            await page.waitForSelector('#ttBody .slot-btn', { state: 'visible' });
            assert.strictEqual(await page.locator('#ttBody .slot-btn').count(), 35);
            assert.strictEqual(await page.locator('#ttHead th').count(), 8);
            assert.strictEqual(await page.locator('#ttBody tr').count(), 5);
            // Free and scheduled cells are visually distinct states.
            assert.ok((await page.locator('#ttBody .slot-btn.is-empty').count()) > 0, 'free cells');
            assert.strictEqual(await page.locator('.legend').first().locator('span').count(), 3);
        });

        await checkAsync('each cell carries its own day/period/subject metadata', async () => {
            const meta = await page.locator('#ttBody .slot-btn[data-day="Monday"][data-period="2"]')
                .evaluate(el => ({ ...el.dataset }));
            assert.strictEqual(meta.day, 'Monday');
            assert.strictEqual(meta.period, '2');
            assert.strictEqual(meta.subject, 'Operating Systems');
            assert.strictEqual(meta.faculty, 'Prof. Kiran Reddy');
            assert.strictEqual(meta.class, 'CSE-A');
            assert.strictEqual(meta.status, 'busy');
        });

        // --- the core end-to-end assertion ---
        await checkAsync('clicking Monday P2 sends the right data and shows free faculty', async () => {
            const before = requests.length;
            await page.click('.nav-item[data-view="availability"]');
            await page.click('#availBody .slot-btn[data-day="Monday"][data-period="2"]');
            await page.waitForSelector('#availResult ul.faculty-list:not(.busy-list)');

            const posted = requests.slice(before)
                .find(r => r.method === 'POST' && r.url.endsWith('/api/availability'));
            assert.ok(posted, 'a POST to /api/availability must be made');
            const sent = JSON.parse(posted.body);
            assert.strictEqual(sent.day, 'Monday');
            assert.strictEqual(sent.period, 2);
            assert.strictEqual(sent.subject, 'Operating Systems');

            const shown = (await page.locator('#availResult ul.faculty-list:not(.busy-list) li').allTextContents())
                .map(t => t.replace(/✓/g, '').trim());
            assert.strictEqual(shown.length, 8);
            assert.ok(!shown.some(t => t.startsWith('Prof. Kiran Reddy')), 'the teaching faculty is excluded');
            assert.ok(!shown.some(t => t.startsWith('Dr. Priya Sharma')), 'busy elsewhere, excluded');

            assert.strictEqual(await page.locator('#availBody .slot-btn.is-selected').count(), 1);
            assert.match(await page.locator('#availResult .slot-title').textContent(), /Monday — Period 2/);

            // The selected cell is described in full.
            const panel = await page.locator('#availResult').textContent();
            assert.match(panel, /Class\s*CSE-A/);
            assert.match(panel, /Subject\s*Operating Systems/);
            assert.match(panel, /Current Faculty\s*Prof\. Kiran Reddy/);

            // Busy faculty are listed alongside the free ones.
            const busy = (await page.locator('#availResult .busy-list li').allTextContents())
                .map(t => t.replace(/✗/g, '').trim());
            // Three others teach at Monday P2, in CSE-B, CSE-C and ECE-A.
            assert.strictEqual(busy.length, 3, 'three faculty are busy elsewhere');
            busy.forEach(entry => assert.ok(!shown.includes(entry), 'busy faculty are never listed free'));

            // The read-only guarantee is stated where the result is read.
            assert.strictEqual(
                (await page.locator('#availResult .readonly-banner').textContent()).trim(),
                'READ ONLY — No substitution has been assigned.');
        });

        await checkAsync('several more cells each resolve correctly', async () => {
            const picks = [['Tuesday', 1], ['Wednesday', 5], ['Thursday', 4], ['Friday', 2]];
            for (const [day, period] of picks) {
                const before = requests.length;
                await page.click(`#availBody .slot-btn[data-day="${day}"][data-period="${period}"]`);
                await page.waitForSelector('#availResult ul.faculty-list:not(.busy-list), #availResult .notice-warn');

                const posted = requests.slice(before)
                    .find(r => r.method === 'POST' && r.url.endsWith('/api/availability'));
                const sent = JSON.parse(posted.body);
                assert.strictEqual(sent.day, day);
                assert.strictEqual(sent.period, period);

                // Cross-check the rendered list against the API directly.
                const api = await page.evaluate(async p => {
                    const res = await fetch('/api/availability', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(p)
                    });
                    return (await res.json()).availableFaculty;
                }, { day, period, faculty: sent.faculty });
                const shown = (await page.locator('#availResult ul.faculty-list:not(.busy-list) li').allTextContents())
                    .map(t => t.replace(/✓/g, '').replace(/\s*(CSE|ECE|General)\s*$/, '').trim());
                assert.deepStrictEqual(shown, api, `${day} P${period} display must match the engine`);
            }
        });

        await checkAsync('the department filter narrows the availability result', async () => {
            await page.selectOption('#availDept', 'ECE');
            await page.waitForFunction(() => {
                const items = document.querySelectorAll('#availResult ul.faculty-list:not(.busy-list) li');
                return items.length > 0 &&
                    Array.from(items).every(li => /ECE/.test(li.textContent));
            });
            await page.selectOption('#availDept', '');
        });

        // ------------------------------------------------------ my schedule
        await checkAsync('My Schedule shows the signed-in faculty\'s own week', async () => {
            await page.click('.nav-item[data-view="schedule"]');
            await page.waitForSelector('#schedBody .slot-btn');
            assert.strictEqual(await page.locator('#schedFaculty').inputValue(), 'Prof. Kiran Reddy');
            assert.strictEqual(await page.locator('#schedBody .slot-btn').count(), 35);
            assert.ok((await page.locator('#schedStats .stat').count()) >= 4, 'schedule stat cards');

            // Clicking one of her own periods lists who could cover it.
            await page.click('#schedBody .slot-btn[data-day="Monday"][data-period="2"]');
            await page.waitForSelector('#schedResult ul.faculty-list:not(.busy-list)');
            const shown = await page.locator('#schedResult ul.faculty-list:not(.busy-list) li').allTextContents();
            assert.ok(!shown.some(t => t.includes('Prof. Kiran Reddy')),
                'the teaching faculty cannot cover for themselves');
        });

        // ------------------------------------------------ adjust / substitute
        await checkAsync('Adjust / Substitute lists cover for a whole day', async () => {
            await page.click('.nav-item[data-view="substitute"]');
            await page.selectOption('#subFaculty', 'Dr. Arjun Rao');
            await page.selectOption('#subDay', 'Monday');
            await page.click('#subFind');
            await page.waitForSelector('#subResult table.data tbody tr');
            assert.ok((await page.locator('#subResult table.data tbody tr').count()) > 0);
            assert.match(await page.locator('#subResult').textContent(), /No substitution has been assigned/);
        });

        // -------------------------------------------------- faculty + reports
        await checkAsync('faculty directory and reports render, with working filters', async () => {
            await page.click('.nav-item[data-view="faculty"]');
            await page.waitForSelector('#facBody tr');
            assert.strictEqual(await page.locator('#facBody tr').count(), 12);

            await page.selectOption('#facDept', 'ECE');
            await page.waitForFunction(() => document.querySelectorAll('#facBody tr').length === 4);

            await page.fill('#facSearch', 'anitha');
            await page.waitForFunction(() => document.querySelectorAll('#facBody tr').length === 1);
            await page.fill('#facSearch', '');
            await page.selectOption('#facDept', '');

            await page.click('.nav-item[data-view="reports"]');
            await page.waitForSelector('#heatTable td');
            assert.strictEqual(await page.locator('#heatTable tbody tr').count(), 5);
        });

        // ------------------------------------------------------- attendance
        await checkAsync('Attendance Track marks a period locally and says so', async () => {
            await page.click('.nav-item[data-view="attendance"]');
            await page.waitForSelector('#attBody tr .mark');
            assert.match(await page.locator('#view-attendance .notice-warn').textContent(),
                /saved in this browser/);

            const before = requests.length;
            await page.click('#attBody tr:first-child .mark[data-mark="held"]');
            await page.waitForSelector('#attBody tr:first-child .mark.is-on');
            assert.match(await page.locator('#attBody tr:first-child .att-status').textContent(), /Held/);

            // Marking attendance must not write anything to the server.
            const writes = requests.slice(before)
                .filter(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
            assert.deepStrictEqual(writes, [], 'attendance marks are local only');

            await page.click('#attReset');
            await page.waitForFunction(() =>
                !document.querySelector('#attBody .mark.is-on'));
        });

        // ------------------------------------------------ upload paper sheet
        await checkAsync('the upload view previews a CSV without loading it', async () => {
            await page.click('.nav-item[data-view="import"]');
            assert.strictEqual(await page.locator('.wf-step').count(), 6);

            const csv = 'Faculty,Monday P1,Monday P2\nDr. Preview One,DBMS,FREE\nDr. Preview Two,FREE,OS\n';
            await page.setInputFiles('#importFile',
                { name: 'preview.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
            await page.click('#importPreview');
            await page.waitForSelector('#importResult table.data');
            assert.match(await page.locator('#importResult').textContent(), /Dr\. Preview One/);
            assert.strictEqual(await page.locator('#importConfirm').count(), 1);
            assert.ok((await page.locator('.wf-step.is-active[data-step="preview"]').count()) === 1,
                'the workflow stepper reaches Preview');

            // The loaded timetable is untouched until the user confirms.
            await page.click('.nav-item[data-view="timetable"]');
            assert.strictEqual(await page.locator('#ttBody .slot-btn').count(), 35);
            await page.click('.nav-item[data-view="import"]');
            await page.click('#importCancel');
        });

        await checkAsync('a scanned PDF is refused with a clear, honest message', async () => {
            await page.setInputFiles('#importFile',
                { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
            await page.click('#importPreview');
            await page.waitForSelector('#importResult .notice-warn');
            assert.match(await page.locator('#importResult').textContent(),
                /OCR key, which is not configured|Unsupported file type/);
        });

        await checkAsync('a department preset fills Quick Paste and previews through the same importer', async () => {
            await page.click('.tab[data-tab="preset"]');
            await page.click('.preset[data-preset="ECE — Semester III"]');
            await page.waitForSelector('#tab-paste.is-active');
            assert.match(await page.locator('#pasteText').inputValue(), /Dr\. Anitha Menon/);
            assert.strictEqual(await page.locator('#pasteClass').inputValue(), 'ECE-A');

            await page.click('#pastePreview');
            await page.waitForSelector('#importResult table.data');
            const text = await page.locator('#importResult').textContent();
            assert.match(text, /quick-paste\.csv/);
            assert.match(text, /Prof\. Naveen Reddy/);
            await page.click('#importCancel');
        });

        await checkAsync('Quick Paste accepts tab-separated rows too', async () => {
            await page.click('.tab[data-tab="paste"]');
            await page.fill('#pasteText',
                'Faculty\tMonday P1\tMonday P2\nDr. Tab One\tDBMS\tFREE\nDr. Tab Two\tFREE\tOS');
            await page.click('#pastePreview');
            await page.waitForSelector('#importResult table.data');
            assert.match(await page.locator('#importResult').textContent(), /Dr\. Tab One/);
            await page.click('#importCancel');
        });

        // ------------------------------------------------------- guarantees
        await checkAsync('nothing was assigned or saved', async () => {
            const writes = requests.filter(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
            const unexpected = writes.filter(r =>
                !/\/api\/availability$/.test(r.url) &&
                !/\/api\/timetable\/import\/preview$/.test(r.url) &&
                !/\/api\/auth\/(login|logout)$/.test(r.url));
            assert.deepStrictEqual(unexpected, [],
                'only availability lookups, import previews and sign-in may be sent');
            assert.strictEqual(writes.filter(r => /\/api\/timetable\/import$/.test(r.url)).length, 0);

            const actions = await page.evaluate(() =>
                Array.from(document.querySelectorAll('button, a, input[type=submit]'))
                    .map(el => (el.textContent || el.value || '').trim())
                    .filter(t => /\b(assign|allocate|save substitution)\b/i.test(t)));
            assert.deepStrictEqual(actions, [], 'the UI must offer no assign action');
        });

        await checkAsync('no page raised a JavaScript error along the way', async () => {
            assert.deepStrictEqual(consoleErrors, []);
        });

        await checkAsync('logging out returns to the sign-in page', async () => {
            await page.click('#logoutBtn');
            await page.waitForURL(/\/login/);
            const session = await page.evaluate(async () =>
                (await (await fetch('/api/auth/session')).json()).authenticated);
            assert.strictEqual(session, false);
        });

        if (process.env.SHOT) {
            await page.screenshot({ path: process.env.SHOT, fullPage: true });
        }
    } finally {
        await browser.close();
    }
}

/** Fallback: the same path over HTTP when no browser is installed. */
async function httpRun() {
    const grid = await request(BASE, 'GET', '/api/timetable');

    await checkAsync('the grid exposes every clickable coordinate', async () => {
        assert.strictEqual(grid.body.cells.length, 35);
    });

    await checkAsync('a clicked cell payload returns the free faculty', async () => {
        const cell = grid.body.cells.find(c => c.day === 'Monday' && c.period === 2);
        const res = await request(BASE, 'POST', '/api/availability', {
            day: cell.day, period: cell.period, subject: cell.subject,
            faculty: cell.faculty, class: cell.className
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.totalAvailable, 8);
        assert.ok(!res.body.availableFaculty.includes(cell.faculty));
    });

    await checkAsync('every cell resolves and never offers its own faculty', async () => {
        for (const cell of grid.body.cells) {
            const res = await request(BASE, 'POST', '/api/availability', {
                day: cell.day, period: cell.period, faculty: cell.faculty
            });
            assert.strictEqual(res.status, 200);
            if (cell.faculty) assert.ok(!res.body.availableFaculty.includes(cell.faculty));
            // Excluding the cell's own faculty removes them from both lists,
            // so the totals cover the roster minus that one person.
            assert.strictEqual(res.body.totalAvailable + res.body.totalBusy,
                cell.faculty ? 9 : 10, `${cell.day} P${cell.period}`);
        }
    });
}

async function run() {
    console.log('TecSubstitution — end-to-end test');
    const playwright = loadPlaywright();

    let browserLaunched = false;
    if (playwright) {
        try {
            await playwright.chromium.launch(
                findChromium() ? { executablePath: findChromium() } : {}).then(b => b.close());
            browserLaunched = true;
        } catch (err) {
            console.log('\n[http] Playwright is installed but no browser could be launched');
            console.log('       (' + err.message.split('\n')[0] + ') — exercising the same');
            console.log('       click -> API -> engine -> result path over HTTP instead.');
        }
    }

    if (browserLaunched) {
        console.log('\n[browser] running against headless Chromium');
        await browserRun(playwright);
    } else if (playwright) {
        await httpRun();
    } else {
        console.log('\n[http] Playwright is not installed — exercising the same');
        console.log('       click -> API -> engine -> result path over HTTP instead.');
        await httpRun();
    }

    const { passed } = counts();
    console.log(`\n✅ e2e: ${passed} checks passed.`);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', d => log += d);
server.stderr.on('data', d => log += d);

waitForServer(BASE)
    .then(run)
    .then(() => server.kill())
    .catch(err => {
        console.error('\n✗ FAILED:', err.message);
        if (log) console.error('\nServer output:\n' + log);
        server.kill();
        process.exit(1);
    });
