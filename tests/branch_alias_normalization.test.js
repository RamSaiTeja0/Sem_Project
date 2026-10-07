/**
 * Branch-Code Alias Normalization Test Suite
 *
 * Verifies:
 * 1. Centralized normalizeDepartmentCode behavior (explicit aliases only, no blind 'D' stripping, preserves case insensitivity).
 * 2. B2.1 Contract Validator accepts valid aliases (DCME -> CME) matching session/upload record.
 * 3. Extraction pipeline normalizes contract department_code to canonical while preserving raw_department_code.
 * 4. Case A: CME HOD + uploaded CME -> Accepted.
 * 5. Case B: CME HOD + uploaded DCME -> Accepted after normalization (No "Your branch is CME, not DCME" error).
 * 6. Case C: CME HOD + uploaded EEE -> Rejected with clear branch mismatch.
 * 7. Case D: EEE HOD + uploaded EEE -> Accepted.
 * 8. Case E: Other configured aliases (DEEE -> EEE, DMEC -> MEC, DCE -> CME) -> Accepted.
 * 9. Case F: Unknown/unregistered branch code -> Rejected clearly.
 * 10. Case G: Strict branch isolation (EEE HOD cannot upload DCME or CME).
 * 11. End-to-end Staging -> Approval -> Import lifecycle with normalized branch code.
 */

const { verifySafetyGuard } = require('./testDbGuard');
verifySafetyGuard();

const assert = require('assert');
const http = require('http');
const { app } = require('../server');
const db = require('../src/db/pool');
const store = require('../src/data/store');
const users = require('../src/data/users');
const {
    normalizeDepartmentCode,
    BRANCH_ALIASES,
    getBranch,
    registerBranch,
    resetBranchForTesting,
    canonical,
    isBranchRegistered,
    isConfigured
} = require('../src/data/departments');
const { validateExtractedContract } = require('../src/core/contractValidator');
const { normalizeExtractedContract } = require('../src/services/extractionPipeline');
const imageImporter = require('../src/importers/imageImporter');

function makeAppRequest(server, options, body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: server.address().port,
            ...options
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function buildMultipartBody(fields, fileField) {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    let body = '';

    for (const [k, v] of Object.entries(fields || {})) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
        body += `${v}\r\n`;
    }

    if (fileField) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n`;
        body += `Content-Type: ${fileField.contentType || 'application/octet-stream'}\r\n\r\n`;
        body += fileField.content.toString('binary') + '\r\n';
    }

    body += `--${boundary}--\r\n`;
    return {
        boundary,
        buffer: Buffer.from(body, 'binary')
    };
}

function buildMockContract(deptCode, className = 'CME-3-A') {
    return {
        contract_version: '2.1',
        timetable_type: 'MASTER_TIMETABLE',
        department_code: deptCode,
        academic_year: '2026-27',
        semester: 'SEM-3',
        days: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        entries: [
            {
                day: 'MONDAY',
                period: 1,
                class_name: className,
                subject_name: 'Data Structures',
                subject_code: 'CS301',
                faculty_name: 'Dr. Alan Turing',
                room: 'Lab-1',
                session_type: 'theory',
                span: 1,
                is_free: false
            }
        ]
    };
}

async function runTests() {
    console.log('--- Starting Branch-Code Alias Normalization Tests ---');
    let server;

    try {
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, resolve));

        // Ensure CME and EEE branches are registered for test
        registerBranch({ code: 'CME', name: 'Computer Engineering' });
        registerBranch({ code: 'EEE', name: 'Electrical Engineering' });

        // -------------------------------------------------------------
        // Test Group 1: Centralized Unit Normalization Logic
        // -------------------------------------------------------------
        console.log('[Test 1] Testing centralized normalizeDepartmentCode...');
        assert.strictEqual(normalizeDepartmentCode('DCME'), 'CME', 'DCME must normalize to CME');
        assert.strictEqual(normalizeDepartmentCode('dcme'), 'CME', 'Lowercase dcme must normalize to CME');
        assert.strictEqual(normalizeDepartmentCode('  DCME  '), 'CME', 'DCME with whitespace must normalize to CME');
        assert.strictEqual(normalizeDepartmentCode('CME'), 'CME', 'CME must remain CME');
        assert.strictEqual(normalizeDepartmentCode('DEEE'), 'EEE', 'DEEE must normalize to EEE');
        assert.strictEqual(normalizeDepartmentCode('EEE'), 'EEE', 'EEE must remain EEE');
        assert.strictEqual(normalizeDepartmentCode('DMEC'), 'MEC', 'DMEC must normalize to MEC');
        assert.strictEqual(normalizeDepartmentCode('DME'), 'MEC', 'DME must normalize to MEC');
        assert.strictEqual(normalizeDepartmentCode('MEC'), 'MEC', 'MEC must remain MEC');
        assert.strictEqual(normalizeDepartmentCode('DECE'), 'ECE', 'DECE must normalize to ECE');
        assert.strictEqual(normalizeDepartmentCode('ECE'), 'ECE', 'ECE must remain ECE');
        assert.strictEqual(normalizeDepartmentCode('DCIVIL'), 'CIVIL', 'DCIVIL must normalize to CIVIL');
        assert.strictEqual(normalizeDepartmentCode('CIVIL'), 'CIVIL', 'CIVIL must remain CIVIL');
        assert.strictEqual(normalizeDepartmentCode('DCE'), 'CIVIL', 'DCE must normalize to CIVIL');
        assert.strictEqual(normalizeDepartmentCode('DCSE'), 'CME', 'DCSE must normalize to CME');
        assert.strictEqual(normalizeDepartmentCode('DAIML'), 'AIML', 'DAIML must normalize to AIML');
        assert.strictEqual(normalizeDepartmentCode('AIML'), 'AIML', 'AIML must remain AIML');

        // Verify NO blind 'D' stripping for unknown branches
        assert.strictEqual(normalizeDepartmentCode('DXYZ'), 'DXYZ', 'DXYZ must NOT strip D without explicit alias');
        assert.strictEqual(normalizeDepartmentCode('UNKNOWN_DEPT'), 'UNKNOWN_DEPT', 'Unknown department preserved as-is');
        assert.strictEqual(normalizeDepartmentCode(''), '', 'Empty string returns empty');
        assert.strictEqual(normalizeDepartmentCode(null), null, 'Null returns null');

        // Verify helper methods integration
        assert.strictEqual(canonical('DCME'), 'CME', 'canonical("DCME") should return CME');
        assert.strictEqual(isBranchRegistered('DCME'), true, 'isBranchRegistered("DCME") should be true');
        assert.strictEqual(isBranchRegistered('UNKNOWN_99'), false, 'isBranchRegistered("UNKNOWN_99") should be false');
        assert.strictEqual(getBranch('DCME').code, 'CME', 'getBranch("DCME") should resolve to CME branch config');

        console.log('✓ Group 1: Unit normalization tests passed.');

        // -------------------------------------------------------------
        // Test Group 2: B2.1 Contract Validator & Normalizer Pipeline
        // -------------------------------------------------------------
        console.log('[Test 2] Testing Contract Validator & Pipeline Normalization...');

        // Contract with DCME against upload context with CME
        const rawDcmeContract = buildMockContract('DCME');
        const normContract = normalizeExtractedContract(rawDcmeContract, { departmentCode: 'CME' });
        assert.strictEqual(normContract.department_code, 'CME', 'Contract department_code should be normalized to CME');
        assert.strictEqual(normContract.raw_department_code, 'DCME', 'Contract raw_department_code should preserve DCME');

        // B2.1 validation for matching normalized codes
        const validRes = validateExtractedContract(rawDcmeContract, { departmentCode: 'CME' });
        assert.strictEqual(validRes.ok, true, 'DCME contract matching CME upload context must be valid');

        // B2.1 validation for mismatch: EEE contract against CME upload
        const mismatchContract = buildMockContract('EEE');
        const mismatchRes = validateExtractedContract(mismatchContract, { departmentCode: 'CME' });
        assert.strictEqual(mismatchRes.ok, false, 'EEE contract matching CME upload context must fail');
        assert.ok(mismatchRes.errors.some(e => e.includes('another branch') || mismatchRes.code === 'BRANCH_MISMATCH'),
            'Expected branch mismatch error in validation report');

        // B2.1 validation for cross-branch alias: DEEE contract against CME upload
        const crossAliasContract = buildMockContract('DEEE');
        const crossAliasRes = validateExtractedContract(crossAliasContract, { departmentCode: 'CME' });
        assert.strictEqual(crossAliasRes.ok, false, 'DEEE contract matching CME upload context must fail');

        console.log('✓ Group 2: Contract Validator & Pipeline Normalization tests passed.');

        // -------------------------------------------------------------
        // Test Group 3: HTTP API Ingestion & Staging Flow
        // -------------------------------------------------------------
        console.log('[Test 3] Testing HTTP API Ingestion with HOD Session...');

        users.resetForTesting();
        resetBranchForTesting();

        const salt = Math.floor(Math.random() * 9000) + 1000;
        const cmeUsername = `hod_cme_${salt}`;
        const eeeUsername = `hod_eee_${salt}`;

        // Register CME HOS
        const regCME = await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            role: 'hos',
            username: cmeUsername,
            password: 'Hos_Password_123',
            confirmPassword: 'Hos_Password_123',
            name: 'HOD CME Head',
            phone: '9876543210',
            email: `cme_${salt}@college.edu`,
            branchName: 'Computer Engineering',
            branchCode: 'CME'
        }));
        assert.strictEqual(regCME.status, 201, `CME HOS registration failed: ${JSON.stringify(regCME.body)}`);

        const cmeLogin = await makeAppRequest(server, {
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            username: cmeUsername,
            password: 'Hos_Password_123'
        }));
        assert.strictEqual(cmeLogin.status, 200, 'CME HOS login must succeed');
        const cmeCookie = cmeLogin.headers['set-cookie'][0].split(';')[0];

        // Register EEE HOS
        const regEEE = await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            role: 'hos',
            username: eeeUsername,
            password: 'Hos_Password_123',
            confirmPassword: 'Hos_Password_123',
            name: 'HOD EEE Head',
            phone: '9876543219',
            email: `eee_${salt}@college.edu`,
            branchName: 'Electrical Engineering',
            branchCode: 'EEE'
        }));
        assert.strictEqual(regEEE.status, 201, `EEE HOS registration failed: ${JSON.stringify(regEEE.body)}`);

        const eeeLogin = await makeAppRequest(server, {
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            username: eeeUsername,
            password: 'Hos_Password_123'
        }));
        assert.strictEqual(eeeLogin.status, 200, 'EEE HOS login must succeed');
        const eeeCookie = eeeLogin.headers['set-cookie'][0].split(';')[0];

        // Mock importer preview to return contracts for image/PDF uploads
        const originalParse = imageImporter.parse;
        let mockDept = 'CME';

        imageImporter.parse = async (buf, opts) => {
            const raw = buildMockContract(mockDept, `${mockDept}-3-A`);
            const mockTransport = async () => JSON.stringify(raw);
            return originalParse(buf, {
                ...opts,
                geminiTransport: mockTransport
            });
        };

        // --- Case A: CME HOD + uploaded CME -> Accepted ---
        mockDept = 'CME';
        const multipartA = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-3', section: 'A' },
            { name: 'timetable', filename: 'cme_timetable.png', contentType: 'image/png', content: Buffer.from('fake-cme-image') }
        );

        const resA = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartA.boundary}`,
                'Content-Length': multipartA.buffer.length,
                Cookie: cmeCookie
            }
        }, multipartA.buffer);

        assert.strictEqual(resA.status, 200, `Case A (CME HOD + CME timetable) should return 200, got ${resA.status}: ${JSON.stringify(resA.body)}`);
        assert.ok(resA.body.uploadId, 'Case A should return an uploadId');
        assert.strictEqual(resA.body.rawContract.department_code, 'CME', 'Case A department_code should be CME');
        console.log('✓ Case A: CME HOD + uploaded CME accepted.');

        // --- Case B: CME HOD + uploaded DCME -> Accepted after normalization ---
        // (Previously caused "Your branch is CME, not DCME")
        mockDept = 'DCME';
        const multipartB = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-3', section: 'A' },
            { name: 'timetable', filename: 'dcme_timetable.png', contentType: 'image/png', content: Buffer.from('fake-dcme-image') }
        );

        const resB = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartB.boundary}`,
                'Content-Length': multipartB.buffer.length,
                Cookie: cmeCookie
            }
        }, multipartB.buffer);

        assert.strictEqual(resB.status, 200, `Case B (CME HOD + DCME timetable) should return 200 without error, got ${resB.status}: ${JSON.stringify(resB.body)}`);
        assert.ok(resB.body.uploadId, 'Case B should return an uploadId');
        assert.strictEqual(resB.body.rawContract.raw_department_code, 'DCME', 'Case B raw_department_code should be DCME');
        assert.strictEqual(resB.body.rawContract.department_code, 'CME', 'Case B department_code should be normalized CME');
        console.log('✓ Case B: CME HOD + uploaded DCME accepted after normalization.');

        // Verify Staging and Approval of DCME upload
        const stagedUploadId = resB.body.uploadId;

        // Register any unresolved entities into CME catalog
        const regUnresolvedRes = await makeAppRequest(server, {
            path: `/api/staging/${stagedUploadId}/register-all-unresolved`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: cmeCookie
            }
        }, JSON.stringify({}));
        assert.strictEqual(regUnresolvedRes.status, 200, 'register-all-unresolved should succeed');

        const approveRes = await makeAppRequest(server, {
            path: `/api/staging/${stagedUploadId}/approve`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: cmeCookie
            }
        }, JSON.stringify({}));

        assert.strictEqual(approveRes.status, 200, `Approval of normalized DCME timetable should return 200, got ${approveRes.status}: ${JSON.stringify(approveRes.body)}`);
        assert.strictEqual(approveRes.body.success, true, 'Approval should succeed');
        assert.strictEqual(approveRes.body.department || (approveRes.body.scope && approveRes.body.scope.branch), 'CME', 'Approved branch must be CME');
        console.log('✓ Staging -> Approval of DCME upload completed successfully.');

        // --- Case C: CME HOD + uploaded EEE -> Rejected ---
        mockDept = 'EEE';
        const multipartC = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-3', section: 'A' },
            { name: 'timetable', filename: 'eee_timetable.png', contentType: 'image/png', content: Buffer.from('fake-eee-image') }
        );

        const resC = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartC.boundary}`,
                'Content-Length': multipartC.buffer.length,
                Cookie: cmeCookie
            }
        }, multipartC.buffer);

        assert.ok([400, 422, 403].includes(resC.status), `Case C (CME HOD + EEE upload) should be rejected, got status ${resC.status}`);
        assert.ok(resC.body.error || resC.body.validation, 'Case C should have error response');
        console.log('✓ Case C: CME HOD + uploaded EEE rejected.');

        // --- Case D: EEE HOD + uploaded EEE -> Accepted ---
        mockDept = 'EEE';
        const multipartD = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-3', section: 'A' },
            { name: 'timetable', filename: 'eee_timetable.png', contentType: 'image/png', content: Buffer.from('fake-eee-image') }
        );

        const resD = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartD.boundary}`,
                'Content-Length': multipartD.buffer.length,
                Cookie: eeeCookie
            }
        }, multipartD.buffer);

        assert.strictEqual(resD.status, 200, `Case D (EEE HOD + EEE timetable) should return 200, got ${resD.status}`);
        assert.strictEqual(resD.body.rawContract.department_code, 'EEE', 'Case D department_code should be EEE');
        console.log('✓ Case D: EEE HOD + uploaded EEE accepted.');

        // --- Case E: EEE HOD + uploaded DEEE -> Accepted after normalization ---
        mockDept = 'DEEE';
        const multipartE = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-3', section: 'A' },
            { name: 'timetable', filename: 'deee_timetable.png', contentType: 'image/png', content: Buffer.from('fake-deee-image') }
        );

        const resE = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartE.boundary}`,
                'Content-Length': multipartE.buffer.length,
                Cookie: eeeCookie
            }
        }, multipartE.buffer);

        assert.strictEqual(resE.status, 200, `Case E (EEE HOD + DEEE timetable) should return 200, got ${resE.status}`);
        assert.strictEqual(resE.body.rawContract.department_code, 'EEE', 'Case E department_code should be canonical EEE');
        assert.strictEqual(resE.body.rawContract.raw_department_code, 'DEEE', 'Case E raw_department_code should be DEEE');
        console.log('✓ Case E: EEE HOD + uploaded DEEE accepted after normalization.');

        // --- Case F: Unknown / Unregistered Branch -> Rejected ---
        mockDept = 'UNKNOWN_BRANCH_XYZ';
        const multipartF = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-1', section: 'A' },
            { name: 'timetable', filename: 'unknown_timetable.png', contentType: 'image/png', content: Buffer.from('fake-unknown-image') }
        );

        const resF = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartF.boundary}`,
                'Content-Length': multipartF.buffer.length,
                Cookie: cmeCookie
            }
        }, multipartF.buffer);

        assert.ok([400, 422, 403].includes(resF.status), `Case F (Unknown branch) should be rejected, got status ${resF.status}`);
        console.log('✓ Case F: Unknown branch code rejected clearly.');

        // --- Case G: Security isolation - EEE HOD attempting to upload DCME or CME -> Rejected ---
        mockDept = 'DCME';
        const multipartG = buildMultipartBody(
            { academicYear: '2026-27', semester: 'SEM-3', section: 'A' },
            { name: 'timetable', filename: 'dcme_timetable.png', contentType: 'image/png', content: Buffer.from('fake-dcme-image') }
        );

        const resG = await makeAppRequest(server, {
            path: '/api/timetable/import/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${multipartG.boundary}`,
                'Content-Length': multipartG.buffer.length,
                Cookie: eeeCookie
            }
        }, multipartG.buffer);

        assert.ok([400, 422, 403].includes(resG.status), `Case G (EEE HOD uploading DCME) must be rejected for cross-branch violation, got ${resG.status}`);
        console.log('✓ Case G: Cross-branch alias access strictly rejected.');

        // Restore importer parse
        imageImporter.parse = originalParse;

        console.log('\n========================================');
        console.log(' ALL 11 BRANCH ALIAS NORMALIZATION TESTS PASSED');
        console.log('========================================\n');

    } finally {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    }
}

if (require.main === module) {
    runTests()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Test failed:', err);
            process.exit(1);
        });
}

module.exports = { runTests };
