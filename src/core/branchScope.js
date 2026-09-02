/**
 * Branch scope — the single authority on which branch a request may see.
 *
 * Every branch behaves like its own application. The branch comes from the
 * SIGNED SESSION, never from a query string or a request body: a CME user who
 * sends ?branch=EEE still gets CME, and asking for another branch by name is
 * refused rather than quietly answered.
 *
 * Two different things are deliberately kept apart:
 *
 *   HOME BRANCH      faculty.department — where the person belongs.
 *   TEACHING BRANCH  the branch of a class they actually teach.
 *
 * One faculty identity can teach in more than one branch. An EEE lecturer who
 * teaches a CME subject appears inside the CME application, because CME needs
 * to see and schedule them — but CME is never told their home branch is EEE,
 * and it gains no access to EEE data. There is exactly one faculty record; the
 * person is never duplicated per branch.
 */

const store = require('../data/store');
const departments = require('../data/departments');

/** Roles that may look across branches. Everyone else is pinned to their own. */
const CROSS_BRANCH_ROLES = new Set(['coordinator']);

function code(value) {
    // Resolve an older spelling to the branch it actually names, so "EE" and
    // "EEE" can never behave as two branches anywhere in the application.
    return departments.canonical(value);
}

/**
 * The branches that are applications right now.
 *
 * Read live from whichever backing is serving — the database's
 * departments.active column, or the bundled list — so archiving a branch is a
 * data decision, not a code change. Falls back to the bundled active set when
 * the source carries no flags at all.
 */
function activeBranches() {
    const declared = (store.source && store.source.departments) || [];
    const flagged = declared.filter(entry => typeof entry.active === 'boolean');

    const codes = flagged.length
        ? flagged.filter(entry => entry.active).map(entry => code(entry.code))
        : departments.activeCodes().map(code);

    return new Set(codes.filter(Boolean));
}

/** Is this branch an application someone may sign in to? */
function isActiveBranch(branch) {
    const wanted = code(branch);
    if (!wanted) return false;
    const active = activeBranches();
    // A branch created at runtime is not in the bundled list; only an explicit
    // archival makes a branch inactive, so an unknown code stays usable.
    const declared = (store.source && store.source.departments) || [];
    const known = declared.some(entry => code(entry.code) === wanted) ||
        departments.find(wanted) !== null;
    return known ? active.has(wanted) : true;
}

/**
 * The branch a class belongs to.
 * Uses the class's declared department when the source carries one, and falls
 * back to the "BRANCH-SECTION" naming convention (CME-A -> CME) otherwise.
 */
function branchOfClass(className) {
    const name = String(className == null ? '' : className).trim();
    if (!name) return null;

    const declared = (store.source && store.source.classes) || [];
    const match = declared.find(entry => (entry.class || entry.name) === name);
    if (match && match.department) return code(match.department);

    const dash = name.indexOf('-');
    return code(dash > 0 ? name.slice(0, dash) : name);
}

/** Every class belonging to a branch. */
function classesOf(branch) {
    const wanted = code(branch);
    return store.engine.getMeta().classes.filter(name => branchOfClass(name) === wanted);
}

/** May this scope see anything belonging to this branch? */
function allows(scope, branch) {
    const wanted = code(branch);
    if (!wanted) return true;                       // unattributed data
    if (scope && scope.branch) return wanted === scope.branch;
    if (scope && scope.includeArchived) return true;
    return isActiveBranch(wanted);
}

/**
 * The classes a scope may see: its own branch's when it has one, otherwise
 * every ACTIVE branch's. An archived branch's classes are visible only to a
 * coordinator, so no ordinary screen can reach them.
 */
function visibleClasses(scope) {
    if (scope && scope.branch) return classesOf(scope.branch);
    return store.engine.getMeta().classes.filter(name => allows(scope, branchOfClass(name)));
}

/** The faculty a scope may see, by name. */
function visibleFacultyNames(scope) {
    if (scope && scope.branch) return facultyPoolOf(scope.branch);

    const names = new Set();
    store.engine.getFaculty().forEach(member => {
        if (allows(scope, member.department)) names.add(member.name);
    });
    // Anyone teaching a class this scope can see is relevant to it, whatever
    // their home branch — that is what makes cross-branch teaching work.
    store.engine.getRecords().forEach(record => {
        if (record.status === 'busy' && record.faculty &&
            allows(scope, branchOfClass(record.className))) {
            names.add(record.faculty);
        }
    });
    return names;
}

/**
 * The faculty a branch may see: those whose HOME branch it is, plus those who
 * TEACH one of its classes. The union is what makes cross-branch teaching work
 * without duplicating a faculty record.
 */
function facultyPoolOf(branch) {
    const wanted = code(branch);
    const engine = store.engine;

    const names = new Set();
    engine.getFaculty().forEach(member => {
        if (code(member.department) === wanted) names.add(member.name);
    });
    engine.getRecords().forEach(record => {
        if (record.status === 'busy' && branchOfClass(record.className) === wanted) {
            names.add(record.faculty);
        }
    });
    return names;
}

/** True when this faculty is visible to this branch at all. */
function facultyInBranch(facultyName, branch) {
    return facultyPoolOf(branch).has(facultyName);
}

/**
 * Present a faculty record to a viewing branch.
 *
 * A visitor from another branch is shown as belonging to the VIEWING branch —
 * that is the only relationship this branch has with them. Their real home
 * branch is withheld, so a CME screen can never reveal "Home Branch: EEE".
 * `crossBranch: true` marks the visitor without naming where they came from.
 */
function projectFaculty(member, branch) {
    // With no viewing branch there is nothing to project onto: a coordinator
    // sees each person's real home branch.
    if (!member || !branch) return member;

    // A record that carries no home branch — a timetable entry, say — discloses
    // nothing, so there is nothing to hide and nothing to relabel. Marking it
    // `crossBranch` would be a plain falsehood about the branch's own staff.
    if (member.department == null) return member;

    const wanted = code(branch);
    const isHome = code(member.department) === wanted;

    const projected = { ...member, department: isHome ? member.department : wanted };
    if (!isHome) {
        projected.crossBranch = true;
        // Never leak the home branch of a visiting lecturer.
        delete projected.homeBranch;

        // A roster record also lists what they teach and where. Left whole,
        // those name the home branch just as plainly as the branch code does
        // ("classes: EEE-A"), so they are trimmed to this branch's own work.
        // The busy/free counts stay whole on purpose: a visitor teaching
        // elsewhere really is unavailable, and availability must say so.
        if (Array.isArray(projected.classes) || Array.isArray(projected.subjects)) {
            const mine = new Set(classesOf(wanted));
            if (Array.isArray(projected.classes)) {
                projected.classes = projected.classes.filter(name => mine.has(name));
            }
            if (Array.isArray(projected.subjects)) {
                const here = new Set(store.engine.getRecords()
                    .filter(r => r.faculty === member.name && mine.has(r.className))
                    .map(r => r.subject));
                projected.subjects = projected.subjects.filter(name => here.has(name));
            }
        }
    }
    return projected;
}

function projectFacultyList(members, branch) {
    return (members || []).map(member => projectFaculty(member, branch));
}

/**
 * Keep only the diagnostics a branch is entitled to read.
 *
 * Validation warnings are free text written about the whole loaded dataset, so
 * one of them can name another branch's class, faculty or code — "Primary class
 * CME-A has no entry for Friday P1" on an ECE screen. Rather than trying to
 * rewrite them, a warning that names anything outside this branch is withheld.
 */
function filterWarnings(warnings, branch) {
    if (!branch) return warnings || [];
    const wanted = code(branch);

    const mine = new Set(classesOf(wanted));
    const pool = facultyPoolOf(wanted);

    const foreign = [];
    store.engine.getMeta().classes.forEach(name => { if (!mine.has(name)) foreign.push(name); });
    store.engine.getFaculty().forEach(member => {
        if (!pool.has(member.name)) foreign.push(member.name);
        const home = code(member.department);
        if (home && home !== wanted && foreign.indexOf(home) < 0) foreign.push(home);
    });

    return (warnings || []).filter(warning => {
        // A warning is an object with a message and context, so the whole
        // record is searched rather than just its message.
        let text;
        try {
            text = typeof warning === 'string' ? warning : JSON.stringify(warning);
        } catch (err) {
            text = String(warning);
        }
        return !foreign.some(token => token && text.includes(token));
    });
}

/**
 * Resolve the branch this request is allowed to act on.
 *
 * @returns {{branch: string|null, crossBranch: boolean}} on success,
 *          or {{error, code, status}} when the caller asked for another branch.
 */
function resolve(req, requested) {
    const session = req.session || null;
    const role = session ? String(session.role || '').toLowerCase() : null;
    const sessionBranch = session ? code(session.department) : null;
    const asked = requested ? code(requested) : null;

    // A coordinator administers every branch, archived ones included: they are
    // the only role that can un-archive one, so it must stay reachable to them.
    if (role && CROSS_BRANCH_ROLES.has(role)) {
        return { branch: asked || null, crossBranch: true, includeArchived: true, role };
    }

    // An account whose branch has been archived has no application to enter.
    // Said plainly rather than served an empty one that looks broken.
    if (sessionBranch && !isActiveBranch(sessionBranch)) {
        return {
            error: `The ${sessionBranch} branch is archived and is no longer an active application.`,
            code: 'BRANCH_ARCHIVED',
            status: 403
        };
    }

    // Nobody else may name an archived branch, whatever their own branch is.
    if (asked && !isActiveBranch(asked)) {
        return {
            error: `The ${asked} branch is archived and is no longer an active application.`,
            code: 'BRANCH_ARCHIVED',
            status: 403
        };
    }

    // Anyone else is pinned to their own branch. An explicit request for a
    // different one is refused outright rather than silently narrowed, so the
    // attempt is visible instead of looking like an empty result.
    if (asked && sessionBranch && asked !== sessionBranch) {
        return {
            error: `This account belongs to ${sessionBranch}. It cannot access ${asked} data.`,
            code: 'BRANCH_FORBIDDEN',
            status: 403
        };
    }

    if (!sessionBranch) {
        // No signed-in branch (sign-in optional in demo mode): unscoped across
        // the ACTIVE branches, but never across an archived one.
        return { branch: asked || null, crossBranch: true, includeArchived: false, role: role || null };
    }

    return { branch: sessionBranch, crossBranch: false, includeArchived: false, role };
}

/**
 * Express guard. Puts `req.branchScope` on the request and answers 403 when the
 * caller asked for a branch that is not theirs.
 *
 * `pick` says where a requested branch may appear, so a route can accept
 * ?branch=… from a coordinator while still refusing it from everyone else.
 */
function guard(pick) {
    return function branchGuard(req, res, next) {
        const requested = typeof pick === 'function' ? pick(req) : null;
        const scope = resolve(req, requested);
        if (scope.error) {
            return res.status(scope.status).json({ error: scope.error, code: scope.code });
        }
        req.branchScope = scope;
        next();
    };
}

module.exports = {
    resolve,
    guard,
    activeBranches,
    isActiveBranch,
    allows,
    visibleClasses,
    visibleFacultyNames,
    branchOfClass,
    classesOf,
    facultyPoolOf,
    facultyInBranch,
    projectFaculty,
    projectFacultyList,
    filterWarnings,
    code,
    CROSS_BRANCH_ROLES
};
