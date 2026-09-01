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
- **Add Timetable** — create, edit and delete a scheduled period from the
  dashboard. Faculty clashes, room clashes, duplicate slots and missing fields
  are all rejected with a message naming the problem, and valid entries are
  saved to PostgreSQL.
- **PostgreSQL / Neon storage** — optional. Set `DATABASE_URL` and the
  timetable is stored, with tables created and demo data seeded automatically.
  Without it the app runs on the bundled demo dataset exactly as before.
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
│   │   ├── demoTimetable.js      12-faculty demo dataset (generated)
│   │   ├── users.js              demo account directory (faculty-derived)
│   │   └── store.js              store: PostgreSQL, or in-memory fallback
│   ├── db/
│   │   ├── schema.sql            tables, keys and no-double-booking constraints
│   │   ├── pool.js               Neon connection pool (optional)
│   │   ├── repository.js         every SQL statement; entry CRUD
│   │   └── seed.js               create tables, seed demo data when empty
│   ├── importers/
│   │   ├── tableParser.js        shared matrix/long-form parser
│   │   ├── excelImporter.js      .xlsx via exceljs
│   │   ├── csvImporter.js        RFC4180 CSV
│   │   └── index.js              preview / commit orchestration
│   └── routes/
│       ├── timetable.js          grids, metadata, records
│       ├── entries.js            add / edit / delete a timetable entry
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
├── scripts/
│   └── setupDatabase.js          npm run db:setup
├── tools/
│   └── generateDemoTimetable.js  regenerates the demo dataset
└── tests/                        engine, API, auth, database and e2e suites
```

---

## Data model

Everything reduces to one record shape:

```json
{ "faculty": "Dr. Arjun Rao", "day": "Monday", "period": 1,
  "subject": "Data Structures", "className": "CSE-A", "room": "A-101",
  "type": "theory", "status": "busy" }
```

A free slot carries the same shape with nulls:

```json
{ "faculty": "Dr. Arjun Rao", "day": "Monday", "period": 2,
  "subject": null, "className": null, "room": null,
  "type": null, "status": "free" }
```

`type` is `theory` or `lab`. A source may state it per entry; when it does not,
it is inferred from the subject name, so timetables written before this field
existed keep working unchanged.

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
| `DATABASE_URL` | _(unset)_ | Neon/PostgreSQL connection string. Unset = in-memory demo data |
| `DB_POOL_MAX` | `5` | Connection pool size |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | Connection timeout |
| `DB_AUTO_SEED` | `true` | Seed demo data at startup when the timetable is empty |

`.env` is git-ignored. Never commit it — copy `.env.example` instead.

`DATABASE_URL` contains a password. Keep it out of commits, screenshots and
chat logs; if one leaks, reset it in the Neon console. The application never
logs the connection string — diagnostics print only the host and database
name.

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
| `arjun.rao`, `priya.sharma`, … | The faculty in the roster |

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
| Dr. Arjun Rao | CSE | Data Structures | FREE | Data Structures |
| Dr. Priya Sharma | CSE | FREE | DBMS | DBMS |

**Long form** — one row per scheduled period:

| Faculty | Day | Period | Subject | Class | Room |
| --- | --- | --- | --- | --- | --- |
| Dr. Arjun Rao | Monday | 1 | Data Structures | CSE-A | A-101 |

A cell reading `FREE`, `-`, or left blank means the faculty is not teaching
then. Days accept `Monday` or `Mon`; periods accept `P1` or `1`.

Steps in the app: **Timetable Import → choose file → Preview → review the
validation report and preview table → Load this timetable.** Nothing changes
until you confirm, and a failed import leaves the current timetable in place.

PDF and image uploads are **not** extracted: there is no OCR in this project.
The upload view accepts those extensions only so it can say so plainly and
point you at Quick Paste, rather than failing with an unexplained error.

---

## Adding, editing and deleting entries

**Add Timetable** in the sidebar creates a single scheduled period. Pick the
class, day, period, subject, faculty, room and type, then save. Existing
entries are listed below the form with Edit and Delete beside each.

Every save is checked before it is written, and all problems are reported at
once rather than one at a time:

| Rejected | Message |
| --- | --- |
| The class already has a period there | `CSE-A already has Operating Systems at Monday P2` |
| The faculty is teaching elsewhere then | `Dr. Priya Sharma already teaches DBMS (CSE-B) at Monday P2` |
| The room is already in use | `Room A-101 is already used by CSE-A at Monday P2` |
| A missing or invalid field | `Day is missing or invalid. Valid days: Monday, …` |
| An unknown class, subject, faculty or room | `Unknown subject "Astral Projection"` |

Saving needs `DATABASE_URL`. Without it the form explains that entries cannot
be persisted and the Save button is disabled — an edit that vanished on the
next restart would be worse than refusing it. Everything else on the page keeps
working on the demo dataset.

A deletion asks for confirmation and removes only that one entry. Imports are
unchanged: they still replace the live dataset only after an explicit confirm.

---

## API documentation

All responses are JSON.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service status |
| `GET` | `/api/timetable` | Primary class grid |
| `GET` | `/api/timetable?class=CSE-B` | Another class grid |
| `GET` | `/api/timetable?faculty=Dr.%20Arjun%20Rao` | One faculty's week |
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
| `GET` | `/api/storage` | Whether the timetable is served from PostgreSQL or memory |
| `GET` | `/api/timetable/entries` | Stored entries (`class`, `day`, `period`, `faculty` filters) |
| `GET` | `/api/timetable/entries/reference` | Options for the Add Timetable form |
| `POST` | `/api/timetable/entries` | **Add an entry** (validated, then saved) |
| `PUT` | `/api/timetable/entries/:id` | **Edit an entry** |
| `DELETE` | `/api/timetable/entries/:id` | **Delete an entry** |
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
    "Dr. Arjun Rao", "Dr. Ananya Iyer", "Prof. Sneha Nair",
    "Dr. Vikram Kumar", "Prof. Meera Joshi", "Prof. Naveen Reddy",
    "Dr. Kavya Rao", "Dr. Anitha Menon"
  ],
  "totalAvailable": 8,
  "totalBusy": 4,
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
npm run test:db       # schema, seeding, round-trip and entry CRUD
npm run test:e2e      # click -> API -> engine -> displayed result
```

The database suite needs a scratch PostgreSQL database and **writes to it**:

```bash
TEST_DATABASE_URL=postgresql://user:pass@host/scratch_db npm run test:db
```

With no connection string it skips itself rather than failing, so `npm test`
stays green on a machine without a database — the application is designed to
run without one. Point it at a scratch database, never one holding real data.

The end-to-end suite runs in headless Chromium when Playwright is installed and
falls back to exercising the same path over HTTP when it is not — it reports
which mode it used rather than skipping silently. It finds a browser via
`CHROMIUM_PATH`, then `PLAYWRIGHT_BROWSERS_PATH`, then Playwright's own build.

The auth suite starts two servers, one in each configuration, so the
`AUTH_REQUIRED` guard is proved to actually turn anonymous callers away rather
than being taken on trust.

Coverage includes Monday P2 and Tuesday P1 availability, busy-faculty
exclusion, free-faculty detection, invalid days and periods, empty timetables,
duplicate records, faculty and room double-booking, Excel and CSV import, Quick
Paste and department presets, API response shapes, sign-in and session
handling, and an assertion that a full sweep of availability calls mutates
nothing.

The database suite additionally covers schema creation, idempotent seeding (no
duplicate demo records on a second run), an exact round trip from the demo
dataset through PostgreSQL and back, rejection of a double-booked slot by the
schema itself, and every add / edit / delete path including each conflict
case.

---

## Database

The timetable can be stored in **PostgreSQL (Neon)**, or held in memory. Both
paths produce the same source shape, so the normalizer, validator, availability
engine, API and dashboard behave identically either way — `src/data/store.js`
is the seam that makes that true.

| | `DATABASE_URL` set | `DATABASE_URL` unset |
| --- | --- | --- |
| Timetable data | PostgreSQL | bundled demo dataset |
| Add / edit / delete entries | yes, persisted | refused with an explanation |
| Everything else | works | works |

The in-memory fallback is never removed. If the database is unreachable at
startup the server still comes up on the demo dataset and says so, rather than
failing to boot.

### Setting it up

1. Create a project at [neon.tech](https://neon.tech) and copy the connection
   string from the dashboard.
2. `cp .env.example .env` and set `DATABASE_URL` to that string.
3. `npm run db:setup`

`db:setup` creates the tables and inserts the demo data. It is safe to run
repeatedly: tables are created only if absent, and the demo rows are inserted
only when the timetable is empty. The server performs the same steps
automatically at startup.

### Tables

| Table | Holds |
| --- | --- |
| `departments` | CSE, ECE |
| `rooms` | classrooms and labs, with capacity |
| `faculty` | the roster, each in a department |
| `subjects` | theory and lab subjects, each in a department |
| `classes` | CSE-A/B/C, ECE-A/B, each with a home room |
| `periods` | period numbers and their start/end times |
| `timetable` | one row per class + day + period |
| `users` | sign-in accounts (the coordinator plus one per faculty) |
| `substitutions` | a recorded substitution — never written by the availability lookup |
| `attendance` | held / not held / substituted, per entry per date |

Primary keys are on every table and foreign keys tie the timetable to its
class, subject, faculty and room. The two rules the application enforces are
also enforced by the schema itself:

```sql
CONSTRAINT timetable_class_slot_unique   UNIQUE (class_id, day_of_week, period)
CONSTRAINT timetable_faculty_slot_unique UNIQUE (faculty_id, day_of_week, period)
CREATE UNIQUE INDEX timetable_room_slot_unique ON timetable (room_id, day_of_week, period)
    WHERE room_id IS NOT NULL;
```

so a double-booked faculty member or room is rejected by PostgreSQL even if
something other than this application tries to insert one.

### Demo data

`src/data/demoTimetable.js` holds 12 fictional faculty across CSE and ECE, 5
classes, 22 subjects (theory and lab), 10 rooms, and a full Monday–Friday
P1–P7 week of 152 scheduled periods.

It is a **generated file**. `tools/generateDemoTimetable.js` searches for a
schedule that satisfies every constraint and writes the result out as plain
data; the app never runs the generator. To change the demo timetable, edit the
teaching plan in that script and re-run it:

```bash
node tools/generateDemoTimetable.js
```

The generator is what guarantees the properties the demonstration depends on:
no faculty member is ever in two classes at once, no room hosts two classes at
once, and every faculty member has both busy and free periods — so the
substitution lookup always has something to show.

All names are fictional and exist only for this demonstration.

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
