/**
 * Phase B1 — Timetable Image/PDF Upload Foundation Tests
 *
 * Verifies all 15 key requirements:
 *   1. HOS can upload master timetable (PNG, JPG, PDF).
 *   2. Faculty can upload own timetable.
 *   3. Faculty upload belongs to authenticated faculty.
 *   4. Faculty cannot impersonate another faculty.
 *   5. Client cannot change branch_id.
 *   6. HOS cannot upload to another branch.
 *   7. Faculty cannot upload to another branch.
 *   8. Invalid file type rejected (PNG/JPG/JPEG/PDF only).
 *   9. Oversized file rejected (>10MB).
 *  10. Empty upload rejected (0-byte or missing file).
 *  11. Upload metadata is stored correctly.
 *  12. Uploaded file is not publicly exposed.
 *  13. Cross-branch upload isolation enforced (HTTP 403).
 *  14. Faculty cannot upload master timetable (HTTP 403).
 *  15. HOS cannot upload faculty timetable (HTTP 403).
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { check, checkAsync, counts } = require('./helpers');
const { app } = require('../server');
const users = require('../src/data/users');
const { resetBranchForTesting } = require('../src/data/departments');
const { clearUploads, UPLOADS_ROOT } = require('../src/data/uploads');

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

function callUpload(urlPath, filename, buffer, cookie, mimeType = 'application/pdf', extraFields = {}) {
    return new Promise((resolve, reject) => {
        const boundary = '----tectest' + Date.now();
        const parts = [];

        Object.keys(extraFields).forEach(name => {
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${extraFields[name]}\r\n`));
        });

        if (filename != null && buffer != null) {
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="timetable"; filename="${filename}"\r\n` +
                `Content-Type: ${mimeType}\r\n\r\n`));
            parts.push(buffer);
            parts.push(Buffer.from(`\r\n`));
        }

        parts.push(Buffer.from(`--${boundary}--\r\n`));
        const payload = Buffer.concat(parts);

        const headers = {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length
        };
        if (cookie) headers.Cookie = cookie;

        let finished = false;
        const req = http.request(`${baseUrl}${urlPath}`, {
            method: 'POST',
            headers
        }, res => {
            finished = true;
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });

        req.on('error', err => {
            if (finished || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
                return; // Server closed connection early after sending error response
            }
            reject(err);
        });

        try {
            req.write(payload, () => {});
            req.end();
        } catch (e) {
            // Stream write might throw EPIPE if server already responded and closed
        }
    });
}

async function run() {
    console.log('\n====================================');
    console.log('TecSubstitution — Upload Foundation Tests (Phase B1)\n');

    await startServer();

    // Clean testing state
    users.resetForTesting();
    resetBranchForTesting();
    clearUploads();

    // Sample file buffers
    const samplePdf = Buffer.from('%PDF-1.4 sample timetable pdf content');
    const samplePng = Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRsample png');
    const sampleJpg = Buffer.from('\xFF\xD8\xFF\xE0\x00\x10JFIFsample jpg');

    // 1. Setup CME HOS
    const hosReg = await call('POST', '/api/auth/register', {
        role: 'hos',
        name: 'CME Head of Section',
        phone: '9876543210',
        branchName: 'Computer Engineering',
        branchCode: 'CME',
        username: 'cme_hos',
        password: 'Cme_password1'
    });
    assert.strictEqual(hosReg.status, 201, 'CME HOS registered');

    const hosLogin = await call('POST', '/api/auth/login', {
        username: 'cme_hos',
        password: 'Cme_password1'
    });
    assert.strictEqual(hosLogin.status, 200, 'CME HOS logged in');
    const cmeHosCookie = hosLogin.cookie;
    assert.ok(cmeHosCookie, 'CME HOS cookie received');

    // 2. CME HOS creates CME Faculty
    const facCreate = await call('POST', '/api/auth/register', {
        role: 'faculty',
        name: 'Dr. Ravi Sharma',
        phone: '9123456789',
        username: 'ravi_sharma',
        password: 'Ravi_password1',
        subjects: ['Data Structures']
    }, cmeHosCookie);
    assert.strictEqual(facCreate.status, 201, 'CME Faculty created');

    const facLogin = await call('POST', '/api/auth/login', {
        username: 'ravi_sharma',
        password: 'Ravi_password1'
    });
    assert.strictEqual(facLogin.status, 200, 'CME Faculty logged in');
    const cmeFacCookie = facLogin.cookie;
    assert.ok(cmeFacCookie, 'CME Faculty cookie received');

    // 3. Setup EEE HOS for independent branch
    const eeeHosReg = await call('POST', '/api/auth/register', {
        role: 'hos',
        name: 'EEE Head of Section',
        phone: '9876500000',
        branchName: 'Electrical Engineering',
        branchCode: 'EEE',
        username: 'eee_hos',
        password: 'Eee_password1'
    });
    assert.strictEqual(eeeHosReg.status, 201, 'EEE HOS registered');

    const eeeHosLogin = await call('POST', '/api/auth/login', {
        username: 'eee_hos',
        password: 'Eee_password1'
    });
    assert.strictEqual(eeeHosLogin.status, 200, 'EEE HOS logged in');
    const eeeHosCookie = eeeHosLogin.cookie;

    let cmeMasterUploadId = null;
    let cmeFacultyUploadId = null;
    let eeeMasterUploadId = null;

    // Test 1: HOS can upload master timetable (PNG, JPG, PDF)
    await checkAsync('[test 1] HOS can upload master timetable (PDF, PNG, JPG)', async () => {
        // PDF upload
        const resPdf = await callUpload('/api/uploads/master-timetable', 'cme_master.pdf', samplePdf, cmeHosCookie, 'application/pdf');
        assert.strictEqual(resPdf.status, 201, 'PDF upload returns 201');
        assert.strictEqual(resPdf.body.success, true);
        assert.strictEqual(resPdf.body.uploadType, 'MASTER_TIMETABLE');
        assert.strictEqual(resPdf.body.department, 'CME');
        assert.strictEqual(resPdf.body.status, 'UPLOADED');
        assert.strictEqual(resPdf.body.originalFilename, 'cme_master.pdf');
        assert.strictEqual(resPdf.body.message, 'Timetable uploaded. Processing will be available in the next step.');
        cmeMasterUploadId = resPdf.body.uploadId;
        assert.ok(cmeMasterUploadId, 'Upload ID generated');

        // PNG upload
        const resPng = await callUpload('/api/uploads/master-timetable', 'cme_master.png', samplePng, cmeHosCookie, 'image/png');
        assert.strictEqual(resPng.status, 201, 'PNG upload returns 201');
        assert.strictEqual(resPng.body.fileType, 'image/png');

        // JPG upload
        const resJpg = await callUpload('/api/uploads/master-timetable', 'cme_master.jpg', sampleJpg, cmeHosCookie, 'image/jpeg');
        assert.strictEqual(resJpg.status, 201, 'JPG upload returns 201');
        assert.strictEqual(resJpg.body.fileType, 'image/jpeg');
    });

    // Test 2: Faculty can upload own timetable
    await checkAsync('[test 2] Faculty can upload own timetable', async () => {
        const res = await callUpload('/api/uploads/faculty-timetable', 'ravi_schedule.pdf', samplePdf, cmeFacCookie, 'application/pdf');
        assert.strictEqual(res.status, 201, 'Faculty timetable returns 201');
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.uploadType, 'FACULTY_TIMETABLE');
        assert.strictEqual(res.body.department, 'CME');
        assert.strictEqual(res.body.faculty, 'Dr. Ravi Sharma');
        assert.strictEqual(res.body.status, 'UPLOADED');
        assert.strictEqual(res.body.message, 'Timetable uploaded. Processing will be available in the next step.');
        cmeFacultyUploadId = res.body.uploadId;
        assert.ok(cmeFacultyUploadId, 'Faculty upload ID generated');
    });

    // Test 3: Faculty upload belongs to authenticated faculty
    await checkAsync('[test 3] Faculty upload metadata belongs to authenticated faculty', async () => {
        const res = await call('GET', `/api/uploads/${cmeFacultyUploadId}`, null, cmeFacCookie);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.faculty, 'Dr. Ravi Sharma');
        assert.strictEqual(res.body.department, 'CME');
        assert.strictEqual(res.body.uploadType, 'FACULTY_TIMETABLE');
    });

    // Test 4: Faculty cannot impersonate another faculty
    await checkAsync('[test 4] Faculty cannot impersonate another faculty via client fields', async () => {
        const res = await callUpload('/api/uploads/faculty-timetable', 'spoofed.pdf', samplePdf, cmeFacCookie, 'application/pdf', {
            faculty: 'Prof. Other Person',
            faculty_id: '9999',
            username: 'someone_else'
        });
        assert.strictEqual(res.status, 403, 'Impersonation rejected with 403');
        assert.strictEqual(res.body.code, 'FACULTY_UPLOAD_MISMATCH');
    });

    // Test 5: Client cannot change branch_id
    await checkAsync('[test 5] Client-supplied branch_id cannot change authenticated branch', async () => {
        const res = await callUpload('/api/uploads/master-timetable', 'cme_spoofed.pdf', samplePdf, cmeHosCookie, 'application/pdf', {
            department: 'EEE',
            branch_id: 'EEE'
        });
        assert.strictEqual(res.status, 403, 'Branch override rejected with 403');
        assert.strictEqual(res.body.code, 'BRANCH_UPLOAD_MISMATCH');
    });

    // Test 6: HOS cannot upload to another branch
    await checkAsync('[test 6] HOS cannot upload to another branch', async () => {
        const res = await callUpload('/api/uploads/master-timetable', 'hacked.pdf', samplePdf, cmeHosCookie, 'application/pdf', {
            department: 'MEC'
        });
        assert.strictEqual(res.status, 403);
    });

    // Test 7: Faculty cannot upload to another branch
    await checkAsync('[test 7] Faculty cannot upload to another branch', async () => {
        const res = await callUpload('/api/uploads/faculty-timetable', 'hacked.pdf', samplePdf, cmeFacCookie, 'application/pdf', {
            department: 'EEE'
        });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'BRANCH_UPLOAD_MISMATCH');
    });

    // Test 8: Invalid file type rejected
    await checkAsync('[test 8] Invalid file type is rejected (e.g. .txt, .exe, .html)', async () => {
        const badTxt = Buffer.from('hello world plain text');
        const resTxt = await callUpload('/api/uploads/master-timetable', 'notes.txt', badTxt, cmeHosCookie, 'text/plain');
        assert.strictEqual(resTxt.status, 400, 'Text file rejected');
        assert.match(resTxt.body.error, /Invalid file type/i);

        const badExe = Buffer.from('MZ binary executable');
        const resExe = await callUpload('/api/uploads/master-timetable', 'app.exe', badExe, cmeHosCookie, 'application/octet-stream');
        assert.strictEqual(resExe.status, 400, 'Exe file rejected');
    });

    // Test 9: Oversized file rejected
    await checkAsync('[test 9] Oversized file is rejected', async () => {
        // Create an 11MB buffer (limit is 10MB)
        const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0x20);
        const res = await callUpload('/api/uploads/master-timetable', 'huge.pdf', bigBuffer, cmeHosCookie, 'application/pdf');
        assert.strictEqual(res.status, 400, 'Oversized file rejected with 400');
        assert.match(res.body.error, /too large/i);
    });

    // Test 10: Empty upload rejected
    await checkAsync('[test 10] Empty upload rejected (0-byte file or missing file field)', async () => {
        // Missing file part entirely
        const resMissing = await callUpload('/api/uploads/master-timetable', null, null, cmeHosCookie);
        assert.strictEqual(resMissing.status, 400, 'Missing file rejected');
        assert.strictEqual(resMissing.body.code, 'NO_FILE');

        // 0-byte file
        const resEmpty = await callUpload('/api/uploads/master-timetable', 'empty.pdf', Buffer.alloc(0), cmeHosCookie, 'application/pdf');
        assert.strictEqual(resEmpty.status, 400, '0-byte file rejected');
        assert.strictEqual(resEmpty.body.code, 'EMPTY_FILE');
    });

    // Test 11: Upload metadata stored correctly
    await checkAsync('[test 11] Upload metadata is stored correctly and retrievable', async () => {
        const res = await call('GET', `/api/uploads/${cmeMasterUploadId}`, null, cmeHosCookie);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.uploadId, cmeMasterUploadId);
        assert.strictEqual(res.body.originalFilename, 'cme_master.pdf');
        assert.strictEqual(res.body.fileType, 'application/pdf');
        assert.strictEqual(res.body.department, 'CME');
        assert.strictEqual(res.body.uploadType, 'MASTER_TIMETABLE');
        assert.strictEqual(res.body.status, 'UPLOADED');
        assert.ok(res.body.fileSize > 0);
    });

    // Test 12: Uploaded file is not publicly exposed
    await checkAsync('[test 12] Uploaded file is not publicly exposed', async () => {
        // Check direct access without authentication or via static routes
        const resPublic = await call('GET', '/uploads/cme_master.pdf');
        assert.notStrictEqual(resPublic.status, 200, 'Direct file path not served publicly');

        const resDeep = await call('GET', `/uploads/timetables/${cmeMasterUploadId}.pdf`);
        assert.notStrictEqual(resDeep.status, 200, 'Direct storage path not served publicly');
    });

    // Test 13: Cross-branch upload isolation enforced
    await checkAsync('[test 13] Cross-branch upload isolation enforced', async () => {
        // EEE HOS uploads master timetable
        const eeeRes = await callUpload('/api/uploads/master-timetable', 'eee_master.pdf', samplePdf, eeeHosCookie, 'application/pdf');
        assert.strictEqual(eeeRes.status, 201);
        eeeMasterUploadId = eeeRes.body.uploadId;

        // CME HOS attempts to access EEE upload metadata -> 403
        const cmeTryEee = await call('GET', `/api/uploads/${eeeMasterUploadId}`, null, cmeHosCookie);
        assert.strictEqual(cmeTryEee.status, 403, 'CME HOS accessing EEE upload returns 403');
        assert.strictEqual(cmeTryEee.body.code, 'FORBIDDEN');

        // EEE HOS attempts to access CME upload metadata -> 403
        const eeeTryCme = await call('GET', `/api/uploads/${cmeMasterUploadId}`, null, eeeHosCookie);
        assert.strictEqual(eeeTryCme.status, 403, 'EEE HOS accessing CME upload returns 403');
        assert.strictEqual(eeeTryCme.body.code, 'FORBIDDEN');
    });

    // Test 14: Faculty cannot upload master timetable
    await checkAsync('[test 14] Faculty cannot upload master timetable', async () => {
        const res = await callUpload('/api/uploads/master-timetable', 'faculty_attempt_master.pdf', samplePdf, cmeFacCookie, 'application/pdf');
        assert.strictEqual(res.status, 403, 'Faculty rejected from master-timetable endpoint');
        assert.strictEqual(res.body.code, 'FORBIDDEN');
    });

    // Test 15: HOS cannot upload faculty timetable
    await checkAsync('[test 15] HOS cannot upload faculty timetable', async () => {
        const res = await callUpload('/api/uploads/faculty-timetable', 'hos_attempt_faculty.pdf', samplePdf, cmeHosCookie, 'application/pdf');
        assert.strictEqual(res.status, 403, 'HOS rejected from faculty-timetable endpoint');
        assert.strictEqual(res.body.code, 'FORBIDDEN');
    });

    await stopServer();

    console.log('\n====================================');
    const { passed, failed } = counts();
    console.log(`Phase B1 Upload Tests finished: ${passed} passed, ${failed} failed.\n`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
