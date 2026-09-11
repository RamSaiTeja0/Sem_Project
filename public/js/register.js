/**
 * Real Account Registration Handler.
 *
 * Coordinates instance setup status, role selection, dynamic faculty subjects/expertise management,
 * password visibility toggling, client-side validation, and server registration request.
 */
(function () {
    'use strict';

    function el(id) { return document.getElementById(id); }

    var subjects = [];

    function showMessage(text, kind) {
        var box = el('registerMessage');
        if (!box) return;
        box.className = 'login-message is-' + kind;
        box.textContent = text;
        box.style.display = 'block';
    }

    function clearMessage() {
        var box = el('registerMessage');
        if (box) {
            box.textContent = '';
            box.style.display = 'none';
        }
    }

    function renderSubjectTags() {
        var container = el('subjectTagContainer');
        if (!container) return;
        container.innerHTML = '';
        subjects.forEach(function (subj, index) {
            var tag = document.createElement('span');
            tag.className = 'subject-tag';
            tag.textContent = subj;

            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.innerHTML = '&times;';
            removeBtn.title = 'Remove ' + subj;
            removeBtn.onclick = function () {
                subjects.splice(index, 1);
                renderSubjectTags();
            };

            tag.appendChild(removeBtn);
            container.appendChild(tag);
        });

        var errBox = el('subjectError');
        if (errBox) {
            if (subjects.length > 0) {
                errBox.style.display = 'none';
            }
        }
    }

    function addSubjectFromInput() {
        var input = el('subjectInput');
        if (!input) return;
        var val = input.value.trim();
        if (!val) return;

        // Prevent duplicate subjects
        var exists = subjects.some(function (s) {
            return s.toLowerCase() === val.toLowerCase();
        });
        if (!exists) {
            subjects.push(val);
            renderSubjectTags();
        }
        input.value = '';
        input.focus();
    }

    /**
     * Password validation rule:
     * - ONLY letters, numbers, and underscore allowed: /^[A-Za-z0-9_]+$/
     * - At least one letter: /[A-Za-z]/
     * - At least one number: /[0-9]/
     * - At least one underscore: /_/
     * - NO dot, dash, space or other characters
     */
    function validatePassword(pwd) {
        if (!pwd || typeof pwd !== 'string') return false;
        if (!/^[A-Za-z0-9_]+$/.test(pwd)) return false;
        return /[A-Za-z]/.test(pwd) && /[0-9]/.test(pwd) && /_/.test(pwd);
    }

    function updatePasswordRequirementsLive() {
        var pwd = el('regPassword') ? el('regPassword').value : '';
        var hasLetter = /[A-Za-z]/.test(pwd);
        var hasNumber = /[0-9]/.test(pwd);
        var hasUnderscore = /_/.test(pwd);
        var onlyAllowed = pwd.length > 0 && /^[A-Za-z0-9_]+$/.test(pwd);
        var hasIllegal = pwd.length > 0 && !/^[A-Za-z0-9_]+$/.test(pwd);

        function updateItem(id, isValid, isIllegal) {
            var item = el(id);
            if (!item) return;
            var icon = item.querySelector('.pw-icon');
            if (isIllegal) {
                item.className = 'pw-req-item is-invalid';
                if (icon) icon.textContent = '✗';
            } else if (isValid) {
                item.className = 'pw-req-item is-valid';
                if (icon) icon.textContent = '✓';
            } else {
                item.className = 'pw-req-item';
                if (icon) icon.textContent = '○';
            }
        }

        updateItem('reqLetter', hasLetter, false);
        updateItem('reqNumber', hasNumber, false);
        updateItem('reqUnderscore', hasUnderscore, false);
        updateItem('reqChars', onlyAllowed, hasIllegal);
    }

    /**
     * Accessible Show/Hide password toggle.
     */
    function setupPasswordToggle(inputId, toggleBtnId) {
        var input = el(inputId);
        var btn = el(toggleBtnId);
        if (!input || !btn) return;

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            var isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';

            var newLabel = isPassword ? 'Hide password' : 'Show password';
            btn.setAttribute('aria-label', newLabel);
            btn.setAttribute('title', newLabel);

            var eyeIcon = btn.querySelector('.eye-icon');
            var eyeOffIcon = btn.querySelector('.eye-off-icon');
            if (eyeIcon && eyeOffIcon) {
                eyeIcon.style.display = isPassword ? 'none' : 'block';
                eyeOffIcon.style.display = isPassword ? 'block' : 'none';
            }
            input.focus();
        });
    }

    var isHOSSession = false;
    var sessionBranch = { code: '', name: '' };

    function updateRoleUI(selectedRole) {
        var isHOS = selectedRole === 'hos';
        var subjectsSec = el('facultySubjectsSection');
        var branchRow = el('branchRow');
        var currentBranchBox = el('currentBranchBox');
        var currentBranchDisplay = el('currentBranchDisplay');
        var hosFacultyHeader = el('hosFacultyHeader');
        var roleSelectorWrap = el('roleSelectorWrap');
        var registerTitle = el('registerTitle');
        var submitBtn = el('registerSubmit');

        var hosLabel = el('roleHOSLabel');
        var facLabel = el('roleFacultyLabel');
        if (hosLabel) hosLabel.classList.toggle('is-selected', isHOS);
        if (facLabel) facLabel.classList.toggle('is-selected', !isHOS);

        var branchNameInput = el('regBranchName');
        var branchCodeInput = el('regBranchCode');
        var facultyBranchRow = el('facultyBranchRow');
        var facultyDesignationRow = el('facultyDesignationRow');

        if (isHOSSession) {
            // FLOW B: Authenticated HOS is creating faculty
            // DO NOT show editable Branch Name and Branch Code inputs!
            if (registerTitle) registerTitle.textContent = 'Create Faculty Account';
            if (hosFacultyHeader) hosFacultyHeader.style.display = 'block';
            if (roleSelectorWrap) roleSelectorWrap.style.display = 'none';
            if (branchRow) branchRow.style.display = 'none'; // strictly hidden
            if (facultyBranchRow) facultyBranchRow.style.display = 'none';
            if (facultyDesignationRow) facultyDesignationRow.style.display = 'none';
            if (currentBranchBox) currentBranchBox.style.display = 'block';
            if (currentBranchDisplay) {
                var bName = sessionBranch.name || sessionBranch.code;
                currentBranchDisplay.textContent = sessionBranch.code + (bName && bName !== sessionBranch.code ? ' — ' + bName : '');
            }
            if (subjectsSec) subjectsSec.style.display = 'block';
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Faculty Account';
            }
        } else {
            // FLOW A: Unauthenticated visitor / New HOS or Faculty Registration
            if (hosFacultyHeader) hosFacultyHeader.style.display = 'none';
            if (roleSelectorWrap) roleSelectorWrap.style.display = 'block';
            if (currentBranchBox) currentBranchBox.style.display = 'none';

            if (isHOS) {
                // Initial HOS creating new branch: inputs are EMPTY and EDITABLE
                if (registerTitle) registerTitle.textContent = 'Create Head of Section Account';
                if (subjectsSec) subjectsSec.style.display = 'none';
                if (branchRow) branchRow.style.display = 'grid';
                if (facultyBranchRow) facultyBranchRow.style.display = 'none';
                if (facultyDesignationRow) facultyDesignationRow.style.display = 'none';
                if (branchNameInput && branchCodeInput) {
                    branchNameInput.readOnly = false;
                    branchCodeInput.readOnly = false;
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Register HOS Account';
                }
            } else {
                // Public visitor selected Faculty Registration (Flow C)
                if (registerTitle) registerTitle.textContent = 'Request Faculty Account';
                if (subjectsSec) subjectsSec.style.display = 'block';
                if (branchRow) branchRow.style.display = 'none';
                if (facultyBranchRow) facultyBranchRow.style.display = 'block';
                if (facultyDesignationRow) facultyDesignationRow.style.display = 'block';
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit Registration Request';
                }
            }
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        var form = el('registerForm');
        var submitBtn = el('registerSubmit');

        // Setup password show/hide toggles
        setupPasswordToggle('regPassword', 'toggleRegPassword');
        setupPasswordToggle('regConfirmPassword', 'toggleRegConfirmPassword');

        // Setup live password requirements listener
        if (el('regPassword')) {
            el('regPassword').addEventListener('input', updatePasswordRequirementsLive);
        }

        // Setup copy credential buttons
        if (el('btnCopyUsername')) {
            el('btnCopyUsername').addEventListener('click', function () {
                var u = el('succFacUsername') ? el('succFacUsername').textContent : '';
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(u);
                    if (el('copyFeedback')) el('copyFeedback').textContent = '✓ Username copied to clipboard';
                }
            });
        }
        if (el('btnCopyPassword')) {
            el('btnCopyPassword').addEventListener('click', function () {
                var p = el('succFacPassword') ? el('succFacPassword').textContent : '';
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(p);
                    if (el('copyFeedback')) el('copyFeedback').textContent = '✓ Password copied to clipboard';
                }
            });
        }
        if (el('btnDismissSuccess')) {
            el('btnDismissSuccess').addEventListener('click', function () {
                var panel = el('facultySuccessPanel');
                if (panel) panel.style.display = 'none';
            });
        }

        if (el('btnHosLogoutToRegister')) {
            el('btnHosLogoutToRegister').addEventListener('click', function () {
                fetch('/api/auth/logout', { method: 'POST' })
                    .then(function () { window.location.reload(); })
                    .catch(function () { window.location.reload(); });
            });
        }

        // Fetch setup and session status from server
        fetch('/api/auth/status')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                isHOSSession = Boolean(data.authenticated && data.isHOS);
                var branch = data.branch || {};

                var setupNotice = el('setupNotice');
                var hosRadio = el('roleHOS');
                var facRadio = el('roleFaculty');

                if (isHOSSession && branch.configured && branch.code) {
                    // FLOW B: HOS is logged in creating faculty
                    sessionBranch = { code: branch.code, name: branch.name || branch.code };
                    if (el('regBranchName')) el('regBranchName').value = sessionBranch.name;
                    if (el('regBranchCode')) el('regBranchCode').value = sessionBranch.code;

                    if (setupNotice) setupNotice.style.display = 'none';
                    if (hosRadio) hosRadio.disabled = true;
                    if (facRadio) facRadio.checked = true;
                    updateRoleUI('faculty');
                } else {
                    // FLOW A: Public visitor — empty branch fields, no CME default
                    sessionBranch = { code: '', name: '' };
                    if (el('regBranchName')) el('regBranchName').value = '';
                    if (el('regBranchCode')) el('regBranchCode').value = '';

                    if (setupNotice) setupNotice.style.display = 'block';
                    if (hosRadio) {
                        hosRadio.disabled = false;
                        hosRadio.checked = true;
                    }
                    updateRoleUI('hos');
                }
            })
            .catch(function () {
                // Fallback to empty HOS form
                updateRoleUI('hos');
            });

        // Role radio change listeners
        Array.prototype.forEach.call(document.querySelectorAll('input[name="role"]'), function (radio) {
            radio.addEventListener('change', function () {
                updateRoleUI(this.value);
            });
        });

        // Subject addition listeners
        if (el('addSubjectBtn')) {
            el('addSubjectBtn').addEventListener('click', addSubjectFromInput);
        }
        if (el('subjectInput')) {
            el('subjectInput').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addSubjectFromInput();
                }
            });
        }

        // Setup branch dropdown change listener
        if (el('regFacultyBranchSelect')) {
            el('regFacultyBranchSelect').addEventListener('change', function () {
                if (el('regFacultyBranchCode')) {
                    el('regFacultyBranchCode').value = this.value;
                }
            });
        }

        if (el('btnNewFacultyRequest')) {
            el('btnNewFacultyRequest').addEventListener('click', function () {
                var panel = el('facultyRequestSuccessPanel');
                if (panel) panel.style.display = 'none';
                clearMessage();
            });
        }

        function loadRegisteredBranches() {
            fetch('/api/faculty-requests/branches')
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    var sel = el('regFacultyBranchSelect');
                    if (!sel || !data || !Array.isArray(data.branches)) return;
                    sel.innerHTML = '<option value="">-- Select Registered Branch --</option>';
                    data.branches.forEach(function (b) {
                        var opt = document.createElement('option');
                        opt.value = b.code;
                        opt.textContent = b.code + (b.name && b.name !== b.code ? ' — ' + b.name : '');
                        sel.appendChild(opt);
                    });
                })
                .catch(function () {});
        }
        loadRegisteredBranches();

        // Check URL params for role=faculty or role=faculty_request
        var urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('role') === 'faculty' || urlParams.get('role') === 'faculty_request') {
            var facRadioParam = el('roleFaculty');
            if (facRadioParam) {
                facRadioParam.checked = true;
                updateRoleUI('faculty_request');
            }
        }

        // Form submission
        if (form) {
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                clearMessage();

                var role = isHOSSession ? 'faculty' : ((document.querySelector('input[name="role"]:checked') || {}).value || 'hos');
                var name = el('regName').value.trim();
                var phone = el('regPhone').value.trim();
                var username = el('regUsername').value.trim();
                var password = el('regPassword').value;
                var confirmPassword = el('regConfirmPassword').value;

                if (!name || name.length < 2) {
                    showMessage('Please enter your full name (at least 2 characters).', 'error');
                    el('regName').focus();
                    return;
                }
                if (!phone) {
                    showMessage('Please enter your phone number.', 'error');
                    el('regPhone').focus();
                    return;
                }

                if (!username || username.length < 3) {
                    showMessage('Username must be at least 3 characters.', 'error');
                    el('regUsername').focus();
                    return;
                }

                // Strictly validate password requirement
                if (!validatePassword(password)) {
                    showMessage('Password must contain at least one letter, one number, and one underscore (_). Only letters, numbers, and underscores are allowed.', 'error');
                    el('regPassword').focus();
                    return;
                }

                if (password !== confirmPassword) {
                    showMessage('Passwords do not match.', 'error');
                    el('regConfirmPassword').focus();
                    return;
                }

                // FLOW C: Faculty Self-Registration Request
                if (role === 'faculty_request') {
                    var facBranchCode = '';
                    if (el('regFacultyBranchCode') && el('regFacultyBranchCode').value.trim()) {
                        facBranchCode = el('regFacultyBranchCode').value.trim().toUpperCase();
                    } else if (el('regFacultyBranchSelect') && el('regFacultyBranchSelect').value.trim()) {
                        facBranchCode = el('regFacultyBranchSelect').value.trim().toUpperCase();
                    }

                    if (!facBranchCode) {
                        showMessage('Please select or enter your branch code.', 'error');
                        if (el('regFacultyBranchCode')) el('regFacultyBranchCode').focus();
                        return;
                    }

                    if (subjects.length === 0) {
                        var subInputVal = el('subjectInput') ? el('subjectInput').value.trim() : '';
                        if (subInputVal) {
                            subjects.push(subInputVal);
                            renderSubjectTags();
                        } else {
                            showMessage('Please add at least one subject or area of expertise.', 'error');
                            var errBox = el('subjectError');
                            if (errBox) {
                                errBox.textContent = 'At least one subject is required.';
                                errBox.style.display = 'block';
                            }
                            if (el('subjectInput')) el('subjectInput').focus();
                            return;
                        }
                    }

                    var designation = el('regDesignation') ? el('regDesignation').value : null;

                    var requestPayload = {
                        name: name,
                        phone: phone,
                        branchCode: facBranchCode,
                        username: username,
                        password: password,
                        confirmPassword: confirmPassword,
                        designation: designation,
                        subjects: subjects
                    };

                    if (submitBtn) {
                        submitBtn.disabled = true;
                        submitBtn.textContent = 'Submitting Request…';
                    }

                    fetch('/api/faculty-requests', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestPayload)
                    })
                        .then(function (res) {
                            return res.json().then(function (data) {
                                return { status: res.status, data: data };
                            });
                        })
                        .then(function (res) {
                            if (res.status >= 400) {
                                if (submitBtn) {
                                    submitBtn.disabled = false;
                                    submitBtn.textContent = 'Submit Registration Request';
                                }
                                showMessage((res.data && res.data.error) || 'Registration request failed.', 'error');
                                return;
                            }

                            if (submitBtn) {
                                submitBtn.disabled = false;
                                submitBtn.textContent = 'Submit Registration Request';
                            }

                            showMessage('Registration request submitted successfully for Head of Section review.', 'ok');
                            var panel = el('facultyRequestSuccessPanel');
                            if (panel) {
                                if (el('succReqBranch')) {
                                    el('succReqBranch').textContent = (res.data && res.data.request && res.data.request.branchCode) || facBranchCode;
                                }
                                panel.style.display = 'block';
                                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }

                            ['regName', 'regPhone', 'regUsername', 'regPassword', 'regConfirmPassword', 'subjectInput', 'regFacultyBranchCode'].forEach(function (id) {
                                if (el(id)) el(id).value = '';
                            });
                            if (el('regFacultyBranchSelect')) el('regFacultyBranchSelect').value = '';
                            subjects = [];
                            renderSubjectTags();
                        })
                        .catch(function (err) {
                            if (submitBtn) {
                                submitBtn.disabled = false;
                                submitBtn.textContent = 'Submit Registration Request';
                            }
                            showMessage('Network error: ' + err.message, 'error');
                        });
                    return;
                }

                // FLOW A (HOS Registration) or FLOW B (HOS creating faculty directly)
                var branchName = isHOSSession ? sessionBranch.name : el('regBranchName').value.trim();
                var branchCode = isHOSSession ? sessionBranch.code : el('regBranchCode').value.trim().toUpperCase();

                if (role === 'hos') {
                    if (!branchName) {
                        showMessage('Please enter the branch name.', 'error');
                        el('regBranchName').focus();
                        return;
                    }
                    if (!branchCode) {
                        showMessage('Please enter the branch code.', 'error');
                        el('regBranchCode').focus();
                        return;
                    }
                }

                if (role === 'faculty') {
                    if (subjects.length === 0) {
                        var subInputVal2 = el('subjectInput') ? el('subjectInput').value.trim() : '';
                        if (subInputVal2) {
                            subjects.push(subInputVal2);
                            renderSubjectTags();
                        } else {
                            showMessage('Please add at least one subject or area of expertise for this faculty member.', 'error');
                            var errBox2 = el('subjectError');
                            if (errBox2) {
                                errBox2.textContent = 'At least one subject is required.';
                                errBox2.style.display = 'block';
                            }
                            if (el('subjectInput')) el('subjectInput').focus();
                            return;
                        }
                    }
                }

                var payload = {
                    role: role,
                    name: name,
                    phone: phone,
                    branchName: branchName,
                    branchCode: branchCode,
                    username: username,
                    password: password,
                    confirmPassword: confirmPassword,
                    subjects: role === 'faculty' ? subjects : []
                };

                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.textContent = isHOSSession ? 'Creating Faculty Account…' : 'Creating Account…';
                }

                fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
                    .then(function (res) {
                        return res.json().then(function (data) {
                            return { status: res.status, data: data };
                        });
                    })
                    .then(function (res) {
                        if (res.status >= 400) {
                            if (submitBtn) {
                                submitBtn.disabled = false;
                                submitBtn.textContent = isHOSSession ? 'Create Faculty Account' : 'Register HOS Account';
                            }
                            showMessage((res.data && res.data.error) || 'Registration failed. Please check your inputs.', 'error');
                            return;
                        }

                        if (role === 'faculty') {
                            if (submitBtn) {
                                submitBtn.disabled = false;
                                submitBtn.textContent = 'Create Faculty Account';
                            }
                            showMessage('Faculty account created successfully for ' + name + '.', 'ok');
                            var panel = el('facultySuccessPanel');
                            if (panel) {
                                if (el('succFacName')) el('succFacName').textContent = name;
                                if (el('succFacUsername')) el('succFacUsername').textContent = username;
                                if (el('succFacPassword')) el('succFacPassword').textContent = password;
                                var bCode = (res.data && res.data.user && res.data.user.department) || sessionBranch.code;
                                var bName = (res.data && res.data.user && res.data.user.branchName) || sessionBranch.name;
                                if (el('succFacBranch')) el('succFacBranch').textContent = bCode + (bName && bName !== bCode ? ' — ' + bName : '');
                                if (el('copyFeedback')) el('copyFeedback').textContent = '';
                                panel.style.display = 'block';
                                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }
                            ['regName', 'regPhone', 'regUsername', 'regPassword', 'regConfirmPassword', 'subjectInput'].forEach(function (id) {
                                if (el(id)) el(id).value = '';
                            });
                            subjects = [];
                            renderSubjectTags();
                        } else {
                            showMessage('Account created successfully. Loading dashboard…', 'ok');
                            setTimeout(function () {
                                window.location.href = '/dashboard';
                            }, 500);
                        }
                    })
                    .catch(function (err) {
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.textContent = isHOSSession ? 'Create Faculty Account' : 'Register HOS Account';
                        }
                        showMessage('Network error during registration: ' + err.message, 'error');
                    });
            });
        }
    });
})();

