const fs = require('fs');
const data = JSON.parse(fs.readFileSync('D:\tmp\tickets.json', 'utf8'));

const staffPoints = {};
const staffAwards = {};
const staffTickets = {};

for (const ticket of data.items) {
  const assessment = ticket.assessment;
  if (!assessment || !assessment.creditRule || !assessment.creditStaffId || assessment.awardedPoints === undefined) continue;
  const staffId = assessment.creditStaffId;
  const points = assessment.awardedPoints;
  if (!staffPoints[staffId]) staffPoints[staffId] = 0;
  if (!staffAwards[staffId]) staffAwards[staffId] = 0;
  if (!staffTickets[staffId]) staffTickets[staffId] = 0;
  staffPoints[staffId] += points;
  staffAwards[staffId] += points;
  staffTickets[staffId]++;
}

const sorted = Object.entries(staffPoints).sort((a, b) => b[1] - a[1]);
console.log('Staff points (ranked):');
for (const [id, pts] of sorted) {
  console.log('  ' + id + ': ' + pts + ' pts from ' + staffTickets[id] + ' tickets');
}

const expected = [71, 119, 343, 40, 39, 20, 0, 3];
console.log('');
console.log('Expected: 71, 119, 343, 40, 39, 20, 0, 3');
for (const ep of expected) {
  const match = sorted.find(([_, p]) => p === ep);
  if (match) {
    console.log('  Found: ' + match[0] + ' = ' + match[1]);
  } else {
    console.log('  NOT FOUND: ' + ep);
  }
}

const total = sorted.reduce((sum, [_, p]) => sum + p, 0);
console.log('');
console.log('Actual total: ' + total);
console.log('Expected total: ' + (71+119+343+40+39+20+0+3));
