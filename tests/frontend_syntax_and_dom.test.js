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

    const { passed, failed } = counts();
    console.log('\n============================================================');
    console.log(`Frontend Verification: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run();
