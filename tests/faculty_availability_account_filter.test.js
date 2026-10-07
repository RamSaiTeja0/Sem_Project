const assert = require('assert');
const http = require('http');
const express = require('express');

const availabilityRoutes = require('../src/routes/availability');
const facultyRoutes = require('../src/routes/faculty');

let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error('   ', err.message);
        failed++;
    }
}

function makeRequest(server, path, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = {
            ...headers,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        };

        const req = http.request({
            hostname: '127.0.0.1',
            port: addr.port,
            path: path,
            method: method,
            headers: reqHeaders
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log('=== FACULTY AVAILABILITY ACCOUNT FILTER TEST SUITE ===\n');

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { username: 'hos.cme', role: 'hos', department: 'CME' };
        next();
    });
    app.use('/api/availability', availabilityRoutes);
    app.use('/api/faculty', facultyRoutes);

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    try {
        await check('1. POST /api/availability returns 0 faculty when 0 accounts exist in live DB', async () => {
            const res = await makeRequest(server, '/api/availability', 'POST', { day: 'Monday', period: 1 });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.totalAvailable, 0);
            assert.strictEqual(res.body.totalFaculty, 0);
            assert.strictEqual(res.body.faculty.length, 0);
            assert.strictEqual(res.body.allFaculty.length, 0);
            assert.strictEqual(res.body.emptyState, 'No faculty accounts available.');
        });

        await check('2. GET /api/faculty?accountOnly=true returns 0 faculty when 0 accounts exist', async () => {
            const res = await makeRequest(server, '/api/faculty?accountOnly=true', 'GET');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.count, 0);
            assert.strictEqual(res.body.faculty.length, 0);
        });

        await check('3. HOD accounts are NEVER returned as faculty in availability', async () => {
            const res = await makeRequest(server, '/api/availability', 'POST', { day: 'Monday', period: 1 });
            assert.strictEqual(res.status, 200);
            const hasHOD = (res.body.faculty || []).some(f => f.name === 'hos.cme' || f.name === 'CH . Sai Kishore');
            assert.strictEqual(hasHOD, false);
        });

        await check('4. GET /api/availability/candidates returns 0 candidates when 0 accounts exist', async () => {
            const res = await makeRequest(server, '/api/availability/candidates?day=Monday&period=1', 'GET');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.totalCandidates, 0);
            assert.strictEqual(res.body.candidates.length, 0);
            assert.strictEqual(res.body.faculty.length, 0);
        });

        await check('5. GET /api/availability/summary returns totalFaculty = 0 when 0 accounts exist', async () => {
            const res = await makeRequest(server, '/api/availability/summary?day=Monday&period=1', 'GET');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.totalFaculty, 0);
            assert.strictEqual(res.body.totalAvailable, 0);
        });
    } finally {
        server.close();
    }

    console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
}

runTests();
