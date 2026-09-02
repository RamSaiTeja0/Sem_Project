/**
 * Day parsing and document extraction tests.
 *
 * The centrepiece is the Saturday regression: Saturday is a working day for
 * this project, and a timetable row naming it must never produce INVALID_DAY.
 * The bug was that DAY_ALIASES knew Saturday while the default allow-list
 * stopped at Friday, so the alias resolved and was then rejected.
 *
 * Usage: node tests/dayparsing.test.js
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { check, checkAsync, counts, request, upload, waitForServer } = require('./helpers');

const {
    normalizeDayName, describeDayError, WORKING_DAYS, parseSlotHeader, isFreeToken
} = require('../src/core/normalizer');
const importer = require('../src/importers');
const documentImporter = require('../src/importers/documentImporter');
const { createProvider } = require('../src/importers/providers/pdfcoProvider');

const PORT = process.env.TEST_PORT || 3396;
const BASE = `http://localhost:${PORT}`;

// ------------------------------------------------------ day normalization
function dayTests() {
    console.log('\n[1] Centralized day normalization');

    check('the working week includes Saturday', () => {
        assert.deepStrictEqual(WORKING_DAYS,
            ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
    });

    const cases = [
        ['Monday', 'Monday'], ['MONDAY', 'Monday'], ['monday', 'Monday'], ['Mon', 'Monday'],
        ['Tuesday', 'Tuesday'], ['Tue', 'Tuesday'], ['TUES', 'Tuesday'],
        ['Wednesday', 'Wednesday'], ['Wed', 'Wednesday'], ['WEDS', 'Wednesday'],
        ['Thursday', 'Thursday'], ['Thu', 'Thursday'], ['THURS', 'Thursday'],
        ['Friday', 'Friday'], ['Fri', 'Friday'], ['FRIDAY', 'Friday'],
        ['Saturday', 'Saturday'], ['SATURDAY', 'Saturday'], ['saturday', 'Saturday'],
        ['Sat', 'Saturday'], ['sat', 'Saturday'], ['SAT', 'Saturday'],
        [' Saturday ', 'Saturday'], ['  Sat  ', 'Saturday'], ['\tSATURDAY\n', 'Saturday']
    ];
    cases.forEach(([input, expected]) => {
        check(`${JSON.stringify(input)} -> ${expected}`, () => {
            assert.strictEqual(normalizeDayName(input), expected);
        });
    });

    check('unknown days stay unknown and are never guessed into a real day', () => {
        ['Someday', 'Funday', 'Sunnyday', 'Satur', 'S', 'xyz', '', '   ', null, undefined]
            .forEach(bad => assert.strictEqual(normalizeDayName(bad), null,
                `${JSON.stringify(bad)} must not resolve`));
    });

    check('the error message names the value and what was expected', () => {
        const message = describeDayError('Someday');
        assert.match(message, /"Someday"/);
        WORKING_DAYS.forEach(day => assert.ok(message.includes(day), day + ' must be listed'));
    });

    check('slot headers parse Saturday columns', () => {
        assert.deepStrictEqual(parseSlotHeader('Saturday P3'), { day: 'Saturday', period: 3 });
        assert.deepStrictEqual(parseSlotHeader('SAT P1'), { day: 'Saturday', period: 1 });
        assert.deepStrictEqual(parseSlotHeader('Sat-P2'), { day: 'Saturday', period: 2 });
        assert.strictEqual(parseSlotHeader('Someday P1'), null);
    });

    check('FREE, blank and dash cells all mean "not teaching"', () => {
        ['FREE', 'free', '-', '--', '', '   ', 'NIL', 'N/A', null]
            .forEach(token => assert.strictEqual(isFreeToken(token), true, JSON.stringify(token)));
        assert.strictEqual(isFreeToken('DBMS'), false);
    });
}

// ------------------------------------------------------------ import paths
const LONG_FORM_CSV =
    'Faculty,Day,Period,Subject,Class,Room\n' +
    'Dr. A Rao,Monday,1,DBMS,CSE-A,101\n' +
    'Dr. A Rao,Saturday,2,OS,CSE-A,101\n' +
    'Dr. B Iyer,SATURDAY,3,CN,CSE-A,102\n' +
    'Dr. C Menon, sat ,4,Java,CSE-A,103\n' +
    'Dr. D Varma,Sat,5,Python,CSE-A,104\n';

const MATRIX_CSV =
    'Faculty,Monday P1,Saturday P1,Saturday P2,Saturday P3\n' +
    'Dr. A Rao,DBMS,OS,FREE,-\n' +
    'Dr. B Iyer,FREE,CN,Java,\n';

async function importTests() {
    console.log('\n[2] Import pipelines');

    await checkAsync('REGRESSION: Saturday rows never produce INVALID_DAY', async () => {
        const result = await importer.preview(Buffer.from(LONG_FORM_CSV), 'tt.csv');
        const dayErrors = result.report.errors.filter(e => e.code === 'INVALID_DAY');
        assert.deepStrictEqual(dayErrors, [], 'no INVALID_DAY for any Saturday spelling');
        assert.strictEqual(result.report.ok, true);
        assert.ok(result.meta.days.includes('Saturday'), 'Saturday must reach the timetable');
    });

    await checkAsync('every valid long-form row is kept', async () => {
        const result = await importer.preview(Buffer.from(LONG_FORM_CSV), 'tt.csv');
        assert.strictEqual(result.report.summary.busySlots, 5, 'all five rows parsed');
        assert.strictEqual(result.layout, 'long');
    });

    await checkAsync('one bad row does not discard the good rows', async () => {
        const mixed = LONG_FORM_CSV + 'Dr. E Bose,Someday,6,AI,CSE-A,105\n';
        const result = await importer.preview(Buffer.from(mixed), 'tt.csv');
        const dayErrors = result.report.errors.filter(e => e.code === 'INVALID_DAY');
        assert.strictEqual(dayErrors.length, 1, 'only the genuinely invalid row errors');
        assert.match(dayErrors[0].message, /Someday/);
        assert.strictEqual(dayErrors[0].context.field, 'day');
        assert.deepStrictEqual(dayErrors[0].context.expected, WORKING_DAYS);
        assert.strictEqual(result.report.summary.busySlots, 5, 'the five valid rows survive');
    });

    await checkAsync('matrix layout handles Saturday columns, FREE and blank cells', async () => {
        const result = await importer.preview(Buffer.from(MATRIX_CSV), 'tt.csv');
        assert.strictEqual(result.layout, 'matrix');
        assert.deepStrictEqual(result.report.errors, []);
        // Rao: DBMS + OS. Iyer: CN + Java. FREE / - / blank contribute nothing.
        assert.strictEqual(result.report.summary.busySlots, 4);
        assert.ok(result.meta.days.includes('Saturday'));
    });

    await checkAsync('Excel import takes the same path and accepts Saturday', async () => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('TT');
        sheet.addRow(['Faculty', 'Day', 'Period', 'Subject', 'Class', 'Room']);
        sheet.addRow(['Dr. A Rao', 'Saturday', 1, 'DBMS', 'CSE-A', '101']);
        sheet.addRow(['Dr. B Iyer', 'SAT', 2, 'OS', 'CSE-A', '102']);
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

        const result = await importer.preview(buffer, 'tt.xlsx');
        assert.strictEqual(result.format, 'excel');
        assert.deepStrictEqual(result.report.errors.filter(e => e.code === 'INVALID_DAY'), []);
        assert.strictEqual(result.report.summary.busySlots, 2);
    });

    await checkAsync('the branch is not hardcoded — any class code flows through', async () => {
        const csv = 'Faculty,Day,Period,Subject,Class\nDr. Z,Saturday,1,Machine Learning,AIDS-A\n';
        const result = await importer.preview(Buffer.from(csv), 'tt.csv');
        assert.deepStrictEqual(result.report.errors, []);
        const cell = result.preview[0].slots.find(s => s.day === 'Saturday' && s.period === 1);
        assert.strictEqual(cell.className, 'AIDS-A');
        assert.strictEqual(cell.subject, 'Machine Learning');
    });
}

// ------------------------------------------------- document extraction
function providerTests() {
    console.log('\n[3] PDF.co document extraction provider');

    check('with no API key, extraction reports it is not configured', () => {
        const status = documentImporter.status();
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.configuredVia, 'PDFCO_API_KEY');
        assert.match(status.message, /Add PDFCO_API_KEY/);
        assert.match(status.message, /no extraction has been attempted/i);
    });

    check('an unconfigured provider refuses rather than inventing a timetable', () => {
        const provider = createProvider({ apiKey: null });
        assert.strictEqual(provider.configured, false);
        return provider.extract(Buffer.from('x'), 'application/pdf', { filename: 'a.pdf' })
            .then(() => { throw new Error('should have refused'); },
                  err => {
                      assert.strictEqual(err.code, 'EXTRACTION_NOT_CONFIGURED');
                      assert.match(err.message, /PDFCO_API_KEY/);
                  });
    });

    check('a configured provider reports as available', () => {
        const provider = createProvider({ apiKey: 'test-key' });
        assert.strictEqual(provider.configured, true);
        assert.strictEqual(provider.name, 'pdf.co');
    });

    check('unsupported file types are refused before any upload', async () => {
        let called = false;
        const provider = createProvider({
            apiKey: 'test-key',
            transport: async () => { called = true; return { ok: true, status: 200, body: {} }; }
        });
        await assert.rejects(
            () => provider.extract(Buffer.from('x'), null, { filename: 'notes.txt' }),
            err => { assert.strictEqual(err.code, 'PDFCO_UNSUPPORTED_TYPE'); return true; });
        assert.strictEqual(called, false, 'nothing should be uploaded for an unsupported type');
    });
}

/**
 * The provider's request/response handling, driven by a stub transport.
 *
 * This proves the adapter builds the right calls and routes the returned table
 * into the shared pipeline. It does NOT prove PDF.co itself works — that needs
 * a real PDFCO_API_KEY and is reported separately.
 */
async function providerPipelineTests() {
    console.log('\n[4] Extracted tables enter the normal validation pipeline');

    const EXTRACTED_CSV =
        'Faculty,Day,Period,Subject,Class,Room\n' +
        'Dr. P Kumar,Monday,1,DBMS,ECE-A,201\n' +
        'Dr. P Kumar,Saturday,2,Signals,ECE-A,201\n' +
        'Dr. Q Sharma,SAT,3,Networks,ECE-A,202\n';

    function stubTransport(calls) {
        return async (url, options) => {
            calls.push({ url, method: options.method });
            if (url.includes('/file/upload/get-presigned-url')) {
                return { ok: true, status: 200, body: {
                    presignedUrl: 'https://upload.example/put', url: 'https://files.example/in.pdf' } };
            }
            if (url === 'https://upload.example/put') return { ok: true, status: 200, body: null };
            if (url.includes('/pdf/convert/from/image')) {
                return { ok: true, status: 200, body: { url: 'https://files.example/converted.pdf' } };
            }
            if (url.includes('/pdf/convert/to/csv')) {
                return { ok: true, status: 200, body: { body: EXTRACTED_CSV } };
            }
            return { ok: false, status: 404, body: null };
        };
    }

    await checkAsync('a PDF is uploaded, converted to a table, and validated', async () => {
        const calls = [];
        documentImporter.setProvider(createProvider({ apiKey: 'test-key', transport: stubTransport(calls) }));
        try {
            const result = await importer.preview(Buffer.from('%PDF-1.4 fake bytes'), 'cse.pdf');
            assert.strictEqual(result.format, 'document');
            assert.strictEqual(result.provider, 'pdf.co');
            assert.deepStrictEqual(result.report.errors, [], 'the extracted table must validate');
            assert.strictEqual(result.report.summary.busySlots, 3);
            assert.ok(result.meta.days.includes('Saturday'), 'Saturday survives extraction');
            // The values come from the extracted table, not from anywhere else.
            assert.ok(result.faculty.some(f => f.name === 'Dr. P Kumar'));
            assert.ok(calls.some(c => c.url.includes('/pdf/convert/to/csv')));
            assert.ok(!calls.some(c => c.url.includes('/convert/from/image')), 'a PDF needs no image step');
        } finally {
            documentImporter.setProvider(null);
        }
    });

    await checkAsync('an image is converted to PDF first, then extracted and validated', async () => {
        const calls = [];
        documentImporter.setProvider(createProvider({ apiKey: 'test-key', transport: stubTransport(calls) }));
        try {
            const result = await importer.preview(Buffer.from('\x89PNG fake'), 'ece.png');
            assert.strictEqual(result.format, 'document');
            assert.strictEqual(result.convertedFromImage, true);
            assert.deepStrictEqual(result.report.errors, []);
            assert.strictEqual(result.report.summary.busySlots, 3);
            assert.ok(calls.some(c => c.url.includes('/pdf/convert/from/image')), 'image step required');
        } finally {
            documentImporter.setProvider(null);
        }
    });

    await checkAsync('an empty extraction result is reported, never passed off as success', async () => {
        documentImporter.setProvider(createProvider({
            apiKey: 'test-key',
            transport: async url => {
                if (url.includes('get-presigned-url')) {
                    return { ok: true, status: 200, body: {
                        presignedUrl: 'https://upload.example/put', url: 'https://files.example/in.pdf' } };
                }
                if (url === 'https://upload.example/put') return { ok: true, status: 200, body: null };
                return { ok: true, status: 200, body: { body: '   ' } };
            }
        }));
        try {
            await assert.rejects(
                () => importer.preview(Buffer.from('%PDF'), 'empty.pdf'),
                err => { assert.strictEqual(err.code, 'PDFCO_EMPTY_RESULT'); return true; });
        } finally {
            documentImporter.setProvider(null);
        }
    });

    await checkAsync('an API error surfaces PDF.co\'s own message', async () => {
        documentImporter.setProvider(createProvider({
            apiKey: 'test-key',
            transport: async () => ({ ok: true, status: 200,
                body: { error: true, message: 'Invalid API key' } })
        }));
        try {
            await assert.rejects(
                () => importer.preview(Buffer.from('%PDF'), 'bad.pdf'),
                /Invalid API key/);
        } finally {
            documentImporter.setProvider(null);
        }
    });
}

// --------------------------------------------------------------- over HTTP
async function httpTests() {
    console.log('\n[5] Over HTTP');

    const status = await request(BASE, 'GET', '/api/timetable/import/document-status');
    check('GET /document-status names PDFCO_API_KEY as the switch', () => {
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.configuredVia, 'PDFCO_API_KEY');
        assert.strictEqual(typeof status.body.available, 'boolean');
        assert.ok(status.body.alternatives.includes('Manual Timetable Entry'));
        assert.ok(!JSON.stringify(status.body).toLowerCase().includes('api_key='),
            'no key material may appear in the response');
    });

    const saturday = await upload(BASE, '/api/timetable/import/preview', 'sat.csv',
        Buffer.from(LONG_FORM_CSV));
    check('uploading a Saturday timetable reports zero errors', () => {
        assert.strictEqual(saturday.status, 200);
        assert.strictEqual(saturday.body.report.ok, true);
        assert.deepStrictEqual(
            saturday.body.report.errors.filter(e => e.code === 'INVALID_DAY'), []);
        assert.strictEqual(saturday.body.report.summary.busySlots, 5);
    });

    const pdf = await upload(BASE, '/api/timetable/import/preview', 'tt.pdf', Buffer.from('%PDF-1.4'));
    check('a PDF upload with no key returns 501 and points at the alternatives', () => {
        assert.strictEqual(pdf.status, 501);
        assert.strictEqual(pdf.body.code, 'EXTRACTION_NOT_CONFIGURED');
        assert.match(pdf.body.error, /PDFCO_API_KEY/);
        assert.ok(pdf.body.alternatives.length >= 3);
    });

    const badClass = await upload(BASE, '/api/timetable/import/preview', 'tt.csv',
        Buffer.from(LONG_FORM_CSV), { defaultClass: 'ece' });
    check('a branch code typed as a class is refused with the real class list', () => {
        assert.strictEqual(badClass.status, 400);
        assert.ok(['AMBIGUOUS_CLASS', 'UNKNOWN_CLASS'].includes(badClass.body.code));
        assert.ok(Array.isArray(badClass.body.choices) && badClass.body.choices.length > 0);
    });

    const casing = await upload(BASE, '/api/timetable/import/preview', 'tt.csv',
        Buffer.from(LONG_FORM_CSV), { defaultClass: 'cse-a' });
    check('a class typed in the wrong case is accepted and corrected', () => {
        assert.strictEqual(casing.status, 200);
    });
}

async function main() {
    console.log('TecSubstitution — day parsing and document extraction tests');
    dayTests();
    await importTests();
    providerTests();
    await providerPipelineTests();

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), PDFCO_API_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    server.stdout.on('data', d => log += d);
    server.stderr.on('data', d => log += d);

    try {
        await waitForServer(BASE);
        await httpTests();
    } catch (err) {
        console.error('\nServer output:\n' + log);
        throw err;
    } finally {
        server.kill();
    }

    const { passed } = counts();
    console.log(`\n✅ day parsing & extraction: ${passed} checks passed.`);
}

main().catch(err => {
    console.error('\n✗ FAILED:', err.message);
    process.exit(1);
});
