/** Runs every test suite in order and reports a combined result. */
const { spawnSync } = require('child_process');
const path = require('path');

// Suites that specifically test against the legacy demo dataset fixtures
const legacyDemoConfigs = {
    'api.test.js': { LOAD_DEMO_DATA: 'true', BRANCH_CODE: 'CME', BRANCH_NAME: 'Computer Engineering' },
    'auth.test.js': { LOAD_DEMO_DATA: 'true', BRANCH_CODE: 'CME', BRANCH_NAME: 'Computer Engineering' },
    'catalog.test.js': { LOAD_DEMO_DATA: 'true', BRANCH_CODE: 'CME', BRANCH_NAME: 'Computer Engineering' },
    'dayparsing.test.js': { LOAD_DEMO_DATA: 'true', BRANCH_CODE: 'CME', BRANCH_NAME: 'Computer Engineering' },
    'e2e.test.js': { LOAD_DEMO_DATA: 'true', BRANCH_CODE: 'CME', BRANCH_NAME: 'Computer Engineering' }
};

const suites = [
    'frontend_syntax_and_dom.test.js',
    'web_auth_and_ui_lifecycle.test.js',
    'accounts.test.js',
    'singlebranch.e2e.test.js',
    'singlebranch.test.js',
    'mastertimetable.test.js',
    'facultyown.test.js',
    'faculty_management.test.js',
    'dynamic_timetable.test.js',
    'cross_branch_availability.test.js',
    'faculty_registration_requests.test.js',
    'faculty_attendance.test.js',
    'invigilation.test.js',
    'b7_4_availability_candidates.test.js',
    'b7_5_substitution.test.js',
    'b6_final_integration.test.js',
    'availability.test.js',
    'engine.test.js',
    'api.test.js',
    'auth.test.js',
    'catalog.test.js',
    'dayparsing.test.js',
    'database.test.js',
    'neon_persistence_verification.test.js',
    'e2e.test.js',
    'uploads.test.js',
    'internal_uploads.test.js',
    'gemini_n8n.test.js',
    'gemini_accuracy.test.js',
    'staging_approval.test.js',
    'config_and_session_persistence.test.js',
    'hod_schedule_and_sql_regression.test.js',
    'live_verification.js'
];
let failures = 0;

const dbSuites = new Set(['database.test.js', 'neon_persistence_verification.test.js', 'hod_schedule_and_sql_regression.test.js']);

suites.forEach(suite => {
    console.log('\n' + '='.repeat(64));
    console.log('RUN  ' + suite);
    console.log('='.repeat(64));
    const envOverrides = legacyDemoConfigs[suite] || {};
    const env = { ...process.env, ...envOverrides };
    if (!dbSuites.has(suite)) {
        env.DATABASE_URL = '';
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit', env });
    if (result.status !== 0) failures++;
});

console.log('\n' + '='.repeat(64));
if (failures === 0) {
    console.log('ALL SUITES PASSED');
} else {
    console.error(`${failures} SUITE(S) FAILED`);
    process.exit(1);
}
