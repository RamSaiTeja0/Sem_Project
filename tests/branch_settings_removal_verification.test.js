const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- Verifying Branch Settings UI Removal & System Integrity ---');

// 1. Verify HTML template changes in public/index.html
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

assert.strictEqual(indexHtml.includes('id="navAbout"'), false, 'index.html must NOT contain #navAbout in the sidebar');
assert.strictEqual(indexHtml.includes('id="view-about"'), false, 'index.html must NOT contain #view-about view container');
assert.strictEqual(indexHtml.includes('Branch Settings</button>'), false, 'index.html must NOT contain Branch Settings navigation button');

// 2. Verify all other sidebar navigation items remain exactly intact
const expectedSidebarNavItems = [
    'Home',
    'Dashboard',
    'Faculty Availability',
    'Adjust / Substitute',
    'Faculty Attendance',
    'My Attendance',
    'Exam Invigilation',
    'Invigilation Requests',
    'My Invigilation',
    'Request Invigilation',
    'Faculty Substitutions',
    'Branch Substitutions',
    'My Timetable',
    'Master Timetable',
    'Faculty Management',
    'Faculty Requests',
    'Add Timetable',
    'Upload Timetable',
    'HOD Delegation'
];

expectedSidebarNavItems.forEach(itemText => {
    assert.ok(
        indexHtml.includes(`>${itemText}<`) || indexHtml.includes(`>${itemText} `) || indexHtml.includes(`>${itemText}</button>`) || indexHtml.includes(`>${itemText} <`),
        `Sidebar must preserve "${itemText}" navigation item`
    );
});
console.log('✔ All remaining sidebar items verified in index.html.');

// 3. Verify JavaScript routing changes in public/js/app.js
const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

assert.strictEqual(appJs.includes("about: 'Settings / About'"), false, 'TITLES map must not contain about view');
assert.ok(appJs.includes("if (name === 'about') return 'dashboard';"), 'viewFromHash must safely fallback #about to dashboard');
assert.ok(appJs.includes("if (name === 'about')") && appJs.includes("name = 'dashboard';"), 'showView must safely reroute about to dashboard');
assert.strictEqual(appJs.includes("if (el('navAbout'))"), false, 'renderUser must not contain navAbout visibility toggle');
assert.strictEqual(appJs.includes("if (name === 'about') { loadBranchConfig(); }"), false, 'showView must not trigger branch config exclusively for about');

console.log('✔ JavaScript router safe fallback and nav cleanup verified.');

// 4. Verify that loadBranchConfig and /api/branch backend logic are still intact for other views
assert.ok(appJs.includes('function loadBranchConfig('), 'loadBranchConfig function must remain intact');
assert.ok(appJs.includes('function saveBranchConfig('), 'saveBranchConfig function must remain intact');

// 5. Verify live server response via HTTP
async function verifyLiveServer() {
    const res = await fetch('http://localhost:3001/dashboard');
    assert.strictEqual(res.status, 200, 'Server must serve dashboard on 3001');
    const html = await res.text();
    assert.strictEqual(html.includes('id="navAbout"'), false, 'Live dashboard HTML must not include #navAbout');
    assert.strictEqual(html.includes('id="view-about"'), false, 'Live dashboard HTML must not include #view-about');
    assert.strictEqual(html.includes('Branch Settings'), false, 'Live dashboard HTML must not include Branch Settings button');
    console.log('✔ Live server response at http://localhost:3001 verified.');
}

verifyLiveServer().then(() => {
    console.log('\n============================================================');
    console.log('Branch Settings Removal Verification Passed Completely!');
    console.log('============================================================\n');
}).catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
