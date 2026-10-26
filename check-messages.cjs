const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/ticketsmanage.db');
const rows = db.prepare("SELECT ticket_id, messages FROM tickets WHERE CAST(ticket_id AS INTEGER) BETWEEN 7790 AND 7794 ORDER BY CAST(ticket_id AS INTEGER) ASC").all();
for (const row of rows) {
  const msgs = JSON.parse(row.messages || '[]');
  console.log(`Ticket ${row.ticket_id} - ${msgs.length} messages`);
  for (const m of msgs) {
    const content = (m.content || '').slice(0, 150);
    if (content) console.log('  ', m.authorName || m.authorId, ':', content);
    for (const e of (m.embeds || [])) {
      const title = (e.title || '').slice(0, 80);
      const desc = (e.description || '').slice(0, 150);
      if (title || desc) console.log('    embed:', title, '|', desc);
    }
  }
  console.log();
}
