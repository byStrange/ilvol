/**
 * LoadForm — Load history persistence
 *
 * Helpers for saving, fetching, updating and deleting per-user loads in
 * Supabase. Mirrors the LoadFormData fields (src-tauri/src/lib.rs) stored in
 * the `loads` table (see supabase/migrations/20260724000000_loads.sql).
 *
 * The Supabase client is passed in by main.js (it already has the session
 * attached, so RLS resolves auth.uid() automatically).
 */

import { DEFAULT_TEMPLATE, renderTemplate } from './templates.js';

// Columns that make up a LoadFormData row (must match the migration).
const LOAD_FIELDS = [
  'pickup_location',
  'pickup_datetime',
  'pickup_type',
  'pickup_window',
  'delivery_location',
  'delivery_datetime',
  'delivery_type',
  'delivery_window',
  'stops',
  'commodity',
  'equipment_type',
  'trailer_instructions',
  'rate',
  'weight',
  'additional_notes',
];

// `miles` is deliberately absent above: the extraction hands it over as a
// string like every other field, but it is stored as an integer, so it is
// parsed separately rather than written through as ''.

// Lightweight columns used for the history list view.
const LIST_SELECT =
  'id,title,status,outcome,pickup_location,delivery_location,pickup_datetime,rate,created_at,updated_at';

/** Outcomes a load can end in. Mirrors loads_outcome_check in the migration. */
export const OUTCOMES = ['pending', 'booked', 'lost'];

/**
 * Pull a total dollar figure out of the free-text rate field.
 *
 * The whole point of this function is one distinction: "$2.80/mile" and
 * "$2,800" are the same digits and mean amounts three orders of magnitude
 * apart. Getting that wrong doesn't produce an obviously broken number — it
 * produces a plausible one, on a revenue report an owner is making decisions
 * from. So the bias throughout is to return null rather than guess.
 *
 * Returns a number, or null when no total can be read.
 */
export function parseRateUsd(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // Below this, a figure is a per-mile rate, a percentage, or a lumper fee —
  // truckload freight does not move for double digits. This is what catches a
  // bare "2.80" that carries no /mile marker to reject it by.
  const MIN_PLAUSIBLE_TOTAL = 100;
  // Above this we're reading a phone number, an MC number, or a zip run
  // together with something else. A single truckload does not pay $500k.
  const MAX_PLAUSIBLE_TOTAL = 500000;

  const candidates = [];
  // Numbers with optional thousands separators and decimals: 2400, 2,400, 2400.50
  const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

  let match;
  while ((match = NUMBER.exec(text)) !== null) {
    const raw = match[0];
    const after = text.slice(match.index + raw.length);
    const before = text.slice(0, match.index);

    // "$2.80/mile", "2.80 per mile", "$2.80/mi" — a unit rate, not a total.
    if (/^\s*(?:\/|per\b)\s*(?:mi\b|mile)/i.test(after)) continue;
    // "840 miles" — that's the distance, and parseMiles wants it, not us.
    if (/^\s*mi(?:les?)?\b/i.test(after)) continue;
    // "50% of", "2 stops", "43,000 lbs" — quantities that aren't the rate.
    if (/^\s*(?:%|lbs?\b|pounds?\b|stops?\b|pallets?\b)/i.test(after)) continue;
    // "MC 123456", "load 45678", "ref 8899" — identifiers.
    if (/(?:mc|dot|load|ref(?:erence)?|order|po)\s*#?\s*$/i.test(before)) continue;

    let value = Number(raw.replace(/,/g, ''));
    // "2.4k" / "$2.4K all in"
    if (/^\s*k\b/i.test(after) && value < 1000) value *= 1000;

    if (!Number.isFinite(value)) continue;
    if (value < MIN_PLAUSIBLE_TOTAL || value > MAX_PLAUSIBLE_TOTAL) continue;
    candidates.push(value);
  }

  if (candidates.length === 0) return null;
  // "$2.80/mile ($2,100 total)" leaves one candidate; "2200 offered, settled at
  // 2350" leaves two. The largest is the wrong answer about as often as the
  // last one is, but it's wrong in a direction that's easy to spot on a report
  // — and negotiated freight settles upward from the broker's first number.
  return Math.max(...candidates);
}

/**
 * Trip mileage, as an integer, or null when nothing usable is stated.
 *
 * `bareNumberOk` distinguishes the two callers. In the miles field a lone
 * "840" is unambiguously the answer. Anywhere else — scanning the rate text as
 * a fallback — it is not: a rate of "2400" would read as 2,400 miles and turn
 * a $2,400 load into a $1.00/mile one. Plausible, wrong, and invisible on a
 * report. So a bare number only counts when the field it came from means miles.
 */
export function parseMiles(text, { bareNumberOk = true } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const bare = bareNumberOk ? text.trim().match(/^(\d{1,3}(?:,\d{3})*|\d+)$/) : null;
  // Otherwise the figure has to be explicitly marked as a distance.
  const marked = text.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*(?:mi\b|miles?\b)/i);
  const raw = bare ? bare[1] : marked ? marked[1] : null;
  if (!raw) return null;

  const value = Math.round(Number(raw.replace(/,/g, '')));
  if (!Number.isFinite(value) || value <= 0) return null;
  // A 10,000-mile domestic truckload doesn't exist; that's a misheard figure.
  if (value > 10000) return null;
  return value;
}

/**
 * Build a human-readable title from the most important load details.
 * e.g. "Amarillo, TX → Tulsa, OK — Tue 6/24"
 * Falls back to "Load — Jul 24" using createdAt, then "Untitled load".
 */
export function generateTitle(data, createdAt) {
  const pickup = (data?.pickup_location || '').trim();
  const delivery = (data?.delivery_location || '').trim();
  const dt = (data?.pickup_datetime || '').trim();

  const loc = pickup && delivery
    ? `${shortLoc(pickup)} → ${shortLoc(delivery)}`
    : pickup || delivery || '';

  let title = loc;
  if (dt) {
    title = title ? `${title} — ${dt}` : dt;
  }

  if (title) return title;

  if (createdAt) {
    const d = new Date(createdAt);
    if (!Number.isNaN(d.getTime())) {
      return `Load — ${d.toLocaleString('en-US', { month: 'short', day: 'numeric' })}`;
    }
  }
  return 'Untitled load';
}

// Trim a location to its first comma part for a compact title
// ("Amarillo, TX 79106" → "Amarillo, TX").
function shortLoc(loc) {
  const parts = loc.split(',');
  if (parts.length <= 2) return loc.trim();
  return `${parts[0].trim()}, ${parts[1].trim()}`;
}

/**
 * Insert a new load or update the existing one identified by loadId.
 * Returns { id } on success, { id: null } on failure.
 *
 * orgId, when the caller currently belongs to an organization, is stamped
 * onto newly-inserted rows only — existing loads never get an org_id
 * retroactively, which is what keeps org dashboards "forward only".
 */
export async function saveLoad(
  supabase,
  userId,
  loadId,
  data,
  confidence,
  transcript,
  orgId,
  outcome = null
) {
  if (!supabase || !userId) return { id: null };

  const row = {};
  for (const key of LOAD_FIELDS) {
    row[key] = data?.[key] ?? '';
  }
  row.confidence = confidence || {};
  row.transcript = transcript || '';
  row.title = generateTitle(data, new Date().toISOString());
  row.updated_at = new Date().toISOString();

  // Derived on every write rather than once at insert: a dispatcher correcting
  // a misheard rate in the form has to move the reportable number too, or the
  // dashboard keeps quoting the transcription error.
  row.rate_usd = parseRateUsd(data?.rate);
  row.miles =
    parseMiles(String(data?.miles ?? '')) ??
    // Brokers often bundle the mileage into the rate sentence ("2.80 a mile,
    // 840 miles"). Scanned as a fallback, but only for an explicitly marked
    // figure — see the bareNumberOk note on parseMiles.
    parseMiles(String(data?.rate ?? ''), { bareNumberOk: false });

  // Only written when the caller actually asked the dispatcher. Autosave on
  // field edits passes null, which must leave a recorded outcome alone.
  if (outcome && OUTCOMES.includes(outcome)) row.outcome = outcome;

  try {
    if (loadId) {
      const { error } = await supabase
        .from('loads')
        .update(row)
        .eq('id', loadId);
      if (error) {
        console.error('saveLoad update failed:', error);
        return { id: loadId };
      }
      return { id: loadId };
    }

    row.user_id = userId;
    if (orgId) row.org_id = orgId;
    const { data: inserted, error } = await supabase
      .from('loads')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      console.error('saveLoad insert failed:', error);
      return { id: null };
    }
    return { id: inserted.id };
  } catch (err) {
    console.error('saveLoad exception:', err);
    return { id: loadId || null };
  }
}

/**
 * Fetch all loads for the current user, newest first (list view columns).
 *
 * Explicitly filtered to userId rather than relying on RLS alone: an org
 * admin's RLS grant additionally covers their org's other dispatchers'
 * loads (see 20260811000000_organizations.sql), and this is the personal
 * History panel — org-wide reads belong to the dashboard, not here.
 */
export async function fetchLoads(supabase, userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from('loads')
    .select(LIST_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('fetchLoads failed:', error);
    return [];
  }
  return data || [];
}

/** Fetch a single load with full details (for "Open"). */
export async function fetchLoad(supabase, id) {
  if (!supabase || !id) return null;
  const { data, error } = await supabase
    .from('loads')
    .select('*')
    .eq('id', id)
    .single();
  if (error) {
    console.error('fetchLoad failed:', error);
    return null;
  }
  return data;
}

/** Set a load's status ('active' | 'completed'). Returns true on success. */
export async function setLoadStatus(supabase, id, status) {
  if (!supabase || !id) return false;
  const { error } = await supabase
    .from('loads')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    console.error('setLoadStatus failed:', error);
    return false;
  }
  return true;
}

/**
 * Record how a load ended ('pending' | 'booked' | 'lost').
 *
 * Separate from setLoadStatus because the two are unrelated: archiving a load
 * in the history panel says nothing about whether it was won.
 */
export async function setLoadOutcome(supabase, id, outcome) {
  if (!supabase || !id || !OUTCOMES.includes(outcome)) return false;
  const { error } = await supabase
    .from('loads')
    .update({ outcome, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    console.error('setLoadOutcome failed:', error);
    return false;
  }
  return true;
}

/** Delete a load. Returns true on success. */
export async function deleteLoad(supabase, id) {
  if (!supabase || !id) return false;
  const { error } = await supabase.from('loads').delete().eq('id', id);
  if (error) {
    console.error('deleteLoad failed:', error);
    return false;
  }
  return true;
}

/** Render a load row into the driver-facing output text. */
export function loadToDriverText(load) {
  return renderTemplate(DEFAULT_TEMPLATE, load || {});
}