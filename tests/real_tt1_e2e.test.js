const fs = require('fs');
const assert = require('assert');

async function testE2E() {
    console.log('=== Running Live HTTP E2E Verification for TT1.jpeg Staging & Approval ===');
    
    // 1. Login as HOS sai_kishore
    const loginRes = await fetch('http://localhost:3001/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sai_kishore', password: 'sai_123' })
    });
    const loginData = await loginRes.json();
    console.log('1. HOS Login status:', loginRes.status, 'Department:', loginData.department);
    assert.strictEqual(loginRes.status, 200);

    const cookieHeader = loginRes.headers.get('set-cookie');
    const cookie = cookieHeader ? cookieHeader.split(';')[0] : '';

    // 2. Fetch baseline Master Timetable count
    const ttResBefore = await fetch('http://localhost:3001/api/timetable', {
        headers: { Cookie: cookie }
    });
    const ttBefore = await ttResBefore.json();
    const beforeCount = (ttBefore.entries || ttBefore.classes || []).length;
    console.log('2. Baseline Master Timetable count:', beforeCount);

    // 3. Upload TT1.jpeg using FormData & fetch
    console.log('3. Uploading TT1.jpeg to /api/timetable/import/preview...');
    const fileBytes = fs.readFileSync('TT1.jpeg');

    let previewRes;
    let previewData;
    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`   Attempt ${attempt} uploading TT1.jpeg...`);
        const blob = new Blob([fileBytes], { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('timetable', blob, 'TT1.jpeg');

        previewRes = await fetch('http://localhost:3001/api/timetable/import/preview', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: formData
        });
        previewData = await previewRes.json().catch(() => ({}));
        console.log(`   Preview response status: ${previewRes.status}`);
        if (previewRes.status === 200 && previewData.uploadId) break;
        if (attempt < 3) {
            console.log('   Waiting 3s before retry...');
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    console.log('4. Preview Response Status:', previewRes.status);
    console.log('   uploadId:', previewData.uploadId);
    console.log('   loaded (must be false):', previewData.loaded);
    console.log('   rowCount:', previewData.rowCount);
    console.log('   report.ok:', previewData.report && previewData.report.ok);

    assert.strictEqual(previewRes.status, 200);
    assert.strictEqual(previewData.loaded, false, 'Preview must have loaded: false');
    assert.ok(previewData.uploadId, 'Preview must return staged uploadId');
    assert.ok(previewData.rowCount > 0, 'Preview must extract rows');

    // 5. Verify Master Timetable is UNCHANGED after preview
    const ttResAfterPreview = await fetch('http://localhost:3001/api/timetable', {
        headers: { Cookie: cookie }
    });
    const ttAfterPreview = await ttResAfterPreview.json();
    const afterPreviewCount = (ttAfterPreview.entries || ttAfterPreview.classes || []).length;
    console.log('5. Master Timetable count after preview:', afterPreviewCount, '(Matches baseline:', afterPreviewCount === beforeCount, ')');
    assert.strictEqual(afterPreviewCount, beforeCount, 'Master Timetable must NOT change merely from preview');

    // 6. Check staging resolution status & verify approval gate
    console.log('6. Querying staging details via GET /api/staging/' + previewData.uploadId + '...');
    const stagingRes = await fetch(`http://localhost:3001/api/staging/${previewData.uploadId}`, {
        headers: { Cookie: cookie }
    });
    const stagingData = await stagingRes.json();
    console.log('   Staging validation status:', stagingData.validationStatus);
    console.log('   Resolution ok:', stagingData.resolution && stagingData.resolution.ok);
    console.log('   Unresolved count:', stagingData.resolution && stagingData.resolution.unresolvedCount);

    const unresolved = (stagingData.resolution && stagingData.resolution.unresolvedEntities) || [];
    if (unresolved.length > 0) {
        console.log(`   Found ${unresolved.length} unresolved entities:`);
        unresolved.forEach(u => console.log(`     - [${u.entityType.toUpperCase()}] ${u.extractedText} (${u.code || 'no code'})`));

        // 6a. Verify approval is BLOCKED while unresolved entities exist
        console.log('   Verifying approval is blocked with HTTP 422 before resolution...');
        const blockedApproveRes = await fetch(`http://localhost:3001/api/staging/${previewData.uploadId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie }
        });
        const blockedData = await blockedApproveRes.json();
        assert.strictEqual(blockedApproveRes.status, 422);
        assert.ok(/not resolved|unresolved/i.test(blockedData.error || ''));

        // 6b. Register remaining unresolved entities into catalog
        console.log('   Registering unresolved entities via POST /api/staging/' + previewData.uploadId + '/register-all-unresolved...');
        const regRes = await fetch(`http://localhost:3001/api/staging/${previewData.uploadId}/register-all-unresolved`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie }
        });
        const regData = await regRes.json();
        console.log('   Registration status:', regRes.status, 'Registered count:', regData.registeredCount);
        assert.strictEqual(regRes.status, 200);
        assert.strictEqual(regData.resolution.unresolvedCount, 0);
        assert.strictEqual(regData.resolution.ok, true);
    }

    // 7. Explicit HOD Approval via POST /api/staging/:uploadId/approve
    console.log('7. Approving staged timetable via POST /api/staging/' + previewData.uploadId + '/approve ...');
    const approveRes = await fetch(`http://localhost:3001/api/staging/${previewData.uploadId}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: cookie
        }
    });
    const approveData = await approveRes.json();

    console.log('8. Approval Response Status:', approveRes.status);
    console.log('   Message:', approveData.message || approveData.error);
    console.log('   importStatus:', approveData.importStatus);
    console.log('   importedCount:', approveData.importedCount);

    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveData.importStatus, 'IMPORTED');
    assert.ok(approveData.importedCount > 0);

    // 9. Verify Master Timetable is NOW updated with approved entries
    const ttResAfterApprove = await fetch('http://localhost:3001/api/timetable', {
        headers: { Cookie: cookie }
    });
    const ttAfterApprove = await ttResAfterApprove.json();
    console.log('9. Master Timetable after approval classes:', ttAfterApprove.classes ? ttAfterApprove.classes.map(c => c.name || c.class) : 'loaded');
    assert.ok(ttAfterApprove.classes && ttAfterApprove.classes.length > 0);

    // 10. Verify Availability now uses the approved timetable
    const availRes = await fetch('http://localhost:3001/api/availability/summary', {
        headers: { Cookie: cookie }
    });
    const availData = await availRes.json();
    console.log('10. Availability summary after approval:', availData);
    assert.strictEqual(availRes.status, 200);

    const slotRes = await fetch('http://localhost:3001/api/availability?day=Monday&period=1', {
        headers: { Cookie: cookie }
    });
    const slotData = await slotRes.json();
    console.log('    Availability for Monday P1 status:', slotRes.status, 'Free count:', (slotData.free || []).length);
    assert.strictEqual(slotRes.status, 200);

    // 11. Verify Duplicate Approval is BLOCKED (HTTP 409)
    const dupRes = await fetch(`http://localhost:3001/api/staging/${previewData.uploadId}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: cookie
        }
    });
    const dupData = await dupRes.json();
    console.log('11. Duplicate Approval Rejection Status:', dupRes.status, '(Code:', dupData.code, ')');
    assert.strictEqual(dupRes.status, 409);
    assert.strictEqual(dupData.code, 'ALREADY_IMPORTED');

    console.log('\n===============================================================');
    console.log('✅ ALL REAL TT1.jpeg END-TO-END STAGING & APPROVAL CHECKS PASSED');
    console.log('===============================================================\n');
}

testE2E().catch(err => {
    console.error('❌ E2E Test Failed:', err);
    process.exit(1);
});
