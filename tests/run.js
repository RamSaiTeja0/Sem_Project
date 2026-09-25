/** Runs every test suite in order and reports a combined result. */
const { spawnSync } = require('child_process');
const path = require('path');
const { verifySafetyGuard, initTestDb } = require('./testDbGuard');

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
    'image_upload_flow.test.js',
    'staging_approval.test.js',
    'hod_timetable_approval_workflow.test.js',
    'hod_master_timetable_upload_flow.test.js',
    'config_and_session_persistence.test.js',
    'hod_schedule_and_sql_regression.test.js',
    'target_scope_import_and_refresh.test.js',
    'class_reuse_and_duplicate_constraint.test.js',
    'master_timetable_display.test.js',
    'hod_only_master_timetable_rbac.test.js',
    'timetable_workflow_complete.test.js',
    'faculty_timetable_extraction.test.js',
    'live_verification.js'
];
let failures = 0;
const failedSuites = [];

const dbSuites = new Set([
    'database.test.js',
    'neon_persistence_verification.test.js',
    'hod_schedule_and_sql_regression.test.js',
    'target_scope_import_and_refresh.test.js',
    'class_reuse_and_duplicate_constraint.test.js',
    'master_timetable_display.test.js',
    'hod_only_master_timetable_rbac.test.js',
    'timetable_workflow_complete.test.js',
    'hod_master_timetable_upload_flow.test.js',
    'faculty_timetable_extraction.test.js'
]);

async function main() {
    // Run safety guard check
    console.log('[Test Suite Safety Guard] Verifying isolated test database configuration...');
    const guardInfo = verifySafetyGuard();
    console.log(`[Test Suite Safety Guard] ✅ Verified. Isolated Test DB: ${guardInfo.parsedTest.full}`);

    suites.forEach(suite => {
        console.log('\n' + '='.repeat(64));
        console.log('RUN  ' + suite);
        console.log('='.repeat(64));
        const envOverrides = legacyDemoConfigs[suite] || {};
        const env = { ...process.env, ...envOverrides };
        if (dbSuites.has(suite)) {
            env.DATABASE_URL = guardInfo.testDatabaseUrl;
            env.TEST_DATABASE_URL = guardInfo.testDatabaseUrl;
            env.APP_DATABASE_URL = guardInfo.appProdUrl;
            env.NODE_ENV = 'test';
        } else {
            env.DATABASE_URL = '';
            env.TEST_DATABASE_URL = '';
            env.APP_DATABASE_URL = guardInfo.appProdUrl;
            env.NODE_ENV = 'test';
        }
        const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit', env });
        if (result.status !== 0) {
            failures++;
            failedSuites.push(suite);
        }
    });

    console.log('\n' + '='.repeat(64));
    if (failures === 0) {
        console.log('ALL SUITES PASSED');
    } else {
        console.error(`${failures} SUITE(S) FAILED: ${failedSuites.join(', ')}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
});

