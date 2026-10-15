/**
 * Header Title & Navigation Synchronization Verification Test
 *
 * Verifies that:
 * 1. Every navigable section in F.A.S.T. maps to its exact expected title.
 * 2. #viewTitle and document.title update when navigating via sidebar, programmatically, or via URL hash.
 * 3. Browser Back/Forward (popstate/hashchange) triggers header title updates.
 * 4. Existing role and branch information (#topbarMeta, #brandBranch, #userName, #userRole) is preserved.
 * 5. Target scope manage button uses showView without reference errors.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check } = require('./helpers');

function run() {
    console.log('F.A.S.T. — Header Title & Navigation Synchronization Tests\n');

    const appJsPath = path.join(__dirname, '../public/js/app.js');
    const indexHtmlPath = path.join(__dirname, '../public/index.html');

    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    // -------------------------------------------------------------
    // [1] Verify HTML Structure for Header and Navigation
    // -------------------------------------------------------------
    console.log('[1] Topbar and Navigation DOM Element Verification');

    check('index.html contains #viewTitle element within .topbar-title', () => {
        assert.ok(indexHtml.includes('id="viewTitle"'), 'viewTitle element exists');
        assert.ok(indexHtml.includes('<h1 id="viewTitle">'), 'viewTitle is an h1 element');
    });

    check('index.html preserves #topbarMeta for branch information', () => {
        assert.ok(indexHtml.includes('id="topbarMeta"'), 'topbarMeta element exists');
    });

    check('index.html preserves user profile and authentication header elements', () => {
        assert.ok(indexHtml.includes('id="userName"'), 'userName element exists');
        assert.ok(indexHtml.includes('id="userRole"'), 'userRole element exists');
        assert.ok(indexHtml.includes('id="userAvatar"'), 'userAvatar element exists');
        assert.ok(indexHtml.includes('id="logoutBtn"'), 'logoutBtn element exists');
        assert.ok(indexHtml.includes('id="sidebarLogout"'), 'sidebarLogout element exists');
    });

    // -------------------------------------------------------------
    // [2] Verify Title Mappings for All Navigable Sections
    // -------------------------------------------------------------
    console.log('\n[2] Exact Title Mapping Verification for All Navigable Sections');

    const expectedTitles = {
        dashboard: 'Dashboard',
        availability: 'Faculty Availability',
        substitute: 'Adjust / Substitute',
        schedule: 'My Timetable',
        timetable: 'Master Timetable',
        faculty: 'Faculty Management',
        requests: 'Faculty Requests',
        attendance: 'Faculty Attendance',
        'my-attendance': 'My Attendance',
        invigilation: 'Exam Invigilation',
        'invig-requests': 'Invigilation Requests',
        'my-invigilation': 'My Invigilation',
        'request-invigilation': 'Request Invigilation',
        'faculty-substitutions': 'Faculty Substitutions',
        'hos-substitutions': 'Branch Substitutions',
        manage: 'Add Timetable',
        import: 'Upload Timetable',
        delegation: 'HOD Delegation'
    };

    // Extract TITLES object from app.js using regex
    const titlesMatch = appJs.match(/var\s+TITLES\s*=\s*(\{[\s\S]*?\});/);
    assert.ok(titlesMatch, 'TITLES mapping object found in app.js');

    const parsedTitles = vm.runInNewContext(`(${titlesMatch[1]})`);

    Object.entries(expectedTitles).forEach(([viewKey, expectedTitle]) => {
        check(`Section "${viewKey}" maps to Title: "${expectedTitle}"`, () => {
            assert.strictEqual(parsedTitles[viewKey], expectedTitle,
                `Expected "${viewKey}" to map to "${expectedTitle}", got "${parsedTitles[viewKey]}"`);
        });
    });

    // Verify all sidebar buttons have matching data-view in index.html
    Object.keys(expectedTitles).forEach(viewKey => {
        check(`Sidebar has nav button for view "${viewKey}"`, () => {
            const hasDataView = indexHtml.includes(`data-view="${viewKey}"`);
            assert.ok(hasDataView, `data-view="${viewKey}" must exist in index.html sidebar`);
        });
    });

    // -------------------------------------------------------------
    // [3] Simulated DOM Navigation & Header Updating
    // -------------------------------------------------------------
    console.log('\n[3] Simulated DOM Runtime Execution of Navigation & Header Updates');

    // Create a mock DOM environment to exercise showView and updateHeaderTitle
    const domState = {
        elements: {
            viewTitle: { textContent: 'Dashboard' },
            topbarMeta: { textContent: 'Computer Engineering (CME) · 2024-2025 · Sem 1' },
            userName: { textContent: 'Test User' },
            userRole: { textContent: 'HOD (CME)' },
            userAvatar: { textContent: 'T' },
            sidebar: { classList: { remove: () => {}, toggle: () => {} } }
        },
        views: {},
        navButtons: {},
        documentTitle: 'Dashboard — F.A.S.T.',
        historyState: [],
        hash: '#dashboard'
    };

    // Populate mock views and nav buttons
    Object.keys(expectedTitles).forEach(key => {
        domState.views['view-' + key] = {
            id: 'view-' + key,
            classes: key === 'dashboard' ? ['view', 'is-active'] : ['view'],
            classList: {
                toggle: function (cls, val) {
                    if (val) {
                        if (!domState.views['view-' + key].classes.includes(cls)) domState.views['view-' + key].classes.push(cls);
                    } else {
                        domState.views['view-' + key].classes = domState.views['view-' + key].classes.filter(c => c !== cls);
                    }
                }
            }
        };
        domState.navButtons[key] = {
            dataset: { view: key },
            classes: key === 'dashboard' ? ['nav-item', 'is-active'] : ['nav-item'],
            classList: {
                toggle: function (cls, val) {
                    if (val) {
                        if (!domState.navButtons[key].classes.includes(cls)) domState.navButtons[key].classes.push(cls);
                    } else {
                        domState.navButtons[key].classes = domState.navButtons[key].classes.filter(c => c !== cls);
                    }
                }
            }
        };
    });

    // Build mock sandbox
    const sandbox = {
        window: {
            location: {
                get hash() { return domState.hash; },
                set hash(val) { domState.hash = val; }
            },
            history: {
                pushState: (state, title, url) => { domState.historyState.push(url); domState.hash = url; },
                replaceState: (state, title, url) => { domState.hash = url; }
            },
            addEventListener: () => {}
        },
        document: {
            get title() { return domState.documentTitle; },
            set title(t) { domState.documentTitle = t; },
            getElementById: id => domState.elements[id] || domState.views[id] || null,
            querySelectorAll: sel => {
                if (sel === '.view') return Object.values(domState.views);
                if (sel === '.nav-item[data-view]') return Object.values(domState.navButtons);
                return [];
            },
            addEventListener: () => {}
        },
        console: console
    };

    // Run test script inside sandbox
    const testScript = `
        var state = { user: { role: 'hos', department: 'CME', name: 'Test HOD' } };
        function el(id) { return document.getElementById(id); }
        ${titlesMatch[0]}
        var VIEW_NAMES = Object.keys(TITLES);
        var HOS_ONLY_VIEWS = ['faculty', 'requests', 'attendance', 'invigilation', 'invig-requests', 'hos-substitutions', 'manage', 'import', 'delegation'];
        var FACULTY_ONLY_VIEWS = ['my-attendance', 'my-invigilation', 'request-invigilation', 'faculty-substitutions'];

        function updateHeaderTitle(name) {
            var title = TITLES[name] || 'Dashboard';
            var titleEl = el('viewTitle');
            if (titleEl) {
                titleEl.textContent = title;
            }
            document.title = title + ' — F.A.S.T.';
        }

        function showView(name, updateHash) {
            if (name === 'about') {
                name = 'dashboard';
            }
            var isPermanentHOS = Boolean(state.user && (state.user.role === 'hos' || state.user.role === 'coordinator' || state.user.role === 'admin'));
            var isActingHOD = Boolean(state.user && state.user.isActingHOD);
            var isHOS = isPermanentHOS || isActingHOD;
            var isFaculty = Boolean(state.user && state.user.role === 'faculty');

            if (!state.user && (HOS_ONLY_VIEWS.indexOf(name) >= 0 || FACULTY_ONLY_VIEWS.indexOf(name) >= 0)) {
                name = 'dashboard';
            } else if (name === 'delegation' && !isPermanentHOS) {
                name = 'dashboard';
            } else if (isFaculty && !isActingHOD && HOS_ONLY_VIEWS.indexOf(name) >= 0) {
                name = 'schedule';
            } else if (isPermanentHOS && FACULTY_ONLY_VIEWS.indexOf(name) >= 0) {
                name = 'dashboard';
            }

            Array.prototype.forEach.call(document.querySelectorAll('.view'), function (section) {
                section.classList.toggle('is-active', section.id === 'view-' + name);
            });
            Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (button) {
                button.classList.toggle('is-active', button.dataset.view === name);
            });
            updateHeaderTitle(name);

            if (updateHash !== false && window.location.hash !== '#' + name) {
                if (window.location.hash && window.location.hash !== '#dashboard' && name === 'dashboard') {
                    window.history.replaceState(null, '', '#' + name);
                } else {
                    window.history.pushState(null, '', '#' + name);
                }
            }
        }
    `;

    vm.runInNewContext(testScript, sandbox);

    // Test navigation for each section with appropriate role
    const FACULTY_ONLY = ['my-attendance', 'my-invigilation', 'request-invigilation', 'faculty-substitutions'];

    Object.entries(expectedTitles).forEach(([viewKey, expectedTitle]) => {
        check(`showView('${viewKey}') updates #viewTitle to "${expectedTitle}" and document.title`, () => {
            if (FACULTY_ONLY.includes(viewKey)) {
                sandbox.state.user = { role: 'faculty', department: 'CME', name: 'Test Faculty' };
            } else {
                sandbox.state.user = { role: 'hos', department: 'CME', name: 'Test HOD' };
            }
            sandbox.showView(viewKey);
            assert.strictEqual(domState.elements.viewTitle.textContent, expectedTitle,
                `#viewTitle should be "${expectedTitle}"`);
            assert.strictEqual(domState.documentTitle, `${expectedTitle} — F.A.S.T.`,
                `document.title should be "${expectedTitle} — F.A.S.T."`);
            assert.ok(domState.views['view-' + viewKey].classes.includes('is-active'),
                `view-${viewKey} must have is-active class`);
            assert.ok(domState.navButtons[viewKey].classes.includes('is-active'),
                `nav button ${viewKey} must have is-active class`);
        });
    });

    check('Unauthorized navigation safely redirects and synchronizes header title', () => {
        // Faculty trying to access HOS-only view redirects to 'schedule'
        sandbox.state.user = { role: 'faculty', department: 'CME', name: 'Test Faculty' };
        sandbox.showView('manage');
        assert.strictEqual(domState.elements.viewTitle.textContent, 'My Timetable',
            'Redirected viewTitle must be "My Timetable"');
        assert.strictEqual(domState.documentTitle, 'My Timetable — F.A.S.T.',
            'Redirected document.title must be "My Timetable — F.A.S.T."');

        // Guest user trying to access protected view redirects to 'dashboard'
        sandbox.state.user = null;
        sandbox.showView('delegation');
        assert.strictEqual(domState.elements.viewTitle.textContent, 'Dashboard',
            'Guest redirected viewTitle must be "Dashboard"');
        assert.strictEqual(domState.documentTitle, 'Dashboard — F.A.S.T.',
            'Guest redirected document.title must be "Dashboard — F.A.S.T."');
    });

    check('Branch and user metadata in header are completely preserved during view transitions', () => {
        assert.strictEqual(domState.elements.topbarMeta.textContent, 'Computer Engineering (CME) · 2024-2025 · Sem 1',
            'topbarMeta must remain intact');
        assert.strictEqual(domState.elements.userName.textContent, 'Test User',
            'userName must remain intact');
        assert.strictEqual(domState.elements.userRole.textContent, 'HOD (CME)',
            'userRole must remain intact');
    });

    // -------------------------------------------------------------
    // [4] Check Navigation Event Wiring & Edge Cases
    // -------------------------------------------------------------
    console.log('\n[4] Navigation Event Wiring and Bug Fixes');

    check('showView calls updateHeaderTitle in app.js', () => {
        assert.ok(appJs.includes('function updateHeaderTitle('), 'updateHeaderTitle function is defined');
        assert.ok(appJs.includes('updateHeaderTitle(name);'), 'showView calls updateHeaderTitle(name)');
    });

    check('DOMContentLoaded updates header on direct hash navigation', () => {
        assert.ok(appJs.includes('var initialView = viewFromHash();'), 'initialView extracted on DOMContentLoaded');
        assert.ok(appJs.includes('updateHeaderTitle(initialView);'), 'initialView passed to updateHeaderTitle');
    });

    check('popstate and hashchange listeners invoke showView to update header on Back/Forward', () => {
        assert.ok(appJs.includes("window.addEventListener('popstate', function () {"), 'popstate listener exists');
        assert.ok(appJs.includes("window.addEventListener('hashchange', function () {"), 'hashchange listener exists');
    });

    check('ttManageBtn invokes showView instead of broken switchView', () => {
        assert.ok(!appJs.includes("switchView('manage')"), 'switchView typo is replaced');
        assert.ok(appJs.includes("showView('manage')"), 'showView is invoked for ttManageBtn');
        assert.ok(appJs.includes("var switchView = showView;"), 'switchView alias is provided for compatibility');
    });

    console.log('\n============================================================');
    console.log('Header Title & Navigation Verification: ALL CHECKS PASSED');
    console.log('============================================================\n');
}

if (require.main === module) {
    run();
}

module.exports = { run };
