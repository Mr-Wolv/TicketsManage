const Database = require('better-sqlite3');
const db = new Database('./data/ticketsmanage.db', { readonly: true });

// Get the min and max opening dates
const minOpen = db.prepare('SELECT MIN(openedAt) FROM tickets').all();
const maxOpen = db.prepare('SELECT MAX(openedAt) FROM tickets').all();
const minClose = db.prepare('SELECT MIN(closedAt) FROM tickets').all();
const maxClose = db.prepare('SELECT MAX(closedAt) FROM tickets').all();

console.log('Min openedAt:', minOpen);
console.log('Max openedAt:', maxOpen);
console.log('Min closedAt:', minClose);
console.log('Max closedAt:', maxClose);

// Count tickets per date range (activity/closure basis)
const countOpen1516 = db.prepare("SELECT COUNT(*) FROM tickets WHERE openedAt >= '2026-10-15' AND openedAt < '2026-10-17'").all();
const countOpen1723 = db.prepare("SELECT COUNT(*) FROM tickets WHERE openedAt >= '2026-10-17' AND openedAt < '2026-10-24'").all();
const countClose1516 = db.prepare("SELECT COUNT(*) FROM tickets WHERE closedAt >= '2026-10-15' AND closedAt < '2026-10-17'").all();
const countClose1723 = db.prepare("SELECT COUNT(*) FROM tickets WHERE closedAt >= '2026-10-17' AND closedAt < '2026-10-24'").all();

console.log('\nTickets opened 15-16 Oct:', countOpen1516);
console.log('Tickets opened 17-23 Oct:', countOpen1723);
console.log('Tickets closed 15-16 Oct:', countClose1516);
console.log('Tickets closed 17-23 Oct:', countClose1723);

// Get staff points from DB directly using JSON functions
const staffPoints = db.prepare(
  "SELECT json_extract(assessment, '$.creditStaffId') as staffId, SUM(json_extract(assessment, '$.awardedPoints')) as totalPoints " +
  "FROM tickets " +
  "WHERE assessment IS NOT NULL " +
  "AND json_extract(assessment, '$.creditStaffId') IS NOT NULL " +
  "AND json_extract(assessment, '$.awardedPoints') IS NOT NULL " +
  "GROUP BY json_extract(assessment, '$.creditStaffId') " +
  "ORDER BY totalPoints DESC"
).all();

console.log('\nStaff points from DB:');
let dbTotal = 0;
for (const row of staffPoints) {
  console.log('  ' + row.staffId + ': ' + row.totalPoints);
  dbTotal += row.totalPoints;
}
console.log('Total from DB:', dbTotal);

// Now get staff points for 15-23 October activity basis (tickets closed in that range)
const staffPoints1523 = db.prepare(
  "SELECT json_extract(assessment, '$.creditStaffId') as staffId, SUM(json_extract(assessment, '$.awardedPoints')) as totalPoints " +
  "FROM tickets " +
  "WHERE assessment IS NOT NULL " +
  "AND json_extract(assessment, '$.creditStatus') = 'awarded' " +
  "AND json_extract(assessment, '$.awardedPoints') IS NOT NULL " +
  "AND json_extract(assessment, '$.closedAt') >= '2026-10-15' AND json_extract(assessment, '$.closedAt') < '2026-10-24' " +
  "GROUP BY json_extract(assessment, '$.creditStaffId') " +
  "ORDER BY totalPoints DESC"
).all();

console.log('\nStaff points from DB (15-23 Oct closed):');
let total1523 = 0;
for (const row of staffPoints1523) {
  console.log('  ' + row.staffId + ': ' + row.totalPoints);
  total1523 += row.totalPoints;
}
console.log('Total 15-23 Oct:', total1523);

// Get staff points for 17-23 October
const staffPoints1723 = db.prepare(
  "SELECT json_extract(assessment, '$.creditStaffId') as staffId, SUM(json_extract(assessment, '$.awardedPoints')) as totalPoints " +
  "FROM tickets " +
  "WHERE assessment IS NOT NULL " +
  "AND json_extract(assessment, '$.creditStatus') = 'awarded' " +
  "AND json_extract(assessment, '$.awardedPoints') IS NOT NULL " +
  "AND json_extract(assessment, '$.closedAt') >= '2026-10-17' AND json_extract(assessment, '$.closedAt') < '2026-10-24' " +
  "GROUP BY json_extract(assessment, '$.creditStaffId') " +
  "ORDER BY totalPoints DESC"
).all();

console.log('\nStaff points from DB (17-23 Oct closed):');
let total1723 = 0;
for (const row of staffPoints1723) {
  console.log('  ' + row.staffId + ': ' + row.totalPoints);
  total1723 += row.totalPoints;
}
console.log('Total 17-23 Oct:', total1723);

db.close();