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
        health: '/api/health'
    };

    var state = {
        meta: null,
        grids: {},          // rendered grid metadata, keyed by container id
        selected: {},       // selected coordinate, keyed by container id
        requestToken: 0,
        pendingImport: null
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

    // ------------------------------------------------------- navigation
    var TITLES = {
        dashboard: 'Dashboard',
        timetable: 'Primary Timetable',
        availability: 'Faculty Availability',
        substitute: 'Substitute / Adjustment',
        import: 'Timetable Import',
        faculty: 'Faculty Management',
        reports: 'Availability Summary',
        about: 'Settings / About'
    };

    function showView(name) {
        Array.prototype.forEach.call(document.querySelectorAll('.view'), function (section) {
            section.classList.toggle('is-active', section.id === 'view-' + name);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
            button.classList.toggle('is-active', button.dataset.view === name);
        });
        el('viewTitle').textContent = TITLES[name] || 'Dashboard';

        if (name === 'faculty') loadFacultyTable();
        if (name === 'reports') loadReports();
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
                button.setAttribute('aria-label',
                    day + ' Period ' + period +
                    (cell.subject ? ' — ' + cell.subject + (cell.faculty ? ', ' + cell.faculty : '') : ' — free'));

                if (cell.subject) {
                    button.innerHTML =
                        '<div class="slot-subject">' + esc(cell.subject) + '</div>' +
                        (cell.faculty ? '<div class="slot-faculty">' + esc(cell.faculty) + '</div>' : '') +
                        (cell.room ? '<div class="slot-room">' + esc(cell.room) + '</div>' : '');
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

        var listHtml;
        if (!result.availableFaculty.length) {
            listHtml = notice('No faculty are free during this period.', 'warn');
        } else {
            listHtml = '<ul class="faculty-list">' + result.available.map(function (f) {
                return '<li><span class="tick">✓</span>' + esc(f.faculty) +
                    '<span class="dept">' + esc(f.department || '') + '</span></li>';
            }).join('') + '</ul>';
        }

        container.innerHTML =
            '<div class="slot-title">' + esc(cell.day) + ' — Period ' + esc(cell.period) + '</div>' +
            '<div style="margin-top:8px;">' +
                '<div class="detail-row"><span class="detail-label">Class</span>' +
                    '<span class="detail-value">' + esc(cell.class || '—') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Subject</span>' +
                    '<span class="detail-value">' + esc(cell.subject || 'Free period') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Faculty</span>' +
                    '<span class="detail-value">' + esc(cell.faculty || '—') + '</span></div>' +
                (cell.room ? '<div class="detail-row"><span class="detail-label">Room</span>' +
                    '<span class="detail-value">' + esc(cell.room) + '</span></div>' : '') +
            '</div>' +
            '<div class="section-label">Available Faculty · ' + esc(result.totalAvailable) + '</div>' +
            listHtml +
            '<p class="readonly-note">Read-only. ' +
                (cell.faculty
                    ? 'Excluding ' + esc(cell.faculty) + ', '
                    : 'Of ') +
                esc(result.totalFaculty) + ' faculty were checked: ' +
                esc(result.totalAvailable) + ' free, ' + esc(result.totalBusy) + ' teaching. ' +
                'No substitute is assigned and nothing is saved.</p>';
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
            return res.body;
        }).catch(function () {
            if (token !== state.requestToken) return;
            if (container) container.innerHTML =
                notice('Could not reach the server. Check that it is running and try again.', 'error');
        });
    }

    // -------------------------------------------------------- dashboard
    function loadDashboard() {
        return getJson(API.summary).then(function (summary) {
            var busiest = summary.slots.slice().sort(function (a, b) { return a.available - b.available; })[0];
            el('dashboardStats').innerHTML = [
                { label: 'Total faculty', value: summary.totalFaculty, note: 'in the roster' },
                { label: 'Working days', value: summary.days.length, note: summary.days[0] + '–' + summary.days[summary.days.length - 1] },
                { label: 'Periods per day', value: summary.periods.length, note: 'P1–P' + summary.periods.length },
                { label: 'Classes', value: summary.classes.length, note: summary.classes.join(', ') || 'none' },
                { label: 'Tightest slot', value: busiest ? busiest.available : '—',
                  note: busiest ? ('free at ' + busiest.day + ' P' + busiest.period) : '' }
            ].map(function (s) {
                return '<div class="stat"><div class="stat-label">' + esc(s.label) + '</div>' +
                    '<div class="stat-value">' + esc(s.value) + '</div>' +
                    '<div class="stat-note">' + esc(s.note) + '</div></div>';
            }).join('');
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
                (warnings || notice('No validation warnings.', 'ok'));

            el('aboutOrigin').textContent = meta.origin;
            el('aboutLoaded').textContent = new Date(meta.loadedAt).toLocaleString();
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
                el('facBody').innerHTML = '<tr><td colspan="8" class="muted">No faculty match this filter.</td></tr>';
                return;
            }
            el('facBody').innerHTML = data.faculty.map(function (f) {
                return '<tr>' +
                    '<td class="mono">' + esc(f.id) + '</td>' +
                    '<td>' + esc(f.name) + '</td>' +
                    '<td>' + esc(f.department) + '</td>' +
                    '<td class="num"><span class="badge badge-busy">' + esc(f.busyPeriods) + '</span></td>' +
                    '<td class="num"><span class="badge badge-free">' + esc(f.freePeriods) + '</span></td>' +
                    '<td class="num">' + esc(f.totalPeriods) + '</td>' +
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
                    '</tbody></table></div>';
            });
        }).catch(function () {
            container.innerHTML = notice('Could not load that faculty timetable.', 'error');
        });
    }

    // ----------------------------------------------------------- import
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

        var table = '<div class="table-scroll" style="margin-top:12px;"><table class="data"><thead><tr>' +
            '<th>Faculty</th><th>Department</th>' +
            data.meta.days.flatMap(function (day) {
                return data.meta.periods.map(function (p) {
                    return '<th>' + esc(day.slice(0, 3)) + ' P' + esc(p) + '</th>';
                });
            }).join('') + '</tr></thead><tbody>' +
            data.preview.map(function (row) {
                return '<tr><td>' + esc(row.faculty) + '</td><td>' + esc(row.department) + '</td>' +
                    row.slots.map(function (slot) {
                        return slot.status === 'busy'
                            ? '<td>' + esc(slot.subject) + '</td>'
                            : '<td class="muted">free</td>';
                    }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';

        var actions = '<div class="controls" style="margin-top:14px;">' +
            (data.report.ok
                ? '<button type="button" class="btn" id="importConfirm">Load this timetable</button>'
                : '<span class="notice notice-error">Validation failed — this file cannot be loaded.</span>') +
            '<button type="button" class="btn btn-secondary" id="importCancel">Cancel</button></div>';

        return head + importReportHtml(data.report) + table + actions;
    }

    function sendImport(url) {
        var input = el('importFile');
        var file = input && input.files && input.files[0];
        if (!file) return Promise.resolve(null);

        var form = new FormData();
        form.append('timetable', file);
        if (el('importClass').value) form.append('defaultClass', el('importClass').value);

        return fetch(url, { method: 'POST', body: form }).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        });
    }

    function previewImport() {
        var container = el('importResult');
        var input = el('importFile');
        if (!input.files || !input.files[0]) {
            container.innerHTML = notice('Choose an .xlsx or .csv file first.', 'warn');
            return;
        }
        container.innerHTML = notice('Reading ' + input.files[0].name + '…', 'info');

        sendImport(API.importPreview).then(function (res) {
            if (!res) return;
            if (!res.ok) {
                container.innerHTML = notice((res.body && res.body.error) || 'Import failed.', 'error') +
                    (res.body && res.body.report ? importReportHtml(res.body.report) : '');
                return;
            }
            state.pendingImport = true;
            container.innerHTML = importPreviewHtml(res.body);

            var confirmBtn = el('importConfirm');
            if (confirmBtn) confirmBtn.addEventListener('click', commitImport);
            el('importCancel').addEventListener('click', function () {
                state.pendingImport = null;
                container.innerHTML = '';
                input.value = '';
            });
        }).catch(function () {
            container.innerHTML = notice('Could not reach the server while importing.', 'error');
        });
    }

    function commitImport() {
        var container = el('importResult');
        container.innerHTML = notice('Loading timetable…', 'info');

        sendImport(API.importCommit).then(function (res) {
            if (!res.ok) {
                container.innerHTML = notice(
                    ((res.body && res.body.error) || 'Import failed.') +
                    ' The previous timetable is still loaded.', 'error');
                return;
            }
            state.pendingImport = null;
            el('importFile').value = '';
            container.innerHTML = notice(
                'Timetable loaded from ' + res.body.filename + '. Availability now uses this data.', 'ok');
            return bootstrap();
        }).catch(function () {
            container.innerHTML = notice('Could not reach the server while importing.', 'error');
        });
    }

    // -------------------------------------------------------- bootstrap
    function bootstrap() {
        return getJson(API.meta).then(function (meta) {
            state.meta = meta;

            el('topbarMeta').innerHTML =
                esc(meta.title || 'Timetable') + ' · ' +
                esc(meta.facultyCount) + ' faculty · ' +
                esc(meta.days.length) + ' days × ' + esc(meta.periods.length) + ' periods';

            fillSelect(el('dashDay'), meta.days, meta.days[0]);
            fillSelect(el('dashPeriod'), meta.periods.map(function (p) {
                return { value: p, label: 'Period ' + p };
            }), meta.periods[0]);
            fillSelect(el('subDay'), meta.days, meta.days[0]);

            var views = meta.classes.map(function (c) {
                return { value: 'class:' + c, label: 'Class — ' + c };
            });
            fillSelect(el('ttView'), views, 'class:' + meta.primaryClass);

            return Promise.all([
                getJson(API.faculty),
                getJson(API.departments),
                loadDashboard(),
                loadSourceCard(),
                getJson(API.health)
            ]);
        }).then(function (results) {
            var facultyData = results[0];
            var departments = results[1].departments;
            var health = results[4];

            el('aboutPort').textContent = String(health.port);

            fillSelect(el('subFaculty'), facultyData.faculty.map(function (f) {
                return { value: f.name, label: f.name + ' (' + f.department + ')' };
            }));
            fillSelect(el('facDept'), [{ value: '', label: 'All departments' }].concat(departments));
            fillSelect(el('availDept'), [{ value: '', label: 'All departments' }].concat(departments));

            var viewValue = el('ttView').value || '';
            var query = viewValue.indexOf('class:') === 0
                ? '?class=' + encodeURIComponent(viewValue.slice(6)) : '';

            return Promise.all([
                loadGrid(query, 'ttHead', 'ttBody', function (cell) {
                    showView('availability');
                    var target = document.querySelector('#availBody .slot-btn[data-key="' + cell.day + '|' + cell.period + '"]');
                    if (target) target.click();
                }).then(function () { el('ttState').style.display = 'none'; }),
                loadGrid(query, 'availHead', 'availBody', function (cell) {
                    checkAvailability(cell, 'availResult', {
                        department: el('availDept').value,
                        search: el('availSearch').value
                    });
                }),
                loadFacultyTable()
            ]);
        }).catch(function (err) {
            var state = el('ttState');
            if (state) {
                state.style.display = 'block';
                state.className = 'notice notice-error';
                state.textContent = 'Could not load the timetable: ' + err.message;
            }
        });
    }

    // ------------------------------------------------------------ wiring
    document.addEventListener('DOMContentLoaded', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
            button.addEventListener('click', function () { showView(button.dataset.view); });
        });

        el('dashCheck').addEventListener('click', function () {
            checkAvailability({
                day: el('dashDay').value,
                period: parseInt(el('dashPeriod').value, 10),
                subject: null, faculty: null, class: null
            }, 'dashResult');
        });

        el('ttView').addEventListener('change', function () {
            var value = el('ttView').value;
            var query = value.indexOf('class:') === 0 ? '?class=' + encodeURIComponent(value.slice(6)) : '';
            loadGrid(query, 'ttHead', 'ttBody', function (cell) {
                showView('availability');
                var target = document.querySelector('#availBody .slot-btn[data-key="' + cell.day + '|' + cell.period + '"]');
                if (target) target.click();
            });
            loadGrid(query, 'availHead', 'availBody', function (cell) {
                checkAvailability(cell, 'availResult', {
                    department: el('availDept').value, search: el('availSearch').value
                });
            });
        });

        ['availDept', 'availSearch'].forEach(function (id) {
            el(id).addEventListener('change', function () {
                var key = state.selected.availBody;
                if (!key) return;
                var button = document.querySelector('#availBody .slot-btn[data-key="' + key + '"]');
                if (button) button.click();
            });
        });

        el('facDept').addEventListener('change', loadFacultyTable);
        el('facSearch').addEventListener('input', loadFacultyTable);
        el('subFind').addEventListener('click', findCover);
        el('importPreview').addEventListener('click', previewImport);

        bootstrap();
    });
})();
