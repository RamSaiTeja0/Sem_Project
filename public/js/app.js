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
        entries: '/api/timetable/entries',
        entryReference: '/api/timetable/entries/reference',
        storage: '/api/storage',
        designations: '/api/faculty/designations',
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
        reference: null,     // form options for Add Timetable
        classMeta: {},       // class code -> department, semester, academic year
        editingId: null,     // entry currently loaded into the form
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

    function postJson(url, payload, method) {
        var options = { method: method || 'POST' };
        if (payload != null) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(payload);
        }
        return fetch(url, options).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        });
    }

    function setupPasswordToggle(btnId, inputId) {
        var btn = el(btnId);
        var input = el(inputId);
        if (!btn || !input) return;

        btn.addEventListener('click', function () {
            var isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';

            var eyeIcon = btn.querySelector('.eye-icon');
            var eyeOffIcon = btn.querySelector('.eye-off-icon');

            if (eyeIcon && eyeOffIcon) {
                eyeIcon.style.display = isPassword ? 'none' : 'block';
                eyeOffIcon.style.display = isPassword ? 'block' : 'none';
            }

            var label = isPassword ? 'Hide password' : 'Show password';
            btn.setAttribute('aria-label', label);
            btn.setAttribute('title', label);
        });
    }

    function validatePasswordStrict(pwd) {
        if (!pwd || typeof pwd !== 'string') return false;
        if (!/^[A-Za-z0-9_]+$/.test(pwd)) return false;
        return /[A-Za-z]/.test(pwd) && /[0-9]/.test(pwd) && /_/.test(pwd);
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
        availability: 'Faculty Availability',
        substitute: 'Adjust / Substitute',
        schedule: 'My Schedule',
        timetable: 'Master Timetable',
        faculty: 'Faculty Directory',
        manage: 'Add Timetable',
        import: 'Upload Timetable',
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

        if (name === 'faculty') { loadFacultyForm(); loadFacultyTable(); }
        if (name === 'schedule') loadSchedule();
        if (name === 'manage') { loadDocumentStatus(); loadManage(); }
        if (name === 'timetable') { applyTimetableDepartment(); }
        if (name === 'availability') { loadHOSAvailabilityForm(); applyAvailabilityDepartment(); }
        if (name === 'about') { loadBranchConfig(); }

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
            ? (state.user.role === 'faculty' ? 'Faculty · ' + state.user.department : (state.user.role === 'hos' ? 'HOS · ' + state.user.department : 'HOS / Coordinator'))
            : (session && session.authRequired ? 'Sign-in required' : 'Not signed in');

        el('userName').textContent = name;
        el('userRole').textContent = role;
        el('userAvatar').textContent = initials(name);

        if (el('loginLink')) el('loginLink').style.display = state.user ? 'none' : '';
        if (el('logoutBtn')) {
            el('logoutBtn').hidden = !state.user;
            el('logoutBtn').style.display = state.user ? '' : 'none';
        }

        var isFaculty = state.user && state.user.role === 'faculty';

        // Role-based navigation visibility
        if (el('navFaculty')) el('navFaculty').style.display = isFaculty ? 'none' : '';
        if (el('navManageLabel')) el('navManageLabel').style.display = isFaculty ? 'none' : '';
        if (el('navManage')) el('navManage').style.display = isFaculty ? 'none' : '';
        if (el('navImport')) el('navImport').style.display = isFaculty ? 'none' : '';
        if (el('navAbout')) el('navAbout').style.display = isFaculty ? 'none' : '';
        if (el('navSchedule')) el('navSchedule').style.display = isFaculty ? '' : 'none';

        var manageBtn = el('ttManageBtn');
        if (manageBtn) {
            manageBtn.style.display = isFaculty ? 'none' : '';
        }

        var facAddCard = el('facAddCard');
        if (facAddCard) {
            facAddCard.style.display = isFaculty ? 'none' : '';
        }

        var hosUploadCard = el('hosUploadCard');
        if (hosUploadCard) {
            hosUploadCard.style.display = isFaculty ? 'none' : '';
        }

        var deptCode = state.user ? state.user.department : 'Branch';
        var branchName = state.user ? (state.user.branchName || '') : '';
        var branchDisplay = deptCode ? (branchName && branchName !== deptCode ? deptCode + ' — ' + branchName : deptCode) : 'Branch';

        ['schedBranchBadge', 'availBranchBadge', 'facBranchBadge', 'facNewBranchBadge', 'ttBranchBadge', 'aboutBranchBadge'].forEach(function (id) {
            if (el(id)) el(id).textContent = deptCode;
        });
        if (el('facBranchInheritBadge')) el('facBranchInheritBadge').textContent = branchDisplay;

        var schedBadge = el('schedFacultyBadge');
        if (schedBadge) {
            schedBadge.textContent = state.user ? (state.user.facultyName || state.user.name) : '';
            schedBadge.style.display = isFaculty ? '' : 'none';
        }
        var schedWrap = el('schedFacultyWrap');
        if (schedWrap) {
            schedWrap.style.display = isFaculty ? 'none' : '';
        }

        // Faculty Profile Summary Card in My Timetable
        var profCard = el('schedProfileCard');
        if (profCard) {
            profCard.style.display = isFaculty ? 'block' : 'none';
            if (isFaculty && state.user) {
                if (el('schedProfName')) el('schedProfName').textContent = state.user.name || 'Faculty Member';
                if (el('schedProfBranch')) el('schedProfBranch').textContent = state.user.department || deptCode;
                if (el('schedProfPhone')) el('schedProfPhone').textContent = state.user.phone || '—';
                if (el('schedProfUsername')) el('schedProfUsername').textContent = state.user.username || '—';
                var subContainer = el('schedProfSubjects');
                if (subContainer) {
                    var subList = Array.isArray(state.user.subjects) ? state.user.subjects : [];
                    subContainer.innerHTML = subList.length
                        ? subList.map(function (s) {
                            return '<span class="badge badge-primary" style="font-size:0.75rem;">' + esc(s) + '</span>';
                        }).join('')
                        : '<span class="muted" style="font-size:0.75rem;">—</span>';
                }
            }
        }

        var about = el('aboutAuth');
        if (about) {
            about.textContent = (session && session.authRequired ? 'Required' : 'Optional') +
                ' — ' + (state.user ? 'signed in as ' + state.user.username : 'browsing as a guest');
        }

        loadBranchConfig();
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

    // -------------------------------------------------- branch configuration
    function loadBranchConfig() {
        var note = el('cfgBranchNote');
        return getJson('/api/branch').then(function (data) {
            var branch = data && data.branch ? data.branch : {};
            var bCode = branch.code || (state.user ? state.user.department : '');
            var bName = branch.name || (state.user ? state.user.branchName : '');
            var bDisplay = bCode ? (bName && bName !== bCode ? bCode + ' — ' + bName : bCode) : 'Branch';

            if (el('cfgBranchCode')) el('cfgBranchCode').value = branch.code || '';
            if (el('cfgBranchName')) el('cfgBranchName').value = branch.name || '';
            if (el('cfgBranchYear')) el('cfgBranchYear').value = branch.academicYear || '';
            if (el('cfgBranchSem')) el('cfgBranchSem').value = branch.semester || '';
            if (el('aboutBranchBadge')) el('aboutBranchBadge').textContent = bCode || 'Branch';
            if (el('facBranchInheritBadge')) el('facBranchInheritBadge').textContent = bDisplay;
            if (el('facNewBranchBadge')) el('facNewBranchBadge').textContent = bCode || 'Branch';

            var isFaculty = state.user && state.user.role === 'faculty';
            var actions = el('cfgBranchActions');
            if (actions) actions.style.display = isFaculty ? 'none' : '';
            if (el('cfgBranchName')) el('cfgBranchName').readOnly = isFaculty;
            if (el('cfgBranchYear')) el('cfgBranchYear').readOnly = isFaculty;
            if (el('cfgBranchSem')) el('cfgBranchSem').readOnly = isFaculty;
            if (note) {
                note.innerHTML = isFaculty
                    ? notice('Signed in as faculty (read-only view). Branch configuration can only be modified by the Head of Section (HOS).', 'info')
                    : '';
            }
        }).catch(function (err) {
            if (note) note.innerHTML = notice('Could not load branch configuration: ' + err.message, 'error');
        });
    }

    function saveBranchConfig(event) {
        event.preventDefault();
        var note = el('cfgBranchNote');
        var btn = el('cfgBranchSave');
        if (btn) btn.disabled = true;
        if (note) note.innerHTML = notice('Saving branch configuration…', 'info');

        var payload = {
            code: el('cfgBranchCode') ? el('cfgBranchCode').value.trim() : (state.user ? state.user.department : ''),
            name: el('cfgBranchName').value.trim(),
            academicYear: el('cfgBranchYear').value.trim(),
            semester: parseInt(el('cfgBranchSem').value, 10)
        };

        postJson('/api/branch', payload, 'PUT').then(function (res) {
            if (btn) btn.disabled = false;
            if (res.status >= 400) {
                if (note) note.innerHTML = notice((res.body && res.body.error) || 'Could not save branch configuration.', 'error');
                return;
            }
            if (note) note.innerHTML = notice('Branch configuration updated successfully.', 'ok');
            var branch = res.body.branch;
            if (branch && branch.code) {
                if (state.user) {
                    state.user.department = branch.code;
                    state.user.branchName = branch.name;
                }
                ['schedBranchBadge', 'availBranchBadge', 'facBranchBadge', 'facNewBranchBadge', 'facBranchInheritBadge', 'ttBranchBadge', 'aboutBranchBadge'].forEach(function (id) {
                    if (el(id)) el(id).textContent = branch.code;
                });
            }
        }).catch(function (err) {
            if (btn) btn.disabled = false;
            if (note) note.innerHTML = notice('Failed to save branch configuration: ' + err.message, 'error');
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

        var hasEntries = grid && grid.cells && grid.cells.some(function (c) { return Boolean(c.subject); });
        var box = el('ttState');
        if (box && headId === 'ttHead') {
            if (!hasEntries) {
                box.style.display = 'block';
                box.className = 'notice notice-info';
                box.textContent = 'No master timetable has been configured yet.';
            } else {
                box.style.display = 'none';
            }
        }

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
                var phoneHtml = f.phone
                    ? '<div class="faculty-phone"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</div>'
                    : '';
                return '<li><span class="tick">✓</span>' +
                    '<div class="faculty-main">' +
                        '<div class="faculty-name">' + esc(f.faculty) + '</div>' +
                        phoneHtml +
                    '</div>' +
                    '<span class="dept">' + esc(f.department || '') + '</span></li>';
            }).join('') + '</ul>'
            : notice('No faculty are free during this period.', 'warn');

        // Busy faculty are shown too, with what is keeping them occupied, so the
        // result can be checked rather than taken on trust.
        var busyHtml = result.busy.length
            ? '<ul class="faculty-list busy-list">' + result.busy.map(function (f) {
                var reason = [f.subject, f.className].filter(Boolean).join(' — ');
                var phoneHtml = f.phone
                    ? '<div class="faculty-phone"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</div>'
                    : '';
                return '<li><span class="cross">✗</span>' +
                    '<div class="faculty-main">' +
                        '<div class="faculty-name">' + esc(f.faculty) + '</div>' +
                        phoneHtml +
                        '<div class="busy-reason">Busy: ' + esc(reason || 'teaching') + (f.room ? ' (' + esc(f.room) + ')' : '') + '</div>' +
                    '</div>' +
                    (f.department ? '<span class="dept">' + esc(f.department) + '</span>' : '') +
                    '</li>';
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
                'READ ONLY — Manual Decision (No Auto-Assignment)</div>' +
            '<p class="readonly-note">' +
                'The HOS manually contacts and assigns the free faculty. The system does not automatically assign substitutes or alter the timetable. ' +
                (cell.faculty ? 'Excluding ' + esc(cell.faculty) + ', ' : 'Of ') +
                esc(result.totalFaculty) + ' faculty in ' + esc(result.branch || 'the branch') + ' were checked: ' +
                esc(result.totalAvailable) + ' free, ' + esc(result.totalBusy) + ' teaching.</p>';
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
    /**
     * One dashboard statistic. When `view` is set the card becomes a button
     * that opens that view — a real button, so it is keyboard reachable and
     * announced as an action rather than as static text.
     */
    function statCard(s) {
        var body =
            '<div class="stat-label">' + esc(s.label) + '</div>' +
            '<div class="stat-value">' + esc(s.value) + '</div>' +
            '<div class="stat-note">' + esc(s.note || '') + '</div>';
        var classes = 'stat' + (s.tone ? ' is-' + s.tone : '');

        if (!s.view) return '<div class="' + classes + '">' + body + '</div>';
        return '<button type="button" class="' + classes + '" data-stat-view="' + esc(s.view) + '"' +
            ' title="' + esc(s.linkLabel || 'Open') + '">' + body +
            '<span class="stat-link">' + esc(s.linkLabel || 'Open') + ' →</span></button>';
    }

    /**
     * Stat cards. Every number comes from an API the project already has:
     * the availability summary, the timetable meta, and the faculty roster.
     */
    function loadDashboard(day, period) {
        var query = (day && period) ? '?day=' + encodeURIComponent(day) + '&period=' + encodeURIComponent(period) : '';
        return Promise.all([
            getJson(API.summary + query),
            getJson(API.meta),
            // Distinct subjects actually on the timetable, counted from the
            // records rather than assumed from the roster.
            getJson(API.timetable + '/records?status=busy')
        ])
            .then(function (results) {
                var summary = results[0];
                var meta = results[1];
                var subjectCount = Object.keys((results[2].records || []).reduce(function (seen, r) {
                    if (r.subject) seen[r.subject] = true;
                    return seen;
                }, {})).length;
                var selected = summary.selected;
                var tightest = summary.slots.slice().sort(function (a, b) {
                    return a.available - b.available;
                })[0];
                var scheduled = summary.slots.reduce(function (sum, s) { return sum + s.busy; }, 0);
                var conflicts = (meta.warnings || []).length;

                el('dashboardStats').innerHTML = [
                    { label: 'Total faculty', value: summary.totalFaculty, note: 'in the roster', tone: 'brand',
                      view: 'faculty', linkLabel: 'Faculty directory' },
                    { label: 'Available faculty', value: selected ? selected.available : '—',
                      note: selected ? 'free at ' + selected.day + ' P' + selected.period : 'pick a slot', tone: 'ok',
                      view: 'availability', linkLabel: 'Faculty availability' },
                    { label: 'Busy faculty', value: selected ? selected.busy : '—',
                      note: selected ? 'teaching at that slot' : 'pick a slot', tone: 'busy',
                      view: 'availability', linkLabel: 'Faculty availability' },
                    { label: 'Total classes', value: summary.classes.length,
                      note: summary.classes.slice(0, 3).join(', ') +
                            (summary.classes.length > 3 ? ' + ' + (summary.classes.length - 3) + ' more' : ''),
                      view: 'timetable', linkLabel: 'Master timetable' },
                    { label: 'Total subjects', value: subjectCount, note: 'taught this semester',
                      view: 'manage', linkLabel: 'Timetable entries' },
                    { label: 'Timetable slots', value: summary.days.length * summary.periods.length,
                      note: summary.days.length + ' days × ' + summary.periods.length + ' periods',
                      view: 'reports', linkLabel: 'Availability summary' },
                    { label: 'Scheduled periods', value: scheduled, note: 'across ' + summary.classes.length + ' class(es)',
                      view: 'timetable', linkLabel: 'Master timetable' },
                    { label: 'Conflicts', value: conflicts,
                      note: conflicts ? 'validator warnings — see below' : 'none reported',
                      tone: conflicts ? 'busy' : 'ok',
                      view: 'validation', linkLabel: 'Validation report' },
                    { label: 'Tightest slot', value: tightest ? tightest.available : '—',
                      note: tightest ? 'free at ' + tightest.day + ' P' + tightest.period : '',
                      view: 'reports', linkLabel: 'Availability summary' }
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

    // ------------------------------------------------------- my timetable
    var schedRefData = null;
    function loadSchedEntryReferences() {
        if (schedRefData) return Promise.resolve(schedRefData);
        return getJson(API.entries + '/reference').then(function (data) {
            schedRefData = data;
            if (el('schedEntryClass')) {
                populateSelect(el('schedEntryClass'), (data.classes || []).map(function (c) {
                    return { value: c.code, label: c.code + (c.semester ? ' · Sem ' + c.semester : '') };
                }));
            }
            if (el('schedEntryDay')) {
                populateSelect(el('schedEntryDay'), (data.days || []).map(function (d) {
                    return { value: d, label: d };
                }));
            }
            if (el('schedEntryPeriod')) {
                populateSelect(el('schedEntryPeriod'), (data.periods || []).map(function (p) {
                    return { value: String(p), label: 'Period ' + p };
                }));
            }
            if (el('schedEntrySubject')) {
                populateSelect(el('schedEntrySubject'), (data.subjects || []).map(function (s) {
                    return { value: s.name, label: s.name };
                }));
            }
            return data;
        }).catch(function () {});
    }

    function fillSchedForm(cell) {
        if (!cell) {
            resetSchedForm();
            return;
        }
        loadSchedEntryReferences().then(function () {
            if (el('schedEntryDay')) el('schedEntryDay').value = cell.day || '';
            if (el('schedEntryPeriod')) el('schedEntryPeriod').value = String(cell.period || '');
            if (el('schedEntryClass') && (cell.className || cell.class)) el('schedEntryClass').value = cell.className || cell.class;
            if (el('schedEntrySubject') && cell.subject) el('schedEntrySubject').value = cell.subject;
            if (el('schedEntryRoom')) el('schedEntryRoom').value = cell.room || '';
            if (el('schedEntryType')) el('schedEntryType').value = cell.type || 'theory';

            var delBtn = el('schedDeleteBtn');
            var title = el('schedFormTitle');

            if (cell.subject) {
                getJson(API.entries + '/mine').then(function (res) {
                    var match = (res.entries || []).find(function (e) {
                        return e.day === cell.day && e.period === cell.period;
                    });
                    if (match && match.id) {
                        el('schedEntryId').value = String(match.id);
                        if (delBtn) delBtn.style.display = '';
                        if (title) title.textContent = 'Edit My Timetable Slot';
                    }
                }).catch(function () {});
            } else {
                el('schedEntryId').value = '';
                if (delBtn) delBtn.style.display = 'none';
                if (title) title.textContent = 'Add My Timetable Slot';
            }
        });
    }

    function resetSchedForm() {
        if (el('schedEntryId')) el('schedEntryId').value = '';
        if (el('schedEntryRoom')) el('schedEntryRoom').value = '';
        if (el('schedEntryNote')) el('schedEntryNote').innerHTML = '';
        var delBtn = el('schedDeleteBtn');
        if (delBtn) delBtn.style.display = 'none';
        var title = el('schedFormTitle');
        if (title) title.textContent = 'Add / Edit My Timetable Slot';
    }

    function schedNote(html, tone) {
        var box = el('schedEntryNote');
        if (!box) return;
        if (!html) { box.innerHTML = ''; return; }
        box.className = 'notice notice-' + (tone || 'info');
        box.innerHTML = html;
    }

    function saveSchedEntry(evt) {
        if (evt && evt.preventDefault) evt.preventDefault();
        var id = el('schedEntryId') ? el('schedEntryId').value : '';
        var payload = {
            class: el('schedEntryClass') ? el('schedEntryClass').value : '',
            day: el('schedEntryDay') ? el('schedEntryDay').value : '',
            period: el('schedEntryPeriod') ? parseInt(el('schedEntryPeriod').value, 10) : 1,
            subject: el('schedEntrySubject') ? el('schedEntrySubject').value : '',
            room: el('schedEntryRoom') ? el('schedEntryRoom').value : null,
            type: el('schedEntryType') ? el('schedEntryType').value : 'theory'
        };

        schedNote('Saving timetable slot…', 'info');
        var method = id ? 'PUT' : 'POST';
        var url = id ? (API.entries + '/mine/' + id) : (API.entries + '/mine');

        postJson(url, payload, method).then(function (res) {
            if (res.status >= 400) {
                schedNote(esc((res.body && res.body.error) || 'Could not save slot'), 'error');
                return;
            }
            schedNote('Slot saved successfully.', 'ok');
            loadSchedule();
        }).catch(function (err) {
            schedNote(esc(err.message || 'Could not save entry'), 'error');
        });
    }

    function deleteSchedEntry() {
        var id = el('schedEntryId') ? el('schedEntryId').value : '';
        if (!id) return;
        if (!window.confirm('Are you sure you want to remove this timetable slot?')) return;

        schedNote('Removing slot…', 'info');
        postJson(API.entries + '/mine/' + id, null, 'DELETE').then(function (res) {
            if (res.status >= 400) {
                schedNote(esc((res.body && res.body.error) || 'Could not remove slot'), 'error');
                return;
            }
            schedNote('Slot removed.', 'ok');
            resetSchedForm();
            loadSchedule();
        }).catch(function (err) {
            schedNote(esc(err.message || 'Could not remove entry'), 'error');
        });
    }

    function loadSchedule() {
        var isFaculty = state.user && state.user.role === 'faculty';
        var name = isFaculty
            ? (state.user.facultyName || state.user.name)
            : (el('schedFaculty') && el('schedFaculty').value);

        var badge = el('schedFacultyBadge');
        if (badge) {
            badge.textContent = name || '';
            badge.style.display = isFaculty ? '' : 'none';
        }
        var wrap = el('schedFacultyWrap');
        if (wrap) {
            wrap.style.display = isFaculty ? 'none' : '';
        }
        var branchBadge = el('schedBranchBadge');
        if (branchBadge && state.user) {
            branchBadge.textContent = state.user.department || 'Branch';
        }

        if (!name && !isFaculty) return Promise.resolve();

        var stateBox = el('schedState');
        stateBox.style.display = 'block';
        stateBox.className = 'notice notice-info';
        stateBox.textContent = 'Loading schedule…';

        var url = isFaculty ? '/api/timetable/mine' : (API.timetable + '?faculty=' + encodeURIComponent(name));

        return getJson(url).then(function (grid) {
            renderGrid('schedHead', 'schedBody', grid, grid.periodTimings, function (cell) {
                fillSchedForm(cell);
                checkAvailability({
                    day: cell.day, period: cell.period, subject: cell.subject,
                    faculty: name, class: cell.className || cell.class
                }, 'schedResult');
            });

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

            if (busy.length === 0) {
                stateBox.style.display = 'block';
                stateBox.className = 'notice notice-info';
                stateBox.textContent = 'No timetable has been configured yet.';
            } else {
                stateBox.style.display = 'none';
            }

            el('schedResult').innerHTML =
                '<p class="muted">Select a period from the schedule above to see who could cover it.</p>';

            loadSchedEntryReferences();
        }).catch(function (err) {
            stateBox.style.display = 'block';
            stateBox.className = 'notice notice-error';
            stateBox.textContent = 'Could not load that schedule: ' + err.message;
        });
    }

    // ------------------------------------------------------- HOS availability finder
    var hosAvailData = null;
    function loadHOSAvailabilityForm() {
        var branchBadge = el('availBranchBadge');
        if (branchBadge && state.user) {
            branchBadge.textContent = state.user.department || 'Branch';
        }

        return Promise.all([
            getJson(API.faculty),
            getJson(API.meta)
        ]).then(function (results) {
            var facultyData = results[0];
            var metaData = results[1];
            hosAvailData = { faculty: facultyData.faculty || [], meta: metaData };

            var facultyList = facultyData.faculty || [];
            var absentSelect = el('availAbsentFaculty');
            if (absentSelect) {
                if (facultyList.length === 0) {
                    absentSelect.innerHTML = '<option value="">No faculty has been configured yet</option>';
                } else {
                    absentSelect.innerHTML = facultyList.map(function (f) {
                        return '<option value="' + esc(f.name) + '">' + esc(f.name) +
                            (f.designation ? ' · ' + esc(f.designation) : '') + '</option>';
                    }).join('');
                }
            }

            var days = metaData.days || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
            var daySelect = el('availDay');
            if (daySelect) {
                daySelect.innerHTML = days.map(function (d) {
                    return '<option value="' + esc(d) + '">' + esc(d) + '</option>';
                }).join('');
            }

            var periods = metaData.periods || [1, 2, 3, 4, 5, 6, 7];
            var periodSelect = el('availPeriod');
            if (periodSelect) {
                periodSelect.innerHTML = periods.map(function (p) {
                    return '<option value="' + esc(p) + '">Period ' + esc(p) + '</option>';
                }).join('');
            }
        }).catch(function (err) {
            var resBox = el('availHOSResult');
            if (resBox) resBox.innerHTML = notice('Could not load faculty references: ' + err.message, 'error');
        });
    }

    function checkHOSAvailability() {
        var resBox = el('availHOSResult');
        if (!resBox) return;

        var absent = el('availAbsentFaculty') ? el('availAbsentFaculty').value : '';
        var day = el('availDay') ? el('availDay').value : '';
        var period = el('availPeriod') ? parseInt(el('availPeriod').value, 10) : 1;

        if (!absent) {
            resBox.innerHTML = notice('No faculty has been configured yet.', 'warn');
            return;
        }

        resBox.innerHTML = notice('Calculating faculty availability…', 'info');

        postJson('/api/availability', {
            absentFaculty: absent,
            day: day,
            period: period
        }).then(function (res) {
            if (!res.ok) {
                var err = (res.body && res.body.error) || ('HTTP ' + res.status);
                resBox.innerHTML = notice(err, 'error');
                return;
            }
            var data = res.body || {};
            var freeList = data.available || [];
            var busyList = data.busy || [];

            var absentHtml = data.absentFaculty
                ? '<div class="notice notice-warn" style="margin-bottom:14px;">' +
                    '<strong>Absent:</strong> ' + esc(data.absentFaculty.name) +
                    '<span class="muted" style="margin-left:8px;">(Excluded from available cover)</span>' +
                  '</div>'
                : '';

            var freeHtml = freeList.length
                ? '<ul class="faculty-list">' + freeList.map(function (f) {
                    return '<li><span class="tick">✓</span>' +
                        '<div class="faculty-main">' +
                            '<div class="faculty-name">' + esc(f.faculty || f.name) + '</div>' +
                            (f.phone ? '<div class="faculty-phone"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</div>' : '') +
                        '</div>' +
                        '<span class="badge badge-free">FREE</span>' +
                    '</li>';
                }).join('') + '</ul>'
                : '<p class="muted">No faculty are free during this period.</p>';

            var busyHtml = busyList.length
                ? '<ul class="faculty-list busy-list">' + busyList.map(function (f) {
                    var reason = [f.subject, f.className].filter(Boolean).join(' — ');
                    return '<li><span class="cross">✗</span>' +
                        '<div class="faculty-main">' +
                            '<div class="faculty-name">' + esc(f.faculty || f.name) + '</div>' +
                            '<div class="busy-reason">Busy: ' + esc(reason || 'teaching') + (f.room ? ' (' + esc(f.room) + ')' : '') + '</div>' +
                        '</div>' +
                        '<span class="badge badge-busy">BUSY</span>' +
                    '</li>';
                }).join('') + '</ul>'
                : '<p class="muted">No faculty are busy during this period.</p>';

            var emptyMsg = data.emptyState ? ('<div style="margin-bottom:12px;">' + notice(data.emptyState, 'info') + '</div>') : '';

            resBox.innerHTML =
                absentHtml +
                emptyMsg +
                '<div class="section-label">AVAILABLE FACULTY (' + freeList.length + ')</div>' +
                freeHtml +
                '<div class="section-label" style="margin-top:16px;">BUSY FACULTY (' + busyList.length + ')</div>' +
                busyHtml +
                '<div class="readonly-banner">READ ONLY — Availability Result</div>' +
                '<p class="readonly-note">This screen reports availability only. The system does not automatically assign or alter the timetable.</p>';
        }).catch(function (err) {
            resBox.innerHTML = notice(err.message || 'Could not calculate availability.', 'error');
        });
    }

    // ---------------------------------------------------------- faculty
    /** Human label for a faculty status code. */
    function statusLabel(status) {
        if (status === 'on_leave') return 'On leave';
        if (status === 'inactive') return 'Inactive';
        return 'Active';
    }

    function loadFacultyTable() {
        var params = [];
        if (el('facDept').value) params.push('department=' + encodeURIComponent(el('facDept').value));
        if (el('facSearch').value) params.push('search=' + encodeURIComponent(el('facSearch').value));

        // The slot selector is optional: with both halves chosen, the server
        // adds each faculty member's free/busy status at that exact period.
        var day = el('facSlotDay') ? el('facSlotDay').value : '';
        var period = el('facSlotPeriod') ? el('facSlotPeriod').value : '';
        if (day && period) {
            params.push('day=' + encodeURIComponent(day));
            params.push('period=' + encodeURIComponent(period));
        }
        var url = API.faculty + (params.length ? '?' + params.join('&') : '');

        return getJson(url).then(function (data) {
            var counter = el('facCount');
            if (counter) {
                counter.textContent = data.count + ' faculty member' + (data.count === 1 ? '' : 's') +
                    (data.slot ? ' · availability shown for ' + data.slot.day + ' P' + data.slot.period : '');
            }
            if (!data.faculty.length) {
                el('facBody').innerHTML =
                    '<tr><td colspan="13" class="muted">No faculty match this filter.</td></tr>';
                return;
            }
            el('facBody').innerHTML = data.faculty.map(function (f) {
                var pct = f.totalPeriods ? Math.round((f.busyPeriods / f.totalPeriods) * 100) : 0;

                var availability = '<span class="muted">—</span>';
                if (f.availability) {
                    availability = f.availability.status === 'free'
                        ? '<span class="badge badge-free">Free</span>'
                        : '<span class="badge badge-busy">Busy</span> ' +
                          '<span class="muted">' + esc(f.availability.subject || '') +
                          (f.availability.className ? ' · ' + esc(f.availability.className) : '') + '</span>';
                } else if (f.status && f.status !== 'active') {
                    availability = '<span class="badge badge-busy">' + esc(statusLabel(f.status)) + '</span>';
                }

                var phoneCell = f.phone
                    ? '<a href="tel:' + esc(f.phone.replace(/\s+/g, '')) + '" class="phone-link"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</a>'
                    : '<span class="muted">—</span>';

                var statusBadge = '<span class="badge ' + (f.status === 'active' ? 'badge-free' : 'badge-busy') + '">' +
                    esc(statusLabel(f.status)) + '</span>';

                return '<tr>' +
                    '<td class="mono">' + esc(f.id) + '</td>' +
                    '<td><strong>' + esc(f.name) + '</strong></td>' +
                    '<td>' + esc(f.department) + '</td>' +
                    '<td>' + esc(f.designation || '—') + '</td>' +
                    '<td>' + phoneCell + '</td>' +
                    '<td>' + (f.email
                        ? '<a href="mailto:' + esc(f.email) + '">' + esc(f.email) + '</a>'
                        : '<span class="muted">—</span>') + '</td>' +
                    '<td class="num"><span class="badge badge-busy">' + esc(f.busyPeriods) + '</span></td>' +
                    '<td class="num"><span class="badge badge-free">' + esc(f.freePeriods) + '</span></td>' +
                    '<td><span class="loadbar" title="' + pct + '% of the week' +
                        (f.maxWeeklyPeriods ? ', cap ' + esc(f.maxWeeklyPeriods) : '') +
                        '"><i style="width:' + pct + '%"></i></span></td>' +
                    '<td>' + availability + '</td>' +
                    '<td class="list" title="' + esc(f.subjects.join(', ')) + '">' +
                        esc(f.subjects.join(', ') || '—') + '</td>' +
                    '<td class="list" title="' + esc(f.classes.join(', ')) + '">' +
                        esc(f.classes.join(', ') || '—') + '</td>' +
                    '<td>' + statusBadge + '</td>' +
                    '</tr>';
            }).join('');
        });
    }
    // ------------------------------------------------------- add faculty
    function facultyNote(message, kind) {
        var box = el('facultyResult');
        if (!box) return;
        box.innerHTML = message
            ? '<div class="notice notice-' + (kind || 'info') + '">' + message + '</div>' : '';
    }

    function resetFacultyForm() {
        ['facNewName', 'facNewPhone', 'facNewUsername', 'facNewPassword', 'facNewConfirmPassword', 'facNewSubjects'].forEach(function (id) {
            if (el(id)) el(id).value = '';
        });
    }

    /** Populate the Add Faculty form and say whether saving is possible. */
    function loadFacultyForm() {
        return Promise.all([
            getJson(API.departments),
            getJson(API.designations).catch(function () { return { designations: [], statuses: ['active'] }; }),
            getJson(API.storage).catch(function () { return null; })
        ]).then(function (results) {
            var details = results[0].details || [];
            var bCode = (state.user ? state.user.department : '') || (details[0] ? details[0].code : '');
            var bName = (state.user ? state.user.branchName : '') || (details[0] ? details[0].name : '');
            var bDisplay = bCode ? (bName && bName !== bCode ? bCode + ' — ' + bName : bCode) : 'Branch';
            if (el('facBranchInheritBadge')) el('facBranchInheritBadge').textContent = bDisplay;
            if (el('facNewBranchBadge')) el('facNewBranchBadge').textContent = bCode || 'Branch';

            var storage = results[2];
            var editable = true;
            var chip = el('facultyBackend');
            if (chip) {
                chip.textContent = 'Active Instance Storage';
                chip.className = 'pill pill-ok';
            }
            var note = el('facultyStorageNote');
            if (note) note.innerHTML = '';
            el('facSave').disabled = false;
            return editable;
        });
    }

    function saveFaculty(event) {
        event.preventDefault();
        var name = el('facNewName') ? el('facNewName').value.trim() : '';
        var phone = el('facNewPhone') ? el('facNewPhone').value.trim() : '';
        var username = el('facNewUsername') ? el('facNewUsername').value.trim() : '';
        var password = el('facNewPassword') ? el('facNewPassword').value : '';
        var confirmPassword = el('facNewConfirmPassword') ? el('facNewConfirmPassword').value : '';
        var rawSubjects = el('facNewSubjects') ? el('facNewSubjects').value.trim() : '';
        var subjectsList = rawSubjects ? rawSubjects.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];

        if (!name || name.length < 2) {
            facultyNote('Full name is required (minimum 2 characters).', 'error');
            if (el('facNewName')) el('facNewName').focus();
            return;
        }
        if (!phone) {
            facultyNote('Phone number is required.', 'error');
            if (el('facNewPhone')) el('facNewPhone').focus();
            return;
        }
        if (!username || username.length < 3) {
            facultyNote('Username is required (minimum 3 characters).', 'error');
            if (el('facNewUsername')) el('facNewUsername').focus();
            return;
        }
        if (!password) {
            facultyNote('Password is required.', 'error');
            if (el('facNewPassword')) el('facNewPassword').focus();
            return;
        }
        if (!validatePasswordStrict(password)) {
            facultyNote('Password must contain at least one letter, one number, and one underscore (_). Allowed characters are only A-Z, a-z, 0-9, and _ (no dots, dashes or spaces).', 'error');
            if (el('facNewPassword')) el('facNewPassword').focus();
            return;
        }
        if (password !== confirmPassword) {
            facultyNote('Passwords do not match.', 'error');
            if (el('facNewConfirmPassword')) el('facNewConfirmPassword').focus();
            return;
        }
        if (subjectsList.length === 0) {
            facultyNote('At least one subject or area of expertise is required.', 'error');
            if (el('facNewSubjects')) el('facNewSubjects').focus();
            return;
        }

        var regPayload = {
            role: 'faculty',
            name: name,
            phone: phone,
            username: username,
            password: password,
            confirmPassword: confirmPassword,
            branchCode: state.user ? state.user.department : '',
            branchName: state.user ? state.user.branchName : '',
            subjects: subjectsList
        };

        var button = el('facSave');
        button.disabled = true;
        facultyNote('Creating faculty account…', 'info');

        postJson('/api/auth/register', regPayload).then(function (res) {
            button.disabled = false;
            if (res.status >= 400) {
                facultyNote(rejectionHtml(res.body), 'error');
                return;
            }
            var added = res.body.user;
            var branchText = added.department || (state.user ? state.user.department : '');

            // Display clear one-time success panel with credentials
            var panel = el('facultySuccessPanel');
            if (panel) {
                if (el('succFacName')) el('succFacName').textContent = added.name;
                if (el('succFacUsername')) el('succFacUsername').textContent = added.username;
                if (el('succFacPassword')) el('succFacPassword').textContent = password;
                if (el('succFacBranch')) el('succFacBranch').textContent = branchText;
                if (el('copyFeedback')) el('copyFeedback').textContent = '';
                panel.style.display = 'block';
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

            facultyNote('Faculty account created successfully for <strong>' + esc(added.name) + '</strong>.', 'ok');
            logActivity('Created faculty account for ' + added.name);
            resetFacultyForm();
            loadFacultyTable();
            loadDashboard();
            refreshDepartmentFilters();
        }).catch(function (err) {
            button.disabled = false;
            facultyNote('Could not create faculty account: ' + esc(err.message), 'error');
        });
    }

    /** Re-read the branch list after the roster changes, keeping selections. */
    function refreshDepartmentFilters() {
        return getJson(API.departments).then(function (data) {
            var options = (data.details || []).map(function (d) {
                return { value: d.code, label: d.code + ' (' + d.facultyCount + ')' };
            });
            [['facDept', 'All departments'], ['availDept', 'All departments']].forEach(function (pair) {
                var select = el(pair[0]);
                if (!select) return;
                var previous = select.value;
                fillSelect(select, [{ value: '', label: pair[1] }].concat(options), previous);
            });
        });
    }

    // -------------------------------------------------- validation report
    function loadValidation() {
        return getJson(API.meta).then(function (meta) {
            var warnings = meta.warnings || [];
            var chip = el('validationChip');
            if (chip) {
                chip.textContent = warnings.length
                    ? warnings.length + ' warning' + (warnings.length === 1 ? '' : 's')
                    : 'No issues';
                chip.className = 'pill ' + (warnings.length ? 'pill-warn' : 'pill-ok');
            }

            el('validationStats').innerHTML = [
                { label: 'Errors', value: 0, note: 'a loaded timetable has none by definition', tone: 'ok' },
                { label: 'Warnings', value: warnings.length,
                  note: warnings.length ? 'listed below' : 'none reported',
                  tone: warnings.length ? 'busy' : 'ok' },
                { label: 'Source', value: meta.origin || '—', note: 'where this timetable came from' },
                { label: 'Faculty', value: meta.facultyCount, note: 'in the loaded roster' }
            ].map(statCard).join('');

            if (!warnings.length) {
                el('validationBody').innerHTML =
                    '<div class="notice notice-ok">The loaded timetable raised no warnings. ' +
                    'No faculty member is double-booked, no room hosts two classes at once, ' +
                    'and every class covers its week.</div>';
                return;
            }

            el('validationBody').innerHTML =
                '<div class="notice notice-info">These are <strong>warnings</strong>, not errors. ' +
                'A timetable with errors is refused at load time, so anything listed here was ' +
                'accepted — it is reported so you can decide whether it is intended.</div>' +
                '<div class="table-scroll" style="margin-top:14px;"><table class="data"><thead><tr>' +
                '<th>Code</th><th>Detail</th></tr></thead><tbody>' +
                warnings.map(function (w) {
                    return '<tr><td class="mono">' + esc(w.code) + '</td><td>' + esc(w.message) + '</td></tr>';
                }).join('') + '</tbody></table></div>';
        }).catch(function (err) {
            el('validationBody').innerHTML =
                '<div class="notice notice-error">Could not load the report: ' + esc(err.message) + '</div>';
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
        'CME — Semester V': {
            className: 'CME-A',
            text: [
                'Faculty,Monday P1,Monday P2,Monday P3,Tuesday P1,Tuesday P2,Tuesday P3',
                'Ms. B. Kusuma,Python Programming,Python Programming,FREE,FREE,FREE,FREE',
                'Sri B. Gopala Rao,FREE,FREE,Industrial Management and Entrepreneurship,FREE,FREE,FREE',
                'Ms. G. Sandhya Rani,FREE,FREE,FREE,Big Data & Cloud Computing,FREE,Big Data & Cloud Computing',
                'Mrs. A. Sravanthi,FREE,FREE,FREE,FREE,Internet Of Things,FREE'
            ].join('\n')
        },
        'ECE — Semester III': {
            className: 'ECE-A',
            text: [
                'Faculty,Monday P1,Monday P2,Tuesday P1,Tuesday P2',
                'Dr. Anitha Menon,Signals and Systems,FREE,FREE,Signals and Systems',
                'Prof. Naveen Reddy,FREE,Digital Electronics,Digital Electronics,FREE',
                'Dr. Kavya Rao,FREE,FREE,Microprocessors,FREE'
            ].join('\n')
        },
        'Long-form (Day / Period rows)': {
            className: 'CME-A',
            text: [
                'Faculty,Day,Period,Subject,Class,Room',
                'Ms. B. Kusuma,Monday,1,Python Programming,CME-A,C-401',
                'Ms. B. Kusuma,Monday,2,Python Programming,CME-A,C-401',
                'Sri B. Gopala Rao,Monday,3,Industrial Management and Entrepreneurship,CME-A,C-401'
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

    /**
     * One validation issue, showing the row, the offending value and what was
     * expected — enough to correct the file without guessing.
     */
    function issueHtml(issue, tone) {
        var context = issue.context || {};
        var lines = [];
        if (context.row != null) lines.push('Row ' + esc(context.row));
        if (context.className) lines.push('Class ' + esc(context.className));
        if (context.field && context.value != null) {
            lines.push(esc(String(context.field).replace(/^./, function (c) { return c.toUpperCase(); })) +
                ': ' + esc(String(context.value).trim() || '(blank)'));
        }
        if (Array.isArray(context.expected) && context.expected.length) {
            lines.push('Expected: ' + esc(context.expected.join(', ')));
        }

        return '<div class="notice notice-' + tone + '">' +
            '<strong>[' + esc(issue.code) + ']</strong> ' + esc(issue.message) +
            (lines.length ? '<div class="issue-detail">' + lines.join(' · ') + '</div>' : '') +
            '</div>';
    }

    function importReportHtml(report) {
        var html = '';
        (report.errors || []).forEach(function (e) { html += issueHtml(e, 'error'); });
        (report.warnings || []).forEach(function (w) { html += issueHtml(w, 'warn'); });
        return html;
    }

    function importPreviewHtml(data) {
        var summary = data.report.summary || {};
        var head = '<div class="notice notice-' + (data.report.ok ? 'ok' : 'error') + '">' +
            esc(data.filename) + ' — read as <strong>' + esc(data.format) + '</strong> (' +
            esc(data.layout) + ' layout' +
            (data.provider ? ', extracted by ' + esc(data.provider) +
                (data.convertedFromImage ? ' (image converted to PDF)' : '') : '') +
            '), ' + esc(data.rowCount == null ? 'n/a' : data.rowCount) + ' row(s): ' +
            esc(summary.faculty) + ' faculty, ' + esc(summary.busySlots) + ' scheduled periods, ' +
            esc(summary.freeSlots) + ' free.</div>';

        var stats = '<div class="stats compact" style="margin-top:14px;">' + [
            { label: 'Rows read', value: data.rowCount == null ? '—' : data.rowCount,
              note: 'from the file', tone: 'brand' },
            { label: 'Faculty', value: summary.faculty, note: 'found in the sheet' },
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
            // PDFs and images ARE supported now; whether they can be read
            // depends on the extraction provider, which the server reports.
            var document = state.formats && state.formats.document;
            if (document && document.available) {
                return ext.slice(1).toUpperCase() + ' files are read by ' + document.provider + '.';
            }
            return 'PDF/Image extraction is not configured. Add PDFCO_API_KEY to enable document ' +
                'extraction. Meanwhile use ' +
                ((document && document.alternatives) || ['Excel', 'CSV', 'Quick Paste']).join(', ') + '.';
        }
        return 'Unsupported file type "' + ext + '". Upload ' + supported + ', or use Quick Paste.';
    }

    /** Progress the user can trust: each line is shown as that stage is entered. */
    function importProgress(container, name) {
        var isDocument = /\.(pdf|png|jpe?g|webp)$/i.test(name);
        var steps = isDocument
            ? ['Uploading…',
               'Extracting timetable from PDF/image…',
               'Reading table…',
               'Normalizing days…',
               'Validating timetable…']
            : ['Uploading…', 'Reading table…', 'Normalizing days…', 'Validating timetable…'];

        var index = 0;
        function render() {
            container.innerHTML = notice(steps[index], 'info') +
                (isDocument && index >= 1
                    ? '<p class="muted" style="margin-top:6px;">' +
                      'The document is being read by the extraction service. This can take a ' +
                      'few seconds; nothing is imported until you confirm the preview.</p>'
                    : '');
        }
        render();

        // Advance only while the request is genuinely still in flight, so the
        // user is never shown a stage that has not been reached.
        var timer = setInterval(function () {
            if (index < steps.length - 1) { index++; render(); }
        }, isDocument ? 1200 : 400);

        return { stop: function () { clearInterval(timer); } };
    }

    function runPreview(container) {
        workflowStep('process');
        var progress = importProgress(container, state.importFile.name);

        return sendImport(API.importPreview).then(function (res) {
            progress.stop();
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
            progress.stop();
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

    function getClassDepartment(code) {
        if (!code) return '';
        if (state.classMeta && state.classMeta[code] && state.classMeta[code].department) {
            return state.classMeta[code].department;
        }
        var raw = String(code).split('-')[0].toUpperCase();
        if (raw.charAt(0) === 'D' && raw.length > 2) return raw.slice(1);
        return raw;
    }

    /** The Master Timetable's current view, as a /api/timetable query string. */
    function ttQuery() {
        var value = (el('ttView') && el('ttView').value) || '';
        return value.indexOf('class:') === 0 ? '?class=' + encodeURIComponent(value.slice(6)) : '';
    }

    /**
     * Rebuild the Master Timetable's class list for the chosen department,
     * keeping the current class selected when it belongs to that department.
     */
    function applyTimetableDepartment() {
        var wanted = (el('ttDept') && el('ttDept').value) || '';
        var meta = state.meta || { classes: [], primaryClass: null };
        var classes = meta.classes.filter(function (code) {
            return !wanted || getClassDepartment(code) === wanted;
        });
        if (!wanted && !classes.length) classes = meta.classes.slice();

        var previous = (el('ttView').value || '').replace(/^class:/, '');
        var keep = classes.indexOf(previous) >= 0 ? previous : classes[0];
        fillSelect(el('ttView'), classes.map(function (c) {
            var info = state.classMeta[c] || {};
            var dept = info.department || getClassDepartment(c);
            return {
                value: 'class:' + c,
                label: 'Class — ' + c + (dept ? ' (' + dept + ')' : '')
            };
        }), keep ? ('class:' + keep) : '');
        describeTimetableClass();
        return loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
    }

    /** The one-line academic context under the Master Timetable heading. */
    function describeTimetableClass() {
        var box = el('ttMeta');
        if (!box) return;
        var code = (el('ttView').value || '').replace(/^class:/, '');
        var info = state.classMeta[code];
        if (!info) { box.textContent = ''; return; }
        box.textContent = [
            code,
            info.departmentName || info.department,
            info.semester ? 'Semester ' + info.semester : null,
            info.academicYear ? 'Academic year ' + info.academicYear : null,
            info.room ? 'Home room ' + info.room : null
        ].filter(Boolean).join(' · ');
    }

    function applyAvailabilityDepartment() {
        var wanted = (el('availDept') && el('availDept').value) || '';
        var meta = state.meta || { classes: [], primaryClass: null };
        var classes = meta.classes.filter(function (code) {
            return !wanted || getClassDepartment(code) === wanted;
        });
        if (!wanted && !classes.length) classes = meta.classes.slice();

        var previous = (el('availClass') && el('availClass').value) || '';
        var keep = classes.indexOf(previous) >= 0 ? previous : classes[0];
        fillSelect(el('availClass'), classes.map(function (c) {
            var info = state.classMeta[c] || {};
            var dept = info.department || getClassDepartment(c);
            return {
                value: c,
                label: 'Class — ' + c + (dept ? ' (' + dept + ')' : '')
            };
        }), keep);

        var query = availabilityQuery();
        return loadGrid(query, 'availHead', 'availBody', onAvailabilitySelect);
    }

    function onAvailabilitySelect(cell) {
        checkAvailability(cell, 'availResult', {
            department: (el('availDept') && el('availDept').value) || '',
            search: (el('availSearch') && el('availSearch').value) || ''
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

            if (el('topbarMeta')) {
                el('topbarMeta').textContent =
                    (meta.title || 'Timetable') + ' · ' +
                    meta.facultyCount + ' faculty · ' +
                    meta.days.length + ' days × ' + meta.periods.length + ' periods';
            }

            fillSelect(el('dashDay'), meta.days, meta.days[0]);
            fillSelect(el('dashPeriod'), (meta.periods || []).map(function (p) {
                return { value: p, label: 'Period ' + p };
            }), meta.periods[0]);
            fillSelect(el('subDay'), meta.days, meta.days[0]);
            fillSelect(el('facSlotDay'), [{ value: '', label: '— any —' }].concat(meta.days));
            fillSelect(el('facSlotPeriod'), [{ value: '', label: '— any —' }].concat(
                (meta.periods || []).map(function (p) { return { value: p, label: 'Period ' + p }; })));

            var views = (meta.classes || []).map(function (c) {
                var dept = getClassDepartment(c);
                return { value: 'class:' + c, label: 'Class — ' + c + (dept ? ' (' + dept + ')' : '') };
            });
            fillSelect(el('ttView'), views, 'class:' + meta.primaryClass);

            return Promise.all([
                getJson(API.faculty).catch(function () { return { faculty: [] }; }),
                getJson(API.departments).catch(function () { return { departments: [], details: [] }; }),
                loadDashboard(meta.days[0], meta.periods[0]).catch(function () { return null; }),
                loadSourceCard().catch(function () { return null; }),
                loadWorkloadCard().catch(function () { return null; }),
                getJson(API.health).catch(function () { return null; }),
                getJson(API.importFormats).catch(function () { return null; }),
                getJson(API.entryReference).catch(function () { return null; })
            ]);
        }).then(function (results) {
            var facultyData = results[0] || { faculty: [] };
            var health = results[5];
            state.formats = results[6];

            if (el('aboutPort') && health) {
                el('aboutPort').textContent = String(health.port);
            }

            var facultyOptions = (facultyData.faculty || []).map(function (f) {
                return { value: f.name, label: f.name + ' (' + f.department + ')' };
            });
            fillSelect(el('subFaculty'), facultyOptions);

            var mine = state.user && state.user.facultyName;
            fillSelect(el('schedFaculty'), facultyOptions,
                mine && facultyOptions.some(function (o) { return o.value === mine; })
                    ? mine : (facultyOptions[0] && facultyOptions[0].value));

            var departmentDetails = results[1] && results[1].details ? results[1].details : [];
            var departmentOptions = departmentDetails.map(function (d) {
                return { value: d.code, label: d.code + ' (' + d.facultyCount + ')' };
            });
            fillSelect(el('facDept'), departmentOptions);
            fillSelect(el('availDept'), departmentOptions);
            fillSelect(el('ttDept'), departmentDetails.map(function (d) { return d.code; }));

            getJson('/api/branch').then(function (branchRes) {
                var b = (branchRes && branchRes.branch) || {};
                var branchLabel = b.name ? (b.name + ' (' + b.code + ')') : (b.code || 'Branch');
                var fullMeta = branchLabel + (b.academicYear ? ' · ' + b.academicYear : '') + (b.semester ? ' · Sem ' + b.semester : '');
                if (el('topbarMeta')) el('topbarMeta').textContent = fullMeta;
                ['manageBranchBadge', 'ttBranchBadge', 'facBranchBadge', 'facNewBranchBadge'].forEach(function (id) {
                    if (el(id)) el(id).textContent = branchLabel;
                });
            }).catch(function () {});

            state.classMeta = {};
            var reference = results[7];
            if (reference && reference.classes) {
                reference.classes.forEach(function (c) { state.classMeta[c.code] = c; });
            }

            applyTimetableDepartment();
            applyAvailabilityDepartment();

            var note = el('formatNote');
            if (note && state.formats) {
                note.textContent = 'Accepted: ' + state.formats.supported.join(', ') +
                    ' · up to ' + state.formats.maxUploadMB + ' MB.';
            }

            return loadFacultyTable();
        }).catch(function (err) {
            console.error('Bootstrap error:', err);
            var box = el('ttState');
            if (box) {
                box.style.display = 'block';
                box.className = 'notice notice-error';
                box.textContent = 'Could not load the timetable: ' + err.message;
            }
        });
    }

    // ------------------------------------------------- add / edit timetable
    /**
     * The Add Timetable view. Reads its options from the server rather than
     * hard-coding them, so the form always offers exactly what the database
     * knows about. Saving is disabled — with an explanation — when no database
     * is configured, because an edit that vanished on restart would mislead.
     */
    function manageNote(message, kind) {
        var box = el('manageResult');
        if (!box) return;
        box.innerHTML = message
            ? '<div class="notice notice-' + (kind || 'info') + '">' + message + '</div>'
            : '';
    }

    function setManageEditable(reference, storage) {
        var chip = el('manageBackend');
        var note = el('manageStorageNote');
        var editable = Boolean(reference && reference.editable);

        if (chip) {
            chip.textContent = editable ? 'Saving to PostgreSQL' : 'Read-only — no database';
            chip.className = 'pill ' + (editable ? 'pill-ok' : 'pill-warn');
        }
        if (note) {
            note.innerHTML = editable
                ? ''
                : '<div class="notice notice-warn">Entries cannot be saved because no database is ' +
                  'configured. Set <code>DATABASE_URL</code> to your Neon connection string and restart ' +
                  'the server. Everything else — the timetable, availability and imports — keeps working ' +
                  'on the bundled demo data.' +
                  (storage && storage.error ? ' <br />Reported: ' + esc(storage.error) : '') + '</div>';
        }
        var save = el('manageSave');
        if (save) save.disabled = !editable;
        return editable;
    }

    /**
     * Load an entry into the form, or reset it when passed null. An empty
     * string is not a valid option for the required selects, so those fall
     * back to their first option rather than rendering blank.
     */
    function fillManageForm(entry) {
        function set(id, value, fallbackToFirst) {
            var select = el(id);
            select.value = value == null ? '' : String(value);
            if (select.value === '' && fallbackToFirst && select.options.length) {
                select.value = select.options[0].value;
            }
        }
        state.editingId = entry ? entry.id : null;
        el('manageId').value = entry ? entry.id : '';

        if (entry && entry.className && state.classMeta[entry.className]) {
            var dept = state.classMeta[entry.className].department || '';
            el('manageDept').value = dept;
            applyManageDepartment();
        } else if (!entry) {
            applyManageDepartment();
        }

        set('manageClass', entry && entry.className, true);
        set('manageDay', entry && entry.day, true);
        set('managePeriod', entry && entry.period, true);
        set('manageSubject', entry && entry.subject, true);
        set('manageFaculty', entry && entry.faculty, true);
        set('manageRoom', entry && entry.room, false);
        set('manageType', entry ? entry.type : 'theory', true);
        el('manageSave').textContent = entry ? 'Update entry' : 'Save entry';

        Array.prototype.forEach.call(document.querySelectorAll('#manageList tr'), function (row) {
            row.classList.toggle('is-editing', entry && row.dataset.id === String(entry.id));
        });
    }

    function renderManageList(entries) {
        var box = el('manageList');
        if (!box) return;
        if (!entries.length) {
            box.innerHTML = '<p class="muted">No entries stored for this filter.</p>';
            return;
        }
        var rows = entries.map(function (e) {
            return '<tr data-id="' + e.id + '">' +
                '<td>' + esc(e.className) + '</td>' +
                '<td>' + esc(e.day) + '</td>' +
                '<td>P' + esc(e.period) + '</td>' +
                '<td>' + esc(e.subject) + '</td>' +
                '<td>' + esc(e.faculty) + '</td>' +
                '<td>' + esc(e.room || '—') + '</td>' +
                '<td>' + esc(e.type === 'lab' ? 'Lab' : 'Theory') + '</td>' +
                '<td><div class="row-actions">' +
                    '<button type="button" class="btn btn-sm btn-secondary" data-edit="' + e.id + '">Edit</button>' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-delete="' + e.id + '">Delete</button>' +
                '</div></td></tr>';
        }).join('');

        box.innerHTML = '<p class="muted" style="margin-bottom:10px;">' + entries.length +
            ' scheduled period' + (entries.length === 1 ? '' : 's') + '.</p>' +
            '<div class="table-scroll entry-scroll"><table class="data"><thead><tr>' +
            '<th>Class</th><th>Day</th><th>Period</th><th>Subject</th>' +
            '<th>Faculty</th><th>Room</th><th>Type</th><th></th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';

        Array.prototype.forEach.call(box.querySelectorAll('[data-edit]'), function (button) {
            button.addEventListener('click', function () {
                var entry = entries.filter(function (e) { return String(e.id) === button.dataset.edit; })[0];
                if (!entry) return;
                fillManageForm(entry);
                manageNote('Editing ' + esc(entry.className) + ' ' + esc(entry.day) +
                    ' P' + esc(entry.period) + '. Change the fields above and press Update entry.', 'info');
                el('manageClass').focus();
            });
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-delete]'), function (button) {
            button.addEventListener('click', function () { deleteEntry(button.dataset.delete); });
        });
    }

    function loadManageList() {
        var filter = el('manageFilterClass').value;
        var url = API.entries + (filter ? '?class=' + encodeURIComponent(filter) : '');
        return getJson(url)
            .then(function (data) { renderManageList(data.entries || []); })
            .catch(function (err) {
                el('manageList').innerHTML =
                    '<p class="muted">Entries are unavailable: ' + esc(err.message) + '</p>';
            });
    }

    function loadManage() {
        return Promise.all([
            getJson(API.entryReference),
            getJson(API.storage).catch(function () { return null; })
        ]).then(function (results) {
            var reference = results[0];
            state.reference = reference;

            reference.classes.forEach(function (c) { state.classMeta[c.code] = c; });
            fillSelect(el('manageDept'), [{ value: '', label: 'All departments' }].concat(
                (reference.departments || []).map(function (d) {
                    return { value: d.code, label: d.code + ' — ' + d.name };
                })), el('manageDept').value);
            fillSelect(el('manageDay'), reference.days);
            fillSelect(el('managePeriod'), reference.periods.map(function (p) {
                return { value: p, label: 'Period ' + p };
            }));
            fillSelect(el('manageRoom'), [{ value: '', label: '— none —' }].concat(
                reference.rooms.map(function (r) { return r.code; })));

            applyManageDepartment();

            var filter = el('manageFilterClass');
            var previous = filter.value;
            fillSelect(filter, [{ value: '', label: 'All classes' }].concat(
                reference.classes.map(function (c) { return c.code; })), previous);

            el('manageClass').onchange = onManageClassChange;

            // A lab subject implies a lab session; the user can still override.
            el('manageSubject').onchange = function () {
                var chosen = (reference.subjects || []).filter(function (s) {
                    return s.name === el('manageSubject').value;
                })[0];
                if (chosen && chosen.type) el('manageType').value = chosen.type;
            };

            if (!setManageEditable(reference, results[1])) {
                el('manageList').innerHTML =
                    '<p class="muted">Stored entries are listed here once a database is configured.</p>';
                return null;
            }
            fillManageForm(null);
            return loadManageList();
        }).catch(function (err) {
            manageNote('Could not load the form: ' + esc(err.message), 'error');
        });
    }

    /** When class changes and no department is locked in, sync subjects & faculty to that class's branch. */
    function onManageClassChange() {
        describeManageClass();
        var reference = state.reference;
        if (!reference) return;
        if (!el('manageDept').value) {
            var clsMeta = state.classMeta[el('manageClass').value];
            var classDept = clsMeta && clsMeta.department;
            if (classDept) {
                var subjects = (reference.subjects || []).filter(function (s) {
                    return s.department === classDept;
                });
                if (subjects.length) {
                    var prevSub = el('manageSubject').value;
                    var keepSub = subjects.some(function (s) { return s.name === prevSub; })
                        ? prevSub : (subjects[0] && subjects[0].name);
                    fillSelect(el('manageSubject'), subjects.map(function (s) { return s.name; }), keepSub);
                    if (el('manageSubject').onchange) el('manageSubject').onchange();
                }
                var faculty = (reference.faculty || []).filter(function (f) {
                    return f.department === classDept;
                });
                if (faculty.length) {
                    var prevFac = el('manageFaculty').value;
                    var keepFac = faculty.some(function (f) { return f.name === prevFac; })
                        ? prevFac : (faculty[0] && faculty[0].name);
                    fillSelect(el('manageFaculty'), faculty.map(function (f) { return f.name; }), keepFac);
                }
            }
        }
    }

    /** Narrow the Add Timetable class, subject, and faculty lists to the chosen department. */
    function applyManageDepartment() {
        var reference = state.reference;
        if (!reference) return;
        var wanted = el('manageDept').value;

        // 1. Filter classes
        var classes = (reference.classes || []).filter(function (c) {
            return !wanted || c.department === wanted;
        });
        if (!classes.length) classes = (reference.classes || []).slice();

        var previousClass = el('manageClass').value;
        var keepClass = classes.some(function (c) { return c.code === previousClass; })
            ? previousClass : (classes[0] && classes[0].code);
        fillSelect(el('manageClass'), classes.map(function (c) { return c.code; }), keepClass);
        describeManageClass();

        // 2. Filter subjects (strictly show only subjects belonging to the selected department)
        var subjects = (reference.subjects || []).filter(function (s) {
            return !wanted || s.department === wanted;
        });
        if (!subjects.length && !wanted) subjects = (reference.subjects || []).slice();

        var previousSubject = el('manageSubject').value;
        var keepSubject = subjects.some(function (s) { return s.name === previousSubject; })
            ? previousSubject : (subjects[0] && subjects[0].name);
        fillSelect(el('manageSubject'), subjects.map(function (s) { return s.name; }), keepSubject);
        if (el('manageSubject').onchange) el('manageSubject').onchange();

        // 3. Filter faculty (show department faculty)
        var faculty = (reference.faculty || []).filter(function (f) {
            return !wanted || f.department === wanted;
        });
        if (!faculty.length && !wanted) faculty = (reference.faculty || []).slice();

        var previousFaculty = el('manageFaculty').value;
        var keepFaculty = faculty.some(function (f) { return f.name === previousFaculty; })
            ? previousFaculty : (faculty[0] && faculty[0].name);
        fillSelect(el('manageFaculty'), faculty.map(function (f) { return f.name; }), keepFaculty);
    }

    /** Show the selected class's branch, semester and academic year. */
    function describeManageClass() {
        var box = el('manageClassMeta');
        if (!box) return;
        var info = state.classMeta[el('manageClass').value];
        box.textContent = info
            ? [
                info.departmentName || info.department,
                info.semester ? 'Semester ' + info.semester : null,
                info.academicYear ? 'Academic year ' + info.academicYear : null,
                info.room ? 'Home room ' + info.room : null
            ].filter(Boolean).join(' · ')
            : '';
    }

    /**
     * Render a rejection. With several problems the joined sentence would just
     * repeat the list, so show a lead-in and the list; with one, show it plain.
     */
    function rejectionHtml(body, fallback) {
        var problems = (body && (body.problems ||
            (body.conflicts || []).map(function (c) { return c.message; }))) || [];
        if (problems.length > 1) {
            return '<strong>Not saved.</strong> ' + problems.length + ' problems need fixing:' +
                '<ul style="margin:8px 0 0 18px;">' + problems.map(function (d) {
                    return '<li>' + esc(d) + '</li>';
                }).join('') + '</ul>';
        }
        return '<strong>Not saved.</strong> ' + esc((body && body.error) || fallback || 'Request failed');
    }

    function saveEntry(event) {
        event.preventDefault();
        var id = el('manageId').value;
        var payload = {
            class: el('manageClass').value,
            day: el('manageDay').value,
            period: el('managePeriod').value,
            subject: el('manageSubject').value,
            faculty: el('manageFaculty').value,
            room: el('manageRoom').value || null,
            type: el('manageType').value
        };
        var button = el('manageSave');
        button.disabled = true;
        manageNote('Saving…', 'info');

        postJson(id ? API.entries + '/' + id : API.entries, payload, id ? 'PUT' : 'POST')
            .then(function (res) {
                button.disabled = false;
                if (res.status >= 400) {
                    manageNote(rejectionHtml(res.body), 'error');
                    return;
                }
                var entry = res.body.entry;
                manageNote('Saved — ' + esc(entry.className) + ' ' + esc(entry.day) + ' P' + esc(entry.period) +
                    ': ' + esc(entry.subject) + ' with ' + esc(entry.faculty) + '.', 'ok');
                logActivity((id ? 'Updated ' : 'Added ') + entry.className + ' ' + entry.day + ' P' + entry.period);
                fillManageForm(null);
                refreshAfterChange();
            })
            .catch(function (err) {
                button.disabled = false;
                manageNote('Could not save: ' + esc(err.message), 'error');
            });
    }

    function deleteEntry(id) {
        var entry = null;
        var row = document.querySelector('#manageList tr[data-id="' + id + '"]');
        if (row) {
            var cells = row.querySelectorAll('td');
            entry = cells[0].textContent + ' ' + cells[1].textContent + ' ' + cells[2].textContent;
        }
        if (!window.confirm('Delete this timetable entry' + (entry ? ' (' + entry + ')' : '') +
            '?\n\nThis removes it from the database and cannot be undone.')) return;

        postJson(API.entries + '/' + id, null, 'DELETE')
            .then(function (res) {
                if (res.status >= 400) {
                    manageNote('Could not delete: ' + esc((res.body && res.body.error) || res.status), 'error');
                    return;
                }
                manageNote('Entry deleted.' + (entry ? ' (' + esc(entry) + ')' : ''), 'ok');
                logActivity('Deleted timetable entry ' + (entry || id));
                if (String(state.editingId) === String(id)) fillManageForm(null);
                refreshAfterChange();
            })
            .catch(function (err) { manageNote('Could not delete: ' + esc(err.message), 'error'); });
    }

    /** After a write, every view reading the timetable must be re-fetched. */
    function refreshAfterChange() {
        loadManageList();
        loadDashboard();
        loadGrid(availabilityQuery(), 'availHead', 'availBody', onAvailabilitySelect);
        loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
        loadFacultyTable();
    }


    /* ==================================================================
     * Catalog management — branches, subjects and classes.
     *
     * A BRANCH is a programme (CME). A CLASS is a section inside one (CME-A).
     * Branch lists are fetched from the API rather than hardcoded, so a branch
     * created here appears in every dropdown without a code change.
     * ================================================================== */

    var catalogState = { branches: [] };

    function catalogFail(containerId, err) {
        var node = el(containerId);
        if (node) node.innerHTML = notice(err && err.message ? err.message : String(err), 'error');
    }

    function backendPill(pillId, noteId, writable) {
        var pill = el(pillId);
        if (pill) {
            pill.textContent = writable ? 'Database' : 'Demo dataset (read-only)';
            pill.className = 'pill ' + (writable ? 'pill-ok' : 'pill-warn');
        }
        var note = el(noteId);
        if (note) {
            note.innerHTML = writable ? '' : notice(
                'No database is configured, so this list is read-only. Set DATABASE_URL ' +
                '(Neon or any PostgreSQL) and restart to add, edit or remove records.', 'warn');
        }
    }

    /** Fill every branch dropdown from the live list. */
    function fillBranchSelects(branches) {
        var options = branches.map(function (b) {
            return { value: b.code, label: b.code + ' — ' + b.name };
        });
        ['subjectBranch', 'classBranch'].forEach(function (id) {
            var current = el(id) && el(id).value;
            fillSelect(el(id), options, current);
        });
        ['subjectFilter', 'classFilter'].forEach(function (id) {
            var current = el(id) && el(id).value;
            fillSelect(el(id), [{ value: '', label: 'All branches' }].concat(options), current);
        });
    }

    function loadBranches() {
        return getJson('/api/branches').then(function (data) {
            catalogState.branches = data.branches;
            backendPill('branchBackend', 'branchStorageNote', data.writable);
            fillBranchSelects(data.branches);

            var submit = el('branchSubmit');
            if (submit) submit.disabled = !data.writable;

            el('branchBody').innerHTML = data.branches.map(function (b) {
                return '<tr>' +
                    '<td class="mono">' + esc(b.code) + '</td>' +
                    '<td>' + esc(b.name) + '</td>' +
                    '<td class="num">' + esc(b.facultyCount) + '</td>' +
                    '<td>' + (data.writable
                        ? '<button type="button" class="btn btn-secondary btn-sm" data-branch-delete="' +
                          esc(b.code) + '">Delete</button>'
                        : '<span class="muted">read-only</span>') + '</td>' +
                    '</tr>';
            }).join('');

            Array.prototype.forEach.call(
                document.querySelectorAll('[data-branch-delete]'), function (button) {
                    button.addEventListener('click', function () {
                        deleteCatalog('/api/branches/' + encodeURIComponent(button.dataset.branchDelete),
                            'branchResult', loadBranches);
                    });
                });
        }).catch(function (err) { catalogFail('branchResult', err); });
    }

    function loadSubjects() {
        var branch = el('subjectFilter') ? el('subjectFilter').value : '';
        var url = '/api/subjects' + (branch ? '?branch=' + encodeURIComponent(branch) : '');
        return Promise.all([
            catalogState.branches.length ? Promise.resolve(null) : loadBranches(),
            getJson(url)
        ]).then(function (results) {
            var data = results[1];
            backendPill('subjectBackend', 'subjectStorageNote', data.writable);
            fillBranchSelects(catalogState.branches);
            var submit = el('subjectSubmit');
            if (submit) submit.disabled = !data.writable;

            el('subjectBody').innerHTML = data.subjects.length
                ? data.subjects.map(function (sub) {
                    return '<tr>' +
                        '<td class="mono">' + esc(sub.code || '—') + '</td>' +
                        '<td>' + esc(sub.name) + '</td>' +
                        '<td>' + esc(sub.department || '—') + '</td>' +
                        '<td><span class="badge badge-neutral">' + esc(sub.type || 'theory') + '</span></td>' +
                        '<td>' + (data.writable && sub.code
                            ? '<button type="button" class="btn btn-secondary btn-sm" data-subject-delete="' +
                              esc(sub.code) + '">Delete</button>'
                            : '<span class="muted">read-only</span>') + '</td>' +
                        '</tr>';
                }).join('')
                : '<tr><td colspan="5" class="muted">No subjects for this branch yet.</td></tr>';

            Array.prototype.forEach.call(
                document.querySelectorAll('[data-subject-delete]'), function (button) {
                    button.addEventListener('click', function () {
                        deleteCatalog('/api/subjects/' + encodeURIComponent(button.dataset.subjectDelete),
                            'subjectResult', loadSubjects);
                    });
                });
        }).catch(function (err) { catalogFail('subjectResult', err); });
    }

    function loadClasses() {
        var branch = el('classFilter') ? el('classFilter').value : '';
        var url = '/api/classes' + (branch ? '?branch=' + encodeURIComponent(branch) : '');
        return Promise.all([
            catalogState.branches.length ? Promise.resolve(null) : loadBranches(),
            getJson(url)
        ]).then(function (results) {
            var data = results[1];
            backendPill('classBackend', 'classStorageNote', data.writable);
            fillBranchSelects(catalogState.branches);
            var submit = el('classSubmit');
            if (submit) submit.disabled = !data.writable;

            el('classBody').innerHTML = data.classes.length
                ? data.classes.map(function (cls) {
                    return '<tr>' +
                        '<td class="mono">' + esc(cls.code) + '</td>' +
                        '<td>' + esc(cls.department || '—') + '</td>' +
                        '<td class="num">' + esc(cls.semester == null ? '—' : cls.semester) + '</td>' +
                        '<td>' + esc(cls.academicYear || '—') + '</td>' +
                        '<td>' + (data.writable
                            ? '<button type="button" class="btn btn-secondary btn-sm" data-class-delete="' +
                              esc(cls.code) + '">Delete</button>'
                            : '<span class="muted">read-only</span>') + '</td>' +
                        '</tr>';
                }).join('')
                : '<tr><td colspan="5" class="muted">No classes for this branch yet.</td></tr>';

            Array.prototype.forEach.call(
                document.querySelectorAll('[data-class-delete]'), function (button) {
                    button.addEventListener('click', function () {
                        deleteCatalog('/api/classes/' + encodeURIComponent(button.dataset.classDelete),
                            'classResult', loadClasses);
                    });
                });
        }).catch(function (err) { catalogFail('classResult', err); });
    }

    /** Shared create handler: POST, report, refresh. */
    function submitCatalog(url, payload, resultId, reload) {
        var container = el(resultId);
        if (container) container.innerHTML = notice('Saving…', 'info');
        return postJson(url, payload).then(function (res) {
            if (!res.ok) {
                var message = (res.body && res.body.error) || ('Request failed (HTTP ' + res.status + ')');
                if (container) container.innerHTML = notice(message, 'error');
                return false;
            }
            if (container) container.innerHTML = notice(res.body.message || 'Saved.', 'ok');
            // A new branch changes every branch dropdown, so refresh the list.
            return loadBranches().then(reload).then(function () { return true; });
        }).catch(function () {
            if (container) container.innerHTML = notice('Could not reach the server.', 'error');
            return false;
        });
    }

    function deleteCatalog(url, resultId, reload) {
        var container = el(resultId);
        if (container) container.innerHTML = notice('Removing…', 'info');
        return fetch(url, { method: 'DELETE' }).then(function (response) {
            return response.json().catch(function () { return null; })
                .then(function (body) {
                    if (!response.ok) {
                        container.innerHTML = notice(
                            (body && body.error) || ('Delete failed (HTTP ' + response.status + ')'), 'error');
                        return;
                    }
                    container.innerHTML = notice((body && body.message) || 'Removed.', 'ok');
                    return loadBranches().then(reload);
                });
        }).catch(function () {
            container.innerHTML = notice('Could not reach the server.', 'error');
        });
    }

    /** Image/PDF extraction availability, shown on the Add Timetable page. */
    function loadDocumentStatus() {
        return getJson('/api/timetable/import/document-status').then(function (status) {
            var node = el('manageDocStatus');
            if (!node) return;
            node.innerHTML = status.available
                ? notice(status.message, 'ok')
                : notice(status.message + ' Use ' + status.alternatives.join(', ') + '.', 'warn');
        }).catch(function () { /* leave the card as-is */ });
    }

    // ------------------------------------------------------------ wiring
    document.addEventListener('DOMContentLoaded', function () {
        renderPresets();
        renderActivity();

        Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (button) {
            button.addEventListener('click', function () { showView(button.dataset.view); });
        });

        // Stat cards are re-rendered on every refresh, so the handler lives on
        // the container rather than on each card.
        if (el('dashboardStats')) {
            el('dashboardStats').addEventListener('click', function (event) {
                var card = event.target.closest('[data-stat-view]');
                if (card) showView(card.dataset.statView);
            });
        }

        var toggle = el('sidebarToggle');
        if (toggle) {
            toggle.addEventListener('click', function () { el('sidebar').classList.toggle('is-open'); });
        }

        if (el('logoutBtn')) el('logoutBtn').addEventListener('click', logout);
        if (el('sidebarLogout')) el('sidebarLogout').addEventListener('click', logout);

        window.addEventListener('hashchange', function () {
            var name = viewFromHash();
            if (name) showView(name, false);
        });

        // --- dashboard
        if (el('dashCheck')) {
            el('dashCheck').addEventListener('click', function () {
                var day = el('dashDay') ? el('dashDay').value : 'Monday';
                var period = el('dashPeriod') ? parseInt(el('dashPeriod').value, 10) : 1;
                checkAvailability({ day: day, period: period, subject: null, faculty: null, class: null },
                    'dashResult');
                loadDashboard(day, period);
            });
        }
        if (el('clearActivity')) {
            el('clearActivity').addEventListener('click', function () {
                state.activity = [];
                renderActivity();
            });
        }

        // --- faculty directory and add faculty
        if (el('facultyForm')) el('facultyForm').addEventListener('submit', saveFaculty);
        if (el('facReset')) {
            el('facReset').addEventListener('click', function () {
                resetFacultyForm();
                facultyNote('');
            });
        }
        if (el('facSlotDay')) el('facSlotDay').addEventListener('change', loadFacultyTable);
        if (el('facSlotPeriod')) el('facSlotPeriod').addEventListener('change', loadFacultyTable);

        // --- master timetable
        if (el('ttManageBtn')) {
            el('ttManageBtn').addEventListener('click', function () {
                switchView('manage');
            });
        }
        if (el('ttDept')) el('ttDept').addEventListener('change', applyTimetableDepartment);
        if (el('ttView')) {
            el('ttView').addEventListener('change', function () {
                describeTimetableClass();
                loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
            });
        }

        // --- add / edit timetable
        if (el('manageDept')) el('manageDept').addEventListener('change', applyManageDepartment);
        if (el('manageForm')) el('manageForm').addEventListener('submit', saveEntry);
        if (el('manageReset')) {
            el('manageReset').addEventListener('click', function () {
                fillManageForm(null);
                manageNote('');
            });
        }
        if (el('manageFilterClass')) el('manageFilterClass').addEventListener('change', loadManageList);

        // --- availability
        if (el('availClass')) {
            el('availClass').addEventListener('change', function () {
                var selectedClass = el('availClass').value;
                var dept = getClassDepartment(selectedClass);
                if (dept && el('availDept') && el('availDept').value !== dept) {
                    el('availDept').value = dept;
                }
                loadGrid(availabilityQuery(), 'availHead', 'availBody', onAvailabilitySelect);
                if (el('availResult')) el('availResult').innerHTML = '<p class="muted">Select a period from the timetable.</p>';
            });
        }
        if (el('availDept')) {
            el('availDept').addEventListener('change', function () {
                applyAvailabilityDepartment();
                var key = state.selected.availBody;
                if (key) {
                    var button = document.querySelector('#availBody .slot-btn[data-key="' + key + '"]');
                    if (button) button.click();
                } else if (el('availResult')) {
                    el('availResult').innerHTML = '<p class="muted">Select a period from the timetable.</p>';
                }
            });
        }
        if (el('availSearch')) {
            el('availSearch').addEventListener('input', function () {
                var key = state.selected.availBody;
                if (key) {
                    var button = document.querySelector('#availBody .slot-btn[data-key="' + key + '"]');
                    if (button) button.click();
                }
            });
        }
        if (el('availCheckBtn')) el('availCheckBtn').addEventListener('click', checkHOSAvailability);

        // Password toggles on Create Faculty form
        setupPasswordToggle('toggleFacPassword', 'facNewPassword');
        setupPasswordToggle('toggleFacConfirmPassword', 'facNewConfirmPassword');

        // Copy credentials buttons on faculty creation success panel
        if (el('btnCopyUsername')) {
            el('btnCopyUsername').addEventListener('click', function () {
                var uname = el('succFacUsername') ? el('succFacUsername').textContent : '';
                if (navigator.clipboard && uname) {
                    navigator.clipboard.writeText(uname).then(function () {
                        if (el('copyFeedback')) el('copyFeedback').textContent = 'Username copied!';
                    });
                }
            });
        }
        if (el('btnCopyPassword')) {
            el('btnCopyPassword').addEventListener('click', function () {
                var pwd = el('succFacPassword') ? el('succFacPassword').textContent : '';
                if (navigator.clipboard && pwd) {
                    navigator.clipboard.writeText(pwd).then(function () {
                        if (el('copyFeedback')) el('copyFeedback').textContent = 'Password copied!';
                    });
                }
            });
        }
        if (el('btnDismissSuccess')) {
            el('btnDismissSuccess').addEventListener('click', function () {
                var panel = el('facultySuccessPanel');
                if (panel) panel.style.display = 'none';
            });
        }

        // --- my schedule / timetable
        if (el('schedFaculty')) el('schedFaculty').addEventListener('change', loadSchedule);
        if (el('schedEntryForm')) el('schedEntryForm').addEventListener('submit', saveSchedEntry);
        if (el('schedResetBtn')) el('schedResetBtn').addEventListener('click', resetSchedForm);
        if (el('schedDeleteBtn')) el('schedDeleteBtn').addEventListener('click', deleteSchedEntry);

        // --- faculty directory
        if (el('facDept')) el('facDept').addEventListener('change', loadFacultyTable);
        if (el('facSearch')) el('facSearch').addEventListener('input', loadFacultyTable);

        // --- substitute
        if (el('subFind')) el('subFind').addEventListener('click', findCover);

        // --- import
        if (el('importPreview')) el('importPreview').addEventListener('click', previewImport);
        if (el('pastePreview')) el('pastePreview').addEventListener('click', previewPaste);
        if (el('pasteClear')) {
            el('pasteClear').addEventListener('click', function () {
                if (el('pasteText')) el('pasteText').value = '';
                if (el('importResult')) el('importResult').innerHTML = '';
                workflowStep('upload');
            });
        }

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

        if (el('presetGrid')) {
            el('presetGrid').addEventListener('click', function (event) {
                var button = event.target.closest ? event.target.closest('.preset') : null;
                if (!button) return;
                var preset = PRESETS[button.dataset.preset];
                if (!preset) return;
                if (el('pasteText')) el('pasteText').value = preset.text;
                if (el('pasteClass')) el('pasteClass').value = preset.className;
                var pasteTab = document.querySelector('.tab[data-tab="paste"]');
                if (pasteTab) pasteTab.click();
                if (el('importResult')) {
                    el('importResult').innerHTML = notice(
                        'Loaded the "' + button.dataset.preset + '" preset into Quick Paste. ' +
                        'Edit it if you need to, then process it.', 'info');
                }
            });
        }

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
                if (el('importFile')) el('importFile').files = files;
                previewImport();
            });
        }

        // --- catalog forms ---
        var branchForm = el('branchForm');
        if (branchForm) branchForm.addEventListener('submit', function (event) {
            event.preventDefault();
            submitCatalog('/api/branches', {
                code: el('branchCode').value, name: el('branchName').value
            }, 'branchResult', loadBranches).then(function (ok) {
                if (ok) { el('branchCode').value = ''; el('branchName').value = ''; }
            });
        });

        var subjectForm = el('subjectForm');
        if (subjectForm) subjectForm.addEventListener('submit', function (event) {
            event.preventDefault();
            submitCatalog('/api/subjects', {
                code: el('subjectCode').value, name: el('subjectName').value,
                department: el('subjectBranch').value, type: el('subjectType').value
            }, 'subjectResult', loadSubjects).then(function (ok) {
                if (ok) { el('subjectCode').value = ''; el('subjectName').value = ''; }
            });
        });

        var classForm = el('classForm');
        if (classForm) classForm.addEventListener('submit', function (event) {
            event.preventDefault();
            submitCatalog('/api/classes', {
                code: el('classCode').value, department: el('classBranch').value,
                semester: el('classSemester').value, academicYear: el('classYear').value
            }, 'classResult', loadClasses).then(function (ok) {
                if (ok) { el('classCode').value = ''; el('classSemester').value = ''; }
            });
        });

        if (el('subjectFilter')) el('subjectFilter').addEventListener('change', loadSubjects);
        if (el('classFilter')) el('classFilter').addEventListener('change', loadClasses);
        if (el('branchConfigForm')) el('branchConfigForm').addEventListener('submit', saveBranchConfig);

        // --- Timetable Upload Foundation (Phase B1) ---
        function setupTimetableUploads() {
            // HOS Master Timetable Upload
            var btnHosChoose = el('btnHosChooseFile');
            var inputHosFile = el('hosTimetableFile');
            var btnHosUpload = el('btnHosUpload');
            var formHos = el('hosUploadForm');
            var nameHos = el('hosSelectedFileName');
            var statusHos = el('hosUploadStatus');

            if (btnHosChoose && inputHosFile) {
                btnHosChoose.addEventListener('click', function () {
                    inputHosFile.click();
                });
                inputHosFile.addEventListener('change', function () {
                    var file = inputHosFile.files && inputHosFile.files[0];
                    if (file) {
                        if (nameHos) nameHos.textContent = file.name;
                        if (btnHosUpload) btnHosUpload.disabled = false;
                        if (statusHos) statusHos.style.display = 'none';
                    } else {
                        if (nameHos) nameHos.textContent = 'None';
                        if (btnHosUpload) btnHosUpload.disabled = true;
                    }
                });
            }

            if (formHos) {
                formHos.addEventListener('submit', function (event) {
                    event.preventDefault();
                    var file = inputHosFile && inputHosFile.files && inputHosFile.files[0];
                    if (!file) {
                        if (statusHos) {
                            statusHos.style.display = 'block';
                            statusHos.innerHTML = '<div class="notice notice-danger" style="margin-top:10px;">Please choose a timetable file first.</div>';
                        }
                        return;
                    }

                    if (btnHosUpload) {
                        btnHosUpload.disabled = true;
                        btnHosUpload.textContent = 'Uploading…';
                    }

                    var formData = new FormData();
                    formData.append('timetable', file);

                    fetch('/api/uploads/master-timetable', {
                        method: 'POST',
                        body: formData
                    }).then(function (res) {
                        return res.json().catch(function () { return {}; }).then(function (body) {
                            return { ok: res.ok, status: res.status, body: body };
                        });
                    }).then(function (res) {
                        if (statusHos) {
                            statusHos.style.display = 'block';
                            if (res.ok) {
                                statusHos.innerHTML =
                                    '<div class="notice notice-success" style="margin-top:10px;">' +
                                    '<strong>Upload status: Uploaded successfully</strong><br/>' +
                                    '<span style="font-size:0.9rem; margin-top:4px; display:inline-block;">' +
                                    'Timetable uploaded. Processing will be available in the next step.</span>' +
                                    '</div>';
                            } else {
                                var errMsg = (res.body && res.body.error) || 'Upload failed.';
                                statusHos.innerHTML =
                                    '<div class="notice notice-danger" style="margin-top:10px;">' +
                                    '<strong>Upload failed:</strong> ' + esc(errMsg) +
                                    '</div>';
                            }
                        }
                    }).catch(function (err) {
                        if (statusHos) {
                            statusHos.style.display = 'block';
                            statusHos.innerHTML =
                                '<div class="notice notice-danger" style="margin-top:10px;">' +
                                '<strong>Network error:</strong> ' + esc(err.message) +
                                '</div>';
                        }
                    }).finally(function () {
                        if (btnHosUpload) {
                            btnHosUpload.disabled = false;
                            btnHosUpload.textContent = 'Upload';
                        }
                    });
                });
            }

            // Faculty My Timetable Upload
            var btnFacChoose = el('btnFacChooseFile');
            var inputFacFile = el('facTimetableFile');
            var btnFacUpload = el('btnFacUpload');
            var formFac = el('facUploadForm');
            var nameFac = el('facSelectedFileName');
            var statusFac = el('facUploadStatus');

            if (btnFacChoose && inputFacFile) {
                btnFacChoose.addEventListener('click', function () {
                    inputFacFile.click();
                });
                inputFacFile.addEventListener('change', function () {
                    var file = inputFacFile.files && inputFacFile.files[0];
                    if (file) {
                        if (nameFac) nameFac.textContent = file.name;
                        if (btnFacUpload) btnFacUpload.disabled = false;
                        if (statusFac) statusFac.style.display = 'none';
                    } else {
                        if (nameFac) nameFac.textContent = 'None';
                        if (btnFacUpload) btnFacUpload.disabled = true;
                    }
                });
            }

            if (formFac) {
                formFac.addEventListener('submit', function (event) {
                    event.preventDefault();
                    var file = inputFacFile && inputFacFile.files && inputFacFile.files[0];
                    if (!file) {
                        if (statusFac) {
                            statusFac.style.display = 'block';
                            statusFac.innerHTML = '<div class="notice notice-danger" style="margin-top:10px;">Please choose a timetable file first.</div>';
                        }
                        return;
                    }

                    if (btnFacUpload) {
                        btnFacUpload.disabled = true;
                        btnFacUpload.textContent = 'Uploading…';
                    }

                    var formData = new FormData();
                    formData.append('timetable', file);

                    fetch('/api/uploads/faculty-timetable', {
                        method: 'POST',
                        body: formData
                    }).then(function (res) {
                        return res.json().catch(function () { return {}; }).then(function (body) {
                            return { ok: res.ok, status: res.status, body: body };
                        });
                    }).then(function (res) {
                        if (statusFac) {
                            statusFac.style.display = 'block';
                            if (res.ok) {
                                statusFac.innerHTML =
                                    '<div class="notice notice-success" style="margin-top:10px;">' +
                                    '<strong>Upload status: Uploaded successfully</strong><br/>' +
                                    '<span style="font-size:0.9rem; margin-top:4px; display:inline-block;">' +
                                    'Timetable uploaded. Processing will be available in the next step.</span>' +
                                    '</div>';
                            } else {
                                var errMsg = (res.body && res.body.error) || 'Upload failed.';
                                statusFac.innerHTML =
                                    '<div class="notice notice-danger" style="margin-top:10px;">' +
                                    '<strong>Upload failed:</strong> ' + esc(errMsg) +
                                    '</div>';
                            }
                        }
                    }).catch(function (err) {
                        if (statusFac) {
                            statusFac.style.display = 'block';
                            statusFac.innerHTML =
                                '<div class="notice notice-danger" style="margin-top:10px;">' +
                                '<strong>Network error:</strong> ' + esc(err.message) +
                                '</div>';
                        }
                    }).finally(function () {
                        if (btnFacUpload) {
                            btnFacUpload.disabled = false;
                            btnFacUpload.textContent = 'Upload';
                        }
                    });
                });
            }

            // --- Phase B2.5 Staging Review & Approval UI Logic ---
            var currentStagingUploadId = null;

            function renderStagingGrid(contract) {
                var head = el('stgHead');
                var body = el('stgBody');
                if (!head || !body) return;

                var days = (contract && contract.days) || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                var periods = (contract && contract.periods) || [1, 2, 3, 4, 5, 6, 7];
                var timings = (contract && contract.period_timings) || {};
                var entries = (contract && contract.entries) || [];

                // Build Header
                var headHtml = '<tr><th style="padding:10px;">Day</th>';
                periods.forEach(function (p) {
                    var t = timings[String(p)] || timings[p];
                    headHtml += '<th style="padding:10px;">P' + p + (t ? '<br/><span style="font-size:0.75rem; font-weight:normal; opacity:0.85;">' + esc(t.start) + '–' + esc(t.end) + '</span>' : '') + '</th>';
                });
                headHtml += '</tr>';
                head.innerHTML = headHtml;

                // Build Body
                var bodyHtml = '';
                days.forEach(function (day) {
                    bodyHtml += '<tr><td style="font-weight:600; padding:10px; background:var(--surface-subtle);">' + esc(day) + '</td>';
                    var coveredUntil = 0;

                    periods.forEach(function (p) {
                        if (p <= coveredUntil) return;

                        var entry = entries.find(function (e) { return e.day === day && e.period === p; });
                        if (!entry || entry.is_free) {
                            bodyHtml += '<td class="muted" style="text-align:center; padding:10px; font-size:0.85rem;">—</td>';
                            return;
                        }

                        var spanTo = entry.span_to;
                        var colspan = 1;
                        if (spanTo && spanTo > p) {
                            colspan = (spanTo - p) + 1;
                            coveredUntil = spanTo;
                        }

                        var typeBadge = '';
                        if (entry.session_type === 'lab') {
                            typeBadge = '<span class="badge" style="background:#e0e7ff; color:#3730a3; font-size:0.7rem; padding:2px 6px;">Lab</span>';
                        } else if (entry.session_type === 'activity') {
                            typeBadge = '<span class="badge" style="background:#fef3c7; color:#92400e; font-size:0.7rem; padding:2px 6px;">Activity</span>';
                        } else {
                            typeBadge = '<span class="badge" style="background:#dbeafe; color:#1e40af; font-size:0.7rem; padding:2px 6px;">Theory</span>';
                        }

                        var spanBadge = (colspan > 1) ? '<span class="badge" style="background:#f3e8ff; color:#6b21a8; font-size:0.7rem; padding:2px 6px;">Spans P' + p + '–P' + spanTo + '</span>' : '';

                        var facultyText = entry.faculty_name ? ('<div style="font-size:0.8rem; color:var(--ink-700); margin-top:2px;">' + esc(entry.faculty_name) + '</div>') : '<div style="font-size:0.78rem; color:var(--ink-500); margin-top:2px;"><em>Unassigned</em></div>';

                        var roomText = entry.room_code ? ('<div style="font-size:0.75rem; color:var(--ink-600); margin-top:2px;">Room: ' + esc(entry.room_code) + '</div>') : '';

                        bodyHtml += '<td ' + (colspan > 1 ? ('colspan="' + colspan + '"') : '') + ' style="background:var(--surface); padding:8px 10px; vertical-align:top; border-left: 3px solid var(--brand-500);">' +
                            '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px; flex-wrap:wrap;">' +
                            typeBadge + (spanBadge ? (' ' + spanBadge) : '') +
                            '</div>' +
                            '<div style="font-weight:600; font-size:0.88rem; margin-top:4px;">' + esc(entry.subject_name || entry.subject_code || '—') +
                            (entry.subject_code ? (' <span style="font-size:0.78rem; font-weight:normal; color:var(--ink-500);">(' + esc(entry.subject_code) + ')</span>') : '') +
                            '</div>' +
                            facultyText +
                            roomText +
                            '</td>';
                    });
                    bodyHtml += '</tr>';
                });
                body.innerHTML = bodyHtml;
            }

            function loadStagedTimetable(uploadId) {
                currentStagingUploadId = uploadId;
                var stagingCard = el('hosStagingCard');
                if (!stagingCard) return;
                stagingCard.style.display = 'block';

                var stgFileName = el('stgFileName');
                var stgClass = el('stgClass');
                var stgSemester = el('stgSemester');
                var stgYear = el('stgYear');
                var stgCount = el('stgCount');
                var validationBadge = el('stagingValidationBadge');
                var importBadge = el('stagingImportBadge');
                var btnApprove = el('btnStagingApprove');
                var btnReject = el('btnStagingReject');
                var alertBox = el('stagingAlertBox');
                var unresolvedBanner = el('stagingUnresolvedBanner');
                var unresolvedList = el('stagingUnresolvedList');
                var actionStatus = el('stagingActionStatus');
                var rejectBox = el('stagingRejectBox');

                if (actionStatus) actionStatus.style.display = 'none';
                if (rejectBox) rejectBox.style.display = 'none';

                fetch('/api/staging/' + encodeURIComponent(uploadId)).then(function (res) {
                    return res.json().catch(function () { return {}; }).then(function (data) {
                        return { ok: res.ok, status: res.status, data: data };
                    });
                }).then(function (res) {
                    if (!res.ok) {
                        if (alertBox) {
                            alertBox.style.display = 'block';
                            alertBox.innerHTML = '<div class="notice notice-danger">' + esc(res.data.error || 'Failed to load staged timetable.') + '</div>';
                        }
                        return;
                    }

                    var s = res.data;
                    var contract = s.extractedJson || {};

                    if (stgFileName) stgFileName.textContent = s.originalFilename || '—';
                    if (stgClass) stgClass.textContent = contract.class_name || '—';
                    if (stgSemester) stgSemester.textContent = contract.semester != null ? ('Semester ' + contract.semester) : '—';
                    if (stgYear) stgYear.textContent = contract.academic_year || '—';
                    if (stgCount) stgCount.textContent = (contract.entries && contract.entries.length) || 0;

                    if (validationBadge) {
                        if (s.validationStatus === 'VALID') {
                            validationBadge.className = 'badge badge-success';
                            validationBadge.textContent = 'VALID';
                        } else {
                            validationBadge.className = 'badge badge-danger';
                            validationBadge.textContent = 'INVALID';
                        }
                    }

                    if (importBadge) {
                        importBadge.textContent = s.importStatus || 'STAGED';
                        if (s.importStatus === 'IMPORTED') {
                            importBadge.className = 'badge badge-primary';
                        } else if (s.importStatus === 'REJECTED') {
                            importBadge.className = 'badge badge-neutral';
                        } else {
                            importBadge.className = 'badge badge-warning';
                        }
                    }

                    var unresolved = (s.resolution && s.resolution.unresolvedEntities) || [];
                    if (unresolved.length > 0) {
                        if (unresolvedBanner) unresolvedBanner.style.display = 'block';
                        if (unresolvedList) {
                            unresolvedList.innerHTML = unresolved.map(function (item) {
                                return '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 12px; background:#fff; border-radius:var(--radius-sm); border:1px solid #fae69e; font-size:0.84rem;">' +
                                    '<div><strong>' + esc(item.entityType.toUpperCase()) + ':</strong> ' + esc(item.extractedText) +
                                    (item.code ? ' <span class="mono">(' + esc(item.code) + ')</span>' : '') +
                                    '<div class="muted" style="font-size:0.78rem; margin-top:2px;">' + esc(item.reason) + '</div></div>' +
                                    '<button type="button" class="btn btn-secondary btn-sm btn-map-entity" data-type="' + esc(item.entityType) + '" data-text="' + esc(item.extractedText) + '">Map to Catalog</button>' +
                                    '</div>';
                            }).join('');

                            unresolvedList.querySelectorAll('.btn-map-entity').forEach(function (btn) {
                                btn.addEventListener('click', function () {
                                    var entityType = btn.getAttribute('data-type');
                                    var extractedText = btn.getAttribute('data-text');
                                    promptEntityMapping(uploadId, entityType, extractedText);
                                });
                            });
                        }
                    } else {
                        if (unresolvedBanner) unresolvedBanner.style.display = 'none';
                    }

                    if (btnApprove) {
                        if (s.importStatus === 'IMPORTED') {
                            btnApprove.disabled = true;
                            btnApprove.textContent = '✓ Already Imported';
                        } else if (s.importStatus === 'REJECTED') {
                            btnApprove.disabled = true;
                            btnApprove.textContent = 'Rejected';
                        } else if (s.validationStatus !== 'VALID') {
                            btnApprove.disabled = true;
                            btnApprove.textContent = 'Cannot Approve (Invalid)';
                        } else if (unresolved.length > 0) {
                            btnApprove.disabled = true;
                            btnApprove.textContent = 'Resolve References to Enable Approval';
                        } else {
                            btnApprove.disabled = false;
                            btnApprove.textContent = 'Approve & Import to Live Timetable';
                        }
                    }

                    if (btnReject) {
                        btnReject.disabled = (s.importStatus === 'IMPORTED');
                    }

                    renderStagingGrid(contract);
                });
            }

            function promptEntityMapping(uploadId, entityType, extractedText) {
                var target = prompt('Map "' + extractedText + '" to existing branch ' + entityType + ' (enter exact name or code):');
                if (!target || !target.trim()) return;

                fetch('/api/staging/' + encodeURIComponent(uploadId) + '/map-entity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        entityType: entityType,
                        extractedText: extractedText,
                        targetName: target.trim(),
                        targetCode: target.trim()
                    })
                }).then(function (r) { return r.json(); }).then(function (res) {
                    if (res.success) {
                        loadStagedTimetable(uploadId);
                    } else {
                        alert(res.error || 'Failed to map entity.');
                    }
                }).catch(function (e) {
                    alert('Network error: ' + e.message);
                });
            }

            var btnStgClose = el('btnStagingClose');
            if (btnStgClose) {
                btnStgClose.addEventListener('click', function () {
                    var card = el('hosStagingCard');
                    if (card) card.style.display = 'none';
                });
            }

            var btnStgApprove = el('btnStagingApprove');
            if (btnStgApprove) {
                btnStgApprove.addEventListener('click', function () {
                    if (!currentStagingUploadId) return;
                    var confirmed = confirm('Approve and import this timetable into the live schedule?\n\nExisting live entries for this class will be replaced.');
                    if (!confirmed) return;

                    btnStgApprove.disabled = true;
                    btnStgApprove.textContent = 'Importing…';
                    var actionStatus = el('stagingActionStatus');

                    fetch('/api/staging/' + encodeURIComponent(currentStagingUploadId) + '/approve', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    }).then(function (r) {
                        return r.json().catch(function () { return {}; }).then(function (body) {
                            return { ok: r.ok, status: r.status, body: body };
                        });
                    }).then(function (res) {
                        if (actionStatus) {
                            actionStatus.style.display = 'block';
                            if (res.ok) {
                                actionStatus.innerHTML = '<div class="notice notice-success"><strong>✓ Timetable Approved &amp; Imported!</strong> ' + esc(res.body.message || '') + '</div>';
                                loadStagedTimetable(currentStagingUploadId);
                                refreshPendingStaging();
                                loadMasterTimetable();
                                loadDashboard();
                            } else {
                                actionStatus.innerHTML = '<div class="notice notice-danger"><strong>Import Failed:</strong> ' + esc(res.body.error || 'Failed to import timetable.') + '</div>';
                                btnStgApprove.disabled = false;
                                btnStgApprove.textContent = 'Approve & Import to Live Timetable';
                            }
                        }
                    }).catch(function (err) {
                        if (actionStatus) {
                            actionStatus.style.display = 'block';
                            actionStatus.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
                        }
                        btnStgApprove.disabled = false;
                        btnStgApprove.textContent = 'Approve & Import to Live Timetable';
                    });
                });
            }

            var btnStgReject = el('btnStagingReject');
            var rejectBox = el('stagingRejectBox');
            var btnStgConfirmReject = el('btnStagingConfirmReject');
            var btnStgCancelReject = el('btnStagingCancelReject');
            var rejectReasonInput = el('stagingRejectReason');

            if (btnStgReject && rejectBox) {
                btnStgReject.addEventListener('click', function () {
                    rejectBox.style.display = 'block';
                });
            }

            if (btnStgCancelReject && rejectBox) {
                btnStgCancelReject.addEventListener('click', function () {
                    rejectBox.style.display = 'none';
                });
            }

            if (btnStgConfirmReject) {
                btnStgConfirmReject.addEventListener('click', function () {
                    if (!currentStagingUploadId) return;
                    var reason = (rejectReasonInput && rejectReasonInput.value) || 'Rejected by HOS';
                    btnStgConfirmReject.disabled = true;

                    fetch('/api/staging/' + encodeURIComponent(currentStagingUploadId) + '/reject', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason: reason })
                    }).then(function (r) { return r.json(); }).then(function (res) {
                        btnStgConfirmReject.disabled = false;
                        if (rejectBox) rejectBox.style.display = 'none';
                        if (res.success) {
                            var actionStatus = el('stagingActionStatus');
                            if (actionStatus) {
                                actionStatus.style.display = 'block';
                                actionStatus.innerHTML = '<div class="notice notice-info">Staged timetable was rejected. No changes were made to the live timetable.</div>';
                            }
                            loadStagedTimetable(currentStagingUploadId);
                            refreshPendingStaging();
                        } else {
                            alert(res.error || 'Failed to reject timetable.');
                        }
                    }).catch(function (e) {
                        btnStgConfirmReject.disabled = false;
                        alert('Network error: ' + e.message);
                    });
                });
            }

            var btnPending = el('btnHosCheckPending');
            var pendingCountEl = el('hosPendingCount');

            function refreshPendingStaging() {
                fetch('/api/staging/pending').then(function (r) { return r.json(); }).then(function (data) {
                    if (data && data.staging) {
                        var pending = data.staging.filter(function (s) { return s.importStatus === 'STAGED'; });
                        if (pendingCountEl) {
                            pendingCountEl.textContent = pending.length > 0 ? ('(' + pending.length + ' pending approval)') : '(0 pending)';
                        }
                    }
                }).catch(function () {});
            }

            if (btnPending) {
                btnPending.addEventListener('click', function () {
                    fetch('/api/staging/pending').then(function (r) { return r.json(); }).then(function (data) {
                        if (data && data.staging && data.staging.length > 0) {
                            loadStagedTimetable(data.staging[0].uploadId);
                        } else {
                            if (statusHos) {
                                statusHos.style.display = 'block';
                                statusHos.innerHTML = '<div class="notice notice-info" style="margin-top:10px;">No staged timetables currently pending review.</div>';
                            }
                        }
                    }).catch(function () {});
                });
                refreshPendingStaging();
            }
        }

        setupTimetableUploads();

        var initial = viewFromHash();
        if (initial) showView(initial, false);

        loadSession().then(bootstrap);
    });
})();
