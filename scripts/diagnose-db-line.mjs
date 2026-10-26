import { readFileSync, writeFileSync } from 'node:fs';
const path = 'D:/TicketsManage_Bakr101_2026/server/db.ts';
let content = readFileSync(path, 'utf8');
const lines = content.split('\n');
console.log('Line 480 raw:', JSON.stringify(lines[479]));
console.log('Line 480 bytes:', Buffer.from(lines[479]).toString('hex'));

// Search for any line containing both 'cloudApiKey' and 'stored'
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('cloudApiKey') && lines[i].includes('stored')) {
    console.log(`Found at line ${i + 1}: ${JSON.stringify(lines[i])}`);
  }
}
