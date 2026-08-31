/**
 * API tests — every documented endpoint, including Excel and CSV import.
 * Usage: node tests/api.test.js
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { check, checkAsync, counts, request, upload, waitForServer } = require('./helpers');

const PORT = process.env.TEST_PORT || 3391;
const BASE = `http://localhost:${PORT}`;

const get = (p) => request(BASE, 'GET', p);
const post = (p, b) => request(BASE, 'POST', p, b);

const CSV_MATRIX =
    'Faculty,Department,Monday P1,Monday P2,Monday P3,Tuesday P1,Tuesday P2\n' +
    'Dr. Alpha,CSE,DBMS,FREE,OS,CN,FREE\n' +
    'Dr. Beta,CSE,FREE,Java,FREE,DBMS,OS\n' +
    'Dr. Gamma,ECE,CN,FREE,Java,FREE,DSA\n';

async function buildWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Timetable');
    sheet.addRow(['Faculty', 'Department', 'Monday P1', 'Monday P2', 'Tuesday P1']);
    sheet.addRow(['Dr. Excel One', 'CSE', 'DBMS', 'FREE', 'OS']);
    sheet.addRow(['Dr. Excel Two', 'CSE', 'FREE', 'Java', 'FREE']);
    sheet.addRow(['Dr. Excel Three', 'ECE', 'CN', 'FREE', 'DSA']);
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function run() {
    console.log('TecSubstitution — API tests');
    console.log('\n[1] Timetable and faculty endpoints');

    const health = await get('/api/health');
    check('GET /api/health reports the service', () => {
        assert.strictEqual(health.status, 200);
        assert.strictEqual(health.body.status, 'ok');
        assert.strictEqual(health.body.service, 'tecsubstitution');
    });

    const meta = await get('/api/timetable/meta');
    check('GET /api/timetable/meta returns days, periods and classes', () => {
        assert.strictEqual(meta.status, 200);
        assert.deepStrictEqual(meta.body.days, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
        assert.deepStrictEqual(meta.body.periods, [1, 2, 3, 4, 5, 6, 7]);
        assert.strictEqual(meta.body.primaryClass, 'CSE-A');
        assert.strictEqual(meta.body.facultyCount, 10);
    });

    const grid = await get('/api/timetable');
    check('GET /api/timetable returns the primary class grid', () => {
        assert.strictEqual(grid.status, 200);
        assert.strictEqual(grid.body.name, 'CSE-A');
        assert.strictEqual(grid.body.cells.length, 35);
        const cell = grid.body.cells.find(c => c.day === 'Monday' && c.period === 2);
        assert.strictEqual(cell.subject, 'OS');
        assert.strictEqual(cell.faculty, 'Dr. Meera Nair');
    });

    check('every grid cell carries the metadata a click needs', () => {
        grid.body.cells.forEach(cell => {
            ['day', 'period', 'subject', 'faculty', 'className', 'status'].forEach(key => {
                assert.ok(key in cell, `cell is missing ${key}`);
            });
        });
        assert.strictEqual(new Set(grid.body.cells.map(c => `${c.day}|${c.period}`)).size, 35);
    });

    const otherClass = await get('/api/timetable?class=CSE-B');
    const facultyGrid = await get('/api/timetable?faculty=' + encodeURIComponent('Dr. Anand Rao'));
    check('the grid can be viewed by class or by faculty', () => {
        assert.strictEqual(otherClass.body.name, 'CSE-B');
        assert.strictEqual(facultyGrid.body.view, 'faculty');
        assert.strictEqual(facultyGrid.body.cells.filter(c => c.status === 'busy').length, 6);
    });

    const missingClass = await get('/api/timetable?class=NOPE');
    check('an unknown class returns 404 JSON', () => {
        assert.strictEqual(missingClass.status, 404);
        assert.strictEqual(missingClass.body.code, 'NOT_FOUND');
    });

    const faculty = await get('/api/faculty');
    check('GET /api/faculty returns the roster with free/busy counts', () => {
        assert.strictEqual(faculty.status, 200);
        assert.strictEqual(faculty.body.count, 10);
        faculty.body.faculty.forEach(f => {
            assert.strictEqual(f.busyPeriods + f.freePeriods, f.totalPeriods);
            assert.ok(f.id && f.name && f.department);
        });
    });

    const filtered = await get('/api/faculty?department=ECE');
    const searched = await get('/api/faculty?search=kiran');
    check('faculty filters by department and by name', () => {
        assert.strictEqual(filtered.body.count, 3);
        filtered.body.faculty.forEach(f => assert.strictEqual(f.department, 'ECE'));
        assert.strictEqual(searched.body.count, 1);
        assert.strictEqual(searched.body.faculty[0].name, 'Prof. Kiran Kumar');
    });

    const records = await get('/api/timetable/records?day=Monday&period=2&status=busy');
    check('GET /api/timetable/records filters normalized records', () => {
        assert.strictEqual(records.status, 200);
        assert.strictEqual(records.body.count, 2);
        records.body.records.forEach(r => {
            assert.strictEqual(r.day, 'Monday');
            assert.strictEqual(r.period, 2);
            assert.strictEqual(r.status, 'busy');
        });
    });

    console.log('\n[2] Availability endpoint');

    const availability = await post('/api/availability', { day: 'Monday', period: 2, subject: 'OS' });
    check('[test 10] POST /api/availability returns the documented shape', () => {
        assert.strictEqual(availability.status, 200);
        assert.strictEqual(availability.body.day, 'Monday');
        assert.strictEqual(availability.body.period, 2);
        assert.strictEqual(availability.body.subject, 'OS');
        assert.strictEqual(availability.body.totalAvailable, 8);
        assert.ok(Array.isArray(availability.body.availableFaculty));
        assert.strictEqual(availability.body.readOnly, true);
    });

    check('busy faculty never appear in availableFaculty', () => {
        const busy = availability.body.busy.map(b => b.faculty);
        assert.deepStrictEqual(busy.sort(), ['Dr. Meera Nair', 'Prof. Naveen Reddy']);
        busy.forEach(name => assert.ok(!availability.body.availableFaculty.includes(name)));
    });

    const viaGet = await get('/api/availability?day=mon&period=P2');
    check('the same query works over GET with abbreviated inputs', () => {
        assert.strictEqual(viaGet.status, 200);
        assert.deepStrictEqual(viaGet.body.availableFaculty.sort(),
            availability.body.availableFaculty.slice().sort());
    });

    const badDay = await post('/api/availability', { day: 'Funday', period: 2 });
    const badPeriod = await post('/api/availability', { day: 'Monday', period: 99 });
    const noInput = await post('/api/availability', {});
    check('invalid day/period return 400 with a clear code', () => {
        assert.strictEqual(badDay.status, 400);
        assert.strictEqual(badDay.body.code, 'INVALID_DAY');
        assert.strictEqual(badPeriod.status, 400);
        assert.strictEqual(badPeriod.body.code, 'INVALID_PERIOD');
        assert.strictEqual(noInput.status, 400);
    });

    const summary = await get('/api/availability/summary?day=Monday&period=2');
    check('GET /api/availability/summary reports totals for a slot', () => {
        assert.strictEqual(summary.status, 200);
        assert.strictEqual(summary.body.totalFaculty, 10);
        assert.strictEqual(summary.body.selected.available, 8);
        assert.strictEqual(summary.body.selected.busy, 2);
        assert.strictEqual(summary.body.slots.length, 35);
    });

    const unknown = await get('/api/availability/does-not-exist');
    const unknownApi = await get('/api/nope');
    check('unknown API paths return JSON 404, not the dashboard HTML', () => {
        assert.strictEqual(unknown.status, 404);
        assert.strictEqual(unknownApi.status, 404);
        assert.ok(unknownApi.body && unknownApi.body.code === 'NOT_FOUND');
    });

    console.log('\n[3] Import');

    const formats = await get('/api/timetable/import/formats');
    check('GET /api/timetable/import/formats documents the layouts', () => {
        assert.strictEqual(formats.status, 200);
        assert.deepStrictEqual(formats.body.supported, ['.xlsx', '.csv']);
        assert.strictEqual(formats.body.primary, '.xlsx');
    });

    const csvPreview = await upload(BASE, '/api/timetable/import/preview', 'tt.csv', Buffer.from(CSV_MATRIX));
    check('CSV preview parses the matrix layout without loading it', () => {
        assert.strictEqual(csvPreview.status, 200);
        assert.strictEqual(csvPreview.body.format, 'csv');
        assert.strictEqual(csvPreview.body.layout, 'matrix');
        assert.strictEqual(csvPreview.body.loaded, false);
        assert.strictEqual(csvPreview.body.report.ok, true);
        assert.strictEqual(csvPreview.body.faculty.length, 3);
        // 3 faculty x 3 taught slots each; the FREE cells become free slots.
        assert.strictEqual(csvPreview.body.report.summary.busySlots, 9);
        // The grid is 3 faculty x 2 days x 3 periods = 18 records, so 9 are free.
        assert.strictEqual(csvPreview.body.report.summary.freeSlots, 9);
        assert.strictEqual(csvPreview.body.report.summary.totalRecords, 18);
    });

    const stillDemo = await get('/api/timetable/meta');
    check('previewing did not change the loaded timetable', () => {
        assert.strictEqual(stillDemo.body.facultyCount, 10);
        assert.strictEqual(stillDemo.body.primaryClass, 'CSE-A');
    });

    const workbook = await buildWorkbook();
    const xlsxPreview = await upload(BASE, '/api/timetable/import/preview', 'tt.xlsx', workbook);
    check('[test 8] Excel preview produces the same normalized structure', () => {
        assert.strictEqual(xlsxPreview.status, 200);
        assert.strictEqual(xlsxPreview.body.format, 'excel');
        assert.strictEqual(xlsxPreview.body.layout, 'matrix');
        assert.strictEqual(xlsxPreview.body.report.ok, true);
        assert.strictEqual(xlsxPreview.body.faculty.length, 3);
        const one = xlsxPreview.body.preview.find(p => p.faculty === 'Dr. Excel One');
        const mondayP1 = one.slots.find(s => s.day === 'Monday' && s.period === 1);
        const mondayP2 = one.slots.find(s => s.day === 'Monday' && s.period === 2);
        assert.strictEqual(mondayP1.subject, 'DBMS');
        assert.strictEqual(mondayP1.status, 'busy');
        assert.strictEqual(mondayP2.status, 'free');
    });

    const badType = await upload(BASE, '/api/timetable/import/preview', 'notes.txt', Buffer.from('hello'));
    const badStructure = await upload(BASE, '/api/timetable/import/preview', 'bad.csv', Buffer.from('A,B\n1,2\n'));
    const notExcel = await upload(BASE, '/api/timetable/import/preview', 'fake.xlsx', Buffer.from('not a workbook'));
    check('unsupported types and broken structures are rejected clearly', () => {
        assert.strictEqual(badType.status, 400);
        assert.strictEqual(badType.body.code, 'UNSUPPORTED_FILE_TYPE');
        assert.strictEqual(badStructure.status, 400);
        assert.strictEqual(badStructure.body.code, 'BAD_STRUCTURE');
        assert.strictEqual(notExcel.status, 400);
        assert.strictEqual(notExcel.body.code, 'UNREADABLE_WORKBOOK');
    });

    const noFile = await post('/api/timetable/import/preview', {});
    check('an import with no file is rejected', () => {
        assert.strictEqual(noFile.status, 400);
        assert.strictEqual(noFile.body.code, 'NO_FILE');
    });

    const afterFailures = await get('/api/timetable/meta');
    check('failed imports leave the loaded timetable untouched', () => {
        assert.strictEqual(afterFailures.body.facultyCount, 10);
        assert.strictEqual(afterFailures.body.origin, 'demo-data');
    });

    console.log('\n[4] Read-only guarantee');

    const before = await get('/api/timetable');
    const beforeFaculty = await get('/api/faculty');
    for (const day of meta.body.days) {
        for (const period of meta.body.periods) {
            await post('/api/availability', { day, period });
        }
    }
    const after = await get('/api/timetable');
    const afterFaculty = await get('/api/faculty');
    check('35 availability calls changed no timetable or faculty data', () => {
        assert.deepStrictEqual(after.body, before.body);
        assert.deepStrictEqual(afterFaculty.body, beforeFaculty.body);
    });

    console.log('\n[5] Committing an import (runs last — it replaces the dataset)');

    const commit = await upload(BASE, '/api/timetable/import', 'tt.csv', Buffer.from(CSV_MATRIX),
        { defaultClass: 'IMPORTED-A' });
    check('POST /api/timetable/import loads the file', () => {
        assert.strictEqual(commit.status, 200);
        assert.strictEqual(commit.body.loaded, true);
    });

    const importedMeta = await get('/api/timetable/meta');
    const importedAvailability = await post('/api/availability', { day: 'Monday', period: 1 });
    check('availability now answers from the imported timetable', () => {
        assert.strictEqual(importedMeta.body.facultyCount, 3);
        assert.match(importedMeta.body.origin, /^import:/);
        // Monday P1: Alpha (DBMS) and Gamma (CN) teach; Beta is free.
        assert.deepStrictEqual(importedAvailability.body.availableFaculty, ['Dr. Beta']);
        assert.strictEqual(importedAvailability.body.totalBusy, 2);
    });

    const { passed } = counts();
    console.log(`\n✅ api: ${passed} checks passed.`);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', d => log += d);
server.stderr.on('data', d => log += d);

waitForServer(BASE)
    .then(run)
    .then(() => server.kill())
    .catch(err => {
        console.error('\n✗ FAILED:', err.message);
        if (log) console.error('\nServer output:\n' + log);
        server.kill();
        process.exit(1);
    });
