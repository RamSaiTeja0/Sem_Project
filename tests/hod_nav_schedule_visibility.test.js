const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- Testing Navigation Bar Role-Based Visibility ---');

const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

// 1. Verify navSchedule exists in HTML structure
assert(indexHtml.includes('id="navSchedule"'), 'index.html must contain #navSchedule button');
assert(indexHtml.includes('>My Timetable</button>'), 'index.html must have My Timetable text');

// 2. Verify navSchedule visibility is isFaculty only (NOT isHOS)
assert(
    appJs.includes("if (el('navSchedule')) el('navSchedule').style.display = isFaculty ? '' : 'none';"),
    'navSchedule must only be displayed when isFaculty is true, NOT for isHOS'
);

// 3. Verify all other HOD sidebar items remain configured
assert(appJs.includes("if (el('navFaculty')) el('navFaculty').style.display = isHOS ? '' : 'none';"), 'navFaculty for HOS');
assert(appJs.includes("if (el('navRequests')) el('navRequests').style.display = isHOS ? '' : 'none';"), 'navRequests for HOS');
assert(appJs.includes("if (el('navAttendance')) el('navAttendance').style.display = isHOS ? '' : 'none';"), 'navAttendance for HOS');
assert(appJs.includes("if (el('navInvigilation')) el('navInvigilation').style.display = isHOS ? '' : 'none';"), 'navInvigilation for HOS');
assert(appJs.includes("if (el('navInvigRequests')) el('navInvigRequests').style.display = isHOS ? '' : 'none';"), 'navInvigRequests for HOS');
assert(appJs.includes("if (el('navHosSubstitutions')) el('navHosSubstitutions').style.display = isHOS ? '' : 'none';"), 'navHosSubstitutions for HOS');
assert(appJs.includes("if (el('navManageLabel')) el('navManageLabel').style.display = isHOS ? '' : 'none';"), 'navManageLabel for HOS');
assert(appJs.includes("if (el('navManage')) el('navManage').style.display = isHOS ? '' : 'none';"), 'navManage for HOS');
assert(appJs.includes("if (el('navImport')) el('navImport').style.display = isHOS ? '' : 'none';"), 'navImport for HOS');
assert(!appJs.includes("if (el('navAbout'))"), 'navAbout must not be in app.js navigation');
assert(!indexHtml.includes('id="navAbout"'), 'navAbout must not be in index.html');
assert(appJs.includes("if (el('navDelegation')) el('navDelegation').style.display = isPermanentHOS ? '' : 'none';"), 'navDelegation for permanent HOS');

// 4. Verify Faculty navigation items remain configured
assert(appJs.includes("if (el('navMyAttendance')) el('navMyAttendance').style.display = isFaculty ? '' : 'none';"), 'navMyAttendance for faculty');
assert(appJs.includes("if (el('navMyInvigilation')) el('navMyInvigilation').style.display = isFaculty ? '' : 'none';"), 'navMyInvigilation for faculty');
assert(appJs.includes("if (el('navRequestInvigilation')) el('navRequestInvigilation').style.display = isFaculty ? '' : 'none';"), 'navRequestInvigilation for faculty');
assert(appJs.includes("if (el('navFacultySubstitutions')) el('navFacultySubstitutions').style.display = isFaculty ? '' : 'none';"), 'navFacultySubstitutions for faculty');

// 5. Simulate DOM element state for both HOD and Faculty roles
function simulateNavigation(role) {
    const isHOS = role === 'hos' || role === 'coordinator';
    const isPermanentHOS = role === 'hos';
    const isFaculty = role === 'faculty';

    const elements = {
        navSchedule: { style: { display: 'none' } },
        navFaculty: { style: { display: 'none' } },
        navRequests: { style: { display: 'none' } },
        navAttendance: { style: { display: 'none' } },
        navMyAttendance: { style: { display: 'none' } },
        navInvigilation: { style: { display: 'none' } },
        navInvigRequests: { style: { display: 'none' } },
        navMyInvigilation: { style: { display: 'none' } },
        navRequestInvigilation: { style: { display: 'none' } },
        navFacultySubstitutions: { style: { display: 'none' } },
        navHosSubstitutions: { style: { display: 'none' } },
        navManageLabel: { style: { display: 'none' } },
        navManage: { style: { display: 'none' } },
        navImport: { style: { display: 'none' } },
        navDelegation: { style: { display: 'none' } }
    };

    function el(id) { return elements[id]; }

    // Logic from public/js/app.js:
    if (el('navFaculty')) el('navFaculty').style.display = isHOS ? '' : 'none';
    if (el('navRequests')) el('navRequests').style.display = isHOS ? '' : 'none';
    if (el('navAttendance')) el('navAttendance').style.display = isHOS ? '' : 'none';
    if (el('navMyAttendance')) el('navMyAttendance').style.display = isFaculty ? '' : 'none';
    if (el('navInvigilation')) el('navInvigilation').style.display = isHOS ? '' : 'none';
    if (el('navInvigRequests')) el('navInvigRequests').style.display = isHOS ? '' : 'none';
    if (el('navMyInvigilation')) el('navMyInvigilation').style.display = isFaculty ? '' : 'none';
    if (el('navRequestInvigilation')) el('navRequestInvigilation').style.display = isFaculty ? '' : 'none';
    if (el('navFacultySubstitutions')) el('navFacultySubstitutions').style.display = isFaculty ? '' : 'none';
    if (el('navHosSubstitutions')) el('navHosSubstitutions').style.display = isHOS ? '' : 'none';
    if (el('navManageLabel')) el('navManageLabel').style.display = isHOS ? '' : 'none';
    if (el('navManage')) el('navManage').style.display = isHOS ? '' : 'none';
    if (el('navImport')) el('navImport').style.display = isHOS ? '' : 'none';
    if (el('navDelegation')) el('navDelegation').style.display = isPermanentHOS ? '' : 'none';
    if (el('navSchedule')) el('navSchedule').style.display = isFaculty ? '' : 'none';

    return elements;
}

// Check HOD
const hodElements = simulateNavigation('hos');
assert.strictEqual(hodElements.navSchedule.style.display, 'none', 'HOD must NOT see navSchedule (My Timetable)');
assert.strictEqual(hodElements.navFaculty.style.display, '', 'HOD must see navFaculty');
assert.strictEqual(hodElements.navAttendance.style.display, '', 'HOD must see navAttendance');
assert.strictEqual(hodElements.navInvigilation.style.display, '', 'HOD must see navInvigilation');
assert.strictEqual(hodElements.navHosSubstitutions.style.display, '', 'HOD must see navHosSubstitutions');
assert.strictEqual(hodElements.navDelegation.style.display, '', 'HOD must see navDelegation');
console.log('✔ HOD navigation verified: "My Timetable" is hidden, all HOD management items are visible.');

// Check Faculty
const facElements = simulateNavigation('faculty');
assert.strictEqual(facElements.navSchedule.style.display, '', 'Faculty MUST see navSchedule (My Timetable)');
assert.strictEqual(facElements.navMyAttendance.style.display, '', 'Faculty must see navMyAttendance');
assert.strictEqual(facElements.navMyInvigilation.style.display, '', 'Faculty must see navMyInvigilation');
assert.strictEqual(facElements.navRequestInvigilation.style.display, '', 'Faculty must see navRequestInvigilation');
assert.strictEqual(facElements.navFacultySubstitutions.style.display, '', 'Faculty must see navFacultySubstitutions');
assert.strictEqual(facElements.navFaculty.style.display, 'none', 'Faculty must NOT see navFaculty');
assert.strictEqual(facElements.navDelegation.style.display, 'none', 'Faculty must NOT see navDelegation');
console.log('✔ Faculty navigation verified: "My Timetable" is visible, faculty personal tools active, HOD tools hidden.');

console.log('All navigation verification checks passed successfully!');
