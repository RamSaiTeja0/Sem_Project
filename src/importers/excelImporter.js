/**
 * Excel importer (.xlsx) — the primary structured input for this project.
 * Reads the first worksheet and hands its rows to the shared table parser, so
 * Excel and CSV produce identical normalized data with no Excel-specific path.
 */
const ExcelJS = require('exceljs');
const { parseTable } = require('./tableParser');

function cellText(cell) {
    const value = cell == null ? null : cell.value;
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map(p => p.text).join('');
        if (value.text != null) return String(value.text);
        if (value.result != null) return String(value.result);
        if (value.hyperlink && value.text) return String(value.text);
        return '';
    }
    return String(value);
}

async function parse(buffer, options = {}) {
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    } catch (err) {
        const error = new Error(
            'Could not read this file as .xlsx. Only the modern Excel format is supported — ' +
            'open a legacy .xls in Excel and "Save As" .xlsx first.');
        error.code = 'UNREADABLE_WORKBOOK';
        throw error;
    }

    const sheet = options.sheet
        ? workbook.getWorksheet(options.sheet)
        : workbook.worksheets[0];

    if (!sheet) {
        const error = new Error('The workbook contains no worksheets');
        error.code = 'EMPTY_FILE';
        throw error;
    }

    const rows = [];
    const columnCount = Math.max(sheet.columnCount, 1);
    sheet.eachRow({ includeEmpty: false }, row => {
        const values = [];
        for (let c = 1; c <= columnCount; c++) values.push(cellText(row.getCell(c)));
        rows.push(values);
    });

    const result = parseTable(rows, options);
    return { ...result, format: 'excel', sheetName: sheet.name };
}

module.exports = { parse, format: 'excel' };
