/**
 * Shared table parser — converts a rectangular sheet (rows of cells) into a
 * timetable source object. Excel and CSV both feed this, so both formats
 * produce identical normalized data.
 *
 * Two layouts are detected automatically:
 *
 *  MATRIX (primary, as documented in the README)
 *     Faculty     | Monday P1 | Monday P2 | Tuesday P1 | ...
 *     Dr. A Rao   | DBMS      | FREE      | OS         | ...
 *
 *  LONG
 *     Faculty | Day | Period | Subject | Class | Room
 *
 * A cell reading FREE / - / blank means "not teaching" and is left free rather
 * than invented into a subject.
 */
const { parseSlotHeader, normalizeDayName, normalizePeriodNumber, isFreeToken,
        describeDayError, WORKING_DAYS } = require('../core/normalizer');

const PERIOD_RANGE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function cellText(value) {
    if (value == null) return '';
    return String(value).trim();
}

function headerKey(value) {
    return cellText(value).toLowerCase().replace(/[\s_.-]/g, '');
}

function detectLayout(header) {
    const keys = header.map(headerKey);
    const hasFaculty = keys.some(k => k === 'faculty' || k === 'facultyname' || k === 'name' || k === 'staff');
    const hasDay = keys.includes('day');
    const hasPeriod = keys.includes('period');
    if (hasFaculty && hasDay && hasPeriod) return 'long';
    const slotColumns = header.filter(h => parseSlotHeader(h) !== null).length;
    if (hasFaculty && slotColumns > 0) return 'matrix';
    if (slotColumns > 0) return 'matrix';
    return null;
}

/**
 * @param {Array<Array<*>>} rows  first row is the header
 * @param {object} options        { defaultClass }
 * @returns {{ source, layout, rowCount, slotCount, issues }}
 */
function parseTable(rows, options = {}) {
    const issues = [];
    const grid = (rows || []).filter(row => row.some(cell => cellText(cell) !== ''));

    if (grid.length === 0) {
        const error = new Error('The file contains no data');
        error.code = 'EMPTY_FILE';
        throw error;
    }
    if (grid.length === 1) {
        const error = new Error('The file has a header row but no timetable rows');
        error.code = 'NO_DATA_ROWS';
        throw error;
    }

    const header = grid[0].map(cellText);
    const layout = detectLayout(header);

    if (!layout) {
        const error = new Error(
            'Unrecognised timetable structure. Expected either a matrix ' +
            '("Faculty" plus columns like "Monday P1"), or long-form columns ' +
            '"Faculty, Day, Period, Subject".');
        error.code = 'BAD_STRUCTURE';
        error.header = header;
        throw error;
    }

    const entries = [];
    const facultyNames = new Set();
    let slotCount = 0;

    if (layout === 'matrix') {
        const facultyIndex = header.findIndex(h =>
            ['faculty', 'facultyname', 'name', 'staff'].includes(headerKey(h)));
        if (facultyIndex < 0) {
            const error = new Error('A matrix timetable needs a "Faculty" column');
            error.code = 'NO_FACULTY_COLUMN';
            throw error;
        }

        const slotColumns = header
            .map((h, index) => ({ index, slot: parseSlotHeader(h) }))
            .filter(entry => entry.slot !== null);

        if (slotColumns.length === 0) {
            const error = new Error(
                'No day/period columns found. Headers should look like "Monday P1", "Tuesday P3".');
            error.code = 'NO_SLOT_COLUMNS';
            throw error;
        }

        const classIndex = header.findIndex(h => ['class', 'section', 'classname'].includes(headerKey(h)));
        const deptIndex = header.findIndex(h => ['department', 'dept'].includes(headerKey(h)));

        grid.slice(1).forEach((row, n) => {
            const lineNumber = n + 2;
            const facultyName = cellText(row[facultyIndex]);
            if (!facultyName) {
                issues.push({ severity: 'error', code: 'MISSING_FACULTY',
                    message: `Row ${lineNumber}: the Faculty cell is empty`, context: { row: lineNumber } });
                return;
            }
            facultyNames.add(JSON.stringify({
                name: facultyName,
                department: deptIndex >= 0 ? cellText(row[deptIndex]) : null
            }));

            slotColumns.forEach(({ index, slot }) => {
                const subject = cellText(row[index]);
                slotCount++;
                if (isFreeToken(subject)) return; // free slot: nothing to record
                entries.push({
                    faculty: facultyName,
                    day: slot.day,
                    period: slot.period,
                    subject,
                    class: classIndex >= 0 ? cellText(row[classIndex]) || options.defaultClass : options.defaultClass
                });
            });
        });
    } else {
        const at = (row, names) => {
            const index = header.findIndex(h => names.includes(headerKey(h)));
            return index >= 0 ? cellText(row[index]) : '';
        };

        grid.slice(1).forEach((row, n) => {
            const lineNumber = n + 2;
            const facultyName = at(row, ['faculty', 'facultyname', 'name', 'staff']);
            const dayRaw = at(row, ['day']);
            const periodRaw = at(row, ['period']);
            const subject = at(row, ['subject', 'course']);
            const className = at(row, ['class', 'section', 'classname']);
            const room = at(row, ['room', 'venue']);
            const department = at(row, ['department', 'dept']);

            if (!facultyName) {
                issues.push({ severity: 'error', code: 'MISSING_FACULTY',
                    message: `Row ${lineNumber}: the Faculty cell is empty`, context: { row: lineNumber } });
                return;
            }
            facultyNames.add(JSON.stringify({ name: facultyName, department: department || null }));

            const day = normalizeDayName(dayRaw);
            if (!day) {
                issues.push({ severity: 'error', code: 'INVALID_DAY',
                    message: `Row ${lineNumber}: ${describeDayError(dayRaw)}`,
                    // Structured detail so the preview can show the offending
                    // value and what was expected, not just a sentence.
                    context: { row: lineNumber, field: 'day', value: dayRaw, expected: WORKING_DAYS } });
                return;
            }
            const period = normalizePeriodNumber(periodRaw, PERIOD_RANGE);
            if (period == null) {
                issues.push({ severity: 'error', code: 'INVALID_PERIOD',
                    message: `Row ${lineNumber}: "${periodRaw}" is not a valid period. Expected 1–${PERIOD_RANGE.length}`,
                    context: { row: lineNumber, field: 'period', value: periodRaw, expected: PERIOD_RANGE } });
                return;
            }

            slotCount++;
            if (isFreeToken(subject)) return;
            entries.push({
                faculty: facultyName,
                day,
                period,
                subject,
                class: className || options.defaultClass,
                room: room || null
            });
        });
    }

    const faculty = [...facultyNames].map(json => {
        const parsed = JSON.parse(json);
        return { id: parsed.name, name: parsed.name, department: parsed.department || 'General' };
    });

    // Days and periods are taken from what the file actually contains, so a
    // 5-period or 8-period timetable both work without configuration.
    const days = [...new Set(entries.map(e => e.day))];
    const periods = [...new Set(entries.map(e => e.period))].sort((a, b) => a - b);
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const source = {
        meta: {
            title: options.title || 'Imported Timetable',
            primaryClass: options.defaultClass || null,
            days: dayOrder.filter(d => days.includes(d)),
            periods: periods.length ? periods : [1, 2, 3, 4, 5, 6, 7]
        },
        faculty,
        entries
    };

    return { source, layout, rowCount: grid.length - 1, slotCount, issues };
}

module.exports = { parseTable, detectLayout };
