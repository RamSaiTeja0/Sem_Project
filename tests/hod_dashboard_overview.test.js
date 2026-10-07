const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('\n======================================================');
console.log('Testing HOD Dashboard Overview & Role UI Separation');
console.log('======================================================\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

// 1. Static HTML structure checks
console.log('--- 1. Checking HTML Elements in index.html ---');
assert(indexHtml.includes('id="hodDashboardOverview"'), 'index.html must contain #hodDashboardOverview');
assert(indexHtml.includes('id="standardDashboardOverview"'), 'index.html must contain #standardDashboardOverview');

// Dynamic branch and date headers
assert(indexHtml.includes('id="hodDashBranchName"'), 'index.html must contain #hodDashBranchName');
assert(indexHtml.includes('id="hodDashDate"'), 'index.html must contain #hodDashDate');

// 1. Faculty Summary Elements
assert(indexHtml.includes('id="hodStatTotalFaculty"'), 'index.html must contain #hodStatTotalFaculty');
assert(indexHtml.includes('id="hodStatPresentToday"'), 'index.html must contain #hodStatPresentToday');
assert(indexHtml.includes('id="hodStatAbsentToday"'), 'index.html must contain #hodStatAbsentToday');
console.log('✔ Faculty summary elements present (Total Faculty, Present Today, Absent Today).');

// 2. Timetable Summary Elements
assert(indexHtml.includes('id="hodStatScheduledPeriods"'), 'index.html must contain #hodStatScheduledPeriods');
assert(indexHtml.includes('id="hodStatFreePeriods"'), 'index.html must contain #hodStatFreePeriods');
console.log('✔ Timetable summary elements present (Scheduled Periods, Free Periods).');

// 3. Pending Requests Elements
assert(indexHtml.includes('id="hodStatPendingFacRequests"'), 'index.html must contain #hodStatPendingFacRequests');
assert(indexHtml.includes('id="hodStatPendingSubstitutions"'), 'index.html must contain #hodStatPendingSubstitutions');
assert(indexHtml.includes('id="hodStatPendingInvigRequests"'), 'index.html must contain #hodStatPendingInvigRequests');
console.log('✔ Pending requests elements present (Faculty Registrations, Substitutions, Invigilation).');

// 4. Quick Actions
assert(indexHtml.includes('data-nav-target="import"'), 'Quick Action for Upload Timetable present');
assert(indexHtml.includes('data-nav-target="manage"'), 'Quick Action for Add Timetable present');
assert(indexHtml.includes('data-nav-target="timetable"'), 'Quick Action for Master Timetable present');
assert(indexHtml.includes('data-nav-target="availability"'), 'Quick Action for Faculty Availability present');
console.log('✔ All 4 Quick Actions present (Upload Timetable, Add Timetable, Master Timetable, Faculty Availability).');

// 2. JavaScript logic checks
console.log('\n--- 2. Checking JavaScript Logic in app.js ---');
assert(appJs.includes('function loadHODDashboard()'), 'app.js must define loadHODDashboard()');
assert(appJs.includes("el('hodDashboardOverview').style.display = isHOS ? 'flex' : 'none'"), 'app.js must show hodDashboardOverview only for isHOS');
assert(appJs.includes("el('standardDashboardOverview').style.display = isHOS ? 'none' : ''"), 'app.js must show standardDashboardOverview for non-HOS');
assert(appJs.includes("data-nav-target"), 'app.js must handle data-nav-target event delegation');
console.log('✔ HOD dashboard JavaScript loader and role separation logic verified.');

console.log('\n======================================================');
console.log('ALL HOD DASHBOARD OVERVIEW UI TESTS PASSED!');
console.log('======================================================\n');
