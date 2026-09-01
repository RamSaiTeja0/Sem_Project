/**
 * Demo academic dataset — realistic fictional data for demonstrating the app.
 *
 * 21 faculty across 6 branches, 8 classes, 50 subjects,
 * 16 rooms, Monday-Friday, periods 1-7.
 *
 * GENERATED FILE — produced by tools/generateDemoTimetable.js and committed as
 * plain data. Edit the plan in that script and re-run it rather than editing
 * the schedule here by hand; the generator is what guarantees that:
 *   - no faculty is scheduled in two classes at the same day + period
 *   - no room hosts two classes at the same day + period
 *   - every faculty member has both busy and free periods, so the
 *     substitution lookup always has something to show
 *
 * All names are fictional and exist only for this demonstration.
 *
 * This module is the fallback dataset. When DATABASE_URL is configured the
 * store loads the timetable from PostgreSQL instead and seeds it from here.
 */

module.exports = {
    meta: {
        institution: "Institute of Engineering & Technology",
        title: "Semester V — Working Timetable 2025-26 (Demo Data)",
        academicYear: "2025-26",
        primaryClass: "CSE-A",
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        periods: [1, 2, 3, 4, 5, 6, 7],
        periodTimings: {
            "1": { start: "09:00", end: "09:50" },
            "2": { start: "09:50", end: "10:40" },
            "3": { start: "10:50", end: "11:40" },
            "4": { start: "11:40", end: "12:30" },
            "5": { start: "13:20", end: "14:10" },
            "6": { start: "14:10", end: "15:00" },
            "7": { start: "15:10", end: "16:00" }
        }
    },
    departments: [
        { code: "CSE", name: "Computer Science and Engineering" },
        { code: "ECE", name: "Electronics and Communication Engineering" },
        { code: "EEE", name: "Electrical and Electronics Engineering" },
        { code: "CME", name: "Computer Engineering" },
        { code: "MEC", name: "Mechanical Engineering" },
        { code: "CIVIL", name: "Civil Engineering" }
    ],
    rooms: [
        { code: "A-101", name: "Block A — Room 101", type: "classroom", capacity: 60 },
        { code: "A-102", name: "Block A — Room 102", type: "classroom", capacity: 60 },
        { code: "E-201", name: "Block E — Room 201", type: "classroom", capacity: 60 },
        { code: "E-202", name: "Block E — Room 202", type: "classroom", capacity: 60 },
        { code: "P-301", name: "Block P — Room 301", type: "classroom", capacity: 60 },
        { code: "C-401", name: "Block C — Room 401", type: "classroom", capacity: 60 },
        { code: "M-501", name: "Block M — Room 501", type: "classroom", capacity: 60 },
        { code: "V-601", name: "Block V — Room 601", type: "classroom", capacity: 60 },
        { code: "CS-LAB-1", name: "Computer Lab 1", type: "lab", capacity: 35 },
        { code: "CS-LAB-2", name: "Computer Lab 2", type: "lab", capacity: 35 },
        { code: "EC-LAB-1", name: "Electronics Lab 1", type: "lab", capacity: 30 },
        { code: "EC-LAB-2", name: "Electronics Lab 2", type: "lab", capacity: 30 },
        { code: "EE-LAB-1", name: "Electrical Machines Lab", type: "lab", capacity: 30 },
        { code: "CM-LAB-1", name: "Computer Engineering Lab", type: "lab", capacity: 35 },
        { code: "ME-WORKSHOP", name: "Mechanical Workshop", type: "lab", capacity: 40 },
        { code: "CV-LAB-1", name: "Civil Engineering Lab", type: "lab", capacity: 30 }
    ],
    subjects: [
        { code: "CS501", name: "Data Structures", department: "CSE", type: "theory" },
        { code: "CS502", name: "Database Management Systems", department: "CSE", type: "theory" },
        { code: "CS503", name: "Operating Systems", department: "CSE", type: "theory" },
        { code: "CS504", name: "Computer Networks", department: "CSE", type: "theory" },
        { code: "CS505", name: "Web Technologies", department: "CSE", type: "theory" },
        { code: "CS506", name: "Software Engineering", department: "CSE", type: "theory" },
        { code: "CS551", name: "Data Structures Lab", department: "CSE", type: "lab" },
        { code: "CS552", name: "DBMS Lab", department: "CSE", type: "lab" },
        { code: "CS553", name: "Web Technologies Lab", department: "CSE", type: "lab" },
        { code: "EC501", name: "Digital Electronics", department: "ECE", type: "theory" },
        { code: "EC502", name: "Signals and Systems", department: "ECE", type: "theory" },
        { code: "EC503", name: "Microprocessors", department: "ECE", type: "theory" },
        { code: "EC504", name: "Communication Systems", department: "ECE", type: "theory" },
        { code: "EC505", name: "VLSI Design", department: "ECE", type: "theory" },
        { code: "EC506", name: "Linear Control Systems", department: "ECE", type: "theory" },
        { code: "EC551", name: "Digital Electronics Lab", department: "ECE", type: "lab" },
        { code: "EC552", name: "Microprocessors Lab", department: "ECE", type: "lab" },
        { code: "EC553", name: "Communication Systems Lab", department: "ECE", type: "lab" },
        { code: "EE501", name: "Power Systems", department: "EEE", type: "theory" },
        { code: "EE502", name: "Electrical Machines", department: "EEE", type: "theory" },
        { code: "EE503", name: "Control Systems", department: "EEE", type: "theory" },
        { code: "EE504", name: "Power Electronics", department: "EEE", type: "theory" },
        { code: "EE505", name: "Electromagnetic Fields", department: "EEE", type: "theory" },
        { code: "EE506", name: "Transmission and Distribution", department: "EEE", type: "theory" },
        { code: "EE551", name: "Electrical Machines Lab", department: "EEE", type: "lab" },
        { code: "EE552", name: "Power Systems Lab", department: "EEE", type: "lab" },
        { code: "CM501", name: "Computer Architecture", department: "CME", type: "theory" },
        { code: "CM502", name: "Programming", department: "CME", type: "theory" },
        { code: "CM503", name: "Software Engineering", department: "CME", type: "theory" },
        { code: "CM504", name: "Embedded Systems", department: "CME", type: "theory" },
        { code: "CM505", name: "Object Oriented Analysis & Design", department: "CME", type: "theory" },
        { code: "CM506", name: "Cloud Computing", department: "CME", type: "theory" },
        { code: "CM551", name: "Programming Lab", department: "CME", type: "lab" },
        { code: "CM552", name: "Computer Architecture Lab", department: "CME", type: "lab" },
        { code: "ME501", name: "Engineering Mechanics", department: "MEC", type: "theory" },
        { code: "ME502", name: "Thermodynamics", department: "MEC", type: "theory" },
        { code: "ME503", name: "Manufacturing Technology", department: "MEC", type: "theory" },
        { code: "ME504", name: "Fluid Mechanics", department: "MEC", type: "theory" },
        { code: "ME505", name: "Kinematics of Machinery", department: "MEC", type: "theory" },
        { code: "ME506", name: "Material Science", department: "MEC", type: "theory" },
        { code: "ME551", name: "Manufacturing Technology Lab", department: "MEC", type: "lab" },
        { code: "ME552", name: "Thermodynamics Lab", department: "MEC", type: "lab" },
        { code: "CV501", name: "Structural Engineering", department: "CIVIL", type: "theory" },
        { code: "CV502", name: "Surveying", department: "CIVIL", type: "theory" },
        { code: "CV503", name: "Concrete Technology", department: "CIVIL", type: "theory" },
        { code: "CV504", name: "Geotechnical Engineering", department: "CIVIL", type: "theory" },
        { code: "CV505", name: "Fluid Mechanics & Hydraulics", department: "CIVIL", type: "theory" },
        { code: "CV506", name: "Environmental Engineering", department: "CIVIL", type: "theory" },
        { code: "CV551", name: "Surveying Lab", department: "CIVIL", type: "lab" },
        { code: "CV552", name: "Concrete Technology Lab", department: "CIVIL", type: "lab" }
    ],
    faculty: [
        {
            id: "FAC001",
            name: "Dr. Arjun Rao",
            department: "CSE",
            designation: "Professor",
            phone: "+91 90000 10001",
            email: "arjun.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC002",
            name: "Dr. Priya Sharma",
            department: "CSE",
            designation: "Associate Professor",
            phone: "+91 90000 10002",
            email: "priya.sharma@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC003",
            name: "Prof. Kiran Reddy",
            department: "CSE",
            designation: "Assistant Professor",
            phone: "+91 90000 10003",
            email: "kiran.reddy@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC004",
            name: "Dr. Ananya Iyer",
            department: "CSE",
            designation: "Associate Professor",
            phone: "+91 90000 10004",
            email: "ananya.iyer@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC005",
            name: "Dr. Rahul Varma",
            department: "CSE",
            designation: "Assistant Professor",
            phone: "+91 90000 10005",
            email: "rahul.varma@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC006",
            name: "Prof. Naveen Reddy",
            department: "ECE",
            designation: "Professor",
            phone: "+91 90000 10006",
            email: "naveen.reddy@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC007",
            name: "Dr. Kavya Rao",
            department: "ECE",
            designation: "Associate Professor",
            phone: "+91 90000 10007",
            email: "kavya.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC008",
            name: "Dr. Anitha Menon",
            department: "ECE",
            designation: "Assistant Professor",
            phone: "+91 90000 10008",
            email: "anitha.menon@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC009",
            name: "Prof. Ravi Teja",
            department: "ECE",
            designation: "Assistant Professor",
            phone: "+91 90000 10009",
            email: "ravi.teja@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC010",
            name: "Dr. Suresh Babu",
            department: "EEE",
            designation: "Professor",
            phone: "+91 90000 10010",
            email: "suresh.babu@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC011",
            name: "Prof. Lakshmi Devi",
            department: "EEE",
            designation: "Associate Professor",
            phone: "+91 90000 10011",
            email: "lakshmi.devi@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC012",
            name: "Dr. Mahesh Gupta",
            department: "EEE",
            designation: "Assistant Professor",
            phone: "+91 90000 10012",
            email: "mahesh.gupta@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC013",
            name: "Dr. Sneha Nair",
            department: "CME",
            designation: "Professor",
            phone: "+91 90000 10013",
            email: "sneha.nair@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC014",
            name: "Prof. Vikram Kumar",
            department: "CME",
            designation: "Associate Professor",
            phone: "+91 90000 10014",
            email: "vikram.kumar@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC015",
            name: "Dr. Meera Joshi",
            department: "CME",
            designation: "Assistant Professor",
            phone: "+91 90000 10015",
            email: "meera.joshi@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC016",
            name: "Dr. Rajesh Pillai",
            department: "MEC",
            designation: "Professor",
            phone: "+91 90000 10016",
            email: "rajesh.pillai@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC017",
            name: "Prof. Harish Chandra",
            department: "MEC",
            designation: "Associate Professor",
            phone: "+91 90000 10017",
            email: "harish.chandra@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC018",
            name: "Dr. Sunita Rani",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "+91 90000 10018",
            email: "sunita.rani@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC019",
            name: "Dr. Venkat Prasad",
            department: "CIVIL",
            designation: "Professor",
            phone: "+91 90000 10019",
            email: "venkat.prasad@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC020",
            name: "Prof. Deepak Sinha",
            department: "CIVIL",
            designation: "Associate Professor",
            phone: "+91 90000 10020",
            email: "deepak.sinha@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC021",
            name: "Dr. Neha Kulkarni",
            department: "CIVIL",
            designation: "Assistant Professor",
            phone: "+91 90000 10021",
            email: "neha.kulkarni@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        }
    ],
    classes: [
        {
            class: "CSE-A",
            department: "CSE",
            semester: 5,
            academicYear: "2025-26",
            room: "A-101",
            rows: {
                Monday: [
                    { period: 1, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 2, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 3, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 4, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 5, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 6, spanTo: 7, subject: "Web Technologies", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" }
                ],
                Tuesday: [
                    { period: 1, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" },
                    { period: 3, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 4, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 5, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    {
                        period: 6,
                        spanTo: 7,
                        subject: "Database Management Systems",
                        faculty: "Dr. Priya Sharma",
                        room: "A-101",
                        type: "theory"
                    }
                ],
                Wednesday: [
                    { period: 1, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" },
                    { period: 2, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 3, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 4, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 5, spanTo: 7, subject: "Data Structures Lab", faculty: "Dr. Arjun Rao", room: "CS-LAB-1", type: "lab" }
                ],
                Thursday: [
                    { period: 1, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 2, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" },
                    { period: 3, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 4, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 5, spanTo: 7, subject: "DBMS Lab", faculty: "Dr. Priya Sharma", room: "CS-LAB-1", type: "lab" }
                ],
                Friday: [
                    { period: 1, spanTo: 2, subject: "Web Technologies", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" },
                    { period: 3, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 4, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" },
                    { period: 5, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 6, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 7, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" }
                ]
            }
        },
        {
            class: "CSE-B",
            department: "CSE",
            semester: 5,
            academicYear: "2025-26",
            room: "A-102",
            rows: {
                Monday: [
                    { period: 1, subject: "Software Engineering", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    { period: 2, subject: "Operating Systems", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    { period: 3, subject: "Data Structures", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 4, subject: "Database Management Systems", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 5, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 6, subject: "Web Technologies", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 7, subject: "Data Structures", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" }
                ],
                Tuesday: [
                    {
                        period: 1,
                        spanTo: 2,
                        subject: "Database Management Systems",
                        faculty: "Dr. Ananya Iyer",
                        room: "A-102",
                        type: "theory"
                    },
                    { period: 3, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 4, subject: "Software Engineering", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Web Technologies Lab",
                        faculty: "Prof. Kiran Reddy",
                        room: "CS-LAB-2",
                        type: "lab"
                    }
                ],
                Wednesday: [
                    { period: 1, subject: "Web Technologies", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 2, subject: "Operating Systems", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    { period: 3, subject: "Data Structures", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 4, subject: "Software Engineering", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    { period: 5, spanTo: 7, subject: "DBMS Lab", faculty: "Dr. Ananya Iyer", room: "CS-LAB-2", type: "lab" }
                ],
                Thursday: [
                    { period: 1, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 2, subject: "Software Engineering", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    { period: 3, subject: "Data Structures", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 4, subject: "Operating Systems", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" },
                    { period: 5, subject: "Web Technologies", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 6, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 7, subject: "Operating Systems", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Database Management Systems", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 3, subject: "Database Management Systems", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 4, subject: "Web Technologies", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 5, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 6, subject: "Data Structures", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 7, subject: "Operating Systems", faculty: "Dr. Rahul Varma", room: "A-102", type: "theory" }
                ]
            }
        },
        {
            class: "ECE-A",
            department: "ECE",
            semester: 5,
            academicYear: "2025-26",
            room: "E-201",
            rows: {
                Monday: [
                    { period: 1, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 2, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 4, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
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
                    { period: 1, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 4, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Microprocessors Lab",
                        faculty: "Dr. Anitha Menon",
                        room: "EC-LAB-1",
                        type: "lab"
                    }
                ],
                Wednesday: [
                    { period: 1, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 4, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 5, spanTo: 6, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 7, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" }
                ],
                Thursday: [
                    { period: 1, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 2, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 3, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 4, subject: "VLSI Design", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 5, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 6, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 7, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 2, spanTo: 3, subject: "Microprocessors", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 4, subject: "Linear Control Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 5, spanTo: 6, subject: "Signals and Systems", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 7, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" }
                ]
            }
        },
        {
            class: "ECE-B",
            department: "ECE",
            semester: 5,
            academicYear: "2025-26",
            room: "E-202",
            rows: {
                Monday: [
                    { period: 1, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 2, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 3, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 4, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 5, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 6, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 7, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" }
                ],
                Tuesday: [
                    { period: 1, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 4, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 5, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 6, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 7, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    {
                        period: 2,
                        spanTo: 3,
                        subject: "Communication Systems",
                        faculty: "Dr. Anitha Menon",
                        room: "E-202",
                        type: "theory"
                    },
                    { period: 4, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 5, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 6, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 7, subject: "VLSI Design", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" }
                ],
                Thursday: [
                    {
                        period: 1,
                        spanTo: 2,
                        subject: "Communication Systems",
                        faculty: "Dr. Anitha Menon",
                        room: "E-202",
                        type: "theory"
                    },
                    { period: 3, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 4, subject: "Linear Control Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Digital Electronics Lab",
                        faculty: "Dr. Kavya Rao",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ],
                Friday: [
                    { period: 1, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 4, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Microprocessors Lab",
                        faculty: "Prof. Ravi Teja",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ]
            }
        },
        {
            class: "EEE-A",
            department: "EEE",
            semester: 5,
            academicYear: "2025-26",
            room: "P-301",
            rows: {
                Monday: [
                    { period: 1, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    {
                        period: 2,
                        spanTo: 3,
                        subject: "Electrical Machines",
                        faculty: "Prof. Lakshmi Devi",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 4, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 5, spanTo: 7, subject: "Power Systems Lab", faculty: "Dr. Suresh Babu", room: "EE-LAB-1", type: "lab" }
                ],
                Tuesday: [
                    { period: 1, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    { period: 2, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 3, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 4, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    { period: 5, spanTo: 6, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    {
                        period: 7,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    }
                ],
                Wednesday: [
                    { period: 1, spanTo: 2, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 3, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    { period: 4, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    {
                        period: 5,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 6, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 7, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" }
                ],
                Thursday: [
                    { period: 1, subject: "Power Systems", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    { period: 2, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    {
                        period: 3,
                        spanTo: 4,
                        subject: "Electromagnetic Fields",
                        faculty: "Prof. Lakshmi Devi",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 5, subject: "Power Electronics", faculty: "Dr. Suresh Babu", room: "P-301", type: "theory" },
                    {
                        period: 6,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 7, subject: "Electrical Machines", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" }
                ],
                Friday: [
                    { period: 1, spanTo: 2, subject: "Control Systems", faculty: "Dr. Mahesh Gupta", room: "P-301", type: "theory" },
                    {
                        period: 3,
                        subject: "Transmission and Distribution",
                        faculty: "Dr. Mahesh Gupta",
                        room: "P-301",
                        type: "theory"
                    },
                    { period: 4, subject: "Electromagnetic Fields", faculty: "Prof. Lakshmi Devi", room: "P-301", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Electrical Machines Lab",
                        faculty: "Prof. Lakshmi Devi",
                        room: "EE-LAB-1",
                        type: "lab"
                    }
                ]
            }
        },
        {
            class: "CME-A",
            department: "CME",
            semester: 5,
            academicYear: "2025-26",
            room: "C-401",
            rows: {
                Monday: [
                    {
                        period: 1,
                        spanTo: 2,
                        subject: "Software Engineering",
                        faculty: "Dr. Meera Joshi",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 3, subject: "Embedded Systems", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    {
                        period: 4,
                        spanTo: 5,
                        subject: "Object Oriented Analysis & Design",
                        faculty: "Prof. Vikram Kumar",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 6, subject: "Cloud Computing", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" },
                    { period: 7, subject: "Programming", faculty: "Prof. Vikram Kumar", room: "C-401", type: "theory" }
                ],
                Tuesday: [
                    { period: 1, subject: "Embedded Systems", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    {
                        period: 2,
                        subject: "Object Oriented Analysis & Design",
                        faculty: "Prof. Vikram Kumar",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 3, subject: "Cloud Computing", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" },
                    { period: 4, subject: "Software Engineering", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" },
                    { period: 5, subject: "Embedded Systems", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    { period: 6, subject: "Computer Architecture", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    { period: 7, subject: "Software Engineering", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" }
                ],
                Wednesday: [
                    {
                        period: 1,
                        spanTo: 2,
                        subject: "Computer Architecture",
                        faculty: "Dr. Sneha Nair",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 3, subject: "Cloud Computing", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" },
                    { period: 4, subject: "Embedded Systems", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Computer Architecture Lab",
                        faculty: "Dr. Sneha Nair",
                        room: "CM-LAB-1",
                        type: "lab"
                    }
                ],
                Thursday: [
                    { period: 1, subject: "Computer Architecture", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    {
                        period: 2,
                        spanTo: 3,
                        subject: "Object Oriented Analysis & Design",
                        faculty: "Prof. Vikram Kumar",
                        room: "C-401",
                        type: "theory"
                    },
                    { period: 4, spanTo: 5, subject: "Programming", faculty: "Prof. Vikram Kumar", room: "C-401", type: "theory" },
                    { period: 6, subject: "Computer Architecture", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    { period: 7, subject: "Cloud Computing", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Programming", faculty: "Prof. Vikram Kumar", room: "C-401", type: "theory" },
                    { period: 2, subject: "Software Engineering", faculty: "Dr. Meera Joshi", room: "C-401", type: "theory" },
                    { period: 3, subject: "Embedded Systems", faculty: "Dr. Sneha Nair", room: "C-401", type: "theory" },
                    { period: 4, subject: "Programming", faculty: "Prof. Vikram Kumar", room: "C-401", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Programming Lab",
                        faculty: "Prof. Vikram Kumar",
                        room: "CM-LAB-1",
                        type: "lab"
                    }
                ]
            }
        },
        {
            class: "MEC-A",
            department: "MEC",
            semester: 5,
            academicYear: "2025-26",
            room: "M-501",
            rows: {
                Monday: [
                    { period: 1, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 2, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 3, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 4, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
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
                    { period: 1, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 2, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 3, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 4, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 5, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 6, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 7, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 2, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 3, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 4, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    {
                        period: 5,
                        spanTo: 6,
                        subject: "Thermodynamics",
                        faculty: "Prof. Harish Chandra",
                        room: "M-501",
                        type: "theory"
                    },
                    { period: 7, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" }
                ],
                Thursday: [
                    { period: 1, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 2, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 3, subject: "Manufacturing Technology", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 4, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Thermodynamics Lab",
                        faculty: "Prof. Harish Chandra",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    }
                ],
                Friday: [
                    { period: 1, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 2, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 3, subject: "Engineering Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 4, subject: "Thermodynamics", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" },
                    { period: 5, subject: "Fluid Mechanics", faculty: "Dr. Rajesh Pillai", room: "M-501", type: "theory" },
                    { period: 6, subject: "Material Science", faculty: "Dr. Sunita Rani", room: "M-501", type: "theory" },
                    { period: 7, subject: "Kinematics of Machinery", faculty: "Prof. Harish Chandra", room: "M-501", type: "theory" }
                ]
            }
        },
        {
            class: "CIVIL-A",
            department: "CIVIL",
            semester: 5,
            academicYear: "2025-26",
            room: "V-601",
            rows: {
                Monday: [
                    { period: 1, subject: "Surveying", faculty: "Prof. Deepak Sinha", room: "V-601", type: "theory" },
                    {
                        period: 2,
                        spanTo: 3,
                        subject: "Concrete Technology",
                        faculty: "Dr. Neha Kulkarni",
                        room: "V-601",
                        type: "theory"
                    },
                    {
                        period: 4,
                        spanTo: 5,
                        subject: "Structural Engineering",
                        faculty: "Dr. Venkat Prasad",
                        room: "V-601",
                        type: "theory"
                    },
                    { period: 6, subject: "Geotechnical Engineering", faculty: "Dr. Venkat Prasad", room: "V-601", type: "theory" },
                    { period: 7, subject: "Environmental Engineering", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" }
                ],
                Tuesday: [
                    { period: 1, subject: "Concrete Technology", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" },
                    { period: 2, subject: "Surveying", faculty: "Prof. Deepak Sinha", room: "V-601", type: "theory" },
                    { period: 3, subject: "Structural Engineering", faculty: "Dr. Venkat Prasad", room: "V-601", type: "theory" },
                    { period: 4, subject: "Environmental Engineering", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" },
                    {
                        period: 5,
                        subject: "Fluid Mechanics & Hydraulics",
                        faculty: "Prof. Deepak Sinha",
                        room: "V-601",
                        type: "theory"
                    },
                    { period: 6, subject: "Surveying", faculty: "Prof. Deepak Sinha", room: "V-601", type: "theory" },
                    { period: 7, subject: "Geotechnical Engineering", faculty: "Dr. Venkat Prasad", room: "V-601", type: "theory" }
                ],
                Wednesday: [
                    {
                        period: 1,
                        subject: "Fluid Mechanics & Hydraulics",
                        faculty: "Prof. Deepak Sinha",
                        room: "V-601",
                        type: "theory"
                    },
                    { period: 2, subject: "Environmental Engineering", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" },
                    {
                        period: 3,
                        spanTo: 4,
                        subject: "Geotechnical Engineering",
                        faculty: "Dr. Venkat Prasad",
                        room: "V-601",
                        type: "theory"
                    },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Concrete Technology Lab",
                        faculty: "Dr. Neha Kulkarni",
                        room: "CV-LAB-1",
                        type: "lab"
                    }
                ],
                Thursday: [
                    {
                        period: 1,
                        subject: "Fluid Mechanics & Hydraulics",
                        faculty: "Prof. Deepak Sinha",
                        room: "V-601",
                        type: "theory"
                    },
                    { period: 2, subject: "Structural Engineering", faculty: "Dr. Venkat Prasad", room: "V-601", type: "theory" },
                    { period: 3, subject: "Geotechnical Engineering", faculty: "Dr. Venkat Prasad", room: "V-601", type: "theory" },
                    { period: 4, subject: "Environmental Engineering", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" },
                    { period: 5, subject: "Surveying", faculty: "Prof. Deepak Sinha", room: "V-601", type: "theory" },
                    { period: 6, subject: "Concrete Technology", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" },
                    { period: 7, subject: "Surveying", faculty: "Prof. Deepak Sinha", room: "V-601", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Concrete Technology", faculty: "Dr. Neha Kulkarni", room: "V-601", type: "theory" },
                    {
                        period: 2,
                        spanTo: 3,
                        subject: "Fluid Mechanics & Hydraulics",
                        faculty: "Prof. Deepak Sinha",
                        room: "V-601",
                        type: "theory"
                    },
                    { period: 4, subject: "Structural Engineering", faculty: "Dr. Venkat Prasad", room: "V-601", type: "theory" },
                    { period: 5, spanTo: 7, subject: "Surveying Lab", faculty: "Prof. Deepak Sinha", room: "CV-LAB-1", type: "lab" }
                ]
            }
        }
    ]
};
