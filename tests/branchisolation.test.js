/**
 * Branch isolation — the security suite.
 *
 * Each branch must behave like its own application. These tests sign in as a
 * real user of one branch and then ATTEMPT to reach another branch's data, by
 * query string and by request body. Isolation is only proven by the attempt
 * being refused, so every case below performs the unauthorized call for real.
 *
 * Also covers the controlled exception: one faculty identity may teach in a
 * second branch and must appear there, without that branch learning their home
 * branch or gaining any access to it.
 *
 * Usage: node tests/branchisolation.test.js
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { check, checkAsync, counts } = require('./helpers');

const PORT = process.env.TEST_PORT || 3397;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = process.env.DEMO_PASSWORD || 'tecsub123';

/** A tiny cookie-aware client, so each account keeps its own session. */
function client() {
    let cookie = null;
    return function call(method, urlPath, body) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const headers = {};
            if (payload) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(payload);
            }
            if (cookie) headers.Cookie = cookie;

            const req = http.request(`${BASE}${urlPath}`, { method, headers }, res => {
                const setCookie = res.headers['set-cookie'];
                if (setCookie && setCookie.length) cookie = setCookie[0].split(';')[0];
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (e) { /* html */ }
                    resolve({ status: res.statusCode, body: parsed, raw: data });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    };
}

async function signIn(username) {
    const call = client();
    const res = await call('POST', '/api/auth/login', { username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `sign-in failed for ${username}: ${res.raw}`);
    return { call, user: res.body.user };
}

/** Branches present in the loaded data, discovered rather than hardcoded. */
let BRANCHES = [];
let ALL_BRANCHES = [];
let ARCHIVED = [];

async function main() {
    console.log('TecSubstitution — branch isolation security tests');

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), AUTH_REQUIRED: 'true', FALLBACK_PORTS: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    server.stdout.on('data', d => log += d);
    server.stderr.on('data', d => log += d);

    try {
        // Wait for the server, then discover the branches as the coordinator.
        const admin = await (async () => {
            for (let attempt = 0; attempt < 40; attempt++) {
                try { return await signIn('admin'); }
                catch (err) { await new Promise(r => setTimeout(r, 250)); }
            }
            throw new Error('server never became ready');
        })();

        // The database connects asynchronously after the port opens. Wait for
        // storage to settle, or the write-path checks below would see "no
        // database" and skip themselves on a run that does have one.
        for (let attempt = 0; attempt < 40; attempt++) {
            const health = await admin.call('GET', '/api/health');
            if (!process.env.DATABASE_URL || health.body.storage === 'postgres') break;
            await new Promise(r => setTimeout(r, 250));
        }

        // The ACTIVE branches — the ones that are applications with accounts.
        // Discovered rather than hardcoded, so archiving or adding a branch
        // changes what this suite tests without changing the suite.
        const branchList = await admin.call('GET', '/api/branches');
        ALL_BRANCHES = branchList.body.branches.map(b => b.code);
        BRANCHES = branchList.body.branches.filter(b => b.active !== false).map(b => b.code);
        ARCHIVED = branchList.body.branches.filter(b => b.active === false).map(b => b.code);
        console.log('\n  active branches:   ' + BRANCHES.join(', '));
        console.log('  archived branches: ' + (ARCHIVED.join(', ') || 'none'));

        await branchIdentityTests();
        await sessionTests();
        await isolationMatrix();
        await hosTests();
        await masterTimetableTests();
        await facultyTests();
        await facultyOwnershipTests();
        await crossBranchTests();
    } catch (err) {
        console.error('\nServer output:\n' + log);
        throw err;
    } finally {
        server.kill();
    }

    const { passed } = counts();
    console.log(`\n✅ branch isolation: ${passed} checks passed.`);
}

// --------------------------------------------- the final branch identity
async function branchIdentityTests() {
    console.log('\n[0] Final branch identity — CME, EEE, MEC');

    check('the active branch set is exactly CME, EEE and MEC', () => {
        assert.deepStrictEqual(BRANCHES.slice().sort(), ['CME', 'EEE', 'MEC']);
    });

    check('EE is not a separate branch — it is a spelling of EEE', () => {
        assert.ok(!ALL_BRANCHES.includes('EE'),
            'EE must have been merged into EEE, not kept alongside it');
        const branchScope = require('../src/core/branchScope');
        assert.strictEqual(branchScope.code('EE'), 'EEE',
            'the old spelling must resolve to the canonical branch');
        assert.strictEqual(branchScope.code('ee'), 'EEE');
    });

    check('ECE is archived — kept in the data, absent from the application', () => {
        assert.ok(!BRANCHES.includes('ECE'), 'ECE must not be an active branch');
        const branchScope = require('../src/core/branchScope');
        assert.strictEqual(branchScope.isActiveBranch('ECE'), false);
    });

    await checkAsync('an archived branch has no accounts to sign in with', async () => {
        const attempt = await client()('POST', '/api/auth/login',
            { username: 'hos.ece', password: PASSWORD });
        assert.strictEqual(attempt.status, 401,
            'signing in as the archived branch\'s HOS must fail');

        const directory = await client()('GET', '/api/auth/accounts');
        const branches = new Set(directory.body.accounts.map(a => a.department));
        assert.ok(!branches.has('ECE'), 'no ECE account may be offered on the sign-in page');
    });

    await checkAsync('no ordinary caller can reach the archived branch by naming it', async () => {
        for (const account of ['admin', ...BRANCHES.map(b => `hos.${b.toLowerCase()}`)]) {
            const session = await signIn(account);
            const isCoordinator = account === 'admin';

            for (const path of ['/api/faculty?department=ECE', '/api/subjects?branch=ECE',
                                '/api/classes?branch=ECE', '/api/timetable?class=ECE-A']) {
                const res = await session.call('GET', path);
                if (isCoordinator) {
                    // The coordinator is the one role that can un-archive it.
                    assert.ok(res.status < 400, `admin should still reach ${path}`);
                } else {
                    assert.ok(res.status === 403 || res.status === 404,
                        `${account} reached ${path} (got ${res.status})`);
                }
            }
        }
    });
}

// ------------------------------------------------- session carries the branch
async function sessionTests() {
    console.log('\n[1] Authentication determines the branch');

    for (const branch of BRANCHES) {
        const hos = await signIn(`hos.${branch.toLowerCase()}`);
        await checkAsync(`${branch} HOS signs in and is pinned to ${branch}`, async () => {
            assert.strictEqual(hos.user.department, branch);
            assert.strictEqual(hos.user.role, 'hos');
            const meta = await hos.call('GET', '/api/timetable/meta');
            assert.strictEqual(meta.body.branch, branch, 'the API reports the session branch');
        });
    }

    const cme = await signIn('hos.cme');
    await checkAsync('a branch account is offered no branch selector', async () => {
        const branches = await cme.call('GET', '/api/branches');
        assert.strictEqual(branches.body.count, 1, 'only its own branch is listed');
        assert.strictEqual(branches.body.branches[0].code, 'CME');
    });
}

// ------------------------------------- every branch pair, both directions
async function isolationMatrix() {
    console.log('\n[2] Cross-branch access is refused (every pair, both directions)');

    for (const mine of BRANCHES) {
        const session = await signIn(`hos.${mine.toLowerCase()}`);
        const others = BRANCHES.filter(b => b !== mine);

        for (const other of others) {
            await checkAsync(`${mine} user cannot reach ${other} data`, async () => {
                // 1. faculty directory by query string
                const faculty = await session.call('GET', `/api/faculty?department=${other}`);
                assert.strictEqual(faculty.status, 403, `GET /api/faculty?department=${other}`);
                assert.strictEqual(faculty.body.code, 'BRANCH_FORBIDDEN');

                // 2. availability by request body — the documented attack
                const availability = await session.call('POST', '/api/availability',
                    { day: 'Monday', period: 3, branch: other });
                assert.strictEqual(availability.status, 403, 'POST /api/availability {branch}');

                // 3. subjects and classes by query string
                const subjects = await session.call('GET', `/api/subjects?branch=${other}`);
                const classes = await session.call('GET', `/api/classes?branch=${other}`);
                assert.strictEqual(subjects.status, 403);
                assert.strictEqual(classes.status, 403);

                // 4. the other branch's timetable by class name
                const otherClasses = (await signIn(`hos.${other.toLowerCase()}`))
                    .call('GET', '/api/timetable/meta');
                const target = (await otherClasses).body.classes[0];
                if (target) {
                    const grid = await session.call('GET', `/api/timetable?class=${encodeURIComponent(target)}`);
                    assert.ok(grid.status === 403 || grid.status === 404,
                        `reading ${other}'s class ${target} must not succeed (got ${grid.status})`);
                }
            });
        }
    }
}

// --------------------------------------------------------------- HOS scope
async function hosTests() {
    console.log('\n[3] Each HOS manages only their own branch');

    for (const branch of BRANCHES) {
        const hos = await signIn(`hos.${branch.toLowerCase()}`);

        await checkAsync(`${branch} HOS sees ${branch} timetable, faculty and availability`, async () => {
            const meta = await hos.call('GET', '/api/timetable/meta');
            assert.strictEqual(meta.status, 200);
            assert.ok(meta.body.classes.length > 0, `${branch} must have classes`);
            meta.body.classes.forEach(name =>
                assert.ok(name.toUpperCase().startsWith(branch), `${name} is not a ${branch} class`));

            const faculty = await hos.call('GET', '/api/faculty');
            assert.strictEqual(faculty.status, 200);
            assert.ok(faculty.body.count > 0, `${branch} must have faculty`);
            faculty.body.faculty.forEach(f =>
                assert.strictEqual(f.department, branch,
                    `${f.name} is shown as ${f.department}, leaking a foreign branch`));

            const grid = await hos.call('GET', '/api/timetable');
            assert.strictEqual(grid.status, 200);
            assert.strictEqual(grid.body.branch, branch);

            const availability = await hos.call('POST', '/api/availability', { day: 'Monday', period: 3 });
            assert.strictEqual(availability.status, 200);
            assert.strictEqual(availability.body.branch, branch);
        });

        // Validation warnings are free text about the whole loaded dataset, so
        // they are the easiest place for another branch's class or faculty name
        // to escape. This is the regression guard for exactly that.
        await checkAsync(`${branch} HOS reads no diagnostics about another branch`, async () => {
            const meta = await hos.call('GET', '/api/timetable/meta');
            const reference = await hos.call('GET', '/api/timetable/entries/reference');
            assert.strictEqual(reference.status, 200);

            const mine = new Set(meta.body.classes);
            const admin = await signIn('admin');
            const everyClass = (await admin.call('GET', '/api/timetable/meta')).body.classes;
            const foreign = everyClass.filter(name => !mine.has(name));

            const shown = JSON.stringify({
                warnings: meta.body.warnings,
                reference: reference.body
            });
            foreign.forEach(name => assert.ok(!shown.includes(name),
                `a ${branch} account was shown "${name}"`));
            BRANCHES.filter(b => b !== branch).forEach(other => assert.ok(
                !shown.includes(other), `a ${branch} account was shown the branch code "${other}"`));
        });
    }
}

// ------------------------------------------- master timetable (HOS CRUD)
/**
 * The write path, exercised for real: each HOS creates, edits and deletes an
 * entry in their own branch, and is refused on every other branch's.
 *
 * With no database configured the writes answer 503 by design, so the suite
 * asserts that instead — it never reports a CRUD check as passed when the write
 * never happened.
 */
async function masterTimetableTests() {
    console.log('\n[3b] Master timetable — each HOS manages only their own branch');

    const probe = await signIn(`hos.${BRANCHES[0].toLowerCase()}`);
    const listedProbe = await probe.call('GET', '/api/timetable/entries');
    const canWrite = listedProbe.status !== 503;
    if (!canWrite) {

        console.log('  [skip] no database configured — timetable writes answer 503.');
        await checkAsync('without a database the write path refuses rather than pretending', async () => {
            const res = await probe.call('POST', '/api/timetable/entries',
                { class: `${BRANCHES[0]}-A`, day: 'Monday', period: 1, subject: 'x', faculty: 'y' });
            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.body.code, 'DATABASE_REQUIRED');
        });
        return;
    }

    for (const branch of BRANCHES) {
        const hos = await signIn(`hos.${branch.toLowerCase()}`);

        // Work on a real entry: free a slot by deleting one, then restore it.
        const listed = await hos.call('GET', '/api/timetable/entries');
        const mine = (listed.body.entries || []).filter(e => e.faculty && e.className);
        if (!mine.length) {
            console.log(`  [skip] ${branch} has no timetable entries to exercise.`);
            continue;
        }
        const original = mine[0];

        await checkAsync(`${branch} HOS can delete and re-create an entry in ${branch}`, async () => {
            const removed = await hos.call('DELETE', `/api/timetable/entries/${original.id}`);
            assert.strictEqual(removed.status, 200, `delete failed: ${removed.raw}`);

            const created = await hos.call('POST', '/api/timetable/entries', {
                class: original.className, day: original.day, period: original.period,
                subject: original.subject, faculty: original.faculty,
                room: original.room, type: original.type
            });
            assert.strictEqual(created.status, 201, `re-create failed: ${created.raw}`);
            assert.strictEqual(created.body.entry.className, original.className);

            // ...and can edit it.
            const edited = await hos.call('PUT', `/api/timetable/entries/${created.body.entry.id}`, {
                class: original.className, day: original.day, period: original.period,
                subject: original.subject, faculty: original.faculty,
                room: original.room, type: original.type
            });
            assert.strictEqual(edited.status, 200, `edit failed: ${edited.raw}`);
        });

        // Whoever now holds that slot is the target for the refusal checks.
        const refreshed = await hos.call('GET', '/api/timetable/entries',
            undefined);
        const target = (refreshed.body.entries || [])
            .find(e => e.className === original.className &&
                       e.day === original.day && e.period === original.period);

        for (const other of BRANCHES.filter(b => b !== branch)) {
            const outsider = await signIn(`hos.${other.toLowerCase()}`);

            await checkAsync(`${other} HOS cannot read, edit or delete a ${branch} entry`, async () => {
                const read = await outsider.call('GET', `/api/timetable/entries/${target.id}`);
                assert.strictEqual(read.status, 404,
                    'another branch\'s entry must read as absent, not as forbidden-but-present');

                const edit = await outsider.call('PUT', `/api/timetable/entries/${target.id}`, {
                    class: target.className, day: target.day, period: target.period,
                    subject: target.subject, faculty: target.faculty
                });
                assert.ok(edit.status === 403 || edit.status === 404,
                    `edit must not succeed (got ${edit.status})`);

                const remove = await outsider.call('DELETE', `/api/timetable/entries/${target.id}`);
                assert.ok(remove.status === 403 || remove.status === 404,
                    `delete must not succeed (got ${remove.status})`);

                // And the entry is still there afterwards.
                const after = await hos.call('GET', `/api/timetable/entries/${target.id}`);
                assert.strictEqual(after.status, 200, 'the entry must have survived');
            });

            await checkAsync(`${other} HOS cannot create an entry in ${branch}`, async () => {
                const res = await outsider.call('POST', '/api/timetable/entries', {
                    class: target.className, day: target.day, period: 7,
                    subject: target.subject, faculty: target.faculty
                });
                assert.strictEqual(res.status, 403);
                assert.strictEqual(res.body.code, 'BRANCH_FORBIDDEN');
            });
        }

        await checkAsync(`${branch} rejects an entry whose class or subject is not its own`, async () => {
            const foreign = BRANCHES.find(b => b !== branch);
            const theirs = await signIn(`hos.${foreign.toLowerCase()}`);
            const theirEntry = ((await theirs.call('GET', '/api/timetable/entries')).body.entries || [])[0];
            if (!theirEntry) return;

            // A subject belonging to another branch, on one of OUR classes:
            // the branch guard passes (our class) so only the ownership
            // validation can catch it.
            const res = await hos.call('POST', '/api/timetable/entries', {
                class: original.className, day: original.day, period: original.period,
                subject: theirEntry.subject, faculty: original.faculty
            });
            assert.ok(res.status === 400 || res.status === 403,
                `a foreign subject must be refused (got ${res.status}: ${res.raw})`);
        });
    }
}

// --------------------------------------- a faculty member's own timetable
async function facultyOwnershipTests() {
    console.log('\n[4b] Faculty own timetable — identity comes from the session');

    // Two colleagues in the same branch: the sharpest test of ownership, since
    // branch isolation cannot be what refuses the write.
    const admin = await signIn('admin');
    const roster = (await admin.call('GET', '/api/faculty?department=' + BRANCHES[0])).body.faculty;
    assert.ok(roster.length >= 2, 'need two colleagues in one branch for this test');

    const accounts = (await admin.call('GET', '/api/auth/accounts')).body.accounts;
    const usernameOf = name => (accounts.find(a => a.name === name) || {}).username;

    const meName = roster[0].name;
    const colleagueName = roster[1].name;
    const me = await signIn(usernameOf(meName));
    const colleague = await signIn(usernameOf(colleagueName));

    await checkAsync('a faculty member can read their own timetable', async () => {
        const mine = await me.call('GET', '/api/timetable/entries/mine');
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.body.faculty, meName);
        assert.strictEqual(mine.body.branch, BRANCHES[0]);
        mine.body.entries.forEach(entry =>
            assert.strictEqual(entry.faculty, meName, 'only their own periods'));
    });

    const canWrite = (await me.call('GET', '/api/timetable/entries/mine')).body.editable;
    if (!canWrite) {
        console.log('  [skip] no database configured — uploads answer 503.');
        await checkAsync('without a database the upload refuses rather than pretending', async () => {
            const res = await me.call('POST', '/api/timetable/entries/mine',
                { entries: [{ day: 'Monday', period: 1, class: `${BRANCHES[0]}-A`, subject: 'x' }] });
            assert.strictEqual(res.status, 503);
        });
        return;
    }

    const before = (await colleague.call('GET', '/api/timetable/entries/mine')).body;

    await checkAsync('a faculty member cannot upload a colleague\'s timetable', async () => {
        // Every field a browser could use to name someone else, all at once.
        const attempt = await me.call('POST', '/api/timetable/entries/mine', {
            faculty: colleagueName,
            facultyName: colleagueName,
            facultyId: 'FAC999',
            mode: 'replace',
            entries: []
        });
        // An empty upload is refused on its own merits; what matters is that it
        // did not touch the colleague.
        assert.ok(attempt.status >= 400);

        const after = (await colleague.call('GET', '/api/timetable/entries/mine')).body;
        assert.strictEqual(after.count, before.count,
            'the colleague\'s timetable must be untouched');
    });

    await checkAsync('an upload naming a colleague is written to the SENDER instead', async () => {
        const myWeek = (await me.call('GET', '/api/timetable/entries/mine')).body.entries
            .filter(e => e.className);
        assert.ok(myWeek.length, 'the sender needs at least one period to round-trip');

        const row = myWeek[0];
        const res = await me.call('POST', '/api/timetable/entries/mine', {
            faculty: colleagueName,          // ignored: identity comes from the session
            facultyId: 'FAC999',             // ignored
            mode: 'replace',
            entries: myWeek.map(e => ({
                day: e.day, period: e.period, class: e.className,
                subject: e.subject, room: e.room, type: e.type
            }))
        });
        assert.strictEqual(res.status, 201, res.raw);
        assert.strictEqual(res.body.faculty, meName,
            'the upload must be attributed to the signed-in account');
        res.body.entries.forEach(entry => assert.strictEqual(entry.faculty, meName));
        assert.ok(row);

        const colleagueAfter = (await colleague.call('GET', '/api/timetable/entries/mine')).body;
        assert.strictEqual(colleagueAfter.count, before.count,
            'a replace by one faculty must never clear another\'s week');
    });

    await checkAsync('a faculty member cannot upload into another branch', async () => {
        const other = BRANCHES.find(b => b !== BRANCHES[0]);
        const res = await me.call('POST', '/api/timetable/entries/mine', {
            entries: [{ day: 'Monday', period: 1, class: `${other}-A`, subject: 'Anything' }]
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'INVALID_ENTRIES');
        assert.match(JSON.stringify(res.body.rejected), /does not belong to/);
    });

    await checkAsync('an invalid upload is rejected whole — nothing is half-written', async () => {
        const mineNow = (await me.call('GET', '/api/timetable/entries/mine')).body;
        const res = await me.call('POST', '/api/timetable/entries/mine', {
            mode: 'replace',
            entries: [
                { day: 'Monday', period: 1, class: `${BRANCHES[0]}-A`, subject: 'Nonexistent Subject' },
                { day: 'Funday', period: 1, class: `${BRANCHES[0]}-A`, subject: 'Also Wrong' }
            ]
        });
        assert.strictEqual(res.status, 400);
        assert.ok(Array.isArray(res.body.rejected) && res.body.rejected.length === 2);

        const after = (await me.call('GET', '/api/timetable/entries/mine')).body;
        assert.strictEqual(after.count, mineNow.count,
            'a rejected upload must not have cleared the existing week');
    });

    await checkAsync('a faculty member cannot edit a colleague\'s single entry', async () => {
        const theirs = (await colleague.call('GET', '/api/timetable/entries/mine')).body.entries
            .filter(e => e.className);
        if (!theirs.length) return;

        const admin2 = await signIn('admin');
        const id = ((await admin2.call('GET',
            `/api/timetable/entries?faculty=${encodeURIComponent(colleagueName)}`)).body.entries || [])[0];
        if (!id) return;

        const edit = await me.call('PUT', `/api/timetable/entries/${id.id}`, {
            class: id.className, day: id.day, period: id.period,
            subject: id.subject, faculty: meName
        });
        assert.strictEqual(edit.status, 403);
        assert.strictEqual(edit.body.code, 'NOT_YOUR_ENTRY');

        const remove = await me.call('DELETE', `/api/timetable/entries/${id.id}`);
        assert.strictEqual(remove.status, 403);
        assert.strictEqual(remove.body.code, 'NOT_YOUR_ENTRY');
    });
}

// ----------------------------------------------------------- faculty scope
async function facultyTests() {
    console.log('\n[4] Faculty accounts');

    const admin = await signIn('admin');
    const roster = (await admin.call('GET', '/api/faculty')).body.faculty;
    const accounts = (await admin.call('GET', '/api/auth/accounts')).body.accounts || [];

    const facultyAccounts = accounts.filter(a => a.role === 'faculty');
    assert.ok(facultyAccounts.length >= 2, 'need at least two faculty accounts');

    const a = facultyAccounts[0];
    const b = facultyAccounts.find(x => x.department !== a.department) || facultyAccounts[1];

    const sessionA = await signIn(a.username);

    await checkAsync('a faculty account is pinned to its own branch', async () => {
        const meta = await sessionA.call('GET', '/api/timetable/meta');
        assert.strictEqual(meta.body.branch, a.department);
        const foreign = BRANCHES.find(x => x !== a.department);
        const attempt = await sessionA.call('GET', `/api/faculty?department=${foreign}`);
        assert.strictEqual(attempt.status, 403);
    });

    await checkAsync('a faculty account cannot read another branch\'s faculty', async () => {
        if (a.department === b.department) return;   // needs two branches to differ
        const list = await sessionA.call('GET', '/api/faculty');

        // Someone from another branch may legitimately appear here, but ONLY
        // when they teach one of this branch's classes — and then only as one
        // of this branch's own, never labelled with where they come from.
        const shown = list.body.faculty.find(f => f.name === b.name);
        if (shown) {
            const grid = await sessionA.call('GET',
                `/api/timetable?faculty=${encodeURIComponent(b.name)}`);
            assert.strictEqual(grid.status, 200);
            assert.ok(grid.body.cells.some(c => c.status === 'busy' && c.className),
                `${b.name} appears in ${a.department} without teaching any of its classes`);
            assert.strictEqual(shown.department, a.department,
                'a visitor must be presented as belonging to the viewing branch');
            assert.strictEqual(shown.crossBranch, true);
        }
        assert.ok(!JSON.stringify(list.body).includes(b.department),
            `${a.department}'s directory names the branch ${b.department}`);
        void roster;
    });

    await checkAsync('a faculty account cannot edit another faculty\'s timetable entry', async () => {
        // Without a database the write path answers 503; with one it must be a
        // 403. Either way it must NOT succeed.
        const attempt = await sessionA.call('POST', '/api/timetable/entries', {
            class: 'CME-A', day: 'Monday', period: 1,
            subject: 'Anything', faculty: b.name, sessionType: 'theory'
        });
        assert.ok(attempt.status >= 400, 'editing another faculty must never succeed');
        assert.ok([403, 503].includes(attempt.status),
            `expected 403 (forbidden) or 503 (no database), got ${attempt.status}`);
    });
}

// ------------------------------------------------- cross-branch teaching
async function crossBranchTests() {
    console.log('\n[5] Cross-branch teaching — one identity, no leakage');

    const branchScope = require('../src/core/branchScope');
    const store = require('../src/data/store');

    check('the model distinguishes home branch from teaching branch', () => {
        // A faculty is visible to a branch either because it is their home, or
        // because they teach one of its classes — never by duplication.
        const engine = store.engine;
        const names = engine.getFaculty().map(f => f.name);
        assert.strictEqual(new Set(names).size, names.length,
            'a faculty must appear exactly once — no per-branch duplicates');
    });

    check('a visiting lecturer is pooled into the branch they teach', () => {
        // Build the relationship the model supports and assert the pool logic,
        // using the real class-to-branch mapping.
        const engine = store.engine;
        const someClass = engine.getMeta().classes[0];
        const branch = branchScope.branchOfClass(someClass);
        const teacher = engine.getRecords()
            .find(r => r.status === 'busy' && r.className === someClass);
        assert.ok(teacher, 'the dataset must have at least one scheduled period');
        assert.ok(branchScope.facultyInBranch(teacher.faculty, branch),
            'whoever teaches a class is in that branch\'s pool');
    });

    check('a visitor is presented as belonging to the viewing branch', () => {
        const visitor = { id: 'F001', name: 'Visiting Lecturer', department: 'EEE' };
        const asSeenByCme = branchScope.projectFaculty(visitor, 'CME');
        assert.strictEqual(asSeenByCme.department, 'CME',
            'CME must see them as CME, not as EEE');
        assert.strictEqual(asSeenByCme.crossBranch, true, 'marked as a visitor');
        assert.ok(!JSON.stringify(asSeenByCme).includes('EEE'),
            'the home branch must not appear anywhere in the projection');

        // Their own branch still sees the truth.
        const asSeenByHome = branchScope.projectFaculty(visitor, 'EEE');
        assert.strictEqual(asSeenByHome.department, 'EEE');
        assert.ok(!asSeenByHome.crossBranch);
    });

    await checkAsync('an outside lecturer can be assigned to teach here, and only then appears', async () => {
        const host = BRANCHES[0];
        const guestBranch = BRANCHES.find(b => b !== host);

        const hostHos = await signIn(`hos.${host.toLowerCase()}`);
        const guestHos = await signIn(`hos.${guestBranch.toLowerCase()}`);

        const guest = (await guestHos.call('GET', '/api/faculty')).body.faculty[0];
        const hostRosterBefore = (await hostHos.call('GET', '/api/faculty')).body;
        assert.ok(!hostRosterBefore.faculty.some(f => f.name === guest.name),
            'the outside lecturer must not already be in the host branch');

        const entries = (await hostHos.call('GET', '/api/timetable/entries')).body.entries;
        if (!entries) return;                       // no database: covered above

        // Free a slot, then assign the outside lecturer to it. The timetable
        // entry IS the teaching assignment — there is no second record.
        const slot = entries.find(e => e.faculty && e.className);
        await hostHos.call('DELETE', `/api/timetable/entries/${slot.id}`);

        const assigned = await hostHos.call('POST', '/api/timetable/entries', {
            class: slot.className, day: slot.day, period: slot.period,
            subject: slot.subject, faculty: guest.name, room: slot.room, type: slot.type
        });
        assert.strictEqual(assigned.status, 201, `assignment failed: ${assigned.raw}`);

        try {

        const hostRosterAfter = (await hostHos.call('GET', '/api/faculty')).body;
        const shown = hostRosterAfter.faculty.find(f => f.name === guest.name);
        assert.ok(shown, 'an assigned lecturer must appear in the host branch');
        assert.strictEqual(shown.department, host, 'presented as belonging to the host branch');
        assert.strictEqual(shown.crossBranch, true);
        assert.ok(!JSON.stringify(shown).includes(guestBranch),
            'the host branch must never learn their home branch');
        assert.strictEqual(hostRosterAfter.count, hostRosterBefore.count + 1,
            'exactly one lecturer joined the pool');

        // Availability considers them, still read-only.
        const avail = await hostHos.call('POST', '/api/availability',
            { day: slot.day, period: slot.period });
        assert.strictEqual(avail.body.readOnly, true);
        assert.ok(avail.body.busy.some(b => b.faculty === guest.name),
            'the assigned lecturer must count as busy at the period they teach');

        // ...and the host branch still has no access to the guest's branch.
        const reach = await hostHos.call('GET', `/api/faculty?department=${guestBranch}`);
        assert.strictEqual(reach.status, 403);

        // No duplicate identity was created anywhere.
        const admin = await signIn('admin');
        const all = (await admin.call('GET', '/api/faculty')).body.faculty.map(f => f.name);
        assert.strictEqual(new Set(all).size, all.length, 'the roster must hold no duplicates');

        } finally {
            // Restore the timetable however this ends: a half-applied
            // assignment left behind would silently corrupt the next run.
            await hostHos.call('DELETE', `/api/timetable/entries/${assigned.body.entry.id}`);
            await hostHos.call('POST', '/api/timetable/entries', {
                class: slot.className, day: slot.day, period: slot.period,
                subject: slot.subject, faculty: slot.faculty, room: slot.room, type: slot.type
            });
        }
    });

    check('a branch cannot widen its own pool by naming another branch', () => {
        const cmePool = branchScope.facultyPoolOf('CME');
        const eeePool = branchScope.facultyPoolOf('EEE');
        const overlap = [...cmePool].filter(n => eeePool.has(n));
        // Any overlap must be genuine cross-branch teaching, not leakage.
        overlap.forEach(name => {
            const teaches = store.engine.getRecords().some(r =>
                r.status === 'busy' && r.faculty === name &&
                ['CME', 'EEE'].includes(branchScope.branchOfClass(r.className)));
            assert.ok(teaches, `${name} is in both pools without teaching in either`);
        });
    });
}

main().catch(err => {
    console.error('\n✗ FAILED:', err.message);
    process.exit(1);
});
