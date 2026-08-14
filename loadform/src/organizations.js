/**
 * LoadForm — Organization accounts
 *
 * Helpers for creating an organization, inviting/managing dispatchers, and
 * accepting/declining invites. Mirrors loads.js: the Supabase client is
 * passed in by main.js (it already has the session attached, so RLS
 * resolves auth.uid() / the caller's email automatically).
 *
 * See supabase/migrations/20260811000000_organizations.sql for the schema
 * and the RLS policies these calls rely on.
 */

/** Create a new org with the caller as its owner. Returns the org row, or
 * { error } if creation failed (e.g. already belongs to an org). */
export async function createOrganization(supabase, name) {
  const trimmed = (name || '').trim();
  if (!supabase || !trimmed) return { error: 'Organization name is required' };
  const { data, error } = await supabase.rpc('create_organization', { p_name: trimmed });
  if (error) {
    console.error('createOrganization failed:', error);
    return { error: error.message };
  }
  return { organization: data };
}

/** Fetch the caller's own active membership (org + role), or null if they
 * don't belong to one. */
export async function fetchMyMembership(supabase, userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, org_id, role, status, organizations(id, name, owner_user_id)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    console.error('fetchMyMembership failed:', error);
    return null;
  }
  return data;
}

/** Fetch pending invites addressed to the caller's email. */
export async function fetchMyInvites(supabase, email) {
  if (!supabase || !email) return [];
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, org_id, role, created_at, organizations(id, name)')
    .eq('invited_email', email.trim().toLowerCase())
    .eq('status', 'invited');
  if (error) {
    console.error('fetchMyInvites failed:', error);
    return [];
  }
  return data || [];
}

/** Accept a pending invite: attaches it to the caller and activates it.
 * Fails if the caller is already an active member elsewhere. Goes through
 * the accept_invite() RPC rather than a raw UPDATE — a direct client-side
 * update to the caller's own row would only be checked on user_id, letting
 * an invite "acceptance" also smuggle in role = 'admin' or similar. */
export async function acceptInvite(supabase, memberRowId) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } = await supabase.rpc('accept_invite', { p_invite_id: memberRowId });
  if (error) {
    console.error('acceptInvite failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Decline a pending invite (deletes the invite row; only pending invites
 * can be deleted at all — see the migration). */
export async function declineInvite(supabase, memberRowId) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } = await supabase.from('organization_members').delete().eq('id', memberRowId);
  if (error) {
    console.error('declineInvite failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Leave the caller's own active org membership. Goes through the
 * leave_organization() RPC — owners can't leave (no ownership-transfer flow
 * yet), which the function enforces itself rather than relying on the UI to
 * hide the button. */
export async function leaveOrganization(supabase) {
  if (!supabase) return { ok: false };
  const { error } = await supabase.rpc('leave_organization');
  if (error) {
    console.error('leaveOrganization failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Fetch the full member roster for an org (owner/admin only — RLS-enforced). */
export async function fetchOrgMembers(supabase, orgId) {
  if (!supabase || !orgId) return [];
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, user_id, invited_email, role, status, created_at, accepted_at, provisioned_at')
    .eq('org_id', orgId)
    .neq('status', 'removed')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('fetchOrgMembers failed:', error);
    return [];
  }
  return data || [];
}

// inviteMember() is gone. Adding someone now goes through the member-accounts
// Edge Function (see createTeamMember in api.js), which provisions the login
// outright and only falls back to an invite for an address that already has a
// LoadForm account. A direct client insert would still pass RLS, but it would
// skip the seat cap the function enforces — so there is deliberately no longer
// a client-side way to create a membership row.

/** Remove a member (owner/admin only — RLS-enforced). A pending invite is
 * revoked outright (deleted); an active membership is deactivated
 * (status = 'removed') rather than deleted, so the roster history and the
 * dashboard's "left org" bucket stay intact — and so the owner row, which
 * the update policy refuses to touch, can never be removed this way. */
export async function removeMember(supabase, memberRowId, status) {
  if (!supabase || !memberRowId) return { ok: false };
  const { error } =
    status === 'invited'
      ? await supabase.from('organization_members').delete().eq('id', memberRowId)
      : await supabase.from('organization_members').update({ status: 'removed' }).eq('id', memberRowId);
  if (error) {
    console.error('removeMember failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Change a member's role between 'admin' and 'dispatcher' (owner/admin only
 * — RLS-enforced). The owner's role is fixed and never passed here. */
export async function updateMemberRole(supabase, memberRowId, role) {
  if (!supabase || !memberRowId || !role) return { ok: false };
  const { error } = await supabase
    .from('organization_members')
    .update({ role })
    .eq('id', memberRowId);
  if (error) {
    console.error('updateMemberRole failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Fetch every load tagged with this org (owner/admin only — RLS-enforced).
 * Only the columns the dashboard aggregates, not full load detail. */
export async function fetchOrgLoads(supabase, orgId) {
  if (!supabase || !orgId) return [];
  const { data, error } = await supabase
    .from('loads')
    .select('user_id, status, outcome, loss_reason, rate_usd, miles, call_score, created_at')
    .eq('org_id', orgId);
  if (error) {
    console.error('fetchOrgLoads failed:', error);
    return [];
  }
  return data || [];
}

/** Fetch the org's most recent loads with enough detail for the activity
 * feed (org admins may see full load content — RLS grants the whole row).
 * Capped rather than unbounded: the feed only ever shows the recent tail. */
export async function fetchOrgRecentLoads(supabase, orgId, limit = 40) {
  if (!supabase || !orgId) return [];
  const { data, error } = await supabase
    .from('loads')
    .select('id, user_id, title, status, pickup_location, delivery_location, rate, equipment_type, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('fetchOrgRecentLoads failed:', error);
    return [];
  }
  return data || [];
}

/** Rename an organization (owner/admin only — RLS-enforced). Only `name` is
 * updatable at all: the column-level grant in the follow-up migration keeps
 * this call from being widened into an ownership or plan change. */
export async function updateOrganizationName(supabase, orgId, name) {
  const trimmed = (name || '').trim();
  if (!supabase || !orgId) return { ok: false };
  if (!trimmed) return { ok: false, error: 'Organization name is required' };
  const { error } = await supabase.from('organizations').update({ name: trimmed }).eq('id', orgId);
  if (error) {
    console.error('updateOrganizationName failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days of per-day history each dispatcher row carries, for its sparkline. */
export const SPARK_DAYS = 14;

/** Local midnight for a timestamp, as the key the daily buckets are counted on.
 * Local rather than UTC because a dispatcher's "yesterday" is their own. */
function dayIndex(value, now) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDay = new Date(d);
  startOfDay.setHours(0, 0, 0, 0);
  return Math.round((startOfToday - startOfDay) / DAY_MS);
}

function emptyStat(userId, email, role) {
  return {
    userId,
    email,
    role,
    total: 0,
    last7d: 0,
    last30d: 0,
    active: 0,
    completed: 0,
    booked: 0,
    lost: 0,
    pending: 0,
    booked7d: 0,
    // Revenue and mileage accumulate over booked loads only — see the note on
    // the derived fields below.
    revenue: 0,
    revenue30d: 0,
    milesTotal: 0,
    revenueWithMiles: 0,
    daily: new Array(SPARK_DAYS).fill(0),
    lastActiveAt: null,
    // Process side: how the calls were run, independent of whether they landed.
    scoreSum: 0,
    scoredCalls: 0,
    // Losses split by whether the reason says anything about the dispatcher.
    lostControllable: 0,
    lostExternal: 0,
    lostUnexplained: 0,
    lossReasons: {},
  };
}

/**
 * Reasons that reflect on the dispatcher rather than on the business.
 *
 * Kept in step with LOSS_REASON_META in loads.js — duplicated rather than
 * imported because this module is pure aggregation over rows and importing the
 * persistence layer for one constant would invert the dependency.
 */
const CONTROLLABLE_LOSS_REASONS = new Set(['lost_on_call']);

/**
 * Calls a dispatcher must have reviewed before a process score is shown.
 *
 * A score over three calls is noise, and noise attached to someone's job is
 * worse than no number: an owner shown "48%" on four calls will act on it.
 */
export const MIN_SCORED_CALLS = 10;

/**
 * Roll raw org loads up into one row per dispatcher.
 *
 * Three of the derived numbers have definitions worth stating, because each
 * could reasonably have been computed another way:
 *
 *   bookingRate   booked / (booked + lost). Pending is excluded from the
 *                 denominator, not counted as a loss — an unresolved load is
 *                 not yet a failure, and treating it as one would punish the
 *                 dispatcher with the most irons in the fire.
 *
 *   revenue       summed over BOOKED loads only. Revenue booked, not revenue
 *                 quoted; a rate discussed on a load that got away is not money.
 *
 *   ratePerMile   total booked revenue ÷ total booked miles, over the loads
 *                 that have both. A weighted average, deliberately not the mean
 *                 of each load's per-mile figure: the latter lets a 90-mile
 *                 drayage run at $4/mi outweigh a 1,200-mile haul at $2.40.
 *
 * Members with no loads still appear at zero; loads from someone who has since
 * left are grouped under a synthetic "former member" bucket rather than
 * dropped, so historical activity isn't silently lost from the org total.
 */
export function aggregateDispatcherStats(loads, members) {
  const now = Date.now();
  const byUser = new Map();

  for (const m of members) {
    if (m.status !== 'active' || !m.user_id) continue;
    byUser.set(m.user_id, emptyStat(m.user_id, m.invited_email, m.role));
  }

  for (const load of loads || []) {
    let stat = byUser.get(load.user_id);
    if (!stat) {
      const key = `former:${load.user_id}`;
      stat = byUser.get(key) || emptyStat(load.user_id, 'Former member', null);
      byUser.set(key, stat);
    }

    stat.total += 1;
    const createdMs = new Date(load.created_at).getTime();
    const ageMs = now - createdMs;
    if (ageMs <= 7 * DAY_MS) stat.last7d += 1;
    if (ageMs <= 30 * DAY_MS) stat.last30d += 1;
    if (load.status === 'completed') stat.completed += 1;
    else stat.active += 1;

    if (!stat.lastActiveAt || createdMs > stat.lastActiveAt) {
      stat.lastActiveAt = createdMs;
    }

    const day = dayIndex(load.created_at, now);
    if (day !== null && day >= 0 && day < SPARK_DAYS) {
      // Index 0 is the oldest day, so the sparkline reads left-to-right in time.
      stat.daily[SPARK_DAYS - 1 - day] += 1;
    }

    // Null-checked before the cast: Number(null) is 0, and a call that was
    // never reviewed averaged in as a zero would drag a dispatcher's score down
    // for every short call and every provider hiccup.
    if (load.call_score !== null && load.call_score !== undefined) {
      const score = Number(load.call_score);
      if (Number.isFinite(score)) {
        stat.scoreSum += score;
        stat.scoredCalls += 1;
      }
    }

    const outcome = load.outcome || 'pending';
    if (outcome === 'booked') stat.booked += 1;
    else if (outcome === 'lost') stat.lost += 1;
    else stat.pending += 1;

    if (outcome === 'lost') {
      const reason = load.loss_reason || null;
      if (!reason) stat.lostUnexplained += 1;
      else if (CONTROLLABLE_LOSS_REASONS.has(reason)) stat.lostControllable += 1;
      else stat.lostExternal += 1;
      if (reason) stat.lossReasons[reason] = (stat.lossReasons[reason] || 0) + 1;
    }

    if (outcome !== 'booked') continue;
    if (ageMs <= 7 * DAY_MS) stat.booked7d += 1;

    const rate = Number(load.rate_usd);
    if (Number.isFinite(rate) && rate > 0) {
      stat.revenue += rate;
      if (ageMs <= 30 * DAY_MS) stat.revenue30d += rate;
      const miles = Number(load.miles);
      if (Number.isFinite(miles) && miles > 0) {
        stat.milesTotal += miles;
        stat.revenueWithMiles += rate;
      }
    }
  }

  for (const stat of byUser.values()) {
    const resolved = stat.booked + stat.lost;
    // Null, never 0, when nothing has been resolved yet: "no answer" and "never
    // wins a load" must not render as the same number.
    stat.bookingRate = resolved > 0 ? stat.booked / resolved : null;
    stat.ratePerMile =
      stat.milesTotal > 0 ? stat.revenueWithMiles / stat.milesTotal : null;

    // Withheld below the sample floor rather than shown with a caveat: a number
    // on screen gets acted on whatever the footnote says.
    stat.processScore =
      stat.scoredCalls >= MIN_SCORED_CALLS ? stat.scoreSum / stat.scoredCalls : null;

    // Of the losses that carry a reason, how many were the dispatcher's to
    // control. Unexplained losses are excluded from the denominator — silence
    // is not evidence either way.
    const explained = stat.lostControllable + stat.lostExternal;
    stat.controllableLossShare = explained > 0 ? stat.lostControllable / explained : null;
  }

  // Ranked by money booked, not by calls made. Sorting on volume puts whoever
  // dials the most at the top, which is precisely the reading this table exists
  // to correct — the busiest dispatcher on a team is often the one converting
  // least. Booked count breaks ties before call count, so someone with no rates
  // captured yet still ranks on results rather than effort.
  //
  // Departed members always sort last, whatever they booked. The bucket is an
  // aggregate of everyone who has left rather than a person, so ranking it
  // among the current team would put a name nobody can act on at the top of a
  // performance table.
  return Array.from(byUser.values()).sort((a, b) => {
    if (!a.role !== !b.role) return a.role ? -1 : 1;
    return b.revenue - a.revenue || b.booked - a.booked || b.total - a.total;
  });
}

/**
 * Read a dispatcher against their own team.
 *
 * Process (did they run the call) and outcome (did it land) are held apart and
 * compared separately, because the interesting answer lives in the disagreement
 * between them:
 *
 *                    high outcome        low outcome
 *   high process     performing          not their fault — look at rates,
 *                                        trucks and lanes before the person
 *   low process      getting away with   coach the call itself
 *                    easy freight
 *
 * Merging the two into a single number destroys exactly this reading, which is
 * the one an owner cannot get any other way.
 *
 * Compared against the team median rather than a fixed threshold on purpose:
 * there is no industry booking rate that is right for every carrier, and a
 * hardcoded one would be wrong for half of them. A dispatcher is measured
 * against the people working the same freight.
 */
export function readPerformance(stat, stats) {
  if (stat.processScore === null || stat.bookingRate === null) {
    return verdictFromMedians(stat, null, null, 0);
  }

  const peers = stats.filter(
    (s) => s.role && s.processScore !== null && s.bookingRate !== null
  );
  const medianProcessScore = peers.length >= 2 ? median(peers.map((s) => s.processScore)) : null;
  const medianBookingRate = peers.length >= 2 ? median(peers.map((s) => s.bookingRate)) : null;
  return verdictFromMedians(stat, medianProcessScore, medianBookingRate, peers.length);
}

/**
 * The verdict from two medians rather than a full peer array.
 *
 * Extracted from readPerformance so a dispatcher's own scorecard can read
 * against server-provided medians (peer_medians RPC) without the client ever
 * holding peer rows — which RLS would not let it see anyway. The labels and the
 * four quadrants are identical to the admin reading, so a dispatcher and an
 * owner never see different verdicts for the same person.
 */
export function verdictFromMedians(stat, medianProcessScore, medianBookingRate, peerCount) {
  if (stat.processScore === null || stat.bookingRate === null) {
    return {
      verdict: 'unknown',
      label: 'Not enough reviewed calls yet',
      detail: `A read needs at least ${MIN_SCORED_CALLS} scored calls and some resolved outcomes.`,
    };
  }

  if (peerCount < 2 || medianProcessScore === null || medianBookingRate === null) {
    return {
      verdict: 'unknown',
      label: 'No one to compare against yet',
      detail: 'This reading compares dispatchers with each other, so it needs at least two.',
    };
  }

  const highProcess = stat.processScore >= medianProcessScore;
  const highOutcome = stat.bookingRate >= medianBookingRate;

  if (highProcess && highOutcome) {
    return {
      verdict: 'performing',
      label: 'Running good calls and winning them',
      detail: 'Above the team on both how the call is run and how often it lands.',
    };
  }
  if (highProcess && !highOutcome) {
    return {
      verdict: 'not_their_fault',
      label: 'Running good calls that are not landing',
      detail:
        'They work the call as well as anyone and still lose more. Look at the rates they are ' +
        'given, the trucks available to them, and the lanes they are handed before looking at them.',
    };
  }
  if (!highProcess && highOutcome) {
    return {
      verdict: 'easy_freight',
      label: 'Winning without working the call',
      detail:
        'Landing loads while skipping steps. Usually easier freight rather than better selling — ' +
        'and the skipped steps are where detention and lumper costs get discovered later.',
    };
  }
  return {
    verdict: 'needs_coaching',
    label: 'The call itself is where to start',
    detail: 'Below the team on both. The step breakdown below says which parts to work on.',
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Roll per-call check results into a per-step pass rate for one dispatcher.
 *
 * This is what makes the score coachable: "you are not asking about detention"
 * is something a person can act on, where "your score is 68" is not.
 */
export function aggregateChecks(loads) {
  const byCheck = new Map();
  for (const load of loads || []) {
    const checks = load.call_checks;
    if (!checks || typeof checks !== 'object') continue;
    for (const [id, entry] of Object.entries(checks)) {
      const result = entry?.result;
      if (result !== 'pass' && result !== 'miss') continue; // 'na' is not scored
      const row = byCheck.get(id) || { id, passed: 0, applicable: 0, example: '', quote: '' };
      row.applicable += 1;
      if (result === 'pass') {
        row.passed += 1;
        // The verbatim quote that justified the first pass — the evidence a
        // dispatcher reads to confirm or dispute a mark against them. A pass
        // with no quote was downgraded to a miss by the scorer, so this is
        // always grounded in the transcript.
        if (!row.quote && entry.quote) row.quote = entry.quote;
      } else if (!row.example) {
        row.example = load.title || '';
      }
      byCheck.set(id, row);
    }
  }
  return Array.from(byCheck.values()).map((r) => ({
    ...r,
    rate: r.applicable > 0 ? r.passed / r.applicable : null,
  }));
}

/**
 * Org-wide loads per day, oldest first, for the overview trend.
 *
 * Aggregated across everyone on purpose: a single dispatcher's daily count is
 * too jagged at this team size to read as a trend, while the org total has
 * enough volume to show a real shape.
 */
export function orgDailySeries(loads, days = 30) {
  const now = Date.now();
  const series = new Array(days).fill(0);
  for (const load of loads || []) {
    const day = dayIndex(load.created_at, now);
    if (day !== null && day >= 0 && day < days) series[days - 1 - day] += 1;
  }
  return series;
}

/**
 * The lanes a dispatcher runs most, busiest first.
 *
 * Cities are compared on their "City, ST" head so that "Amarillo, TX 79106" and
 * "Amarillo, TX" are one lane rather than two.
 */
export function topLanes(loads, limit = 5) {
  const counts = new Map();
  for (const load of loads || []) {
    const from = laneEnd(load.pickup_location);
    const to = laneEnd(load.delivery_location);
    if (!from || !to) continue;
    const key = `${from} → ${to}`;
    const entry = counts.get(key) || { lane: key, count: 0, booked: 0 };
    entry.count += 1;
    if (load.outcome === 'booked') entry.booked += 1;
    counts.set(key, entry);
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function laneEnd(location) {
  const parts = String(location || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  // "Amarillo, TX 79106" → "Amarillo, TX": keep the state, drop the zip.
  return `${parts[0]}, ${parts[1].split(/\s+/)[0]}`;
}

/** One dispatcher's loads in full detail, newest first, for their profile. */
export async function fetchDispatcherLoads(supabase, orgId, userId, limit = 100) {
  if (!supabase || !orgId || !userId) return [];
  const { data, error } = await supabase
    .from('loads')
    .select(
      'id, title, status, outcome, loss_reason, loss_note, call_score, call_checks, call_score_skipped, rate, rate_usd, miles, pickup_location, delivery_location, equipment_type, commodity, created_at'
    )
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('fetchDispatcherLoads failed:', error);
    return [];
  }
  return data || [];
}
