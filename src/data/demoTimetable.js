/**
 * Demo timetable — 10 faculty, Monday–Friday, periods 1–7, three classes.
 *
 * Internally consistent by construction: no faculty is ever scheduled in two
 * classes at the same day + period, which the validator enforces on load.
 * CSE-A is the primary class shown in the Primary Timetable section.
 *
 * Replace this by importing an Excel/CSV file at runtime, or swap the whole
 * module for a database-backed loader — nothing downstream changes.
 */

module.exports = {
    meta: {
        institution: 'Institute of Technology',
        title: 'Semester V — Working Timetable',
        primaryClass: 'CSE-A',
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        periods: [1, 2, 3, 4, 5, 6, 7],
        periodTimings: {
            '1': { start: '09:00', end: '09:50' },
            '2': { start: '09:50', end: '10:40' },
            '3': { start: '10:50', end: '11:40' },
            '4': { start: '11:40', end: '12:30' },
            '5': { start: '13:20', end: '14:10' },
            '6': { start: '14:10', end: '15:00' },
            '7': { start: '15:10', end: '16:00' }
        }
    },

    faculty: [
        { id: 'FAC01', name: 'Dr. Anand Rao',      department: 'CSE' },
        { id: 'FAC02', name: 'Dr. Meera Nair',     department: 'CSE' },
        { id: 'FAC03', name: 'Prof. Kiran Kumar',  department: 'CSE' },
        { id: 'FAC04', name: 'Prof. Priya Sharma', department: 'CSE' },
        { id: 'FAC05', name: 'Dr. Suresh Babu',    department: 'CSE' },
        { id: 'FAC06', name: 'Prof. Arun Prasad',  department: 'CSE' },
        { id: 'FAC07', name: 'Dr. Deepa Iyer',     department: 'ECE' },
        { id: 'FAC08', name: 'Prof. Naveen Reddy', department: 'ECE' },
        { id: 'FAC09', name: 'Dr. Latha Menon',    department: 'ECE' },
        { id: 'FAC10', name: 'Mr. Sai Kishore',    department: 'CSE' }
    ],

    classes: [
        {
            class: 'CSE-A',
            room: 'A-101',
            rows: {
                Monday: [
                    { period: 1, subject: 'DBMS',   faculty: 'Dr. Anand Rao' },
                    { period: 2, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 3, subject: 'CN',     faculty: 'Prof. Kiran Kumar' },
                    { period: 4, subject: 'Java',   faculty: 'Prof. Priya Sharma' },
                    { period: 5, subject: 'Python', faculty: 'Dr. Suresh Babu' }
                ],
                Tuesday: [
                    { period: 1, subject: 'CN',     faculty: 'Prof. Kiran Kumar' },
                    { period: 2, subject: 'DBMS',   faculty: 'Dr. Anand Rao' },
                    { period: 3, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 4, subject: 'Python', faculty: 'Dr. Suresh Babu' },
                    { period: 5, subject: 'Java',   faculty: 'Prof. Priya Sharma' },
                    { period: 6, subject: 'DSA',    faculty: 'Prof. Arun Prasad' }
                ],
                Wednesday: [
                    { period: 1, subject: 'Java', faculty: 'Prof. Priya Sharma' },
                    { period: 2, subject: 'CN',   faculty: 'Prof. Kiran Kumar' },
                    { period: 3, subject: 'DBMS', faculty: 'Dr. Anand Rao' },
                    { period: 4, subject: 'SE',   faculty: 'Mr. Sai Kishore' },
                    { period: 5, spanTo: 7, subject: 'DBMS Lab', faculty: 'Dr. Anand Rao', room: 'Lab-1' }
                ],
                Thursday: [
                    { period: 1, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 2, subject: 'Python', faculty: 'Dr. Suresh Babu' },
                    { period: 3, subject: 'Java',   faculty: 'Prof. Priya Sharma' },
                    { period: 4, subject: 'DSA',    faculty: 'Prof. Arun Prasad' },
                    { period: 5, subject: 'CN',     faculty: 'Prof. Kiran Kumar' },
                    { period: 6, subject: 'SE',     faculty: 'Mr. Sai Kishore' }
                ],
                Friday: [
                    { period: 1, subject: 'DSA',    faculty: 'Prof. Arun Prasad' },
                    { period: 2, subject: 'SE',     faculty: 'Mr. Sai Kishore' },
                    { period: 3, subject: 'Python', faculty: 'Dr. Suresh Babu' },
                    { period: 4, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 5, spanTo: 7, subject: 'Python Lab', faculty: 'Dr. Suresh Babu', room: 'Lab-2' }
                ]
            }
        },

        {
            class: 'CSE-B',
            room: 'A-102',
            rows: {
                Monday: [
                    { period: 1, subject: 'DBMS',   faculty: 'Dr. Deepa Iyer' },
                    { period: 2, subject: 'Java',   faculty: 'Prof. Naveen Reddy' },
                    { period: 3, subject: 'DSA',    faculty: 'Dr. Latha Menon' },
                    { period: 4, subject: 'SE',     faculty: 'Prof. Arun Prasad' },
                    { period: 5, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 6, subject: 'CN',     faculty: 'Prof. Kiran Kumar' },
                    { period: 7, subject: 'Python', faculty: 'Prof. Priya Sharma' }
                ],
                Tuesday: [
                    { period: 1, subject: 'Java',   faculty: 'Prof. Naveen Reddy' },
                    { period: 2, subject: 'DSA',    faculty: 'Dr. Latha Menon' },
                    { period: 3, subject: 'DBMS',   faculty: 'Dr. Deepa Iyer' },
                    { period: 4, subject: 'SE',     faculty: 'Prof. Arun Prasad' },
                    { period: 5, subject: 'SE',     faculty: 'Mr. Sai Kishore' },
                    { period: 6, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 7, subject: 'CN',     faculty: 'Prof. Kiran Kumar' }
                ],
                Wednesday: [
                    { period: 1, subject: 'DBMS',   faculty: 'Dr. Deepa Iyer' },
                    { period: 2, subject: 'Java',   faculty: 'Prof. Naveen Reddy' },
                    { period: 3, subject: 'DSA',    faculty: 'Dr. Latha Menon' },
                    { period: 4, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 5, subject: 'CN',     faculty: 'Prof. Kiran Kumar' },
                    { period: 6, subject: 'Python', faculty: 'Prof. Priya Sharma' },
                    { period: 7, subject: 'SE',     faculty: 'Prof. Arun Prasad' }
                ],
                Thursday: [
                    { period: 1, subject: 'DSA',    faculty: 'Dr. Latha Menon' },
                    { period: 2, subject: 'DBMS',   faculty: 'Dr. Deepa Iyer' },
                    { period: 3, subject: 'Java',   faculty: 'Prof. Naveen Reddy' },
                    { period: 4, subject: 'OS',     faculty: 'Dr. Meera Nair' },
                    { period: 5, subject: 'SE',     faculty: 'Mr. Sai Kishore' },
                    { period: 6, subject: 'Python', faculty: 'Prof. Priya Sharma' },
                    { period: 7, subject: 'CN',     faculty: 'Prof. Kiran Kumar' }
                ],
                Friday: [
                    { period: 1, subject: 'DBMS',   faculty: 'Dr. Deepa Iyer' },
                    { period: 2, subject: 'Java',   faculty: 'Prof. Naveen Reddy' },
                    { period: 3, subject: 'DSA',    faculty: 'Dr. Latha Menon' },
                    { period: 4, subject: 'SE',     faculty: 'Prof. Arun Prasad' },
                    { period: 5, subject: 'CN',     faculty: 'Prof. Kiran Kumar' },
                    { period: 6, subject: 'Python', faculty: 'Prof. Priya Sharma' },
                    { period: 7, subject: 'OS',     faculty: 'Dr. Meera Nair' }
                ]
            }
        },

        {
            class: 'ECE-A',
            room: 'E-201',
            rows: {
                Monday: [
                    { period: 4, subject: 'Networks', faculty: 'Dr. Deepa Iyer' },
                    { period: 5, subject: 'EDC',      faculty: 'Prof. Naveen Reddy' },
                    { period: 6, subject: 'Signals',  faculty: 'Dr. Latha Menon' }
                ],
                Tuesday: [
                    { period: 4, subject: 'Signals',  faculty: 'Dr. Latha Menon' },
                    { period: 5, subject: 'Networks', faculty: 'Dr. Deepa Iyer' },
                    { period: 6, subject: 'EDC',      faculty: 'Prof. Naveen Reddy' }
                ],
                Wednesday: [
                    { period: 4, subject: 'EDC',      faculty: 'Prof. Naveen Reddy' },
                    { period: 5, subject: 'Signals',  faculty: 'Dr. Latha Menon' },
                    { period: 6, subject: 'Networks', faculty: 'Dr. Deepa Iyer' }
                ],
                Thursday: [
                    { period: 4, subject: 'Networks', faculty: 'Dr. Deepa Iyer' },
                    { period: 5, subject: 'EDC',      faculty: 'Prof. Naveen Reddy' },
                    { period: 6, subject: 'Signals',  faculty: 'Dr. Latha Menon' }
                ],
                Friday: [
                    { period: 4, subject: 'Signals',  faculty: 'Dr. Latha Menon' },
                    { period: 5, subject: 'Networks', faculty: 'Dr. Deepa Iyer' },
                    { period: 6, subject: 'EDC',      faculty: 'Prof. Naveen Reddy' }
                ]
            }
        }
    ]
};
