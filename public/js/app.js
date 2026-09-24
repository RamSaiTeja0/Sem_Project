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
        logout: '/api/auth/logout',
        facultyRequests: '/api/faculty-requests',
        attendance: '/api/attendance',
        invigilation: '/api/invigilation',
        substitutions: '/api/substitutions'
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
        return fetch(url, { credentials: 'same-origin' }).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) {
                    if (!res.ok) {
                        var msg = (body && (body.error || body.message)) || ('HTTP ' + res.status);
                        var err = new Error(msg);
                        err.body = body;
                        err.status = res.status;
                        throw err;
                    }
                    return body;
                });
        }).catch(function (err) {
            if (err.status) throw err;
            throw new Error(err.message === 'Failed to fetch'
                ? 'Server is temporarily unreachable. Please ensure the server is running.'
                : err.message);
        });
    }

    function postJson(url, payload, method) {
        var options = {
            method: method || 'POST',
            credentials: 'same-origin'
        };
        if (payload != null) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(payload);
        }
        return fetch(url, options).then(function (res) {
            return res.json().catch(function () { return null; })
                .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }).catch(function (err) {
            return {
                ok: false,
                status: 0,
                body: {
                    error: err.message === 'Failed to fetch'
                        ? 'Server is temporarily unreachable. Please ensure the server is running.'
                        : err.message
                }
            };
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

    function parseSemesterNumber(val) {
        if (val == null) return null;
        var str = String(val).trim().toUpperCase();
        var romanMap = { 'VIII': 8, 'VII': 7, 'VI': 6, 'IV': 4, 'V': 5, 'III': 3, 'II': 2, 'I': 1 };
        for (var r in romanMap) {
            if (new RegExp('\\b' + r + '\\b').test(str) || str === r || str === 'SEM-' + r || str === 'SEMESTER-' + r) {
                return romanMap[r];
            }
        }
        var digitMatch = str.match(/\d+/);
        if (digitMatch) {
            var num = parseInt(digitMatch[0], 10);
            if (num >= 1 && num <= 12) return num;
        }
        return null;
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
        schedule: 'My Timetable',
        timetable: 'Master Timetable',
        faculty: 'Faculty Directory',
        requests: 'Faculty Registration Requests',
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
        about: 'Settings / About'
    };

    var VIEW_NAMES = Object.keys(TITLES);

    /** Open the view named in the URL hash, so the home page can link into it. */
    function viewFromHash() {
        var name = (window.location.hash || '').replace(/^#/, '');
        return VIEW_NAMES.indexOf(name) >= 0 ? name : null;
    }

    var HOS_ONLY_VIEWS = ['faculty', 'requests', 'attendance', 'invigilation', 'invig-requests', 'hos-substitutions', 'manage', 'import', 'about'];
    var FACULTY_ONLY_VIEWS = ['my-attendance', 'my-invigilation', 'request-invigilation', 'faculty-substitutions'];

    function showView(name, updateHash) {
        var isFaculty = Boolean(state.user && state.user.role === 'faculty');
        var isHOS = Boolean(state.user && (state.user.role === 'hos' || state.user.role === 'coordinator' || state.user.role === 'admin'));

        if (!state.user && (HOS_ONLY_VIEWS.indexOf(name) >= 0 || FACULTY_ONLY_VIEWS.indexOf(name) >= 0)) {
            name = 'dashboard';
        } else if (isFaculty && HOS_ONLY_VIEWS.indexOf(name) >= 0) {
            name = 'schedule';
        } else if (isHOS && FACULTY_ONLY_VIEWS.indexOf(name) >= 0) {
            name = 'dashboard';
        }

        Array.prototype.forEach.call(document.querySelectorAll('.view'), function (section) {
            section.classList.toggle('is-active', section.id === 'view-' + name);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (button) {
            button.classList.toggle('is-active', button.dataset.view === name);
        });
        el('viewTitle').textContent = TITLES[name] || 'Dashboard';

        if (name === 'faculty') { loadFacultyForm(); loadFacultyTable(); }
        if (name === 'requests') { loadFacultyRequests(); }
        if (name === 'attendance') { loadHOSAttendance(); }
        if (name === 'my-attendance') { loadMyAttendance(); }
        if (name === 'invigilation') { loadHOSInvigilation(); }
        if (name === 'invig-requests') { loadHOSInvigRequests(); }
        if (name === 'my-invigilation') { loadMyInvigilation(); }
        if (name === 'request-invigilation') { loadRequestInvigilationForm(); }
        if (name === 'faculty-substitutions') { loadFacultySubstitutionsView(); }
        if (name === 'hos-substitutions') { loadHOSSubstitutionsView(); }
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

        if (el('userName')) el('userName').textContent = name;
        if (el('userRole')) el('userRole').textContent = role;
        if (el('userAvatar')) el('userAvatar').textContent = initials(name);

        if (el('loginLink')) el('loginLink').style.display = state.user ? 'none' : '';
        if (el('logoutBtn')) {
            el('logoutBtn').hidden = !state.user;
            el('logoutBtn').style.display = state.user ? '' : 'none';
        }
        if (el('sidebarLogout')) {
            el('sidebarLogout').style.display = state.user ? '' : 'none';
        }

        var isFaculty = Boolean(state.user && state.user.role === 'faculty');
        var isHOS = Boolean(state.user && (state.user.role === 'hos' || state.user.role === 'coordinator' || state.user.role === 'admin'));

        // Role-based navigation visibility
        if (el('navFaculty')) el('navFaculty').style.display = isHOS ? '' : 'none';
        if (el('navRequests')) el('navRequests').style.display = isHOS ? '' : 'none';
        if (el('navAttendance')) el('navAttendance').style.display = isHOS ? '' : 'none';
        if (el('navMyAttendance')) el('navMyAttendance').style.display = isFaculty ? '' : 'none';
        if (el('navInvigilation')) el('navInvigilation').style.display = isHOS ? '' : 'none';
        if (el('navInvigRequests')) el('navInvigRequests').style.display = isHOS ? '' : 'none';
        if (el('navMyInvigilation')) el('navMyInvigilation').style.display = isFaculty ? '' : 'none';
        if (el('navRequestInvigilation')) el('navRequestInvigilation').style.display = isFaculty ? '' : 'none';
        if (el('navFacultySubstitutions')) el('navFacultySubstitutions').style.display = isFaculty ? '' : 'none';
        if (el('navHosSubstitutions')) el('navHosSubstitutions').style.display = isHOS ? '' : 'none';
        if (el('navManageLabel')) el('navManageLabel').style.display = isHOS ? '' : 'none';
        if (el('navManage')) el('navManage').style.display = isHOS ? '' : 'none';
        if (el('navImport')) el('navImport').style.display = isHOS ? '' : 'none';
        if (el('navAbout')) el('navAbout').style.display = isHOS ? '' : 'none';
        if (el('navSchedule')) el('navSchedule').style.display = (isFaculty || isHOS) ? '' : 'none';

        if (isHOS) {
            updatePendingRequestsBadge();
            updatePendingInvigRequestsBadge();
        }
        if (isFaculty) {
            updatePendingSubstitutionsBadge();
        }

        var manageBtn = el('ttManageBtn');
        if (manageBtn) {
            manageBtn.style.display = isHOS ? '' : 'none';
        }

        var btnTtEditMode = el('btnTtEditMode');
        if (btnTtEditMode) {
            btnTtEditMode.style.display = isHOS ? '' : 'none';
        }

        var btnTtClearScope = el('btnTtClearScope');
        if (btnTtClearScope) {
            btnTtClearScope.style.display = isHOS ? '' : 'none';
        }

        var facAddCard = el('facAddCard');
        if (facAddCard) {
            facAddCard.style.display = isHOS ? '' : 'none';
        }

        var hosUploadCard = el('hosUploadCard');
        if (hosUploadCard) {
            hosUploadCard.style.display = isHOS ? '' : 'none';
        }

        var hosStagingCard = el('hosStagingCard');
        if (hosStagingCard && !isHOS) {
            hosStagingCard.style.display = 'none';
        }

        var ttEditModal = el('ttEditModal');
        if (ttEditModal && !isHOS) {
            ttEditModal.style.display = 'none';
        }

        var deptCode = state.user ? state.user.department : 'Branch';
        var branchName = state.user ? (state.user.branchName || '') : '';
        var branchDisplay = deptCode ? (branchName && branchName !== deptCode ? deptCode + ' — ' + branchName : deptCode) : 'Branch';

        ['schedBranchBadge', 'availBranchBadge', 'facBranchBadge', 'facNewBranchBadge', 'ttBranchBadge', 'aboutBranchBadge', 'reqBranchBadge', 'hosSubBranchBadge'].forEach(function (id) {
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

        var freeList = result.available || [];
        var sameBranchCode = (result.sameBranch && result.sameBranch.branch) ||
            result.priorityBranch || (cell && cell.branch) || result.branch || '';

        var sameList = (result.sameBranch && result.sameBranch.available) || freeList.filter(function (f) {
            return sameBranchCode && (f.department || '').toUpperCase() === sameBranchCode.toUpperCase();
        });
        var otherList = (result.otherBranches && result.otherBranches.available) || freeList.filter(function (f) {
            return !sameBranchCode || (f.department || '').toUpperCase() !== sameBranchCode.toUpperCase();
        });

        var freeHtml = '';
        if (freeList.length === 0) {
            freeHtml = notice('No faculty are free during this period.', 'warn');
        } else if (sameBranchCode) {
            var sameSection = '';
            if (sameList.length > 0) {
                sameSection = '<div style="font-weight:650; font-size:0.86rem; color:var(--ink-800); margin:8px 0 6px 0;">Same Branch — ' + esc(sameBranchCode) + ' (' + sameList.length + ')</div>' +
                    '<ul class="faculty-list">' + sameList.map(function (f) {
                        var phoneHtml = f.phone
                            ? '<div class="faculty-phone"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</div>'
                            : '';
                        return '<li><span class="tick">✓</span>' +
                            '<div class="faculty-main">' +
                                '<div class="faculty-name">' + esc(f.faculty || f.name) + '</div>' +
                                phoneHtml +
                            '</div>' +
                            '<span class="dept">' + esc(f.department || sameBranchCode) + '</span></li>';
                    }).join('') + '</ul>';
            } else {
                sameSection = '<div style="font-weight:650; font-size:0.86rem; color:var(--ink-800); margin:8px 0 6px 0;">Same Branch — ' + esc(sameBranchCode) + ' (0)</div>' +
                    '<p class="muted" style="margin:4px 0 10px 0;">No free faculty in same branch.</p>';
            }

            var otherSection = '';
            if (otherList.length > 0) {
                otherSection = '<div style="font-weight:650; font-size:0.86rem; color:var(--ink-800); margin:14px 0 6px 0;">Other Branches (' + otherList.length + ')</div>' +
                    '<ul class="faculty-list">' + otherList.map(function (f) {
                        var phoneHtml = f.phone
                            ? '<div class="faculty-phone"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</div>'
                            : '';
                        var deptPrefix = f.department ? '<strong style="color:var(--brand-700); margin-right:6px;">' + esc(f.department) + ' —</strong> ' : '';
                        return '<li><span class="tick">✓</span>' +
                            '<div class="faculty-main">' +
                                '<div class="faculty-name">' + deptPrefix + esc(f.faculty || f.name) + '</div>' +
                                phoneHtml +
                            '</div>' +
                            '<span class="dept">' + esc(f.department || '') + '</span></li>';
                    }).join('') + '</ul>';
            }

            freeHtml = sameSection + otherSection;
        } else {
            freeHtml = '<ul class="faculty-list">' + freeList.map(function (f) {
                var phoneHtml = f.phone
                    ? '<div class="faculty-phone"><span class="phone-icon">📞</span> ' + esc(f.phone) + '</div>'
                    : '';
                return '<li><span class="tick">✓</span>' +
                    '<div class="faculty-main">' +
                        '<div class="faculty-name">' + esc(f.faculty || f.name) + '</div>' +
                        phoneHtml +
                    '</div>' +
                    '<span class="dept">' + esc(f.department || '') + '</span></li>';
            }).join('') + '</ul>';
        }

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

        var dateInput = el('availDate');
        if (dateInput && !dateInput.value) {
            var now = new Date();
            var yyyy = now.getFullYear();
            var mm = String(now.getMonth() + 1).padStart(2, '0');
            var dd = String(now.getDate()).padStart(2, '0');
            dateInput.value = yyyy + '-' + mm + '-' + dd;
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
                var opts = '<option value="">None / Auto from Attendance</option>';
                opts += facultyList.map(function (f) {
                    return '<option value="' + esc(f.name) + '">' + esc(f.name) +
                        (f.designation ? ' · ' + esc(f.designation) : '') + '</option>';
                }).join('');
                absentSelect.innerHTML = opts;
            }

            var days = metaData.days || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
            var daySelect = el('availDay');
            if (daySelect) {
                daySelect.innerHTML = days.map(function (d) {
                    return '<option value="' + esc(d) + '">' + esc(d) + '</option>';
                }).join('');
            }

            if (dateInput && daySelect) {
                var updateDayFromDate = function () {
                    if (dateInput.value) {
                        var parts = dateInput.value.split('-');
                        if (parts.length === 3) {
                            var dObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                            var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                            var dName = dayNames[dObj.getDay()];
                            if (days.indexOf(dName) !== -1) {
                                daySelect.value = dName;
                            }
                        }
                    }
                };
                dateInput.removeEventListener('change', updateDayFromDate);
                dateInput.addEventListener('change', updateDayFromDate);
                updateDayFromDate();
            }

            var periods = metaData.periods || [1, 2, 3, 4, 5, 6, 7];
            var periodSelect = el('availPeriod');
            if (periodSelect) {
                periodSelect.innerHTML = periods.map(function (p) {
                    return '<option value="' + esc(p) + '">Period ' + esc(p) + '</option>';
                }).join('');
            }

            var classSelect = el('availClassSection');
            if (classSelect) {
                var classOpts = '<option value="">All Classes</option>';
                var classes = metaData.classes || [];
                classOpts += classes.map(function (c) {
                    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
                }).join('');
                classSelect.innerHTML = classOpts;
            }
        }).catch(function (err) {
            var resBox = el('availHOSResult');
            if (resBox) resBox.innerHTML = notice('Could not load faculty references: ' + err.message, 'error');
        });
    }

    function checkHOSAvailability() {
        var resBox = el('availHOSResult');
        if (!resBox) return;

        var dateVal = el('availDate') ? el('availDate').value : '';
        var absent = el('availAbsentFaculty') ? el('availAbsentFaculty').value : '';
        var day = el('availDay') ? el('availDay').value : '';
        var period = el('availPeriod') ? parseInt(el('availPeriod').value, 10) : 1;
        var classVal = el('availClassSection') ? el('availClassSection').value : '';

        resBox.innerHTML = notice('Calculating faculty availability and substitute candidates…', 'info');

        var query = [];
        if (dateVal) query.push('date=' + encodeURIComponent(dateVal));
        if (day) query.push('day=' + encodeURIComponent(day));
        if (period) query.push('period=' + encodeURIComponent(period));
        if (classVal) query.push('class=' + encodeURIComponent(classVal));
        if (absent) query.push('absentFaculty=' + encodeURIComponent(absent));

        var endpoint = '/api/availability/candidates?' + query.join('&');

        getJson(endpoint).then(function (data) {
            renderHOSAvailabilityResult(resBox, data);
        }).catch(function (err) {
            // Fallback to POST /api/availability
            postJson('/api/availability', {
                date: dateVal || undefined,
                absentFaculty: absent || undefined,
                day: day,
                period: period,
                class: classVal || undefined,
                includeAbsent: true
            }).then(function (res) {
                if (!res.ok) {
                    var msg = (res.body && res.body.error) || ('HTTP ' + res.status);
                    resBox.innerHTML = notice(msg, 'error');
                    return;
                }
                renderHOSAvailabilityResult(resBox, res.body || {});
            }).catch(function (postErr) {
                resBox.innerHTML = notice(err.message || postErr.message || 'Could not calculate availability.', 'error');
            });
        });
    }

    function renderHOSAvailabilityResult(resBox, data) {
        var sameBranchCode = (data.sameBranch && data.sameBranch.branch) ||
            data.priorityBranch || data.branch || '';

        var candidateList = data.candidates || data.available || [];
        var sameCandidates = (data.sameBranch && data.sameBranch.candidates) ||
            (data.sameBranch && data.sameBranch.available) ||
            candidateList.filter(function (f) {
                return sameBranchCode && (f.department || f.branch || '').toUpperCase() === sameBranchCode.toUpperCase();
            });

        var otherCandidates = (data.otherBranches && data.otherBranches.candidates) ||
            (data.otherBranches && data.otherBranches.available) ||
            candidateList.filter(function (f) {
                return !sameBranchCode || (f.department || f.branch || '').toUpperCase() !== sameBranchCode.toUpperCase();
            });

        // 1. Substitute Candidates Section
        var candidatesHtml = '<div style="margin-bottom:20px; padding:14px; background:var(--surface-subtle, #f8fafc); border-radius:var(--radius-sm, 6px); border:1px solid var(--border-color, #e2e8f0);">' +
            '<h3 style="margin:0 0 10px 0; font-size:1.02rem; color:var(--ink-900, #0f172a);">Substitute Candidates (FREE Only)</h3>';

        // Same Branch Candidates
        candidatesHtml += '<div style="font-weight:650; font-size:0.88rem; color:var(--ink-800); margin:8px 0 6px 0;">Same Branch' + (sameBranchCode ? ' — ' + esc(sameBranchCode) : '') + ' (' + sameCandidates.length + ')</div>';
        if (sameCandidates.length > 0) {
            candidatesHtml += '<ol style="margin:0 0 12px 18px; padding:0;">' + sameCandidates.map(function (c) {
                return '<li style="margin-bottom:4px; font-size:0.9rem;"><strong>' + esc(c.facultyName || c.name || c.faculty) + '</strong>' +
                    (c.phone ? ' <span class="muted" style="font-size:0.82rem;">📞 ' + esc(c.phone) + '</span>' : '') +
                    ' <span class="badge badge-free" style="margin-left:6px;">FREE</span></li>';
            }).join('') + '</ol>';
        } else {
            candidatesHtml += '<p class="muted" style="margin:0 0 10px 0; font-size:0.86rem;">No free faculty in same branch.</p>';
        }

        // Other Branches Candidates
        candidatesHtml += '<div style="font-weight:650; font-size:0.88rem; color:var(--ink-800); margin:10px 0 6px 0;">Other Branches (' + otherCandidates.length + ')</div>';
        if (otherCandidates.length > 0) {
            candidatesHtml += '<ol style="margin:0 0 6px 18px; padding:0;">' + otherCandidates.map(function (c) {
                var dept = c.branch || c.department || '';
                return '<li style="margin-bottom:4px; font-size:0.9rem;"><strong>' + esc(c.facultyName || c.name || c.faculty) + '</strong>' +
                    (dept ? ' <span class="muted" style="font-size:0.82rem;">(' + esc(dept) + ')</span>' : '') +
                    (c.phone ? ' <span class="muted" style="font-size:0.82rem;">📞 ' + esc(c.phone) + '</span>' : '') +
                    ' <span class="badge badge-free" style="margin-left:6px;">FREE</span></li>';
            }).join('') + '</ol>';
        } else {
            candidatesHtml += '<p class="muted" style="margin:0; font-size:0.86rem;">No free faculty in other branches.</p>';
        }
        candidatesHtml += '</div>';

        // 2. Full Faculty Availability Status Table (FREE, BUSY [TEACHING/INVIGILATION], ABSENT)
        var facultyList = data.faculty || data.allFaculty || [];
        var tableHtml = '<div style="margin-top:16px;">' +
            '<h3 style="margin:0 0 10px 0; font-size:1.02rem; color:var(--ink-900, #0f172a);">Faculty Availability Status</h3>' +
            '<div class="table-scroll">' +
            '<table class="table" style="width:100%; border-collapse:collapse; font-size:0.88rem;">' +
            '<thead>' +
                '<tr style="border-bottom:2px solid var(--border-color, #e2e8f0); text-align:left;">' +
                    '<th style="padding:8px 10px;">Faculty</th>' +
                    '<th style="padding:8px 10px;">Status</th>' +
                    '<th style="padding:8px 10px;">Reason</th>' +
                    '<th style="padding:8px 10px;">Branch</th>' +
                '</tr>' +
            '</thead>' +
            '<tbody>';

        if (facultyList.length === 0) {
            tableHtml += '<tr><td colspan="4" class="muted" style="padding:12px; text-align:center;">No faculty records found.</td></tr>';
        } else {
            facultyList.forEach(function (f) {
                var status = String(f.status || '').toUpperCase();
                var badgeClass = 'badge-free';
                var badgeStyle = '';
                if (status === 'BUSY') {
                    badgeClass = 'badge-busy';
                } else if (status === 'ABSENT') {
                    badgeClass = 'badge';
                    badgeStyle = 'background:#fee2e2; color:#991b1b;';
                }

                var reason = f.reason || '—';
                var dept = f.branch || f.department || '—';

                tableHtml += '<tr style="border-bottom:1px solid var(--border-color, #f1f5f9);">' +
                    '<td style="padding:8px 10px; font-weight:550;">' + esc(f.facultyName || f.name || f.faculty) + '</td>' +
                    '<td style="padding:8px 10px;"><span class="badge ' + badgeClass + '" style="' + badgeStyle + '">' + esc(status) + '</span></td>' +
                    '<td style="padding:8px 10px; color:var(--ink-700);">' + esc(reason) + '</td>' +
                    '<td style="padding:8px 10px; color:var(--ink-600);">' + esc(dept) + '</td>' +
                '</tr>';
            });
        }

        tableHtml += '</tbody></table></div></div>';

        var absentNotice = data.absentFaculty
            ? '<div class="notice notice-warn" style="margin-bottom:14px;">' +
                '<strong>Absent:</strong> ' + esc(data.absentFaculty.name) +
                '<span class="muted" style="margin-left:8px;">(Excluded from substitute cover)</span>' +
              '</div>'
            : '';

        resBox.innerHTML =
            absentNotice +
            candidatesHtml +
            tableHtml +
            '<div class="readonly-banner" style="margin-top:20px;">READ ONLY — Availability & Substitution Preparation</div>' +
            '<p class="readonly-note">This screen reports candidate rankings and availability. Automatic substitute assignment is disabled in this phase.</p>';
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
                    '<tr><td colspan="14" class="muted">No faculty match this filter.</td></tr>';
                return;
            }
            var isFacultyUser = state.user && state.user.role === 'faculty';
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

                var actionsHtml = '<span class="muted">—</span>';
                if (!isFacultyUser) {
                    var editBtn = '<button type="button" class="btn btn-secondary btn-sm btn-fac-edit" ' +
                        'data-id="' + esc(f.id) + '" ' +
                        'data-name="' + esc(f.name) + '" ' +
                        'data-branch="' + esc(f.department) + '" ' +
                        'data-phone="' + esc(f.phone || '') + '" ' +
                        'data-designation="' + esc(f.designation || 'Faculty') + '" ' +
                        'data-subjects="' + esc((f.subjects || []).join(', ')) + '" ' +
                        'style="padding: 3px 8px; font-size: 0.8rem;">Edit</button>';

                    var statusBtn = f.status === 'inactive'
                        ? '<button type="button" class="btn btn-primary btn-sm btn-fac-activate" ' +
                            'data-id="' + esc(f.id) + '" ' +
                            'data-name="' + esc(f.name) + '" ' +
                            'style="padding: 3px 8px; font-size: 0.8rem;">Reactivate</button>'
                        : '<button type="button" class="btn btn-danger btn-sm btn-fac-deactivate" ' +
                            'data-id="' + esc(f.id) + '" ' +
                            'data-name="' + esc(f.name) + '" ' +
                            'style="padding: 3px 8px; font-size: 0.8rem;">Deactivate</button>';

                    actionsHtml = '<div style="display:flex; gap:6px; align-items:center;">' + editBtn + statusBtn + '</div>';
                }

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
                    '<td style="white-space:nowrap;">' + actionsHtml + '</td>' +
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

    // -------------------------------------------------- faculty requests (B7.1)
    function updatePendingRequestsBadge() {
        if (!state.user || (state.user.role !== 'hos' && state.user.role !== 'coordinator' && state.user.role !== 'admin')) return;
        getJson(API.facultyRequests).then(function (data) {
            var pending = (data.requests || []).filter(function (r) { return r.status === 'PENDING'; });
            var badge = el('pendingRequestsCount');
            if (badge) {
                if (pending.length > 0) {
                    badge.textContent = pending.length;
                    badge.style.display = 'inline-block';
                } else {
                    badge.style.display = 'none';
                }
            }
        }).catch(function () {});
    }

    function loadFacultyRequests() {
        var alertBox = el('requestsAlertBox');
        if (alertBox) alertBox.style.display = 'none';
        var tableBody = el('requestsTableBody');
        var emptyNotice = el('requestsEmptyNotice');
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="8" class="muted">Loading requests…</td></tr>';

        return getJson(API.facultyRequests).then(function (data) {
            var requests = data.requests || [];
            renderRequestsTable(requests);
            updatePendingRequestsBadge();
        }).catch(function (err) {
            if (tableBody) tableBody.innerHTML = '<tr><td colspan="8" class="notice notice-error">Could not load requests: ' + esc(err.message) + '</td></tr>';
        });
    }

    function renderRequestsTable(requests) {
        var tableBody = el('requestsTableBody');
        var emptyNotice = el('requestsEmptyNotice');
        if (!tableBody) return;

        if (!requests || requests.length === 0) {
            tableBody.innerHTML = '';
            if (emptyNotice) emptyNotice.style.display = 'block';
            return;
        }

        if (emptyNotice) emptyNotice.style.display = 'none';
        tableBody.innerHTML = requests.map(function (req) {
            var statusBadge = req.status === 'PENDING'
                ? '<span class="badge badge-warning">PENDING</span>'
                : (req.status === 'APPROVED'
                    ? '<span class="badge badge-success">APPROVED</span>'
                    : '<span class="badge badge-danger">REJECTED</span>');

            var actionsHtml = '<span class="muted">—</span>';
            if (req.status === 'PENDING') {
                actionsHtml = '<div style="display:flex; gap:6px; align-items:center;">' +
                    '<button type="button" class="btn btn-primary btn-sm btn-req-approve" data-id="' + esc(req.id) + '" data-name="' + esc(req.name) + '" style="padding:3px 8px; font-size:0.8rem;">Approve</button>' +
                    '<button type="button" class="btn btn-danger btn-sm btn-req-reject" data-id="' + esc(req.id) + '" data-name="' + esc(req.name) + '" style="padding:3px 8px; font-size:0.8rem;">Reject</button>' +
                    '</div>';
            } else if (req.status === 'REJECTED' && req.rejectionReason) {
                actionsHtml = '<span class="muted" style="font-size:0.8rem;" title="' + esc(req.rejectionReason) + '">Reason: ' + esc(req.rejectionReason) + '</span>';
            }

            var phoneCell = req.phone
                ? '<a href="tel:' + esc(req.phone.replace(/\s+/g, '')) + '" class="phone-link"><span class="phone-icon">📞</span> ' + esc(req.phone) + '</a>'
                : '<span class="muted">—</span>';

            var requestedAtStr = req.createdAt ? new Date(req.createdAt).toLocaleString() : '—';

            return '<tr>' +
                '<td><strong>' + esc(req.name) + '</strong></td>' +
                '<td class="mono">' + esc(req.username) + '</td>' +
                '<td>' + phoneCell + '</td>' +
                '<td>' + esc(req.designation || 'Faculty') + '</td>' +
                '<td class="list" title="' + esc((req.subjects || []).join(', ')) + '">' + esc((req.subjects || []).join(', ') || '—') + '</td>' +
                '<td style="font-size:0.82rem; color:var(--ink-600);">' + esc(requestedAtStr) + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td style="white-space:nowrap;">' + actionsHtml + '</td>' +
                '</tr>';
        }).join('');
    }

    function approveFacultyRequest(id, facultyName) {
        if (!confirm('Approve registration request for "' + facultyName + '"?\n\nThis will create an active faculty account and enable login.')) {
            return;
        }

        var alertBox = el('requestsAlertBox');
        fetch(API.facultyRequests + '/' + encodeURIComponent(id) + '/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }).then(function (result) {
            if (alertBox) {
                alertBox.style.display = 'block';
                if (result.ok) {
                    alertBox.innerHTML = '<div class="notice notice-success"><strong>✓ Request Approved!</strong> Faculty account created for <strong>' + esc(result.body.user ? result.body.user.name : facultyName) + '</strong>. They can now log in.</div>';
                } else {
                    alertBox.innerHTML = '<div class="notice notice-danger"><strong>Approval Failed:</strong> ' + esc(result.body.error || 'Failed to approve request.') + '</div>';
                }
            }
            loadFacultyRequests();
            loadFacultyTable();
            loadDashboard();
            refreshDepartmentFilters();
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
            }
        });
    }

    function openRejectModal(id, facultyName) {
        if (el('rejectTargetId')) el('rejectTargetId').value = id;
        if (el('rejectReasonInput')) el('rejectReasonInput').value = '';
        var modal = el('rejectRequestModal');
        if (modal) modal.style.display = 'flex';
    }

    function closeRejectModal() {
        var modal = el('rejectRequestModal');
        if (modal) modal.style.display = 'none';
        if (el('rejectTargetId')) el('rejectTargetId').value = '';
        if (el('rejectReasonInput')) el('rejectReasonInput').value = '';
    }

    function confirmRejectFacultyRequest() {
        var targetId = el('rejectTargetId') ? el('rejectTargetId').value : '';
        if (!targetId) return;
        var reason = el('rejectReasonInput') ? el('rejectReasonInput').value.trim() : '';
        var alertBox = el('requestsAlertBox');

        var confirmBtn = el('btnConfirmReject');
        if (confirmBtn) confirmBtn.disabled = true;

        fetch(API.facultyRequests + '/' + encodeURIComponent(targetId) + '/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason })
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }).then(function (result) {
            if (confirmBtn) confirmBtn.disabled = false;
            closeRejectModal();
            if (alertBox) {
                alertBox.style.display = 'block';
                if (result.ok) {
                    alertBox.innerHTML = '<div class="notice notice-info">Faculty registration request rejected. No user account was created.</div>';
                } else {
                    alertBox.innerHTML = '<div class="notice notice-danger"><strong>Rejection Failed:</strong> ' + esc(result.body.error || 'Failed to reject request.') + '</div>';
                }
            }
            loadFacultyRequests();
            updatePendingRequestsBadge();
        }).catch(function (err) {
            if (confirmBtn) confirmBtn.disabled = false;
            closeRejectModal();
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
            }
        });
    }

    // -------------------------------------------------- faculty attendance (B7.2)
    function getTodayDateString() {
        var d = new Date();
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function loadHOSAttendance(dateParam) {
        var dateInput = el('attDateInput');
        var targetDate = dateParam || (dateInput && dateInput.value) || getTodayDateString();
        if (dateInput && !dateInput.value) dateInput.value = targetDate;

        var branchBadge = el('attBranchBadge');
        if (branchBadge && state.user) {
            branchBadge.textContent = state.user.department || 'Branch';
        }

        var alertBox = el('attendanceAlertBox');
        if (alertBox) alertBox.style.display = 'none';

        var tableBody = el('attendanceTableBody');
        var emptyNotice = el('attendanceEmptyNotice');
        var dateDisplay = el('attDateDisplay');

        if (tableBody) tableBody.innerHTML = '<tr><td colspan="6" class="muted">Loading attendance for ' + esc(targetDate) + '…</td></tr>';

        return getJson(API.attendance + '?date=' + encodeURIComponent(targetDate)).then(function (data) {
            if (dateDisplay) {
                dateDisplay.textContent = (data.dayOfWeek ? data.dayOfWeek + ', ' : '') + data.date;
            }
            renderHOSAttendanceTable(data.faculty || [], targetDate);
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="6" class="notice notice-error">Could not load attendance: ' + esc(err.message) + '</td></tr>';
            }
        });
    }

    function renderHOSAttendanceTable(facultyList, targetDate) {
        var tableBody = el('attendanceTableBody');
        var emptyNotice = el('attendanceEmptyNotice');
        if (!tableBody) return;

        if (!facultyList || facultyList.length === 0) {
            tableBody.innerHTML = '';
            if (emptyNotice) emptyNotice.style.display = 'block';
            return;
        }

        if (emptyNotice) emptyNotice.style.display = 'none';

        tableBody.innerHTML = facultyList.map(function (f) {
            var isAbsent = f.status === 'ABSENT';
            var statusBadge = isAbsent
                ? '<span class="badge badge-danger">ABSENT</span>'
                : '<span class="badge badge-success">PRESENT</span>';

            var actionBtn = isAbsent
                ? '<button type="button" class="btn btn-secondary btn-sm btn-mark-present" data-id="' + esc(f.id || f.facultyId) + '" data-name="' + esc(f.name) + '" data-att-id="' + esc(f.attendanceId || '') + '">Mark Present</button>'
                : '<button type="button" class="btn btn-danger btn-sm btn-mark-absent" data-id="' + esc(f.id || f.facultyId) + '" data-name="' + esc(f.name) + '">Mark Absent</button>';

            return '<tr>' +
                '<td><strong>' + esc(f.name) + '</strong></td>' +
                '<td>' + esc(f.designation || 'Faculty') + '</td>' +
                '<td>' + esc(f.department || '') + '</td>' +
                '<td>' + esc(f.phone || '—') + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + actionBtn + '</td>' +
            '</tr>';
        }).join('');

        // Attach listeners to Mark Absent buttons
        Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-mark-absent'), function (btn) {
            btn.addEventListener('click', function () {
                var facId = btn.getAttribute('data-id');
                var facName = btn.getAttribute('data-name');
                btn.disabled = true;
                postAttendanceStatus(facId, facName, targetDate, 'ABSENT');
            });
        });

        // Attach listeners to Mark Present buttons
        Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-mark-present'), function (btn) {
            btn.addEventListener('click', function () {
                var facId = btn.getAttribute('data-id');
                var facName = btn.getAttribute('data-name');
                var attId = btn.getAttribute('data-att-id');
                btn.disabled = true;
                if (attId) {
                    deleteAttendanceRecord(attId, facName, targetDate);
                } else {
                    postAttendanceStatus(facId, facName, targetDate, 'PRESENT');
                }
            });
        });
    }

    function postAttendanceStatus(facultyId, facultyName, date, status) {
        var alertBox = el('attendanceAlertBox');
        fetch(API.attendance, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ facultyId: facultyId, date: date, status: status })
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }).then(function (res) {
            if (alertBox) {
                alertBox.style.display = 'block';
                if (res.ok) {
                    alertBox.innerHTML = '<div class="notice notice-success">Marked <strong>' + esc(facultyName) + '</strong> as <strong>' + esc(status) + '</strong> for ' + esc(date) + '.</div>';
                } else {
                    alertBox.innerHTML = '<div class="notice notice-danger">Failed to mark attendance: ' + esc(res.body.error || 'Unknown error') + '</div>';
                }
            }
            loadHOSAttendance(date);
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
            }
            loadHOSAttendance(date);
        });
    }

    function deleteAttendanceRecord(attendanceId, facultyName, date) {
        var alertBox = el('attendanceAlertBox');
        fetch(API.attendance + '/' + encodeURIComponent(attendanceId), {
            method: 'DELETE'
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }).then(function (res) {
            if (alertBox) {
                alertBox.style.display = 'block';
                if (res.ok) {
                    alertBox.innerHTML = '<div class="notice notice-success">Marked <strong>' + esc(facultyName) + '</strong> as <strong>PRESENT</strong> for ' + esc(date) + '.</div>';
                } else {
                    alertBox.innerHTML = '<div class="notice notice-danger">Failed to update attendance: ' + esc(res.body.error || 'Unknown error') + '</div>';
                }
            }
            loadHOSAttendance(date);
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
            }
            loadHOSAttendance(date);
        });
    }

    function loadMyAttendance() {
        var tableBody = el('myAttendanceTableBody');
        var emptyNotice = el('myAttendanceEmptyNotice');
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="4" class="muted">Loading your attendance records…</td></tr>';

        return getJson(API.attendance + '/my').then(function (data) {
            var records = data.records || [];
            if (!records.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = records.map(function (r) {
                var badge = r.status === 'ABSENT'
                    ? '<span class="badge badge-danger">ABSENT</span>'
                    : '<span class="badge badge-success">PRESENT</span>';
                return '<tr>' +
                    '<td><strong>' + esc(r.date) + '</strong></td>' +
                    '<td>' + esc(r.dayOfWeek || '—') + '</td>' +
                    '<td>' + badge + '</td>' +
                    '<td>' + esc(r.markedBy || 'HOS') + '</td>' +
                '</tr>';
            }).join('');
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="4" class="notice notice-error">Could not load attendance: ' + esc(err.message) + '</td></tr>';
            }
        });
    }

    // -------------------------------------------------- exam invigilation (B7.3)
    var activeInvigPeriods = [1, 2, 3, 4, 5, 6, 7];

    function fetchConfiguredPeriods() {
        return getJson(API.invigilation + '/periods').then(function (data) {
            if (data && Array.isArray(data.periods) && data.periods.length > 0) {
                activeInvigPeriods = data.periods;
            }
            return activeInvigPeriods;
        }).catch(function () {
            return activeInvigPeriods;
        });
    }

    function loadHOSInvigilation(filterDate) {
        if (el('invigBranchBadge')) {
            el('invigBranchBadge').textContent = (state.user && state.user.department) || 'Branch';
        }
        loadHOSInvigFacultyDropdown();
        loadHOSInvigPeriodsCheckboxes();
        loadActiveInvigTable(filterDate);
    }

    function loadHOSInvigFacultyDropdown() {
        var sel = el('directInvigFaculty');
        if (!sel) return;
        var myDept = state.user && state.user.department ? state.user.department.toUpperCase() : '';
        getJson(API.faculty).then(function (roster) {
            var branchFaculty = (roster || []).filter(function (f) {
                return !myDept || (f.department && f.department.toUpperCase() === myDept);
            });
            sel.innerHTML = '<option value="">Select faculty…</option>' + branchFaculty.map(function (f) {
                return '<option value="' + esc(f.id || f.name) + '">' + esc(f.name) + (f.designation ? ' (' + esc(f.designation) + ')' : '') + '</option>';
            }).join('');
        }).catch(function () {});
    }

    function loadHOSInvigPeriodsCheckboxes() {
        var wrap = el('directInvigPeriodsWrap');
        if (!wrap) return;
        fetchConfiguredPeriods().then(function (periods) {
            wrap.innerHTML = periods.map(function (p) {
                return '<label style="display:inline-flex; align-items:center; gap:5px; font-size:0.88rem; cursor:pointer; background:var(--surface); padding:4px 10px; border:1px solid var(--border); border-radius:var(--radius-sm);">' +
                    '<input type="checkbox" name="directInvigPeriod" value="' + p + '" /> P' + p +
                '</label>';
            }).join('');
        });
    }

    function loadActiveInvigTable(filterDate) {
        var tableBody = el('activeInvigTableBody');
        var emptyNotice = el('activeInvigEmptyNotice');
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="7" class="muted">Loading scheduled invigilations…</td></tr>';

        var url = API.invigilation;
        if (filterDate) {
            url += '?date=' + encodeURIComponent(filterDate);
        }

        return getJson(url).then(function (data) {
            var list = data.assignments || [];
            if (!list.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = list.map(function (a) {
                var srcBadge = a.source === 'DIRECT'
                    ? '<span class="badge badge-primary">DIRECT</span>'
                    : '<span class="badge badge-info">REQUEST</span>';
                return '<tr>' +
                    '<td><strong>' + esc(a.facultyName) + '</strong></td>' +
                    '<td>' + esc(a.examDate) + '</td>' +
                    '<td>' + esc(a.dayOfWeek || '—') + '</td>' +
                    '<td><span class="badge badge-warning">P' + esc(a.period) + '</span></td>' +
                    '<td>' + srcBadge + '</td>' +
                    '<td>' + esc(a.notes || '—') + '</td>' +
                    '<td><button type="button" class="btn btn-danger btn-sm btn-cancel-invig" data-id="' + esc(a.id) + '">Cancel</button></td>' +
                '</tr>';
            }).join('');

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-cancel-invig'), function (btn) {
                btn.addEventListener('click', function () {
                    var id = btn.getAttribute('data-id');
                    if (window.confirm('Are you sure you want to cancel this invigilation assignment?')) {
                        deleteActiveInvig(id);
                    }
                });
            });
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="7" class="notice notice-error">Could not load invigilations: ' + esc(err.message) + '</td></tr>';
            }
        });
    }

    function deleteActiveInvig(id) {
        fetch(API.invigilation + '/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) throw new Error(body.error || 'Failed to cancel invigilation');
                loadActiveInvigTable(el('filterInvigDate') ? el('filterInvigDate').value : null);
            });
        }).catch(function (err) {
            window.alert('Error: ' + err.message);
        });
    }

    function handleDirectInvigSubmit(e) {
        e.preventDefault();
        var alertBox = el('directInvigAlert');
        var facultyId = el('directInvigFaculty') ? el('directInvigFaculty').value : '';
        var date = el('directInvigDate') ? el('directInvigDate').value : '';
        var notes = el('directInvigNotes') ? el('directInvigNotes').value : '';

        var checkedPeriods = [];
        var checkboxes = document.querySelectorAll('input[name="directInvigPeriod"]:checked');
        for (var i = 0; i < checkboxes.length; i++) {
            checkedPeriods.push(parseInt(checkboxes[i].value, 10));
        }

        if (!facultyId) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Please select a faculty member.</div>';
            }
            return;
        }
        if (!date) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Please select an exam date.</div>';
            }
            return;
        }
        if (!checkedPeriods.length) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Please select at least one period.</div>';
            }
            return;
        }

        var payload = {
            facultyId: facultyId,
            date: date,
            periods: checkedPeriods,
            notes: notes
        };

        fetch(API.invigilation, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) {
                    var msg = body.error || 'Failed to assign invigilation.';
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(msg) + '</div>';
                    }
                    return;
                }
                if (alertBox) {
                    alertBox.style.display = 'block';
                    alertBox.innerHTML = '<div class="notice notice-success">Invigilation duty assigned successfully!</div>';
                    setTimeout(function () { alertBox.style.display = 'none'; }, 4000);
                }
                el('directInvigForm').reset();
                loadHOSInvigFacultyDropdown();
                loadHOSInvigPeriodsCheckboxes();
                loadActiveInvigTable();
            });
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function loadHOSInvigRequests(statusParam) {
        var tableBody = el('invigRequestsTableBody');
        var emptyNotice = el('invigRequestsEmptyNotice');
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="8" class="muted">Loading invigilation requests…</td></tr>';

        var status = statusParam !== undefined ? statusParam : (el('filterInvigReqStatus') ? el('filterInvigReqStatus').value : 'PENDING');
        var url = API.invigilation + '/requests' + (status ? '?status=' + encodeURIComponent(status) : '');

        return getJson(url).then(function (data) {
            var list = data.requests || [];
            if (!list.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = list.map(function (r) {
                var statusBadge = r.status === 'PENDING'
                    ? '<span class="badge badge-warning">PENDING</span>'
                    : (r.status === 'APPROVED'
                        ? '<span class="badge badge-success">APPROVED</span>'
                        : '<span class="badge badge-danger">REJECTED</span>');

                var actions = '';
                if (r.status === 'PENDING') {
                    actions = '<div style="display:flex; gap:6px;">' +
                        '<button type="button" class="btn btn-primary btn-sm btn-approve-invig" data-id="' + esc(r.id) + '">Approve</button>' +
                        '<button type="button" class="btn btn-secondary btn-sm btn-reject-invig" data-id="' + esc(r.id) + '">Reject</button>' +
                    '</div>';
                } else if (r.status === 'REJECTED' && r.rejectionReason) {
                    actions = '<span class="muted" style="font-size:0.8rem;">Reason: ' + esc(r.rejectionReason) + '</span>';
                } else {
                    actions = '<span class="muted" style="font-size:0.8rem;">Reviewed by ' + esc(r.reviewedBy || 'HOS') + '</span>';
                }

                var periodsDisplay = Array.isArray(r.periods) ? r.periods.map(function (p) { return 'P' + p; }).join(', ') : '—';
                var dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—';

                return '<tr>' +
                    '<td><strong>' + esc(r.facultyName) + '</strong></td>' +
                    '<td>' + esc(r.examDate) + '</td>' +
                    '<td>' + esc(r.dayOfWeek || '—') + '</td>' +
                    '<td>' + esc(periodsDisplay) + '</td>' +
                    '<td>' + esc(r.reason || '—') + '</td>' +
                    '<td>' + statusBadge + '</td>' +
                    '<td>' + esc(dateStr) + '</td>' +
                    '<td>' + actions + '</td>' +
                '</tr>';
            }).join('');

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-approve-invig'), function (btn) {
                btn.addEventListener('click', function () {
                    approveInvigRequest(btn.getAttribute('data-id'));
                });
            });

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-reject-invig'), function (btn) {
                btn.addEventListener('click', function () {
                    openRejectInvigModal(btn.getAttribute('data-id'));
                });
            });
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="8" class="notice notice-error">Could not load requests: ' + esc(err.message) + '</td></tr>';
            }
        });
    }

    function approveInvigRequest(id) {
        var alertBox = el('invigReqReviewAlert');
        fetch(API.invigilation + '/requests/' + encodeURIComponent(id) + '/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(body.error || 'Failed to approve request') + '</div>';
                    }
                    return;
                }
                if (alertBox) {
                    alertBox.style.display = 'block';
                    alertBox.innerHTML = '<div class="notice notice-success">Request approved and invigilation assigned!</div>';
                    setTimeout(function () { alertBox.style.display = 'none'; }, 4000);
                }
                loadHOSInvigRequests();
                updatePendingInvigRequestsBadge();
            });
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function openRejectInvigModal(id) {
        var modal = el('rejectInvigModal');
        var targetInput = el('rejectInvigTargetId');
        var reasonInput = el('rejectInvigReasonInput');
        if (targetInput) targetInput.value = id;
        if (reasonInput) reasonInput.value = '';
        if (modal) modal.style.display = 'flex';
    }

    function closeRejectInvigModal() {
        var modal = el('rejectInvigModal');
        if (modal) modal.style.display = 'none';
    }

    function confirmRejectInvig() {
        var id = el('rejectInvigTargetId') ? el('rejectInvigTargetId').value : '';
        var reason = el('rejectInvigReasonInput') ? el('rejectInvigReasonInput').value : '';
        if (!id) return;

        var alertBox = el('invigReqReviewAlert');
        fetch(API.invigilation + '/requests/' + encodeURIComponent(id) + '/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rejectionReason: reason })
        }).then(function (res) {
            return res.json().then(function (body) {
                closeRejectInvigModal();
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(body.error || 'Failed to reject request') + '</div>';
                    }
                    return;
                }
                if (alertBox) {
                    alertBox.style.display = 'block';
                    alertBox.innerHTML = '<div class="notice notice-info">Invigilation request rejected.</div>';
                    setTimeout(function () { alertBox.style.display = 'none'; }, 4000);
                }
                loadHOSInvigRequests();
                updatePendingInvigRequestsBadge();
            });
        }).catch(function (err) {
            closeRejectInvigModal();
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function updatePendingInvigRequestsBadge() {
        var badge = el('pendingInvigRequestsCount');
        if (!badge) return;
        getJson(API.invigilation + '/requests?status=PENDING').then(function (data) {
            var count = (data && data.requests) ? data.requests.length : 0;
            if (count > 0) {
                badge.textContent = count;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }).catch(function () {
            badge.style.display = 'none';
        });
    }

    function loadMyInvigilation() {
        var myInvigTableBody = el('myInvigTableBody');
        var myInvigEmptyNotice = el('myInvigEmptyNotice');
        var myReqTableBody = el('myInvigRequestsTableBody');
        var myReqEmptyNotice = el('myInvigRequestsEmptyNotice');

        if (myInvigTableBody) myInvigTableBody.innerHTML = '<tr><td colspan="6" class="muted">Loading your invigilation duties…</td></tr>';
        if (myReqTableBody) myReqTableBody.innerHTML = '<tr><td colspan="6" class="muted">Loading your requests…</td></tr>';

        return getJson(API.invigilation + '/my').then(function (data) {
            // Render active assignments
            var assignments = data.assignments || [];
            if (!assignments.length) {
                if (myInvigTableBody) myInvigTableBody.innerHTML = '';
                if (myInvigEmptyNotice) myInvigEmptyNotice.style.display = 'block';
            } else {
                if (myInvigEmptyNotice) myInvigEmptyNotice.style.display = 'none';
                myInvigTableBody.innerHTML = assignments.map(function (a) {
                    var srcBadge = a.source === 'DIRECT'
                        ? '<span class="badge badge-primary">DIRECT</span>'
                        : '<span class="badge badge-info">REQUEST</span>';
                    return '<tr>' +
                        '<td><strong>' + esc(a.examDate) + '</strong></td>' +
                        '<td>' + esc(a.dayOfWeek || '—') + '</td>' +
                        '<td><span class="badge badge-warning">P' + esc(a.period) + '</span></td>' +
                        '<td>' + srcBadge + '</td>' +
                        '<td>' + esc(a.notes || '—') + '</td>' +
                        '<td>' + esc(a.assignedBy || 'HOS') + '</td>' +
                    '</tr>';
                }).join('');
            }

            // Render requests
            var requests = data.requests || [];
            if (!requests.length) {
                if (myReqTableBody) myReqTableBody.innerHTML = '';
                if (myReqEmptyNotice) myReqEmptyNotice.style.display = 'block';
            } else {
                if (myReqEmptyNotice) myReqEmptyNotice.style.display = 'none';
                myReqTableBody.innerHTML = requests.map(function (r) {
                    var statusBadge = r.status === 'PENDING'
                        ? '<span class="badge badge-warning">PENDING</span>'
                        : (r.status === 'APPROVED'
                            ? '<span class="badge badge-success">APPROVED</span>'
                            : '<span class="badge badge-danger">REJECTED</span>');

                    var reviewNotes = r.status === 'REJECTED'
                        ? (r.rejectionReason ? 'Reason: ' + esc(r.rejectionReason) : 'Rejected by HOS')
                        : (r.status === 'APPROVED' ? 'Approved by ' + esc(r.reviewedBy || 'HOS') : 'Awaiting review');

                    var periodsDisplay = Array.isArray(r.periods) ? r.periods.map(function (p) { return 'P' + p; }).join(', ') : '—';

                    return '<tr>' +
                        '<td><strong>' + esc(r.examDate) + '</strong></td>' +
                        '<td>' + esc(r.dayOfWeek || '—') + '</td>' +
                        '<td>' + esc(periodsDisplay) + '</td>' +
                        '<td>' + esc(r.reason || '—') + '</td>' +
                        '<td>' + statusBadge + '</td>' +
                        '<td><span class="muted" style="font-size:0.85rem;">' + reviewNotes + '</span></td>' +
                    '</tr>';
                }).join('');
            }
        }).catch(function (err) {
            if (myInvigTableBody) {
                myInvigTableBody.innerHTML = '<tr><td colspan="6" class="notice notice-error">Could not load invigilations: ' + esc(err.message) + '</td></tr>';
            }
            if (myReqTableBody) {
                myReqTableBody.innerHTML = '<tr><td colspan="6" class="notice notice-error">Could not load requests: ' + esc(err.message) + '</td></tr>';
            }
        });
    }

    function loadRequestInvigilationForm() {
        var wrap = el('facultyInvigPeriodsWrap');
        if (!wrap) return;
        fetchConfiguredPeriods().then(function (periods) {
            wrap.innerHTML = periods.map(function (p) {
                return '<label style="display:inline-flex; align-items:center; gap:5px; font-size:0.88rem; cursor:pointer; background:var(--surface); padding:4px 10px; border:1px solid var(--border); border-radius:var(--radius-sm);">' +
                    '<input type="checkbox" name="facultyInvigPeriod" value="' + p + '" /> P' + p +
                '</label>';
            }).join('');
        });
    }

    function handleFacultyInvigRequestSubmit(e) {
        e.preventDefault();
        var alertBox = el('facultyInvigAlert');
        var date = el('facultyInvigDate') ? el('facultyInvigDate').value : '';
        var reason = el('facultyInvigReason') ? el('facultyInvigReason').value : '';

        var checkedPeriods = [];
        var checkboxes = document.querySelectorAll('input[name="facultyInvigPeriod"]:checked');
        for (var i = 0; i < checkboxes.length; i++) {
            checkedPeriods.push(parseInt(checkboxes[i].value, 10));
        }

        if (!date) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Please select an exam date.</div>';
            }
            return;
        }
        if (!checkedPeriods.length) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Please select at least one period.</div>';
            }
            return;
        }

        var payload = {
            date: date,
            periods: checkedPeriods,
            reason: reason
        };

        fetch(API.invigilation + '/requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(body.error || 'Failed to submit request.') + '</div>';
                    }
                    return;
                }
                if (alertBox) {
                    alertBox.style.display = 'block';
                    alertBox.innerHTML = '<div class="notice notice-success">Invigilation request submitted successfully! Your HOS will review it.</div>';
                    setTimeout(function () { alertBox.style.display = 'none'; }, 4000);
                }
                el('facultyInvigRequestForm').reset();
                loadRequestInvigilationForm();
            });
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    // -------------------------------------------------- faculty substitutions (Phase B7.5)
    var currentSubTab = 'request';
    var selectedVacantSlot = null;

    function updatePendingSubstitutionsBadge() {
        if (!state.user || state.user.role !== 'faculty') return;
        getJson(API.substitutions + '/incoming').then(function (data) {
            var count = (data && data.requests && data.requests.length) || 0;
            var badge = el('pendingSubstitutionsCount');
            var tabBadge = el('tabIncomingCount');
            if (badge) {
                badge.textContent = count;
                badge.style.display = count > 0 ? 'inline-block' : 'none';
            }
            if (tabBadge) {
                tabBadge.textContent = count;
                tabBadge.style.display = count > 0 ? 'inline-block' : 'none';
            }
        }).catch(function () {});
    }

    function switchSubTab(tabName) {
        currentSubTab = tabName;
        var tabReq = el('subTabRequest');
        var tabInc = el('subTabIncoming');
        var tabHist = el('subTabHistory');

        if (tabReq) tabReq.style.display = tabName === 'request' ? 'block' : 'none';
        if (tabInc) tabInc.style.display = tabName === 'incoming' ? 'block' : 'none';
        if (tabHist) tabHist.style.display = tabName === 'history' ? 'block' : 'none';

        var btnReq = el('tabBtnSubRequest');
        var btnInc = el('tabBtnSubIncoming');
        var btnHist = el('tabBtnSubHistory');

        if (btnReq) {
            btnReq.className = 'btn btn-sm sub-tab-btn ' + (tabName === 'request' ? 'btn-primary' : 'btn-secondary');
        }
        if (btnInc) {
            btnInc.className = 'btn btn-sm sub-tab-btn ' + (tabName === 'incoming' ? 'btn-primary' : 'btn-secondary');
        }
        if (btnHist) {
            btnHist.className = 'btn btn-sm sub-tab-btn ' + (tabName === 'history' ? 'btn-primary' : 'btn-secondary');
        }

        if (tabName === 'incoming') {
            loadIncomingSubstitutions();
        } else if (tabName === 'history') {
            loadMySubstitutions();
        }
    }

    function loadFacultySubstitutionsView() {
        var dateInput = el('subRequestDate');
        if (dateInput && !dateInput.value) {
            var now = new Date();
            var yyyy = now.getFullYear();
            var mm = String(now.getMonth() + 1).padStart(2, '0');
            var dd = String(now.getDate()).padStart(2, '0');
            dateInput.value = yyyy + '-' + mm + '-' + dd;
        }
        switchSubTab('request');
        updatePendingSubstitutionsBadge();
    }

    function handleFindVacantPeriods() {
        var dateInput = el('subRequestDate');
        var alertBox = el('vacantPeriodsAlert');
        var tableBody = el('vacantPeriodsTableBody');
        var candidatesCard = el('subCandidatesCard');

        if (candidatesCard) candidatesCard.style.display = 'none';
        selectedVacantSlot = null;

        var date = dateInput ? dateInput.value : '';
        if (!date) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">Please enter a date to find your vacant periods.</div>';
            }
            return;
        }

        if (alertBox) alertBox.style.display = 'none';
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="7" class="muted">Checking schedule and absence status…</td></tr>';

        getJson(API.substitutions + '/vacant-periods?date=' + encodeURIComponent(date)).then(function (data) {
            var list = (data && data.vacantPeriods) || [];
            if (!list.length) {
                if (tableBody) {
                    tableBody.innerHTML = '<tr><td colspan="7" class="muted">No vacant teaching periods found for ' + esc(date) + '. You are either not marked absent or have no classes on this day.</td></tr>';
                }
                return;
            }

            tableBody.innerHTML = list.map(function (p) {
                return '<tr>' +
                    '<td><strong>' + esc(p.date) + '</strong></td>' +
                    '<td>' + esc(p.dayOfWeek || '—') + '</td>' +
                    '<td><span class="badge badge-warning">P' + esc(p.period) + '</span></td>' +
                    '<td>' + esc(p.className || '—') + '</td>' +
                    '<td>' + esc(p.subject || '—') + '</td>' +
                    '<td>' + esc(p.room || '—') + '</td>' +
                    '<td><button type="button" class="btn btn-primary btn-sm btn-select-vacant" ' +
                        'data-date="' + esc(p.date) + '" ' +
                        'data-day="' + esc(p.dayOfWeek || '') + '" ' +
                        'data-period="' + esc(p.period) + '" ' +
                        'data-class="' + esc(p.className || '') + '" ' +
                        'data-subject="' + esc(p.subject || '') + '" ' +
                        'data-room="' + esc(p.room || '') + '">Select Slot</button></td>' +
                '</tr>';
            }).join('');

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-select-vacant'), function (btn) {
                btn.addEventListener('click', function () {
                    handleSelectVacantSlot({
                        date: btn.getAttribute('data-date'),
                        dayOfWeek: btn.getAttribute('data-day'),
                        period: parseInt(btn.getAttribute('data-period'), 10),
                        className: btn.getAttribute('data-class'),
                        subject: btn.getAttribute('data-subject'),
                        room: btn.getAttribute('data-room')
                    });
                });
            });
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="7" class="notice notice-error">' + esc(err.message || 'Failed to check vacant periods.') + '</td></tr>';
            }
        });
    }

    function handleSelectVacantSlot(slot) {
        selectedVacantSlot = slot;
        var card = el('subCandidatesCard');
        var badge = el('subSelectedSlotBadge');
        var subtitle = el('subCandidatesSubtitle');
        var tableBody = el('subCandidatesTableBody');
        var emptyNotice = el('subCandidatesEmptyNotice');
        var alertBox = el('subCandidatesAlert');

        if (alertBox) alertBox.style.display = 'none';
        if (card) card.style.display = 'block';
        if (badge) badge.textContent = 'P' + slot.period + ' · ' + (slot.className || 'Class') + ' (' + slot.date + ')';
        if (subtitle) subtitle.textContent = 'Available FREE colleagues for ' + (slot.dayOfWeek || '') + ' Period ' + slot.period + ' (' + (slot.subject || 'Teaching') + ')';

        if (tableBody) tableBody.innerHTML = '<tr><td colspan="5" class="muted">Scanning colleague availability across branches…</td></tr>';
        if (emptyNotice) emptyNotice.style.display = 'none';

        var url = API.substitutions + '/candidates?date=' + encodeURIComponent(slot.date) +
            '&period=' + encodeURIComponent(slot.period) +
            (slot.className ? '&className=' + encodeURIComponent(slot.className) : '');

        getJson(url).then(function (data) {
            var candidates = (data && data.candidates) || [];
            if (!candidates.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = candidates.map(function (c) {
                var priorityBadge = c.isSameBranch
                    ? '<span class="badge badge-primary">Same Branch (' + esc(c.branch || c.department) + ')</span>'
                    : '<span class="badge badge-neutral">Other Branch (' + esc(c.branch || c.department) + ')</span>';

                return '<tr>' +
                    '<td><strong>' + esc(c.name || c.facultyName) + '</strong></td>' +
                    '<td>' + esc(c.branch || c.department || '—') + '</td>' +
                    '<td>' + priorityBadge + '</td>' +
                    '<td><span class="badge badge-success">FREE</span></td>' +
                    '<td><button type="button" class="btn btn-primary btn-sm btn-choose-sub" ' +
                        'data-id="' + esc(c.id || c.facultyId) + '" ' +
                        'data-name="' + esc(c.name || c.facultyName) + '">Send Request</button></td>' +
                '</tr>';
            }).join('');

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-choose-sub'), function (btn) {
                btn.addEventListener('click', function () {
                    var subId = btn.getAttribute('data-id');
                    var subName = btn.getAttribute('data-name');
                    handleSendSubRequest(slot, { id: subId, name: subName });
                });
            });
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="5" class="notice notice-error">' + esc(err.message || 'Failed to load candidates.') + '</td></tr>';
            }
        });
    }

    function handleSendSubRequest(slot, candidate) {
        var alertBox = el('subCandidatesAlert');
        fetch(API.substitutions + '/requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: slot.date,
                period: slot.period,
                className: slot.className,
                subject: slot.subject,
                substituteFacultyId: candidate.id,
                substituteFacultyName: candidate.name
            })
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(body.error || 'Failed to send substitution request.') + '</div>';
                    }
                    return;
                }
                alert('Substitution request sent to ' + candidate.name + ' for Period ' + slot.period + ' on ' + slot.date + '!');
                var card = el('subCandidatesCard');
                if (card) card.style.display = 'none';
                switchSubTab('history');
            });
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function loadIncomingSubstitutions() {
        var tableBody = el('incomingSubsTableBody');
        var emptyNotice = el('incomingSubsEmptyNotice');
        var alertBox = el('incomingSubsAlert');

        if (tableBody) tableBody.innerHTML = '<tr><td colspan="8" class="muted">Loading incoming substitution requests…</td></tr>';
        if (emptyNotice) emptyNotice.style.display = 'none';
        if (alertBox) alertBox.style.display = 'none';

        getJson(API.substitutions + '/incoming').then(function (data) {
            var list = (data && data.requests) || [];
            if (!list.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = list.map(function (r) {
                return '<tr>' +
                    '<td><strong>' + esc(r.date) + '</strong></td>' +
                    '<td>' + esc(r.dayOfWeek || '—') + '</td>' +
                    '<td><span class="badge badge-warning">P' + esc(r.period) + '</span></td>' +
                    '<td>' + esc(r.className || '—') + '</td>' +
                    '<td>' + esc(r.subject || '—') + '</td>' +
                    '<td><strong>' + esc(r.originalFacultyName) + '</strong></td>' +
                    '<td>' + esc(r.originalFacultyBranch || '—') + '</td>' +
                    '<td><div style="display:flex; gap:6px;">' +
                        '<button type="button" class="btn btn-success btn-sm btn-accept-sub" data-id="' + esc(r.id) + '">Accept</button>' +
                        '<button type="button" class="btn btn-danger btn-sm btn-open-reject-sub" data-id="' + esc(r.id) + '">Decline</button>' +
                    '</div></td>' +
                '</tr>';
            }).join('');

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-accept-sub'), function (btn) {
                btn.addEventListener('click', function () {
                    handleAcceptSub(btn.getAttribute('data-id'));
                });
            });

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-open-reject-sub'), function (btn) {
                btn.addEventListener('click', function () {
                    openRejectSubModal(btn.getAttribute('data-id'));
                });
            });
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="8" class="notice notice-error">' + esc(err.message || 'Failed to load incoming requests.') + '</td></tr>';
            }
        });
    }

    function handleAcceptSub(id) {
        var alertBox = el('incomingSubsAlert');
        fetch(API.substitutions + '/' + encodeURIComponent(id) + '/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger"><strong>Cannot Accept:</strong> ' + esc(body.error || 'Failed to accept substitution') + '</div>';
                    }
                    return;
                }
                if (alertBox) {
                    alertBox.style.display = 'block';
                    alertBox.innerHTML = '<div class="notice notice-success">Substitution accepted! The class has been added to your schedule.</div>';
                    setTimeout(function () { alertBox.style.display = 'none'; }, 4000);
                }
                loadIncomingSubstitutions();
                updatePendingSubstitutionsBadge();
            });
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function openRejectSubModal(id) {
        var modal = el('rejectSubModal');
        var targetInput = el('rejectSubTargetId');
        var reasonInput = el('rejectSubReasonInput');
        if (targetInput) targetInput.value = id;
        if (reasonInput) reasonInput.value = '';
        if (modal) modal.style.display = 'flex';
    }

    function closeRejectSubModal() {
        var modal = el('rejectSubModal');
        if (modal) modal.style.display = 'none';
    }

    function confirmRejectSub() {
        var targetId = el('rejectSubTargetId') ? el('rejectSubTargetId').value : '';
        var reason = el('rejectSubReasonInput') ? el('rejectSubReasonInput').value : '';
        var alertBox = el('incomingSubsAlert');
        if (!targetId) return;

        fetch(API.substitutions + '/' + encodeURIComponent(targetId) + '/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason })
        }).then(function (res) {
            return res.json().then(function (body) {
                closeRejectSubModal();
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(body.error || 'Failed to reject substitution') + '</div>';
                    }
                    return;
                }
                if (alertBox) {
                    alertBox.style.display = 'block';
                    alertBox.innerHTML = '<div class="notice notice-neutral">Substitution request declined.</div>';
                    setTimeout(function () { alertBox.style.display = 'none'; }, 4000);
                }
                loadIncomingSubstitutions();
                updatePendingSubstitutionsBadge();
            });
        }).catch(function (err) {
            closeRejectSubModal();
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function loadMySubstitutions() {
        var tableBody = el('mySubsTableBody');
        var emptyNotice = el('mySubsEmptyNotice');
        var alertBox = el('mySubsAlert');

        if (tableBody) tableBody.innerHTML = '<tr><td colspan="9" class="muted">Loading your substitution history…</td></tr>';
        if (emptyNotice) emptyNotice.style.display = 'none';
        if (alertBox) alertBox.style.display = 'none';

        getJson(API.substitutions + '/my').then(function (data) {
            var list = (data && data.outgoingRequests) || [];
            if (!list.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = list.map(function (s) {
                var statusBadge = s.status === 'ACCEPTED'
                    ? '<span class="badge badge-success">ACCEPTED</span>'
                    : (s.status === 'REJECTED'
                        ? '<span class="badge badge-danger">REJECTED</span>'
                        : (s.status === 'CANCELLED'
                            ? '<span class="badge badge-neutral">CANCELLED</span>'
                            : '<span class="badge badge-warning">PENDING</span>'));

                var notes = s.status === 'REJECTED'
                    ? (s.rejectionReason ? 'Reason: ' + esc(s.rejectionReason) : 'Declined by substitute')
                    : (s.status === 'ACCEPTED' ? 'Accepted by substitute' : (s.status === 'CANCELLED' ? 'Cancelled by you' : 'Awaiting response'));

                var actionBtn = s.status === 'PENDING'
                    ? '<button type="button" class="btn btn-secondary btn-sm btn-cancel-sub" data-id="' + esc(s.id) + '">Cancel</button>'
                    : '—';

                return '<tr>' +
                    '<td><strong>' + esc(s.date) + '</strong></td>' +
                    '<td>' + esc(s.dayOfWeek || '—') + '</td>' +
                    '<td><span class="badge badge-warning">P' + esc(s.period) + '</span></td>' +
                    '<td>' + esc(s.className || '—') + '</td>' +
                    '<td>' + esc(s.subject || '—') + '</td>' +
                    '<td><strong>' + esc(s.substituteFacultyName) + '</strong> (' + esc(s.substituteFacultyBranch || '') + ')</td>' +
                    '<td>' + statusBadge + '</td>' +
                    '<td><span class="muted" style="font-size:0.85rem;">' + notes + '</span></td>' +
                    '<td>' + actionBtn + '</td>' +
                '</tr>';
            }).join('');

            Array.prototype.forEach.call(tableBody.querySelectorAll('.btn-cancel-sub'), function (btn) {
                btn.addEventListener('click', function () {
                    handleCancelSub(btn.getAttribute('data-id'));
                });
            });
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="9" class="notice notice-error">' + esc(err.message || 'Failed to load substitutions.') + '</td></tr>';
            }
        });
    }

    function handleCancelSub(id) {
        if (!confirm('Cancel this pending substitution request?')) return;
        var alertBox = el('mySubsAlert');
        fetch(API.substitutions + '/' + encodeURIComponent(id), {
            method: 'DELETE'
        }).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok) {
                    if (alertBox) {
                        alertBox.style.display = 'block';
                        alertBox.innerHTML = '<div class="notice notice-danger">' + esc(body.error || 'Failed to cancel request') + '</div>';
                    }
                    return;
                }
                loadMySubstitutions();
            });
        }).catch(function (err) {
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.innerHTML = '<div class="notice notice-danger">' + esc(err.message) + '</div>';
            }
        });
    }

    function loadHOSSubstitutionsView(filterDate, filterStatus) {
        if (el('hosSubBranchBadge')) {
            el('hosSubBranchBadge').textContent = (state.user && state.user.department) || 'Branch';
        }
        var tableBody = el('hosSubTableBody');
        var emptyNotice = el('hosSubEmptyNotice');
        var alertBox = el('hosSubAlert');

        if (tableBody) tableBody.innerHTML = '<tr><td colspan="9" class="muted">Loading branch substitutions overview…</td></tr>';
        if (emptyNotice) emptyNotice.style.display = 'none';
        if (alertBox) alertBox.style.display = 'none';

        var url = API.substitutions;
        var params = [];
        if (filterDate) params.push('date=' + encodeURIComponent(filterDate));
        if (filterStatus) params.push('status=' + encodeURIComponent(filterStatus));
        if (params.length) url += '?' + params.join('&');

        getJson(url).then(function (data) {
            var list = (data && data.substitutions) || [];
            if (!list.length) {
                if (tableBody) tableBody.innerHTML = '';
                if (emptyNotice) emptyNotice.style.display = 'block';
                return;
            }
            if (emptyNotice) emptyNotice.style.display = 'none';

            tableBody.innerHTML = list.map(function (s) {
                var statusBadge = s.status === 'ACCEPTED'
                    ? '<span class="badge badge-success">ACCEPTED</span>'
                    : (s.status === 'REJECTED'
                        ? '<span class="badge badge-danger">REJECTED</span>'
                        : (s.status === 'CANCELLED'
                            ? '<span class="badge badge-neutral">CANCELLED</span>'
                            : '<span class="badge badge-warning">PENDING</span>'));

                var createdAt = s.createdAt ? new Date(s.createdAt).toLocaleString() : '—';

                return '<tr>' +
                    '<td><strong>' + esc(s.date) + '</strong></td>' +
                    '<td>' + esc(s.dayOfWeek || '—') + '</td>' +
                    '<td><span class="badge badge-warning">P' + esc(s.period) + '</span></td>' +
                    '<td>' + esc(s.className || '—') + '</td>' +
                    '<td>' + esc(s.subject || '—') + '</td>' +
                    '<td><strong>' + esc(s.originalFacultyName) + '</strong> (' + esc(s.originalFacultyBranch || '') + ')</td>' +
                    '<td><strong>' + esc(s.substituteFacultyName) + '</strong> (' + esc(s.substituteFacultyBranch || '') + ')</td>' +
                    '<td>' + statusBadge + '</td>' +
                    '<td><span class="muted" style="font-size:0.82rem;">' + esc(createdAt) + '</span></td>' +
                '</tr>';
            }).join('');
        }).catch(function (err) {
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="9" class="notice notice-error">' + esc(err.message || 'Failed to load branch substitutions.') + '</td></tr>';
            }
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

            if (el('validationStats')) {
                el('validationStats').innerHTML = [
                    { label: 'Errors', value: 0, note: 'a loaded timetable has none by definition', tone: 'ok' },
                    { label: 'Warnings', value: warnings.length,
                      note: warnings.length ? 'listed below' : 'none reported',
                      tone: warnings.length ? 'busy' : 'ok' },
                    { label: 'Source', value: meta.origin || '—', note: 'where this timetable came from' },
                    { label: 'Faculty', value: meta.facultyCount, note: 'in the loaded roster' }
                ].map(statCard).join('');
            }

            if (el('validationBody')) {
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
            }
        }).catch(function (err) {
            if (el('validationBody')) {
                el('validationBody').innerHTML =
                    '<div class="notice notice-error">Could not load the report: ' + esc(err.message) + '</div>';
            }
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

            if (el('heatTable')) el('heatTable').innerHTML = html + '</tbody>';
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
        var day = el('attDay') ? el('attDay').value : null;
        var className = el('attClass') ? el('attClass').value : null;
        if (!day || !className) return Promise.resolve();

        return getJson(API.timetable + '?class=' + encodeURIComponent(className)).then(function (grid) {
            var rows = grid.cells
                .filter(function (c) { return c.day === day && c.status === 'busy'; })
                .sort(function (a, b) { return a.period - b.period; });

            if (!rows.length) {
                if (el('attBody')) {
                    el('attBody').innerHTML =
                        '<tr><td colspan="6" class="muted">No scheduled periods for ' + esc(className) +
                        ' on ' + esc(day) + '.</td></tr>';
                }
                if (el('attStats')) el('attStats').innerHTML = '';
                return;
            }

            if (el('attBody')) {
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
            }

            var counts = { held: 0, missed: 0, substituted: 0, unmarked: 0 };
            rows.forEach(function (cell) {
                var mark = state.attendance[className + '|' + day + '|' + cell.period];
                counts[mark || 'unmarked']++;
            });

            if (el('attStats')) {
                el('attStats').innerHTML = [
                    { label: 'Scheduled', value: rows.length, note: className + ' · ' + day },
                    { label: 'Held', value: counts.held, note: 'marked as taken', tone: 'ok' },
                    { label: 'Not held', value: counts.missed, note: 'marked as missed', tone: 'busy' },
                    { label: 'Unmarked', value: counts.unmarked, note: 'still to record' }
                ].map(statCard).join('');
            }
        }).catch(function (err) {
            if (el('attBody')) {
                el('attBody').innerHTML =
                    '<tr><td colspan="6" class="notice notice-error">Could not load attendance rows: ' +
                    esc(err.message) + '</td></tr>';
            }
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

    function renderUnresolvedCategoriesHtml(unresolved, uploadId) {
        if (!unresolved || unresolved.length === 0) return '';
        var categories = [
            { key: 'faculty', label: 'Faculty', icon: '👤' },
            { key: 'subject', label: 'Subject', icon: '📚' },
            { key: 'class', label: 'Class', icon: '🏫' },
            { key: 'room', label: 'Room', icon: '🚪' }
        ];

        var grouped = { faculty: [], subject: [], class: [], room: [], other: [] };
        unresolved.forEach(function (item) {
            var k = (item.entityType || '').toLowerCase();
            if (grouped[k]) grouped[k].push(item);
            else grouped.other.push(item);
        });

        var html = '<div class="unresolved-banner-box" style="background:#fffdf5; border:1px solid #f6c000; border-radius:var(--radius-sm); padding:16px; margin:14px 0;">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">';
        html += '<div><strong style="color:#8c6200; font-size:0.95rem;">⚠️ Action Required: ' + unresolved.length + ' Unresolved Reference(s)</strong>';
        html += '<p style="margin:2px 0 0; font-size:0.84rem; color:#5c4100;">These extracted names/codes are not yet registered in your branch catalog. Map them to existing records or click Register below to unblock approval.</p></div>';
        if (uploadId) {
            html += '<button type="button" class="btn btn-sm btn-primary btn-register-all-unresolved" data-upload="' + esc(uploadId) + '" style="background:#0284c7; border:none; color:#fff; font-weight:600; padding:6px 14px;">⚡ Register All Unresolved to Catalog</button>';
        }
        html += '</div>';

        categories.concat([{ key: 'other', label: 'Other References', icon: '📌' }]).forEach(function (cat) {
            var items = grouped[cat.key] || [];
            if (items.length === 0) return;
            html += '<div style="margin-top:10px; padding:10px 12px; background:#ffffff; border:1px solid #fae69e; border-radius:var(--radius-sm);">';
            html += '<div style="font-weight:600; font-size:0.86rem; color:#8c6200; margin-bottom:8px; display:flex; align-items:center; gap:6px;">' + cat.icon + ' ' + cat.label + ' (' + items.length + ')</div>';
            html += '<div style="display:flex; flex-direction:column; gap:6px;">';
            items.forEach(function (item) {
                html += '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding:6px 10px; background:var(--surface-subtle); border-radius:4px; font-size:0.83rem;">';
                html += '<div><strong>' + esc(item.extractedText) + '</strong>' +
                    (item.code ? ' <span class="mono text-muted">[' + esc(item.code) + ']</span>' : '') +
                    '<div class="muted" style="font-size:0.77rem;">' + esc(item.reason || 'Not found in branch catalog') + '</div></div>';
                if (uploadId) {
                    html += '<div style="display:flex; gap:6px;">' +
                        '<button type="button" class="btn btn-secondary btn-sm btn-map-entity" data-upload="' + esc(uploadId) + '" data-type="' + esc(item.entityType) + '" data-text="' + esc(item.extractedText) + '" style="font-size:0.78rem; padding:3px 8px;">Map Existing</button>' +
                        '<button type="button" class="btn btn-outline-primary btn-sm btn-register-entity" data-upload="' + esc(uploadId) + '" data-type="' + esc(item.entityType) + '" data-text="' + esc(item.extractedText) + '" data-code="' + esc(item.code || '') + '" style="font-size:0.78rem; padding:3px 8px;">+ Register New</button>' +
                        '</div>';
                }
                html += '</div>';
            });
            html += '</div></div>';
        });

        html += '</div>';
        return html;
    }

    function bindUnresolvedActionHandlers(container, uploadId, onRefresh) {
        if (!container || !uploadId) return;

        var regAllBtn = container.querySelector('.btn-register-all-unresolved');
        if (regAllBtn) {
            regAllBtn.addEventListener('click', function () {
                regAllBtn.disabled = true;
                regAllBtn.textContent = 'Registering…';
                fetch('/api/staging/' + encodeURIComponent(uploadId) + '/register-all-unresolved', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }).then(function (r) { return r.json(); }).then(function (res) {
                    if (res.success) {
                        if (onRefresh) onRefresh();
                    } else {
                        alert(res.error || 'Failed to register entities.');
                        regAllBtn.disabled = false;
                        regAllBtn.textContent = '⚡ Register All Unresolved to Catalog';
                    }
                }).catch(function (err) {
                    alert('Network error: ' + err.message);
                    regAllBtn.disabled = false;
                    regAllBtn.textContent = '⚡ Register All Unresolved to Catalog';
                });
            });
        }

        container.querySelectorAll('.btn-register-entity').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var entityType = btn.getAttribute('data-type');
                var extractedText = btn.getAttribute('data-text');
                var code = btn.getAttribute('data-code') || '';
                btn.disabled = true;
                btn.textContent = 'Registering…';

                fetch('/api/staging/' + encodeURIComponent(uploadId) + '/register-entity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        entityType: entityType,
                        extractedText: extractedText,
                        code: code
                    })
                }).then(function (r) { return r.json(); }).then(function (res) {
                    if (res.success) {
                        if (onRefresh) onRefresh();
                    } else {
                        alert(res.error || 'Failed to register entity.');
                        btn.disabled = false;
                        btn.textContent = '+ Register New';
                    }
                }).catch(function (err) {
                    alert('Network error: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = '+ Register New';
                });
            });
        });

        container.querySelectorAll('.btn-map-entity').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var entityType = btn.getAttribute('data-type');
                var extractedText = btn.getAttribute('data-text');
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
                        if (onRefresh) onRefresh();
                    } else {
                        alert(res.error || 'Failed to map entity.');
                    }
                }).catch(function (e) {
                    alert('Network error: ' + e.message);
                });
            });
        });
    }

    function importPreviewHtml(data) {
        if (!data) return notice('No preview data available.', 'warn');
        var report = data.report || { ok: true, errors: [], warnings: [], summary: {} };
        var summary = report.summary || {};
        var meta = data.meta || { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], periods: [1, 2, 3, 4, 5, 6, 7] };
        var previewRows = Array.isArray(data.preview) ? data.preview : [];
        var unresolved = Array.isArray(data.unresolvedEntities) ? data.unresolvedEntities : [];
        var isImported = (data.importStatus === 'IMPORTED');

        var head = '';
        if (isImported) {
            head = '<div class="notice notice-ok" style="border-left: 4px solid #16a34a; padding: 12px 16px;">' +
                '<strong>✓ Timetable Already Imported:</strong> This timetable has been successfully approved and added to the Master Timetable.' +
                '</div>';
        } else if (report.ok) {
            head = '<div class="notice notice-info" style="border-left: 4px solid var(--brand-500); padding: 12px 16px;">' +
                '<strong style="font-size:1rem; display:block; margin-bottom:4px;">Approve Timetable · Preview Only</strong>' +
                '<span>Timetable extracted and validated. Review the schedule below and click <strong>"✓ Accept &amp; Import to Master Timetable"</strong> to approve and add it to the live schedule.</span>' +
                '</div>';
        } else {
            head = '<div class="notice notice-error" style="border-left: 4px solid #dc2626; padding: 12px 16px;">' +
                '<strong style="font-size:1rem; display:block; margin-bottom:4px;">Validation Issues Detected</strong>' +
                '<span>Timetable extracted with validation errors. Review the issues below before approving.</span>' +
                '</div>';
        }

        var fileInfo = '<div class="notice notice-info" style="margin-top:10px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;">' +
            '<span>File: <strong>' + esc(data.filename || 'Timetable') + '</strong></span> &bull; ' +
            '<span>Format: <strong>' + esc(data.format || 'document') + '</strong> (' + esc(data.layout || 'visual') + ' layout' +
            (data.provider ? ', ' + esc(data.provider) : '') + ')</span>' +
            (isImported
                ? ' &bull; <span class="badge" style="background:#16a34a;color:#fff;font-size:11px;padding:3px 8px;border-radius:4px;font-weight:600;">✓ IMPORTED</span>'
                : (data.uploadId ? ' &bull; <span class="badge" style="background:#d97706;color:#fff;font-size:11px;padding:3px 8px;border-radius:4px;font-weight:600;">STAGED / PENDING APPROVAL</span>' : '')) +
            '</div>';

        var stats = '<div class="stats compact" style="margin-top:14px;">' + [
            { label: 'Rows read', value: data.rowCount == null ? (previewRows.length || '—') : data.rowCount,
              note: 'from the file', tone: 'brand' },
            { label: 'Faculty', value: summary.faculty != null ? summary.faculty : previewRows.length, note: 'found in the sheet' },
            { label: 'Scheduled periods', value: summary.busySlots != null ? summary.busySlots : '—', note: 'to be loaded' },
            { label: 'Errors', value: (report.errors || []).length,
              note: report.ok ? 'none — safe to load' : 'must be fixed first',
              tone: report.ok ? 'ok' : 'busy' },
            { label: 'Warnings', value: (report.warnings || []).length, note: 'shown below' }
        ].map(statCard).join('') + '</div>';

        var unresolvedHtml = renderUnresolvedCategoriesHtml(unresolved, data.uploadId);

        var days = Array.isArray(meta.days) && meta.days.length > 0 ? meta.days : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        var periods = Array.isArray(meta.periods) && meta.periods.length > 0 ? meta.periods : [1, 2, 3, 4, 5, 6, 7];
        var timings = Array.isArray(meta.periodTimings) ? meta.periodTimings : [];

        var table = '<div class="table-scroll" style="margin-top:14px;"><table class="data"><thead><tr>' +
            '<th>Faculty</th><th>Department</th>' +
            days.reduce(function (cells, day) {
                return cells.concat(periods.map(function (p, pIdx) {
                    var timing = timings[pIdx] || '';
                    return '<th>' + esc(String(day).slice(0, 3)) + '<br><small style="font-weight:normal;opacity:0.85;">P' + esc(p) + (timing ? ' (' + esc(timing) + ')' : '') + '</small></th>';
                }));
            }, []).join('') + '</tr></thead><tbody>' +
            previewRows.map(function (row) {
                var slots = Array.isArray(row.slots) ? row.slots : [];
                return '<tr><td><strong>' + esc(row.faculty || '') + '</strong></td><td>' + esc(row.department || '') + '</td>' +
                    slots.map(function (slot) {
                        if (!slot || slot.status !== 'busy') {
                            return '<td class="muted" style="text-align:center;">free</td>';
                        }
                        var label = esc(slot.subject || '');
                        if (slot.className) {
                            label += '<br><small class="muted">' + esc(slot.className) + '</small>';
                        }
                        return '<td>' + label + '</td>';
                    }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';

        var canApprove = report.ok && (!unresolved || unresolved.length === 0);
        var buttonHtml = '';
        if (isImported) {
            buttonHtml = '<button type="button" class="btn btn-secondary" id="importConfirm" disabled style="font-weight:600;">✓ Already Imported</button>';
        } else if (canApprove) {
            buttonHtml = '<button type="button" class="btn btn-primary" id="importConfirm" style="background:#16a34a;border-color:#16a34a;color:#fff;font-weight:600;font-size:0.95rem;padding:8px 18px;">✓ Accept &amp; Import to Master Timetable</button>';
        } else if (unresolved.length > 0) {
            buttonHtml = '<button type="button" class="btn btn-secondary" id="importConfirm" disabled style="opacity:0.65;font-weight:600;">Resolve References to Enable Approval</button>' +
                '<span class="notice notice-warn" style="margin:0;">Resolve ' + unresolved.length + ' catalog reference(s) above to enable approval.</span>';
        } else {
            buttonHtml = '<button type="button" class="btn btn-secondary" id="importConfirm" disabled style="opacity:0.65;font-weight:600;">Cannot Approve (Invalid Data)</button>' +
                '<span class="notice notice-error" style="margin:0;">Validation failed — cannot add to Master Timetable.</span>';
        }

        var actions = '<div class="controls" style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
            buttonHtml +
            '<button type="button" class="btn btn-secondary" id="importCancel">Cancel</button></div>' +
            '<div id="importActionStatus" style="margin-top:12px;display:none;"></div>';

        return head + fileInfo + stats + unresolvedHtml + importReportHtml(report) + table + actions;
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
        return (state.formats && state.formats.supported) || ['.xlsx', '.xls', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.pdf'];
    }

    function unsupportedMessage(filename) {
        var ext = (String(filename).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        var supported = supportedExtensions().join(', ');
        if (/^\.(pdf|png|jpg|jpeg|webp)$/.test(ext)) {
            var document = state.formats && state.formats.document;
            if (document && document.available) {
                return ext.slice(1).toUpperCase() + ' files are read by ' + document.provider + '.';
            }
            return 'PDF/Image extraction is not configured. Add GEMINI_API_KEY to enable document ' +
                'extraction. Meanwhile use ' +
                ((document && document.alternatives) || ['Excel', 'CSV', 'Quick Paste']).join(', ') + '.';
        }
        return 'Unsupported file type "' + ext + '". Upload ' + supported + ', or use Quick Paste.';
    }

    /** Progress the user can trust: each line is shown as that stage is entered. */
    function importProgress(container, name) {
        var isDocument = /\.(pdf|png|jpe?g|webp)$/i.test(name);
        var steps = isDocument
            ? [
                { delay: 0, text: 'Uploading timetable to server…', sub: 'Preparing image payload…' },
                { delay: 2000, text: 'Stage 1: Extracting timetable with Gemini Vision…', sub: 'Analyzing visual grid, periods, and staff legend…' },
                { delay: 14000, text: 'Stage 2: Multimodal verification & error-correction…', sub: 'Cross-checking original image with draft JSON for full accuracy…' },
                { delay: 28000, text: 'Validating timetable rules & constraints…', sub: 'Verifying subject codes, session spans, and class mappings…' },
                { delay: 38000, text: 'Preparing staged timetable for HOD preview…', sub: 'Nothing is added to Master Timetable until you approve.' },
                { delay: 50000, text: 'Processing complex timetable structure…', sub: 'Finalizing verification response. Please wait…' }
              ]
            : [
                { delay: 0, text: 'Uploading…', sub: '' },
                { delay: 400, text: 'Reading table…', sub: '' },
                { delay: 800, text: 'Normalizing days…', sub: '' },
                { delay: 1200, text: 'Validating timetable…', sub: '' }
              ];

        var index = 0;
        function render() {
            var item = steps[index] || steps[steps.length - 1];
            container.innerHTML = notice(item.text, 'info') +
                (item.sub
                    ? '<p class="muted" style="margin-top:6px;">' + item.sub + '</p>'
                    : '');
        }
        render();

        var startTime = Date.now();
        var timer = setInterval(function () {
            var elapsed = Date.now() - startTime;
            var nextIndex = index;
            for (var i = 0; i < steps.length; i++) {
                if (elapsed >= steps[i].delay) {
                    nextIndex = i;
                }
            }
            if (nextIndex !== index) {
                index = nextIndex;
                render();
            }
        }, 500);

        return { stop: function () { clearInterval(timer); } };
    }

    function setPreviewButtonsDisabled(disabled) {
        var btn1 = el('importPreview');
        if (btn1) btn1.disabled = Boolean(disabled);
        var btn2 = el('pastePreview');
        if (btn2) btn2.disabled = Boolean(disabled);
    }

    function runPreview(container) {
        workflowStep('process');
        setPreviewButtonsDisabled(true);
        var progress = importProgress(container, state.importFile.name);

        return sendImport(API.importPreview).then(function (res) {
            progress.stop();
            setPreviewButtonsDisabled(false);
            if (!res) return;
            workflowStep('validate');
            if (!res.ok) {
                workflowStep('validate', true);
                var errNotice = (res.body && res.body.error)
                    ? res.body.error
                    : (res.status ? 'Import failed (HTTP ' + res.status + ').' : 'Import failed.');
                container.innerHTML = notice(errNotice, 'error') +
                    (res.body && res.body.report ? importReportHtml(res.body.report) : '');
                return;
            }
            if (!res.body || typeof res.body !== 'object') {
                workflowStep('validate', true);
                container.innerHTML = notice('Invalid server response format.', 'error');
                return;
            }
            state.pendingImport = res.body;
            var isReportOk = res.body.report ? Boolean(res.body.report.ok) : true;
            workflowStep(isReportOk ? 'preview' : 'validate', !isReportOk);
            renderPreviewIntoContainer(container, res.body);
            logActivity('Previewed ' + (res.body.filename || 'timetable') + ' (' + (res.body.rowCount || 0) + ' rows)');
        }).catch(function (err) {
            progress.stop();
            setPreviewButtonsDisabled(false);
            workflowStep('process', true);
            var msg = 'Could not reach the server while importing. Check that the server is running and try again.';
            if (err && err.name === 'AbortError') {
                msg = 'Import request timed out. Please try again.';
            } else if (err && err.message && !/failed to fetch|networkerror/i.test(err.message)) {
                msg = 'Import processing error: ' + err.message;
            }
            container.innerHTML = notice(msg, 'error');
        });
    }

    function renderPreviewIntoContainer(container, body) {
        container.innerHTML = importPreviewHtml(body);
        var confirmBtn = el('importConfirm');
        if (confirmBtn) confirmBtn.addEventListener('click', commitImport);
        var cancelBtn = el('importCancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function () {
                state.pendingImport = null;
                state.importFile = null;
                container.innerHTML = '';
                if (el('importFile')) el('importFile').value = '';
                workflowStep('upload');
            });
        }
        if (body.uploadId) {
            bindUnresolvedActionHandlers(container, body.uploadId, function () {
                fetch('/api/staging/' + encodeURIComponent(body.uploadId)).then(function (r) {
                    return r.json();
                }).then(function (stagingData) {
                    if (stagingData && stagingData.resolution) {
                        body.unresolvedEntities = stagingData.resolution.unresolvedEntities || [];
                        state.pendingImport = body;
                        renderPreviewIntoContainer(container, body);
                    }
                }).catch(function () {});
            });
        }
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
        var confirmBtn = el('importConfirm');
        var statusBox = el('importActionStatus');
        if (!confirmBtn || confirmBtn.disabled) return;

        var pending = state.pendingImport;
        if (!pending) return;

        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Importing…';
        if (statusBox) {
            statusBox.style.display = 'block';
            statusBox.innerHTML = notice('Adding timetable to Master Timetable…', 'info');
        }
        workflowStep('confirm');

        var uploadId = pending.uploadId || null;
        var approvePromise;
        if (uploadId) {
            // Explicit HOD Approval via staging API
            approvePromise = fetch('/api/staging/' + encodeURIComponent(uploadId) + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }).then(function (res) {
                return res.json().catch(function () { return null; }).then(function (body) {
                    return { ok: res.ok, status: res.status, body: body };
                });
            });
        } else {
            // Direct commit for spreadsheet imports
            approvePromise = sendImport(API.importCommit);
        }

        approvePromise.then(function (res) {
            if (!res) {
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = '✓ Accept & Import to Master Timetable';
                }
                return;
            }
            if (!res.ok) {
                workflowStep('preview', true);
                var errNotice = (res.body && res.body.error)
                    ? res.body.error
                    : (res.status ? 'Approval failed (HTTP ' + res.status + ').' : 'Approval failed.');
                if (statusBox) {
                    statusBox.style.display = 'block';
                    statusBox.innerHTML = notice(
                        errNotice + ' The live timetable was not changed.', 'error') +
                        (res.body && res.body.report ? importReportHtml(res.body.report) : '');
                }
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = '✓ Accept & Import to Master Timetable';
                }
                return;
            }

            // Successful approval
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = '✓ Already Imported';
                confirmBtn.className = 'btn btn-secondary';
            }
            if (state.pendingImport) {
                state.pendingImport.importStatus = 'IMPORTED';
            }
            if (statusBox) {
                statusBox.style.display = 'block';
                statusBox.innerHTML = notice(
                    '✓ Timetable approved and added to Master Timetable successfully. Availability now uses the approved timetable.', 'ok');
            }
            workflowStep('generate');
            logActivity('Approved and added timetable to Master Timetable');

            var preferredScope = (res.body && res.body.scope) || (pending && pending.stagedContract ? {
                branch: pending.stagedContract.department_code || pending.stagedContract.branch_code,
                semester: pending.stagedContract.semester,
                section: pending.stagedContract.section,
                academicYear: pending.stagedContract.academic_year
            } : null);

            return bootstrap().then(function () {
                if (preferredScope) {
                    return loadTimetableScopes(preferredScope);
                }
            });
        }).catch(function (err) {
            workflowStep('preview', true);
            var msg = 'Could not reach the server while approving. Check that the server is running and try again.';
            if (err && err.name === 'AbortError') {
                msg = 'Approval request timed out. Please try again.';
            } else if (err && err.message && !/failed to fetch|networkerror/i.test(err.message)) {
                msg = 'Approval error: ' + err.message;
            }
            if (statusBox) {
                statusBox.style.display = 'block';
                statusBox.innerHTML = notice(msg, 'error');
            }
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = '✓ Accept & Import to Master Timetable';
            }
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
        var sem = (el('ttSemester') && el('ttSemester').value) || '';
        var sec = (el('ttSection') && el('ttSection').value) || '';
        var year = (el('ttAcademicYear') && el('ttAcademicYear').value) || '';
        if (sem && sec) {
            return '?semester=' + encodeURIComponent(sem) + '&section=' + encodeURIComponent(sec) + (year ? '&academicYear=' + encodeURIComponent(year) : '');
        }
        var value = (el('ttView') && el('ttView').value) || '';
        return value.indexOf('class:') === 0 ? '?class=' + encodeURIComponent(value.slice(6)) : '';
    }

    function loadTimetableScopes(preferredScope) {
        return getJson('/api/timetable/scopes').then(function (data) {
            state.timetableScopes = data;
            var semEl = el('ttSemester');
            var secEl = el('ttSection');
            var yearEl = el('ttAcademicYear');

            var branchClasses = (data && data.classes) || [];
            var activeClass = branchClasses.find(function (c) { return (c.entryCount > 0); }) || branchClasses[0] || null;

            var currentYear = (preferredScope && preferredScope.academicYear) || (yearEl && yearEl.value) || (activeClass && activeClass.academicYear);
            var currentSem = (preferredScope && preferredScope.semester) || (semEl && semEl.value) || (activeClass && activeClass.semester);
            var currentSec = (preferredScope && preferredScope.section) || (secEl && secEl.value) || (activeClass && activeClass.section);

            // If no preferredScope provided, prefer semester/section from active class with timetable entries
            if (!preferredScope && activeClass && activeClass.entryCount > 0 && activeClass.semester) {
                var sem1Class = branchClasses.find(function (c) { return parseSemesterNumber(c.semester) === 1 && c.entryCount > 0; });
                if (!sem1Class) {
                    currentSem = activeClass.semester;
                    currentSec = activeClass.section || currentSec;
                    currentYear = activeClass.academicYear || currentYear;
                }
            }

            if (yearEl && data.academicYears && data.academicYears.length) {
                var selectedYear = (data.academicYears.indexOf(currentYear) >= 0) ? currentYear : data.academicYears[0];
                fillSelect(yearEl, data.academicYears.map(function (y) {
                    return { value: y, label: y };
                }), selectedYear);
            }

            if (semEl && data.semesters && data.semesters.length) {
                var normSem = currentSem;
                var currentSemNum = parseSemesterNumber(normSem);
                if (normSem && data.semesters.indexOf(normSem) < 0) {
                    var match = data.semesters.find(function (s) {
                        if (s.toLowerCase() === String(normSem).toLowerCase()) return true;
                        var sNum = parseSemesterNumber(s);
                        return (sNum != null && currentSemNum != null && sNum === currentSemNum);
                    });
                    if (match) normSem = match;
                }
                var selectedSem = (normSem && data.semesters.indexOf(normSem) >= 0) ? normSem : data.semesters[0];
                fillSelect(semEl, data.semesters.map(function (s) {
                    return { value: s, label: s };
                }), selectedSem);
            }

            if (secEl && data.sections && data.sections.length) {
                var normSec = currentSec ? String(currentSec).toUpperCase().replace(/^(?:SEC(?:TION)?[-_\s]*)/, '') : null;
                var selectedSec = (normSec && data.sections.indexOf(normSec) >= 0) ? normSec : data.sections[0];
                fillSelect(secEl, data.sections.map(function (sec) {
                    return { value: sec, label: 'Section ' + sec };
                }), selectedSec);
            }

            var uploadSem = el('hosUploadSemester');
            var uploadSec = el('hosUploadSection');
            if (uploadSem && data.semesters) {
                fillSelect(uploadSem, [{ value: '', label: '— Auto Detect —' }].concat(data.semesters.map(function (s) {
                    return { value: s, label: s };
                })), uploadSem.value || '');
            }
            if (uploadSec && data.sections) {
                fillSelect(uploadSec, [{ value: '', label: '— Auto Detect —' }].concat(data.sections.map(function (sec) {
                    return { value: sec, label: 'Section ' + sec };
                })), uploadSec.value || '');
            }

            describeTimetableClass();
            return loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
        }).catch(function () {});
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
        return loadTimetableScopes();
    }

    /** The one-line academic context under the Master Timetable heading. */
    function describeTimetableClass() {
        var box = el('ttMeta');
        if (!box) return;

        var sem = (el('ttSemester') && el('ttSemester').value) || '';
        var sec = (el('ttSection') && el('ttSection').value) || '';
        var year = (el('ttAcademicYear') && el('ttAcademicYear').value) || '';
        var branch = (state.user && state.user.department) || '';

        if (sem && sec) {
            box.textContent = [
                branch ? 'Branch: ' + branch : null,
                year ? 'Academic Year ' + year : null,
                sem,
                'Section ' + sec
            ].filter(Boolean).join(' · ');
            return;
        }

        var code = (el('ttView') && el('ttView').value || '').replace(/^class:/, '');
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

    function initFacultyManagementEvents() {
        var facBody = el('facBody');
        if (facBody && !facBody.__boundFacultyEvents) {
            facBody.__boundFacultyEvents = true;
            facBody.addEventListener('click', function (e) {
                var target = e.target;
                if (!target) return;

                // Edit button
                var editBtn = target.closest('.btn-fac-edit');
                if (editBtn) {
                    var id = editBtn.getAttribute('data-id');
                    var name = editBtn.getAttribute('data-name') || '';
                    var branch = editBtn.getAttribute('data-branch') || '';
                    var phone = editBtn.getAttribute('data-phone') || '';
                    var designation = editBtn.getAttribute('data-designation') || 'Faculty';
                    var subjects = editBtn.getAttribute('data-subjects') || '';

                    if (el('editFacId')) el('editFacId').value = id;
                    if (el('editFacIdDisplay')) el('editFacIdDisplay').textContent = id;
                    if (el('editFacBranchDisplay')) el('editFacBranchDisplay').textContent = branch;
                    if (el('editFacName')) el('editFacName').value = name;
                    if (el('editFacPhone')) el('editFacPhone').value = phone;
                    if (el('editFacDesignation')) el('editFacDesignation').value = designation;
                    if (el('editFacSubjects')) el('editFacSubjects').value = subjects;
                    if (el('editFacNote')) el('editFacNote').style.display = 'none';

                    if (el('editFacultyModal')) el('editFacultyModal').style.display = 'flex';
                    return;
                }

                // Deactivate button
                var deactBtn = target.closest('.btn-fac-deactivate');
                if (deactBtn) {
                    var dId = deactBtn.getAttribute('data-id');
                    var dName = deactBtn.getAttribute('data-name') || dId;
                    if (!confirm('Are you sure you want to deactivate ' + dName + '?\n\nThis will prevent them from logging in and exclude them from substitution availability. All existing timetable entries are preserved.')) {
                        return;
                    }
                    fetch('/api/faculty/' + encodeURIComponent(dId) + '/deactivate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    })
                    .then(function (res) {
                        return res.json().then(function (data) {
                            if (!res.ok) throw new Error(data.error || 'Failed to deactivate faculty.');
                            return data;
                        });
                    })
                    .then(function () {
                        loadFacultyTable();
                    })
                    .catch(function (err) {
                        alert(err.message || 'Failed to deactivate faculty.');
                    });
                    return;
                }

                // Reactivate button
                var actBtn = target.closest('.btn-fac-activate');
                if (actBtn) {
                    var aId = actBtn.getAttribute('data-id');
                    fetch('/api/faculty/' + encodeURIComponent(aId) + '/activate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    })
                    .then(function (res) {
                        return res.json().then(function (data) {
                            if (!res.ok) throw new Error(data.error || 'Failed to reactivate faculty.');
                            return data;
                        });
                    })
                    .then(function () {
                        loadFacultyTable();
                    })
                    .catch(function (err) {
                        alert(err.message || 'Failed to reactivate faculty.');
                    });
                    return;
                }
            });
        }

        // Close Edit Modal
        if (el('btnEditFacClose') && !el('btnEditFacClose').__bound) {
            el('btnEditFacClose').__bound = true;
            el('btnEditFacClose').addEventListener('click', function () {
                if (el('editFacultyModal')) el('editFacultyModal').style.display = 'none';
            });
        }
        if (el('btnEditFacCancel') && !el('btnEditFacCancel').__bound) {
            el('btnEditFacCancel').__bound = true;
            el('btnEditFacCancel').addEventListener('click', function () {
                if (el('editFacultyModal')) el('editFacultyModal').style.display = 'none';
            });
        }

        // Submit Edit Form
        if (el('editFacultyForm') && !el('editFacultyForm').__bound) {
            el('editFacultyForm').__bound = true;
            el('editFacultyForm').addEventListener('submit', function (e) {
                e.preventDefault();
                var id = el('editFacId') ? el('editFacId').value : '';
                var name = el('editFacName') ? el('editFacName').value.trim() : '';
                var phone = el('editFacPhone') ? el('editFacPhone').value.trim() : '';
                var designation = el('editFacDesignation') ? el('editFacDesignation').value : 'Faculty';
                var subjects = el('editFacSubjects') ? el('editFacSubjects').value.trim() : '';
                var noteBox = el('editFacNote');

                if (!name || name.length < 2) {
                    if (noteBox) {
                        noteBox.className = 'notice notice-danger';
                        noteBox.textContent = 'Faculty name must be at least 2 characters.';
                        noteBox.style.display = 'block';
                    }
                    return;
                }

                var saveBtn = el('btnEditFacSave');
                if (saveBtn) saveBtn.disabled = true;

                fetch('/api/faculty/' + encodeURIComponent(id), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        phone: phone,
                        designation: designation,
                        subjects: subjects
                    })
                })
                .then(function (res) {
                    return res.json().then(function (data) {
                        if (!res.ok) throw new Error(data.error || 'Failed to update faculty.');
                        return data;
                    });
                })
                .then(function () {
                    if (saveBtn) saveBtn.disabled = false;
                    if (el('editFacultyModal')) el('editFacultyModal').style.display = 'none';
                    loadFacultyTable();
                })
                .catch(function (err) {
                    if (saveBtn) saveBtn.disabled = false;
                    if (noteBox) {
                        noteBox.className = 'notice notice-danger';
                        noteBox.textContent = err.message || 'Failed to save changes.';
                        noteBox.style.display = 'block';
                    }
                });
            });
        }
    }

    function bootstrap() {
        initFacultyManagementEvents();
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

            if (el('branchBody')) {
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
            }

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

            if (el('subjectBody')) {
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
            }

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

            if (el('classBody')) {
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
            }

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

        ['ttAcademicYear', 'ttSemester', 'ttSection'].forEach(function (id) {
            if (el(id)) {
                el(id).addEventListener('change', function () {
                    describeTimetableClass();
                    loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
                });
            }
        });

        if (el('btnTtClearScope')) {
            el('btnTtClearScope').addEventListener('click', function () {
                var sem = (el('ttSemester') && el('ttSemester').value) || 'SEM-1';
                var sec = (el('ttSection') && el('ttSection').value) || 'A';
                var year = (el('ttAcademicYear') && el('ttAcademicYear').value) || '';
                var branch = (state.user && state.user.department) || '';
                if (!confirm('Are you sure you want to clear the timetable for ' + (branch ? branch + ' ' : '') + sem + ' Section ' + sec + '?\n\nThis will delete scheduled slots for this section only. Faculty records, subjects, classes, and history are preserved.')) {
                    return;
                }
                postJson('/api/timetable/clear', {
                    semester: sem,
                    section: sec,
                    academicYear: year,
                    branch: branch
                }).then(function (res) {
                    alert(res.message || 'Timetable cleared.');
                    loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
                }).catch(function (err) {
                    alert(err.message || 'Failed to clear timetable.');
                });
            });
        }

        // --- master timetable cell editing (HOD edit mode)
        function setupMasterTimetableEdit() {
            var btnEditMode = el('btnTtEditMode');
            var modal = el('ttEditModal');
            var btnClose = el('btnTtCloseEditModal');
            var btnCancel = el('btnTtCancelSlot');
            var btnClear = el('btnTtClearSlot');
            var form = el('ttSlotEditForm');
            var statusBox = el('ttEditStatus');

            var selDay = el('ttEditDay');
            var selPeriod = el('ttEditPeriod');
            var selSubject = el('ttEditSubject');
            var selFaculty = el('ttEditFaculty');
            var inputRoom = el('ttEditRoom');
            var selType = el('ttEditType');

            function populateEditDropdowns(selectedCell) {
                var days = (state.meta && state.meta.days) || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                var periods = (state.meta && state.meta.periods) || [1, 2, 3, 4, 5, 6, 7];

                if (selDay) fillSelect(selDay, days, selectedCell && selectedCell.day);
                if (selPeriod) fillSelect(selPeriod, periods, selectedCell && selectedCell.period);

                getJson(API.entryReference).then(function (ref) {
                    state.entryReference = ref;
                    if (selSubject && ref.subjects) {
                        var subList = [{ value: '', label: '— Free Slot —' }].concat(ref.subjects.map(function (s) {
                            return { value: s.name, label: s.name + (s.code ? ' (' + s.code + ')' : '') };
                        }));
                        if (selectedCell && selectedCell.subject && !ref.subjects.some(function (s) { return s.name === selectedCell.subject; })) {
                            subList.push({ value: selectedCell.subject, label: selectedCell.subject });
                        }
                        fillSelect(selSubject, subList, selectedCell && selectedCell.subject);
                    }
                    if (selFaculty && ref.faculty) {
                        var facList = [{ value: '', label: '— Unassigned / Activity —' }].concat(ref.faculty.map(function (f) {
                            return { value: f.name, label: f.name };
                        }));
                        if (selectedCell && selectedCell.faculty && !ref.faculty.some(function (f) { return f.name === selectedCell.faculty; })) {
                            facList.push({ value: selectedCell.faculty, label: selectedCell.faculty });
                        }
                        fillSelect(selFaculty, facList, selectedCell && selectedCell.faculty);
                    }
                }).catch(function () {});

                if (inputRoom) inputRoom.value = (selectedCell && selectedCell.room) || '';
                if (selType) selType.value = (selectedCell && selectedCell.type) || 'theory';
                if (statusBox) statusBox.style.display = 'none';
            }

            if (btnEditMode) {
                btnEditMode.addEventListener('click', function () {
                    var isHOS = Boolean(state.user && (state.user.role === 'hos' || state.user.role === 'coordinator' || state.user.role === 'admin'));
                    if (!isHOS) return;
                    if (modal.style.display === 'none' || !modal.style.display) {
                        modal.style.display = 'block';
                        var key = state.selected.ttBody;
                        var parts = key ? key.split('|') : [];
                        populateEditDropdowns({ day: parts[0], period: parts[1] ? Number(parts[1]) : 1 });
                    } else {
                        modal.style.display = 'none';
                    }
                });
            }

            if (btnClose) {
                btnClose.addEventListener('click', function () { modal.style.display = 'none'; });
            }
            if (btnCancel) {
                btnCancel.addEventListener('click', function () { modal.style.display = 'none'; });
            }

            function getCurrentClassName() {
                var sem = (el('ttSemester') && el('ttSemester').value) || 'SEM-1';
                var sec = (el('ttSection') && el('ttSection').value) || 'A';
                var dept = (state.user && state.user.department) || '';
                var semNum = parseSemesterNumber(sem) || 1;
                return (dept ? dept + '-' : '') + semNum + '-' + sec;
            }

            if (form) {
                form.addEventListener('submit', function (e) {
                    e.preventDefault();
                    var className = getCurrentClassName();
                    var day = selDay ? selDay.value : null;
                    var period = selPeriod ? selPeriod.value : null;
                    var subject = selSubject ? selSubject.value : '';
                    var faculty = selFaculty ? selFaculty.value : '';
                    var room = inputRoom ? inputRoom.value.trim() : '';
                    var type = selType ? selType.value : 'theory';

                    if (statusBox) {
                        statusBox.style.display = 'block';
                        statusBox.innerHTML = '<div class="notice notice-info">Saving slot…</div>';
                    }

                    postJson('/api/timetable/entries/slot', {
                        className: className,
                        day: day,
                        period: period,
                        subject: subject,
                        faculty: faculty,
                        room: room,
                        type: type
                    }).then(function (res) {
                        if (statusBox) {
                            if (res.ok && res.body && res.body.success) {
                                statusBox.innerHTML = '<div class="notice notice-success"><strong>✓ Slot updated!</strong> Live Master Timetable &amp; availability refreshed.</div>';
                                loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
                                loadDashboard();
                            } else {
                                var err = (res.body && (res.body.error || res.body.message)) || 'Failed to update slot.';
                                statusBox.innerHTML = '<div class="notice notice-danger"><strong>Error:</strong> ' + esc(err) + '</div>';
                            }
                        }
                    }).catch(function (err) {
                        if (statusBox) {
                            statusBox.innerHTML = '<div class="notice notice-danger"><strong>Network error:</strong> ' + esc(err.message) + '</div>';
                        }
                    });
                });
            }

            if (btnClear) {
                btnClear.addEventListener('click', function () {
                    var className = getCurrentClassName();
                    var day = selDay ? selDay.value : null;
                    var period = selPeriod ? selPeriod.value : null;
                    if (!confirm('Clear slot for ' + day + ' Period ' + period + ' (Mark as Free)?')) return;

                    if (statusBox) {
                        statusBox.style.display = 'block';
                        statusBox.innerHTML = '<div class="notice notice-info">Clearing slot…</div>';
                    }

                    postJson('/api/timetable/entries/slot', {
                        className: className,
                        day: day,
                        period: period,
                        subject: ''
                    }).then(function (res) {
                        if (statusBox) {
                            if (res.ok && res.body && res.body.success) {
                                statusBox.innerHTML = '<div class="notice notice-success"><strong>✓ Slot cleared (marked free).</strong></div>';
                                if (selSubject) selSubject.value = '';
                                if (selFaculty) selFaculty.value = '';
                                if (inputRoom) inputRoom.value = '';
                                loadGrid(ttQuery(), 'ttHead', 'ttBody', jumpToAvailability);
                                loadDashboard();
                            } else {
                                var err = (res.body && (res.body.error || res.body.message)) || 'Failed to clear slot.';
                                statusBox.innerHTML = '<div class="notice notice-danger"><strong>Error:</strong> ' + esc(err) + '</div>';
                            }
                        }
                    });
                });
            }
        }
        setupMasterTimetableEdit();

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

        // Faculty Registration Requests Listeners (Phase B7.1)
        if (el('btnRefreshRequests')) el('btnRefreshRequests').addEventListener('click', loadFacultyRequests);
        if (el('btnRejectModalClose')) el('btnRejectModalClose').addEventListener('click', closeRejectModal);
        if (el('btnRejectModalCancel')) el('btnRejectModalCancel').addEventListener('click', closeRejectModal);
        if (el('btnConfirmReject')) el('btnConfirmReject').addEventListener('click', confirmRejectFacultyRequest);

        var requestsTableBody = el('requestsTableBody');
        if (requestsTableBody) {
            requestsTableBody.addEventListener('click', function (e) {
                var approveBtn = e.target.closest('.btn-req-approve');
                if (approveBtn) {
                    var reqId = approveBtn.getAttribute('data-id');
                    var reqName = approveBtn.getAttribute('data-name') || 'Faculty';
                    approveFacultyRequest(reqId, reqName);
                    return;
                }
                var rejectBtn = e.target.closest('.btn-req-reject');
                if (rejectBtn) {
                    var reqId = rejectBtn.getAttribute('data-id');
                    var reqName = rejectBtn.getAttribute('data-name') || 'Faculty';
                    openRejectModal(reqId, reqName);
                    return;
                }
            });
        }

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
                        btnHosUpload.textContent = 'Extracting…';
                    }

                    var formData = new FormData();
                    formData.append('timetable', file);
                    if (el('hosUploadSemester') && el('hosUploadSemester').value) {
                        formData.append('semester', el('hosUploadSemester').value);
                    }
                    if (el('hosUploadSection') && el('hosUploadSection').value) {
                        formData.append('section', el('hosUploadSection').value);
                    }

                    fetch('/api/timetable/import/preview', {
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
                                var slotCount = (res.body.report && res.body.report.stats && res.body.report.stats.busySlots != null)
                                    ? res.body.report.stats.busySlots
                                    : ((res.body.rawContract && res.body.rawContract.entries) ? res.body.rawContract.entries.length : (res.body.rowCount || 0));
                                statusHos.innerHTML =
                                    '<div class="notice notice-success" style="margin-top:10px;">' +
                                    '<strong>Extraction complete!</strong> Found ' + slotCount + ' scheduled slot(s). Review and edit the timetable below before approving.' +
                                    '</div>';
                                if (res.body && res.body.uploadId) {
                                    loadStagedTimetable(res.body.uploadId);
                                    refreshPendingStaging();
                                }
                            } else {
                                var errMsg = (res.body && res.body.error) || 'Upload extraction failed.';
                                statusHos.innerHTML =
                                    '<div class="notice notice-danger" style="margin-top:10px;">' +
                                    '<strong>Extraction failed:</strong> ' + esc(errMsg) +
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
                            btnHosUpload.textContent = 'Preview Timetable';
                        }
                    });
                });
            }

            // Faculty My Timetable Upload & Preview
            var btnFacChoose = el('btnFacChooseFile');
            var inputFacFile = el('facTimetableFile');
            var btnFacUpload = el('btnFacUpload');
            var formFac = el('facUploadForm');
            var nameFac = el('facSelectedFileName');
            var statusFac = el('facUploadStatus');
            var facPreviewCard = el('facPreviewCard');
            var facPreviewCountBadge = el('facPreviewCountBadge');
            var facPreviewHead = el('facPreviewHead');
            var facPreviewBody = el('facPreviewBody');
            var btnFacConfirmSave = el('btnFacConfirmSave');
            var btnFacCancelPreview = el('btnFacCancelPreview');

            var facPendingContract = null;

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
                        btnFacUpload.textContent = 'Extracting…';
                    }

                    var formData = new FormData();
                    formData.append('timetable', file);

                    fetch('/api/faculty/timetable/preview', {
                        method: 'POST',
                        body: formData
                    }).then(function (res) {
                        return res.json().catch(function () { return {}; }).then(function (body) {
                            return { ok: res.ok, status: res.status, body: body };
                        });
                    }).then(function (res) {
                        if (statusFac) statusFac.style.display = 'block';
                        if (!res.ok) {
                            var errMsg = (res.body && res.body.error) || 'Upload preview failed.';
                            statusFac.innerHTML = '<div class="notice notice-danger" style="margin-top:10px;"><strong>Extraction failed:</strong> ' + esc(errMsg) + '</div>';
                            if (facPreviewCard) facPreviewCard.style.display = 'none';
                            return;
                        }

                        facPendingContract = res.body.contract || {};
                        var entries = (res.body.slots && res.body.slots.length > 0) ? res.body.slots : (facPendingContract.entries || []);
                        var totalSlots = res.body.slotCount != null ? res.body.slotCount : (res.body.totalSlots != null ? res.body.totalSlots : entries.length);

                        if (totalSlots === 0) {
                            var diag = res.body.diagnosticReason || res.body.message || 'No scheduled teaching slots were found for your faculty account.';
                            statusFac.innerHTML = '<div class="notice notice-warning" style="margin-top:10px;">' +
                                '<strong>No matching slots found:</strong> ' + esc(diag) + '</div>';
                        } else {
                            statusFac.innerHTML = '<div class="notice notice-success" style="margin-top:10px;">' +
                                '<strong>Extraction complete!</strong> Found ' + totalSlots + ' teaching slot(s) for ' + esc(res.body.faculty || '') + '. Review below and confirm to save to your personal schedule.</div>';
                        }

                        if (facPreviewCard) {
                            facPreviewCard.style.display = 'block';
                            if (facPreviewCountBadge) facPreviewCountBadge.textContent = totalSlots + ' slots';
                            if (facPreviewHead) {
                                facPreviewHead.innerHTML = '<tr><th>Day</th><th>Period</th><th>Subject</th><th>Room</th><th>Class</th><th>Type</th></tr>';
                            }
                            if (facPreviewBody) {
                                if (entries.length === 0) {
                                    facPreviewBody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center; padding: 1.5rem;">' + esc(res.body.diagnosticReason || 'No scheduled teaching slots extracted for your account.') + '</td></tr>';
                                } else {
                                    facPreviewBody.innerHTML = entries.map(function (e) {
                                        return '<tr>' +
                                            '<td style="font-weight:600;">' + esc(e.day) + '</td>' +
                                            '<td>P' + esc(e.period) + '</td>' +
                                            '<td>' + esc(e.subject || e.subject_name || e.subject_code || '—') + '</td>' +
                                            '<td>' + esc(e.room || e.room_code || '—') + '</td>' +
                                            '<td>' + esc(e.className || e.class_name || '—') + '</td>' +
                                            '<td><span class="badge" style="font-size:0.75rem;">' + esc(e.type || e.session_type || 'theory') + '</span></td>' +
                                            '</tr>';
                                    }).join('');
                                }
                            }
                            if (btnFacConfirmSave) {
                                btnFacConfirmSave.disabled = (entries.length === 0);
                            }
                        }
                    }).catch(function (err) {
                        if (statusFac) {
                            statusFac.style.display = 'block';
                            statusFac.innerHTML = '<div class="notice notice-danger" style="margin-top:10px;"><strong>Network error:</strong> ' + esc(err.message) + '</div>';
                        }
                    }).finally(function () {
                        if (btnFacUpload) {
                            btnFacUpload.disabled = false;
                            btnFacUpload.textContent = 'Preview Timetable';
                        }
                    });
                });
            }

            if (btnFacConfirmSave) {
                btnFacConfirmSave.addEventListener('click', function () {
                    var slotsToSave = (facPendingContract && facPendingContract.entries && facPendingContract.entries.length > 0)
                        ? facPendingContract.entries
                        : [];
                    if (slotsToSave.length === 0) return;

                    btnFacConfirmSave.disabled = true;
                    btnFacConfirmSave.textContent = 'Saving…';

                    fetch('/api/faculty/timetable/confirm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            slots: slotsToSave,
                            entries: slotsToSave,
                            academicYear: facPendingContract.academic_year,
                            semester: facPendingContract.semester
                        })
                    }).then(function (r) { return r.json(); }).then(function (res) {
                        btnFacConfirmSave.disabled = false;
                        btnFacConfirmSave.textContent = 'Confirm & Save to My Timetable';
                        if (res.saved) {
                            if (statusFac) {
                                statusFac.innerHTML = '<div class="notice notice-success" style="margin-top:10px;"><strong>✓ Personal timetable saved!</strong> Your My Timetable schedule has been updated without altering the official branch Master Timetable.</div>';
                            }
                            if (facPreviewCard) facPreviewCard.style.display = 'none';
                            loadSchedule();
                        } else {
                            alert(res.error || 'Failed to save personal timetable.');
                        }
                    }).catch(function (err) {
                        btnFacConfirmSave.disabled = false;
                        btnFacConfirmSave.textContent = 'Confirm & Save to My Timetable';
                        alert('Network error: ' + err.message);
                    });
                });
            }

            if (btnFacCancelPreview) {
                btnFacCancelPreview.addEventListener('click', function () {
                    if (facPreviewCard) facPreviewCard.style.display = 'none';
                    facPendingContract = null;
                });
            }

            // --- Phase B2.5 Staging Review & Approval UI Logic ---
            var currentStagingUploadId = null;
            var currentStagingContract = null;

            function openStagingCellEditor(day, period, entry, periods) {
                var modal = el('stagingCellModal');
                if (!modal) return;

                var stgEditDay = el('stgEditDay');
                var stgEditPeriod = el('stgEditPeriod');
                var stgEditSubject = el('stgEditSubject');
                var stgEditSubjectCode = el('stgEditSubjectCode');
                var stgEditFaculty = el('stgEditFaculty');
                var stgEditRoom = el('stgEditRoom');
                var stgEditType = el('stgEditType');
                var stgEditSpanTo = el('stgEditSpanTo');
                var stgEditIsFree = el('stgEditIsFree');
                var modalTitle = el('stagingCellModalTitle');
                var cellStatus = el('stagingCellStatus');

                if (stgEditDay) stgEditDay.value = day;
                if (stgEditPeriod) stgEditPeriod.value = period;
                if (modalTitle) modalTitle.textContent = 'Edit Timetable Slot — ' + day + ' Period ' + period;

                var isFree = !entry || entry.is_free;
                if (stgEditIsFree) stgEditIsFree.checked = isFree;
                if (stgEditSubject) {
                    stgEditSubject.value = isFree ? '' : (entry.subject_name || entry.subject_code || '');
                    stgEditSubject.required = !isFree;
                }
                if (stgEditSubjectCode) stgEditSubjectCode.value = isFree ? '' : (entry.subject_code || '');
                if (stgEditFaculty) stgEditFaculty.value = isFree ? '' : (entry.faculty_name || '');
                if (stgEditRoom) stgEditRoom.value = isFree ? '' : (entry.room_code || '');
                if (stgEditType) stgEditType.value = isFree ? 'theory' : (entry.session_type || 'theory');

                if (stgEditSpanTo) {
                    stgEditSpanTo.innerHTML = '<option value="">Single Period (P' + period + ')</option>';
                    (periods || [1, 2, 3, 4, 5, 6, 7]).forEach(function (p) {
                        if (p > period) {
                            var opt = document.createElement('option');
                            opt.value = p;
                            opt.textContent = 'Spans P' + period + ' to P' + p;
                            if (entry && entry.span_to === p) opt.selected = true;
                            stgEditSpanTo.appendChild(opt);
                        }
                    });
                }

                if (stgEditIsFree) {
                    stgEditIsFree.onchange = function () {
                        var free = stgEditIsFree.checked;
                        if (stgEditSubject) stgEditSubject.required = !free;
                    };
                }

                if (cellStatus) cellStatus.style.display = 'none';
                modal.style.display = 'flex';
            }

            function setupStagingCellModalEvents() {
                var modal = el('stagingCellModal');
                var btnClose = el('btnStagingCellModalClose');
                var btnCancel = el('btnStagingCellCancel');
                var form = el('stagingCellEditForm');
                var btnSave = el('btnStagingCellSave');
                var cellStatus = el('stagingCellStatus');

                if (btnClose && modal && !btnClose._bound) {
                    btnClose._bound = true;
                    btnClose.addEventListener('click', function () { modal.style.display = 'none'; });
                }
                if (btnCancel && modal && !btnCancel._bound) {
                    btnCancel._bound = true;
                    btnCancel.addEventListener('click', function () { modal.style.display = 'none'; });
                }
                if (form && !form._bound) {
                    form._bound = true;
                    form.addEventListener('submit', function (e) {
                        e.preventDefault();
                        if (!currentStagingUploadId) return;

                        var day = el('stgEditDay').value;
                        var period = parseInt(el('stgEditPeriod').value, 10);
                        var isFree = el('stgEditIsFree') ? el('stgEditIsFree').checked : false;
                        var subjectName = el('stgEditSubject') ? el('stgEditSubject').value.trim() : '';
                        var subjectCode = el('stgEditSubjectCode') ? el('stgEditSubjectCode').value.trim() : '';
                        var facultyName = el('stgEditFaculty') ? el('stgEditFaculty').value.trim() : '';
                        var roomCode = el('stgEditRoom') ? el('stgEditRoom').value.trim() : '';
                        var sessionType = el('stgEditType') ? el('stgEditType').value : 'theory';
                        var spanToVal = el('stgEditSpanTo') ? el('stgEditSpanTo').value : '';
                        var spanTo = spanToVal ? parseInt(spanToVal, 10) : null;

                        if (btnSave) {
                            btnSave.disabled = true;
                            btnSave.textContent = 'Saving…';
                        }

                        fetch('/api/staging/' + encodeURIComponent(currentStagingUploadId) + '/entry', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                day: day,
                                period: period,
                                is_free: isFree,
                                subject_name: subjectName,
                                subject_code: subjectCode,
                                faculty_name: facultyName,
                                room_code: roomCode,
                                session_type: sessionType,
                                span_to: spanTo
                            })
                        }).then(function (r) {
                            return r.json().catch(function () { return {}; }).then(function (body) {
                                return { ok: r.ok, status: r.status, body: body };
                            });
                        }).then(function (res) {
                            if (btnSave) {
                                btnSave.disabled = false;
                                btnSave.textContent = 'Save Cell Changes';
                            }
                            if (res.ok) {
                                if (modal) modal.style.display = 'none';
                                loadStagedTimetable(currentStagingUploadId);
                            } else {
                                if (cellStatus) {
                                    cellStatus.style.display = 'block';
                                    cellStatus.innerHTML = '<div class="notice notice-danger">' + esc(res.body.error || 'Failed to save cell changes.') + '</div>';
                                }
                            }
                        }).catch(function (err) {
                            if (btnSave) {
                                btnSave.disabled = false;
                                btnSave.textContent = 'Save Cell Changes';
                            }
                            if (cellStatus) {
                                cellStatus.style.display = 'block';
                                cellStatus.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
                            }
                        });
                    });
                }
            }

            function renderStagingGrid(contract) {
                currentStagingContract = contract;
                setupStagingCellModalEvents();

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

                        var entry = entries.find(function (e) {
                            return String(e.day).trim().toUpperCase() === String(day).trim().toUpperCase() && parseInt(e.period, 10) === p;
                        });

                        if (!entry || entry.is_free) {
                            bodyHtml += '<td class="staging-cell-clickable" data-day="' + esc(day) + '" data-period="' + p + '" style="text-align:center; padding:10px; font-size:0.85rem; cursor:pointer; background:var(--surface-subtle);" title="Click to add/edit slot">' +
                                '<span class="muted" style="opacity:0.6;">—</span> <span style="font-size:0.75rem; color:var(--brand-600); margin-left:4px;">✎</span></td>';
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

                        bodyHtml += '<td class="staging-cell-clickable" data-day="' + esc(day) + '" data-period="' + p + '" ' + (colspan > 1 ? ('colspan="' + colspan + '"') : '') + ' style="background:var(--surface); padding:8px 10px; vertical-align:top; border-left: 3px solid var(--brand-500); cursor:pointer;" title="Click to edit slot">' +
                            '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px; flex-wrap:wrap;">' +
                            typeBadge + (spanBadge ? (' ' + spanBadge) : '') +
                            '<span style="font-size:0.75rem; color:var(--brand-600); font-weight:600;">✎ Edit</span>' +
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

                var stagingTable = el('stagingTable');
                if (stagingTable && !stagingTable._clickBound) {
                    stagingTable._clickBound = true;
                    stagingTable.addEventListener('click', function (e) {
                        var cell = e.target.closest('.staging-cell-clickable');
                        if (!cell) return;
                        var day = cell.getAttribute('data-day');
                        var period = parseInt(cell.getAttribute('data-period'), 10);
                        if (!day || isNaN(period) || !currentStagingContract) return;
                        var entry = (currentStagingContract.entries || []).find(function (it) {
                            return String(it.day).trim().toUpperCase() === day.trim().toUpperCase() && parseInt(it.period, 10) === period;
                        });
                        openStagingCellEditor(day, period, entry, currentStagingContract.periods || [1, 2, 3, 4, 5, 6, 7]);
                    });
                }
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
                    var stgCountBadge = el('stgCountBadge');
                    if (stgCountBadge) stgCountBadge.textContent = ((contract.entries && contract.entries.length) || 0) + ' slots';

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

                    if (alertBox) {
                        var alertHtml = '';
                        var valErrors = s.validationErrors || [];
                        var branchErr = valErrors.find(function (e) { return e.code === 'BRANCH_MISMATCH' || e.code === 'UNRESOLVED_BRANCH'; });
                        if (branchErr) {
                            alertHtml += '<div class="notice notice-danger" style="margin-bottom:12px;">' +
                                '<strong>Branch Mismatch:</strong> ' + esc(branchErr.message) +
                                (branchErr.details && branchErr.details.detectedBranch ? '<br/><strong>Detected branch:</strong> ' + esc(branchErr.details.detectedBranch) : '') +
                                (branchErr.details && branchErr.details.expectedBranch ? '<br/><strong>Your branch:</strong> ' + esc(branchErr.details.expectedBranch) : '') +
                                '</div>';
                        } else if (valErrors.length > 0) {
                            alertHtml += '<div class="notice notice-danger" style="margin-bottom:12px;"><strong>Validation Errors:</strong><br/>' +
                                valErrors.map(function (e) { return '• ' + esc(e.message || e); }).join('<br/>') + '</div>';
                        }
                        var warnings = s.warnings || [];
                        if (warnings.length > 0) {
                            alertHtml += '<div class="notice notice-warning" style="margin-bottom:12px;">' +
                                warnings.map(function (w) { return 'ℹ️ ' + esc(w.message || w); }).join('<br/>') + '</div>';
                        }
                        if (alertHtml) {
                            alertBox.style.display = 'block';
                            alertBox.innerHTML = alertHtml;
                        } else {
                            alertBox.style.display = 'none';
                            alertBox.innerHTML = '';
                        }
                    }

                    var unresolved = (s.resolution && s.resolution.unresolvedEntities) || [];
                    if (unresolved.length > 0) {
                        if (unresolvedBanner) {
                            unresolvedBanner.style.display = 'block';
                            unresolvedBanner.innerHTML = renderUnresolvedCategoriesHtml(unresolved, uploadId);
                            bindUnresolvedActionHandlers(unresolvedBanner, uploadId, function () {
                                loadStagedTimetable(uploadId);
                            });
                        }
                    } else {
                        if (unresolvedBanner) {
                            unresolvedBanner.style.display = 'none';
                            unresolvedBanner.innerHTML = '';
                        }
                    }

                    if (btnApprove) {
                        if (s.importStatus === 'IMPORTED') {
                            btnApprove.disabled = true;
                            btnApprove.textContent = '✓ Already Imported';
                            btnApprove.className = 'btn btn-secondary';
                        } else if (s.importStatus === 'REJECTED') {
                            btnApprove.disabled = true;
                            btnApprove.textContent = 'Rejected';
                            btnApprove.className = 'btn btn-secondary';
                        } else if (s.validationStatus !== 'VALID') {
                            btnApprove.disabled = true;
                            btnApprove.textContent = 'Cannot Approve (Invalid)';
                            btnApprove.className = 'btn btn-secondary';
                        } else if (unresolved.length > 0) {
                            btnApprove.disabled = true;
                            btnApprove.textContent = 'Resolve References to Enable Approval';
                            btnApprove.className = 'btn btn-secondary';
                        } else {
                            btnApprove.disabled = false;
                            btnApprove.textContent = '✓ Accept & Import to Master Timetable';
                            btnApprove.className = 'btn btn-primary';
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
                    var confirmed = confirm('Approve and import this timetable into the live Master Timetable?\n\nExisting live entries for this class will be replaced.');
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
                                var approvedScope = res.body && res.body.scope;
                                bootstrap().then(function () {
                                    if (approvedScope) loadTimetableScopes(approvedScope);
                                    loadDashboard();
                                });
                            } else {
                                actionStatus.innerHTML = '<div class="notice notice-danger"><strong>Import Failed:</strong> ' + esc(res.body.error || 'Failed to import timetable.') + '</div>';
                                btnStgApprove.disabled = false;
                                btnStgApprove.textContent = '✓ Accept & Import to Master Timetable';
                            }
                        }
                    }).catch(function (err) {
                        if (actionStatus) {
                            actionStatus.style.display = 'block';
                            actionStatus.innerHTML = '<div class="notice notice-danger">Network error: ' + esc(err.message) + '</div>';
                        }
                        btnStgApprove.disabled = false;
                        btnStgApprove.textContent = '✓ Accept & Import to Master Timetable';
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

        var btnLoadAtt = el('btnLoadAttendance');
        if (btnLoadAtt) {
            btnLoadAtt.addEventListener('click', function () {
                var input = el('attDateInput');
                if (input && input.value) {
                    loadHOSAttendance(input.value);
                }
            });
        }
        var inputAttDate = el('attDateInput');
        if (inputAttDate) {
            inputAttDate.addEventListener('change', function () {
                if (inputAttDate.value) {
                    loadHOSAttendance(inputAttDate.value);
                }
            });
        }
        var btnRefreshAtt = el('btnRefreshAttendance');
        if (btnRefreshAtt) {
            btnRefreshAtt.addEventListener('click', function () {
                var input = el('attDateInput');
                loadHOSAttendance(input ? input.value : null);
            });
        }

        // Invigilation event listeners (B7.3)
        var directInvigForm = el('directInvigForm');
        if (directInvigForm) {
            directInvigForm.addEventListener('submit', handleDirectInvigSubmit);
        }

        var btnRefreshInvig = el('btnRefreshInvig');
        if (btnRefreshInvig) {
            btnRefreshInvig.addEventListener('click', function () {
                var input = el('filterInvigDate');
                loadActiveInvigTable(input ? input.value : null);
            });
        }

        var btnFilterInvig = el('btnFilterInvig');
        if (btnFilterInvig) {
            btnFilterInvig.addEventListener('click', function () {
                var input = el('filterInvigDate');
                if (input && input.value) {
                    loadActiveInvigTable(input.value);
                }
            });
        }

        var btnClearFilterInvig = el('btnClearFilterInvig');
        if (btnClearFilterInvig) {
            btnClearFilterInvig.addEventListener('click', function () {
                var input = el('filterInvigDate');
                if (input) input.value = '';
                loadActiveInvigTable();
            });
        }

        var filterInvigReqStatus = el('filterInvigReqStatus');
        if (filterInvigReqStatus) {
            filterInvigReqStatus.addEventListener('change', function () {
                loadHOSInvigRequests(filterInvigReqStatus.value);
            });
        }

        var btnRefreshInvigReqs = el('btnRefreshInvigReqs');
        if (btnRefreshInvigReqs) {
            btnRefreshInvigReqs.addEventListener('click', function () {
                loadHOSInvigRequests();
            });
        }

        var btnRejectInvigClose = el('btnRejectInvigClose');
        if (btnRejectInvigClose) {
            btnRejectInvigClose.addEventListener('click', closeRejectInvigModal);
        }

        var btnRejectInvigCancel = el('btnRejectInvigCancel');
        if (btnRejectInvigCancel) {
            btnRejectInvigCancel.addEventListener('click', closeRejectInvigModal);
        }

        var btnConfirmRejectInvig = el('btnConfirmRejectInvig');
        if (btnConfirmRejectInvig) {
            btnConfirmRejectInvig.addEventListener('click', confirmRejectInvig);
        }

        var btnRefreshMyInvig = el('btnRefreshMyInvig');
        if (btnRefreshMyInvig) {
            btnRefreshMyInvig.addEventListener('click', loadMyInvigilation);
        }

        var facultyInvigRequestForm = el('facultyInvigRequestForm');
        if (facultyInvigRequestForm) {
            facultyInvigRequestForm.addEventListener('submit', handleFacultyInvigRequestSubmit);
        }

        // Faculty Substitution event listeners (Phase B7.5)
        Array.prototype.forEach.call(document.querySelectorAll('.sub-tab-btn'), function (btn) {
            btn.addEventListener('click', function () {
                switchSubTab(btn.getAttribute('data-sub-tab'));
            });
        });

        var btnCheckVacant = el('btnCheckVacantPeriods');
        if (btnCheckVacant) {
            btnCheckVacant.addEventListener('click', handleFindVacantPeriods);
        }

        var btnRefreshVacant = el('btnRefreshVacantPeriods');
        if (btnRefreshVacant) {
            btnRefreshVacant.addEventListener('click', handleFindVacantPeriods);
        }

        var btnRefreshIncoming = el('btnRefreshIncomingSubs');
        if (btnRefreshIncoming) {
            btnRefreshIncoming.addEventListener('click', loadIncomingSubstitutions);
        }

        var btnRefreshMySubs = el('btnRefreshMySubs');
        if (btnRefreshMySubs) {
            btnRefreshMySubs.addEventListener('click', loadMySubstitutions);
        }

        var btnRejectSubClose = el('btnRejectSubModalClose');
        if (btnRejectSubClose) {
            btnRejectSubClose.addEventListener('click', closeRejectSubModal);
        }

        var btnRejectSubCancel = el('btnRejectSubModalCancel');
        if (btnRejectSubCancel) {
            btnRejectSubCancel.addEventListener('click', closeRejectSubModal);
        }

        var btnConfirmRejectSub = el('btnConfirmRejectSub');
        if (btnConfirmRejectSub) {
            btnConfirmRejectSub.addEventListener('click', confirmRejectSub);
        }

        var btnRefreshHOSSubs = el('btnRefreshHOSSubs');
        if (btnRefreshHOSSubs) {
            btnRefreshHOSSubs.addEventListener('click', function () {
                var d = el('filterHOSSubDate') ? el('filterHOSSubDate').value : '';
                var s = el('filterHOSSubStatus') ? el('filterHOSSubStatus').value : '';
                loadHOSSubstitutionsView(d, s);
            });
        }

        var btnFilterHOSSubs = el('btnFilterHOSSubs');
        if (btnFilterHOSSubs) {
            btnFilterHOSSubs.addEventListener('click', function () {
                var d = el('filterHOSSubDate') ? el('filterHOSSubDate').value : '';
                var s = el('filterHOSSubStatus') ? el('filterHOSSubStatus').value : '';
                loadHOSSubstitutionsView(d, s);
            });
        }

        var btnClearFilterHOSSubs = el('btnClearFilterHOSSubs');
        if (btnClearFilterHOSSubs) {
            btnClearFilterHOSSubs.addEventListener('click', function () {
                if (el('filterHOSSubDate')) el('filterHOSSubDate').value = '';
                if (el('filterHOSSubStatus')) el('filterHOSSubStatus').value = '';
                loadHOSSubstitutionsView();
            });
        }

        setupTimetableUploads();

        loadSession().then(function () {
            var initial = viewFromHash();
            if (initial) showView(initial, false);
            return bootstrap();
        });
    });
})();
