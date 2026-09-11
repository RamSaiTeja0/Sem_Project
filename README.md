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
- **Faculty Directory** — every faculty member with ID, name, branch,
  designation, email, weekly load, and free/busy status at any slot you pick.
  Searchable by name, ID, email or designation, and filterable by branch. The
  dashboard's Total Faculty card opens it.
- **Add Faculty** — register a new faculty member. A duplicate ID, a duplicate
  email, an unknown branch and a malformed address are each rejected with a
  message naming the problem. A new arrival is immediately offered as a
  substitute and gets a sign-in account.
- **Six branches** — CSE, ECE, EEE, CME, MEC and CIVIL, defined once in
  `src/data/departments.js` and shared by the seed, the API and every filter.
- **Add Timetable** — create, edit and delete a scheduled period, choosing a
  branch and then a class. Faculty clashes, room clashes, duplicate slots and
  missing fields are all rejected with a message naming the problem, and valid
  entries are saved to PostgreSQL.
- **Validation Report** — what the validator found in the loaded timetable,
  reached from the dashboard's Conflicts card.
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
│   │   ├── departments.js        the six branches, defined once
│   │   ├── demoTimetable.js      21-faculty demo dataset (generated)
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
│       ├── faculty.js            roster, branches, and adding a faculty member
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

## What in here is real data

Being straight about this matters more than a full-looking demo:

| | Faculty names | Subjects | Timetable | Phone / email |
| --- | --- | --- | --- | --- |
| **CME** | real | real | **real** (CME-A, transcribed from the supplied sheet) | not supplied |
| **EEE** | placeholder | placeholder | placeholder | not supplied |
| **MEC** | placeholder | placeholder | placeholder | not supplied |
| **ECE** (archived) | placeholder | placeholder | placeholder | not supplied |

Only **CME-A** is a real timetable. The other classes are a conflict-free week
generated by `tools/generateDemoTimetable.js` so the branch structure works
before the real data arrives. Each class carries `dataSource` (`real` or
`placeholder`), the API reports it, and any screen showing a placeholder week
says so in a banner. Replace one by uploading the real timetable — nothing else
needs changing.

**No contact details are invented.** No phone number or email address came with
the timetable, so every one is `null` rather than a plausible-looking fake: a
made-up number in a substitution tool is worse than a blank, because somebody
would dial it. Enter real ones through the faculty form and they appear
everywhere.

---

## Branches

The active branches — the ones that are applications people sign in to — are
**CME**, **EEE** and **MEC**.

- **EE** is an older spelling of EEE, not a separate branch. `schema.sql`
  merges any surviving EE records into EEE: where both exist, the faculty,
  subjects and classes are re-pointed at EEE and the empty EE row is removed.
  Faculty names, subject codes and class codes are all UNIQUE, so the merge
  cannot produce a second identity for one person.
- **ECE** is **archived**, not deleted. Every ECE faculty member, class, subject
  and timetable row stays in the database; the branch simply stops being an
  application — it has no accounts, appears in no list, and cannot be reached
  through any API an ordinary caller can make. A coordinator still sees it, and
  a single `UPDATE departments SET active = TRUE WHERE code = 'ECE'` brings it
  back.

Archiving is a data decision, held in `departments.active` (and in the bundled
`src/data/departments.js` when no database is configured) rather than in code.

## Branch isolation

Every branch behaves like its own application. A signed-in CME user sees CME
classes, CME faculty, the CME timetable and CME availability — and is never
shown the name of another branch, let alone its data.

The rule is enforced in **`src/core/branchScope.js`**, which every read and
write route goes through. Three things make it hold:

1. **The branch comes from the signed session, never from the request.**
   `POST /api/availability {"branch":"MEC"}` from a CME account is answered
   `403 BRANCH_FORBIDDEN`, not quietly narrowed to CME. The same applies to
   `?department=`, `?branch=`, `?class=` and to every write path.
2. **There is no branch selector.** The branch list a selector would be built
   from is itself scoped, so `GET /api/branches` returns one branch to a branch
   account. The UI hides the selectors it has and redirects `#branches` to the
   dashboard; the server would refuse the call regardless.
3. **Diagnostics are scoped too.** Validation warnings, the Add Timetable
   reference lists and the room list are free text and shared vocabulary — the
   easiest place for another branch's name to escape. Anything naming a class,
   faculty member or branch outside the caller's own is withheld.

### Cross-branch teaching

A faculty member has a **home branch** (`faculty.department`) and may teach in
another branch. **The timetable entry IS the teaching assignment** — putting an
EEE lecturer on a CME period is what makes them part of CME's pool, and it is
the only way that link is created. A head of section or coordinator may make
such an assignment; a faculty account cannot, since it may only write its own
periods. These are deliberately different things:

- The faculty a branch may see is *its own faculty* ∪ *anyone teaching one of
  its classes*.
- A visitor is presented as belonging to the **viewing** branch, marked
  `crossBranch: true`. Their home branch is withheld, so a CME screen can never
  read "Home Branch: EEE".
- There is exactly **one** faculty record. Cross-branch teaching is never
  solved by copying a person into two branches.

A coordinator (`admin`) is the one role that may look across branches, and must
name the branch explicitly to do so.

---

## Managing a timetable

Two workflows, on the same validated write path.

### A head of section manages their branch's master timetable

```
GET    /api/timetable/entries?class=CME-A   list
POST   /api/timetable/entries               add
PUT    /api/timetable/entries/:id           edit
DELETE /api/timetable/entries/:id           delete
```

The branch comes from the session, so a CME head of section can create, edit and
delete CME entries and nothing else. An entry belonging to another branch reads
back as **404 — absent**, rather than as forbidden-but-present.

### A faculty member manages their own timetable

```
GET    /api/timetable/entries/mine    read it
POST   /api/timetable/entries/mine    upload or replace it
DELETE /api/timetable/entries/mine    clear it
```

```json
{
  "mode": "replace",
  "entries": [
    { "day": "Monday", "period": 1, "class": "CME-A",
      "subject": "Python Programming", "room": "C-401" }
  ]
}
```

**The identity comes from the signed session and nowhere else.** A `faculty`,
`facultyName` or `facultyId` field in the body is ignored outright for a faculty
account: an upload that names a colleague is written to the sender instead, and
`mode: "replace"` only ever clears the sender's own periods. A head of section
or coordinator may name a faculty member — one their branch may schedule — which
is what makes this the endpoint an automated extractor can post to later.

This is the structured-input path. It does no extraction of its own: it takes
already-normalized rows.

### What is checked before anything is written

Day and period are valid; the class exists and belongs to the caller's branch;
the subject exists and belongs to that branch (an unattributed subject such as
Library is allowed anywhere); the room exists; the faculty is someone that
branch may schedule; the slot is free of class, faculty and room conflicts; and
no coordinate appears twice in one upload.

An upload is **all-or-nothing**. One bad row rejects the whole thing, with the
problems listed against the row numbers you sent:

```json
{
  "error": "2 of 12 entries were rejected; nothing was saved.",
  "code": "INVALID_ENTRIES",
  "rejected": [
    { "index": 3, "problems": ["Class \"EEE-A\" does not belong to CME"] },
    { "index": 7, "problems": ["Tuesday P2 appears more than once in this upload (already given as row 5)"] }
  ]
}
```

FREE is not stored. A faculty member with no entry at a slot is free; one with
an entry is busy. There are no FREE records to keep in step.

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

A faculty member carries a profile alongside their schedule:

```json
{ "id": "FAC001", "name": "Dr. Arjun Rao", "department": "CSE",
  "designation": "Professor", "email": "arjun.rao@college.edu",
  "phone": null, "maxWeeklyPeriods": 20, "status": "active" }
```

Every profile field except the name and branch is optional, so a roster loaded
from a spreadsheet — which carries none of them — still produces valid faculty
records with nulls where the source said nothing.

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

| Username | Role | Sees |
| --- | --- | --- |
| `admin` | Timetable coordinator | Every branch |
| `hos.cme`, `hos.ece`, … | Head of section, one per branch | That branch only |
| `arjun.rao`, `priya.sharma`, … | The faculty in the roster | Their own branch only |

The HOS accounts are derived from the roster, not from a hardcoded list, so a
new branch gets its head of section automatically.

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

## The dashboard

Every statistic is computed from live API responses — nothing on the dashboard
is hard-coded. Most cards open the view behind their number:

| Card | Opens |
| --- | --- |
| Total faculty | Faculty Directory |
| Available faculty / Busy faculty | Faculty Availability |
| Total classes / Scheduled periods | Master Timetable |
| Total subjects | Add Timetable (the stored entries) |
| Timetable slots / Tightest slot | Availability Summary |
| Conflicts | Validation Report |

The cards are real `<button>` elements, so they are reachable by keyboard and
announced as actions rather than as static text.

---

## The faculty directory

Reached from the sidebar or from the dashboard's Total Faculty card. Each row
carries the faculty ID, name, branch, designation, email, busy and free period
counts, weekly load, subjects and classes.

Two filters and a search narrow the list: **Department** covers all six
branches with a live count each, and **Search** matches a name, ID, email or
designation. The **Free at** selector adds an availability column showing who
is free or busy at that exact day and period, computed by the same engine the
substitution lookup uses.

### Adding a faculty member

The form above the directory takes an ID, name and branch (all required) plus
an optional designation, email, phone, weekly period cap and status. Validation
happens in two places and reports every problem at once:

| Rejected | Message |
| --- | --- |
| A missing required field | caught by the browser before any request is sent |
| A malformed email | caught by the browser, and again by the server |
| A duplicate faculty ID | `Faculty ID "FAC001" is already in use` |
| A duplicate email | `Email "..." is already in use` |
| An unknown branch | `Unknown department "XYZ". Valid: CSE, ECE, …` |

A saved faculty member is immediately part of the roster: they appear in the
directory and its branch filter, the Total Faculty count updates, they become
selectable when adding a timetable entry, and they are offered as a substitute
at every slot they are free. They also get a sign-in account, exactly as the
seeded faculty do.

Saving needs `DATABASE_URL`, for the same reason timetable edits do. Without it
the form says so and the Save button is disabled; browsing, filtering and
availability all keep working on the demo dataset.

---

## Adding, editing and deleting entries

**Add Timetable** in the sidebar creates a single scheduled period. Pick a
branch to narrow the class list, then the class, day, period, subject, faculty,
room and type, and save. The class's branch, semester, academic year and home
room are shown as you choose it. Existing entries are listed below the form
with Edit and Delete beside each.

**Master Timetable** shows one class's full week, filterable by branch, with
the same academic context line. Every cell stays clickable: clicking one sends
its day and period to the availability engine and shows the selected period,
the available substitutes, the busy faculty with what each is teaching, and the
read-only notice. Nothing is ever assigned automatically.

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
| `GET` | `/api/faculty?day=Monday&period=2` | …plus each member's free/busy status at that slot |
| `POST` | `/api/faculty` | **Add a faculty member** (validated, then saved) |
| `GET` | `/api/faculty/departments` | The six branches, with roster counts |
| `GET` | `/api/faculty/designations` | Designation and status vocabularies |
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

## Production checklist

Two settings are safe defaults for a demo and **must** be set before anyone else
can reach the app. The server warns about both at startup.

- **`SESSION_SECRET`** — signs session cookies, so it is the only thing stopping
  someone forging a sign-in as any account in any branch. Unset, a random key is
  generated per boot: safe, but everyone is signed out on restart. Generate one
  with `openssl rand -hex 32`.
- **`DEMO_PASSWORD`** — every demo account shares it and the default is
  documented in this repository.

Also set `AUTH_REQUIRED=true`, or anonymous visitors browse the data.

---

## Testing

```bash
npm test              # all suites
npm run test:engine   # normalizer, validator, availability engine
npm run test:api      # every endpoint, including Excel and CSV import
npm run test:auth     # sessions, sign-in, and the AUTH_REQUIRED guard
npm run test:db       # schema, migration, seeding, round-trip, entry and faculty CRUD
npm run test:e2e      # click -> API -> engine -> displayed result
npm run test:isolation # branch isolation over HTTP — real unauthorized calls
npm run test:browser  # branch isolation on screen, in a real browser
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

The two isolation suites are the ones that prove branch separation. They do not
inspect the code — they sign in as real accounts and make the calls an attacker
would. `test:isolation` walks every ordered pair of branches and asserts a `403`
for the faculty directory by query string, availability by request **body**
(`POST /api/availability {"branch":"OTHER"}`), subjects, classes and another
branch's class grid, then checks that no diagnostic, reference list or faculty
record names a branch the caller may not see. `test:browser` drives headless
Chromium through each branch's whole application and asserts that no other
branch is named on any screen, that no branch selector exists, and that the
classes, faculty and availability shown are that branch's own. It skips with a
message when no browser is available:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright-core \
CHROMIUM_PATH=/path/to/chrome npm run test:browser
```

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
| `departments` | CSE, ECE, EEE, CME, MEC, CIVIL |
| `rooms` | classrooms and labs, with capacity |
| `faculty` | the roster: ID, name, branch, designation, email, phone, load cap, status |
| `subjects` | theory and lab subjects, each in a department |
| `classes` | CSE-A/B, ECE-A/B, EEE-A, CME-A, MEC-A, CIVIL-A — branch, semester, academic year, home room |
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

### Upgrading an existing database

`schema.sql` is applied on every startup and is safe to re-run: tables use
`CREATE TABLE IF NOT EXISTS`, and columns added after the first release use
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Upgrading a database created by an
earlier version adds the new faculty profile columns and the class academic
year **in place** — no table is dropped and no row is rewritten, so data
already stored survives untouched.

### Demo data

`src/data/demoTimetable.js` holds 21 fictional faculty across all six branches,
8 classes, 34 subjects (theory and lab), 16 classrooms and labs, and a full
Monday–Friday P1–P7 week of 192 scheduled periods.

| Branch | Faculty | Classes | Subjects include |
| --- | --- | --- | --- |
| CSE | 5 | CSE-A, CSE-B | Data Structures, DBMS, Operating Systems, Computer Networks, Web Technologies |
| ECE | 4 | ECE-A, ECE-B | Digital Electronics, Signals and Systems, Microprocessors, Communication Systems |
| EEE | 3 | EEE-A | Power Systems, Electrical Machines, Control Systems |
| CME | 3 | CME-A | Computer Architecture, Programming, Software Engineering |
| MEC | 3 | MEC-A | Engineering Mechanics, Thermodynamics, Manufacturing Technology |
| CIVIL | 3 | CIVIL-A | Structural Engineering, Surveying, Concrete Technology |

Every faculty member has a designation and an `@college.edu` address. The names
and addresses are fictional and exist only for this demonstration — no real
person's details appear anywhere in this project.

It is a **generated file**. `tools/generateDemoTimetable.js` searches for a
schedule that satisfies every constraint and writes the result out as plain
data; the app never runs the generator. To change the demo timetable — a new
branch, another class, a different teaching plan — edit that script and re-run
it:

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
- Workload balancing across faculty, and enforcing the per-faculty period cap
  (`maxWeeklyPeriods` is stored and displayed, but nothing rejects an entry for
  exceeding it yet)
- Notifications by email or messaging
- Editing and deactivating a faculty member from the UI (the directory adds and
  lists; changing a record is a database operation for now)
- Attendance integration (marks still live in the browser)

---

## Licence

MIT
