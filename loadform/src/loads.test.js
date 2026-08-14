/**
 * LoadForm — rate/mileage parser tests
 *
 *   node src/loads.test.js
 *
 * These two functions turn what a broker said out loud into the numbers an
 * owner's revenue report is built from, so the cases below are mostly about
 * what they must refuse to answer. A parser that guesses produces a plausible
 * wrong number, which is far more expensive than a blank.
 */

import { parseRateUsd, parseMiles } from './loads.js';

let failures = 0;

function check(actual, expected, message) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`FAIL: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual:   ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`PASS: ${message}`);
}

// ─── parseRateUsd ───────────────────────────────────────────────────────────

check(parseRateUsd('$2,400'), 2400, 'reads a formatted total');
check(parseRateUsd('2400'), 2400, 'reads a bare total');
check(parseRateUsd('$2400 all in'), 2400, 'ignores trailing words');
check(parseRateUsd('2,350.50'), 2350.5, 'keeps cents');
check(parseRateUsd('$2.4k'), 2400, 'expands a k suffix');

// The distinction the whole function exists for.
check(parseRateUsd('$2.80/mile'), null, 'refuses a per-mile rate as a total');
check(parseRateUsd('2.80 per mile'), null, 'refuses "per mile" spelled out');
check(parseRateUsd('$2.80/mi'), null, 'refuses the /mi abbreviation');
check(parseRateUsd('2.80'), null, 'refuses a bare figure too small to be a total');
check(
  parseRateUsd('$2.80/mile ($2,100 total)'),
  2100,
  'takes the total when both forms are stated'
);

// Numbers that are not money.
check(parseRateUsd('43,000 lbs'), null, 'ignores a weight');
check(parseRateUsd('840 miles'), null, 'ignores a mileage');
check(parseRateUsd('MC 123456'), null, 'ignores an MC number');
check(parseRateUsd('load 45678'), null, 'ignores a load number');
check(parseRateUsd('2 stops'), null, 'ignores a stop count');

// Negotiations state several figures; the settled one is what got booked.
check(
  parseRateUsd('offered 2200, settled at 2350'),
  2350,
  'takes the settled figure over the opening offer'
);

check(parseRateUsd(''), null, 'empty string is null');
check(parseRateUsd('   '), null, 'blank string is null');
check(parseRateUsd(null), null, 'null input is null');
check(parseRateUsd(undefined), null, 'undefined input is null');
check(parseRateUsd('TBD'), null, 'unparseable text is null');
check(parseRateUsd(1234), null, 'a non-string is null rather than a crash');

// ─── parseMiles ─────────────────────────────────────────────────────────────

check(parseMiles('840'), 840, 'reads a bare mileage');
check(parseMiles('840 miles'), 840, 'reads a labelled mileage');
check(parseMiles('1,240 mi'), 1240, 'reads a formatted mileage with mi');
check(parseMiles('about 620 miles'), 620, 'reads a mileage inside a phrase');
check(parseMiles('$2,400'), null, 'does not read a dollar figure as mileage');
check(parseMiles('12000 miles'), null, 'refuses an implausible distance');
check(parseMiles('0'), null, 'refuses zero');
check(parseMiles(''), null, 'empty string is null');
check(parseMiles(null), null, 'null input is null');

// The rate-text fallback must not read a bare rate as a distance: "2400" as a
// mileage would turn a $2,400 load into a plausible, wrong $1.00/mile.
check(
  parseMiles('2400', { bareNumberOk: false }),
  null,
  'refuses a bare number when scanning rate text'
);
check(
  parseMiles('2.80 a mile, 840 miles', { bareNumberOk: false }),
  840,
  'still reads a marked mileage out of rate text'
);
check(
  parseMiles('$2,400', { bareNumberOk: false }),
  null,
  'refuses a formatted dollar figure in rate text'
);

// ─── Result ─────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll load parser tests passed');
