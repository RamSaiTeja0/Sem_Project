/**
 * Frontend JavaScript Syntax & Structure Verification Test
 *
 * Verifies that all client-side JavaScript assets parse cleanly with Node's VM Script engine
 * without syntax errors, missing closures, or illegal tokens.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, counts } = require('./helpers');

function run() {
    console.log('TecSubstitution — Frontend Syntax & Structure Tests\n');

    const publicJsDir = path.join(__dirname, '..', 'public', 'js');
    const jsFiles = fs.readdirSync(publicJsDir).filter(f => f.endsWith('.js'));

    console.log('[1] Client-side JavaScript syntax verification');
    for (const file of jsFiles) {
        const fullPath = path.join(publicJsDir, file);
        const code = fs.readFileSync(fullPath, 'utf8');

        check(`public/js/${file} compiles cleanly with zero syntax errors`, () => {
            assert.doesNotThrow(() => {
                new vm.Script(code, { filename: `public/js/${file}` });
            }, `Failed to parse public/js/${file}`);
        });
    }

    console.log('\n[2] Session bootstrap & lifecycle structure');
    const appCode = fs.readFileSync(path.join(publicJsDir, 'app.js'), 'utf8');

    check('app.js defines loadSession, renderUser, and bootstrap', () => {
        assert.ok(appCode.includes('function loadSession()'), 'loadSession defined');
        assert.ok(appCode.includes('function renderUser('), 'renderUser defined');
        assert.ok(appCode.includes('function bootstrap()'), 'bootstrap defined');
        assert.ok(appCode.includes('function showView('), 'showView defined');
    });

    check('app.js attaches role-based navigation guards', () => {
        assert.ok(appCode.includes('navFaculty'), 'navFaculty referenced');
        assert.ok(appCode.includes('navAttendance'), 'navAttendance referenced');
        assert.ok(appCode.includes('navInvigilation'), 'navInvigilation referenced');
        assert.ok(appCode.includes('navSchedule'), 'navSchedule referenced');
    });

    console.log('\n[3] Master Timetable Target Scope UI & Academic Year Structure');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    check('index.html defines #ttAcademicYear as a text input (NOT a select dropdown)', () => {
        assert.ok(indexHtml.includes('<input type="text" id="ttAcademicYear"'), 'ttAcademicYear must be a text input');
        assert.ok(!indexHtml.includes('<select id="ttAcademicYear"'), 'ttAcademicYear must not be a select element');
    });

    check('Target Scope contains Academic Year, Semester, and Section', () => {
        assert.ok(indexHtml.includes('id="ttYearWrap"'), 'ttYearWrap exists');
        assert.ok(indexHtml.includes('id="ttSemWrap"'), 'ttSemWrap exists');
        assert.ok(indexHtml.includes('id="ttSecWrap"'), 'ttSecWrap exists');
    });

    check('app.js does not generate automatic academic year dropdown options', () => {
        assert.ok(!appCode.includes("data.academicYears = ["), 'No hardcoded academicYears array generated');
        assert.ok(!appCode.includes("fillSelect(yearEl"), 'No fillSelect on yearEl dropdown');
    });

    check('app.js validates non-empty Academic Year on import and approval', () => {
        assert.ok(appCode.includes('Please enter an Academic Year (e.g. 2026-27) in the Target Scope'), 'Validates academic year before approving');
    });

    check('app.js warns when uploaded academic year differs from target academic year without overwriting', () => {
        assert.ok(appCode.includes('Uploaded timetable academic year differs from the selected target academic year.'), 'Clear mismatch warning present');
    });

    const { passed, failed } = counts();
    console.log('\n============================================================');
    console.log(`Frontend Verification: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run();
