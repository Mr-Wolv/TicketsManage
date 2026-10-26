const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/ticketsmanage.db');

async function testListing() {
  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM tickets) AS tickets, (SELECT COUNT(*) FROM assessments) AS assessments").get();
  console.log('DB state:', JSON.stringify(counts));
  
  const sample = db.prepare('SELECT ticket_id, close_reason, closed_at FROM tickets LIMIT 5').all();
  console.log('Sample tickets:', JSON.stringify(sample, null, 2));
}

testListing().catch(console.error);
