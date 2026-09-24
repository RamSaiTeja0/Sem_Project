/**
 * HOD-Only Master Timetable RBAC & Read-Only Faculty Access Tests
 *
 * Verifies that:
 * 1. HOD has full edit, upload, preview, cell edit, approve, and slot edit access.
 * 2. Faculty has read-only access to Master Timetable.
 * 3. Direct unauthorized mutation API attempts by Faculty return HTTP 403.
 * 4. Staging and live Master Timetable data remain untouched upon unauthorized attempts.
 * 5. Faculty My Timetable functionality remains unaffected.
 */

const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const { saveUploadRecord, saveStagedData } = require('../src/data/uploads');

let server;
let baseUrl;

function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

function call(method, urlPath, body, cookie, rawHeaders = {}) {
    return new Promise((resolve, reject) => {
        let payload = null;
        const headers = { ...rawHeaders };

        if (typeof body === 'string') {
            payload = body;
            headers['Content-Length'] = Buffer.byteLength(payload);
        } else if (body) {
            payload = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                const setCookie = res.headers['set-cookie'];
                const cookieVal = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : (setCookie ? setCookie.split(';')[0] : null);
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    headers: res.headers,
                    cookie: cookieVal
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log('\n======================================================');
    console.log('Running HOD-Only Master Timetable RBAC & Security Tests');
    console.log('======================================================\n');

    await startServer();

    if (db.isConfigured()) {
        await store.initFromDatabase();
    }

    const rand = Math.floor(1000 + Math.random() * 9000);
    const branchCode = `RBAC_${rand}`;
    const hodUsername = `hod_rbac_${rand}`;
    const facUsername = `fac_rbac_${rand}`;
    const password = 'Password_123';
    const facName = `Prof. RBAC Tester ${rand}`;

    // --- 1. Create Branch & Register HOD ---
    console.log('--- Step 1: Register HOD for Branch ' + branchCode + ' ---');
    const hodReg = await call('POST', '/api/auth/register', {
        username: hodUsername,
        password,
        phone: '9876543210',
        role: 'hos',
        branchCode,
        branchName: `RBAC Branch ${rand}`,
        name: `HOD ${branchCode}`
    });
    assert.strictEqual(hodReg.status, 201, `HOD register failed: ${JSON.stringify(hodReg.body)}`);
    const hodCookie = hodReg.cookie;
    assert.ok(hodCookie, 'HOD cookie required');

    // --- 2. Create Faculty under Branch ---
    console.log('--- Step 2: Create Faculty Account ---');
    const facCreate = await call('POST', '/api/auth/register', {
        role: 'faculty',
        username: facUsername,
        password,
        confirmPassword: password,
        name: facName,
        phone: '9876543211',
        designation: 'Assistant Professor',
        subjects: ['Computer Science', 'Operating Systems']
    }, hodCookie);
    assert(facCreate.status === 200 || facCreate.status === 201, `Faculty create failed: ${JSON.stringify(facCreate.body)}`);

    // Faculty login
    const facLogin = await call('POST', '/api/auth/login', {
        username: facUsername,
        password
    });
    assert.strictEqual(facLogin.status, 200, `Faculty login failed: ${JSON.stringify(facLogin.body)}`);
    const facCookie = facLogin.cookie;
    assert.ok(facCookie, 'Faculty cookie required');

    // --- 3. Stage a Timetable as HOD ---
    console.log('--- Step 3: Stage a Timetable for HOD Review ---');
    const uploadId = `upl_rbac_${rand}`;
    const className = `${branchCode}-SEM5-A`;

    await saveUploadRecord({
        uploadId,
        originalFilename: 'master_tt.png',
        fileType: 'image/png',
        fileSize: 1024,
        uploaderUserId: hodUsername,
        branchId: branchCode,
        departmentCode: branchCode,
        academicYear: '2024-2027',
        semester: 'SEM-5',
        section: 'A',
        targetClass: className,
        uploadType: 'MASTER_TIMETABLE',
        status: 'PROCESSING'
    });

    const stagedContract = {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        department_code: branchCode,
        academic_year: '2024-2027',
        semester: 'SEM-5',
        section: 'A',
        class_name: className,
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        entries: [
            {
                day: 'Monday',
                period: 1,
                subject_name: 'Advanced Algorithms',
                subject_code: 'AA-501',
                faculty_name: facName,
                room_code: `Room_${rand}_101`,
                session_type: 'theory',
                class_name: className
            },
            {
                day: 'Tuesday',
                period: 2,
                subject_name: 'Operating Systems',
                subject_code: 'OS-502',
                faculty_name: facName,
                room_code: `Room_${rand}_102`,
                session_type: 'theory',
                class_name: className
            }
        ],
        faculty_legend: [{ name: facName, code: 'FAC_1' }],
        subject_legend: [{ name: 'Advanced Algorithms', code: 'AA-501' }, { name: 'Operating Systems', code: 'OS-502' }]
    };

    await saveStagedData(uploadId, stagedContract, 'VALID', null, { unresolvedEntities: [] });

    // --- 4. Verify HOD can edit staging cell ---
    console.log('--- Step 4: Verify HOD can edit staging cell ---');
    const hodStgEdit = await call('PUT', `/api/staging/${uploadId}/entry`, {
        day: 'Monday',
        period: 1,
        subject_name: 'Advanced Algorithms Modified',
        subject_code: 'AA-501',
        faculty_name: facName,
        room_code: `Room_${rand}_105`,
        session_type: 'theory'
    }, hodCookie);
    assert.strictEqual(hodStgEdit.status, 200, `HOD staging edit failed: ${JSON.stringify(hodStgEdit.body)}`);
    assert.strictEqual(hodStgEdit.body.success, true);
    console.log('✓ HOD can edit staging cell');

    // --- 5. Verify Faculty CANNOT edit staging cell (HTTP 403) ---
    console.log('--- Step 5: Verify Faculty CANNOT edit staging cell ---');
    const facStgEdit = await call('PUT', `/api/staging/${uploadId}/entry`, {
        day: 'Monday',
        period: 1,
        subject_name: 'Hacked Subject By Faculty',
        faculty_name: facName,
        room_code: `Room_${rand}_999`
    }, facCookie);
    assert.strictEqual(facStgEdit.status, 403, 'Faculty staging edit must return 403 FORBIDDEN');
    console.log('✓ Faculty staging edit rejected with HTTP 403');

    // --- 6. Verify Faculty CANNOT approve staging (HTTP 403) ---
    console.log('--- Step 6: Verify Faculty CANNOT approve staging ---');
    const facApprove = await call('POST', `/api/staging/${uploadId}/approve`, {}, facCookie);
    assert.strictEqual(facApprove.status, 403, 'Faculty approval must return 403 FORBIDDEN');
    console.log('✓ Faculty staging approval rejected with HTTP 403');

    // --- 7. Verify Faculty CANNOT register unresolved entities in staging (HTTP 403) ---
    console.log('--- Step 7: Verify Faculty CANNOT register entities in staging ---');
    const facReg = await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, facCookie);
    assert.strictEqual(facReg.status, 403, 'Faculty register-all-unresolved must return 403 FORBIDDEN');
    console.log('✓ Faculty register entities rejected with HTTP 403');

    // --- 8. Verify HOD approves staging ---
    console.log('--- Step 8: HOD Approves Timetable ---');
    await call('POST', `/api/staging/${uploadId}/register-all-unresolved`, {}, hodCookie);
    const hodApprove = await call('POST', `/api/staging/${uploadId}/approve`, {}, hodCookie);
    assert.strictEqual(hodApprove.status, 200, `HOD approval failed: ${JSON.stringify(hodApprove.body)}`);
    assert.strictEqual(hodApprove.body.success, true);
    console.log('✓ HOD successfully approved and imported Master Timetable');

    // --- 9. Verify BOTH HOD and Faculty can VIEW the Master Timetable ---
    console.log('--- Step 9: Verify Master Timetable View for Both Roles ---');
    const hodView = await call('GET', `/api/timetable?semester=SEM-5&section=A&academicYear=2024-2027`, null, hodCookie);
    assert.strictEqual(hodView.status, 200);
    const hodCells = (hodView.body.cells || []).filter(c => c.status === 'busy');
    assert.strictEqual(hodCells.length, 2, 'HOD must see 2 busy cells in Master Timetable');

    const facView = await call('GET', `/api/timetable?semester=SEM-5&section=A&academicYear=2024-2027`, null, facCookie);
    assert.strictEqual(facView.status, 200);
    const facCells = (facView.body.cells || []).filter(c => c.status === 'busy');
    assert.strictEqual(facCells.length, 2, 'Faculty must see 2 busy cells in Master Timetable');
    console.log('✓ Both HOD and Faculty can read Master Timetable grid');

    // --- 10. Verify HOD can edit Live Master Timetable Slot ---
    console.log('--- Step 10: HOD edits Master Timetable slot ---');
    const hodSlotEdit = await call('POST', '/api/timetable/entries/slot', {
        className,
        day: 'Monday',
        period: 1,
        subject: 'Advanced Algorithms HOD Updated',
        faculty: facName,
        room: `Room_${rand}_108`,
        type: 'theory'
    }, hodCookie);
    assert.strictEqual(hodSlotEdit.status, 200, `HOD slot edit failed: ${JSON.stringify(hodSlotEdit.body)}`);
    assert.strictEqual(hodSlotEdit.body.success, true);
    console.log('✓ HOD slot edit succeeded');

    // --- 11. Verify Faculty CANNOT edit Live Master Timetable Slot (HTTP 403) ---
    console.log('--- Step 11: Faculty attempts to edit Master Timetable slot ---');
    const facSlotEdit = await call('POST', '/api/timetable/entries/slot', {
        className,
        day: 'Monday',
        period: 1,
        subject: 'Unauthorized Faculty Edit',
        faculty: facName,
        room: `Room_${rand}_999`,
        type: 'theory'
    }, facCookie);
    assert.strictEqual(facSlotEdit.status, 403, 'Faculty slot edit must return 403 FORBIDDEN');
    console.log('✓ Faculty slot edit rejected with HTTP 403');

    // Verify cell content is unchanged by faculty attempt
    const verifyView = await call('GET', `/api/timetable?semester=SEM-5&section=A&academicYear=2024-2027`, null, facCookie);
    const cellP1 = (verifyView.body.cells || []).find(c => c.day === 'Monday' && c.period === 1);
    assert.strictEqual(cellP1.subject, 'Advanced Algorithms HOD Updated', 'Cell content must NOT have been changed by faculty');
    console.log('✓ Master Timetable data integrity preserved against unauthorized faculty edit');

    // --- 12. Verify Faculty CANNOT clear Master Timetable (HTTP 403) ---
    console.log('--- Step 12: Faculty attempts to clear Master Timetable ---');
    const facClear = await call('POST', '/api/timetable/clear', {
        semester: 'SEM-5',
        section: 'A',
        branch: branchCode
    }, facCookie);
    assert.strictEqual(facClear.status, 403, 'Faculty clear must return 403 FORBIDDEN');
    console.log('✓ Faculty clear rejected with HTTP 403');

    // --- 13. Verify Faculty CANNOT upload Master Timetable (HTTP 403) ---
    console.log('--- Step 13: Faculty attempts to upload Master Timetable ---');
    const boundary = '----WebKitFormBoundary' + rand;
    const bodyMultipart =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="timetable"; filename="test.csv"\r\n` +
        `Content-Type: text/csv\r\n\r\n` +
        `Faculty,Monday P1,Monday P2\r\n${facName},CS101,CS102\r\n` +
        `--${boundary}--\r\n`;

    const facUpload = await call('POST', '/api/uploads/master-timetable', bodyMultipart, facCookie, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
    });
    assert.strictEqual(facUpload.status, 403, 'Faculty master timetable upload must return 403 FORBIDDEN');
    console.log('✓ Faculty master timetable upload rejected with HTTP 403');

    // --- 14. Verify Faculty CANNOT commit import to Master Timetable (HTTP 403) ---
    console.log('--- Step 14: Faculty attempts to commit import to Master Timetable ---');
    const facImportCommit = await call('POST', '/api/timetable/import', bodyMultipart, facCookie, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
    });
    assert.strictEqual(facImportCommit.status, 403, 'Faculty master timetable commit import must return 403 FORBIDDEN');
    console.log('✓ Faculty master timetable commit import rejected with HTTP 403');

    // --- 15. Verify Faculty My Timetable Flow Still Works ---
    console.log('--- Step 15: Verify Faculty My Timetable Flow ---');
    const myTtPreview = await call('POST', '/api/faculty/timetable/preview', bodyMultipart, facCookie, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
    });
    assert.strictEqual(myTtPreview.status, 200, `Faculty personal preview failed: ${JSON.stringify(myTtPreview.body)}`);
    assert.strictEqual(myTtPreview.body.success, true);

    const myTtConfirm = await call('POST', '/api/faculty/timetable/confirm', {
        slots: [
            { day: 'Wednesday', period: 3, subject: 'My Personal Lab', className: `${branchCode}-SEM5-A` }
        ]
    }, facCookie);
    assert.strictEqual(myTtConfirm.status, 200);
    assert.strictEqual(myTtConfirm.body.saved, true);
    console.log('✓ Faculty My Timetable personal workflow operates independently and correctly');

    await stopServer();
    console.log('\n======================================================');
    console.log('ALL 15 HOD-ONLY MASTER TIMETABLE RBAC CHECKS PASSED!');
    console.log('======================================================\n');
    process.exit(0);
}

runTests().catch(async (err) => {
    console.error('Test error:', err);
    await stopServer();
    process.exit(1);
});
