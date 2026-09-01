#!/usr/bin/env node
/**
 * One-shot database setup: create the tables and seed the demo data.
 *
 *   npm run db:setup
 *
 * Safe to run repeatedly. Tables are created only if absent and the demo rows
 * are inserted only when the timetable is empty, so this never duplicates data
 * and never overwrites a timetable you have already built.
 *
 * The server does the same thing automatically at startup; this script exists
 * so you can initialize the database — and see the result — before running it.
 */
const db = require('../src/db/pool');
const seeder = require('../src/db/seed');
const repository = require('../src/db/repository');

async function main() {
    if (!db.isConfigured()) {
        console.error(
            'DATABASE_URL is not set.\n\n' +
            '  1. Copy .env.example to .env\n' +
            '  2. Set DATABASE_URL to your Neon connection string\n' +
            '  3. Run this again\n\n' +
            'Without it the app still runs on the bundled demo dataset.');
        process.exit(1);
    }

    console.log(`Connecting to ${db.describeTarget()} …`);
    await seeder.migrate();
    console.log('Schema applied (tables created if they were absent).');

    const result = await seeder.seed();
    if (result.seeded) {
        console.log('Demo data inserted.');
    } else {
        console.log(`Demo data not inserted — ${result.reason}.`);
    }

    const counts = await repository.counts();
    console.log('\nRows now stored:');
    Object.keys(counts).forEach(table => {
        console.log(`  ${table.padEnd(15)} ${counts[table]}`);
    });
    console.log('\nDone. Start the server with: npm start');
}

main()
    .then(() => db.close())
    .catch(async err => {
        console.error('\nDatabase setup failed:', err.message);
        try { await db.close(); } catch (e) { /* already closing */ }
        process.exit(1);
    });
