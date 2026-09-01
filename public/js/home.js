/** Landing page: the mobile menu toggle and the footer year. */
(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', function () {
        var toggle = document.getElementById('navToggle');
        var nav = document.getElementById('siteNav');

        if (toggle && nav) {
            toggle.addEventListener('click', function () {
                var open = nav.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', String(open));
            });
            nav.addEventListener('click', function (event) {
                if (event.target.tagName === 'A') {
                    nav.classList.remove('is-open');
                    toggle.setAttribute('aria-expanded', 'false');
                }
            });
        }

        var year = document.getElementById('footYear');
        if (year) year.textContent = String(new Date().getFullYear());
    });
})();
