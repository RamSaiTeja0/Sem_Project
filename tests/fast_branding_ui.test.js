/**
 * F.A.S.T. Branding & User-Facing UI Verification Tests
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, counts } = require('./helpers');

function run() {
    console.log('F.A.S.T. — UI Branding Verification Tests\n');

    const publicDir = path.join(__dirname, '..', 'public');

    const pages = [
        { file: 'login.html', name: 'Login Page' },
        { file: 'register.html', name: 'Registration Page' },
        { file: 'home.html', name: 'Landing/Home Page' },
        { file: 'index.html', name: 'Main Dashboard' }
    ];

    console.log('[1] User-Facing HTML Page Title & Brand Lockup Verification');
    for (const page of pages) {
        const content = fs.readFileSync(path.join(publicDir, page.file), 'utf8');

        check(`${page.name} (${page.file}) specifies F.A.S.T. in <title>`, () => {
            const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
            assert.ok(titleMatch, 'Title element found');
            assert.ok(titleMatch[1].includes('F.A.S.T.'), `Title "${titleMatch[1]}" must contain "F.A.S.T."`);
        });

        check(`${page.name} (${page.file}) brand text is "F.A.S.T."`, () => {
            assert.ok(content.includes('<span class="brand-text">F.A.S.T.</span>'), 'brand-text span contains F.A.S.T.');
        });

        check(`${page.name} (${page.file}) brand lockup contains [FAST] F.A.S.T. with subtitle`, () => {
            assert.ok(content.includes('<span class="brand-mark">FAST</span>'), 'brand-mark contains FAST');
            assert.ok(content.includes('<span class="brand-content">'), 'brand-content container exists');
            assert.ok(content.includes('<span class="brand-text">F.A.S.T.</span>'), 'brand-text contains F.A.S.T.');
            assert.ok(content.includes('<span class="brand-subtitle">Faculty Alternative Substitution Tracker</span>'), 'brand-subtitle contains full form');
        });

        check(`${page.name} (${page.file}) has no visible "TecSubstitution" branding`, () => {
            // Strip HTML comments to only test rendered content
            const uncommented = content.replace(/<!--[\s\S]*?-->/g, '');
            assert.ok(!uncommented.includes('TecSubstitution'), `No visible "TecSubstitution" text in ${page.file}`);
            assert.ok(!uncommented.includes('Tec Substitution'), `No visible "Tec Substitution" text in ${page.file}`);
        });
    }

    console.log('\n[2] Detailed Display Format Verification');
    const loginHtml = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');
    const registerHtml = fs.readFileSync(path.join(publicDir, 'register.html'), 'utf8');
    const homeHtml = fs.readFileSync(path.join(publicDir, 'home.html'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

    check('login.html displays brand lockup and sidebar heading', () => {
        assert.ok(loginHtml.includes('Faculty Alternative Substitution Tracker'));
    });

    check('register.html displays brand lockup with full subtitle', () => {
        assert.ok(registerHtml.includes('<span class="brand-subtitle">Faculty Alternative Substitution Tracker</span>'));
    });

    check('home.html contains brand lockup in header and footer', () => {
        assert.ok(homeHtml.includes('<span class="brand-subtitle">Faculty Alternative Substitution Tracker</span>'));
    });

    check('index.html contains brand lockup in sidebar header', () => {
        assert.ok(indexHtml.includes('<span class="brand-mark">FAST</span>'));
        assert.ok(indexHtml.includes('<span class="brand-text">F.A.S.T.</span>'));
        assert.ok(indexHtml.includes('<span class="brand-subtitle">Faculty Alternative Substitution Tracker</span>'));
    });

    const { passed, failed } = counts();
    console.log('\n============================================================');
    console.log(`UI Branding Verification: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run();
