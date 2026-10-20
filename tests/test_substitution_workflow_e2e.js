/**
 * Comprehensive Verification Test for Phase 8:
 * Faculty-to-Faculty Substitution Request Workflow and Adjust / Substitute UI
 */
const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = require('../src/data/store');
const substitutions = require('../src/data/substitutions');
const repository = require('../src/db/repository');
const { query } = require('../src/db/pool');

async function run() {
    console.log('================================================================');
    console.log('F.A.S.T. — Substitution Request Workflow Verification Test');
    console.log('================================================================\n');

    let passed = 0;
    let failed = 0;

    async function check(name, fn) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✕ ${name}`);
            console.error(`    ${err.message}`);
            failed++;
        }
    }

    // -------------------------------------------------------------------------
    // TEST SECTION 1: Frontend DOM & UI Structure Verification
    // -------------------------------------------------------------------------
    console.log('--- SECTION 1: Adjust / Substitute UI & DOM Verification ---');

    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

    await check('1. #view-substitute contains #subDate, #subDay, #subFacultyBadge, and #subFind', () => {
        assert.ok(indexHtml.includes('id="view-substitute"'), 'Must have #view-substitute section');
        assert.ok(indexHtml.includes('id="subDate"'), 'Must have #subDate input for calendar date');
        assert.ok(indexHtml.includes('id="subDay"'), 'Must have #subDay select dropdown');
        assert.ok(indexHtml.includes('id="subFacultyBadge"'), 'Must have #subFacultyBadge for automatic faculty identity');
        assert.ok(indexHtml.includes('id="subFacultyReadOnly"'), 'Must have #subFacultyReadOnly wrapper');
        assert.ok(indexHtml.includes('id="subFind"'), 'Must have #subFind button');
    });

    await check('2. Single-line comma-separated faculty list (names.join) is completely removed', () => {
        // Confirm names.join(', ') is no longer used to render available faculty in app.js
        assert.ok(!appJs.includes("names.join(', ')"), 'Must not join faculty names with commas into one line');
    });

    await check('3. Available faculty are displayed in separate table rows with Name, Branch, FREE badge, and Select button', () => {
        assert.ok(appJs.includes('btn-sub-candidate-select'), 'Must have individual Select buttons for candidates');
        assert.ok(appJs.includes('badge-success">FREE</span>'), 'Must display FREE availability badge');
        assert.ok(appJs.includes('candidate-row'), 'Must display candidates in discrete rows');
        assert.ok(appJs.includes('No faculty members are available to cover Period'), 'Must display clear empty state when no faculty are free');
    });

    await check('4. Logged-in faculty member is excluded from being their own substitute candidate in UI', () => {
        assert.ok(appJs.includes('candName !== facultyName.toUpperCase()'), 'Requester must be filtered out of available candidate list');
    });

    await check('5. Confirmation panel displays selected Date, Day, Period, Class, Subject, Proposed Substitute, and Send Request button', () => {
        assert.ok(appJs.includes('subRequestConfirmCard'), 'Must define confirmation card');
        assert.ok(appJs.includes('btnSendSubRequest'), 'Must have Send Request button');
        assert.ok(appJs.includes('btnCancelSubSelection'), 'Must have Cancel Selection button');
        assert.ok(appJs.includes('subRequestAlert'), 'Must have request alert area');
    });

    // -------------------------------------------------------------------------
    // TEST SECTION 2: Backend Substitution Request Workflow & Rules
    // -------------------------------------------------------------------------
    console.log('\n--- SECTION 2: Backend Substitution Request Validation & Execution ---');

    await store.initFromDatabase();

    const mockSessionRequester = {
        id: 99881,
        username: 'prof.test.requester',
        name: 'Prof. Test Requester',
        facultyName: 'Prof. Test Requester',
        role: 'faculty',
        department: 'CME'
    };

    const mockSessionSubstitute = {
        id: 99882,
        username: 'dr.test.substitute',
        name: 'Dr. Test Substitute',
        facultyName: 'Dr. Test Substitute',
        role: 'faculty',
        department: 'CME'
    };

    const mockSessionOther = {
        id: 99883,
        username: 'prof.test.other',
        name: 'Prof. Test Other',
        facultyName: 'Prof. Test Other',
        role: 'faculty',
        department: 'CME'
    };

    // Ensure mock faculty exist in store
    store.addFacultyInMemory({
        id: mockSessionRequester.id,
        code: 'TEST_REQ_01',
        name: mockSessionRequester.name,
        department: 'CME',
        status: 'active'
    });

    store.addFacultyInMemory({
        id: mockSessionSubstitute.id,
        code: 'TEST_SUB_01',
        name: mockSessionSubstitute.name,
        department: 'CME',
        status: 'active'
    });

    store.addFacultyInMemory({
        id: mockSessionOther.id,
        code: 'TEST_OTH_01',
        name: mockSessionOther.name,
        department: 'CME',
        status: 'active'
    });

    // Add scheduled timetable class for Requester on Monday Period 2
    store.addEntryInMemory({
        className: 'CME-SEM3-A',
        day: 'Monday',
        period: 2,
        subject: 'Operating Systems',
        faculty: mockSessionRequester.name,
        room: 'C-201',
        type: 'theory'
    });

    let createdRequestId = null;

    await check('6. Requester cannot select themselves as substitute (Self-substitution rejected)', async () => {
        try {
            await substitutions.createRequest({
                date: '2026-10-26', // A Monday
                period: 2,
                className: 'CME-SEM3-A',
                subject: 'Operating Systems',
                substituteFacultyId: mockSessionRequester.id,
                substituteFacultyName: mockSessionRequester.name,
                isAdjustment: true,
                sessionUser: mockSessionRequester
            });
            assert.fail('Should have rejected self-substitution');
        } catch (err) {
            assert.strictEqual(err.code, 'CANNOT_SUBSTITUTE_SELF');
        }
    });

    await check('7. Requester cannot request substitution for an unscheduled period (Class mismatch / no teaching)', async () => {
        try {
            await substitutions.createRequest({
                date: '2026-10-26', // A Monday
                period: 5, // Not teaching Period 5
                className: 'CME-SEM3-A',
                subject: 'Operating Systems',
                substituteFacultyId: mockSessionSubstitute.id,
                substituteFacultyName: mockSessionSubstitute.name,
                isAdjustment: true,
                sessionUser: mockSessionRequester
            });
            assert.fail('Should have rejected unscheduled period');
        } catch (err) {
            assert.strictEqual(err.code, 'NO_SCHEDULED_CLASS');
        }
    });

    await check('8. Requester cannot select a busy substitute who has a scheduled teaching conflict', async () => {
        // Substitute teaches on Monday Period 2 in CME-SEM1-B
        const conflictEntry = store.addEntryInMemory({
            className: 'CME-SEM1-B',
            day: 'Monday',
            period: 2,
            subject: 'Digital Logic',
            faculty: mockSessionSubstitute.name,
            room: 'C-102',
            type: 'theory'
        });

        try {
            await substitutions.createRequest({
                date: '2026-10-26',
                period: 2,
                className: 'CME-SEM3-A',
                subject: 'Operating Systems',
                substituteFacultyId: mockSessionSubstitute.id,
                substituteFacultyName: mockSessionSubstitute.name,
                isAdjustment: true,
                sessionUser: mockSessionRequester
            });
            assert.fail('Should have rejected busy substitute');
        } catch (err) {
            assert.strictEqual(err.code, 'SUBSTITUTE_NOT_FREE');
        } finally {
            // Remove the conflict entry for subsequent tests
            if (conflictEntry && conflictEntry.id) {
                store.deleteEntryInMemory(conflictEntry.id);
            }
        }
    });

    await check('9. Valid substitution request is created and saved with status PENDING', async () => {
        const req = await substitutions.createRequest({
            date: '2026-10-26',
            period: 2,
            className: 'CME-SEM3-A',
            subject: 'Operating Systems',
            substituteFacultyId: mockSessionSubstitute.id,
            substituteFacultyName: mockSessionSubstitute.name,
            isAdjustment: true,
            sessionUser: mockSessionRequester
        });

        assert.ok(req.id, 'Request must have an ID');
        assert.strictEqual(req.status, 'PENDING');
        assert.strictEqual(req.period, 2);
        assert.strictEqual(req.originalFacultyName, mockSessionRequester.name);
        assert.strictEqual(req.substituteFacultyName, mockSessionSubstitute.name);
        createdRequestId = req.id;
    });

    await check('10. Duplicate request for the same slot by requester is rejected', async () => {
        try {
            await substitutions.createRequest({
                date: '2026-10-26',
                period: 2,
                className: 'CME-SEM3-A',
                subject: 'Operating Systems',
                substituteFacultyId: mockSessionSubstitute.id,
                substituteFacultyName: mockSessionSubstitute.name,
                isAdjustment: true,
                sessionUser: mockSessionRequester
            });
            assert.fail('Should have rejected duplicate substitution request');
        } catch (err) {
            assert.strictEqual(err.code, 'DUPLICATE_SUBSTITUTION_REQUEST');
        }
    });

    await check('11. Substitute faculty can view the pending request in their incoming requests', async () => {
        const incoming = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        assert.ok(incoming.requests.length > 0, 'Substitute should see incoming request');
        const found = incoming.requests.find(r => r.id === createdRequestId);
        assert.ok(found, 'Created request must be in substitute incoming requests');
        assert.strictEqual(found.status, 'PENDING');
        assert.strictEqual(found.originalFacultyName, mockSessionRequester.name);
    });

    await check('12. Unrelated faculty cannot accept the substitution request', async () => {
        try {
            await substitutions.acceptRequest(createdRequestId, mockSessionOther);
            assert.fail('Unrelated faculty should not be able to accept request');
        } catch (err) {
            assert.strictEqual(err.code, 'FORBIDDEN');
        }
    });

    await check('13. Requester cannot accept their own substitution request', async () => {
        try {
            await substitutions.acceptRequest(createdRequestId, mockSessionRequester);
            assert.fail('Requester should not be able to accept own request');
        } catch (err) {
            assert.strictEqual(err.code, 'FORBIDDEN');
        }
    });

    await check('14. Substitute faculty successfully accepts the request with status transition to ACCEPTED', async () => {
        const accepted = await substitutions.acceptRequest(createdRequestId, mockSessionSubstitute);
        assert.strictEqual(accepted.status, 'ACCEPTED');
        assert.ok(accepted.respondedAt, 'Must record respondedAt timestamp');
    });

    await check('15. HOD branch view displays the substitution request and its updated status (read-only)', async () => {
        const hosResult = await substitutions.getBranchSubstitutions({
            branch: 'CME',
            sessionUser: {
                role: 'hos',
                department: 'CME',
                username: 'hos_cme'
            }
        });

        assert.strictEqual(hosResult.readOnly, true, 'HOD view must be strictly read-only');
        const found = hosResult.substitutions.find(s => s.id === createdRequestId);
        assert.ok(found, 'HOD must see the substitution in branch records');
        assert.strictEqual(found.status, 'ACCEPTED');
        assert.strictEqual(found.originalFacultyName, mockSessionRequester.name);
        assert.strictEqual(found.substituteFacultyName, mockSessionSubstitute.name);
    });

    // Cleanup mock test records from DB if connected
    if (store.usingDatabase && createdRequestId) {
        try {
            await query('DELETE FROM faculty_substitutions WHERE id = $1', [createdRequestId]);
        } catch (_) {}
    }

    console.log('\n============================================================');
    console.log(`Verification Complete: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error('Test runner failure:', err);
    process.exit(1);
});
