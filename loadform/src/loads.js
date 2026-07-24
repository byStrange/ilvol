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

// Lightweight columns used for the history list view.
const LIST_SELECT =
  'id,title,status,pickup_location,delivery_location,pickup_datetime,rate,created_at,updated_at';

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
 */
export async function saveLoad(supabase, userId, loadId, data, confidence, transcript) {
  if (!supabase || !userId) return { id: null };

  const row = {};
  for (const key of LOAD_FIELDS) {
    row[key] = data?.[key] ?? '';
  }
  row.confidence = confidence || {};
  row.transcript = transcript || '';
  row.title = generateTitle(data, new Date().toISOString());
  row.updated_at = new Date().toISOString();

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

/** Fetch all loads for the current user, newest first (list view columns). */
export async function fetchLoads(supabase) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('loads')
    .select(LIST_SELECT)
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