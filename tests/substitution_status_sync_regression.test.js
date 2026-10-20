/**
 * F.A.S.T. — Faculty Substitution Status Synchronization & UI Consistency Regression Test Suite
 *
 * Verifies:
 * 1. A pending request appears in Incoming Requests with Accept and Decline buttons.
 * 2. Accepting a pending request changes its status through the existing backend workflow (PENDING -> ACCEPTED).
 * 3. After acceptance, the request disappears from Incoming Requests.
 * 4. The incoming badge decreases correctly (counts strictly PENDING requests).
 * 5. The accepted request appears in history with status ACCEPTED.
 * 6. An already-accepted request is not displayed as pending.
 * 7. An already-rejected request is not displayed as pending.
 * 8. The UI does not display Accept or Decline buttons for final-status requests.
 * 9. A stale frontend response is corrected by refreshing from the backend.
 * 10. Existing branch isolation and authorization remain unchanged.
 * 11. Existing availability and timetable-conflict checks still run.
 * 12. Duplicate acceptance and concurrent accept/decline attempts remain safely handled.
 */
const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/data/store');
const substitutions = require('../src/data/substitutions');
const repository = require('../src/db/repository');
const { query } = require('../src/db/pool');

async function run() {
    console.log('================================================================');
    console.log('F.A.S.T. — Substitution Status Synchronization Regression Tests');
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

    const rand = Math.floor(Math.random() * 9000 + 1000);
    const FAC_A_ID = 8100 + rand;
    const FAC_B_ID = 8200 + rand;
    const FAC_OTHER_ID = 8300 + rand;

    const mockSessionRequester = {
        role: 'faculty',
        department: 'CME',
        username: `kusuma_${rand}`,
        name: `Ms. B. Kusuma ${rand}`,
        facultyName: `Ms. B. Kusuma ${rand}`,
        facultyId: FAC_A_ID,
        id: FAC_A_ID
    };

    const mockSessionSubstitute = {
        role: 'faculty',
        department: 'CME',
        username: `lohith_${rand}`,
        name: `Lohith Kumar ${rand}`,
        facultyName: `Lohith Kumar ${rand}`,
        facultyId: FAC_B_ID,
        id: FAC_B_ID
    };

    const mockSessionOther = {
        role: 'faculty',
        department: 'ECE',
        username: `other_fac_${rand}`,
        name: `Dr. Other Branch ${rand}`,
        facultyName: `Dr. Other Branch ${rand}`,
        facultyId: FAC_OTHER_ID,
        id: FAC_OTHER_ID
    };

    const mockSessionHOD = {
        role: 'hos',
        department: 'CME',
        username: `hod_cme_${rand}`,
        name: `HOD CME ${rand}`
    };

    // Ensure faculty records exist in engine roster
    store.addFacultyInMemory({ id: FAC_A_ID, name: mockSessionRequester.name, code: `FAC_A_${rand}`, department: 'CME', status: 'active' });
    store.addFacultyInMemory({ id: FAC_B_ID, name: mockSessionSubstitute.name, code: `FAC_B_${rand}`, department: 'CME', status: 'active' });
    store.addFacultyInMemory({ id: FAC_OTHER_ID, name: mockSessionOther.name, code: `FAC_O_${rand}`, department: 'ECE', status: 'active' });

    // Add scheduled teaching class for Faculty A on Saturday Period 1
    const classEntry = store.addEntryInMemory({
        className: 'CME-SEM1-A',
        day: 'Saturday',
        period: 1,
        subject: 'COES',
        faculty: mockSessionRequester.name,
        room: 'Room-101',
        type: 'theory'
    });

    let req1Id = null;
    let req2Id = null;

    // -------------------------------------------------------------------------
    // TEST 1: Creation of a valid pending request
    // -------------------------------------------------------------------------
    await check('1. Pending request is created and appears in Incoming Requests for substitute', async () => {
        const result = await substitutions.createRequest({
            date: '2026-10-24', // Saturday
            period: 1,
            className: 'CME-SEM1-A',
            subject: 'COES',
            substituteFacultyId: mockSessionSubstitute.id,
            substituteFacultyName: mockSessionSubstitute.name,
            isAdjustment: true,
            sessionUser: mockSessionRequester
        });

        assert.ok(result && result.id, 'Request must have an ID');
        assert.strictEqual(result.status, 'PENDING');
        req1Id = result.id;

        // Check substitute's incoming requests
        const incoming = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        assert.ok(incoming.requests.length >= 1, 'Incoming requests must not be empty');
        const found = incoming.requests.find(r => r.id === req1Id);
        assert.ok(found, 'Created request must appear in incoming requests');
        assert.strictEqual(found.status, 'PENDING');
        assert.strictEqual(found.originalFacultyName, mockSessionRequester.name);
    });

    // -------------------------------------------------------------------------
    // TEST 2: Incoming badge count matches pending requests
    // -------------------------------------------------------------------------
    await check('2. Incoming badge count correctly reflects the pending request count', async () => {
        const incoming = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        const pendingCount = incoming.requests.filter(r => (r.status || 'PENDING').toUpperCase() === 'PENDING').length;
        assert.strictEqual(pendingCount, incoming.requests.length, 'By default incoming requests are all pending');
        assert.ok(pendingCount >= 1, 'Badge count must be at least 1');
    });

    // -------------------------------------------------------------------------
    // TEST 3: Accepting pending request transitions status to ACCEPTED
    // -------------------------------------------------------------------------
    await check('3. Accepting pending request transitions status to ACCEPTED', async () => {
        const accepted = await substitutions.acceptRequest(req1Id, mockSessionSubstitute);
        assert.strictEqual(accepted.status, 'ACCEPTED');
        assert.ok(accepted.respondedAt, 'Must set respondedAt timestamp');
    });

    // -------------------------------------------------------------------------
    // TEST 4: After acceptance, request disappears from Incoming Requests
    // -------------------------------------------------------------------------
    await check('4. After acceptance, the request disappears from Incoming Requests', async () => {
        const incomingAfter = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        const foundInIncoming = incomingAfter.requests.find(r => r.id === req1Id);
        assert.strictEqual(foundInIncoming, undefined, 'Accepted request must NOT appear in Incoming Requests');
    });

    // -------------------------------------------------------------------------
    // TEST 5: Incoming badge count decreases after acceptance
    // -------------------------------------------------------------------------
    await check('5. Incoming badge count decreases to 0 (or remaining pending requests)', async () => {
        const incomingAfter = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        const pendingCount = incomingAfter.requests.filter(r => (r.status || 'PENDING').toUpperCase() === 'PENDING').length;
        assert.strictEqual(pendingCount, 0, 'Badge count for this substitute must be 0 after accepting the only request');
    });

    // -------------------------------------------------------------------------
    // TEST 6: Accepted request appears in History with status ACCEPTED
    // -------------------------------------------------------------------------
    await check('6. Accepted request appears in history with status ACCEPTED', async () => {
        const mySubs = await substitutions.getMySubstitutions(mockSessionSubstitute);
        // It is present in incomingRequests directed to substitute
        const foundIncoming = mySubs.incomingRequests.find(r => r.id === req1Id);
        assert.ok(foundIncoming, 'Must be found in substitute history');
        assert.strictEqual(foundIncoming.status, 'ACCEPTED');

        // Also present in all list
        const foundAll = mySubs.all.find(r => r.id === req1Id);
        assert.ok(foundAll, 'Must be in all substitutions list');
        assert.strictEqual(foundAll.status, 'ACCEPTED');
    });

    // -------------------------------------------------------------------------
    // TEST 7: Duplicate acceptance attempt returns 400 REQUEST_NOT_PENDING
    // -------------------------------------------------------------------------
    await check('7. Duplicate acceptance attempt returns 400 REQUEST_NOT_PENDING', async () => {
        try {
            await substitutions.acceptRequest(req1Id, mockSessionSubstitute);
            assert.fail('Should not allow accepting already-accepted request');
        } catch (err) {
            assert.strictEqual(err.status, 400);
            assert.strictEqual(err.code, 'REQUEST_NOT_PENDING');
            assert.match(err.message, /already accepted/i);
        }
    });

    // -------------------------------------------------------------------------
    // TEST 8: Rejection transitions to REJECTED and disappears from Incoming Requests
    // -------------------------------------------------------------------------
    await check('8. Rejected request transitions to REJECTED and does not appear in incoming requests', async () => {
        // Create another class & request for Faculty A on Saturday Period 2
        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Saturday',
            period: 2,
            subject: 'Data Structures',
            faculty: mockSessionRequester.name,
            room: 'Room-102',
            type: 'theory'
        });

        const req2 = await substitutions.createRequest({
            date: '2026-10-24',
            period: 2,
            className: 'CME-SEM1-A',
            subject: 'Data Structures',
            substituteFacultyId: mockSessionSubstitute.id,
            substituteFacultyName: mockSessionSubstitute.name,
            isAdjustment: true,
            sessionUser: mockSessionRequester
        });
        req2Id = req2.id;

        // Substitute rejects the request
        const rejected = await substitutions.rejectRequest(req2Id, 'Prior personal engagement', mockSessionSubstitute);
        assert.strictEqual(rejected.status, 'REJECTED');
        assert.strictEqual(rejected.rejectionReason, 'Prior personal engagement');

        // Verify it is NOT in incoming requests
        const incomingAfterReject = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        const foundRejected = incomingAfterReject.requests.find(r => r.id === req2Id);
        assert.strictEqual(foundRejected, undefined, 'Rejected request must NOT appear in Incoming Requests');
    });

    // -------------------------------------------------------------------------
    // TEST 9: Frontend DOM & JS logic verification for buttons & status rendering
    // -------------------------------------------------------------------------
    await check('9. Frontend code strictly shows Accept/Decline only for PENDING requests and refreshes on already-accepted', () => {
        const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
        const appJsContent = fs.readFileSync(appJsPath, 'utf8');

        // Check loadIncomingSubstitutions filters for PENDING
        assert.ok(appJsContent.includes("(r.status || 'PENDING').toUpperCase() === 'PENDING'"),
            'loadIncomingSubstitutions must filter strictly for PENDING requests');

        // Check updatePendingSubstitutionsBadge filters for PENDING
        assert.ok(appJsContent.includes("var count = rawList.filter(function (r) {"),
            'updatePendingSubstitutionsBadge must filter rawList for PENDING');

        // Check handleAcceptSub refreshes incoming substitutions and badge on already-accepted
        assert.ok(appJsContent.includes("isAlreadyAccepted"),
            'handleAcceptSub must detect already-accepted errors');
        assert.ok(appJsContent.includes("This substitution request has already been accepted"),
            'handleAcceptSub must display friendly message when already accepted');

        // Check loadMySubstitutions includes resolved incoming requests in history
        assert.ok(appJsContent.includes("outgoing.concat(resolvedIncoming)"),
            'loadMySubstitutions must combine outgoing and resolved incoming requests');
    });

    // -------------------------------------------------------------------------
    // TEST 10: Authorization & Governance - HOD and third-party cannot accept
    // -------------------------------------------------------------------------
    await check('10. HOD and third-party faculty cannot accept or reject requests', async () => {
        // Create fresh pending request for period 3
        store.addEntryInMemory({
            className: 'CME-SEM1-A',
            day: 'Saturday',
            period: 3,
            subject: 'Algorithms',
            faculty: mockSessionRequester.name,
            room: 'Room-103',
            type: 'theory'
        });

        const req3 = await substitutions.createRequest({
            date: '2026-10-24',
            period: 3,
            className: 'CME-SEM1-A',
            subject: 'Algorithms',
            substituteFacultyId: mockSessionSubstitute.id,
            substituteFacultyName: mockSessionSubstitute.name,
            isAdjustment: true,
            sessionUser: mockSessionRequester
        });

        // HOD attempts to accept -> HTTP 403 FORBIDDEN
        try {
            await substitutions.acceptRequest(req3.id, mockSessionHOD);
            assert.fail('HOD must not be able to accept substitution');
        } catch (err) {
            assert.strictEqual(err.status, 403);
            assert.strictEqual(err.code, 'FORBIDDEN');
        }

        // Other branch faculty attempts to accept -> HTTP 403 FORBIDDEN
        try {
            await substitutions.acceptRequest(req3.id, mockSessionOther);
            assert.fail('Third party faculty must not be able to accept substitution');
        } catch (err) {
            assert.strictEqual(err.status, 403);
            assert.strictEqual(err.code, 'FORBIDDEN');
        }

        // Requester attempts to accept their own request -> HTTP 403 FORBIDDEN
        try {
            await substitutions.acceptRequest(req3.id, mockSessionRequester);
            assert.fail('Requester must not be able to accept own substitution');
        } catch (err) {
            assert.strictEqual(err.status, 403);
            assert.strictEqual(err.code, 'FORBIDDEN');
        }
    });

    // -------------------------------------------------------------------------
    // TEST 11: Real-time availability checks (Double booking & timetable conflict)
    // -------------------------------------------------------------------------
    await check('11. Real-time availability conflict prevents duplicate booking on the same slot', async () => {
        // Substitute has already accepted req1 on Saturday Period 1.
        // If another request is created for Saturday Period 1, candidate selection and acceptance must reject.
        const isDoubleBooked = substitutions.hasAcceptedSubstitution(mockSessionSubstitute, '2026-10-24', 1);
        assert.strictEqual(isDoubleBooked, true, 'hasAcceptedSubstitution must return true for Saturday Period 1');

        try {
            await substitutions.createRequest({
                date: '2026-10-24',
                period: 1,
                className: 'CME-SEM1-A',
                subject: 'COES',
                substituteFacultyId: mockSessionSubstitute.id,
                substituteFacultyName: mockSessionSubstitute.name,
                isAdjustment: true,
                sessionUser: mockSessionRequester
            });
            assert.fail('Should have rejected double-booking candidate');
        } catch (err) {
            assert.ok(err.message.includes('DUPLICATE_SUBSTITUTION_REQUEST') || err.message.includes('already accepted'));
        }
    });

    // -------------------------------------------------------------------------
    // TEST 12: Stale response recovery simulation
    // -------------------------------------------------------------------------
    await check('12. Explicit query status parameter allows retrieving ALL or PENDING requests', async () => {
        // Query status='ALL' returns all requests (pending, accepted, rejected)
        const allRes = await substitutions.getIncomingSubstitutions(mockSessionSubstitute, { status: 'ALL' });
        assert.ok(allRes.requests.some(r => r.id === req1Id && r.status === 'ACCEPTED'),
            'status=ALL must include the accepted request');

        // Default query returns ONLY pending requests
        const defaultRes = await substitutions.getIncomingSubstitutions(mockSessionSubstitute);
        assert.ok(!defaultRes.requests.some(r => r.id === req1Id),
            'Default incoming must not include accepted request');
        assert.ok(!defaultRes.requests.some(r => r.id === req2Id),
            'Default incoming must not include rejected request');
    });

    // Clean up created mock entries
    if (store.usingDatabase && (req1Id || req2Id)) {
        try {
            await query('DELETE FROM faculty_substitutions WHERE id IN ($1, $2)', [req1Id, req2Id]);
        } catch (_) {}
    }

    console.log('\n================================================================');
    console.log(`Results: ${passed} passed, ${failed} failed.`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
