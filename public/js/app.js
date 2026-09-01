/**
 * TecSubstitution dashboard.
 *
 * The browser holds no timetable data of its own: every grid, roster and
 * summary is fetched from the API, so there is one source of truth.
 *
 * Clicking a timetable cell posts that cell's day and period to
 * /api/availability and renders the free faculty. Nothing is assigned or saved.
 */
(function () {
    'use strict';

    var API = {
        meta: '/api/timetable/meta',
        timetable: '/api/timetable',
        faculty: '/api/faculty',
        departments: '/api/faculty/departments',
        availability: '/api/availability',
        summary: '/api/availability/summary',
        importPreview: '/api/timetable/import/preview',
        importCommit: '/api/timetable/import',
        importFormats: '/api/timetable/import/formats',
        health: '/api/health',
        session: '/api/auth/session',
        logout: '/api/auth/logout'
    };

    var state = {
        meta: null,
        user: null,
        selected: {},       // selected coordinate, keyed by grid body id
        requestToken: 0,
        pendingImport: null,
        importFile: null,   // the File that Preview/Confirm will send
        faculty: [],
        formats: null,
        activity: [],
        attendance: {}
    };

    // ------------------------------------------------------------ helpers
    function el(id) { return document.getElementById(id); }

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function getJson(url) {
        return fetch(url).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) {
                    if (!res.ok) {
                        var err = new Error((body && body.error) || ('HTTP ' + res.status));
                        err.body = body;
                        err.status = res.status;
                        throw err;
                    }
                    return body;
                });
        });
    }

    function postJson(url, payload) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        });
    }

    function notice(message, kind) {
        return '<div class="notice notice-' + (kind || 'info') + '">' + esc(message) + '</div>';
    }

    function fillSelect(select, values, selected) {
        if (!select) return;
        select.innerHTML = values.map(function (v) {
            var value = typeof v === 'object' ? v.value : v;
            var label = typeof v === 'object' ? v.label : v;
            return '<option value="' + esc(value) + '"' +
                (String(value) === String(selected) ? ' selected' : '') + '>' + esc(label) + '</option>';
        }).join('');
    }

    function initials(name) {
        var parts = String(name || 'Guest')
            .replace(/^(Dr|Prof|Mr|Mrs|Ms)\.?\s+/i, '').trim().split(/\s+/);
        return ((parts[0] || 'G')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }

    // ----------------------------------------------------------- activity
    /** A session-local trail of what was looked up. Never sent to the server. */
    function logActivity(text) {
        state.activity.unshift({ text: text, at: new Date() });
        state.activity = state.activity.slice(0, 25);
        renderActivity();
    }

    function renderActivity() {
        var list = el('activityList');
        if (!list) return;
        if (!state.activity.length) {
            list.innerHTML = '<li class="activity-empty muted">No activity yet in this session.</li>';
            return;
        }
        list.innerHTML = state.activity.map(function (entry) {
            return '<li><span class="act-text">' + esc(entry.text) + '</span>' +
                '<span class="act-time">' + esc(entry.at.toLocaleTimeString()) + '</span></li>';
        }).join('');
    }

    // ------------------------------------------------------- navigation
    var TITLES = {
        dashboard: 'Dashboard',
        schedule: 'My Schedule',
        substitute: 'Adjust / Substitute',
        availability: 'Faculty Availability',
        import: 'Upload Paper Sheet',
        attendance: 'Attendance Track',
        timetable: 'Master Timetable',
        faculty: 'Faculty Directory',
        reports: 'Availability Summary',
        about: 'Settings / About'
    };

    var VIEW_NAMES = Object.keys(TITLES);

    /** Open the view named in the URL hash, so the home page can link into it. */
    function viewFromHash() {
        var name = (window.location.hash || '').replace(/^#/, '');
        return VIEW_NAMES.indexOf(name) >= 0 ? name : null;
    }

    function showView(name, updateHash) {
        Array.prototype.forEach.call(document.querySelectorAll('.view'), function (section) {
            section.classList.toggle('is-active', section.id === 'view-' + name);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (button) {
            button.classList.toggle('is-active', button.dataset.view === name);
        });
        el('viewTitle').textContent = TITLES[name] || 'Dashboard';

        if (name === 'faculty') loadFacultyTable();
        if (name === 'reports') loadReports();
        if (name === 'attendance') loadAttendance();
        if (name === 'schedule') loadSchedule();

        var sidebar = el('sidebar');
        if (sidebar) sidebar.classList.remove('is-open');

        if (updateHash !== false && window.location.hash !== '#' + name) {
            window.history.replaceState(null, '', '#' + name);
        }
    }

    // ---------------------------------------------------------- session
    function renderUser(session) {
        state.user = session && session.user ? session.user : null;
        var name = state.user ? state.user.name : 'Guest';
        var role = state.user
            ? (state.user.role === 'faculty' ? 'Faculty · ' + state.user.department : 'Coordinator')
            : (session && session.authRequired ? 'Sign-in required' : 'Not signed in');

        el('userName').textContent = name;
        el('userRole').textContent = role;
        el('userAvatar').textContent = initials(name);
        el('loginLink').hidden = Boolean(state.user);
        el('logoutBtn').hidden = !state.user;

        var about = el('aboutAuth');
        if (about) {
            about.textContent = (session && session.authRequired ? 'Required' : 'Optional') +
                ' — ' + (state.user ? 'signed in as ' + state.user.username : 'browsing as a guest');
        }
    }

    function loadSession() {
        return getJson(API.session).then(renderUser).catch(function () {
            renderUser(null);
        });
    }

    function logout() {
        return postJson(API.logout, {}).then(function () {
            window.location.href = '/login';
        });
    }

    // -------------------------------------------------------- timetable
    /**
     * Render a clickable grid. Every cell carries its own metadata in dataset
     * attributes, and clicking one calls onSelect with that metadata.
     */
    function renderGrid(headId, bodyId, grid, timings, onSelect) {
        var head = el(headId);
        var body = el(bodyId);
        if (!head || !body) return;

        var headHtml = '<tr><th class="day-col">Day</th>';
        grid.periods.forEach(function (period) {
            var timing = (timings || {})[String(period)] || {};
            headHtml += '<th>P' + esc(period) +
                (timing.start ? '<small>' + esc(timing.start) + '–' + esc(timing.end) + '</small>' : '') +
                '</th>';
        });
        head.innerHTML = headHtml + '</tr>';

        var byKey = {};
        grid.cells.forEach(function (cell) { byKey[cell.day + '|' + cell.period] = cell; });

        body.innerHTML = '';
        grid.days.forEach(function (day) {
            var row = document.createElement('tr');
            var dayCell = document.createElement('th');
            dayCell.className = 'day-col';
            dayCell.scope = 'row';
            dayCell.textContent = day;
            row.appendChild(dayCell);

            grid.periods.forEach(function (period) {
                var cell = byKey[day + '|' + period] || {
                    day: day, period: period, subject: null, faculty: null,
                    className: grid.name, room: null, status: 'free'
                };

                var td = document.createElement('td');
                td.className = 'slot';

                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'slot-btn' + (cell.subject ? '' : ' is-empty');
                button.setAttribute('data-key', day + '|' + period);
                button.setAttribute('data-day', cell.day);
                button.setAttribute('data-period', String(cell.period));
                button.setAttribute('data-subject', cell.subject || '');
                button.setAttribute('data-faculty', cell.faculty || '');
                button.setAttribute('data-class', cell.className || '');
                button.setAttribute('data-room', cell.room || '');
                button.setAttribute('data-status', cell.status || (cell.subject ? 'busy' : 'free'));
                button.setAttribute('title', day + ' · Period ' + period +
                    (cell.subject ? ' · ' + cell.subject : ' · free') + ' — click to check availability');
                button.setAttribute('aria-label',
                    day + ' Period ' + period +
                    (cell.subject ? ' — ' + cell.subject + (cell.faculty ? ', ' + cell.faculty : '') : ' — free'));

                if (cell.subject) {
                    button.innerHTML =
                        '<div class="slot-subject">' + esc(cell.subject) + '</div>' +
                        (cell.faculty ? '<div class="slot-faculty">' + esc(cell.faculty) + '</div>' : '') +
                        (cell.className && grid.view === 'faculty'
                            ? '<div class="slot-room">' + esc(cell.className) + (cell.room ? ' · ' + esc(cell.room) : '') + '</div>'
                            : (cell.room ? '<div class="slot-room">' + esc(cell.room) + '</div>' : ''));
                } else {
                    button.innerHTML = '<div class="slot-subject">Free</div>';
                }

                button.addEventListener('click', function () {
                    var container = body.id;
                    state.selected[container] = day + '|' + period;
                    Array.prototype.forEach.call(body.querySelectorAll('.slot-btn'), function (b) {
                        b.classList.toggle('is-selected', b.getAttribute('data-key') === day + '|' + period);
                    });
                    onSelect({
                        day: cell.day,
                        period: cell.period,
                        subject: cell.subject,
                        faculty: cell.faculty,
                        class: cell.className,
                        room: cell.room
                    });
                });

                td.appendChild(button);
                row.appendChild(td);
            });

            body.appendChild(row);
        });
    }

    function loadGrid(query, headId, bodyId, onSelect) {
        return getJson(API.timetable + (query || '')).then(function (grid) {
            renderGrid(headId, bodyId, grid, grid.periodTimings, onSelect);
            return grid;
        });
    }

    // ---------------------------------------------------- availability
    function renderAvailability(containerId, cell, result) {
        var container = el(containerId);
        if (!container) return;

        var freeHtml = result.availableFaculty.length
            ? '<ul class="faculty-list">' + result.available.map(function (f) {
                return '<li><span class="tick">✓</span>' + esc(f.faculty) +
                    '<span class="dept">' + esc(f.department || '') + '</span></li>';
            }).join('') + '</ul>'
            : notice('No faculty are free during this period.', 'warn');

        // Busy faculty are shown too, with what is keeping them occupied, so the
        // result can be checked rather than taken on trust.
        var busyHtml = result.busy.length
            ? '<ul class="faculty-list busy-list">' + result.busy.map(function (f) {
                var reason = [f.subject, f.className].filter(Boolean).join(' · ');
                return '<li><span class="cross">✗</span>' + esc(f.faculty) +
                    '<span class="dept">' + esc(reason || 'teaching') + '</span></li>';
            }).join('') + '</ul>'
            : '<p class="muted">Nobody else is teaching this period.</p>';

        container.innerHTML =
            '<div class="section-label">Selected slot</div>' +
            '<div class="slot-title">' + esc(cell.day) + ' — Period ' + esc(cell.period) + '</div>' +
            '<div style="margin-top:8px;">' +
                '<div class="detail-row"><span class="detail-label">Day</span>' +
                    '<span class="detail-value">' + esc(cell.day) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Period</span>' +
                    '<span class="detail-value">P' + esc(cell.period) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Class</span>' +
                    '<span class="detail-value">' + esc(cell.class || '—') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Subject</span>' +
                    '<span class="detail-value">' + esc(cell.subject || 'Free period') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Current Faculty</span>' +
                    '<span class="detail-value">' + esc(cell.faculty || '—') + '</span></div>' +
                (cell.room ? '<div class="detail-row"><span class="detail-label">Room</span>' +
                    '<span class="detail-value">' + esc(cell.room) + '</span></div>' : '') +
            '</div>' +
            '<div class="section-label">Available Substitute Faculty · ' +
                esc(result.totalAvailable) + '</div>' +
            freeHtml +
            '<div class="section-label">Busy Faculty · ' + esc(result.totalBusy) + '</div>' +
            busyHtml +
            // A class, not an id: this panel is rendered into more than one
            // container at a time, and ids must stay unique.
            '<div class="readonly-banner">' +
                'READ ONLY — No substitution has been assigned.</div>' +
            '<p class="readonly-note">' +
                (cell.faculty ? 'Excluding ' + esc(cell.faculty) + ', ' : 'Of ') +
                esc(result.totalFaculty) + ' faculty were checked: ' +
                esc(result.totalAvailable) + ' free, ' + esc(result.totalBusy) + ' teaching. ' +
                'Nothing was saved and no timetable was modified.</p>';
    }

    function checkAvailability(cell, containerId, extra) {
        var container = el(containerId);
        if (container) container.innerHTML = notice('Checking availability…', 'info');

        var token = ++state.requestToken;
        var payload = {
            day: cell.day,
            period: cell.period,
            subject: cell.subject,
            faculty: cell.faculty,
            class: cell.class
        };
        Object.keys(extra || {}).forEach(function (key) {
            if (extra[key]) payload[key] = extra[key];
        });

        return postJson(API.availability, payload).then(function (res) {
            if (token !== state.requestToken) return;
            if (!res.ok) {
                var message = (res.body && res.body.error) || ('Request failed (HTTP ' + res.status + ')');
                if (container) container.innerHTML = notice(message, 'error');
                return;
            }
            renderAvailability(containerId, cell, res.body);
            logActivity('Checked ' + cell.day + ' P' + cell.period +
                (cell.subject ? ' (' + cell.subject + ')' : '') +
                ' — ' + res.body.totalAvailable + ' free, ' + res.body.totalBusy + ' busy');
            return res.body;
        }).catch(function () {
            if (token !== state.requestToken) return;
            if (container) container.innerHTML =
                notice('Could not reach the server. Check that it is running and try again.', 'error');
        });
    }

    // -------------------------------------------------------- dashboard
    function statCard(s) {
        return '<div class="stat' + (s.tone ? ' is-' + s.tone : '') + '">' +
            '<div class="stat-label">' + esc(s.label) + '</div>' +
            '<div class="stat-value">' + esc(s.value) + '</div>' +
            '<div class="stat-note">' + esc(s.note || '') + '</div></div>';
    }

    /**
     * Stat cards. Every number comes from an API the project already has:
     * the availability summary, the timetable meta, and the faculty roster.
     */
    function loadDashboard(day, period) {
        var query = (day && period) ? '?day=' + encodeURIComponent(day) + '&period=' + encodeURIComponent(period) : '';
        return Promise.all([getJson(API.summary + query), getJson(API.meta)])
            .then(function (results) {
                var summary = results[0];
                var meta = results[1];
                var selected = summary.selected;
                var tightest = summary.slots.slice().sort(function (a, b) {
                    return a.available - b.available;
                })[0];
                var scheduled = summary.slots.reduce(function (sum, s) { return sum + s.busy; }, 0);
                var conflicts = (meta.warnings || []).length;

                el('dashboardStats').innerHTML = [
                    { label: 'Total faculty', value: summary.totalFaculty, note: 'in the roster', tone: 'brand' },
                    { label: 'Available faculty', value: selected ? selected.available : '—',
                      note: selected ? 'free at ' + selected.day + ' P' + selected.period : 'pick a slot', tone: 'ok' },
                    { label: 'Busy faculty', value: selected ? selected.busy : '—',
                      note: selected ? 'teaching at that slot' : 'pick a slot', tone: 'busy' },
                    { label: 'Timetable slots', value: summary.days.length * summary.periods.length,
                      note: summary.days.length + ' days × ' + summary.periods.length + ' periods' },
                    { label: 'Scheduled periods', value: scheduled, note: 'across ' + summary.classes.length + ' class(es)' },
                    { label: 'Conflicts', value: conflicts,
                      note: conflicts ? 'validator warnings — see below' : 'none reported',
                      tone: conflicts ? 'busy' : 'ok' },
                    { label: 'Tightest slot', value: tightest ? tightest.available : '—',
                      note: tightest ? 'free at ' + tightest.day + ' P' + tightest.period : '' }
                ].map(statCard).join('');
            });
    }

    function loadWorkloadCard() {
        return getJson(API.faculty).then(function (data) {
            state.faculty = data.faculty;
            var ranked = data.faculty.slice().sort(function (a, b) { return b.busyPeriods - a.busyPeriods; });
            var max = ranked.length ? ranked[0].busyPeriods || 1 : 1;

            el('workloadCard').innerHTML =
                '<div class="table-scroll"><table class="data"><thead><tr>' +
                '<th>Faculty</th><th>Dept</th><th class="num">Busy</th><th class="num">Free</th><th>Load</th>' +
                '</tr></thead><tbody>' +
                ranked.slice(0, 6).map(function (f) {
                    var pct = Math.round((f.busyPeriods / max) * 100);
                    return '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.department) + '</td>' +
                        '<td class="num"><span class="badge badge-busy">' + esc(f.busyPeriods) + '</span></td>' +
                        '<td class="num"><span class="badge badge-free">' + esc(f.freePeriods) + '</span></td>' +
                        '<td><span class="loadbar"><i style="width:' + pct + '%"></i></span></td></tr>';
                }).join('') +
                '</tbody></table></div>';
        });
    }

    function loadSourceCard() {
        return getJson(API.meta).then(function (meta) {
            var warnings = (meta.warnings || []).map(function (w) {
                return notice(w.message, 'warn');
            }).join('');
            el('dashSource').innerHTML =
                '<div class="detail-row"><span class="detail-label">Title</span>' +
                    '<span class="detail-value">' + esc(meta.title || '—') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Source</span>' +
                    '<span class="detail-value mono">' + esc(meta.origin) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Loaded</span>' +
                    '<span class="detail-value">' + esc(new Date(meta.loadedAt).toLocaleString()) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Primary</span>' +
                    '<span class="detail-value">' + esc(meta.primaryClass || '—') + '</span></div>' +
                '<div style="margin-top:12px;">' + (warnings || notice('No validation warnings.', 'ok')) + '</div>';

            el('aboutOrigin').textContent = meta.origin;
            el('aboutLoaded').textContent = new Date(meta.loadedAt).toLocaleString();
        });
    }

    // ------------------------------------------------------- my schedule
    function loadSchedule() {
        var select = el('schedFaculty');
        var name = select && select.value;
        if (!name) return Promise.resolve();

        var stateBox = el('schedState');
        stateBox.style.display = 'block';
        stateBox.className = 'notice notice-info';
        stateBox.textContent = 'Loading schedule…';

        return loadGrid('?faculty=' + encodeURIComponent(name), 'schedHead', 'schedBody', function (cell) {
            checkAvailability({
                day: cell.day, period: cell.period, subject: cell.subject,
                faculty: name, class: cell.class
            }, 'schedResult');
        }).then(function (grid) {
            var busy = grid.cells.filter(function (c) { return c.status === 'busy'; });
            var total = grid.days.length * grid.periods.length;
            var subjects = [];
            busy.forEach(function (c) { if (subjects.indexOf(c.subject) < 0) subjects.push(c.subject); });

            el('schedStats').innerHTML = [
                { label: 'Scheduled periods', value: busy.length, note: 'out of ' + total, tone: 'busy' },
                { label: 'Free periods', value: total - busy.length, note: 'available for cover', tone: 'ok' },
                { label: 'Subjects', value: subjects.length, note: subjects.slice(0, 3).join(', ') || '—' },
                { label: 'Working days', value: grid.days.length, note: grid.periods.length + ' periods per day' }
            ].map(statCard).join('');

            stateBox.style.display = 'none';
            el('schedResult').innerHTML =
                '<p class="muted">Select a period from the schedule above to see who could cover it.</p>';
        }).catch(function (err) {
            stateBox.style.display = 'block';
            stateBox.className = 'notice notice-error';
            stateBox.textContent = 'Could not load that schedule: ' + err.message;
        });
    }

    // ---------------------------------------------------------- faculty
    function loadFacultyTable() {
        var params = [];
        if (el('facDept').value) params.push('department=' + encodeURIComponent(el('facDept').value));
        if (el('facSearch').value) params.push('search=' + encodeURIComponent(el('facSearch').value));
        var url = API.faculty + (params.length ? '?' + params.join('&') : '');

        return getJson(url).then(function (data) {
            if (!data.faculty.length) {
                el('facBody').innerHTML =
                    '<tr><td colspan="9" class="muted">No faculty match this filter.</td></tr>';
                return;
            }
            el('facBody').innerHTML = data.faculty.map(function (f) {
                var pct = f.totalPeriods ? Math.round((f.busyPeriods / f.totalPeriods) * 100) : 0;
                return '<tr>' +
                    '<td class="mono">' + esc(f.id) + '</td>' +
                    '<td>' + esc(f.name) + '</td>' +
                    '<td>' + esc(f.department) + '</td>' +
                    '<td class="num"><span class="badge badge-busy">' + esc(f.busyPeriods) + '</span></td>' +
                    '<td class="num"><span class="badge badge-free">' + esc(f.freePeriods) + '</span></td>' +
                    '<td class="num">' + esc(f.totalPeriods) + '</td>' +
                    '<td><span class="loadbar" title="' + pct + '% of the week"><i style="width:' + pct + '%"></i></span></td>' +
                    '<td>' + esc(f.subjects.join(', ') || '—') + '</td>' +
                    '<td>' + esc(f.classes.join(', ') || '—') + '</td>' +
                    '</tr>';
            }).join('');
        });
    }

    // ---------------------------------------------------------- reports
    function loadReports() {
        return getJson(API.summary).then(function (summary) {
            var html = '<thead><tr><th>Day</th>' +
                summary.periods.map(function (p) { return '<th>P' + esc(p) + '</th>'; }).join('') +
                '</tr></thead><tbody>';

            summary.days.forEach(function (day) {
                html += '<tr><td class="day-name">' + esc(day) + '</td>';
                summary.periods.forEach(function (period) {
                    var slot = summary.slots.filter(function (s) {
                        return s.day === day && s.period === period;
                    })[0] || { available: 0, busy: 0 };
                    var kind = slot.available === 0 ? 'badge-busy' : 'badge-free';
                    html += '<td><span class="badge ' + kind + '">' + esc(slot.available) + '</span>' +
                        ' <span class="muted">/ ' + esc(summary.totalFaculty) + '</span></td>';
                });
                html += '</tr>';
            });

            el('heatTable').innerHTML = html + '</tbody>';
        });
    }

    // ------------------------------------------------------- substitute
    function findCover() {
        var facultyName = el('subFaculty').value;
        var day = el('subDay').value;
        var container = el('subResult');
        if (!facultyName || !day) return;

        container.innerHTML = notice('Looking up periods…', 'info');

        getJson(API.timetable + '?faculty=' + encodeURIComponent(facultyName)).then(function (grid) {
            var busy = grid.cells.filter(function (c) { return c.day === day && c.status === 'busy'; });
            if (!busy.length) {
                container.innerHTML = notice(
                    facultyName + ' has no scheduled periods on ' + day + '.', 'ok');
                return;
            }

            return Promise.all(busy.map(function (cell) {
                return postJson(API.availability, {
                    day: cell.day, period: cell.period,
                    subject: cell.subject, faculty: facultyName, class: cell.className
                }).then(function (res) { return { cell: cell, result: res.body }; });
            })).then(function (rows) {
                container.innerHTML =
                    '<div class="notice notice-info">' + esc(facultyName) + ' teaches ' +
                    rows.length + ' period(s) on ' + esc(day) +
                    '. Faculty free at each are listed below — nothing is assigned.</div>' +
                    '<div class="table-scroll" style="margin-top:12px;"><table class="data"><thead><tr>' +
                    '<th>Period</th><th>Subject</th><th>Class</th><th class="num">Free</th><th>Available faculty</th>' +
                    '</tr></thead><tbody>' +
                    rows.map(function (row) {
                        var names = row.result.availableFaculty;
                        return '<tr><td>P' + esc(row.cell.period) + '</td>' +
                            '<td>' + esc(row.cell.subject) + '</td>' +
                            '<td>' + esc(row.cell.className || '—') + '</td>' +
                            '<td class="num"><span class="badge ' +
                                (names.length ? 'badge-free' : 'badge-busy') + '">' + names.length + '</span></td>' +
                            '<td>' + (names.length ? esc(names.join(', ')) : '<span class="muted">nobody free</span>') + '</td>' +
                            '</tr>';
                    }).join('') +
                    '</tbody></table></div>' +
                    '<div class="readonly-banner">READ ONLY — No substitution has been assigned.</div>';
                logActivity('Listed cover for ' + facultyName + ' on ' + day);
            });
        }).catch(function () {
            container.innerHTML = notice('Could not load that faculty timetable.', 'error');
        });
    }

    // ------------------------------------------------------- attendance
    /**
     * Attendance marks. The server has no attendance store, so these live in
     * this browser only — the view says so, and nothing is ever posted.
     */
    var ATT_KEY = 'tecsub.attendance.v1';

    function loadAttendanceState() {
        try {
            state.attendance = JSON.parse(window.localStorage.getItem(ATT_KEY) || '{}');
        } catch (err) {
            state.attendance = {};
        }
    }

    function saveAttendanceState() {
        try {
            window.localStorage.setItem(ATT_KEY, JSON.stringify(state.attendance));
        } catch (err) { /* private mode — marks stay for this page view only */ }
    }

    function loadAttendance() {
        var day = el('attDay').value;
        var className = el('attClass').value;
        if (!day || !className) return Promise.resolve();

        return getJson(API.timetable + '?class=' + encodeURIComponent(className)).then(function (grid) {
            var rows = grid.cells
                .filter(function (c) { return c.day === day && c.status === 'busy'; })
                .sort(function (a, b) { return a.period - b.period; });

            if (!rows.length) {
                el('attBody').innerHTML =
                    '<tr><td colspan="6" class="muted">No scheduled periods for ' + esc(className) +
                    ' on ' + esc(day) + '.</td></tr>';
                el('attStats').innerHTML = '';
                return;
            }

            el('attBody').innerHTML = rows.map(function (cell) {
                var key = className + '|' + day + '|' + cell.period;
                var mark = state.attendance[key] || null;
                var label = mark === 'held' ? '<span class="badge badge-free">Held</span>'
                    : mark === 'missed' ? '<span class="badge badge-busy">Not held</span>'
                    : mark === 'substituted' ? '<span class="badge badge-neutral">Substituted</span>'
                    : '<span class="badge badge-muted">Unmarked</span>';

                return '<tr data-key="' + esc(key) + '">' +
                    '<td>P' + esc(cell.period) + '</td>' +
                    '<td>' + esc(cell.subject) + '</td>' +
                    '<td>' + esc(cell.faculty || '—') + '</td>' +
                    '<td>' + esc(cell.room || '—') + '</td>' +
                    '<td class="att-status">' + label + '</td>' +
                    '<td><span class="mark-group">' +
                        ['held', 'missed', 'substituted'].map(function (value) {
                            return '<button type="button" class="mark' + (mark === value ? ' is-on' : '') +
                                '" data-mark="' + value + '" data-key="' + esc(key) + '">' +
                                (value === 'held' ? 'Held' : value === 'missed' ? 'Not held' : 'Substituted') +
                                '</button>';
                        }).join('') +
                    '</span></td></tr>';
            }).join('');

            var counts = { held: 0, missed: 0, substituted: 0, unmarked: 0 };
            rows.forEach(function (cell) {
                var mark = state.attendance[className + '|' + day + '|' + cell.period];
                counts[mark || 'unmarked']++;
            });

            el('attStats').innerHTML = [
                { label: 'Scheduled', value: rows.length, note: className + ' · ' + day },
                { label: 'Held', value: counts.held, note: 'marked as taken', tone: 'ok' },
                { label: 'Not held', value: counts.missed, note: 'marked as missed', tone: 'busy' },
                { label: 'Unmarked', value: counts.unmarked, note: 'still to record' }
            ].map(statCard).join('');
        }).catch(function (err) {
            el('attBody').innerHTML =
                '<tr><td colspan="6" class="notice notice-error">Could not load attendance rows: ' +
                esc(err.message) + '</td></tr>';
        });
    }

    // ----------------------------------------------------------- import
    var WORKFLOW = ['upload', 'process', 'validate', 'preview', 'confirm', 'generate'];

    /** Move the Upload → … → Generate stepper to the given stage. */
    function workflowStep(name, failed) {
        var index = WORKFLOW.indexOf(name);
        Array.prototype.forEach.call(document.querySelectorAll('.wf-step'), function (step, i) {
            step.classList.toggle('is-done', i < index);
            step.classList.toggle('is-active', i === index && !failed);
        });
    }

    var PRESETS = {
        'CSE — Semester V': {
            className: 'CSE-A',
            text: [
                'Faculty,Monday P1,Monday P2,Monday P3,Tuesday P1,Tuesday P2,Tuesday P3',
                'Dr. Anand Rao,DBMS,FREE,FREE,FREE,DBMS,FREE',
                'Dr. Meera Nair,FREE,OS,FREE,FREE,FREE,OS',
                'Prof. Kiran Kumar,FREE,FREE,CN,CN,FREE,FREE',
                'Prof. Priya Sharma,FREE,FREE,FREE,FREE,FREE,FREE'
            ].join('\n')
        },
        'ECE — Semester III': {
            className: 'ECE-A',
            text: [
                'Faculty,Monday P1,Monday P2,Tuesday P1,Tuesday P2',
                'Dr. Deepa Iyer,Signals,FREE,FREE,Signals',
                'Prof. Naveen Reddy,FREE,Digital Electronics,Digital Electronics,FREE',
                'Dr. Latha Menon,FREE,FREE,EMT,FREE'
            ].join('\n')
        },
        'Long-form (Day / Period rows)': {
            className: 'CSE-B',
            text: [
                'Faculty,Day,Period,Subject,Class,Room',
                'Dr. Anand Rao,Monday,1,DBMS,CSE-B,B-201',
                'Dr. Meera Nair,Monday,2,OS,CSE-B,B-201',
                'Prof. Kiran Kumar,Tuesday,1,CN,CSE-B,B-201'
            ].join('\n')
        }
    };

    function renderPresets() {
        var grid = el('presetGrid');
        if (!grid) return;
        grid.innerHTML = Object.keys(PRESETS).map(function (name) {
            var lines = PRESETS[name].text.split('\n').length - 1;
            return '<button type="button" class="preset" data-preset="' + esc(name) + '">' +
                '<strong>' + esc(name) + '</strong>' +
                '<span>' + lines + ' faculty rows · class ' + esc(PRESETS[name].className) + '</span></button>';
        }).join('');
    }

    /**
     * Quick Paste: turn pasted rows into well-formed CSV so the *existing*
     * Excel/CSV importer, normalizer and validator handle it unchanged.
     * Tabs, semicolons and commas are all accepted as column separators.
     */
    function pastedTextToCsv(text) {
        var lines = String(text).replace(/\r/g, '').split('\n')
            .filter(function (line) { return line.trim() !== ''; });
        if (!lines.length) return '';

        var header = lines[0];
        var delimiter = header.indexOf('\t') >= 0 ? '\t'
            : (header.split(';').length > header.split(',').length ? ';' : ',');

        return lines.map(function (line) {
            return line.split(delimiter).map(function (field) {
                var value = field.trim();
                return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
            }).join(',');
        }).join('\n') + '\n';
    }

    function csvFile(text, name) {
        return new File([text], name, { type: 'text/csv' });
    }

    function importReportHtml(report) {
        var html = '';
        (report.errors || []).forEach(function (e) {
            html += notice('[' + e.code + '] ' + e.message, 'error');
        });
        (report.warnings || []).forEach(function (w) {
            html += notice('[' + w.code + '] ' + w.message, 'warn');
        });
        return html;
    }

    function importPreviewHtml(data) {
        var summary = data.report.summary || {};
        var head = '<div class="notice notice-' + (data.report.ok ? 'ok' : 'error') + '">' +
            esc(data.filename) + ' — read as <strong>' + esc(data.format) + '</strong> (' +
            esc(data.layout) + ' layout), ' + esc(data.rowCount) + ' row(s): ' +
            esc(summary.faculty) + ' faculty, ' + esc(summary.busySlots) + ' scheduled periods, ' +
            esc(summary.freeSlots) + ' free.</div>';

        var stats = '<div class="stats compact" style="margin-top:14px;">' + [
            { label: 'Faculty', value: summary.faculty, note: 'found in the sheet', tone: 'brand' },
            { label: 'Scheduled periods', value: summary.busySlots, note: 'to be loaded' },
            { label: 'Errors', value: (data.report.errors || []).length,
              note: data.report.ok ? 'none — safe to load' : 'must be fixed first',
              tone: data.report.ok ? 'ok' : 'busy' },
            { label: 'Warnings', value: (data.report.warnings || []).length, note: 'shown below' }
        ].map(statCard).join('') + '</div>';

        var table = '<div class="table-scroll" style="margin-top:14px;"><table class="data"><thead><tr>' +
            '<th>Faculty</th><th>Department</th>' +
            data.meta.days.reduce(function (cells, day) {
                return cells.concat(data.meta.periods.map(function (p) {
                    return '<th>' + esc(day.slice(0, 3)) + ' P' + esc(p) + '</th>';
                }));
            }, []).join('') + '</tr></thead><tbody>' +
            data.preview.map(function (row) {
                return '<tr><td>' + esc(row.faculty) + '</td><td>' + esc(row.department) + '</td>' +
                    row.slots.map(function (slot) {
                        return slot.status === 'busy'
                            ? '<td>' + esc(slot.subject) + '</td>'
                            : '<td class="muted">free</td>';
                    }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';

        var actions = '<div class="controls" style="margin-top:16px;">' +
            (data.report.ok
                ? '<button type="button" class="btn" id="importConfirm">Confirm &amp; generate timetable</button>'
                : '<span class="notice notice-error">Validation failed — this file cannot be loaded.</span>') +
            '<button type="button" class="btn btn-secondary" id="importCancel">Cancel</button></div>';

        return head + stats + importReportHtml(data.report) + table + actions;
    }

    function sendImport(url) {
        var file = state.importFile;
        if (!file) return Promise.resolve(null);

        var form = new FormData();
        form.append('timetable', file);
        var className = (el('importClass').value || el('pasteClass').value || '').trim();
        if (className) form.append('defaultClass', className);

        return fetch(url, { method: 'POST', body: form }).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        });
    }

    /** Formats the server actually accepts, so the UI never promises more. */
    function supportedExtensions() {
        return (state.formats && state.formats.supported) || ['.xlsx', '.csv'];
    }

    function unsupportedMessage(filename) {
        var ext = (String(filename).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        var supported = supportedExtensions().join(', ');
        if (/^\.(pdf|png|jpg|jpeg|webp)$/.test(ext)) {
            return 'This build reads structured timetables only (' + supported + '). ' +
                'Scanned ' + ext.slice(1).toUpperCase() + ' extraction needs an OCR key, which is not ' +
                'configured on this server — use Quick Paste to type or paste the sheet instead.';
        }
        return 'Unsupported file type "' + ext + '". Upload ' + supported + ', or use Quick Paste.';
    }

    function runPreview(container) {
        workflowStep('process');
        container.innerHTML = notice('Reading ' + state.importFile.name + '…', 'info');

        return sendImport(API.importPreview).then(function (res) {
            if (!res) return;
            workflowStep('validate');
            if (!res.ok) {
                workflowStep('validate', true);
                container.innerHTML = notice((res.body && res.body.error) || 'Import failed.', 'error') +
                    (res.body && res.body.report ? importReportHtml(res.body.report) : '');
                return;
            }
            state.pendingImport = true;
            workflowStep(res.body.report.ok ? 'preview' : 'validate', !res.body.report.ok);
            container.innerHTML = importPreviewHtml(res.body);
            logActivity('Previewed ' + res.body.filename + ' (' + res.body.rowCount + ' rows)');

            var confirmBtn = el('importConfirm');
            if (confirmBtn) confirmBtn.addEventListener('click', commitImport);
            el('importCancel').addEventListener('click', function () {
                state.pendingImport = null;
                state.importFile = null;
                container.innerHTML = '';
                el('importFile').value = '';
                workflowStep('upload');
            });
        }).catch(function () {
            workflowStep('process', true);
            container.innerHTML = notice('Could not reach the server while importing.', 'error');
        });
    }

    function previewImport() {
        var container = el('importResult');
        var input = el('importFile');
        if (!input.files || !input.files[0]) {
            container.innerHTML = notice(
                'Choose a file first (' + supportedExtensions().join(' or ') + ').', 'warn');
            return;
        }

        var file = input.files[0];
        var ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        if (supportedExtensions().indexOf(ext) < 0 && ext !== '.xlsm') {
            workflowStep('upload', true);
            container.innerHTML = notice(unsupportedMessage(file.name), 'warn');
            return;
        }

        state.importFile = file;
        runPreview(container);
    }

    function previewPaste() {
        var container = el('importResult');
        var text = el('pasteText').value;
        if (!text.trim()) {
            container.innerHTML = notice('Paste some timetable rows first.', 'warn');
            return;
        }
        var csv = pastedTextToCsv(text);
        if (csv.split('\n').filter(function (l) { return l.trim(); }).length < 2) {
            container.innerHTML = notice(
                'A pasted timetable needs a header row and at least one faculty row.', 'warn');
            return;
        }
        state.importFile = csvFile(csv, 'quick-paste.csv');
        runPreview(container);
    }

    function commitImport() {
        var container = el('importResult');
        workflowStep('confirm');
        container.innerHTML = notice('Loading timetable…', 'info');

        sendImport(API.importCommit).then(function (res) {
            if (!res.ok) {
                workflowStep('confirm', true);
                container.innerHTML = notice(
                    ((res.body && res.body.error) || 'Import failed.') +
                    ' The previous timetable is still loaded.', 'error');
                return;
            }
            state.pendingImport = null;
            state.importFile = null;
            el('importFile').value = '';
            workflowStep('generate');
            container.innerHTML = notice(
                'Timetable loaded from ' + res.body.filename + '. Availability now uses this data.', 'ok');
            logActivity('Loaded timetable from ' + res.body.filename);
            return bootstrap();
        }).catch(function () {
            workflowStep('confirm', true);
            container.innerHTML = notice('Could not reach the server while importing.', 'error');
        });
    }

    // -------------------------------------------------------- bootstrap
    function availabilityQuery() {
        var value = el('availClass').value || '';
        return value ? '?class=' + encodeURIComponent(value) : '';
    }

    function onAvailabilitySelect(cell) {
        checkAvailability(cell, 'availResult', {
            department: el('availDept').value,
            search: el('availSearch').value
        });
    }

    function jumpToAvailability(cell) {
        showView('availability');
        var target = document.querySelector(
            '#availBody .slot-btn[data-key="' + cell.day + '|' + cell.period + '"]');
        if (target) target.click();
    }

    function bootstrap() {
        return getJson(API.meta).then(function (meta) {
            state.meta = meta;

            el('topbarMeta').textContent =
                (meta.title || 'Timetable') + ' · ' +
                meta.facultyCount + ' faculty · ' +
                meta.days.length + ' days × ' + meta.periods.length + ' periods';

            fillSelect(el('dashDay'), meta.days, meta.days[0]);
            fillSelect(el('dashPeriod'), meta.periods.map(function (p) {
                return { value: p, label: 'Period ' + p };
            }), meta.periods[0]);
            fillSelect(el('subDay'), meta.days, meta.days[0]);
            fillSelect(el('attDay'), meta.days, meta.days[0]);
            fillSelect(el('attClass'), meta.classes, meta.primaryClass);
            fillSelect(el('availClass'), meta.classes, meta.primaryClass);

            var views = meta.classes.map(function (c) {
                return { value: 'class:' + c, label: 'Class — ' + c };
            });
            fillSelect(el('ttView'), views, 'class:' + meta.primaryClass);

            return Promise.all([
                getJson(API.faculty),
                getJson(API.departments),
                loadDashboard(meta.days[0], meta.periods[0]),
                loadSourceCard(),
                loadWorkloadCard(),
                getJson(API.health),
                getJson(API.importFormats).catch(function () { return null; })
            ]);
        }).then(function (results) {
            var facultyData = results[0];
            var departments = results[1].departments;
            var health = results[5];
            state.formats = results[6];

            el('aboutPort').textContent = String(health.port);

            var facultyOptions = facultyData.faculty.map(function (f) {
                return { value: f.name, label: f.name + ' (' + f.department + ')' };
            });
            fillSelect(el('subFaculty'), facultyOptions);

            // My Schedule defaults to the signed-in faculty member when there
            // is one, otherwise the first name in the roster.
            var mine = state.user && state.user.facultyName;
            fillSelect(el('schedFaculty'), facultyOptions,
                mine && facultyOptions.some(function (o) { return o.value === mine; })
                    ? mine : (facultyOptions[0] && facultyOptions[0].value));

            fillSelect(el('facDept'), [{ value: '', label: 'All departments' }].concat(departments));
            fillSelect(el('availDept'), [{ value: '', label: 'All departments' }].concat(departments));

            var viewValue = el('ttView').value || '';
            var query = viewValue.indexOf('class:') === 0
                ? '?class=' + encodeURIComponent(viewValue.slice(6)) : '';

            var note = el('formatNote');
            if (note && state.formats) {
                note.textContent = 'Accepted: ' + state.formats.supported.join(', ') +
                    ' · up to ' + state.formats.maxUploadMB + ' MB. ' +
                    'Scanned PDF/photo extraction is not configured on this server — use Quick Paste for those.';
            }

            return Promise.all([
                loadGrid(query, 'ttHead', 'ttBody', jumpToAvailability)
                    .then(function () { el('ttState').style.display = 'none'; }),
                loadGrid(availabilityQuery(), 'availHead', 'availBody', onAvailabilitySelect),
                loadFacultyTable()
            ]);
        }).catch(function (err) {
            var box = el('ttState');
            if (box) {
                box.style.display = 'block';
                box.className = 'notice notice-error';
                box.textContent = 'Could not load the timetable: ' + err.message;
            }
        });
    }

    // ------------------------------------------------------------ wiring
    document.addEventListener('DOMContentLoaded', function () {
        loadAttendanceState();
        renderPresets();
        renderActivity();

        Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (button) {
            button.addEventListener('click', function () { showView(button.dataset.view); });
        });

        var toggle = el('sidebarToggle');
        if (toggle) {
            toggle.addEventListener('click', function () { el('sidebar').classList.toggle('is-open'); });
        }

        el('logoutBtn').addEventListener('click', logout);
        el('sidebarLogout').addEventListener('click', logout);

        window.addEventListener('hashchange', function () {
            var name = viewFromHash();
            if (name) showView(name, false);
        });

        // --- dashboard
        el('dashCheck').addEventListener('click', function () {
            var day = el('dashDay').value;
            var period = parseInt(el('dashPeriod').value, 10);
            checkAvailability({ day: day, period: period, subject: null, faculty: null, class: null },
                'dashResult');
            loadDashboard(day, period);
        });
        el('clearActivity').addEventListener('click', function () {
            state.activity = [];
            renderActivity();
        });

        // --- master timetable
        el('ttView').addEventListener('change', function () {
            var value = el('ttView').value;
            var query = value.indexOf('class:') === 0 ? '?class=' + encodeURIComponent(value.slice(6)) : '';
            loadGrid(query, 'ttHead', 'ttBody', jumpToAvailability);
        });

        // --- availability
        el('availClass').addEventListener('change', function () {
            loadGrid(availabilityQuery(), 'availHead', 'availBody', onAvailabilitySelect);
            el('availResult').innerHTML = '<p class="muted">Select a period from the timetable.</p>';
        });
        ['availDept', 'availSearch'].forEach(function (id) {
            el(id).addEventListener('change', function () {
                var key = state.selected.availBody;
                if (!key) return;
                var button = document.querySelector('#availBody .slot-btn[data-key="' + key + '"]');
                if (button) button.click();
            });
        });

        // --- my schedule
        el('schedFaculty').addEventListener('change', loadSchedule);

        // --- faculty directory
        el('facDept').addEventListener('change', loadFacultyTable);
        el('facSearch').addEventListener('input', loadFacultyTable);

        // --- substitute
        el('subFind').addEventListener('click', findCover);

        // --- import
        el('importPreview').addEventListener('click', previewImport);
        el('pastePreview').addEventListener('click', previewPaste);
        el('pasteClear').addEventListener('click', function () {
            el('pasteText').value = '';
            el('importResult').innerHTML = '';
            workflowStep('upload');
        });

        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
            tab.addEventListener('click', function () {
                Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
                    t.classList.toggle('is-active', t === tab);
                });
                Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (panel) {
                    panel.classList.toggle('is-active', panel.id === 'tab-' + tab.dataset.tab);
                });
            });
        });

        el('presetGrid').addEventListener('click', function (event) {
            var button = event.target.closest ? event.target.closest('.preset') : null;
            if (!button) return;
            var preset = PRESETS[button.dataset.preset];
            if (!preset) return;
            el('pasteText').value = preset.text;
            el('pasteClass').value = preset.className;
            document.querySelector('.tab[data-tab="paste"]').click();
            el('importResult').innerHTML = notice(
                'Loaded the "' + button.dataset.preset + '" preset into Quick Paste. ' +
                'Edit it if you need to, then process it.', 'info');
        });

        var dropzone = el('dropzone');
        if (dropzone) {
            ['dragenter', 'dragover'].forEach(function (name) {
                dropzone.addEventListener(name, function (event) {
                    event.preventDefault();
                    dropzone.classList.add('is-over');
                });
            });
            ['dragleave', 'drop'].forEach(function (name) {
                dropzone.addEventListener(name, function (event) {
                    event.preventDefault();
                    dropzone.classList.remove('is-over');
                });
            });
            dropzone.addEventListener('drop', function (event) {
                var files = event.dataTransfer && event.dataTransfer.files;
                if (!files || !files.length) return;
                el('importFile').files = files;
                previewImport();
            });
        }

        // --- attendance
        el('attDay').addEventListener('change', loadAttendance);
        el('attClass').addEventListener('change', loadAttendance);
        el('attBody').addEventListener('click', function (event) {
            var button = event.target.closest ? event.target.closest('.mark') : null;
            if (!button) return;
            var key = button.dataset.key;
            state.attendance[key] = state.attendance[key] === button.dataset.mark ? null : button.dataset.mark;
            if (!state.attendance[key]) delete state.attendance[key];
            saveAttendanceState();
            loadAttendance();
        });
        el('attReset').addEventListener('click', function () {
            var prefix = el('attClass').value + '|' + el('attDay').value + '|';
            Object.keys(state.attendance).forEach(function (key) {
                if (key.indexOf(prefix) === 0) delete state.attendance[key];
            });
            saveAttendanceState();
            loadAttendance();
        });

        var initial = viewFromHash();
        if (initial) showView(initial, false);

        loadSession().then(bootstrap);
    });
})();
