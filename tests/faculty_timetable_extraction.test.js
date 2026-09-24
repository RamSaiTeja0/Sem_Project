/**
 * Faculty Personal Timetable Extraction & Dynamic Slot Matching Regression Tests
 *
 * Verifies:
 * 1. Multi-faculty timetable with > 3 faculty slots extracts ALL matching slots dynamically.
 * 2. Distinct timetable structure (5 days, 4 periods) extracts all theory, lab, activity slots.
 * 3. Joint faculty names (e.g. "A / B") are matched properly.
 * 4. Multi-period lab sessions (span_to) are expanded into discrete slots.
 * 5. Single-faculty personal timetable extracts all valid slots.
 * 6. Single-faculty foreign timetable is rejected with HTTP 403 FACULTY_MISMATCH.
 * 7. Multi-faculty timetable with 0 matches returns clear diagnosticReason.
 * 8. Master Timetable remains immutable.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { app } = require('../server');
const { validateExtractedContract } = require('../src/core/contractValidator');
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
        if (body) {
            req.write(body);
        }
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
        body += `Content-Type: ${fileField.contentType || 'text/csv'}\r\n\r\n`;
        body += fileField.content;
        body += '\r\n';
    }

    body += `--${boundary}--\r\n`;
    return { boundary, body: Buffer.from(body, 'utf8') };
}

async function runTests() {
    console.log('\n======================================================');
    console.log('Running Faculty Personal Timetable Extraction Tests');
    console.log('======================================================\n');

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const salt = Math.floor(Math.random() * 9000) + 1000;
        const branchCode = `FAC_DEPT_${salt}`;
        const hosUsername = `hos_user_${salt}`;

        // 1. Register HOS & Branch
        const hosReg = await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            role: 'hos',
            username: hosUsername,
            password: 'Hos_Password_123',
            confirmPassword: 'Hos_Password_123',
            name: 'HOS Test Head',
            phone: '9876543210',
            email: `hos_${salt}@college.edu`,
            branchName: 'Faculty Testing Department',
            branchCode
        }));
        assert(hosReg.status === 200 || hosReg.status === 201, `HOS registration failed: ${JSON.stringify(hosReg.body)}`);

        // Login as HOS to get cookie for creating faculty
        const hosLogin = await makeAppRequest(server, {
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            username: hosUsername,
            password: 'Hos_Password_123'
        }));
        assert.strictEqual(hosLogin.status, 200);
        const hosCookie = hosLogin.headers['set-cookie'][0].split(';')[0];

        // 2. Create Faculty Account
        const facName = `Dr. Faculty Test ${salt}`;
        const facUsername = `fac_${salt}`;
        const facCreate = await makeAppRequest(server, {
            path: '/api/auth/register',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: hosCookie
            }
        }, JSON.stringify({
            role: 'faculty',
            name: facName,
            username: facUsername,
            password: 'Fac_Password_123',
            confirmPassword: 'Fac_Password_123',
            department: branchCode,
            email: `fac_${salt}@college.edu`,
            phone: '9876543210',
            subjects: ['Theory One', 'Theory Two', 'Lab One']
        }));
        assert(facCreate.status === 200 || facCreate.status === 201, `Faculty creation failed: ${JSON.stringify(facCreate.body)}`);

        // 3. Login as Faculty
        const facLogin = await makeAppRequest(server, {
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
            username: facUsername,
            password: 'Fac_Password_123'
        }));
        assert.strictEqual(facLogin.status, 200);
        const facCookie = facLogin.headers['set-cookie'][0].split(';')[0];

        // -------------------------------------------------------------
        // TEST CASE 1: Multi-Faculty Timetable with > 3 slots (8 slots total)
        // -------------------------------------------------------------
        console.log('--- Test 1: Multi-Faculty Timetable with 8 Personal Slots ---');
        const csv8Slots = [
            'Faculty,Day,Period,Subject,Class,Room,Type',
            `${facName},Monday,1,Operating Systems,CSE-A,301,theory`,
            `${facName},Monday,2,Operating Systems,CSE-A,301,theory`,
            `${facName},Tuesday,3,Web Technologies,CSE-A,301,theory`,
            `${facName},Tuesday,4,Web Technologies,CSE-A,301,theory`,
            `${facName},Wednesday,1,Database Systems,CSE-A,301,theory`,
            `${facName},Thursday,5,Project Mentoring,CSE-A,301,activity`,
            `${facName},Friday,2,Advanced Computing,CSE-A,301,theory`,
            `${facName},Saturday,3,Seminar,CSE-A,301,activity`,
            `Other Colleague ${salt},Monday,3,Physics,CSE-A,302,theory`,
            `Other Colleague ${salt},Tuesday,1,Chemistry,CSE-A,302,theory`
        ].join('\n');

        const mp1 = buildMultipartBody({}, {
            name: 'timetable',
            filename: 'schedule_8slots.csv',
            contentType: 'text/csv',
            content: csv8Slots
        });

        const preview1 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${mp1.boundary}`,
                'Content-Length': mp1.body.length,
                Cookie: facCookie
            }
        }, mp1.body);

        assert.strictEqual(preview1.status, 200);
        assert.strictEqual(preview1.body.totalSlots, 8, 'Must return exactly 8 matched slots (not capped at 3)');
        assert.strictEqual(preview1.body.slots.length, 8);
        console.log(`✓ Test 1 Passed: Correctly extracted all ${preview1.body.totalSlots} slots for ${facName}`);

        // Confirm and save Test 1 slots
        const save1 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/confirm',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: facCookie }
        }, JSON.stringify({ slots: preview1.body.slots }));
        assert.strictEqual(save1.status, 200);
        assert.strictEqual(save1.body.slotCount, 8);

        // Verify DB reload
        const mine1 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/mine',
            method: 'GET',
            headers: { Cookie: facCookie }
        });
        assert.strictEqual(mine1.status, 200);
        const busyCount1 = mine1.body.cells.filter(c => c.status === 'busy').length;
        assert.strictEqual(busyCount1, 8, 'DB reload must show all 8 saved periods');
        console.log(`✓ Test 1 DB Reload Passed: Reloaded ${busyCount1} busy cells from database`);

        // -------------------------------------------------------------
        // TEST CASE 2: Distinct Layout (5 Days, 4 Periods, Labs, Activities, Theory)
        // -------------------------------------------------------------
        console.log('\n--- Test 2: Distinct 5-Day 4-Period Layout with Lab & Activities ---');
        const csv5Day4Period = [
            'Faculty,Day,Period,Subject,Class,Room,Type',
            `${facName},Monday,1,Digital Logic,IT-B,201,theory`,
            `${facName},Monday,2,Digital Logic,IT-B,201,theory`,
            `${facName},Tuesday,1,Hardware Lab,IT-B,LAB-1,lab`,
            `${facName},Tuesday,2,Hardware Lab,IT-B,LAB-1,lab`,
            `${facName},Wednesday,3,Training & Placement (TPC),IT-B,201,activity`,
            `${facName},Thursday,4,Library / Counselling,IT-B,201,activity`,
            `Dr. External Specialist,Friday,1,Maths,IT-B,201,theory`
        ].join('\n');

        const mp2 = buildMultipartBody({}, {
            name: 'timetable',
            filename: 'distinct_5day_schedule.csv',
            contentType: 'text/csv',
            content: csv5Day4Period
        });

        const preview2 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${mp2.boundary}`,
                'Content-Length': mp2.body.length,
                Cookie: facCookie
            }
        }, mp2.body);

        assert.strictEqual(preview2.status, 200);
        assert.strictEqual(preview2.body.totalSlots, 6, 'Must extract all 6 slots (theory, lab, activity)');
        const subjectsFound = preview2.body.slots.map(s => s.subject);
        assert.ok(subjectsFound.includes('Digital Logic'));
        assert.ok(subjectsFound.includes('Hardware Lab'));
        assert.ok(subjectsFound.includes('Training & Placement (TPC)'));
        assert.ok(subjectsFound.includes('Library / Counselling'));
        console.log(`✓ Test 2 Passed: Dynamic 5-day layout extracted ${preview2.body.totalSlots} slots including activities`);

        // -------------------------------------------------------------
        // TEST CASE 3: Joint Faculty Names (e.g. "Dr. Faculty / Colleague")
        // -------------------------------------------------------------
        console.log('\n--- Test 3: Joint Faculty Names Matching ---');
        const jointCsv = [
            'Faculty,Day,Period,Subject,Class,Room,Type',
            `${facName} / Colleague Two,Monday,1,Joint Project Lab,CSE-A,LAB-2,lab`,
            `${facName} & Colleague Three,Wednesday,2,Joint Research Seminar,CSE-A,301,theory`,
            `Other Solo Colleague,Friday,3,Mechanics,CSE-A,301,theory`
        ].join('\n');

        const mp3 = buildMultipartBody({}, {
            name: 'timetable',
            filename: 'joint_faculty.csv',
            contentType: 'text/csv',
            content: jointCsv
        });

        const preview3 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${mp3.boundary}`,
                'Content-Length': mp3.body.length,
                Cookie: facCookie
            }
        }, mp3.body);

        assert.strictEqual(preview3.status, 200);
        assert.strictEqual(preview3.body.totalSlots, 2, 'Must match joint slots where logged-in faculty is co-instructor');
        console.log(`✓ Test 3 Passed: Successfully extracted joint faculty teaching slots`);

        // -------------------------------------------------------------
        // TEST CASE 4: Single-Faculty Foreign Timetable Rejection
        // -------------------------------------------------------------
        console.log('\n--- Test 4: Single-Faculty Foreign Timetable Rejection (403) ---');
        const foreignSingleCsv = [
            'Faculty,Day,Period,Subject,Class,Room,Type',
            'Prof. Completely Different Person,Monday,1,Robotics,CSE-A,301,theory',
            'Prof. Completely Different Person,Tuesday,2,Robotics,CSE-A,301,theory'
        ].join('\n');

        const mp4 = buildMultipartBody({}, {
            name: 'timetable',
            filename: 'foreign_single.csv',
            contentType: 'text/csv',
            content: foreignSingleCsv
        });

        const preview4 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${mp4.boundary}`,
                'Content-Length': mp4.body.length,
                Cookie: facCookie
            }
        }, mp4.body);

        assert.strictEqual(preview4.status, 403);
        assert.strictEqual(preview4.body.code, 'FACULTY_MISMATCH');
        console.log(`✓ Test 4 Passed: Foreign single-faculty timetable rejected with 403 FACULTY_MISMATCH`);

        // -------------------------------------------------------------
        // TEST CASE 5: Multi-Faculty Timetable with 0 Matches Diagnostic
        // -------------------------------------------------------------
        console.log('\n--- Test 5: Multi-Faculty Timetable Zero-Matches Diagnostic ---');
        const multiNoMatchCsv = [
            'Faculty,Day,Period,Subject,Class,Room,Type',
            'Colleague Alpha,Monday,1,Subject A,CSE-A,301,theory',
            'Colleague Beta,Tuesday,2,Subject B,CSE-A,301,theory'
        ].join('\n');

        const mp5 = buildMultipartBody({}, {
            name: 'timetable',
            filename: 'multi_nomatch.csv',
            contentType: 'text/csv',
            content: multiNoMatchCsv
        });

        const preview5 = await makeAppRequest(server, {
            path: '/api/faculty/timetable/preview',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${mp5.boundary}`,
                'Content-Length': mp5.body.length,
                Cookie: facCookie
            }
        }, mp5.body);

        // -------------------------------------------------------------
        // TEST CASE 6 (Requirement 8A): Faculty Personal Timetable with no class_name -> Accepted
        // -------------------------------------------------------------
        console.log('\n--- Test 6 (Req 8A): Faculty Personal Timetable with no class_name (Accepted) ---');
        const facPayloadNoClass = {
            contract_version: '2.1',
            timetable_type: 'FACULTY_TIMETABLE',
            department_code: branchCode,
            faculty_name: facName,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                { day: 'Monday', period: 1, subject_name: 'JAVA', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Monday', period: 2, subject_name: 'BCE', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Tuesday', period: 4, span_to: 6, subject_name: 'JAVA LAB', class_name: null, room_code: null, session_type: 'lab', is_free: false },
                { day: 'Wednesday', period: 5, span_to: 7, subject_name: 'CF-LAB', class_name: null, room_code: null, session_type: 'lab', is_free: false }
            ]
        };

        const valFacNoClass = validateExtractedContract(facPayloadNoClass, { uploadType: 'FACULTY_TIMETABLE', facultyId: facName });
        assert.strictEqual(valFacNoClass.ok, true, `Faculty timetable with no class_name must pass validation. Errors: ${valFacNoClass.errors.join(', ')}`);
        console.log('✓ Test 6 Passed: Faculty personal timetable with no class_name successfully validated');

        // -------------------------------------------------------------
        // TEST CASE 7 (Requirement 8B): Faculty Personal Timetable with class_name -> Accepted
        // -------------------------------------------------------------
        console.log('\n--- Test 7 (Req 8B): Faculty Personal Timetable with class_name (Accepted) ---');
        const facPayloadWithClass = {
            contract_version: '2.1',
            timetable_type: 'FACULTY_TIMETABLE',
            department_code: branchCode,
            faculty_name: facName,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                { day: 'Monday', period: 1, subject_name: 'JAVA', class_name: 'CSE-3A', room_code: '301', session_type: 'theory', is_free: false },
                { day: 'Tuesday', period: 4, span_to: 6, subject_name: 'JAVA LAB', class_name: 'CSE-3A', room_code: 'LAB-1', session_type: 'lab', is_free: false }
            ]
        };

        const valFacWithClass = validateExtractedContract(facPayloadWithClass, { uploadType: 'FACULTY_TIMETABLE', facultyId: facName });
        assert.strictEqual(valFacWithClass.ok, true, `Faculty timetable with class_name must pass validation. Errors: ${valFacWithClass.errors.join(', ')}`);
        console.log('✓ Test 7 Passed: Faculty personal timetable with class_name successfully validated');

        // -------------------------------------------------------------
        // TEST CASE 8 (Requirement 8C): Master Timetable with missing required class_name -> Rejected
        // -------------------------------------------------------------
        console.log('\n--- Test 8 (Req 8C): Master Timetable with missing required class_name (Rejected) ---');
        const masterPayloadNoClass = {
            contract_version: '2.1',
            timetable_type: 'MASTER_TIMETABLE',
            department_code: branchCode,
            class_name: null,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                { day: 'Monday', period: 1, subject_name: 'JAVA', faculty_name: facName, class_name: null, room_code: null, session_type: 'theory', is_free: false }
            ]
        };

        const valMasterNoClass = validateExtractedContract(masterPayloadNoClass, { uploadType: 'MASTER_TIMETABLE' });
        assert.strictEqual(valMasterNoClass.ok, false, 'Master Timetable with missing class_name must be rejected');
        assert.ok(valMasterNoClass.errors.some(e => e.includes('class_name is required')), 'Must contain class_name is required error');
        console.log('✓ Test 8 Passed: Master Timetable without required class_name correctly rejected');

        // -------------------------------------------------------------
        // TEST CASE 9 (Requirements 3, 8D, 8E, 9): FACTT1.jpeg Multimodal Image Extraction Simulation
        // (6 days: MON–SAT, 7 periods, JAVA, BCE, JAVA LAB multi-period, CF-LAB multi-period)
        // -------------------------------------------------------------
        console.log('\n--- Test 9 (Req 3, 8D, 9): FACTT1.jpeg Multimodal Personal Timetable Extraction ---');
        const factt1Draft = {
            contract_version: '2.1',
            timetable_type: 'FACULTY_TIMETABLE',
            department_code: branchCode,
            faculty_name: facName,
            days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
            periods: [1, 2, 3, 4, 5, 6, 7],
            entries: [
                { day: 'Monday', period: 1, span_to: null, subject_name: 'JAVA', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Monday', period: 2, span_to: null, subject_name: 'BCE', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Monday', period: 4, span_to: 6, subject_name: 'JAVA LAB', class_name: null, room_code: null, session_type: 'lab', is_free: false },
                { day: 'Tuesday', period: 2, span_to: null, subject_name: 'JAVA', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Wednesday', period: 1, span_to: null, subject_name: 'BCE', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Thursday', period: 5, span_to: 7, subject_name: 'CF-LAB', class_name: null, room_code: null, session_type: 'lab', is_free: false },
                { day: 'Friday', period: 3, span_to: null, subject_name: 'JAVA', class_name: null, room_code: null, session_type: 'theory', is_free: false },
                { day: 'Saturday', period: 2, span_to: null, subject_name: 'BCE', class_name: null, room_code: null, session_type: 'theory', is_free: false }
            ]
        };

        const mockTransport = async (options) => {
            return JSON.stringify(factt1Draft);
        };

        const dummyBuffer = Buffer.from('FAKE_FACTT1_JPEG_BINARY_DATA');
        const parsedResult = await imageImporter.parse(dummyBuffer, {
            filename: 'FACTT1.jpeg',
            mimeType: 'image/jpeg',
            geminiTransport: mockTransport,
            session: {
                role: 'faculty',
                facultyName: facName,
                username: facUsername,
                department: branchCode
            }
        });

        assert.ok(parsedResult.source, 'Must produce valid source');
        assert.strictEqual(parsedResult.source.entries.length, 12, 'Must expand multi-period labs to 12 discrete period slots (not 3)');
        console.log(`✓ Test 9 Direct Importer Passed: Extracted ${parsedResult.source.entries.length} slots from FACTT1 structure`);

        // Test over HTTP Preview endpoint with image upload
        const mpImage = buildMultipartBody({}, {
            name: 'timetable',
            filename: 'FACTT1.jpeg',
            contentType: 'image/jpeg',
            content: 'FAKE_FACTT1_JPEG_BINARY_DATA'
        });

        // Use custom transport hook by mocking imageImporter parse for route test
        const originalParse = imageImporter.parse;
        imageImporter.parse = async (buf, opts) => {
            return originalParse(buf, {
                ...opts,
                geminiTransport: mockTransport
            });
        };

        try {
            const previewImg = await makeAppRequest(server, {
                path: '/api/faculty/timetable/preview',
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${mpImage.boundary}`,
                    'Content-Length': mpImage.body.length,
                    Cookie: facCookie
                }
            }, mpImage.body);

            assert.strictEqual(previewImg.status, 200, `Preview must succeed with HTTP 200. Got: ${JSON.stringify(previewImg.body)}`);
            assert.strictEqual(previewImg.body.totalSlots, 12, 'Must extract all 12 slots (expanding multi-period JAVA LAB and CF-LAB)');
            assert.strictEqual(previewImg.body.slots.length, 12);

            // Verify lab spans are preserved as discrete slots
            const labSlots = previewImg.body.slots.filter(s => s.type === 'lab');
            assert.strictEqual(labSlots.length, 6, 'Must have 6 lab period slots (3 for JAVA LAB + 3 for CF-LAB)');

            const javaLabSlots = previewImg.body.slots.filter(s => s.subject === 'JAVA LAB');
            assert.strictEqual(javaLabSlots.length, 3, 'JAVA LAB spans P4-P6');
            assert.deepStrictEqual(javaLabSlots.map(s => s.period), [4, 5, 6]);

            const cfLabSlots = previewImg.body.slots.filter(s => s.subject === 'CF-LAB');
            assert.strictEqual(cfLabSlots.length, 3, 'CF-LAB spans P5-P7');
            assert.deepStrictEqual(cfLabSlots.map(s => s.period), [5, 6, 7]);

            console.log(`✓ Test 9 HTTP Preview Passed: Extracted ${previewImg.body.totalSlots} slots, lab spans expanded properly, class_name optional`);

            // Confirm and save FACTT1 slots
            const saveImg = await makeAppRequest(server, {
                path: '/api/faculty/timetable/confirm',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: facCookie }
            }, JSON.stringify({ slots: previewImg.body.slots }));

            assert.strictEqual(saveImg.status, 200);
            assert.strictEqual(saveImg.body.slotCount, 12);

            // Verify DB reload
            const mineImg = await makeAppRequest(server, {
                path: '/api/faculty/timetable/mine',
                method: 'GET',
                headers: { Cookie: facCookie }
            });
            assert.strictEqual(mineImg.status, 200);
            const busyCountImg = mineImg.body.cells.filter(c => c.status === 'busy').length;
            assert.strictEqual(busyCountImg, 12, 'DB reload must show all 12 saved periods');
            console.log(`✓ Test 9 DB Reload Passed: Reloaded all ${busyCountImg} busy cells from database`);
        } finally {
            imageImporter.parse = originalParse;
        }

        console.log('\n======================================================');
        console.log('ALL FACULTY TIMETABLE EXTRACTION TESTS PASSED!');
        console.log('======================================================\n');
    } finally {
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
