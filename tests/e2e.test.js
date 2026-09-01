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

/** Headless-browser run: clicks real cells and reads the rendered result. */
async function browserRun(playwright) {
    const launchOptions = process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH } : {};
    const browser = await playwright.chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

    const requests = [];
    page.on('request', r => requests.push({ method: r.method(), url: r.url(), body: r.postData() }));

    try {
        // The landing page is served at "/" and links into the dashboard.
        await page.goto(BASE + '/', { waitUntil: 'networkidle' });

        await checkAsync('the home page loads and explains the project', async () => {
            assert.match(await page.locator('h1').first().textContent(),
                /Smart Faculty Substitution Management/);
            ['#about', '#features', '#workflow', '#excel', '#benefits'].forEach(function () {});
            for (const id of ['about', 'features', 'workflow', 'excel', 'benefits']) {
                assert.strictEqual(await page.locator('#' + id).count(), 1, 'missing section #' + id);
            }
            assert.ok((await page.locator('.feature').count()) >= 9, 'feature cards');
            assert.match(await page.locator('.site-footer').textContent(),
                /Faculty Substitution Management System/);
        });

        await checkAsync('the home page CTA opens the dashboard timetable', async () => {
            await page.click('.hero-actions a[href="/dashboard#timetable"]');
            await page.waitForSelector('#ttBody .slot-btn', { state: 'visible' });
            assert.match(page.url(), /\/dashboard#timetable$/);
        });

        await page.waitForSelector('#ttBody .slot-btn', { state: 'attached' });

        await checkAsync('dashboard loads with the navigation and stats', async () => {
            await page.click('.nav-item[data-view="dashboard"]');
            assert.strictEqual(await page.locator('.nav-item').count(), 8);
            assert.ok((await page.locator('#dashboardStats .stat').count()) >= 4);
            assert.match(await page.locator('#topbarMeta').textContent(), /10 faculty/);
        });

        await checkAsync('the primary timetable renders 35 clickable cells', async () => {
            await page.click('.nav-item[data-view="timetable"]');
            await page.waitForSelector('#ttBody .slot-btn', { state: 'visible' });
            assert.strictEqual(await page.locator('#ttBody .slot-btn').count(), 35);
            assert.strictEqual(await page.locator('#ttHead th').count(), 8);
            assert.strictEqual(await page.locator('#ttBody tr').count(), 5);
        });

        await checkAsync('each cell carries its own day/period/subject metadata', async () => {
            const meta = await page.locator('#ttBody .slot-btn[data-day="Monday"][data-period="2"]')
                .evaluate(el => ({ ...el.dataset }));
            assert.strictEqual(meta.day, 'Monday');
            assert.strictEqual(meta.period, '2');
            assert.strictEqual(meta.subject, 'OS');
            assert.strictEqual(meta.faculty, 'Dr. Meera Nair');
            assert.strictEqual(meta.class, 'CSE-A');
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
            assert.strictEqual(sent.subject, 'OS');

            const shown = (await page.locator('#availResult ul.faculty-list:not(.busy-list) li').allTextContents())
                .map(t => t.replace(/✓/g, '').trim());
            assert.strictEqual(shown.length, 8);
            assert.ok(!shown.some(t => t.startsWith('Dr. Meera Nair')), 'the teaching faculty is excluded');
            assert.ok(!shown.some(t => t.startsWith('Prof. Naveen Reddy')), 'busy elsewhere, excluded');

            assert.strictEqual(await page.locator('#availBody .slot-btn.is-selected').count(), 1);
            assert.match(await page.locator('#availResult .slot-title').textContent(), /Monday — Period 2/);

            // The selected cell is described in full.
            const panel = await page.locator('#availResult').textContent();
            assert.match(panel, /Class\s*CSE-A/);
            assert.match(panel, /Subject\s*OS/);
            assert.match(panel, /Current Faculty\s*Dr\. Meera Nair/);

            // Busy faculty are listed alongside the free ones.
            const busy = (await page.locator('#availResult .busy-list li').allTextContents())
                .map(t => t.replace(/✗/g, '').trim());
            assert.strictEqual(busy.length, 1, 'Prof. Naveen Reddy is busy elsewhere');
            assert.ok(busy[0].startsWith('Prof. Naveen Reddy'));

            // The read-only guarantee is stated where the result is read.
            assert.strictEqual(
                (await page.locator('#readOnlyBanner').textContent()).trim(),
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

        await checkAsync('faculty management and reports render', async () => {
            await page.click('.nav-item[data-view="faculty"]');
            await page.waitForSelector('#facBody tr');
            assert.strictEqual(await page.locator('#facBody tr').count(), 10);

            await page.click('.nav-item[data-view="reports"]');
            await page.waitForSelector('#heatTable td');
            assert.strictEqual(await page.locator('#heatTable tbody tr').count(), 5);
        });

        await checkAsync('the import section previews a CSV without loading it', async () => {
            await page.click('.nav-item[data-view="import"]');
            const csv = 'Faculty,Monday P1,Monday P2\nDr. Preview One,DBMS,FREE\nDr. Preview Two,FREE,OS\n';
            await page.setInputFiles('#importFile',
                { name: 'preview.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
            await page.click('#importPreview');
            await page.waitForSelector('#importResult table.data');
            assert.match(await page.locator('#importResult').textContent(), /Dr\. Preview One/);
            assert.strictEqual(await page.locator('#importConfirm').count(), 1);

            // The loaded timetable is untouched until the user confirms.
            await page.click('.nav-item[data-view="timetable"]');
            assert.strictEqual(await page.locator('#ttBody .slot-btn').count(), 35);
            await page.click('#importCancel').catch(() => {});
        });

        await checkAsync('nothing was assigned or saved', async () => {
            const writes = requests.filter(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
            const unexpected = writes.filter(r =>
                !/\/api\/availability$/.test(r.url) && !/\/api\/timetable\/import\/preview$/.test(r.url));
            assert.deepStrictEqual(unexpected, [], 'only availability lookups and previews may be sent');
            assert.strictEqual(writes.filter(r => /\/api\/timetable\/import$/.test(r.url)).length, 0);

            const actions = await page.evaluate(() =>
                Array.from(document.querySelectorAll('button, a, input[type=submit]'))
                    .map(el => (el.textContent || el.value || '').trim())
                    .filter(t => /\b(assign|allocate|save substitution)\b/i.test(t)));
            assert.deepStrictEqual(actions, [], 'the UI must offer no assign action');
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

    if (playwright) {
        console.log('\n[browser] running against headless Chromium');
        await browserRun(playwright);
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
