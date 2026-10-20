require('dotenv').config();
const assert = require('assert');
const { verifySafetyGuard, initTestDb } = require('./testDbGuard');

// Enforce test database isolation before loading pool or config
const guardInfo = verifySafetyGuard();
console.log(`[Safety Guard] Active test database: ${guardInfo.parsedTest.full}`);

const store = require('../src/data/store');
const pool = require('../src/db/pool');
const config = require('../src/config');

async function runTest() {
    console.log('=== EMPTY FACULTY DATABASE STARTUP REGRESSION TEST ===\n');

    // POSITIVE VERIFICATION: Ensure the active target is confirmed to be the isolated test database
    const activeTarget = (pool.describeTarget() || '').toLowerCase();
    const testDbName = (guardInfo.parsedTest.dbName || '').toLowerCase();
    if (!activeTarget.includes(testDbName) || activeTarget.includes('neondb?')) {
        throw new Error(`[SAFETY GUARD FATAL] Refusing to run destructive queries: active target "${activeTarget}" is not the test database "${testDbName}"!`);
    }

    await initTestDb();

    // 0. Establish clean empty-faculty baseline in test database while preserving HOD accounts
    await pool.query(`
        DELETE FROM timetable;
        DELETE FROM faculty_attendance;
        DELETE FROM exam_invigilation;
        DELETE FROM exam_invigilation_requests;
        DELETE FROM faculty_substitutions;
        DELETE FROM faculty_subjects;
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'faculty_delegations') THEN
                DELETE FROM faculty_delegations;
            END IF;
        END $$;
        DELETE FROM timetable_staging;
        DELETE FROM timetable_uploads;
        DELETE FROM users WHERE role = 'faculty' OR faculty_id IS NOT NULL;
        DELETE FROM faculty;
    `);

    // Ensure at least one HOD account exists in the database
    const existingHod = await pool.query("SELECT id FROM users WHERE role = 'hos' OR role = 'hod' LIMIT 1");
    if (existingHod.rows.length === 0) {
        const dRes = await pool.query("INSERT INTO departments (code, name) VALUES ('CME', 'Computer Engineering') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id");
        const deptId = dRes.rows[0].id;
        await pool.query("INSERT INTO users (username, password_hash, name, role, department_id) VALUES ('hod_baseline', '$2a$10$abcdefghijklmnopqrstuu', 'HOD Baseline', 'hos', $1)", [deptId]);
    }

    // 1. Verify live database state
    const userRes = await pool.query("SELECT id, username, role FROM users WHERE role = 'faculty'");
    const facRes = await pool.query("SELECT id, name, department_id FROM faculty");
    const hodRes = await pool.query("SELECT id, username, role FROM users WHERE role = 'hos' OR role = 'hod'");

    console.log(`Live DB check: faculty users = ${userRes.rows.length}, faculty rows = ${facRes.rows.length}, HOD users = ${hodRes.rows.length}`);
    assert.strictEqual(userRes.rows.length, 0, 'Expected 0 faculty user accounts in DB');
    assert.strictEqual(facRes.rows.length, 0, 'Expected 0 faculty records in DB');
    assert.ok(hodRes.rows.length > 0, 'Expected HOD accounts to remain intact');
    console.log('  ✓ 1. Live database correctly contains 0 faculty records/accounts and preserves HODs');

    // 2. Test store.initFromDatabase() behavior
    const initResult = await store.initFromDatabase({ seed: Boolean(config.dbSeedDemo) });
    console.log('store.initFromDatabase result:', initResult);

    assert.strictEqual(initResult.enabled, true, 'Expected store.initFromDatabase to be enabled');
    assert.strictEqual(initResult.seeded, false, 'Expected seeded to be false (no automatic demo seeding)');
    assert.strictEqual(initResult.error, undefined, 'Expected no error from initFromDatabase');
    console.log('  ✓ 2. initFromDatabase() succeeds without error (no NO_FACULTY or demo fallback)');

    // 3. Verify store state in memory matches database
    assert.strictEqual(store.usingDatabase, true, 'Expected store.usingDatabase to be true');
    const facultyList = store.engine.getFaculty();
    assert.strictEqual(facultyList.length, 0, 'Expected 0 faculty in store');
    console.log('  ✓ 3. Store is database-backed and returns 0 faculty');

    // 4. Verify no demo faculty like CME-F1 exist in memory or DB
    const hasDemoFaculty = facultyList.some(f => (f.name && f.name.includes('CME-F')) || (f.id && f.id.includes('CME_F')));
    assert.strictEqual(hasDemoFaculty, false, 'Demo faculty must not exist in store');
    console.log('  ✓ 4. No bundled demo faculty loaded into memory');

    // 5. Verify database counts after initFromDatabase did not create any rows
    const userAfter = await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'faculty'");
    const facAfter = await pool.query("SELECT count(*)::int AS n FROM faculty");
    assert.strictEqual(userAfter.rows[0].n, 0, 'Database faculty users must still be 0');
    assert.strictEqual(facAfter.rows[0].n, 0, 'Database faculty rows must still be 0');
    console.log('  ✓ 5. Database remains clean (0 faculty users, 0 faculty rows)');

    console.log('\nAll regression tests passed successfully.');
}

runTest().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
