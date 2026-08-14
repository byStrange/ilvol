/**
 * LoadForm — dispatcher aggregation tests
 *
 *   node src/organizations.test.js
 *
 * These are the numbers an owner ranks people by, so the cases that matter are
 * the definitional ones: what counts in a denominator, what a missing answer
 * renders as, and which average is taken.
 */

import { aggregateDispatcherStats, orgDailySeries, topLanes, SPARK_DAYS } from './organizations.js';

let failures = 0;

function check(actual, expected, message) {
  if (actual !== expected) {
    failures += 1;
    console.error(`FAIL: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual:   ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`PASS: ${message}`);
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

const members = [
  { user_id: 'u1', invited_email: 'marcus@acme.com', role: 'dispatcher', status: 'active' },
  { user_id: 'u2', invited_email: 'dave@acme.com', role: 'dispatcher', status: 'active' },
  { user_id: 'u3', invited_email: 'new@acme.com', role: 'dispatcher', status: 'active' },
];

const loads = [
  // Marcus: 2 booked, 1 lost, 1 pending.
  { user_id: 'u1', outcome: 'booked', rate_usd: 2400, miles: 800, status: 'active', created_at: daysAgo(1) },
  { user_id: 'u1', outcome: 'booked', rate_usd: 1200, miles: 400, status: 'active', created_at: daysAgo(2) },
  { user_id: 'u1', outcome: 'lost', rate_usd: 900, miles: 300, status: 'active', created_at: daysAgo(3) },
  { user_id: 'u1', outcome: 'pending', rate_usd: null, miles: null, status: 'active', created_at: daysAgo(3) },
  // Dave: 1 booked, 3 lost.
  { user_id: 'u2', outcome: 'booked', rate_usd: 1000, miles: 500, status: 'active', created_at: daysAgo(1) },
  { user_id: 'u2', outcome: 'lost', rate_usd: null, miles: null, status: 'active', created_at: daysAgo(2) },
  { user_id: 'u2', outcome: 'lost', rate_usd: null, miles: null, status: 'active', created_at: daysAgo(4) },
  { user_id: 'u2', outcome: 'lost', rate_usd: null, miles: null, status: 'active', created_at: daysAgo(5) },
  // Someone who has since left the org.
  { user_id: 'gone', outcome: 'booked', rate_usd: 5000, miles: 1000, status: 'active', created_at: daysAgo(2) },
];

const stats = aggregateDispatcherStats(loads, members);
const byEmail = (e) => stats.find((s) => s.email === e);
const marcus = byEmail('marcus@acme.com');
const dave = byEmail('dave@acme.com');
const fresh = byEmail('new@acme.com');
const former = byEmail('Former member');

// ─── Booking rate ───────────────────────────────────────────────────────────

check(marcus.booked, 2, 'counts booked loads');
check(marcus.lost, 1, 'counts lost loads');
check(marcus.pending, 1, 'counts pending loads');
// 2 booked of 3 resolved — the pending load is NOT in the denominator.
check(marcus.bookingRate, 2 / 3, 'booking rate excludes pending from the denominator');
check(dave.bookingRate, 1 / 4, 'booking rate for a weaker dispatcher');
check(fresh.bookingRate, null, 'booking rate is null, not 0, with nothing resolved');
check(fresh.total, 0, 'a member with no loads still appears');

// ─── Revenue ────────────────────────────────────────────────────────────────

check(marcus.revenue, 3600, 'revenue sums booked loads only');
check(dave.revenue, 1000, 'a lost load contributes no revenue');
check(fresh.revenue, 0, 'no loads means no revenue');

// ─── Rate per mile ──────────────────────────────────────────────────────────

// Weighted: (2400 + 1200) / (800 + 400) = 3.00.
// The mean of the two per-load rates would be (3.00 + 3.00) / 2 = 3.00 here,
// so use a case where they differ:
const weightedLoads = [
  { user_id: 'u1', outcome: 'booked', rate_usd: 360, miles: 90, status: 'active', created_at: daysAgo(1) },
  { user_id: 'u1', outcome: 'booked', rate_usd: 2880, miles: 1200, status: 'active', created_at: daysAgo(2) },
];
const weighted = aggregateDispatcherStats(weightedLoads, members).find((s) => s.userId === 'u1');
// Weighted: 3240 / 1290 = 2.512...  Mean of ratios would be (4.00 + 2.40)/2 = 3.20.
check(
  Math.round(weighted.ratePerMile * 1000) / 1000,
  2.512,
  'rate per mile is weighted by distance, not the mean of per-load rates'
);
check(fresh.ratePerMile, null, 'rate per mile is null without miles');

// A booked load with a rate but no mileage must not drag the average down.
const noMiles = aggregateDispatcherStats(
  [
    { user_id: 'u1', outcome: 'booked', rate_usd: 2000, miles: 1000, status: 'active', created_at: daysAgo(1) },
    { user_id: 'u1', outcome: 'booked', rate_usd: 5000, miles: null, status: 'active', created_at: daysAgo(1) },
  ],
  members
).find((s) => s.userId === 'u1');
check(noMiles.ratePerMile, 2, 'a load with no mileage is excluded from rate per mile');
check(noMiles.revenue, 7000, 'but it still counts toward revenue');

// ─── Former members ─────────────────────────────────────────────────────────

check(former.total, 1, "a departed member's loads are kept under a former bucket");
check(former.role, null, 'the former bucket carries no role');

// ─── Sparkline series ───────────────────────────────────────────────────────

check(marcus.daily.length, SPARK_DAYS, 'daily series has one slot per spark day');
check(marcus.daily[SPARK_DAYS - 1 - 1], 1, 'yesterday lands in the right bucket');
check(
  marcus.daily.reduce((a, b) => a + b, 0),
  4,
  'every recent load lands somewhere in the series'
);

// ─── Org trend ──────────────────────────────────────────────────────────────

const series = orgDailySeries(loads, 30);
check(series.length, 30, 'org series spans the requested window');
check(
  series.reduce((a, b) => a + b, 0),
  9,
  'org series counts every load in the window'
);
check(orgDailySeries([], 30).reduce((a, b) => a + b, 0), 0, 'empty org series is all zeroes');

// ─── Lanes ──────────────────────────────────────────────────────────────────

const laneLoads = [
  { pickup_location: 'Amarillo, TX', delivery_location: 'Tulsa, OK', outcome: 'booked' },
  { pickup_location: 'Amarillo, TX 79106', delivery_location: 'Tulsa, OK', outcome: 'lost' },
  { pickup_location: 'Dallas, TX', delivery_location: 'Memphis, TN', outcome: 'booked' },
  { pickup_location: '', delivery_location: 'Tulsa, OK', outcome: 'booked' },
];
const lanes = topLanes(laneLoads);
check(lanes[0].lane, 'Amarillo, TX → Tulsa, OK', 'busiest lane first');
check(lanes[0].count, 2, 'a zip code does not split a lane in two');
check(lanes[0].booked, 1, 'lane tracks how many were booked');
check(lanes.length, 2, 'a load missing one end is not a lane');

// ─── Result ─────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll aggregation tests passed');
