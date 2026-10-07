/**
 * Swipe / Gesture Navigation Regression Tests
 *
 * Verifies that:
 * 1. Authenticated HOD swiping left on any feature page navigates to HOD Dashboard (#dashboard)
 * 2. Authenticated Faculty swiping left on any feature page navigates to Faculty Dashboard (#dashboard)
 * 3. Unauthenticated/public user swiping left navigates to public landing page (/)
 * 4. Swiping does not log out the user or mutate the session
 * 5. Feature pages (Availability, Attendance, Invigilation, Timetable, etc.) do not redirect authenticated users to /
 * 6. Horizontal scroll containers and interactive elements do not trigger unwanted swipe navigation
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, counts } = require('./helpers');

function createMockEnvironment(user) {
    let currentHash = '#availability';
    let currentHref = 'http://localhost:3001/dashboard#availability';
    let activeViews = new Set(['view-availability']);
    let activeNavs = new Set(['availability']);
    let hodOverviewDisplay = 'none';
    let stdOverviewDisplay = 'none';

    const documentMock = {
        location: {
            get href() { return currentHref; },
            set href(val) { currentHref = val; },
            get hash() { return currentHash; },
            set hash(val) { currentHash = val; }
        },
        querySelectorAll: (selector) => {
            if (selector === '.view') {
                const views = ['dashboard', 'availability', 'substitute', 'attendance', 'my-attendance',
                               'invigilation', 'invig-requests', 'my-invigilation', 'request-invigilation',
                               'faculty-substitutions', 'hos-substitutions', 'schedule', 'timetable',
                               'faculty', 'requests', 'manage', 'import', 'delegation'];
                return views.map(v => ({
                    id: 'view-' + v,
                    classList: {
                        toggle: (cls, active) => {
                            if (cls === 'is-active') {
                                if (active) activeViews.add('view-' + v);
                                else activeViews.delete('view-' + v);
                            }
                        }
                    }
                }));
            }
            if (selector === '.nav-item[data-view]') {
                const navs = ['dashboard', 'availability', 'substitute', 'attendance', 'my-attendance',
                              'invigilation', 'invig-requests', 'my-invigilation', 'request-invigilation',
                              'faculty-substitutions', 'hos-substitutions', 'schedule', 'timetable',
                              'faculty', 'requests', 'manage', 'import', 'delegation'];
                return navs.map(n => ({
                    dataset: { view: n },
                    classList: {
                        toggle: (cls, active) => {
                            if (cls === 'is-active') {
                                if (active) activeNavs.add(n);
                                else activeNavs.delete(n);
                            }
                        }
                    },
                    addEventListener: () => {}
                }));
            }
            return [];
        },
        getElementById: (id) => {
            if (id === 'hodDashboardOverview') {
                return {
                    style: {
                        get display() { return hodOverviewDisplay; },
                        set display(v) { hodOverviewDisplay = v; }
                    },
                    addEventListener: () => {}
                };
            }
            if (id === 'standardDashboardOverview') {
                return {
                    style: {
                        get display() { return stdOverviewDisplay; },
                        set display(v) { stdOverviewDisplay = v; }
                    }
                };
            }
            if (id === 'sidebar') {
                return {
                    classList: { remove: () => {}, toggle: () => {} }
                };
            }
            return {
                addEventListener: () => {},
                classList: { add: () => {}, remove: () => {}, toggle: () => {} },
                style: {},
                dataset: {},
                appendChild: () => {},
                replaceChildren: () => {},
                innerHTML: ''
            };
        },
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            style: {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: () => {},
            setAttribute: () => {},
            addEventListener: () => {}
        }),
        addEventListener: () => {}
    };

    const windowMock = {
        location: documentMock.location,
        history: {
            replaceState: (state, title, url) => {
                if (url.startsWith('#')) {
                    currentHash = url;
                    currentHref = currentHref.split('#')[0] + url;
                } else {
                    currentHref = url;
                }
            },
            pushState: (state, title, url) => {
                if (url.startsWith('#')) {
                    currentHash = url;
                    currentHref = currentHref.split('#')[0] + url;
                } else {
                    currentHref = url;
                }
            }
        },
        addEventListener: () => {},
        confirm: () => true,
        alert: () => {}
    };

    return {
        window: windowMock,
        document: documentMock,
        getActiveViews: () => Array.from(activeViews),
        getCurrentHash: () => currentHash,
        getCurrentHref: () => currentHref,
        getHodDisplay: () => hodOverviewDisplay,
        getStdDisplay: () => stdOverviewDisplay,
        setView: (v) => {
            currentHash = '#' + v;
            activeViews.clear();
            activeViews.add('view-' + v);
        }
    };
}

function run() {
    console.log('F.A.S.T. — Swipe / Gesture Navigation Regression Tests\n');

    const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
    const appCode = fs.readFileSync(appJsPath, 'utf8');

    console.log('[1] Verify source code implementation of swipe navigation');
    check('app.js defines initSwipeNavigation and handleSwipeLeftNavigation', () => {
        assert.ok(appCode.includes('function initSwipeNavigation()'), 'initSwipeNavigation defined');
        assert.ok(appCode.includes('function handleSwipeLeftNavigation()'), 'handleSwipeLeftNavigation defined');
    });

    check('app.js calls initSwipeNavigation during DOMContentLoaded initialization', () => {
        assert.ok(appCode.includes('initSwipeNavigation();'), 'initSwipeNavigation called on DOMContentLoaded');
    });

    console.log('\n[2] Test Suite: Authenticated HOD Swipe-Left Navigation');
    {
        const hodUser = { id: 1, name: 'Dr. HOD CME', role: 'hos', department: 'CME' };
        const hodViewsToTest = [
            'availability',
            'attendance',
            'invigilation',
            'invig-requests',
            'hos-substitutions',
            'timetable',
            'faculty',
            'requests',
            'delegation',
            'manage',
            'import'
        ];

        for (const featureView of hodViewsToTest) {
            check(`HOD swiping left on #${featureView} navigates to HOD Dashboard (#dashboard)`, () => {
                // Setup VM sandbox with mock DOM and execute app.js functions
                const sandbox = {
                    console,
                    Date,
                    Math,
                    Array,
                    Object,
                    Set,
                    String,
                    Number,
                    Boolean,
                    JSON,
                    parseInt,
                    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ slots: [], days: ['Monday'], periods: [1,2,3,4,5,6,7], classes: [], faculty: [], departments: [], details: [] }) }),
                    window: {},
                    document: {}
                };
                const env = createMockEnvironment(hodUser);
                sandbox.window = env.window;
                sandbox.document = env.document;

                vm.createContext(sandbox);
                vm.runInContext(appCode, sandbox);

                // Set user session in state and navigate to feature view
                vm.runInContext(`
                    window.__testSwipeNavigation.setUser(${JSON.stringify(hodUser)});
                    window.__testSwipeNavigation.showView('${featureView}');
                `, sandbox);

                assert.strictEqual(env.getCurrentHash(), '#' + featureView);

                // Simulate swipe left gesture (drag left deltaX = -120px)
                vm.runInContext(`
                    window.__testSwipeNavigation.handleSwipeStart(300, 200, { closest: () => null });
                    window.__testSwipeNavigation.handleSwipeEnd(150, 205, { closest: () => null });
                `, sandbox);

                assert.strictEqual(env.getCurrentHash(), '#dashboard', `Must navigate to #dashboard from #${featureView}`);
                assert.ok(env.getActiveViews().includes('view-dashboard'), 'view-dashboard must be active');
                assert.strictEqual(env.getHodDisplay(), 'flex', 'HOD overview banner must be displayed');
                assert.strictEqual(env.getCurrentHref(), 'http://localhost:3001/dashboard#dashboard', 'Must NOT redirect to public /');
            });
        }
    }

    console.log('\n[3] Test Suite: Authenticated Faculty Swipe-Left Navigation');
    {
        const facultyUser = { id: 10, name: 'Prof. Ramesh', role: 'faculty', department: 'CME' };
        const facultyViewsToTest = [
            'schedule',
            'my-attendance',
            'my-invigilation',
            'request-invigilation',
            'faculty-substitutions',
            'availability',
            'timetable'
        ];

        for (const featureView of facultyViewsToTest) {
            check(`Faculty swiping left on #${featureView} navigates to Faculty Dashboard (#dashboard)`, () => {
                const sandbox = {
                    console,
                    Date,
                    Math,
                    Array,
                    Object,
                    Set,
                    String,
                    Number,
                    Boolean,
                    JSON,
                    parseInt,
                    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ slots: [], days: ['Monday'], periods: [1,2,3,4,5,6,7], classes: [], faculty: [], departments: [], details: [] }) }),
                    window: {},
                    document: {}
                };
                const env = createMockEnvironment(facultyUser);
                sandbox.window = env.window;
                sandbox.document = env.document;

                vm.createContext(sandbox);
                vm.runInContext(appCode, sandbox);

                vm.runInContext(`
                    window.__testSwipeNavigation.setUser(${JSON.stringify(facultyUser)});
                    window.__testSwipeNavigation.showView('${featureView}');
                `, sandbox);

                // Simulate swipe left
                vm.runInContext(`
                    window.__testSwipeNavigation.handleSwipeStart(300, 200, { closest: () => null });
                    window.__testSwipeNavigation.handleSwipeEnd(150, 205, { closest: () => null });
                `, sandbox);

                assert.strictEqual(env.getCurrentHash(), '#dashboard', `Faculty must return to #dashboard from #${featureView}`);
                assert.ok(env.getActiveViews().includes('view-dashboard'), 'view-dashboard must be active');
                assert.strictEqual(env.getHodDisplay(), 'none', 'HOD overview banner must NOT be displayed for faculty');
                assert.strictEqual(env.getStdDisplay(), '', 'Standard faculty dashboard must be visible');
                assert.strictEqual(env.getCurrentHref(), 'http://localhost:3001/dashboard#dashboard', 'Must NOT redirect to public /');
            });
        }
    }

    console.log('\n[4] Test Suite: Unauthenticated / Public Guest User Swipe-Left');
    {
        check('Unauthenticated guest swiping left navigates to public landing page (/)', () => {
            const sandbox = {
                console,
                Date,
                Math,
                Array,
                Object,
                Set,
                String,
                Number,
                Boolean,
                JSON,
                parseInt,
                fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ slots: [], days: ['Monday'], periods: [1,2,3,4,5,6,7], classes: [], faculty: [], departments: [], details: [] }) }),
                window: {},
                document: {}
            };
            const env = createMockEnvironment(null);
            sandbox.window = env.window;
            sandbox.document = env.document;

            vm.createContext(sandbox);
            vm.runInContext(appCode, sandbox);

            vm.runInContext(`
                window.__testSwipeNavigation.setUser(null);
                window.__testSwipeNavigation.handleSwipeStart(300, 200, { closest: () => null });
                window.__testSwipeNavigation.handleSwipeEnd(150, 205, { closest: () => null });
            `, sandbox);

            assert.strictEqual(env.getCurrentHref(), '/', 'Unauthenticated guest must redirect to /');
        });
    }

    console.log('\n[5] Test Suite: Non-Interference with Form Controls & Horizontal Scroll');
    {
        check('Swipe starting inside form controls (input, select, button) does not trigger navigation', () => {
            const hodUser = { id: 1, name: 'Dr. HOD CME', role: 'hos', department: 'CME' };
            const sandbox = {
                console,
                Date,
                Math,
                Array,
                Object,
                Set,
                String,
                Number,
                Boolean,
                JSON,
                parseInt,
                fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ slots: [], days: ['Monday'], periods: [1,2,3,4,5,6,7], classes: [], faculty: [], departments: [], details: [] }) }),
                window: {},
                document: {}
            };
            const env = createMockEnvironment(hodUser);
            sandbox.window = env.window;
            sandbox.document = env.document;

            vm.createContext(sandbox);
            vm.runInContext(appCode, sandbox);

            vm.runInContext(`
                window.__testSwipeNavigation.setUser(${JSON.stringify(hodUser)});
                window.__testSwipeNavigation.showView('timetable');
                // Target is an input field
                const inputTarget = { closest: (sel) => sel.includes('input') ? {} : null };
                window.__testSwipeNavigation.handleSwipeStart(300, 200, inputTarget);
                window.__testSwipeNavigation.handleSwipeEnd(150, 205, inputTarget);
            `, sandbox);

            assert.strictEqual(env.getCurrentHash(), '#timetable', 'Must remain on #timetable when interacting with input controls');
        });

        check('Horizontal scroll inside timetable table does not trigger swipe navigation', () => {
            const hodUser = { id: 1, name: 'Dr. HOD CME', role: 'hos', department: 'CME' };
            const sandbox = {
                console,
                Date,
                Math,
                Array,
                Object,
                Set,
                String,
                Number,
                Boolean,
                JSON,
                parseInt,
                fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ slots: [], days: ['Monday'], periods: [1,2,3,4,5,6,7], classes: [], faculty: [], departments: [], details: [] }) }),
                window: {},
                document: {}
            };
            const env = createMockEnvironment(hodUser);
            sandbox.window = env.window;
            sandbox.document = env.document;

            vm.createContext(sandbox);
            vm.runInContext(appCode, sandbox);

            vm.runInContext(`
                window.__testSwipeNavigation.setUser(${JSON.stringify(hodUser)});
                window.__testSwipeNavigation.showView('timetable');
                // Scrollable container with un-scrolled content to the right
                const scrollContainer = { scrollWidth: 1200, clientWidth: 800, scrollLeft: 100 };
                const tableTarget = { closest: (sel) => sel.includes('table-scroll') ? scrollContainer : null };
                window.__testSwipeNavigation.handleSwipeStart(300, 200, tableTarget);
                window.__testSwipeNavigation.handleSwipeEnd(150, 205, tableTarget);
            `, sandbox);

            assert.strictEqual(env.getCurrentHash(), '#timetable', 'Must remain on #timetable when scrolling horizontally');
        });
    }

    console.log('\n[6] Test Suite: Branch Settings Removal & #about Redirect');
    {
        check('Direct navigation to #about redirects safely to HOD Dashboard (#dashboard)', () => {
            const hodUser = { id: 1, name: 'Dr. HOD CME', role: 'hos', department: 'CME' };
            const sandbox = {
                console,
                Date,
                Math,
                Array,
                Object,
                Set,
                String,
                Number,
                Boolean,
                JSON,
                parseInt,
                fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ slots: [], days: ['Monday'], periods: [1,2,3,4,5,6,7], classes: [], faculty: [], departments: [], details: [] }) }),
                window: {},
                document: {}
            };
            const env = createMockEnvironment(hodUser);
            sandbox.window = env.window;
            sandbox.document = env.document;

            vm.createContext(sandbox);
            vm.runInContext(appCode, sandbox);

            vm.runInContext(`
                window.__testSwipeNavigation.setUser(${JSON.stringify(hodUser)});
                window.__testSwipeNavigation.showView('about');
            `, sandbox);

            assert.strictEqual(env.getCurrentHash(), '#dashboard', 'Accessing #about must safely redirect to #dashboard');
            assert.ok(env.getActiveViews().includes('view-dashboard'), 'view-dashboard must be active');
        });
    }

    const { passed, failed } = counts();
    console.log('\n============================================================');
    console.log(`Swipe / Gesture Navigation Verification: ${passed} passed, ${failed} failed.`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

run();
