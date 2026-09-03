/**
 * Browser test: each branch really is its own application on screen.
 *
 * The API tests prove the server refuses another branch's data. This proves
 * the thing a person actually sees: sign in as one branch and the screen
 * offers no branch selector, names no other branch, and shows exactly that
 * branch's classes, faculty, timetable and availability.
 *
 * It drives a real headless Chromium. When none is available it says so and
 * skips, rather than passing quietly and claiming a check that never ran.
 *
 * Usage: node tests/browserisolation.test.js
 *   PLAYWRIGHT_MODULE=/path/to/playwright-core   when Playwright lives outside
 *   CHROMIUM_PATH=/path/to/chrome                the project's node_modules
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { checkAsync, counts, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3394;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = process.env.DEMO_PASSWORD || 'tecsub123';

function loadPlaywright() {
    const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core']
        .filter(Boolean);
    for (const name of candidates) {
        try { return require(name); } catch (err) { /* try the next one */ }
    }
    return null;
}

/** Honour CHROMIUM_PATH, then PLAYWRIGHT_BROWSERS_PATH, then the bundled build. */
function findChromium() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!root) return null;
    try {
        return fs.readdirSync(root)
            .filter(name => /^chromium-/.test(name))
            .map(name => path.join(root, name, 'chrome-linux', 'chrome'))
            .find(file => fs.existsSync(file)) || null;
    } catch (err) {
        return null;
    }
}

/**
 * EVERY view a branch account can reach from the sidebar — not a sample. A
 * screen nobody tests is where the next leak or stuck spinner will be.
 */
const VIEWS = ['dashboard', 'schedule', 'substitute', 'availability', 'import',
               'timetable', 'manage', 'subjects', 'classes', 'faculty',
               'reports', 'validation', 'about'];

/**
 * A stuck screen is detected STRUCTURALLY, not by scanning for the word
 * "loading": that word appears in ordinary prose ("Errors block a timetable
 * from loading"), and a check that cries wolf is worse than no check. Every
 * element that exists only until real content replaces it carries
 * `data-loading-placeholder`, so one still on screen is genuinely stuck.
 */
function stillLoading(page) {
    return page.$$eval('[data-loading-placeholder]',
        list => list.filter(el => el.offsetParent !== null).map(el => el.id || el.textContent.trim()));
}

async function signIn(page, username) {
    await page.goto(`${BASE}/login`);
    await page.fill('#username', username);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('#topbarMeta', { timeout: 15000 });
    // The dashboard bootstraps asynchronously; wait for it to finish rather
    // than for a fixed delay, so the assertions never race the first render.
    await page.waitForFunction(
        () => !/Loading/i.test(document.getElementById('topbarMeta').textContent),
        null, { timeout: 20000 });
}

/** Text a person can actually read: hidden nodes are excluded. */
function visibleText(page) {
    return page.evaluate(() => {
        const out = [];
        const walk = node => {
            if (node.nodeType === Node.TEXT_NODE) { out.push(node.nodeValue); return; }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const style = window.getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return;
            node.childNodes.forEach(walk);
        };
        walk(document.body);
        // Selected option labels are readable even though the list is closed.
        document.querySelectorAll('select').forEach(select => {
            if (!select.offsetParent) return;
            Array.from(select.options).forEach(o => out.push(o.textContent));
        });
        return out.join(' ');
    });
}

async function run(playwright) {
    const executablePath = findChromium();
    const browser = await playwright.chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox']
    });

    try {
        // The branch list is read from the server rather than hardcoded, so
        // this test keeps working as branches are added or renamed.
        const admin = await browser.newContext();
        const adminPage = await admin.newPage();
        await signIn(adminPage, 'admin');
        const listed = await adminPage.evaluate(() =>
            fetch('/api/branches').then(r => r.json()).then(d => d.branches));
        await admin.close();

        // Only the ACTIVE branches are applications, and only they have
        // accounts to sign in with. An archived branch is checked separately,
        // by confirming it is nowhere to be seen.
        const branches = listed.filter(b => b.active !== false).map(b => b.code);
        const archived = listed.filter(b => b.active === false).map(b => b.code);

        assert.ok(branches.length >= 2,
            'this test needs at least two branches to prove one cannot see the other');
        console.log(`\n  Active branches:   ${branches.join(', ')}`);
        console.log(`  Archived branches: ${archived.join(', ') || 'none'}`);

        for (const branch of branches) {
            const username = 'hos.' + branch.toLowerCase();
            console.log(`\n[${branch}] signed in as ${username}`);

            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            const page = await context.newPage();
            const pageErrors = [];
            const badResponses = [];
            page.on('pageerror', err => pageErrors.push(err.message));
            page.on('response', res => {
                if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
            });

            await signIn(page, username);

            // Nothing from another active branch, and nothing from an archived
            // one, may appear on this branch's screens.
            const others = branches.filter(other => other !== branch).concat(archived);

            await checkAsync(`${branch}: the header names the branch this application serves`, async () => {
                const badge = await page.textContent('#brandBranch');
                assert.strictEqual(badge.trim(), branch + ' /',
                    'the sidebar brand must read "<BRANCH> / TecSubstitution"');
                const meta = await page.textContent('#topbarMeta');
                assert.ok(meta.indexOf(branch) >= 0, `the header line must name ${branch}`);
            });

            await checkAsync(`${branch}: no branch selector is offered anywhere`, async () => {
                const visible = await page.$$eval('[data-branch-selector]',
                    fields => fields.filter(f => f.offsetParent !== null).map(f => f.textContent.trim()));
                assert.deepStrictEqual(visible, [],
                    'a branch account must not be able to choose a branch');
                const branchNav = await page.$eval('.nav-item[data-view="branches"]',
                    item => item.offsetParent !== null).catch(() => false);
                assert.strictEqual(branchNav, false,
                    'Branch Management is an institution-level screen');
            });

            await checkAsync(`${branch}: no other branch is named on any screen`, async () => {
                for (const view of VIEWS) {
                    const nav = await page.$(`.nav-item[data-view="${view}"]`);
                    // A screen hidden for this role is not a leak; skip it.
                    if (!nav || !(await nav.evaluate(el => el.offsetParent !== null))) continue;
                    await nav.click();
                    await page.waitForTimeout(700);
                    const text = await visibleText(page);
                    for (const other of others) {
                        const pattern = new RegExp('\\b' + other + '\\b');
                        assert.ok(!pattern.test(text),
                            `the ${view} view showed "${other}" to a ${branch} account`);
                    }
                }
            });

            await checkAsync(`${branch}: only this branch's classes and faculty are listed`, async () => {
                await page.click('.nav-item[data-view="timetable"]');
                await page.waitForTimeout(700);
                const classes = await page.$$eval('#ttView option', os => os.map(o => o.value));
                assert.ok(classes.length > 0, 'at least one class must be offered');
                classes.forEach(value => assert.ok(
                    value.replace(/^class:/, '').toUpperCase().indexOf(branch) === 0,
                    `class "${value}" does not belong to ${branch}`));

                await page.click('.nav-item[data-view="faculty"]');
                await page.waitForTimeout(900);
                const rows = await page.$$eval('#facBody tr td:nth-child(3)',
                    cells => cells.map(c => c.textContent.trim().toUpperCase()));
                assert.ok(rows.length > 0, 'the faculty directory must not be empty');
                rows.forEach(dept => assert.strictEqual(dept, branch,
                    `the directory listed a ${dept} member to a ${branch} account`));
            });

            await checkAsync(`${branch}: clicking a period returns this branch's free faculty`, async () => {
                await page.click('.nav-item[data-view="availability"]');
                await page.waitForSelector('#availBody .slot-btn', { timeout: 10000 });
                await page.click('#availBody .slot-btn');
                await page.waitForFunction(
                    () => !/Select a period/.test(document.getElementById('availResult').textContent),
                    null, { timeout: 10000 });
                const result = await page.textContent('#availResult');
                assert.ok(result.trim().length > 0, 'the availability panel stayed empty');
                for (const other of others) {
                    assert.ok(!new RegExp('\\b' + other + '\\b').test(result),
                        `availability mentioned ${other} to a ${branch} account`);
                }
            });

            await checkAsync(`${branch}: the application loads clean — no errors, no refusals`, async () => {
                assert.deepStrictEqual(pageErrors, [], 'the page threw a script error');
                assert.deepStrictEqual(badResponses, [],
                    'the branch application asked for something it is not allowed to have');
            });

            await checkAsync(`${branch}: no screen is stuck loading, and no dropdown is empty`, async () => {
                for (const view of VIEWS) {
                    const nav = await page.$(`.nav-item[data-view="${view}"]`);
                    if (!nav || !(await nav.evaluate(el => el.offsetParent !== null))) continue;
                    await nav.click();
                    await page.waitForTimeout(700);

                    // "Still loading" and "stuck loading" look identical in a
                    // single sample. Give the view a fair chance to settle and
                    // only fail when it never does.
                    let pending = await stillLoading(page);
                    for (let waited = 0; waited < 8000 && pending.length; waited += 400) {
                        await page.waitForTimeout(400);
                        pending = await stillLoading(page);
                    }
                    assert.deepStrictEqual(pending, [],
                        `the ${view} view never finished loading`);

                    // An empty visible dropdown is the other half of the
                    // original dashboard complaint.
                    const empty = await page.$$eval(`#view-${view} select`,
                        list => list.filter(s => s.offsetParent !== null && s.options.length === 0)
                            .map(s => '#' + s.id));
                    assert.deepStrictEqual(empty, [],
                        `the ${view} view has an empty dropdown`);
                }
            });

            await context.close();
        }

        // ------------------------------------------- a faculty member's own week
        await checkAsync('a faculty member sees, and can only see, their own upload form', async () => {
            const adminCtx = await browser.newContext();
            const adminPg = await adminCtx.newPage();
            await signIn(adminPg, 'admin');
            const accounts = await adminPg.evaluate(() =>
                fetch('/api/auth/accounts').then(r => r.json()).then(d => d.accounts));
            await adminCtx.close();

            const person = accounts.find(a => a.role === 'faculty');
            assert.ok(person, 'the roster must provide a faculty account');

            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            const page = await context.newPage();
            await signIn(page, person.username);
            await page.click('.nav-item[data-view="schedule"]');
            await page.waitForSelector('#ownUploadCard', { state: 'visible', timeout: 10000 });

            // The form names them, and has no field for whose week it is.
            const who = await page.textContent('#ownUploadWho');
            assert.strictEqual(who.trim(), person.name);
            const facultyFields = await page.$$eval('#ownUploadCard input, #ownUploadCard select',
                els => els.map(e => e.id));
            assert.ok(!facultyFields.some(id => /faculty/i.test(id)),
                'the upload form must not offer a way to name another faculty member');

            // It round-trips their real week.
            await page.click('#ownUploadSample');
            const filled = await page.inputValue('#ownUploadJson');
            const payload = JSON.parse(filled);
            assert.ok(Array.isArray(payload.entries));
            assert.ok(!JSON.stringify(payload).includes('"faculty"'),
                'the payload names no faculty — the server takes it from the session');

            await context.close();
        });

        // A head of section is not a faculty member, so has no own timetable.
        await checkAsync('a head of section is offered no personal upload form', async () => {
            const context = await browser.newContext();
            const page = await context.newPage();
            await signIn(page, 'hos.' + branches[0].toLowerCase());
            await page.click('.nav-item[data-view="schedule"]');
            await page.waitForTimeout(1200);
            const visible = await page.$eval('#ownUploadCard', el => el.offsetParent !== null)
                .catch(() => false);
            assert.strictEqual(visible, false);
            await context.close();
        });

        await checkAsync('an archived branch offers no way in at the sign-in page', async () => {
            if (!archived.length) return;
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(`${BASE}/login`);
            await page.waitForTimeout(1500);
            const text = await page.textContent('body');
            for (const code of archived) {
                assert.ok(!new RegExp('\\b' + code + '\\b').test(text),
                    `the sign-in page offers the archived branch ${code}`);
            }
            // ...and its account really is refused.
            await page.fill('#username', 'hos.' + archived[0].toLowerCase());
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit]');
            await page.waitForTimeout(2000);
            assert.ok(/login/.test(page.url()),
                'an archived branch account must not reach the dashboard');
            await context.close();
        });

        // A branch account cannot reach an institution-level screen by hand.
        const sneaky = await browser.newContext();
        const sneakyPage = await sneaky.newPage();
        await signIn(sneakyPage, 'hos.' + branches[0].toLowerCase());
        await sneakyPage.goto(`${BASE}/dashboard#branches`);
        await sneakyPage.waitForTimeout(2500);
        await checkAsync('a hand-typed #branches lands on the dashboard, not on branch management', async () => {
            const active = await sneakyPage.$eval('.view.is-active', v => v.id);
            assert.strictEqual(active, 'view-dashboard');
        });
        await sneaky.close();
    } finally {
        await browser.close();
    }
}

const playwright = loadPlaywright();

console.log('TecSubstitution — browser branch-isolation test');

if (!playwright) {
    console.log('\n[skip] Playwright is not installed.');
    console.log('       Install it, or set PLAYWRIGHT_MODULE to a playwright-core');
    console.log('       checkout, to run the on-screen isolation checks.');
    console.log('       The API-level isolation tests in branchisolation.test.js still ran.');
    console.log('\n✅ browser isolation: skipped (no browser).');
    process.exit(0);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_REQUIRED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', d => log += d);
server.stderr.on('data', d => log += d);

waitForServer(BASE)
    .then(() => run(playwright))
    .then(() => {
        server.kill();
        const { passed, failed } = counts();
        if (failed) {
            console.error(`\n✗ browser isolation: ${failed} check(s) failed.`);
            process.exit(1);
        }
        console.log(`\n✅ browser isolation: ${passed} checks passed.`);
    })
    .catch(err => {
        server.kill();
        console.error('\n✗ FAILED:', err.message);
        if (log) console.error('\nServer output:\n' + log);
        process.exit(1);
    });
