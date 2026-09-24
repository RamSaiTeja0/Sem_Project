/**
 * TecSubstitution — Faculty Substitution / Availability Finder.
 *
 * Layering:
 *   demo data / Excel / CSV -> normalizer -> validator -> store
 *                           -> availability engine -> REST API -> dashboard
 *
 * The availability path is read-only: clicking a timetable cell never assigns
 * a substitute, saves a selection, or modifies any timetable.
 */
const express = require('express');
const path = require('path');

const config = require('./src/config');
const session = require('./src/core/session');
const store = require('./src/data/store');
const timetableRoutes = require('./src/routes/timetable');
const facultyRoutes = require('./src/routes/faculty');
const availabilityRoutes = require('./src/routes/availability');
const importRoutes = require('./src/routes/import');
const entryRoutes = require('./src/routes/entries');
const catalogRoutes = require('./src/routes/catalog');
const authRoutes = require('./src/routes/auth');
const uploadRoutes = require('./src/routes/uploads');
const internalUploadRoutes = require('./src/routes/internalUploads');
const stagingRoutes = require('./src/routes/staging');
const facultyRequestRoutes = require('./src/routes/facultyRequests');
const attendanceRoutes = require('./src/routes/attendance');
const invigilationRoutes = require('./src/routes/invigilation');
const substitutionRoutes = require('./src/routes/substitutions');
const facultyTimetableRoutes = require('./src/routes/facultyTimetable');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Reads the signed session cookie and exposes req.session. Mounted before the
// routes so every handler, page and guard sees the same view of the user.
app.use(session.middleware);

// Landing page.
app.get(['/', '/home', '/home.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Sign-in page. Always reachable, including when auth is not enforced.
// If already authenticated, redirect to /dashboard to prevent redundant login forms.
app.get(['/login', '/login.html'], (req, res) => {
    if (req.session && req.session.username) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Create account page.
app.get(['/register', '/register.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Static assets. `index: false` so "/" is routed explicitly to the landing
// page rather than being served index.html by the static middleware.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Health check, handy for deployment probes.
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'tecsubstitution',
        port: app.get('activePort') || config.port,
        env: config.env,
        authRequired: config.authRequired,
        authenticated: Boolean(req.session),
        storage: store.usingDatabase ? 'postgres' : 'in-memory'
    });
});

/**
 * Where the timetable is being served from. Lets the dashboard say plainly
 * whether it is on Neon or on the bundled demo dataset, and why.
 */
app.get('/api/storage', (req, res) => {
    res.json({
        backend: store.usingDatabase ? 'postgres' : 'in-memory',
        databaseConfigured: store.databaseConfigured,
        target: store.usingDatabase ? require('./src/db/pool').describeTarget() : null,
        origin: store.origin,
        loadedAt: store.loadedAt,
        editable: store.usingDatabase,
        error: store.databaseError,
        note: store.usingDatabase
            ? 'Timetable data is stored in PostgreSQL.'
            : 'Running on the bundled demo dataset. Set DATABASE_URL to persist changes.'
    });
});

// Authentication is mounted before the guard: signing in must not require
// being signed in already.
app.use('/api/auth', authRoutes);

// Internal service-to-service automation API (Phase B2.3, authenticated via X-Internal-Secret)
app.use('/api/internal/uploads', internalUploadRoutes);

// Faculty Registration Requests API (Phase B7.1)
app.use('/api/faculty-requests', facultyRequestRoutes);

/**
 * Optional sign-in guard. Off by default (AUTH_REQUIRED=false) so the demo
 * dataset stays browsable; when on, API calls answer 401 in JSON and page
 * requests are redirected to /login instead of silently rendering an empty
 * dashboard.
 */
function requireAuth(req, res, next) {
    if (!config.authRequired || req.session) return next();
    // originalUrl, not path: inside a mounted router req.path is relative to
    // the mount point, so "/api/..." would not match.
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Sign in to use this endpoint.', code: 'UNAUTHENTICATED' });
    }
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// Dashboard application.
app.get(['/dashboard', '/app', '/index.html'], requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API. The import router is mounted first so /api/timetable/import is not
// swallowed by the timetable router's own routes.
app.use('/api/timetable/import', requireAuth, importRoutes);
app.use('/api/timetable/entries', requireAuth, entryRoutes);
app.use('/api/timetable', requireAuth, timetableRoutes);
app.use('/api/faculty/timetable', requireAuth, facultyTimetableRoutes);
app.use('/api/faculty', requireAuth, facultyRoutes);
app.use('/api/availability', requireAuth, availabilityRoutes);
app.use('/api/attendance', requireAuth, attendanceRoutes);
app.use('/api/invigilation', requireAuth, invigilationRoutes);
app.use('/api/substitutions', requireAuth, substitutionRoutes);
app.use('/api/uploads', requireAuth, uploadRoutes);
app.use('/api/staging', requireAuth, stagingRoutes);
// Branch / subject / class management. Reads work without a database; writes
// need one, for the same reason timetable entry writes do.
app.use('/api', requireAuth, catalogRoutes);

// Unknown API paths answer in JSON instead of returning the dashboard HTML.
app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

// Uploaded files are private; direct web access is forbidden.
app.use('/uploads', (req, res) => {
    res.status(404).json({ error: 'Direct file access not allowed.', code: 'NOT_FOUND' });
});

// Everything else serves the dashboard, so its in-app views remain linkable.
app.get('*', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Errors (including multer upload limits) are reported as JSON.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    res.status(status).json({
        error: err.message || 'Unexpected server error',
        code: err.code || 'SERVER_ERROR'
    });
});

/**
 * Start listening, falling back to the next configured port when the primary
 * one is already taken — so a stale server from another project cannot block a
 * fresh start, and the terminal always says which port actually came up.
 */
function start(port = config.port, fallbacks = config.fallbackPorts) {
    // Validate configuration (throws fail-fast error in production if required secrets are missing)
    const validation = config.validateConfig();

    const server = app.listen(port);
    const queue = (fallbacks || []).slice();

    server.on('listening', () => {
        const active = server.address().port;
        app.set('activePort', active);
        console.log(`TecSubstitution server running on http://localhost:${active}`);
        if (active !== config.port) {
            console.log(`(port ${config.port} was busy — fell back to ${active})`);
        }
        console.log(config.authRequired
            ? 'Sign-in required: AUTH_REQUIRED=true'
            : 'Sign-in optional: visit /login to sign in, or browse as a guest.');

        // Print any startup configuration warnings
        if (validation && Array.isArray(validation.warnings)) {
            validation.warnings.forEach(w => console.warn(w));
        }
    });

    server.on('error', err => {
        if (err.code !== 'EADDRINUSE') throw err;
        const next = queue.shift();
        if (next == null) {
            console.error(
                `Port ${port} is already in use and no fallback port is free.\n` +
                `  Find the process:  lsof -i :${port}   (or: ss -lptn 'sport = :' ${port})\n` +
                '  Then stop it, or start this project with a different PORT.');
            process.exit(1);
        }
        console.warn(`Port ${port} is in use — trying ${next}…`);
        server.listen(next);
    });

    return server;
}

/**
 * Connect the database (create tables, seed when empty) and then listen. A
 * database failure is reported but never blocks startup: the app falls back to
 * the bundled demo dataset so a demonstration is always possible.
 */
async function bootstrap() {
    const shouldSeed = Boolean(config.dbSeedDemo);
    const result = await store.initFromDatabase({ seed: shouldSeed });
    if (result.enabled) {
        console.log(`Database: connected to ${result.target}` +
            (result.seeded ? ' (demo data seeded)' : ' (schema ready)'));
    } else if (result.error) {
        console.warn(`Database: ${result.error}\n  Falling back to the bundled demo dataset.`);
    } else {
        console.log(`Database: ${result.reason}`);
    }
    return start();
}

if (require.main === module) {
    bootstrap();
}

module.exports = { app, start, bootstrap, config };
