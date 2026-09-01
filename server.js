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
const timetableRoutes = require('./src/routes/timetable');
const facultyRoutes = require('./src/routes/faculty');
const availabilityRoutes = require('./src/routes/availability');
const importRoutes = require('./src/routes/import');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Static assets. `index: false` so "/" is routed explicitly to the landing
// page rather than being served index.html by the static middleware.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Landing page.
app.get(['/', '/home', '/home.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Dashboard application.
app.get(['/dashboard', '/app', '/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check, handy for deployment probes.
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'tecsubstitution', port: config.port, env: config.env });
});

// API. The import router is mounted first so /api/timetable/import is not
// swallowed by the timetable router's own routes.
app.use('/api/timetable/import', importRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/faculty', facultyRoutes);
app.use('/api/availability', availabilityRoutes);

// Unknown API paths answer in JSON instead of returning the dashboard HTML.
app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

// Everything else serves the dashboard, so its in-app views remain linkable.
app.get('*', (req, res) => {
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

function start(port = config.port) {
    return app.listen(port, () => {
        console.log(`TecSubstitution running on http://localhost:${port}`);
    });
}

if (require.main === module) {
    start();
}

module.exports = { app, start, config };
