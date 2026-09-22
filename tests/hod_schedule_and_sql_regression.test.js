const assert = require('assert');
const fs = require('fs');
const path = require('path');
const repo = require('../src/db/repository');
const db = require('../src/db/pool');

async function runTests() {
    console.log('--- Testing SQL Query Regression & Class Resolution ---');
    // Test resolveOrCreateClass does not crash with missing column c.name
    const res = await repo.resolveOrCreateClass({
        branch: 'CME',
        academicYear: '2025-2026',
        semester: 5,
        section: 'A'
    });
    assert(res, 'resolveOrCreateClass should return a class object');
    assert.strictEqual(res.department, 'CME');
    assert.strictEqual(res.section, 'A');
    console.log('✔ resolveOrCreateClass executed successfully with zero SQL errors.');

    console.log('--- Testing Navigation and UI Role Permissions in Frontend ---');
    const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

    // 1. My Timetable visible for both HOD and Faculty
    assert(appJs.includes("if (el('navSchedule')) el('navSchedule').style.display = (isFaculty || isHOS) ? '' : 'none';"),
        'navSchedule should be visible for both isFaculty and isHOS');

    // 2. schedule removed from FACULTY_ONLY_VIEWS so HOD is not redirected to dashboard
    assert(!appJs.includes("FACULTY_ONLY_VIEWS = ['my-attendance', 'my-invigilation', 'request-invigilation', 'faculty-substitutions', 'schedule']"),
        'schedule must not be in FACULTY_ONLY_VIEWS');
    assert(appJs.includes("FACULTY_ONLY_VIEWS = ['my-attendance', 'my-invigilation', 'request-invigilation', 'faculty-substitutions']"),
        'FACULTY_ONLY_VIEWS should only contain faculty-specific views');

    // 3. index.html contains navSchedule button
    assert(indexHtml.includes('id="navSchedule"'), 'index.html must contain #navSchedule button');

    console.log('✔ HOD and Faculty timetable navigation & role authorization rules verified.');
}

runTests().then(() => {
    console.log('All regression checks passed.');
    process.exit(0);
}).catch(err => {
    console.error('Regression check failed:', err);
    process.exit(1);
});
