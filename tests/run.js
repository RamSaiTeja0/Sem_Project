/** Runs every test suite in order and reports a combined result. */
const { spawnSync } = require('child_process');
const path = require('path');

// database.test.js skips itself when no connection string is set, so this list
// is the same whether or not a PostgreSQL database is available.
const suites = ['engine.test.js', 'api.test.js', 'auth.test.js', 'database.test.js', 'e2e.test.js'];
let failures = 0;

suites.forEach(suite => {
    console.log('\n' + '='.repeat(64));
    console.log('RUN  ' + suite);
    console.log('='.repeat(64));
    const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (result.status !== 0) failures++;
});

console.log('\n' + '='.repeat(64));
if (failures === 0) {
    console.log('ALL SUITES PASSED');
} else {
    console.error(`${failures} SUITE(S) FAILED`);
    process.exit(1);
}
