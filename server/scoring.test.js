'use strict';

const { calculatePoints } = require('./scoring');

let failures = 0;
function assertEq(actual, expected, name) {
  if (actual !== expected) {
    console.error(`FAIL: ${name} -> expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

assertEq(calculatePoints(true, 0, 10000), 1000, 'instant correct = 1000');
assertEq(calculatePoints(true, 10000, 10000), 500, 'last-ms correct = 500');
assertEq(calculatePoints(true, 5000, 10000), 750, 'mid correct = 750');
assertEq(calculatePoints(false, 0, 10000), 0, 'wrong = 0');
assertEq(calculatePoints(false, 5000, 10000), 0, 'wrong mid = 0');
assertEq(calculatePoints(true, 15000, 10000), 500, 'over-limit correct clamps to 500');
assertEq(calculatePoints(true, -100, 10000), 1000, 'negative ms clamps to 0 -> 1000');
assertEq(calculatePoints(true, 0, 0), 0, 'zero timeLimit = 0 (guard)');

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll scoring tests passed');
