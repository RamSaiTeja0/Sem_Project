/**
 * Demo academic dataset — realistic fictional data for demonstrating the app.
 *
 * 12 faculty across 2 departments, 5 classes, 22 subjects,
 * 10 rooms, Monday-Friday, periods 1-7.
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
        title: "Semester V — Working Timetable (Demo Data)",
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
        { code: "CSE", name: "Computer Science & Engineering" },
        { code: "ECE", name: "Electronics & Communication Engineering" }
    ],
    rooms: [
        { code: "A-101", name: "Block A — Room 101", type: "classroom", capacity: 60 },
        { code: "A-102", name: "Block A — Room 102", type: "classroom", capacity: 60 },
        { code: "A-103", name: "Block A — Room 103", type: "classroom", capacity: 60 },
        { code: "E-201", name: "Block E — Room 201", type: "classroom", capacity: 60 },
        { code: "E-202", name: "Block E — Room 202", type: "classroom", capacity: 60 },
        { code: "CS-LAB-1", name: "Computer Lab 1", type: "lab", capacity: 35 },
        { code: "CS-LAB-2", name: "Computer Lab 2", type: "lab", capacity: 35 },
        { code: "CS-LAB-3", name: "Computer Lab 3", type: "lab", capacity: 35 },
        { code: "EC-LAB-1", name: "Electronics Lab 1", type: "lab", capacity: 30 },
        { code: "EC-LAB-2", name: "Embedded Systems Lab", type: "lab", capacity: 30 }
    ],
    subjects: [
        { code: "CS501", name: "Data Structures", department: "CSE", type: "theory" },
        { code: "CS502", name: "Database Management Systems", department: "CSE", type: "theory" },
        { code: "CS503", name: "Operating Systems", department: "CSE", type: "theory" },
        { code: "CS504", name: "Computer Networks", department: "CSE", type: "theory" },
        { code: "CS505", name: "Java Programming", department: "CSE", type: "theory" },
        { code: "CS506", name: "Web Technologies", department: "CSE", type: "theory" },
        { code: "CS507", name: "Software Engineering", department: "CSE", type: "theory" },
        { code: "CS508", name: "Machine Learning", department: "CSE", type: "theory" },
        { code: "CS551", name: "Data Structures Lab", department: "CSE", type: "lab" },
        { code: "CS552", name: "DBMS Lab", department: "CSE", type: "lab" },
        { code: "CS553", name: "Operating Systems Lab", department: "CSE", type: "lab" },
        { code: "CS554", name: "Java Programming Lab", department: "CSE", type: "lab" },
        { code: "CS555", name: "Web Technologies Lab", department: "CSE", type: "lab" },
        { code: "CS556", name: "Machine Learning Lab", department: "CSE", type: "lab" },
        { code: "EC501", name: "Digital Electronics", department: "ECE", type: "theory" },
        { code: "EC502", name: "Microprocessors", department: "ECE", type: "theory" },
        { code: "EC503", name: "Signals and Systems", department: "ECE", type: "theory" },
        { code: "EC504", name: "Communication Systems", department: "ECE", type: "theory" },
        { code: "EC505", name: "Embedded Systems", department: "ECE", type: "theory" },
        { code: "EC551", name: "Digital Electronics Lab", department: "ECE", type: "lab" },
        { code: "EC552", name: "Microprocessors Lab", department: "ECE", type: "lab" },
        { code: "EC553", name: "Embedded Systems Lab", department: "ECE", type: "lab" }
    ],
    faculty: [
        { id: "FAC01", name: "Dr. Arjun Rao", department: "CSE" },
        { id: "FAC02", name: "Dr. Priya Sharma", department: "CSE" },
        { id: "FAC03", name: "Prof. Kiran Reddy", department: "CSE" },
        { id: "FAC04", name: "Dr. Ananya Iyer", department: "CSE" },
        { id: "FAC05", name: "Dr. Rahul Varma", department: "CSE" },
        { id: "FAC06", name: "Prof. Sneha Nair", department: "CSE" },
        { id: "FAC07", name: "Dr. Vikram Kumar", department: "CSE" },
        { id: "FAC08", name: "Prof. Meera Joshi", department: "CSE" },
        { id: "FAC09", name: "Prof. Naveen Reddy", department: "ECE" },
        { id: "FAC10", name: "Dr. Kavya Rao", department: "ECE" },
        { id: "FAC11", name: "Dr. Anitha Menon", department: "ECE" },
        { id: "FAC12", name: "Prof. Ravi Teja", department: "ECE" }
    ],
    classes: [
        {
            class: "CSE-A",
            department: "CSE",
            semester: 5,
            room: "A-101",
            rows: {
                Monday: [
                    { period: 1, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" },
                    { period: 2, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 3, subject: "Machine Learning", faculty: "Dr. Vikram Kumar", room: "A-101", type: "theory" },
                    { period: 4, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 5, spanTo: 7, subject: "DBMS Lab", faculty: "Dr. Priya Sharma", room: "CS-LAB-1", type: "lab" }
                ],
                Tuesday: [
                    { period: 1, subject: "Software Engineering", faculty: "Prof. Sneha Nair", room: "A-101", type: "theory" },
                    { period: 2, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 3, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 4, subject: "Java Programming", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Java Programming Lab",
                        faculty: "Dr. Rahul Varma",
                        room: "CS-LAB-1",
                        type: "lab"
                    }
                ],
                Wednesday: [
                    { period: 1, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 2, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 3, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" },
                    { period: 4, subject: "Machine Learning", faculty: "Dr. Vikram Kumar", room: "A-101", type: "theory" },
                    { period: 5, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 6, subject: "Java Programming", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" },
                    { period: 7, subject: "Software Engineering", faculty: "Prof. Sneha Nair", room: "A-101", type: "theory" }
                ],
                Thursday: [
                    { period: 1, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 2, subject: "Java Programming", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" },
                    { period: 4, subject: "Computer Networks", faculty: "Dr. Ananya Iyer", room: "A-101", type: "theory" },
                    { period: 5, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 6, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Operating Systems", faculty: "Prof. Kiran Reddy", room: "A-101", type: "theory" },
                    { period: 2, subject: "Machine Learning", faculty: "Dr. Vikram Kumar", room: "A-101", type: "theory" },
                    { period: 3, subject: "Data Structures", faculty: "Dr. Arjun Rao", room: "A-101", type: "theory" },
                    { period: 5, subject: "Database Management Systems", faculty: "Dr. Priya Sharma", room: "A-101", type: "theory" },
                    { period: 6, subject: "Java Programming", faculty: "Dr. Rahul Varma", room: "A-101", type: "theory" },
                    { period: 7, subject: "Software Engineering", faculty: "Prof. Sneha Nair", room: "A-101", type: "theory" }
                ]
            }
        },
        {
            class: "CSE-B",
            department: "CSE",
            semester: 5,
            room: "A-102",
            rows: {
                Monday: [
                    { period: 2, subject: "Operating Systems", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 4, subject: "Data Structures", faculty: "Prof. Meera Joshi", room: "A-102", type: "theory" },
                    { period: 5, subject: "Machine Learning", faculty: "Dr. Vikram Kumar", room: "A-102", type: "theory" },
                    { period: 6, subject: "Computer Networks", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" }
                ],
                Tuesday: [
                    { period: 1, subject: "Machine Learning", faculty: "Dr. Vikram Kumar", room: "A-102", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 3, subject: "Database Management Systems", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 4, subject: "Operating Systems", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 5, subject: "Computer Networks", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 6, subject: "Java Programming", faculty: "Prof. Sneha Nair", room: "A-102", type: "theory" },
                    { period: 7, subject: "Data Structures", faculty: "Prof. Meera Joshi", room: "A-102", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Database Management Systems", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 3, subject: "Java Programming", faculty: "Prof. Sneha Nair", room: "A-102", type: "theory" },
                    { period: 4, subject: "Operating Systems", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Data Structures Lab",
                        faculty: "Prof. Meera Joshi",
                        room: "CS-LAB-2",
                        type: "lab"
                    }
                ],
                Thursday: [
                    { period: 1, subject: "Web Technologies", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 2, subject: "Data Structures", faculty: "Prof. Meera Joshi", room: "A-102", type: "theory" },
                    { period: 3, subject: "Computer Networks", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" },
                    { period: 4, subject: "Database Management Systems", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Web Technologies Lab",
                        faculty: "Dr. Ananya Iyer",
                        room: "CS-LAB-2",
                        type: "lab"
                    }
                ],
                Friday: [
                    { period: 1, subject: "Operating Systems", faculty: "Dr. Priya Sharma", room: "A-102", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Dr. Ananya Iyer", room: "A-102", type: "theory" },
                    { period: 3, subject: "Data Structures", faculty: "Prof. Meera Joshi", room: "A-102", type: "theory" },
                    { period: 4, subject: "Machine Learning", faculty: "Dr. Vikram Kumar", room: "A-102", type: "theory" },
                    { period: 5, subject: "Database Management Systems", faculty: "Dr. Arjun Rao", room: "A-102", type: "theory" },
                    { period: 6, subject: "Java Programming", faculty: "Prof. Sneha Nair", room: "A-102", type: "theory" },
                    { period: 7, subject: "Computer Networks", faculty: "Prof. Kiran Reddy", room: "A-102", type: "theory" }
                ]
            }
        },
        {
            class: "CSE-C",
            department: "CSE",
            semester: 5,
            room: "A-103",
            rows: {
                Monday: [
                    { period: 1, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-103", type: "theory" },
                    { period: 2, subject: "Data Structures", faculty: "Dr. Rahul Varma", room: "A-103", type: "theory" },
                    { period: 3, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-103", type: "theory" },
                    { period: 4, subject: "Machine Learning", faculty: "Dr. Priya Sharma", room: "A-103", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Operating Systems Lab",
                        faculty: "Prof. Meera Joshi",
                        room: "CS-LAB-3",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    { period: 1, subject: "Operating Systems", faculty: "Prof. Meera Joshi", room: "A-103", type: "theory" },
                    { period: 2, subject: "Data Structures", faculty: "Dr. Rahul Varma", room: "A-103", type: "theory" },
                    { period: 3, subject: "Java Programming", faculty: "Dr. Vikram Kumar", room: "A-103", type: "theory" },
                    { period: 4, subject: "Web Technologies", faculty: "Prof. Sneha Nair", room: "A-103", type: "theory" },
                    { period: 5, subject: "Machine Learning", faculty: "Dr. Priya Sharma", room: "A-103", type: "theory" },
                    { period: 6, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-103", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Operating Systems", faculty: "Prof. Meera Joshi", room: "A-103", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Prof. Sneha Nair", room: "A-103", type: "theory" },
                    { period: 3, subject: "Java Programming", faculty: "Dr. Vikram Kumar", room: "A-103", type: "theory" },
                    { period: 4, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-103", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Machine Learning Lab",
                        faculty: "Dr. Priya Sharma",
                        room: "CS-LAB-3",
                        type: "lab"
                    }
                ],
                Thursday: [
                    { period: 1, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-103", type: "theory" },
                    { period: 3, subject: "Operating Systems", faculty: "Prof. Meera Joshi", room: "A-103", type: "theory" },
                    { period: 4, subject: "Machine Learning", faculty: "Dr. Priya Sharma", room: "A-103", type: "theory" },
                    { period: 5, subject: "Java Programming", faculty: "Dr. Vikram Kumar", room: "A-103", type: "theory" },
                    { period: 6, subject: "Data Structures", faculty: "Dr. Rahul Varma", room: "A-103", type: "theory" },
                    { period: 7, subject: "Web Technologies", faculty: "Prof. Sneha Nair", room: "A-103", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Data Structures", faculty: "Dr. Rahul Varma", room: "A-103", type: "theory" },
                    { period: 2, subject: "Web Technologies", faculty: "Prof. Sneha Nair", room: "A-103", type: "theory" },
                    { period: 3, subject: "Software Engineering", faculty: "Prof. Kiran Reddy", room: "A-103", type: "theory" },
                    { period: 4, subject: "Computer Networks", faculty: "Dr. Arjun Rao", room: "A-103", type: "theory" },
                    { period: 5, subject: "Java Programming", faculty: "Dr. Vikram Kumar", room: "A-103", type: "theory" },
                    { period: 6, subject: "Operating Systems", faculty: "Prof. Meera Joshi", room: "A-103", type: "theory" }
                ]
            }
        },
        {
            class: "ECE-A",
            department: "ECE",
            semester: 5,
            room: "E-201",
            rows: {
                Monday: [
                    { period: 2, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 3, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 4, subject: "Signals and Systems", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Embedded Systems Lab",
                        faculty: "Prof. Ravi Teja",
                        room: "EC-LAB-1",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    { period: 1, subject: "Microprocessors", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 2, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 5, spanTo: 7, subject: "Microprocessors Lab", faculty: "Dr. Kavya Rao", room: "EC-LAB-1", type: "lab" }
                ],
                Wednesday: [
                    { period: 1, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 3, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 4, subject: "Microprocessors", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 5, subject: "Signals and Systems", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 6, subject: "Embedded Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" }
                ],
                Thursday: [
                    { period: 1, subject: "Signals and Systems", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 3, subject: "Embedded Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 4, subject: "Communication Systems", faculty: "Prof. Ravi Teja", room: "E-201", type: "theory" },
                    { period: 5, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 7, subject: "Microprocessors", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" }
                ],
                Friday: [
                    { period: 1, subject: "Microprocessors", faculty: "Dr. Kavya Rao", room: "E-201", type: "theory" },
                    { period: 2, subject: "Signals and Systems", faculty: "Dr. Anitha Menon", room: "E-201", type: "theory" },
                    { period: 3, subject: "Digital Electronics", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    { period: 4, subject: "Embedded Systems", faculty: "Prof. Naveen Reddy", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Digital Electronics Lab",
                        faculty: "Prof. Naveen Reddy",
                        room: "EC-LAB-1",
                        type: "lab"
                    }
                ]
            }
        },
        {
            class: "ECE-B",
            department: "ECE",
            semester: 5,
            room: "E-202",
            rows: {
                Monday: [
                    { period: 1, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 3, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    { period: 4, subject: "Embedded Systems", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 6, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 7, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" }
                ],
                Tuesday: [
                    { period: 3, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 5, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 7, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" }
                ],
                Wednesday: [
                    { period: 1, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 4, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Microprocessors Lab",
                        faculty: "Prof. Ravi Teja",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ],
                Thursday: [
                    { period: 1, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 2, subject: "Signals and Systems", faculty: "Prof. Naveen Reddy", room: "E-202", type: "theory" },
                    { period: 4, subject: "Embedded Systems", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Digital Electronics Lab",
                        faculty: "Dr. Anitha Menon",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ],
                Friday: [
                    { period: 1, subject: "Communication Systems", faculty: "Dr. Anitha Menon", room: "E-202", type: "theory" },
                    { period: 2, subject: "Digital Electronics", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 3, subject: "Embedded Systems", faculty: "Dr. Kavya Rao", room: "E-202", type: "theory" },
                    { period: 4, subject: "Microprocessors", faculty: "Prof. Ravi Teja", room: "E-202", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Embedded Systems Lab",
                        faculty: "Prof. Ravi Teja",
                        room: "EC-LAB-2",
                        type: "lab"
                    }
                ]
            }
        }
    ]
};
