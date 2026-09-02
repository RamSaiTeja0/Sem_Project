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

async function main() {
    console.log('TecSubstitution — branch isolation security tests');

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), AUTH_REQUIRED: 'true' },
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

        const branchList = await admin.call('GET', '/api/branches');
        BRANCHES = branchList.body.branches.map(b => b.code);
        console.log('\n  branches in the loaded data: ' + BRANCHES.join(', '));

        await sessionTests();
        await isolationMatrix();
        await hosTests();
        await facultyTests();
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
        assert.ok(!list.body.faculty.some(f => f.name === b.name),
            `${b.name} (${b.department}) must not appear in ${a.department}'s directory`);
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
        const visitor = { id: 'F001', name: 'Visiting Lecturer', department: 'EE' };
        const asSeenByCme = branchScope.projectFaculty(visitor, 'CME');
        assert.strictEqual(asSeenByCme.department, 'CME',
            'CME must see them as CME, not as EE');
        assert.strictEqual(asSeenByCme.crossBranch, true, 'marked as a visitor');
        assert.ok(!JSON.stringify(asSeenByCme).includes('EE'),
            'the home branch must not appear anywhere in the projection');

        // Their own branch still sees the truth.
        const asSeenByHome = branchScope.projectFaculty(visitor, 'EE');
        assert.strictEqual(asSeenByHome.department, 'EE');
        assert.ok(!asSeenByHome.crossBranch);
    });

    check('a branch cannot widen its own pool by naming another branch', () => {
        const cmePool = branchScope.facultyPoolOf('CME');
        const eePool = branchScope.facultyPoolOf('EE');
        const overlap = [...cmePool].filter(n => eePool.has(n));
        // Any overlap must be genuine cross-branch teaching, not leakage.
        overlap.forEach(name => {
            const teaches = store.engine.getRecords().some(r =>
                r.status === 'busy' && r.faculty === name &&
                ['CME', 'EE'].includes(branchScope.branchOfClass(r.className)));
            assert.ok(teaches, `${name} is in both pools without teaching in either`);
        });
    });
}

main().catch(err => {
    console.error('\n✗ FAILED:', err.message);
    process.exit(1);
});
