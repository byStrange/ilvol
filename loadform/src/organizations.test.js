/**
 * LoadForm — dispatcher aggregation tests
 *
 *   node src/organizations.test.js
 *
 * These are the numbers an owner ranks people by, so the cases that matter are
 * the definitional ones: what counts in a denominator, what a missing answer
 * renders as, and which average is taken.
 */

import {
  aggregateDispatcherStats,
  orgDailySeries,
  topLanes,
  readPerformance,
  verdictFromMedians,
  aggregateChecks,
  aggregateLossReasons,
  SPARK_DAYS,
  MIN_SCORED_CALLS,
  MIN_EXPLAINED_LOSSES,
} from './organizations.js';

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

// ─── Ranking ────────────────────────────────────────────────────────────────

// Dave makes the most calls (4) and books the least money. Ranking by volume
// would put him first, which is exactly the misreading the table exists to
// prevent — so revenue leads.
check(stats[0].email, 'marcus@acme.com', 'ranked by revenue booked, not call count');
check(
  stats.findIndex((s) => s.email === 'dave@acme.com') >
    stats.findIndex((s) => s.email === 'marcus@acme.com'),
  true,
  'the busiest dialler does not outrank the better closer'
);
check(
  stats.findIndex((s) => s.email === 'new@acme.com') <
    stats.findIndex((s) => s.email === 'Former member'),
  true,
  'a current member with no loads still outranks the departed bucket'
);
// The former bucket booked $5,000 — more than anyone current — and still sorts
// last, because it is an aggregate of people who have left, not a person.
check(stats[stats.length - 1].email, 'Former member', 'departed members always rank last');

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

// ─── Loss reasons ───────────────────────────────────────────────────────────

const lossLoads = [
  // Four losses that are the business's problem, one that is the dispatcher's.
  { user_id: 'u1', outcome: 'lost', loss_reason: 'rate_too_low', created_at: daysAgo(1) },
  { user_id: 'u1', outcome: 'lost', loss_reason: 'rate_too_low', created_at: daysAgo(2) },
  { user_id: 'u1', outcome: 'lost', loss_reason: 'no_truck', created_at: daysAgo(3) },
  { user_id: 'u1', outcome: 'lost', loss_reason: 'already_covered', created_at: daysAgo(4) },
  { user_id: 'u1', outcome: 'lost', loss_reason: 'lost_on_call', created_at: daysAgo(5) },
  // A loss with no reason recorded at all.
  { user_id: 'u1', outcome: 'lost', loss_reason: null, created_at: daysAgo(6) },
];
const lossStat = aggregateDispatcherStats(lossLoads, members).find((s) => s.userId === 'u1');

check(lossStat.lostExternal, 4, 'losses outside the dispatcher\'s control are counted apart');
check(lossStat.lostControllable, 1, 'only lost_on_call counts against the dispatcher');
check(lossStat.lostUnexplained, 1, 'a loss with no reason is neither, and is counted separately');
check(lossStat.lossReasons.rate_too_low, 2, 'reasons are tallied for the breakdown');
// 1 of 5 explained losses — the unexplained one stays out of the denominator,
// because silence is not evidence in either direction.
check(lossStat.controllableLossShare, 1 / 5, 'unexplained losses do not dilute the share');
check(lossStat.explainedLosses, 5, 'the explained count is published for the sample floor');

// ─── The loss-share sample floor ────────────────────────────────────────────
//
// The case this exists for: one loss, one reason, and a percentage that reads
// as a finding. The identical dispatcher is 0% or 100% depending on which call
// happened to land first, so neither number belongs on a dashboard.

const oneLoss = [
  { user_id: 'u1', outcome: 'lost', loss_reason: 'already_covered', created_at: daysAgo(1) },
];
const oneLossStat = aggregateDispatcherStats(oneLoss, members).find((s) => s.userId === 'u1');
check(oneLossStat.controllableLossShare, null, 'one explained loss is not a share');
check(oneLossStat.explainedLosses, 1, 'but the count says how far off the floor it is');
check(oneLossStat.lossReasons.already_covered, 1, 'the reason itself is still tallied');

const fourLosses = Array.from({ length: 4 }, (_, i) => ({
  user_id: 'u1',
  outcome: 'lost',
  loss_reason: 'lost_on_call',
  created_at: daysAgo(i + 1),
}));
const fourStat = aggregateDispatcherStats(fourLosses, members).find((s) => s.userId === 'u1');
check(fourStat.controllableLossShare, null, 'still withheld one short of the floor');

const fifth = [
  ...fourLosses,
  { user_id: 'u1', outcome: 'lost', loss_reason: 'lost_on_call', created_at: daysAgo(5) },
];
const fifthStat = aggregateDispatcherStats(fifth, members).find((s) => s.userId === 'u1');
check(fifthStat.controllableLossShare, 1, 'and appears exactly at the floor');
check(MIN_EXPLAINED_LOSSES, 5, 'the floor is the one the tests above assume');

// ─── Loss reasons with their evidence ───────────────────────────────────────

const quotedLosses = [
  {
    outcome: 'lost',
    loss_reason: 'rate_too_low',
    loss_reason_quote: "that's all it pays",
  },
  // Same reason, second quote: the first one recorded is the one kept, so the
  // panel does not change its evidence between reloads.
  { outcome: 'lost', loss_reason: 'rate_too_low', loss_reason_quote: 'I cannot go higher' },
  // Derived rather than spoken, so it arrives with nothing to cite.
  { outcome: 'lost', loss_reason: 'lost_on_call', loss_reason_quote: null },
  // Read but unexplained: counted as a loss, absent from the breakdown.
  { outcome: 'lost', loss_reason: null, loss_reason_quote: null },
  // Won, and therefore not a loss reason however it is shaped.
  { outcome: 'booked', loss_reason: 'rate_too_low', loss_reason_quote: 'ignored' },
];
const reasons = aggregateLossReasons(quotedLosses);

check(reasons.length, 2, 'only lost loads carrying a reason reach the breakdown');
check(reasons[0].reason, 'rate_too_low', 'ordered by how often, busiest first');
check(reasons[0].count, 2, 'and counted');
check(reasons[0].quote, "that's all it pays", 'the first quote recorded is the one shown');
check(reasons[1].reason, 'lost_on_call', 'a derived reason still appears');
check(reasons[1].quote, '', 'with no quote, because it was never spoken');
check(aggregateLossReasons([]).length, 0, 'no loads, no breakdown');
check(aggregateLossReasons(null).length, 0, 'and a missing list is not a crash');

// ─── Process score ──────────────────────────────────────────────────────────

function scoredLoads(userId, scores) {
  return scores.map((call_score, i) => ({
    user_id: userId,
    outcome: 'booked',
    call_score,
    created_at: daysAgo(i + 1),
  }));
}

const thin = aggregateDispatcherStats(scoredLoads('u1', [90, 80, 70]), members).find(
  (s) => s.userId === 'u1'
);
check(thin.scoredCalls, 3, 'scored calls are counted');
check(
  thin.processScore,
  null,
  `a process score is withheld below ${MIN_SCORED_CALLS} reviewed calls`
);

const enough = aggregateDispatcherStats(
  scoredLoads('u1', new Array(MIN_SCORED_CALLS).fill(80)),
  members
).find((s) => s.userId === 'u1');
check(enough.processScore, 80, 'a process score appears once there are enough calls');

// An unscored call must not be averaged in as a zero.
const withSkips = aggregateDispatcherStats(
  [
    ...scoredLoads('u1', new Array(MIN_SCORED_CALLS).fill(80)),
    { user_id: 'u1', outcome: 'lost', call_score: null, created_at: daysAgo(1) },
  ],
  members
).find((s) => s.userId === 'u1');
check(withSkips.processScore, 80, 'an unscored call is skipped, not counted as zero');

// ─── The quadrant reading ───────────────────────────────────────────────────

function peer(userId, email, processScore, bookingRate) {
  return { userId, email, role: 'dispatcher', processScore, bookingRate };
}
const peers = [
  peer('a', 'a@x.com', 90, 0.4), // good process, good outcome
  peer('b', 'b@x.com', 88, 0.1), // good process, bad outcome
  peer('c', 'c@x.com', 40, 0.38), // bad process, good outcome
  peer('d', 'd@x.com', 35, 0.08), // bad process, bad outcome
];

check(readPerformance(peers[0], peers).verdict, 'performing', 'strong on both reads as performing');
check(
  readPerformance(peers[1], peers).verdict,
  'not_their_fault',
  'good calls that do not land point at the business, not the person'
);
check(
  readPerformance(peers[2], peers).verdict,
  'easy_freight',
  'winning while skipping steps is flagged as easy freight'
);
check(
  readPerformance(peers[3], peers).verdict,
  'needs_coaching',
  'weak on both points at the call itself'
);
check(
  readPerformance(peer('e', 'e@x.com', null, 0.3), peers).verdict,
  'unknown',
  'no reading without a process score'
);
check(
  readPerformance(peers[0], [peers[0]]).verdict,
  'unknown',
  'no reading without peers to compare against'
);

// ─── The same reading from server-supplied medians ──────────────────────────
//
// A dispatcher cannot read peer loads (RLS is admin-only), so their own
// scorecard reads against medians from the peer_medians RPC instead of a peer
// array. The verdict must come out identical either way, or a dispatcher and
// their owner would see different readings of the same person.

const medProcess = 64; // median of [90, 88, 40, 35]
const medBooking = 0.24; // median of [0.4, 0.1, 0.38, 0.08]

check(
  verdictFromMedians(peers[0], medProcess, medBooking, 4).verdict,
  readPerformance(peers[0], peers).verdict,
  'medians give the same verdict as the peer array — performing'
);
check(
  verdictFromMedians(peers[1], medProcess, medBooking, 4).verdict,
  readPerformance(peers[1], peers).verdict,
  'medians give the same verdict as the peer array — not their fault'
);
check(
  verdictFromMedians(peers[2], medProcess, medBooking, 4).verdict,
  readPerformance(peers[2], peers).verdict,
  'medians give the same verdict as the peer array — easy freight'
);
check(
  verdictFromMedians(peers[3], medProcess, medBooking, 4).verdict,
  readPerformance(peers[3], peers).verdict,
  'medians give the same verdict as the peer array — needs coaching'
);
check(
  verdictFromMedians(peers[0], medProcess, medBooking, 1).verdict,
  'unknown',
  'a lone dispatcher has no team to be read against'
);
check(
  verdictFromMedians(peer('e', 'e@x.com', null, 0.3), medProcess, medBooking, 4).verdict,
  'unknown',
  'no reading from medians without a process score'
);
// The RPC returning nothing must degrade to "no comparison", never to a verdict
// computed against null — which would silently read as "below the team".
check(
  verdictFromMedians(peers[0], null, null, 0).verdict,
  'unknown',
  'a failed median lookup withholds the reading rather than inventing one'
);

// ─── Per-step rollup ────────────────────────────────────────────────────────

const checkLoads = [
  {
    title: 'Load A',
    call_checks: {
      rate_asked: { result: 'pass', quote: 'what does it pay' },
      accessorials_raised: { result: 'miss', quote: '' },
      rate_negotiated: { result: 'na', quote: '' },
    },
  },
  {
    title: 'Load B',
    call_checks: {
      rate_asked: { result: 'pass', quote: 'how much' },
      accessorials_raised: { result: 'miss', quote: '' },
      rate_negotiated: { result: 'pass', quote: 'I need more than that' },
    },
  },
  { title: 'Unscored load', call_checks: null },
];
const rolled = aggregateChecks(checkLoads);
const byId = (id) => rolled.find((r) => r.id === id);
check(byId('rate_asked').rate, 1, 'a step passed every time rolls up to 100%');
check(byId('accessorials_raised').rate, 0, 'a step never done rolls up to 0%');
check(byId('rate_negotiated').applicable, 1, 'an N/A call is excluded from that step');
check(byId('rate_negotiated').rate, 1, 'and the remaining call decides the rate');
check(byId('accessorials_raised').example, 'Load A', 'a missed step cites a call to look at');
check(rolled.length, 3, 'unscored loads contribute nothing');

// The evidence a dispatcher reads to dispute a mark against them. A pass with
// no quote was already downgraded to a miss by the scorer, so a quote here is
// always grounded in the transcript.
check(byId('rate_asked').quote, 'what does it pay', 'a passed step keeps the words that earned it');
check(byId('accessorials_raised').quote, '', 'a step never passed has no quote to show');

// ─── Result ─────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll aggregation tests passed');
