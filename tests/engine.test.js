/**
 * Engine tests — normalizer, validator and availability engine.
 * No server, no browser: the engine is pure and directly testable.
 *
 * Usage: node tests/engine.test.js
 */
const assert = require('assert');
const { check, counts } = require('./helpers');

const { normalize } = require('../src/core/normalizer');
const { validate } = require('../src/core/validator');
const { createEngine } = require('../src/core/availabilityEngine');
const demo = require('../src/data/demoTimetable');

function engineFor(source) {
    const normalized = normalize(source);
    const report = validate(normalized);
    assert.ok(report.ok, 'fixture must validate: ' + report.errors.map(e => e.message).join('; '));
    return createEngine(normalized);
}

const engine = engineFor(demo);
const names = list => list.slice().sort();

console.log('TecSubstitution — engine tests');
console.log('\n[1] Normalized data model');

check('demo data yields 10 faculty over 5 days x 7 periods', () => {
    const meta = engine.getMeta();
    assert.strictEqual(meta.facultyCount, 10);
    assert.strictEqual(meta.days.length, 5);
    assert.strictEqual(meta.periods.length, 7);
    assert.strictEqual(engine.getRecords().length, 10 * 5 * 7);
});

check('every record has the documented shape and a busy/free status', () => {
    engine.getRecords().forEach(r => {
        assert.ok(typeof r.faculty === 'string' && r.faculty.length > 0);
        assert.ok(typeof r.day === 'string');
        assert.ok(typeof r.period === 'number');
        assert.ok(r.status === 'busy' || r.status === 'free', `bad status ${r.status}`);
        if (r.status === 'free') {
            assert.strictEqual(r.subject, null);
            assert.strictEqual(r.className, null);
        } else {
            assert.ok(r.subject, 'a busy record must name a subject');
        }
    });
});

check('a multi-period lab marks every period it spans', () => {
    // CSE-A Wednesday P5-P7 is Dr. Anand Rao's DBMS Lab.
    [5, 6, 7].forEach(period => {
        const slot = engine.getSlot('Wednesday', period);
        const busy = slot.busy.filter(r => r.faculty === 'Dr. Anand Rao');
        assert.strictEqual(busy.length, 1, `Anand Rao must be busy Wednesday P${period}`);
        assert.strictEqual(busy[0].subject, 'DBMS Lab');
    });
});

console.log('\n[2] Availability');

check('[test 1] Monday P2 returns the correct free faculty', () => {
    const result = engine.getAvailability('Monday', 2);
    // Busy: Dr. Meera Nair (CSE-A OS), Prof. Naveen Reddy (CSE-B Java).
    assert.deepStrictEqual(names(result.busy.map(b => b.faculty)),
        names(['Dr. Meera Nair', 'Prof. Naveen Reddy']));
    assert.strictEqual(result.totalAvailable, 8);
    assert.strictEqual(result.totalBusy, 2);
    assert.deepStrictEqual(names(result.availableFaculty), names([
        'Dr. Anand Rao', 'Prof. Kiran Kumar', 'Prof. Priya Sharma', 'Dr. Suresh Babu',
        'Prof. Arun Prasad', 'Dr. Deepa Iyer', 'Dr. Latha Menon', 'Mr. Sai Kishore'
    ]));
});

check('[test 2] Tuesday P1 returns the correct free faculty', () => {
    const result = engine.getAvailability('Tuesday', 1);
    // Busy: Prof. Kiran Kumar (CSE-A CN), Prof. Naveen Reddy (CSE-B Java).
    assert.deepStrictEqual(names(result.busy.map(b => b.faculty)),
        names(['Prof. Kiran Kumar', 'Prof. Naveen Reddy']));
    assert.strictEqual(result.totalAvailable, 8);
    assert.ok(!result.availableFaculty.includes('Prof. Kiran Kumar'));
});

check('[test 3] busy faculty are excluded at every slot', () => {
    engine.getDays().forEach(day => {
        engine.getPeriods().forEach(period => {
            const slot = engine.getSlot(day, period);
            const free = new Set(engine.getAvailability(day, period).availableFaculty);
            slot.busy.forEach(record => {
                assert.ok(!free.has(record.faculty),
                    `${record.faculty} teaches ${record.subject} at ${day} P${period} but was listed free`);
            });
        });
    });
});

check('[test 4] free faculty are detected and free + busy covers the roster', () => {
    engine.getDays().forEach(day => {
        engine.getPeriods().forEach(period => {
            const result = engine.getAvailability(day, period);
            assert.strictEqual(result.totalAvailable + result.totalBusy, 10,
                `${day} P${period}: free + busy must equal the roster`);
            const overlap = result.availableFaculty
                .filter(name => result.busy.some(b => b.faculty === name));
            assert.strictEqual(overlap.length, 0);
        });
    });
});

check('the clicked cell faculty can be excluded explicitly', () => {
    const withMeera = engine.getAvailability('Monday', 3);
    assert.ok(withMeera.availableFaculty.includes('Dr. Meera Nair'));
    const without = engine.getAvailability('Monday', 3, { exclude: 'Dr. Meera Nair' });
    assert.ok(!without.availableFaculty.includes('Dr. Meera Nair'));
    assert.strictEqual(without.totalAvailable, withMeera.totalAvailable - 1);
});

check('department and search filters narrow the result', () => {
    const all = engine.getAvailability('Monday', 2);
    const ece = engine.getAvailability('Monday', 2, { department: 'ECE' });
    assert.ok(ece.totalAvailable < all.totalAvailable);
    ece.available.forEach(f => assert.strictEqual(f.department, 'ECE'));

    const search = engine.getAvailability('Monday', 2, { search: 'kiran' });
    assert.deepStrictEqual(search.availableFaculty, ['Prof. Kiran Kumar']);
});

console.log('\n[3] Invalid input and validation');

check('[test 5] an invalid day resolves to null and returns no slot', () => {
    assert.strictEqual(engine.normalizeDay('Funday'), null);
    assert.strictEqual(engine.normalizeDay('Sunday'), null, 'not in this timetable');
    assert.strictEqual(engine.getSlot('Funday', 1), null);
    assert.strictEqual(engine.getAvailability('Funday', 1), null);
    // Valid aliases still resolve.
    assert.strictEqual(engine.normalizeDay('mon'), 'Monday');
    assert.strictEqual(engine.normalizeDay('MONDAY'), 'Monday');
});

check('[test 6] an invalid period resolves to null and returns no slot', () => {
    assert.strictEqual(engine.normalizePeriod(99), null);
    assert.strictEqual(engine.normalizePeriod('lunch'), null);
    assert.strictEqual(engine.normalizePeriod(0), null);
    assert.strictEqual(engine.getAvailability('Monday', 99), null);
    assert.strictEqual(engine.normalizePeriod('P3'), 3);
    assert.strictEqual(engine.normalizePeriod('3'), 3);
});

check('[test 7] an empty timetable is rejected', () => {
    const normalized = normalize({
        meta: { days: ['Monday'], periods: [1] },
        faculty: [{ id: 'F1', name: 'A' }],
        entries: []
    });
    const report = validate(normalized);
    assert.strictEqual(report.ok, false);
    assert.ok(report.errors.some(e => e.code === 'EMPTY_TIMETABLE'));
});

check('a timetable with no faculty is rejected', () => {
    const report = validate(normalize({ meta: { days: ['Monday'], periods: [1] }, faculty: [], entries: [] }));
    assert.strictEqual(report.ok, false);
    assert.ok(report.errors.some(e => e.code === 'NO_FACULTY'));
});

check('[test 9] a duplicate faculty/day/period entry is rejected', () => {
    const report = validate(normalize({
        meta: { days: ['Monday'], periods: [1] },
        faculty: [{ id: 'F1', name: 'Dr. A' }],
        entries: [
            { faculty: 'Dr. A', day: 'Monday', period: 1, subject: 'DBMS' },
            { faculty: 'Dr. A', day: 'Monday', period: 1, subject: 'OS' }
        ]
    }));
    assert.strictEqual(report.ok, false);
    assert.ok(report.errors.some(e => e.code === 'DUPLICATE_ENTRY'), 'expected DUPLICATE_ENTRY');
});

check('a faculty double-booked across two classes is rejected', () => {
    const report = validate(normalize({
        meta: { days: ['Monday'], periods: [1] },
        faculty: [{ id: 'F1', name: 'Dr. A' }],
        classes: [
            { class: 'X', rows: { Monday: [{ period: 1, subject: 'DBMS', faculty: 'Dr. A' }] } },
            { class: 'Y', rows: { Monday: [{ period: 1, subject: 'OS', faculty: 'Dr. A' }] } }
        ]
    }));
    assert.strictEqual(report.ok, false);
    assert.ok(report.errors.some(e => e.code === 'DUPLICATE_ENTRY' || e.code === 'DOUBLE_BOOKING'));
});

check('an invalid day or period in the source is reported, not silently dropped', () => {
    const report = validate(normalize({
        meta: { days: ['Monday'], periods: [1, 2] },
        faculty: [{ id: 'F1', name: 'Dr. A' }],
        entries: [
            { faculty: 'Dr. A', day: 'Funday', period: 1, subject: 'DBMS' },
            { faculty: 'Dr. A', day: 'Monday', period: 9, subject: 'OS' }
        ]
    }));
    assert.ok(report.errors.some(e => e.code === 'INVALID_DAY'));
    assert.ok(report.errors.some(e => e.code === 'INVALID_PERIOD'));
});

check('a faculty named only in the timetable is added with a warning, never dropped', () => {
    const normalized = normalize({
        meta: { days: ['Monday'], periods: [1] },
        faculty: [{ id: 'F1', name: 'Dr. A' }],
        entries: [{ faculty: 'Dr. Ghost', day: 'Monday', period: 1, subject: 'DBMS' }]
    });
    const report = validate(normalized);
    assert.strictEqual(report.ok, true);
    assert.ok(report.warnings.some(w => w.code === 'FACULTY_AUTO_ADDED'));
    // Dropping them would have made a teaching faculty look permanently free.
    const engineWithGhost = createEngine(normalized);
    assert.ok(!engineWithGhost.getAvailability('Monday', 1).availableFaculty.includes('Dr. Ghost'));
});

console.log('\n[4] Views and read-only behaviour');

check('the class grid covers every day and period', () => {
    const grid = engine.getClassGrid('CSE-A');
    assert.strictEqual(grid.cells.length, 35);
    const mondayP2 = grid.cells.find(c => c.day === 'Monday' && c.period === 2);
    assert.strictEqual(mondayP2.subject, 'OS');
    assert.strictEqual(mondayP2.faculty, 'Dr. Meera Nair');
    assert.strictEqual(mondayP2.className, 'CSE-A');
});

check('a faculty grid shows that faculty\'s own week', () => {
    const grid = engine.getFacultyGrid('Dr. Anand Rao');
    assert.strictEqual(grid.cells.length, 35);
    const busy = grid.cells.filter(c => c.status === 'busy');
    assert.strictEqual(busy.length, 6);
    assert.strictEqual(engine.getFacultyGrid('Nobody At All'), null);
});

check('faculty stats add up to the full week', () => {
    engine.getFacultyStats().forEach(f => {
        assert.strictEqual(f.busyPeriods + f.freePeriods, f.totalPeriods);
        assert.strictEqual(f.totalPeriods, 35);
    });
});

check('queries return copies — callers cannot mutate engine state', () => {
    const before = JSON.stringify(engine.getSlot('Monday', 2));
    const slot = engine.getSlot('Monday', 2);
    slot.busy.length = 0;
    slot.free.push({ faculty: 'Injected' });
    engine.getRecords()[0].status = 'tampered';
    assert.strictEqual(JSON.stringify(engine.getSlot('Monday', 2)), before);
    assert.notStrictEqual(engine.getRecords()[0].status, 'tampered');
});

check('the engine exposes no write operation', () => {
    ['assign', 'save', 'update', 'delete', 'set'].forEach(name => {
        assert.strictEqual(typeof engine[name], 'undefined', `engine must not expose ${name}()`);
    });
});

const { passed } = counts();
console.log(`\n✅ engine: ${passed} checks passed.`);
