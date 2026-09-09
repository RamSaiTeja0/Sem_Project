/**
 * Demo academic dataset — realistic academic data for demonstrating the app.
 *
 * 21 faculty across 3 branches (CME, EEE, MEC),
 * CME-A (2026-27), EEE-B / DEEE-B (2025-2026), and MEC-A / DME (2026-27) timetables,
 * Monday-Saturday, periods 1-7.
 */

module.exports = {
    meta: {
        institution: "ADITYA INSTITUTE OF TECHNOLOGY AND MANAGEMENT",
        title: "POLYTECHNIC C23 - V SEM TIME TABLE",
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
        { code: "CME", name: "Computer Engineering" },
        { code: "EEE", name: "Electrical and Electronics Engineering" },
        { code: "MEC", name: "Mechanical Engineering" }
    ],
    rooms: [
        { code: "C-401", name: "Block C — Room 401", type: "classroom", capacity: 60 },
        { code: "E-201", name: "Block E — Room 201", type: "classroom", capacity: 60 },
        { code: "M-501", name: "Block M — Room 501", type: "classroom", capacity: 60 },
        { code: "CM-LAB-1", name: "Computer Engineering Lab", type: "lab", capacity: 35 },
        { code: "EE-LAB-1", name: "Electrical Machines Lab", type: "lab", capacity: 30 },
        { code: "ME-WORKSHOP", name: "Mechanical Workshop", type: "lab", capacity: 40 }
    ],
    subjects: [
        // CME — 9 Subjects
        { code: "CM-501", name: "Industrial Management and Entrepreneurship", department: "CME", type: "theory" },
        { code: "CM-502", name: "Big Data & Cloud Computing", department: "CME", type: "theory" },
        { code: "CM-503", name: "Android Programming", department: "CME", type: "theory" },
        { code: "CM-504", name: "Internet Of Things", department: "CME", type: "theory" },
        { code: "CM-505", name: "Python Programming", department: "CME", type: "theory" },
        { code: "CM-506", name: "Android Programming Lab", department: "CME", type: "lab" },
        { code: "CM-507", name: "Python Programming Lab", department: "CME", type: "lab" },
        { code: "CM-508", name: "Life Skills", department: "CME", type: "theory" },
        { code: "CM-509", name: "Project work", department: "CME", type: "theory" },
        // EEE — 10 Subjects
        { code: "EE-401", name: "Electrical Installation & Estimation", department: "EEE", type: "theory" },
        { code: "EE-402", name: "Electrical Machines-II", department: "EEE", type: "theory" },
        { code: "EE-403", name: "Power System – I", department: "EEE", type: "theory" },
        { code: "EE-404", name: "Power Electronics & PLC", department: "EEE", type: "theory" },
        { code: "EE-405", name: "General Mechanical Engineering", department: "EEE", type: "theory" },
        { code: "EE-406", name: "Electrical Engineering Drawing", department: "EEE", type: "theory" },
        { code: "EE-407", name: "Electrical Machines-II Laboratory", department: "EEE", type: "lab" },
        { code: "EE-408", name: "Communications Skills Laboratory", department: "EEE", type: "lab" },
        { code: "EE-409", name: "Power Electronics Laboratory", department: "EEE", type: "lab" },
        { code: "EE-410", name: "Hybrid Power Systems Laboratory", department: "EEE", type: "lab" },
        // MEC — 11 Subjects
        { code: "M-501", name: "Industrial Management and Entrepreneurship", department: "MEC", type: "theory" },
        { code: "M-502", name: "Industrial Engineering and Quality Control", department: "MEC", type: "theory" },
        { code: "M-503", name: "Green Energy & Thermal Systems", department: "MEC", type: "theory" },
        { code: "M-504", name: "Industrial Automation & 3D Printing", department: "MEC", type: "theory" },
        { code: "M-505", name: "Refrigeration and Air Conditioning", department: "MEC", type: "theory" },
        { code: "M-506", name: "CAD Lab Practice", department: "MEC", type: "lab" },
        { code: "M-507", name: "CAM Lab Practice", department: "MEC", type: "lab" },
        { code: "M-508", name: "Life Skills Lab", department: "MEC", type: "lab" },
        { code: "M-509", name: "Refrigeration and Air Conditioning Lab", department: "MEC", type: "lab" },
        { code: "M-510", name: "Training Cum Production Work Shop", department: "MEC", type: "lab" },
        { code: "M-511", name: "Project Work", department: "MEC", type: "lab" }
    ],
    faculty: [
        // CME Faculty
        {
            id: "FAC001",
            name: "Sri B. Gopala Rao",
            department: "CME",
            designation: "Professor",
            phone: "9493438305",
            email: "b.gopala.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC002",
            name: "Ms. G. Sandhya Rani",
            department: "CME",
            designation: "Associate Professor",
            phone: "8142237495",
            email: "g.sandhya.rani@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC003",
            name: "Ms. Debadatta Bhattacharya",
            department: "CME",
            designation: "Assistant Professor",
            phone: "7396726904",
            email: "debadatta.bhattacharya@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC004",
            name: "Mrs. A. Sravanthi",
            department: "CME",
            designation: "Assistant Professor",
            phone: "7842459355",
            email: "a.sravanthi@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC005",
            name: "Ms. B. Kusuma",
            department: "CME",
            designation: "Assistant Professor",
            phone: "9392980517",
            email: "b.kusuma@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC006",
            name: "Mrs. K. Anitha",
            department: "CME",
            designation: "Assistant Professor",
            phone: "9963206541",
            email: "k.anitha@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC007",
            name: "Mr. Ch. Sai Kishore",
            department: "CME",
            designation: "Assistant Professor",
            phone: "7801056541",
            email: "ch.sai.kishore@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        // EEE Faculty
        {
            id: "FAC008",
            name: "A.MANINDRA",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "a.manindra@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC009",
            name: "M.DALAYYA",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "m.dalayya@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC010",
            name: "T.RAJENDRA PRASAD",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "t.rajendra.prasad@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC011",
            name: "D.SAGAR KUMAR",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "d.sagar.kumar@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC012",
            name: "P.DAMODHARARAO",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "p.damodhararao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC013",
            name: "G.BHARATH REDDY",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "g.bharath.reddy@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC014",
            name: "T.PAVAN VARMA",
            department: "EEE",
            designation: "Assistant Professor",
            phone: null,
            email: "t.pavan.varma@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        // MEC Faculty
        {
            id: "FAC015",
            name: "Sri B.Gopala Rao",
            department: "MEC",
            designation: "Professor",
            phone: "9493438305",
            email: "b.gopala.rao.mec@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC016",
            name: "Sri P.Suresh",
            department: "MEC",
            designation: "Associate Professor",
            phone: "9642408351",
            email: "p.suresh@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC017",
            name: "Sri B.Siva Srinivas",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "9491816614",
            email: "b.siva.srinivas@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC018",
            name: "Sri K.Ramachandra Rao",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "8688007893",
            email: "k.ramachandra.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC019",
            name: "Sri P.Damodhara Rao",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "8317526759",
            email: "p.damodhara.rao@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC020",
            name: "Smt.K.Anitha",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "9963206541",
            email: "k.anitha.mec@college.edu",
            status: "active",
            maxWeeklyPeriods: 20
        },
        {
            id: "FAC021",
            name: "Sri K.Prasad",
            department: "MEC",
            designation: "Assistant Professor",
            phone: "9581177640",
            email: "k.prasad@college.edu",
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
                    { period: 5, spanTo: 7, subject: "Life Skills", faculty: "Mrs. K. Anitha", room: "CM-LAB-1", type: "lab" }
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
            class: "EEE-B",
            department: "EEE",
            semester: 5,
            academicYear: "2025-2026",
            room: "E-201",
            rows: {
                Monday: [
                    { period: 1, subject: "Electrical Installation & Estimation", faculty: "A.MANINDRA", room: "E-201", type: "theory" },
                    { period: 2, subject: "Electrical Machines-II", faculty: "M.DALAYYA", room: "E-201", type: "theory" },
                    { period: 3, subject: "Power System – I", faculty: "T.RAJENDRA PRASAD", room: "E-201", type: "theory" },
                    { period: 4, subject: "Power Electronics & PLC", faculty: "D.SAGAR KUMAR", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Electrical Machines-II Laboratory",
                        faculty: "M.DALAYYA",
                        room: "EE-LAB-1",
                        type: "lab"
                    }
                ],
                Tuesday: [
                    { period: 1, subject: "Electrical Machines-II", faculty: "M.DALAYYA", room: "E-201", type: "theory" },
                    { period: 2, subject: "Electrical Installation & Estimation", faculty: "A.MANINDRA", room: "E-201", type: "theory" },
                    { period: 3, subject: "Power System – I", faculty: "T.RAJENDRA PRASAD", room: "E-201", type: "theory" },
                    { period: 4, subject: "General Mechanical Engineering", faculty: "P.DAMODHARARAO", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Hybrid Power Systems Laboratory",
                        faculty: "A.MANINDRA",
                        room: "EE-LAB-1",
                        type: "lab"
                    }
                ],
                Wednesday: [
                    { period: 1, subject: "Electrical Machines-II", faculty: "M.DALAYYA", room: "E-201", type: "theory" },
                    { period: 2, subject: "Power System – I", faculty: "T.RAJENDRA PRASAD", room: "E-201", type: "theory" },
                    { period: 3, subject: "Power Electronics & PLC", faculty: "D.SAGAR KUMAR", room: "E-201", type: "theory" },
                    { period: 4, subject: "General Mechanical Engineering", faculty: "P.DAMODHARARAO", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Communications Skills Laboratory",
                        faculty: "T.PAVAN VARMA",
                        room: "EE-LAB-1",
                        type: "lab"
                    }
                ],
                Thursday: [
                    { period: 1, subject: "Electrical Machines-II", faculty: "M.DALAYYA", room: "E-201", type: "theory" },
                    { period: 2, subject: "Power System – I", faculty: "T.RAJENDRA PRASAD", room: "E-201", type: "theory" },
                    { period: 3, subject: "Electrical Installation & Estimation", faculty: "A.MANINDRA", room: "E-201", type: "theory" },
                    { period: 4, subject: "General Mechanical Engineering", faculty: "P.DAMODHARARAO", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Electrical Engineering Drawing",
                        faculty: "G.BHARATH REDDY",
                        room: "E-201",
                        type: "theory"
                    }
                ],
                Friday: [
                    { period: 1, subject: "Electrical Machines-II", faculty: "M.DALAYYA", room: "E-201", type: "theory" },
                    { period: 2, subject: "Power Electronics & PLC", faculty: "D.SAGAR KUMAR", room: "E-201", type: "theory" },
                    { period: 3, subject: "General Mechanical Engineering", faculty: "P.DAMODHARARAO", room: "E-201", type: "theory" },
                    { period: 4, subject: "Electrical Installation & Estimation", faculty: "A.MANINDRA", room: "E-201", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Power Electronics Laboratory",
                        faculty: "T.RAJENDRA PRASAD",
                        room: "EE-LAB-1",
                        type: "lab"
                    }
                ],
                Saturday: [
                    { period: 1, subject: "Power Electronics & PLC", faculty: "D.SAGAR KUMAR", room: "E-201", type: "theory" },
                    {
                        period: 2,
                        spanTo: 4,
                        subject: "Electrical Engineering Drawing",
                        faculty: "G.BHARATH REDDY",
                        room: "E-201",
                        type: "theory"
                    },
                    { period: 5, subject: "Library / Counselling", faculty: null, room: "E-201", type: "activity" },
                    { period: 6, spanTo: 7, subject: "Games / Sports", faculty: null, room: "E-201", type: "activity" }
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
                    {
                        period: 1,
                        spanTo: 3,
                        subject: "CAD/CAM LAB",
                        faculty: "Sri B.Siva Srinivas",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    },
                    { period: 4, subject: "Refrigeration and Air Conditioning", faculty: "Sri P.Damodhara Rao", room: "M-501", type: "theory" },
                    { period: 5, subject: "Industrial Management and Entrepreneurship", faculty: "Sri B.Gopala Rao", room: "M-501", type: "theory" },
                    { period: 6, subject: "Industrial Automation & 3D Printing", faculty: "Sri K.Ramachandra Rao", room: "M-501", type: "theory" },
                    { period: 7, subject: "Industrial Engineering and Quality Control", faculty: "Sri P.Suresh", room: "M-501", type: "theory" }
                ],
                Tuesday: [
                    {
                        period: 1,
                        spanTo: 3,
                        subject: "CAD/CAM LAB",
                        faculty: "Sri P.Damodhara Rao",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    },
                    { period: 4, subject: "Green Energy & Thermal Systems", faculty: "Sri B.Siva Srinivas", room: "M-501", type: "theory" },
                    { period: 5, subject: "Industrial Management and Entrepreneurship", faculty: "Sri B.Gopala Rao", room: "M-501", type: "theory" },
                    { period: 6, subject: "Industrial Engineering and Quality Control", faculty: "Sri P.Suresh", room: "M-501", type: "theory" },
                    { period: 7, subject: "TPC", faculty: null, room: "M-501", type: "activity" }
                ],
                Wednesday: [
                    {
                        period: 1,
                        spanTo: 3,
                        subject: "TCPW / R & AC Lab",
                        faculty: "Sri P.Damodhara Rao",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    },
                    { period: 4, subject: "Industrial Automation & 3D Printing", faculty: "Sri K.Ramachandra Rao", room: "M-501", type: "theory" },
                    { period: 5, subject: "Green Energy & Thermal Systems", faculty: "Sri B.Siva Srinivas", room: "M-501", type: "theory" },
                    { period: 6, subject: "Green Energy & Thermal Systems", faculty: "Sri B.Siva Srinivas", room: "M-501", type: "theory" },
                    { period: 7, subject: "Refrigeration and Air Conditioning", faculty: "Sri P.Damodhara Rao", room: "M-501", type: "theory" }
                ],
                Thursday: [
                    { period: 1, subject: "Refrigeration and Air Conditioning", faculty: "Sri P.Damodhara Rao", room: "M-501", type: "theory" },
                    { period: 2, subject: "Refrigeration and Air Conditioning", faculty: "Sri P.Damodhara Rao", room: "M-501", type: "theory" },
                    { period: 3, subject: "Industrial Management and Entrepreneurship", faculty: "Sri B.Gopala Rao", room: "M-501", type: "theory" },
                    {
                        period: 4,
                        spanTo: 6,
                        subject: "TCPW / R & AC Lab",
                        faculty: "Sri K.Prasad",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    },
                    { period: 7, subject: "Library / Counselling", faculty: null, room: "M-501", type: "activity" }
                ],
                Friday: [
                    { period: 1, subject: "Industrial Engineering and Quality Control", faculty: "Sri P.Suresh", room: "M-501", type: "theory" },
                    { period: 2, subject: "Industrial Management and Entrepreneurship", faculty: "Sri B.Gopala Rao", room: "M-501", type: "theory" },
                    { period: 3, subject: "Refrigeration and Air Conditioning", faculty: "Sri P.Damodhara Rao", room: "M-501", type: "theory" },
                    { period: 4, subject: "Green Energy & Thermal Systems", faculty: "Sri B.Siva Srinivas", room: "M-501", type: "theory" },
                    {
                        period: 5,
                        spanTo: 7,
                        subject: "Project Work",
                        faculty: "Sri B.Siva Srinivas",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    }
                ],
                Saturday: [
                    {
                        period: 1,
                        spanTo: 3,
                        subject: "Life Skills Lab",
                        faculty: "Smt.K.Anitha",
                        room: "ME-WORKSHOP",
                        type: "lab"
                    },
                    { period: 4, subject: "Green Energy & Thermal Systems", faculty: "Sri B.Siva Srinivas", room: "M-501", type: "theory" },
                    { period: 5, subject: "Industrial Automation & 3D Printing", faculty: "Sri K.Ramachandra Rao", room: "M-501", type: "theory" },
                    { period: 6, subject: "Industrial Engineering and Quality Control", faculty: "Sri P.Suresh", room: "M-501", type: "theory" },
                    { period: 7, subject: "Industrial Management and Entrepreneurship", faculty: "Sri B.Gopala Rao", room: "M-501", type: "theory" }
                ]
            }
        }
    ]
};
