/**
 * Demo academic dataset — realistic academic data for demonstrating the app.
 *
 * 17 faculty across 4 branches, 5 classes, 34 subjects,
 * 10 rooms, Monday-Saturday, periods 1-7.
 *
 * GENERATED FILE — produced by tools/generateDemoTimetable.js and committed as
 * plain data. Edit the plan in that script and re-run it rather than editing
 * the schedule here by hand; the generator is what guarantees that:
 *   - no faculty is scheduled in two classes at the same day + period
 *   - no room hosts two classes at the same day + period
 *   - every faculty member has both busy and free periods, so the
 *     substitution lookup always has something to show
 *
 * This module is the fallback dataset. When DATABASE_URL is configured the
 * store loads the timetable from PostgreSQL instead and seeds it from here.
 */

module.exports = {
    meta: {
        institution: "ADITYA INSTITUTE OF TECHNOLOGY AND MANAGEMENT",
        title: "II SHIFT POLYTECHNIC C23 - V SEM TIME TABLE",
        academicYear: "2026-27",
        wef: "08-06-2026",
        primaryClass: "CME-A",
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        periods: [1, 2, 3, 4, 5, 6, 7],
        periodTimings: {
            "1": { start: "08:00", end: "08:45" },
            "2": { start: "08:45", end: "09:30" },
            "3": { start: "09:30", end: "10:15" },
            "4": { start: "10:30", end: "11:15" },
            "5": { start: "11:15", end: "12:00" },
            "6": { start: "12:00", end: "12:45" },
            "7": { start: "12:45", end: "13:30" }
        }
    },
    departments: [
        { code: "CME", name: "Computer Engineering", active: true },
        { code: "EEE", name: "Electrical and Electronics Engineering", active: true },
        { code: "MEC", name: "Mechanical Engineering", active: true },
        { code: "ECE", name: "Electronics and Communication Engineering", active: false }
    ],
    rooms: [
        { code: "C-401", name: "Block C — Room 401", type: "classroom", capacity: 60 },
        { code: "P-301", name: "Block P — Room 301", type: "classroom", capacity: 60 },
        { code: "E-201", name: "Block E — Room 201", type: "classroom", capacity: 60 },
        { code: "E-202", name: "Block E — Room 202", type: "classroom", capacity: 60 },
        { code: "M-501", name: "Block M — Room 501", type: "classroom", capacity: 60 },
        { code: "CM-LAB-1", name: "Computer Engineering Lab", type: "lab", capacity: 35 },
        { code: "EEE-LAB-1", name: "Electrical Machines Lab", type: "lab", capacity: 30 },
        { code: "EC-LAB-1", name: "Electronics Lab 1", type: "lab", capacity: 30 },
        { code: "EC-LAB-2", name: "Electronics Lab 2", type: "lab", capacity: 30 },
        { code: "ME-WORKSHOP", name: "Mechanical Workshop", type: "lab", capacity: 40 }
    ],
    subjects: [
        { code: "CM-501", name: "Industrial Management and Entrepreneurship", department: "CME", type: "theory" },
        { code: "CM-502", name: "Big Data & Cloud Computing", department: "CME", type: "theory" },
        { code: "CM-503", name: "Android Programming", department: "CME", type: "theory" },
        { code: "CM-504", name: "Internet Of Things", department: "CME", type: "theory" },
        { code: "CM-505", name: "Python Programming", department: "CME", type: "theory" },
        { code: "CM-506", name: "Android Programming Lab", department: "CME", type: "lab" },
        { code: "CM-507", name: "Python Programming Lab", department: "CME", type: "lab" },
        { code: "CM-508", name: "Life Skills", department: "CME", type: "theory" },
        { code: "CM-509", name: "Project work", department: "CME", type: "theory" },
        { code: "EE501", name: "Power Systems", department: "EEE", type: "theory" },
        { code: "EE502", name: "Electrical Machines", department: "EEE", type: "theory" },
        { code: "EE503", name: "Control Systems", department: "EEE", type: "theory" },
        { code: "EE504", name: "Power Electronics", department: "EEE", type: "theory" },
        { code: "EE505", name: "Electromagnetic Fields", department: "EEE", type: "theory" },
        { code: "EE506", name: "Transmission and Distribution", department: "EEE", type: "theory" },
        { code: "EE551", name: "Electrical Machines Lab", department: "EEE", type: "lab" },
        { code: "EE552", name: "Power Systems Lab", department: "EEE", type: "lab" },
        { code: "EC501", name: "Digital Electronics", department: "ECE", type: "theory" },
        { code: "EC502", name: "Signals and Systems", department: "ECE", type: "theory" },
        { code: "EC503", name: "Microprocessors", department: "ECE", type: "theory" },
        { code: "EC504", name: "Communication Systems", department: "ECE", type: "theory" },
        { code: "EC505", name: "VLSI Design", department: "ECE", type: "theory" },
        { code: "EC506", name: "Linear Control Systems", department: "ECE", type: "theory" },
        { code: "EC551", name: "Digital Electronics Lab", department: "ECE", type: "lab" },
        { code: "EC552", name: "Microprocessors Lab", department: "ECE", type: "lab" },
        { code: "EC553", name: "Communication Systems Lab", department: "ECE", type: "lab" },
        { code: "ME501", name: "Engineering Mechanics", department: "MEC", type: "theory" },
        { code: "ME502", name: "Thermodynamics", department: "MEC", type: "theory" },
        { code: "ME503", name: "Manufacturing Technology", department: "MEC", type: "theory" },
        { code: "ME504", name: "Fluid Mechanics", department: "MEC", type: "theory" },
        { code: "ME505", name: "Kinematics of Machinery", department: "MEC", type: "theory" },
        { code: "ME506", name: "Material Science", department: "MEC", type: "theory" },
        { code: "ME551", name: "Manufacturing Technology Lab", department: "MEC", type: "lab" },
        { code: "ME552", name: "Thermodynamics Lab", department: "MEC", type: "lab" }
    ],
    faculty: [
        {
            id: "FAC001",
            name: "Sri B. Gopala Rao",
            department: "CME",
            designation: "Professor",
            phone: "+91 90000 10001",
            email: "b.gopala.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC002",
            name: "Ms. G. Sandhya Rani",
            department: "CME",
            designation: "Associate Professor",
            phone: "+91 90000 10002",
            email: "g.sandhya.rani@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC003",
            name: "Ms. Debadatta Bhattacharya",
            department: "CME",
            designation: "Assistant Professor",
            phone: "+91 90000 10003",
            email: "debadatta.bhattacharya@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC004",
            name: "Mrs. A. Sravanthi",
            department: "CME",
            designation: "Assistant Professor",
            phone: "+91 90000 10004",
            email: "a.sravanthi@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC005",
            name: "Ms. B. Kusuma",
            department: "CME",
            designation: "Assistant Professor",
            phone: "+91 90000 10005",
            email: "b.kusuma@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC006",
            name: "Mrs. K. Anitha",
            department: "CME",
            designation: "Assistant Professor",
            phone: "+91 90000 10006",
            email: "k.anitha@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC007",
            name: "Mr. Ch. Sai Kishore",
            department: "CME",
            designation: "Assistant Professor",
            phone: "+91 90000 10007",
            email: "ch.sai.kishore@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC008",
            name: "Dr. Suresh Babu",
            department: "EEE",
            designation: "Professor",
            phone: "+91 90000 10008",
            email: "suresh.babu@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC009",
            name: "Prof. Lakshmi Devi",
            department: "EEE",
            designation: "Associate Professor",
            phone: "+91 90000 10009",
            email: "lakshmi.devi@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC010",
            name: "Dr. Mahesh Gupta",
            department: "EEE",
            designation: "Assistant Professor",
            phone: "+91 90000 10010",
            email: "mahesh.gupta@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC011",
            name: "Prof. Naveen Reddy",
            department: "ECE",
            designation: "Professor",
            phone: "+91 90000 10011",
            email: "naveen.reddy@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC012",
            name: "Dr. Kavya Rao",
            department: "ECE",
            designation: "Associate Professor",
            phone: "+91 90000 10012",
            email: "kavya.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC013",
            name: "Dr. Anitha Menon",
            department: "ECE",
            designation: "Assistant Professor",
            phone: "+91 90000 10013",
            email: "anitha.menon@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC014",
            name: "Prof. Ravi Teja",
            department: "ECE",
            designation: "Assistant Professor",
            phone: "+91 90000 10014",
            email: "ravi.teja@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC015",
            name: "Dr. Rajesh Pillai",
            department: "MEC",
            designation: "Professor",
            phone: "+91 90000 10015",
            email: "rajesh.pillai@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC016",
            name: "Prof. Harish Chandra",
            department: "MEC",
            designation: "Associate Professor",
            phone: "+91 90000 10016",
            email: "harish.chandra@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC017",
            name: "Dr. Sunita Rani",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "+91 90000 10017",
            email: "sunita.rani@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        }
    ],
    classes: [
        {
            class: "CME-A",
            department: "CME",
            semester: 5,
            academicYear: "2026-27",
            room: "C-401",
            rows: {
                Monday: [
                    { period: 1, spanTo: 2, subject: "Python Programming", faculty: "Ms. B. Kusuma", room: "C-401", type: "theory" },
                    {
                        period: 3,
                        subject: "Industrial Management and Entrepreneurship",
                        faculty: "Sri B. Gopala Rao",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 4,
                        subject: "Big Data & Cloud Computing",
                        faculty: "Ms. G. Sandhya Rani",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Android Programming Lab",
                        faculty: "Ms. Debadatta Bhattacharya",
                        room: "CM-LAB-1",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    {
                        period: 1,
                        subject: "Big Data & Cloud Computing",
                        faculty: "Ms. G. Sandhya Rani",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 2, subject: "Internet Of Things", faculty: "Mrs. A. Sravanthi", room: "C-401", type: "theory" },
                    {
                        period: 3,
                        subject: "Big Data & Cloud Computing",
                        faculty: "Ms. G. Sandhya Rani",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 4, subject: "Internet Of Things", faculty: "Mrs. A. Sravanthi", room: "C-401", type: "theory" },
                    {
                        period: 5,
                        subject: "Android Programming",
                        faculty: "Ms. Debadatta Bhattacharya",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 6, subject: "Python Programming", faculty: "Ms. B. Kusuma", room: "C-401", type: "theory" },
                    { period: 7, subject: "Project work", faculty: "Mr. Ch. Sai Kishore", room: "C-401", type: "theory" }
                ],
                Wednesday: [
                    {
                        period: 1,
                        subject: "Big Data & Cloud Computing",
                        faculty: "Ms. G. Sandhya Rani",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 2, subject: "Python Programming", faculty: "Ms. B. Kusuma", room: "C-401", type: "theory" },
                    {
                        period: 3,
                        subject: "Android Programming",
                        faculty: "Ms. Debadatta Bhattacharya",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 4,
                        subject: "Industrial Management and Entrepreneurship",
                        faculty: "Sri B. Gopala Rao",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 5, spanTo: 7, subject: "Life Skills Lab", faculty: "Mrs. K. Anitha", room: "CM-LAB-1", type: "lab" }
                ],
                Thursday: [
                    {
                        period: 1,
                        subject: "Industrial Management and Entrepreneurship",
                        faculty: "Sri B. Gopala Rao",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 2, subject: "Python Programming", faculty: "Ms. B. Kusuma", room: "C-401", type: "theory" },
                    {
                        period: 3,
                        subject: "Big Data & Cloud Computing",
                        faculty: "Ms. G. Sandhya Rani",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 4, subject: "Internet Of Things", faculty: "Mrs. A. Sravanthi", room: "C-401", type: "theory" },
                    {
                        period: 5,
                        subject: "Android Programming",
                        faculty: "Ms. Debadatta Bhattacharya",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 6,
                        subject: "Industrial Management and Entrepreneurship",
                        faculty: "Sri B. Gopala Rao",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 7, subject: "Library / Counselling", faculty: null, room: "C-401", type: "activity" }
                ],
                Friday: [
                    {
                        period: 1,
                        subject: "Big Data & Cloud Computing",
                        faculty: "Ms. G. Sandhya Rani",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 2, subject: "Python Programming", faculty: "Ms. B. Kusuma", room: "C-401", type: "theory" },
                    {
                        period: 3,
                        subject: "Android Programming",
                        faculty: "Ms. Debadatta Bhattacharya",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 4,
                        subject: "Industrial Management and Entrepreneurship",
                        faculty: "Sri B. Gopala Rao",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 5, subject: "Internet Of Things", faculty: "Mrs. A. Sravanthi", room: "C-401", type: "theory" },
                    { period: 6, subject: "TPC", faculty: null, room: "C-401", type: "activity" },
                    { period: 7, subject: "Project work", faculty: "Mr. Ch. Sai Kishore", room: "C-401", type: "theory" }
                ],
                Saturday: [
                    {
                        period: 1,
                        spanTo: 2,
                        subject: "Internet Of Things",
                        faculty: "Mrs. A. Sravanthi",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 3,
                        spanTo: 4,
                        subject: "Android Programming",
                        faculty: "Ms. Debadatta Bhattacharya",
                        room: "C-401",
                        type: "theory"
                    },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Python Programming Lab",
                        faculty: "Ms. B. Kusuma",
                        room: "CM-LAB-1",
                        type: "lab"
                    }
                ]
            }
        },
        {
            class: "EEE-A",
            department: "EEE",
            semester: 5,
            academicYear: "2026-27",
            room: "P-301",
            rows: {
                Monday: [
                    { period: 1, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    {
                        period: 2,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 3, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 4, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Power Systems Lab",
                        faculty: "Dr. Suresh Babu",
                        room: "EEE-LAB-1",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    { period: 1, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 2, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    {
                        period: 3,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 4, spanTo: 5, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 7, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    {
                        period: 3,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 4, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 5, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 6, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" }
                ],
                Thursday: [
                    {
                        period: 1,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 2, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    { period: 3, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Electrical Machines Lab",
                        faculty: "Prof. Lakshmi Devi",
                        room: "EEE-LAB-1",
                        type: "lab"
                    }
                ],
                Friday: [
                    {
                        period: 1,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 2, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 3, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 5, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 6, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    { period: 7, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" }
                ],
                Saturday: [
                    { period: 1, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 2, spanTo: 3, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 4, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 5, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    { period: 7, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" }
                ]
            }
        },
        {
            class: "ECE-A",
            department: "ECE",
            semester: 5,
            academicYear: "2026-27",
            room: "E-201",
            rows: {
                Monday: [
                    { period: 1, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 4, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Digital Electronics Lab",
                        faculty: "Prof. Naveen Reddy",
                        room: "EC-LAB-1",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    { period: 1, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 5, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 6, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 7, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 2, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 3, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Microprocessors Lab",
                        faculty: "Dr. Anitha Menon",
                        room: "EC-LAB-1",
                        type: "lab"
                    }
                ],
                Thursday: [
                    {
                        period: 1,
                        spanTo: 2,
                        subject: "Digital Electronics",
                        faculty: "Prof. Naveen Reddy",
                        room: "E-201",
                        type: "theory"
                    },
                    { period: 3, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 4, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 5, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 6, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 7, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 4, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 5, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 6, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 7, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" }
                ],
                Saturday: [
                    { period: 1, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 4, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 6, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 7, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" }
                ]
            }
        },
        {
            class: "ECE-B",
            department: "ECE",
            semester: 5,
            academicYear: "2026-27",
            room: "E-202",
            rows: {
                Monday: [
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 4, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 5, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 7, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" }
                ],
                Tuesday: [
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 4, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 5, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 6, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 2, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 4, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Communication Systems Lab",
                        faculty: "Dr. Kavya Rao",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ],
                Thursday: [
                    { period: 1, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 2, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 3, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 4, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 5, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 6, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 7, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 4, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Microprocessors Lab",
                        faculty: "Prof. Ravi Teja",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ],
                Saturday: [
                    { period: 2, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 3, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 4, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 5, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 6, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 7, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" }
                ]
            }
        },
        {
            class: "MEC-A",
            department: "MEC",
            semester: 5,
            academicYear: "2026-27",
            room: "M-501",
            rows: {
                Monday: [
                    { period: 1, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 2, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 3, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 4, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Manufacturing Technology Lab",
                        faculty: "Dr. Sunita Rani",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    { period: 1, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 2, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 3, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 5, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 6, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 7, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 3, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 4, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 6, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" }
                ],
                Thursday: [
                    { period: 2, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 3, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 4, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 5, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 6, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 7, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 2, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 3, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 4, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 5, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 6, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" }
                ],
                Saturday: [
                    { period: 1, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    {
                        period: 2,
                        spanTo: 3,
                        subject: "Kinematics of Machinery",
                        faculty: "Prof. Harish Chandra",
                        room: "M-501",
                        type: "theory"
                    },
                    { period: 4, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Thermodynamics Lab",
                        faculty: "Prof. Harish Chandra",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    }
                ]
            }
        }
    ]
};
