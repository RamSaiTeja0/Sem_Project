/**
 * Sign-in page. Posts to /api/auth/login, which sets the session cookie, then
 * follows the ?next= parameter (or the dashboard).
 */
(function () {
    'use strict';

    function el(id) { return document.getElementById(id); }

    function message(text, kind) {
        var box = el('loginMessage');
        box.textContent = text;
        box.className = 'login-message is-visible is-' + (kind || 'info');
    }

    function nextUrl() {
        var match = /[?&]next=([^&]+)/.exec(window.location.search);
        if (!match) return '/dashboard';
        var target = decodeURIComponent(match[1]);
        // Only same-origin paths, so ?next= cannot be used to bounce elsewhere.
        return /^\/(?!\/)/.test(target) ? target : '/dashboard';
    }

    document.addEventListener('DOMContentLoaded', function () {
        var form = el('loginForm');
        var submit = el('loginSubmit');

        // If sign-in is not enforced, say so rather than implying it is required.
        fetch('/api/auth/session').then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.authenticated) {
                    message('Already signed in as ' + data.user.name + '.', 'ok');
                } else if (!data.authRequired) {
                    message('Sign-in is optional on this deployment — you can also continue as a guest.', 'info');
                }
                var guest = el('guestLink');
                if (guest && data.authRequired) guest.style.display = 'none';
            })
            .catch(function () { /* the form still works */ });

        // The password hint is only served while the demo default is in use.
        fetch('/api/auth/accounts').then(function (res) { return res.json(); })
            .then(function (data) {
                var hint = el('demoPassword');
                if (!hint) return;
                if (data.demoPassword) {
                    hint.textContent = data.demoPassword;
                } else {
                    var block = document.querySelector('.login-demo');
                    if (block) block.style.display = 'none';
                }
            })
            .catch(function () { /* keep the documented default on screen */ });

        Array.prototype.forEach.call(document.querySelectorAll('.demo-chip'), function (chip) {
            chip.addEventListener('click', function () {
                el('username').value = chip.dataset.user;
                el('password').value = el('demoPassword').textContent.trim();
                el('password').focus();
            });
        });

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            var username = el('username').value.trim();
            var password = el('password').value;

            if (!username || !password) {
                message('Enter both a username and a password.', 'error');
                return;
            }

            submit.disabled = true;
            message('Signing in…', 'info');

            fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, password: password })
            }).then(function (res) {
                return res.json().catch(function () { return null; })
                    .then(function (body) { return { ok: res.ok, body: body }; });
            }).then(function (res) {
                if (!res.ok) {
                    submit.disabled = false;
                    message((res.body && res.body.error) || 'Sign-in failed.', 'error');
                    return;
                }
                message('Signed in as ' + res.body.user.name + '. Opening the dashboard…', 'ok');
                window.location.href = nextUrl();
            }).catch(function () {
                submit.disabled = false;
                message('Could not reach the server. Check that it is running and try again.', 'error');
            });
        });
    });
})();
