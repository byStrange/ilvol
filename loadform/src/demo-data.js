/**
 * LoadForm — demo dataset for the admin console.
 *
 * A new org has a handful of loads and no outcomes, which is not enough to
 * judge a dashboard by: you cannot tell whether a ranking reads well from four
 * rows, or whether a sparkline says anything from three days. This generates
 * two months of plausible traffic for five dispatchers so the console can be
 * looked at the way it will actually be used.
 *
 * Two hard rules about this module:
 *
 *   1. It is READ-ONLY scaffolding. Nothing here is ever written to Supabase.
 *      The console swaps it in at the fetch boundary and nowhere else, so
 *      turning demo mode off restores the real org exactly.
 *
 *   2. It is deterministic. A fixed seed means the same numbers every reload —
 *      figures that drift each time you refresh make it impossible to tell a
 *      layout change from a data change.
 *
 * Addresses are @example.com (RFC 2606, reserved) so a screenshot of this can
 * never be mistaken for a real customer's team.
 */

import { generateTitle } from './loads.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 62; // ~two months
const SEED = 20260814;

/** Small deterministic PRNG. Math.random() would reshuffle every reload. */
function mulberry32(a) {
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The five dispatchers, written to make the console's argument visible.
 *
 * Dave is the point of the whole layout: he out-dials everyone and books the
 * least, at the worst rate per mile. On a dashboard that ranked by loads
 * captured he would look like the hardest worker on the team. That is the
 * failure the booking-rate and $/mile columns exist to prevent, so the demo
 * data has to contain someone it catches.
 */
const PEOPLE = [
  {
    key: 'marcus',
    email: 'marcus.reyes@example.com',
    role: 'owner',
    joinedDaysAgo: 210,
    callsPerWeekday: [3, 6],
    bookRate: 0.34,
    ratePerMile: [2.55, 3.15],
    lanes: [0, 1, 3, 5],
    quiet: null,
    process: [0.82, 0.95],
    // Weighting over the loss taxonomy. Marcus loses mostly on price, which is
    // a pricing decision rather than a performance problem.
    losses: { rate_too_low: 5, already_covered: 3, no_truck: 2, lost_on_call: 1, requirements: 1 },
  },
  {
    key: 'tanya',
    email: 'tanya.okafor@example.com',
    role: 'admin',
    joinedDaysAgo: 150,
    callsPerWeekday: [2, 4],
    // Selective: fewer calls, best conversion and the best freight on the team.
    bookRate: 0.46,
    ratePerMile: [2.9, 3.6],
    lanes: [2, 6, 8],
    quiet: null,
    process: [0.9, 1.0],
    losses: { rate_too_low: 6, already_covered: 3, requirements: 1 },
  },
  {
    key: 'dave',
    email: 'dave.kowalski@example.com',
    role: 'dispatcher',
    joinedDaysAgo: 180,
    callsPerWeekday: [5, 9],
    bookRate: 0.12,
    ratePerMile: [1.75, 2.25],
    lanes: [1, 4, 7, 9, 10],
    // A week off, so at least one sparkline has a real gap in it.
    quiet: { from: 26, to: 33 },
    // Low process AND low outcome — the one case where the call itself is
    // genuinely where to start, and the losses say so too.
    process: [0.3, 0.6],
    losses: { lost_on_call: 8, rate_too_low: 3, already_covered: 2, no_truck: 1 },
  },
  {
    key: 'luis',
    email: 'luis.mendez@example.com',
    role: 'dispatcher',
    joinedDaysAgo: 95,
    callsPerWeekday: [3, 5],
    bookRate: 0.2,
    ratePerMile: [2.35, 2.85],
    lanes: [0, 4, 9, 11],
    quiet: null,
    // The case the whole split exists for: Luis runs calls as well as anyone
    // and still loses more of them, because the freight he is handed is priced
    // badly. On a single blended score he would look mediocre.
    process: [0.85, 0.97],
    losses: { rate_too_low: 9, no_truck: 3, already_covered: 2, lost_on_call: 1 },
  },
  {
    key: 'priya',
    email: 'priya.raman@example.com',
    role: 'dispatcher',
    joinedDaysAgo: 24,
    callsPerWeekday: [1, 3],
    // Books well while skipping steps — the newest dispatcher is being handed
    // the easy freight, which reads as talent until you look at the calls.
    // Every accessorial she doesn't ask about turns up later as a lumper bill.
    bookRate: 0.32,
    ratePerMile: [2.2, 2.8],
    lanes: [3, 8, 11],
    quiet: null,
    process: [0.5, 0.72],
    losses: { rate_too_low: 3, lost_on_call: 3, already_covered: 2, schedule: 1 },
  },
];

/**
 * Which steps a dispatcher tends to skip, in the order they get dropped.
 *
 * Not random: accessorials and appointment type are the first things to go
 * under time pressure, and the last two are what a struggling dispatcher misses
 * long after they have learned to ask the rate.
 */
const CHECK_IDS = [
  'rate_asked',
  'pickup_confirmed',
  'delivery_confirmed',
  'freight_details',
  'equipment_confirmed',
  'next_steps',
  'rate_negotiated',
  'appointment_type',
  'accessorials_raised',
];

/** Real corridors with roughly real mileage, so $/mile lands in a sane range. */
const LANES = [
  { from: 'Amarillo, TX', to: 'Tulsa, OK', miles: 380 },
  { from: 'Ontario, CA', to: 'El Paso, TX', miles: 800 },
  { from: 'Chicago, IL', to: 'Atlanta, GA', miles: 715 },
  { from: 'Dallas, TX', to: 'Memphis, TN', miles: 450 },
  { from: 'Kansas City, MO', to: 'Denver, CO', miles: 600 },
  { from: 'Laredo, TX', to: 'Houston, TX', miles: 320 },
  { from: 'Fresno, CA', to: 'Seattle, WA', miles: 1000 },
  { from: 'Atlanta, GA', to: 'Miami, FL', miles: 660 },
  { from: 'Columbus, OH', to: 'Charlotte, NC', miles: 430 },
  { from: 'Birmingham, AL', to: 'Nashville, TN', miles: 190 },
  { from: 'Newark, NJ', to: 'Boston, MA', miles: 225 },
  { from: 'Phoenix, AZ', to: 'Salt Lake City, UT', miles: 650 },
];

const EQUIPMENT = ['Reefer', 'Dry Van', 'Flatbed', 'Step Deck'];
const COMMODITIES = [
  'Frozen chicken',
  'Retail goods',
  'Steel coils',
  'Paper goods',
  'Produce',
  'Canned food',
  'Building materials',
  'Auto parts',
];

const ORG_ID = 'demo-org';

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function between(rand, lo, hi) {
  return lo + rand() * (hi - lo);
}

/**
 * Build the whole dataset once.
 *
 * Every view the console needs is derived from one canonical array of loads,
 * so the overview totals, the activity feed and a dispatcher's own page can
 * never disagree with each other.
 */
function build() {
  const rand = mulberry32(SEED);
  const now = Date.now();
  const members = [];
  const loads = [];

  for (const person of PEOPLE) {
    const userId = `demo-${person.key}`;
    const joined = new Date(now - person.joinedDaysAgo * DAY_MS).toISOString();
    members.push({
      id: `demo-member-${person.key}`,
      user_id: userId,
      invited_email: person.email,
      role: person.role,
      status: 'active',
      created_at: joined,
      accepted_at: joined,
      // Everyone but the owner was given a login by the office, which is what
      // the real flow now produces — so the profile page shows Reset password.
      provisioned_at: person.role === 'owner' ? null : joined,
    });

    for (let daysAgo = DAYS; daysAgo >= 0; daysAgo--) {
      // Nobody had an account before they joined.
      if (daysAgo > person.joinedDaysAgo) continue;
      if (person.quiet && daysAgo <= person.quiet.to && daysAgo >= person.quiet.from) continue;

      const date = new Date(now - daysAgo * DAY_MS);
      const weekday = date.getDay();
      let calls;
      if (weekday === 0) {
        // Sunday: the odd load, mostly nothing.
        calls = rand() < 0.12 ? 1 : 0;
      } else if (weekday === 6) {
        calls = rand() < 0.5 ? Math.round(between(rand, 1, 2)) : 0;
      } else {
        calls = Math.round(between(rand, person.callsPerWeekday[0], person.callsPerWeekday[1]));
      }
      // A new hire ramps up rather than starting at full speed.
      if (person.joinedDaysAgo < 40) {
        const weeksIn = (person.joinedDaysAgo - daysAgo) / 7;
        if (weeksIn < 1) calls = Math.min(calls, 1);
        else if (weeksIn < 2) calls = Math.min(calls, 2);
      }

      for (let i = 0; i < calls; i++) {
        loads.push(makeLoad(rand, person, userId, date, daysAgo, i));
      }
    }
  }

  loads.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { members, loads };
}

function makeLoad(rand, person, userId, date, daysAgo, index) {
  const lane = LANES[person.lanes[Math.floor(rand() * person.lanes.length)]];
  // Mileage as a broker would say it: the corridor's figure, give or take.
  const miles = Math.round(lane.miles * between(rand, 0.92, 1.1));
  const perMile = between(rand, person.ratePerMile[0], person.ratePerMile[1]);
  // Brokers quote round money, not four decimal places.
  const rateUsd = Math.round((miles * perMile) / 25) * 25;

  let outcome;
  if (daysAgo <= 3 && rand() < 0.4) {
    // The recent tail is where unresolved loads genuinely live.
    outcome = 'pending';
  } else {
    outcome = rand() < person.bookRate ? 'booked' : 'lost';
  }

  // Some losses go unexplained, as they will in reality — a dispatcher in a
  // hurry skips the question, and the console has to cope with that.
  const lossReason = outcome === 'lost' && rand() > 0.12 ? weightedPick(rand, person.losses) : null;

  const { checks, score } = makeCallReview(rand, person, outcome);

  // Spread the day's calls across working hours so timestamps look real.
  const at = new Date(date);
  at.setHours(8 + Math.floor(rand() * 9), Math.floor(rand() * 60), 0, 0);

  const pickupDate = new Date(at.getTime() + Math.round(between(rand, 0.5, 2)) * DAY_MS);
  const pickupDatetime = `${pickupDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  })}, ${pick(rand, ['7:00 AM', '8:00 AM', '10:00 AM', '1:00 PM', '3:00 PM'])}`;

  const data = {
    pickup_location: lane.from,
    delivery_location: lane.to,
    pickup_datetime: pickupDatetime,
  };

  // Rate text mirrors how the extraction stores it — sometimes a flat total,
  // sometimes the per-mile figure with the total in brackets. The dashboard
  // reads rate_usd, so this is only what a human sees on the row.
  const rateText =
    rand() < 0.35
      ? `$${perMile.toFixed(2)}/mile ($${rateUsd.toLocaleString()} total)`
      : `$${rateUsd.toLocaleString()}`;

  return {
    id: `demo-load-${userId}-${daysAgo}-${index}`,
    user_id: userId,
    org_id: ORG_ID,
    title: generateTitle(data, at.toISOString()),
    // Older loads have mostly been archived; recent ones are still open.
    status: daysAgo > 21 && rand() < 0.8 ? 'completed' : 'active',
    outcome,
    pickup_location: lane.from,
    delivery_location: lane.to,
    pickup_datetime: pickupDatetime,
    equipment_type: pick(rand, EQUIPMENT),
    commodity: pick(rand, COMMODITIES),
    rate: rateText,
    rate_usd: rateUsd,
    miles,
    loss_reason: lossReason,
    loss_note: null,
    call_checks: checks,
    call_score: score,
    call_scored_at: score === null ? null : at.toISOString(),
    call_score_skipped: score === null && outcome !== 'pending' ? 'too_short' : null,
    created_at: at.toISOString(),
  };
}

function weightedPick(rand, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * A per-call review consistent with the dispatcher's habits.
 *
 * Built so the scorecard's per-step breakdown means something: someone with a
 * low process score misses the *later* steps rather than random ones, which is
 * how it actually goes — nobody forgets to ask the rate.
 */
function makeCallReview(rand, person, outcome) {
  // A pending call is still in progress; a share of calls are too short to
  // review at all, which the console has to show as "not scored", not as zero.
  if (outcome === 'pending' || rand() < 0.12) return { checks: null, score: null };

  const ability = between(rand, person.process[0], person.process[1]);
  const checks = {};
  let passed = 0;
  let applicable = 0;

  CHECK_IDS.forEach((id, index) => {
    // Later steps in the list are the ones that get dropped first, so the
    // threshold rises as we go.
    const difficulty = index / (CHECK_IDS.length - 1);
    // Negotiation genuinely doesn't arise on a load that was already covered.
    if (id === 'rate_negotiated' && rand() < 0.15) {
      checks[id] = { result: 'na', quote: '' };
      return;
    }
    const done = ability > difficulty * 0.95 && rand() < 0.5 + ability / 2;
    checks[id] = {
      result: done ? 'pass' : 'miss',
      quote: done ? DEMO_QUOTES[id] : '',
    };
    applicable += 1;
    if (done) passed += 1;
  });

  return {
    checks,
    score: applicable > 0 ? Math.round((passed / applicable) * 10000) / 100 : null,
  };
}

/** Stand-in evidence, so the scorecard shows what a real quote looks like. */
const DEMO_QUOTES = {
  rate_asked: 'what does it pay on that one',
  rate_negotiated: "that's low for that lane, I need more to make it work",
  pickup_confirmed: 'picks up tomorrow morning, eight AM',
  delivery_confirmed: 'delivering Thursday by six AM',
  appointment_type: "it's first come first served until three",
  freight_details: 'frozen chicken, forty three thousand pounds',
  equipment_confirmed: "it's a reefer, set at negative ten continuous",
  accessorials_raised: 'is there a lumper at delivery',
  next_steps: "send me the rate confirmation and I'll get you the driver info",
};

// Built once per session. Regenerating per render would be wasteful and, with
// timestamps relative to now, would make rows drift under the reader.
let cache = null;
function dataset() {
  if (!cache) cache = build();
  return cache;
}

/** Stand-in for fetchOrgMembers. */
export function demoMembers() {
  return dataset().members.map((m) => ({ ...m }));
}

/** Stand-in for fetchOrgLoads — the columns the aggregates need. */
export function demoOrgLoads() {
  return dataset().loads.map((l) => ({
    user_id: l.user_id,
    status: l.status,
    outcome: l.outcome,
    loss_reason: l.loss_reason,
    rate_usd: l.rate_usd,
    miles: l.miles,
    call_score: l.call_score,
    created_at: l.created_at,
  }));
}

/** Stand-in for fetchOrgRecentLoads. Same cap the real query uses. */
export function demoRecentLoads(limit = 40) {
  return dataset().loads.slice(0, limit).map((l) => ({ ...l }));
}

/** Stand-in for fetchDispatcherLoads. */
export function demoDispatcherLoads(userId, limit = 100) {
  return dataset()
    .loads.filter((l) => l.user_id === userId)
    .slice(0, limit)
    .map((l) => ({ ...l }));
}

/** How much traffic the set contains, for the banner. */
export function demoSummary() {
  const { members, loads } = dataset();
  return { members: members.length, loads: loads.length, days: DAYS };
}
