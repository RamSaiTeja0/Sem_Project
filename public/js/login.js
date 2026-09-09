/**
 * Real Account Login Handler.
 *
 * Checks instance status, handles credential submission, displays server error messages,
 * and sets the session on successful authentication.
 */
(function () {
    'use strict';

    function el(id) { return document.getElementById(id); }

    function showMessage(text, kind) {
        var box = el('loginMessage');
        if (!box) return;
        box.className = 'login-message is-' + kind;
        box.textContent = text;
        box.style.display = 'block';
    }

    function clearMessage() {
        var box = el('loginMessage');
        if (box) {
            box.textContent = '';
            box.style.display = 'none';
        }
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

    document.addEventListener('DOMContentLoaded', function () {
        var form = el('loginForm');
        var submitBtn = el('loginSubmit');

        setupPasswordToggle('toggleLoginPassword', 'password');

        // Check if an initial HOS account is needed
        fetch('/api/auth/status')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var banner = el('setupBanner');
                if (banner) {
                    banner.style.display = data.hasHOS ? 'none' : 'block';
                }
            })
            .catch(function () { /* ignore status error */ });

        // Check whether sign-in is required or guest browsing is permitted
        fetch('/api/auth/session')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var guest = el('guestLink');
                if (guest && data.authRequired) {
                    guest.style.display = 'none';
                }
            })
            .catch(function () { /* fallback to default */ });

        if (form) {
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                clearMessage();

                var username = el('username').value.trim();
                var password = el('password').value;

                if (!username) {
                    showMessage('Please enter your username.', 'error');
                    el('username').focus();
                    return;
                }
                if (!password) {
                    showMessage('Please enter your password.', 'error');
                    el('password').focus();
                    return;
                }

                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Signing in…';
                }

                fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                })
                    .then(function (res) {
                        return res.json().then(function (data) {
                            return { status: res.status, data: data };
                        });
                    })
                    .then(function (res) {
                        if (res.status !== 200) {
                            if (submitBtn) {
                                submitBtn.disabled = false;
                                submitBtn.textContent = 'Sign in';
                            }
                            showMessage((res.data && res.data.error) || 'Incorrect username or password.', 'error');
                            return;
                        }

                        showMessage('Sign-in successful. Opening dashboard…', 'info');
                        var next = new URLSearchParams(window.location.search).get('next') || '/dashboard';
                        window.location.href = next;
                    })
                    .catch(function (err) {
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Sign in';
                        }
                        showMessage('Network error while signing in: ' + err.message, 'error');
                    });
            });
        }
    });
})();
