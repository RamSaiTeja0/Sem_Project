# TecSubstitution — Faculty Substitution / Availability Finder

A web application that answers one question quickly and reliably:

> **A faculty member is absent. Who else is free during their class period?**

Click a period in the timetable and the system lists every faculty member who
is free at that exact day and period. It does **not** assign anyone, does
**not** save a selection, and does **not** modify any timetable. The result is
displayed for the person checking, and nothing else.

---

## Purpose

When a faculty member is away, the HOD or a colleague needs to know who can
cover each of that day's periods. Doing this by hand means cross-reading nine
or ten timetables. TecSubstitution normalizes every timetable into one internal
representation and answers the question in a single click.

Assignment, eligibility checking and workload balancing are deliberately out of
scope — see [Future enhancements](#future-enhancements).

---

## Features

- **Primary timetable** — a weekly grid where every cell is clickable and
  carries its own day, period, subject, faculty, class and room.
- **Availability engine** — given a day and period, returns every faculty
  member who is free, checked against all loaded timetables.
- **Read-only by construction** — no assign button, no save, no database write
  in the availability path.
- **Excel import (.xlsx)** — the primary structured input. Upload, preview,
  validate, then confirm.
- **CSV import** — the same normalization pipeline, same result.
- **Faculty management** — roster with busy/free period counts per faculty.
- **Availability summary** — free faculty for every slot across the week.
- **Filters** — by day, period, department and faculty name.
- **Validation** — invalid days, invalid periods, duplicate entries,
  double-bookings, malformed spreadsheets and empty timetables are all reported
  with clear messages rather than silently accepted.
- **Quick Paste** — paste rows straight from a printed sheet or an email;
  tabs, commas and semicolons are all accepted and run through the *same*
  importer, normalizer and validator as an uploaded file.
- **Department presets** — starter layouts you can edit before processing.
- **My Schedule** — one faculty member's own week, defaulting to whoever is
  signed in, with one click from any of their periods to who could cover it.
- **Attendance Track** — mark each scheduled period held / not held /
  substituted. The server has no attendance store, so these marks live in the
  browser (`localStorage`) and the view says so plainly.
- **Sign-in** — signed cookie sessions with a demo account directory. Optional
  by default; set `AUTH_REQUIRED=true` to turn anonymous visitors away.

---

## Architecture

```
Excel / CSV / demo data
        ↓
   normalizer          src/core/normalizer.js     one record per faculty·day·period
        ↓
   validator           src/core/validator.js      errors block, warnings inform
        ↓
   store               src/data/store.js          the swappable storage seam
        ↓
   availability engine src/core/availabilityEngine.js   pure, no framework
        ↓
   REST API            src/routes/*.js
        ↓
   dashboard           public/
```

Each layer depends only on the one above it. The availability engine takes
plain objects and has no Express, DOM or database dependency, so it can be
tested directly and reused unchanged if the storage or transport changes.

### Folder structure

```
.
├── server.js                     Express app and route wiring
├── src/
│   ├── config.js                 environment-driven configuration
│   ├── core/
│   │   ├── normalizer.js         source data -> normalized records
│   │   ├── validator.js          errors and warnings
│   │   ├── session.js            signed-cookie sessions (no dependency)
│   │   └── availabilityEngine.js the availability query engine
│   ├── data/
│   │   ├── demoTimetable.js      10-faculty demo dataset
│   │   ├── users.js              demo account directory (faculty-derived)
│   │   └── store.js              in-memory store (replaceable)
│   ├── importers/
│   │   ├── tableParser.js        shared matrix/long-form parser
│   │   ├── excelImporter.js      .xlsx via exceljs
│   │   ├── csvImporter.js        RFC4180 CSV
│   │   └── index.js              preview / commit orchestration
│   └── routes/
│       ├── timetable.js          grids, metadata, records
│       ├── faculty.js            roster and load
│       ├── availability.js       the read-only availability API
│       ├── import.js             upload endpoints
│       └── auth.js               sign-in, sign-out, session
├── public/
│   ├── home.html                 landing page
│   ├── login.html                sign-in page
│   ├── index.html                dashboard shell
│   ├── css/                      theme tokens + per-page styles
│   └── js/                       home.js, login.js, app.js (vanilla)
└── tests/                        engine, API, auth and end-to-end suites
```

---

## Data model

Everything reduces to one record shape:

```json
{ "faculty": "Dr. Anand Rao", "day": "Monday", "period": 1,
  "subject": "DBMS", "className": "CSE-A", "room": "A-101", "status": "busy" }
```

A free slot carries the same shape with nulls:

```json
{ "faculty": "Dr. Anand Rao", "day": "Monday", "period": 2,
  "subject": null, "className": null, "room": null, "status": "free" }
```

A record exists for every faculty × day × period combination, so availability
is a direct lookup rather than a scan across timetables. Multi-period labs
become one record per period, keeping each coordinate individually addressable.

---

## Installation

```bash
git clone https://github.com/RamSaiTeja0/Sem_Project.git
cd Sem_Project
npm install
cp .env.example .env      # optional; defaults work as-is
```

Requires Node.js 18 or newer.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Port the server listens on |
| `FALLBACK_PORTS` | `3002,3003,3004` | Tried in order if `PORT` is already in use |
| `NODE_ENV` | `development` | Node environment |
| `MAX_UPLOAD_MB` | `10` | Maximum timetable upload size |
| `AUTH_REQUIRED` | `false` | `true` turns anonymous visitors away |
| `SESSION_SECRET` | dev default | HMAC key for session cookies — set this in production |
| `SESSION_HOURS` | `12` | Session lifetime |
| `DEMO_PASSWORD` | `tecsub123` | Password shared by every demo account |

`.env` is git-ignored. Never commit it — copy `.env.example` instead.

## How to run

```bash
npm start           # http://localhost:3001
npm run dev         # same, with auto-restart on file changes
```

The terminal prints the port it actually came up on:

```
TecSubstitution server running on http://localhost:3001
Sign-in optional: visit /login to sign in, or browse as a guest.
```

If port 3001 is already taken, the server says so and moves to the next port in
`FALLBACK_PORTS` rather than dying — the log then reads
`(port 3001 was busy — fell back to 3002)`. To reclaim 3001 instead, find and
stop the process holding it (`lsof -i :3001`).

Open **http://localhost:3001** for the landing page, or go straight to
**/dashboard**, which loads with the demo timetable.

### Signing in

Sign-in is optional by default, so the demo dataset stays browsable. Visit
**/login** to sign in as:

| Username | Role |
| --- | --- |
| `admin` | Timetable coordinator |
| `anand.rao`, `meera.nair`, … | The faculty in the roster |

Every demo account uses `DEMO_PASSWORD` (default `tecsub123`). This is a college
project: accounts are derived from the faculty roster and there is no password
database — `src/data/users.js` is the seam where a real one would go. Set
`AUTH_REQUIRED=true` and anonymous API calls get a `401` while page requests
redirect to `/login`.

---

## How to import a timetable

Two layouts are accepted, and both are detected automatically.

**Matrix (recommended)** — one row per faculty, one column per slot:

| Faculty | Department | Monday P1 | Monday P2 | Tuesday P1 |
| --- | --- | --- | --- | --- |
| Dr. Anand Rao | CSE | DBMS | FREE | OS |
| Dr. Meera Nair | CSE | FREE | OS | CN |

**Long form** — one row per scheduled period:

| Faculty | Day | Period | Subject | Class | Room |
| --- | --- | --- | --- | --- | --- |
| Dr. Anand Rao | Monday | 1 | DBMS | CSE-A | A-101 |

A cell reading `FREE`, `-`, or left blank means the faculty is not teaching
then. Days accept `Monday` or `Mon`; periods accept `P1` or `1`.

Steps in the app: **Timetable Import → choose file → Preview → review the
validation report and preview table → Load this timetable.** Nothing changes
until you confirm, and a failed import leaves the current timetable in place.

---

## API documentation

All responses are JSON.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service status |
| `GET` | `/api/timetable` | Primary class grid |
| `GET` | `/api/timetable?class=CSE-B` | Another class grid |
| `GET` | `/api/timetable?faculty=Dr.%20Anand%20Rao` | One faculty's week |
| `GET` | `/api/timetable/meta` | Days, periods, classes, timings |
| `GET` | `/api/timetable/records` | Normalized records (`day`, `period`, `faculty`, `status` filters) |
| `GET` | `/api/faculty` | Roster with busy/free counts (`department`, `search` filters) |
| `GET` | `/api/faculty/departments` | Distinct departments |
| `POST` | `/api/availability` | **Free faculty for a slot** |
| `GET` | `/api/availability` | Same query over GET |
| `GET` | `/api/availability/summary` | Totals for the dashboard |
| `GET` | `/api/timetable/import/formats` | Supported formats and layouts |
| `POST` | `/api/timetable/import/preview` | Validate an upload, change nothing |
| `POST` | `/api/timetable/import` | Load an upload |
| `GET` | `/api/auth/session` | Who is signed in, and whether sign-in is enforced |
| `GET` | `/api/auth/accounts` | The demo account directory (never passwords) |
| `POST` | `/api/auth/login` | Start a session |
| `POST` | `/api/auth/logout` | End a session |

### The core call

```bash
curl -X POST http://localhost:3001/api/availability \
  -H 'Content-Type: application/json' \
  -d '{"day":"Monday","period":2}'
```

```json
{
  "day": "Monday",
  "period": 2,
  "subject": null,
  "availableFaculty": [
    "Dr. Anand Rao", "Prof. Kiran Kumar", "Prof. Priya Sharma",
    "Dr. Suresh Babu", "Prof. Arun Prasad", "Dr. Deepa Iyer",
    "Dr. Latha Menon", "Mr. Sai Kishore"
  ],
  "totalAvailable": 8,
  "totalBusy": 2,
  "readOnly": true
}
```

Optional fields: `subject`, `class` and `faculty` give context from the clicked
cell (`faculty` also excludes that person from the result); `department` and
`search` filter the list. **Only `day` and `period` drive the lookup** — the
other fields are never trusted as the source of truth.

Errors return HTTP 400 with a code:

```json
{ "error": "Unknown or missing day \"Funday\". Valid days: Monday, …", "code": "INVALID_DAY" }
```

---

## How availability is calculated

1. Every source is normalized into `{ faculty, day, period, subject, status }`
   records, one per faculty × day × period.
2. Records are indexed by `day|period`.
3. A request for a day and period reads that index: faculty whose record says
   `busy` are teaching; everyone else is `free`.
4. If the request names the absent faculty, they are removed from the result —
   you are looking for cover, not for them.
5. Optional department and name filters narrow the list.

A faculty is free only when **no** record marks them busy at that slot, so a
faculty teaching another class at the same time is correctly excluded.

Nothing in this path writes. The engine exposes no `assign`, `save` or `update`
operation, and the tests assert that.

---

## Testing

```bash
npm test              # all suites
npm run test:engine   # normalizer, validator, availability engine
npm run test:api      # every endpoint, including Excel and CSV import
npm run test:auth     # sessions, sign-in, and the AUTH_REQUIRED guard
npm run test:e2e      # click -> API -> engine -> displayed result
```

The end-to-end suite runs in headless Chromium when Playwright is installed and
falls back to exercising the same path over HTTP when it is not — it reports
which mode it used rather than skipping silently. It finds a browser via
`CHROMIUM_PATH`, then `PLAYWRIGHT_BROWSERS_PATH`, then Playwright's own build.

The auth suite starts two servers, one in each configuration, so the
`AUTH_REQUIRED` guard is proved to actually turn anonymous callers away rather
than being taken on trust.

Coverage includes Monday P2 and Tuesday P1 availability, busy-faculty
exclusion, free-faculty detection, invalid days and periods, empty timetables,
duplicate records, Excel and CSV import, Quick Paste and department presets,
API response shapes, sign-in and session handling, and an assertion that a full
sweep of availability calls mutates nothing.

---

## Database

The current version keeps the normalized timetable in memory, seeded from
`src/data/demoTimetable.js` and replaceable by an import at runtime. This is
deliberate: the core workflow matters more than storage infrastructure.

`src/data/store.js` is the seam. To move to PostgreSQL/Neon, replace its
`loadSource()` with a query returning the same source shape. The normalizer,
validator, availability engine, API and dashboard are unaffected.

Note that imports are in-memory: a restart returns to the demo dataset.

---

## Future enhancements

Structured for, but deliberately not implementing:

- OCR / image timetable extraction (Excel and CSV remain the reliable path)
- Automatic substitution assignment and persistence
- Subject eligibility and "can teach this subject" checking
- Workload balancing across faculty
- Notifications by email or messaging
- Timetable conflict detection across departments
- Attendance integration
- PostgreSQL/Neon persistence

---

## Licence

MIT
