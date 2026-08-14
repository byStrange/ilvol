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
  },
  {
    key: 'luis',
    email: 'luis.mendez@example.com',
    role: 'dispatcher',
    joinedDaysAgo: 95,
    callsPerWeekday: [3, 5],
    bookRate: 0.29,
    ratePerMile: [2.35, 2.85],
    lanes: [0, 4, 9, 11],
    quiet: null,
  },
  {
    key: 'priya',
    email: 'priya.raman@example.com',
    role: 'dispatcher',
    joinedDaysAgo: 24,
    callsPerWeekday: [1, 3],
    bookRate: 0.24,
    ratePerMile: [2.2, 2.8],
    lanes: [3, 8, 11],
    quiet: null,
  },
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
    created_at: at.toISOString(),
  };
}

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
    rate_usd: l.rate_usd,
    miles: l.miles,
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
