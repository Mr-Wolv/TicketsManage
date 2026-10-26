import { readFileSync, writeFileSync } from 'node:fs';
const path = 'D:/TicketsManage_Bakr101_2026/server/db.ts';
let content = readFileSync(path, 'utf8');
const oldLine = '      cloudApiKey: stored...iKey ?? DEFAULT_SETTINGS.cloudApiKey,';
const newLine = '      cloudApiKey: stored.cloudApiKey ?? DEFAULT_SETTINGS.cloudApiKey,';
if (content.includes(oldLine)) {
  content = content.replace(oldLine, newLine);
  writeFileSync(path, content);
  console.log('Fixed cloudApiKey line');
} else {
  console.log('Old line not found');
  const lines = content.split('\n');
  for (let i = 478; i < 483; i++) {
    console.log(`Line ${i + 1}: ${lines[i]}`);
  }
}
