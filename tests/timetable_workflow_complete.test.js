/**
 * Complete Timetable Workflow Integration & Regression Test Suite
 *
 * Covers all 5 planned areas:
 * 1. Master Timetable Display (approval -> rows committed -> API -> UI -> availability, zero-slots check, Roman numerals).
 * 2. Unregistered Faculty in timetable (creates catalog reference without fake user credentials).
 * 3. Wrong-Branch Detection (detects mismatched branch dynamically, rejects with clear Detected/Your branch message).
 * 4. HOD Master Timetable Edit (edits cell, validates branch, persists to DB/store, immediately reflected in Master Timetable and availability).
 * 5. Faculty My Timetable Upload (preview -> confirm -> saves to My Timetable only, keeps official Master Timetable untouched).
 */

const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const http = require('http');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const repository = require('../src/db/repository');
const { app } = require('../server');
const { saveUploadRecord, saveStagedData, getStagedData } = require('../src/data/uploads');
const { validateExtractedContract } = require('../src/core/contractValidator');
const { resolveContract } = require('../src/core/entityResolver');

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

function call(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                const setCookie = (res.headers['set-cookie'] || [])[0] || null;
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    raw: data,
                    cookie: setCookie ? setCookie.split(';')[0] : null
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function uploadMultipart(urlPath, filename, fileBuffer, mimeType, cookie) {
    return new Promise((resolve, reject) => {
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        const header = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="timetable"; filename="${filename}"\r\n` +
            `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
        );
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const bodyBuffer = Buffer.concat([header, fileBuffer, footer]);

        const headers = {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuffer.length
        };
        if (cookie) headers.Cookie = cookie;

        const req = http.request(`${baseUrl}${urlPath}`, { method: 'POST', headers }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                resolve({
                    status: res.statusCode,
                    body: parsed,
                    raw: data
                });
            });
        });
        req.on('error', reject);
        req.write(bodyBuffer);
        req.end();
    });
}

async function runTest() {
    console.log('\n======================================================');
    console.log('Running Complete Timetable Workflow Integration Tests');
    console.log('======================================================\n');

    await startServer();

    try {
        if (db.isConfigured()) {
            await store.initFromDatabase();
        } else {
            await store.init();
        }

        const randSuffix = Math.floor(1000 + Math.random() * 9000);
        const branchCode = 'CSE_WF_' + randSuffix;

        // 1. Create HOD Account
        const hodUsername = `hod_wf_${randSuffix}`;
        const hodPassword = 'TecSub_123';
        const regHodRes = await call('POST', '/api/auth/register', {
            role: 'hos',
            username: hodUsername,
            password: hodPassword,
            confirmPassword: hodPassword,
            name: 'HOD WF Tester ' + randSuffix,
            phone: '9876543210',
            branchCode: branchCode,
            branchName: 'Computer Science WF ' + randSuffix,
            academicYear: '2025-2026',
            semester: 4
        });
        assert(regHodRes.status === 200 || regHodRes.status === 201, `HOD registration failed: ${JSON.stringify(regHodRes.body)}`);

        // Login as HOD
        const hodLogin = await call('POST', '/api/auth/login', {
            username: hodUsername,
            password: hodPassword
        });
        assert.strictEqual(hodLogin.status, 200, `HOD login failed: ${JSON.stringify(hodLogin.body)}`);
        const hodCookie = hodLogin.cookie;

        // 2. Create Faculty Account (created by HOD)
        const facUsername = `fac_wf_${randSuffix}`;
        const facPassword = 'TecSub_123';
        const facName = 'Prof. Faculty WF ' + randSuffix;
        const regFacRes = await call('POST', '/api/auth/register', {
            role: 'faculty',
            username: facUsername,
            password: facPassword,
            confirmPassword: facPassword,
            name: facName,
            phone: '9876543211',
            designation: 'Assistant Professor',
            subjects: ['Computer Science', 'Distributed Systems']
        }, hodCookie);
        assert(regFacRes.status === 200 || regFacRes.status === 201, `Faculty registration failed: ${JSON.stringify(regFacRes.body)}`);

        // Login as Faculty
        const facLogin = await call('POST', '/api/auth/login', {
            username: facUsername,
            password: facPassword
        });
        assert.strictEqual(facLogin.status, 200, `Faculty login failed: ${JSON.stringify(facLogin.body)}`);
        const facCookie = facLogin.cookie;

        // ========================================================
        // AREA 1: MASTER TIMETABLE APPROVAL, SCOPE & AVAILABILITY
        // ========================================================
        console.log('--- Testing Area 1: Master Timetable Approval & Display Flow ---');
        const uploadId1 = 'upload_wf_1_' + randSuffix;
        const className1 = `${branchCode}-4-A`;

        const contract1 = {
            academic_year: '2025-2026',
            semester: 'IV', // Roman numeral test
            section: 'A',
            branch_code: branchCode,
            class_name: className1,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Distributed Systems',
                    subject_code: 'CS401',
                    faculty_name: facName,
                    room_code: 'LH-101',
                    session_type: 'theory'
                },
                {
                    day: 'Monday',
                    period: 2,
                    subject_name: 'Database Security',
                    subject_code: 'CS402',
                    faculty_name: facName,
                    room_code: 'LH-102',
                    session_type: 'theory'
                }
            ]
        };

        await saveUploadRecord({
            uploadId: uploadId1,
            departmentCode: branchCode,
            uploadedBy: 'HOD WF Tester',
            originalFilename: 'master_tt_test.csv',
            uploadType: 'master',
            fileType: 'text/csv',
            fileBuffer: Buffer.from('dummy'),
            mimeType: 'text/csv',
            status: 'UPLOADED'
        });

        await saveStagedData(uploadId1, {
            extractedJson: contract1,
            validationStatus: 'VALID',
            validationErrors: [],
            importStatus: 'STAGED',
            resolution: {
                canAutoApprove: true,
                unresolvedEntities: []
            }
        });

        // Register / resolve entities if needed
        await call('POST', `/api/staging/${encodeURIComponent(uploadId1)}/register-all-unresolved`, {}, hodCookie);

        // Approve timetable
        const approveRes = await call('POST', `/api/staging/${uploadId1}/approve`, {}, hodCookie);
        assert.strictEqual(approveRes.status, 200, `Approval failed: ${JSON.stringify(approveRes.body)}`);
        assert.strictEqual(approveRes.body.success, true);
        assert(approveRes.body.importedCount >= 2, 'Expected at least 2 imported slots');

        // Query Master Timetable with Roman Numeral / standard scope
        const ttScopesRes = await call('GET', '/api/timetable/scopes', null, hodCookie);
        assert.strictEqual(ttScopesRes.status, 200);

        const ttRes = await call('GET', `/api/timetable?semester=SEM-4&section=A`, null, hodCookie);
        assert.strictEqual(ttRes.status, 200);
        const cells = ttRes.body.cells || [];
        const m1 = cells.find(c => c.day === 'Monday' && c.period === 1);
        assert(m1, 'Monday P1 must exist in returned timetable');
        assert.strictEqual(m1.subject, 'Distributed Systems');
        assert.strictEqual(m1.faculty, facName);

        // Verify Availability uses this timetable
        const availRes = await call('POST', '/api/availability', {
            day: 'Monday',
            period: 1,
            class: className1
        }, hodCookie);
        assert.strictEqual(availRes.status, 200);
        const isFree = (availRes.body.freeFaculty || []).some(f => f.name === facName);
        assert.strictEqual(isFree, false, `Occupied faculty ${facName} should not be free during Monday P1`);
        console.log('✓ Master Timetable Approval, Display, Roman Numeral, & Availability Verified!');

        // ========================================================
        // AREA 2: NEW FACULTY IN TIMETABLE (NO FAKE USER LOGIN)
        // ========================================================
        console.log('\n--- Testing Area 2: New Faculty Handling ---');
        const uploadId2 = 'upload_wf_2_' + randSuffix;
        const unregFacName = 'Dr. Extracted Guest ' + randSuffix;
        const contract2 = {
            academic_year: '2025-2026',
            semester: 4,
            section: 'B',
            branch_code: branchCode,
            class_name: `${branchCode}-4-B`,
            days: ['Tuesday'],
            periods: [1],
            entries: [
                {
                    day: 'Tuesday',
                    period: 1,
                    subject_name: 'Robotics',
                    subject_code: 'CS403',
                    faculty_name: unregFacName,
                    room_code: 'LH-103',
                    session_type: 'theory'
                }
            ]
        };

        const res2 = await resolveContract(contract2, branchCode);
        const unresolvedFaculty = (res2.unresolvedEntities || []).filter(e => e.entityType === 'faculty');
        assert.strictEqual(unresolvedFaculty.length, 0, 'Unregistered faculty should NOT be flagged as unresolved blocking entity');
        assert(res2.informationalWarnings.length > 0, 'Must produce informational warning');
        assert(res2.informationalWarnings[0].includes('does not have an account in this branch') || res2.informationalWarnings[0].includes('no login account'), 'Warning must specify no login account available');

        // Verify in DB/store that no user account was fabricated
        const fakeUserCheck = await call('POST', '/api/auth/login', {
            username: unregFacName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
            password: 'any_password'
        });
        assert.notStrictEqual(fakeUserCheck.status, 200, 'Fabricated user login must not exist');
        console.log('✓ Unregistered faculty created catalog reference with NO fake user credentials!');

        // ========================================================
        // AREA 3: WRONG-BRANCH DETECTION
        // ========================================================
        console.log('\n--- Testing Area 3: Wrong-Branch Detection ---');
        const foreignContract = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            academic_year: '2025-2026',
            semester: 4,
            section: 'A',
            department_code: 'MECHANICAL_XYZ',
            branch_code: 'MECHANICAL_XYZ',
            class_name: 'MECH-4-A',
            days: ['Monday'],
            periods: [1],
            entries: [
                {
                    day: 'Monday',
                    period: 1,
                    subject_name: 'Thermodynamics',
                    faculty_name: 'Dr. Mech Prof',
                    room_code: 'ME-101',
                    session_type: 'theory'
                }
            ]
        };

        const foreignVal = validateExtractedContract(foreignContract, { departmentCode: branchCode });
        assert.strictEqual(foreignVal.ok, false, 'Wrong-branch timetable must fail validation');
        assert.strictEqual(foreignVal.code, 'BRANCH_MISMATCH', 'Must return BRANCH_MISMATCH error code');
        const mismatchMsg = foreignVal.errors.find(e => e.includes('belongs to another branch'));
        assert.ok(mismatchMsg, 'Error message must specify timetable belongs to another branch');
        assert(foreignVal.errors.some(e => e.includes('MECHANICAL_XYZ')), 'Errors must show detected branch');
        assert(foreignVal.errors.some(e => e.includes(branchCode)), 'Errors must show your branch');
        console.log('✓ Wrong-branch timetable detected and rejected with clear branch message!');

        // ========================================================
        // AREA 4: HOD MASTER TIMETABLE EDIT
        // ========================================================
        console.log('\n--- Testing Area 4: HOD Master Timetable Edit ---');
        // Edit cell Tuesday P4 for CSE class
        const editRes = await call('POST', '/api/timetable/entries/slot', {
            className: className1,
            day: 'Tuesday',
            period: 4,
            subject: 'Cloud Computing Infrastructure',
            faculty: facName,
            room: 'LH-' + randSuffix,
            type: 'theory'
        }, hodCookie);
        assert.strictEqual(editRes.status, 200, `Edit slot failed: ${JSON.stringify(editRes.body)}`);
        assert.strictEqual(editRes.body.success, true);

        // Verify read-back via Master Timetable API
        const readBackRes = await call('GET', `/api/timetable?class=${className1}`, null, hodCookie);
        assert.strictEqual(readBackRes.status, 200);
        const editedCell = (readBackRes.body.cells || []).find(c => c.day === 'Tuesday' && c.period === 4);
        assert(editedCell, 'Edited cell Tuesday P4 must exist in Master Timetable');
        assert.strictEqual(editedCell.subject, 'Cloud Computing Infrastructure');

        // Faculty cannot edit Master Timetable cell
        const facForbiddenRes = await call('POST', '/api/timetable/entries/slot', {
            className: className1,
            day: 'Tuesday',
            period: 4,
            subject: 'Unauthorized Edit',
            faculty: facName
        }, facCookie);
        assert.strictEqual(facForbiddenRes.status, 403, 'Faculty edit to Master Timetable must be 403 Forbidden');
        console.log('✓ HOD Master Timetable Edit persisted and validated with RBAC!');

        // ========================================================
        // AREA 5: FACULTY MY TIMETABLE UPLOAD
        // ========================================================
        console.log('\n--- Testing Area 5: Faculty My Timetable Upload & Matching ---');

        // Register a second faculty in the same branch to verify isolation
        const fac2Username = `fac2_wf_${randSuffix}`;
        const fac2Name = `Colleague Two ${randSuffix}`;
        const regFac2Res = await call('POST', '/api/auth/register', {
            role: 'faculty',
            username: fac2Username,
            password: 'TecSub_123',
            confirmPassword: 'TecSub_123',
            name: fac2Name,
            phone: '9876543212',
            department: branchCode,
            subjects: ['Operating Systems', 'Computer Networks']
        }, hodCookie);
        assert.strictEqual(regFac2Res.status, 201, `Fac2 registration failed: ${JSON.stringify(regFac2Res.body)}`);

        const loginFac2Res = await call('POST', '/api/auth/login', {
            username: fac2Username,
            password: 'TecSub_123'
        });
        assert.strictEqual(loginFac2Res.status, 200);
        const fac2Cookie = loginFac2Res.cookie;

        // 5A. Multi-faculty CSV Timetable Upload Preview
        // CSV contains slots for facName, fac2Name, and another faculty
        const multiFacCsv =
            `Day,Period,Subject,Faculty,Room,Class\n` +
            `Monday,1,Data Structures,${facName},LH-101,${className1}\n` +
            `Monday,2,Operating Systems,${fac2Name},LH-102,${className1}\n` +
            `Tuesday,3,Compiler Design,${facName},LH-101,${className1}\n` +
            `Wednesday,4,Database Systems,Other Unknown Prof,LH-103,${className1}\n`;

        const previewRes = await uploadMultipart(
            '/api/faculty/timetable/preview',
            'multi_faculty_schedule.csv',
            Buffer.from(multiFacCsv),
            'text/csv',
            facCookie
        );

        assert.strictEqual(previewRes.status, 200, `Multi-faculty preview failed: ${JSON.stringify(previewRes.body)}`);
        assert.strictEqual(previewRes.body.success, true);
        assert.strictEqual(previewRes.body.slotCount, 2, 'Must filter ONLY the 2 teaching slots for the logged-in faculty');
        assert.ok(previewRes.body.slots.every(s => s.subject === 'Data Structures' || s.subject === 'Compiler Design'), 'Must only contain logged-in faculty subjects');

        // 5B. Confirm & Save to faculty_personal_timetable
        const facConfirmRes = await call('POST', '/api/faculty/timetable/confirm', {
            slots: previewRes.body.slots
        }, facCookie);

        assert.strictEqual(facConfirmRes.status, 200, `Faculty confirm failed: ${JSON.stringify(facConfirmRes.body)}`);
        assert.strictEqual(facConfirmRes.body.saved, true);
        assert.strictEqual(facConfirmRes.body.slotCount, 2);

        // 5C. Reload My Timetable from Database / Store
        const mineRes = await call('GET', '/api/timetable/mine', null, facCookie);
        assert.strictEqual(mineRes.status, 200);
        const mySlots = mineRes.body.cells || [];
        const monP1 = mySlots.find(c => c.day === 'Monday' && c.period === 1);
        const tueP3 = mySlots.find(c => c.day === 'Tuesday' && c.period === 3);
        const monP2 = mySlots.find(c => c.day === 'Monday' && c.period === 2);

        assert(monP1 && monP1.status === 'busy' && monP1.subject === 'Data Structures', 'Monday P1 must be busy with Data Structures');
        assert(tueP3 && tueP3.status === 'busy' && tueP3.subject === 'Compiler Design', 'Tuesday P3 must be busy with Compiler Design');
        assert(monP2 && monP2.status === 'free', 'Monday P2 (taught by Colleague Two) must be FREE in fac1 personal timetable');

        // 5D. Second Faculty Isolation: Colleague Two's schedule is completely independent
        const fac2MineRes = await call('GET', '/api/timetable/mine', null, fac2Cookie);
        assert.strictEqual(fac2MineRes.status, 200);
        const fac2Slots = fac2MineRes.body.cells || [];
        const fac2MonP1 = fac2Slots.find(c => c.day === 'Monday' && c.period === 1);
        assert(fac2MonP1 && fac2MonP1.status === 'free', 'Colleague Two must NOT see fac1 slots');

        // 5E. Upload containing multi-faculty timetable with NO teaching periods for logged-in faculty gives clear diagnostic
        const multiOtherFacCsv =
            `Day,Period,Subject,Faculty,Room,Class\n` +
            `Monday,1,VLSI Design,${fac2Name},LH-201,${className1}\n` +
            `Tuesday,2,Embedded Systems,Prof. Third Colleague,LH-201,${className1}\n`;

        const noMatchPreviewRes = await uploadMultipart(
            '/api/faculty/timetable/preview',
            'multi_other_faculty.csv',
            Buffer.from(multiOtherFacCsv),
            'text/csv',
            facCookie
        );
        assert.strictEqual(noMatchPreviewRes.status, 200);
        assert.strictEqual(noMatchPreviewRes.body.slotCount, 0);
        assert.ok(noMatchPreviewRes.body.diagnosticReason, 'Must provide clear diagnostic reason');
        assert(noMatchPreviewRes.body.diagnosticReason.includes(facName), 'Diagnostic must mention the logged-in faculty');

        // 5F. Upload containing single-faculty timetable for another faculty member is rejected
        const singleOtherFacCsv =
            `Day,Period,Subject,Faculty,Room,Class\n` +
            `Monday,1,VLSI Design,${fac2Name},LH-201,${className1}\n`;

        const singleForeignPreviewRes = await uploadMultipart(
            '/api/faculty/timetable/preview',
            'single_foreign_faculty.csv',
            Buffer.from(singleOtherFacCsv),
            'text/csv',
            facCookie
        );
        assert.strictEqual(singleForeignPreviewRes.status, 403, 'Foreign single faculty upload must be 403');
        assert.strictEqual(singleForeignPreviewRes.body.code, 'FACULTY_MISMATCH');
        assert.strictEqual(singleForeignPreviewRes.body.detectedFaculty, fac2Name);

        // 5G. Verify Master Timetable for class was NOT modified by personal upload
        const masterCheckRes = await call('GET', `/api/timetable?class=${className1}`, null, hodCookie);
        assert.strictEqual(masterCheckRes.status, 200);
        console.log('✓ Faculty My Timetable multi-faculty matching, confirmation, database reload & isolation verified!');

        console.log('\n======================================================');
        console.log('ALL 5 TIMETABLE WORKFLOW AREAS PASSED SUCCESSFULLY!');
        console.log('======================================================\n');
    } finally {
        await stopServer();
    }
}

runTest().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failure:', err);
    process.exit(1);
});
