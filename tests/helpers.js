/** Shared test helpers: a tiny assertion runner and an HTTP client. */
const http = require('http');

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}\n      ${err.message}`);
        throw err;
    }
}

async function checkAsync(name, fn) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
}

function counts() { return { passed, failed }; }

function request(base, method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(`${base}${path}`, {
            method,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                : {}
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { /* html */ }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** Multipart upload, so the import routes are exercised exactly as the UI uses them. */
function upload(base, path, filename, buffer, fields = {}) {
    return new Promise((resolve, reject) => {
        const boundary = '----tectest' + Date.now();
        const parts = [];

        Object.keys(fields).forEach(name => {
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${fields[name]}\r\n`));
        });
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="timetable"; filename="${filename}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n'));
        parts.push(buffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const payload = Buffer.concat(parts);
        const req = http.request(`${base}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': payload.length
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) { /* non-json */ }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function waitForServer(base, attempts = 40) {
    return new Promise((resolve, reject) => {
        const tick = n => request(base, 'GET', '/api/health')
            .then(resolve)
            .catch(err => {
                if (n <= 0) return reject(err);
                setTimeout(() => tick(n - 1), 250);
            });
        tick(attempts);
    });
}

module.exports = { check, checkAsync, counts, request, upload, waitForServer };
