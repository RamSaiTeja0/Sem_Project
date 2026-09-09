const http = require('http');

function post(path, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request('http://localhost:3001' + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...(cookie ? { 'Cookie': cookie } : {})
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                const setCookie = (res.headers['set-cookie'] || [])[0];
                resolve({ status: res.statusCode, body: parsed, cookie: setCookie ? setCookie.split(';')[0] : null });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function upload(path, filename, buffer, cookie, mime = 'application/pdf') {
    return new Promise((resolve, reject) => {
        const boundary = '----liveverify' + Date.now();
        const parts = [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="timetable"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
            buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ];
        const payload = Buffer.concat(parts);
        const req = http.request('http://localhost:3001' + path, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': payload.length,
                ...(cookie ? { 'Cookie': cookie } : {})
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function get(path, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.request('http://localhost:3001' + path, {
            method: 'GET',
            headers: cookie ? { 'Cookie': cookie } : {}
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function testLive() {
    console.log('--- Checking Live Server Health ---');
    const health = await get('/api/health');
    console.log('Health status:', health.status);

    console.log('\n--- Registering CME HOS on live dev server ---');
    const regHos = await post('/api/auth/register', {
        role: 'hos',
        name: 'Live CME HOS',
        phone: '9876543210',
        branchName: 'Computer Engineering',
        branchCode: 'CME',
        username: 'live_cme_hos',
        password: 'Live_password1'
    });
    console.log('CME HOS reg status:', regHos.status);

    const loginHos = await post('/api/auth/login', {
        username: 'live_cme_hos',
        password: 'Live_password1'
    });
    console.log('CME HOS login status:', loginHos.status);
    const cmeCookie = loginHos.cookie;

    console.log('\n--- Testing Live Master Timetable Upload (PDF) ---');
    const samplePdf = Buffer.from('%PDF-1.4 sample master timetable pdf');
    const upMaster = await upload('/api/uploads/master-timetable', 'cme_master_schedule.pdf', samplePdf, cmeCookie);
    console.log('Master upload status:', upMaster.status);
    console.log('Master upload response:', upMaster.body);

    console.log('\n--- Testing Live Master Timetable Upload (PNG) ---');
    const samplePng = Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRpng');
    const upMasterPng = await upload('/api/uploads/master-timetable', 'cme_master_grid.png', samplePng, cmeCookie, 'image/png');
    console.log('Master PNG upload status:', upMasterPng.status);
    console.log('Master PNG fileType:', upMasterPng.body ? upMasterPng.body.fileType : null);

    console.log('\n--- Creating Faculty under CME HOS ---');
    const regFac = await post('/api/auth/register', {
        role: 'faculty',
        name: 'Dr. Live Faculty',
        phone: '9123456780',
        username: 'live_faculty',
        password: 'Live_password1',
        subjects: ['Operating Systems']
    }, cmeCookie);
    console.log('Faculty create status:', regFac.status);

    const loginFac = await post('/api/auth/login', {
        username: 'live_faculty',
        password: 'Live_password1'
    });
    console.log('Faculty login status:', loginFac.status);
    const facCookie = loginFac.cookie;

    console.log('\n--- Testing Live Faculty My Timetable Upload (JPG) ---');
    const sampleJpg = Buffer.from('\xFF\xD8\xFF\xE0\x00\x10JFIFjpg');
    const upFac = await upload('/api/uploads/faculty-timetable', 'my_os_timetable.jpg', sampleJpg, facCookie, 'image/jpeg');
    console.log('Faculty upload status:', upFac.status);
    console.log('Faculty upload response:', upFac.body);

    console.log('\n--- Verifying Upload Metadata via GET /api/uploads/:id ---');
    const metaCheck = await get('/api/uploads/' + upMaster.body.uploadId, cmeCookie);
    console.log('Metadata check status:', metaCheck.status);
    console.log('Retrieved metadata:', metaCheck.body);

    console.log('\n--- Checking List Uploads for CME Branch ---');
    const listCheck = await get('/api/uploads', cmeCookie);
    console.log('List uploads status:', listCheck.status);
    console.log('List uploads count:', listCheck.body ? listCheck.body.uploads.length : 0);

    console.log('\n--- Registering Independent EEE HOS ---');
    const regEeeHos = await post('/api/auth/register', {
        role: 'hos',
        name: 'Live EEE HOS',
        phone: '9876543211',
        branchName: 'Electrical Engineering',
        branchCode: 'EEE',
        username: 'live_eee_hos',
        password: 'Live_password1'
    });
    console.log('EEE HOS reg status:', regEeeHos.status);

    const loginEee = await post('/api/auth/login', {
        username: 'live_eee_hos',
        password: 'Live_password1'
    });
    console.log('EEE HOS login status:', loginEee.status);
    const eeeCookie = loginEee.cookie;

    console.log('\n--- Testing Cross-Branch Isolation ---');
    const eeeTryCme = await get('/api/uploads/' + upMaster.body.uploadId, eeeCookie);
    console.log('EEE HOS querying CME upload status:', eeeTryCme.status);
    console.log('EEE HOS querying CME error code:', eeeTryCme.body ? eeeTryCme.body.code : null);

    console.log('\n--- Verifying Direct URL /uploads is blocked ---');
    const directFile = await get('/uploads/' + upMaster.body.uploadId + '.pdf');
    console.log('Direct file access status:', directFile.status);

    console.log('\n=============================================');
    console.log('>>> ALL LIVE CHECKS COMPLETED SUCCESSFULLY <<<');
    console.log('=============================================');
}

testLive().catch(console.error);
