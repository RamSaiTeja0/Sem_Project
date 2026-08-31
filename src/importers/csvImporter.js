/**
 * CSV importer. Parses RFC4180-style CSV (quoted fields, embedded commas and
 * newlines) into rows, then hands them to the shared table parser.
 */
const { parseTable } = require('./tableParser');

function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const content = String(text).replace(/^﻿/, '');

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (inQuotes) {
            if (char === '"') {
                if (content[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += char;
            continue;
        }
        if (char === '"') { inQuotes = true; continue; }
        if (char === ',') { row.push(field); field = ''; continue; }
        if (char === '\r') continue;
        if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += char;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

async function parse(buffer, options = {}) {
    const rows = parseCsvText(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer);
    const result = parseTable(rows, options);
    return { ...result, format: 'csv' };
}

module.exports = { parse, parseCsvText, format: 'csv' };
