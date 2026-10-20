/**
 * Reusable Subject Display Name Resolver & Formatter
 *
 * Resolves short abbreviations and legacy shorthand subject names (e.g., "PP", "DS",
 * "DS Lab", "EEE COCS Lab") into authoritative full subject names (e.g., "Python Programming",
 * "Data Structures", "Data Structures Lab", "Communications Skills Laboratory") using the
 * institutional subject catalog and standard academic alias definitions.
 *
 * Guarantees:
 * 1. Safe display formatting — does NOT mutate or update underlying database records or timetable assignments.
 * 2. Reliable mapping — does NOT guess or invent names. Preserves original display when unmapped.
 * 3. Handles both theory and lab subjects correctly (e.g., PP -> Python Programming vs PP Lab -> Python Programming Lab).
 * 4. Preserves joint/split slots (e.g., "DS Lab / Web Lab").
 */

const { normalizeDepartmentCode } = require('../data/departments');

// Authoritative standard academic mappings based on the polytechnic / university curriculum & catalog
const CANONICAL_MAPPINGS = {
    // CME / Computer Engineering Theory
    'PP': 'Python Programming',
    'PYTHON': 'Python Programming',
    'PYTHON PROG': 'Python Programming',
    'PYTHON PROGRAMMING': 'Python Programming',
    'DS': 'Data Structures',
    'DATA STRUCTURES': 'Data Structures',
    'DATASTRUCT': 'Data Structures',
    'CO': 'Computer Organization',
    'COMPUTER ORGANIZATION': 'Computer Organization',
    'COMPUTEROR': 'Computer Organization',
    'WT': 'Web Technologies',
    'WEB TECHNOLOGIES': 'Web Technologies',
    'WEBTECHNOL': 'Web Technologies',
    'WT-II': 'Web Technologies-II',
    'SE': 'Software Engineering',
    'SOFTWARE ENGINEERING': 'Software Engineering',
    'CN': 'Computer Networks',
    'COMPUTER NETWORKS': 'Computer Networks',
    'COMPUTERNE': 'Computer Networks',
    'CNCS': 'Computer Networks and Cyber Security',
    'COMPUTER NETWORKS AND CYBER SECURITY': 'Computer Networks and Cyber Security',
    'OS': 'Operating Systems',
    'OPERATING SYSTEMS': 'Operating Systems',
    'OPERATINGS': 'Operating Systems',
    'DBMS': 'Database Management Systems',
    'JAVA': 'Java Programming',
    'DLD': 'Digital Logic',
    'DIGITAL LOGIC': 'Digital Logic',
    'DIGITALLOG': 'Digital Logic',
    'CC': 'Cloud Computing',
    'CLOUD COMPUTING': 'Cloud Computing',
    'CLOUDCOMPU': 'Cloud Computing',
    'MC': 'Mobile Computing',
    'MOBILE COMPUTING': 'Mobile Computing',
    'IOT': 'Internet of Things',
    'INTERNET OF THINGS': 'Internet of Things',
    'IMEP': 'Industrial Management and Entrepreneurship',
    'IM & EP': 'Industrial Management and Entrepreneurship',
    'INDUSTRIAL MANAGEMENT AND ENTREPRENEURSHIP': 'Industrial Management and Entrepreneurship',
    'BDCC': 'Big Data & Cloud Computing',
    'BD & CC': 'Big Data & Cloud Computing',
    'BIG DATA & CLOUD COMPUTING': 'Big Data & Cloud Computing',
    'BIG DATA AND CLOUD COMPUTING': 'Big Data & Cloud Computing',
    'ANDROID': 'Android Programming',
    'ANDROID PROG': 'Android Programming',
    'ANDROID PROGRAMMING': 'Android Programming',
    'ENGLISH': 'English',
    'ENGINEERING PHYSICS': 'Engineering Physics',
    'ENGINEERING CHEMISTRY': 'Engineering Chemistry',
    'PROGRAMMING IN C': 'Programming in C',
    'COMMUNICATION SKILLS': 'Communication Skills',

    // CME / Computer Engineering Labs
    'PP LAB': 'Python Programming Lab',
    'PYTHON LAB': 'Python Programming Lab',
    'PYTHON PROGRAMMING LAB': 'Python Programming Lab',
    'DS LAB': 'Data Structures Lab',
    'DATA STRUCTURES LAB': 'Data Structures Lab',
    'DSLAB': 'Data Structures Lab',
    'WT LAB': 'Web Technologies Lab',
    'WEB LAB': 'Web Technologies Lab',
    'WEB TECHNOLOGIES LAB': 'Web Technologies Lab',
    'CN LAB': 'Computer Networks Lab',
    'COMPUTER NETWORKS LAB': 'Computer Networks Lab',
    'CNCS LAB': 'Computer Networks and Cyber Security Lab',
    'COMPUTER NETWORKS AND CYBER SECURITY LAB': 'Computer Networks and Cyber Security Lab',
    'DBMS LAB': 'DBMS Lab',
    'JAVA LAB': 'Java Lab',
    'AI & ML LAB': 'AI & ML Lab',
    'AIML LAB': 'AI & ML Lab',
    'AIMLLAB': 'AI & ML Lab',
    'IOT LAB': 'IoT Lab',
    'ANDROID LAB': 'Android Programming Lab',
    'ANDROID PROG LAB': 'Android Programming Lab',
    'ANDROIDPRO': 'Android Programming Lab',
    'LIFE SKILLS LAB': 'Life Skills Lab',
    'LIFESKILLS': 'Life Skills Lab',
    'C LAB': 'C Programming Lab',
    'C PROGRAMMING LAB': 'C Programming Lab',
    'CLAB': 'C Programming Lab',
    'PHYSICS LAB': 'Physics Lab',
    'PHYSICSLAB': 'Physics Lab',

    // EEE / Electrical Engineering Theory
    'EED': 'Electrical Engineering Drawing',
    'EM-II': 'Electrical Machines- II',
    'EM II': 'Electrical Machines- II',
    'ELECTRICAL MACHINES- II': 'Electrical Machines- II',
    'ELECTRICAL MACHINES II': 'Electrical Machines- II',
    'GME': 'General Mechanical Engineering',
    'GENERAL MECHANICAL ENGINEERING': 'General Mechanical Engineering',
    'EIE': 'Electrical Installation & Estimation',
    'ELECTRICAL INSTALLATION & ESTIMATION': 'Electrical Installation & Estimation',
    'ELECTRICAL INSTALLATION AND ESTIMATION': 'Electrical Installation & Estimation',
    'PE&PLC': 'Power Electronics & PLC',
    'PE PLC': 'Power Electronics & PLC',
    'POWER ELECTRONICS & PLC': 'Power Electronics & PLC',
    'POWER ELECTRONICS AND PLC': 'Power Electronics & PLC',
    'CIRCUIT THEORY': 'Circuit Theory',
    'ELECTRONIC DEVICES': 'Electronic Devices',
    'CONTROL SYSTEMS': 'Control Systems',
    'POWER SYSTEMS-I': 'Power Systems-I',
    'ELECTRICAL DRIVES': 'Electrical Drives',
    'RENEWABLE ENERGY': 'Renewable Energy',
    'SMART GRID': 'Smart Grid',
    'EMBEDDED SYSTEMS': 'Embedded Systems',

    // EEE / Electrical Engineering Labs
    'EEE COCS LAB': 'Communications Skills Laboratory',
    'COCS LAB': 'Communications Skills Laboratory',
    'COCS': 'Communications Skills Laboratory',
    'COMMUNICATION SKILLS LAB': 'Communications Skills Laboratory',
    'COMMUNICATIONS SKILLS LABORATORY': 'Communications Skills Laboratory',
    'EM-II LAB': 'Electrical Machines- II Laboratory',
    'EM II LAB': 'Electrical Machines- II Laboratory',
    'ELECTRICAL MACHINES- II LABORATORY': 'Electrical Machines- II Laboratory',
    'ELECTRICAL MACHINES II LABORATORY': 'Electrical Machines- II Laboratory',
    'HPS LAB': 'Hybrid Power Systems Laboratory',
    'HYBRID POWER SYSTEMS LABORATORY': 'Hybrid Power Systems Laboratory',
    'ELECTRICAL MEASUREMENTS LAB': 'Electrical Measurements Lab',
    'ELECTRONIC DEVICES LAB': 'Electronic Devices Lab',
    'CIRCUITS LAB': 'Circuits Lab',
    'MEASUREMENTS LAB': 'Measurements Lab',
    'MACHINES LAB': 'Machines Lab',
    'MACHINE LAB': 'Machines Lab',
    'POWER ELECTRONICS LAB': 'Power Electronics Lab',
    'MICROCONTROLLER LAB': 'Microcontroller Lab',
    'EMBEDDED SYSTEMS LAB': 'Embedded Systems Lab',
    'AUTOMATION LAB': 'Automation Lab',

    // General & Mathematics
    'M-I': 'Engineering Mathematics-I',
    'MATHS-I': 'Engineering Mathematics-I',
    'MATHS 1': 'Engineering Mathematics-I',
    'MATHS I': 'Engineering Mathematics-I',
    'ENGINEERING MATHEMATICS-I': 'Engineering Mathematics-I',
    'M-II': 'Engineering Mathematics-II',
    'MATHS-II': 'Engineering Mathematics-II',
    'MATHS 2': 'Engineering Mathematics-II',
    'MATHS II': 'Engineering Mathematics-II',
    'ENGINEERING MATHEMATICS-II': 'Engineering Mathematics-II',
    'PROJECT WORK': 'Project Work',
    'COUNCLING/LIBRARY': 'Counseling / Library',
    'LIBRARY / COUNSELING': 'Library / Counseling',
    'TPC': 'TPC'
};

// Theory-to-Lab specific overrides when context explicitly dictates lab session
const LAB_SPECIFIC_OVERRIDES = {
    'PP': 'Python Programming Lab',
    'PYTHON': 'Python Programming Lab',
    'PYTHON PROG': 'Python Programming Lab',
    'PYTHON PROGRAMMING': 'Python Programming Lab',
    'DS': 'Data Structures Lab',
    'DATA STRUCTURES': 'Data Structures Lab',
    'WT': 'Web Technologies Lab',
    'WEB TECHNOLOGIES': 'Web Technologies Lab',
    'CN': 'Computer Networks Lab',
    'COMPUTER NETWORKS': 'Computer Networks Lab',
    'CNCS': 'Computer Networks and Cyber Security Lab',
    'DBMS': 'DBMS Lab',
    'JAVA': 'Java Lab',
    'IOT': 'IoT Lab',
    'ANDROID': 'Android Programming Lab',
    'ANDROID PROG': 'Android Programming Lab',
    'EM-II': 'Electrical Machines- II Laboratory',
    'EM II': 'Electrical Machines- II Laboratory',
    'PE': 'Power Electronics Lab',
    'COCS': 'Communications Skills Laboratory'
};

// Set of unmapped subject abbreviations tracked during execution for auditing
const unmappedSubjectAbbreviations = new Set();

/**
 * Normalizes an abbreviation key for lookup (uppercased, collapsed spaces, clean punctuation)
 */
function cleanLookupKey(str) {
    if (!str) return '';
    return String(str)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Strips leading department code prefix if present (e.g., "EEE COCS LAB" -> "COCS LAB")
 */
function stripDepartmentPrefix(str) {
    if (!str) return { dept: null, subject: '' };
    const trimmed = String(str).trim();
    const match = trimmed.match(/^(CME|CSE|EEE|ECE|CIVIL|CIV|MECH|MEC|ME|IT|CS)\s+[-_:]*\s*(.*)$/i);
    if (match) {
        return { dept: match[1].toUpperCase(), subject: match[2].trim() };
    }
    return { dept: null, subject: trimmed };
}

/**
 * Resolves a subject name/abbreviation into its full authoritative name.
 *
 * @param {string} subject - Raw subject string (e.g. "PP", "DS", "DS Lab", "EEE COCS Lab")
 * @param {object} [options]
 * @param {string} [options.type] - 'theory' | 'lab' | 'activity'
 * @param {string} [options.department] - Department code ('CME', 'EEE', etc.)
 * @param {Array}  [options.catalog] - Optional database subjects catalog
 * @returns {string} - Full authoritative subject name, or raw subject if unmapped
 */
function resolveFullSubjectName(subject, options = {}) {
    if (!subject || typeof subject !== 'string') return subject || '';
    const raw = subject.trim();
    if (!raw) return '';
    if (raw.toUpperCase() === 'FREE') return raw;

    // Handle joint/split subjects (e.g., "DS Lab / Web Lab" or "PP / DS")
    if (raw.includes('/')) {
        const parts = raw.split('/').map(p => p.trim());
        // Only recurse if parts are distinct non-empty strings
        if (parts.length > 1 && parts.every(Boolean)) {
            const resolvedParts = parts.map(part => resolveFullSubjectName(part, options));
            return resolvedParts.join(' / ');
        }
    }

    const isExplicitLab = (options.type === 'lab') ||
        /\b(lab|laboratory)\b/i.test(raw);

    // 1. Direct check against canonical map with raw string
    const rawKey = cleanLookupKey(raw);
    if (CANONICAL_MAPPINGS[rawKey]) {
        // If explicitly a lab but mapped to theory, check lab override
        if (isExplicitLab && LAB_SPECIFIC_OVERRIDES[rawKey]) {
            return LAB_SPECIFIC_OVERRIDES[rawKey];
        }
        return CANONICAL_MAPPINGS[rawKey];
    }

    // 2. Check with department prefix removed (e.g. "EEE COCS Lab" -> "COCS Lab")
    const { dept: prefixDept, subject: noPrefix } = stripDepartmentPrefix(raw);
    if (noPrefix && noPrefix !== raw) {
        const noPrefixKey = cleanLookupKey(noPrefix);
        if (CANONICAL_MAPPINGS[noPrefixKey]) {
            if (isExplicitLab && LAB_SPECIFIC_OVERRIDES[noPrefixKey]) {
                return LAB_SPECIFIC_OVERRIDES[noPrefixKey];
            }
            return CANONICAL_MAPPINGS[noPrefixKey];
        }
    }

    // 3. Check lab-specific override directly if marked as lab
    if (isExplicitLab) {
        if (LAB_SPECIFIC_OVERRIDES[rawKey]) {
            return LAB_SPECIFIC_OVERRIDES[rawKey];
        }
        // Remove trailing "LAB" / "LABORATORY" and check base subject
        const baseKey = rawKey.replace(/\b(LAB|LABORATORY)\b/gi, '').trim();
        if (baseKey && LAB_SPECIFIC_OVERRIDES[baseKey]) {
            return LAB_SPECIFIC_OVERRIDES[baseKey];
        }
        if (baseKey && CANONICAL_MAPPINGS[baseKey]) {
            return CANONICAL_MAPPINGS[baseKey] + ' Lab';
        }
    }

    // 4. Check dynamic subject catalog if provided in options or memory
    const catalog = Array.isArray(options.catalog) ? options.catalog : null;
    if (catalog && catalog.length > 0) {
        const effectiveDept = options.department || prefixDept;
        const normDept = effectiveDept ? normalizeDepartmentCode(effectiveDept) : null;

        // Try exact match on name
        const matchName = catalog.find(s => {
            if (normDept && s.department && normalizeDepartmentCode(s.department) !== normDept) return false;
            return cleanLookupKey(s.name) === rawKey;
        });
        if (matchName) {
            // Check if catalog name itself is an abbreviation with a known expansion
            const cNameKey = cleanLookupKey(matchName.name);
            return CANONICAL_MAPPINGS[cNameKey] || matchName.name;
        }

        // Try exact match on code
        const matchCode = catalog.find(s => {
            if (normDept && s.department && normalizeDepartmentCode(s.department) !== normDept) return false;
            return s.code && cleanLookupKey(s.code) === rawKey;
        });
        if (matchCode) {
            const cNameKey = cleanLookupKey(matchCode.name);
            return CANONICAL_MAPPINGS[cNameKey] || matchCode.name;
        }
    }

    // 5. Preserved fallback: If abbreviation cannot be mapped reliably, preserve existing display
    // Track unmapped abbreviation for reporting
    if (rawKey.length > 0 && !CANONICAL_MAPPINGS[rawKey]) {
        unmappedSubjectAbbreviations.add(raw);
    }
    return raw;
}

/**
 * Formats all cells in a timetable grid using the subject display resolver.
 * Preserves all grid metadata, period timings, days, and slot coordinates.
 *
 * @param {object} grid - Timetable grid object ({ view, days, periods, cells, ... })
 * @param {string} [branch] - Optional branch/department code
 * @returns {object} - Grid with formatted full subject names
 */
function formatTimetableGridSubjects(grid, branch) {
    if (!grid || !Array.isArray(grid.cells)) return grid;

    const formattedCells = grid.cells.map(cell => {
        if (!cell || !cell.subject) return cell;
        const fullSubject = resolveFullSubjectName(cell.subject, {
            type: cell.type,
            department: branch || grid.branch
        });
        return {
            ...cell,
            subject: fullSubject,
            rawSubject: cell.rawSubject || cell.subject
        };
    });

    return {
        ...grid,
        cells: formattedCells
    };
}

/**
 * Returns a list of subject abbreviations that could not be mapped confidently.
 */
function getUnmappedSubjectAbbreviations() {
    return Array.from(unmappedSubjectAbbreviations);
}

/**
 * Resets the unmapped abbreviations tracker.
 */
function clearUnmappedSubjectAbbreviations() {
    unmappedSubjectAbbreviations.clear();
}

module.exports = {
    resolveFullSubjectName,
    formatTimetableGridSubjects,
    getUnmappedSubjectAbbreviations,
    clearUnmappedSubjectAbbreviations,
    CANONICAL_MAPPINGS,
    LAB_SPECIFIC_OVERRIDES
};
