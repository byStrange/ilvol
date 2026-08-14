/**
 * LoadForm — Supabase client + server-side provider proxies.
 *
 * Provider credentials are NOT in this app. Deepgram and Ollama keys live only
 * in Edge Function secrets; this module is how the client reaches them, always
 * authenticated as the signed-in user.
 *
 * Two shapes, because the two providers need different things:
 *
 *   getDeepgramToken()  — broker. Returns a short-lived Deepgram token that the
 *                         Rust backend uses for its WebSocket handshake. Audio
 *                         then streams direct to Deepgram. It cannot be a real
 *                         proxy: Edge Functions hard-cap at 150s (Free) / 400s
 *                         (Pro) wall clock, which would sever a normal call.
 *
 *   extractLoad()       — true proxy. One request in, structured fields out.
 *
 * Both windows (main + widget) import this module. Each webview is its own JS
 * context so each ends up with its own client instance, but they share an
 * origin — and therefore localStorage and the Web Locks namespace — so
 * supabase-js coordinates session refresh between them exactly as it does
 * between browser tabs.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://tusiipxekbfheihjrjbd.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1c2lpcHhla2JmaGVpaGpyamJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDExMTgsImV4cCI6MjA5OTA3NzExOH0.s86u7JDk0mgYqSm_NNKOQnIHKfWlizRt5xswd5vc1xI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Turn an Edge Function failure into something worth showing a user.
 * A 402 is the quota wall, so it gets its own flag.
 *
 * Async because the useful text is in the *response body*, not in the error:
 * on a non-2xx, functions.invoke resolves with data = null and a
 * FunctionsHttpError whose `message` is only ever the generic "Edge Function
 * returned a non-2xx status code". The body — where our own error string and
 * quota details live — hangs off error.context as an unread Response.
 */
async function edgeError(error, data) {
  const status = error?.context?.status;

  let body = data;
  if (!body?.error && typeof error?.context?.json === 'function') {
    body = await error.context.json().catch(() => null);
  }

  const err = new Error(body?.error || error?.message || 'Request failed');
  err.status = status;
  err.quotaExceeded = status === 402;
  err.quota = body?.quota ?? null;
  return err;
}

/**
 * Mint a short-lived Deepgram access token for one capture session.
 * Valid for ~60s — only long enough to complete the WebSocket handshake. The
 * stream stays open for the full call after that, so this does not bound how
 * long a dispatcher can talk.
 */
export async function getDeepgramToken(source = null) {
  const { data, error } = await supabase.functions.invoke('deepgram-token', {
    body: { source },
  });
  if (error || !data?.access_token) throw await edgeError(error, data);
  return {
    token: data.access_token,
    captureId: data.capture_id,
    capturesRemaining: data.captures_remaining ?? null,
    capturesLimit: data.captures_limit ?? null,
  };
}

/**
 * Extract structured load fields from a transcript.
 * Returns { data, confidence } — same shape the Rust command used to return.
 * `captureId` ties this extraction to its capture session for metering.
 */
export async function extractLoad(transcript, captureId = null) {
  const { data, error } = await supabase.functions.invoke('extract', {
    body: { transcript, capture_id: captureId },
  });
  if (error || !data?.data) throw await edgeError(error, data);
  return data;
}

/**
 * Read the signed-in user's usage totals for the current billing month.
 *
 * Goes through the usage_summary() RPC rather than querying usage_daily
 * directly so the billing-day boundary (US Central, not UTC) is defined in one
 * place — the client must not reimplement it and drift.
 *
 * Returns null on failure: usage is ambient information, and a hiccup here
 * should leave the display blank rather than interrupt anyone.
 */
export async function fetchUsageSummary() {
  const { data, error } = await supabase.rpc('usage_summary');
  if (error) {
    console.warn('usage_summary failed:', error.message);
    return null;
  }
  // Postgres set-returning functions come back as an array of rows.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  // "Loads" are capture sessions, matching what the quota counts. Extractions
  // are a separate, much larger number (auto-extract re-runs during a call) and
  // are cost telemetry rather than anything to show as a load count.
  return {
    loadsToday: row.captures_today ?? 0,
    loadsMonth: row.captures_month ?? 0,
    extractionsToday: row.extractions_today ?? 0,
    extractionsMonth: row.extractions_month ?? 0,
    audioSecondsMonth: Number(row.audio_seconds_month ?? 0),
    estCostUsdMonth: Number(row.est_cost_usd_month ?? 0),
  };
}

/**
 * Read the caller's plan limits and today's usage against them.
 *
 * Same tolerance as fetchUsageSummary: returns null on failure so the UI leaves
 * the counter blank instead of inventing a limit. The server is the authority —
 * this is only for display, and the gate lives in the Edge Functions.
 */
export async function fetchQuotaStatus() {
  const { data, error } = await supabase.rpc('quota_status');
  if (error) {
    console.warn('quota_status failed:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    plan: row.plan ?? 'free',
    capturesUsed: row.captures_used ?? 0,
    capturesLimit: row.captures_limit ?? null,
    extractionsUsed: row.extractions_used ?? 0,
    extractionsLimit: row.extractions_limit ?? null,
  };
}

/**
 * Create a login for a dispatcher, as their org owner/admin.
 *
 * Returns the password exactly once — it is never stored anywhere the app can
 * read it back, so the only copy is the one shown to the owner. If `password` is
 * omitted the server generates one.
 *
 * `outcome` says what actually happened: 'created' for a new login (credentials
 * included), or 'invited' when that address already had a LoadForm account and
 * could therefore only be asked to join.
 */
export async function createTeamMember({ email, password = null, role = 'dispatcher' }) {
  const { data, error } = await supabase.functions.invoke('member-accounts', {
    body: { action: 'create', email, password, role },
  });
  if (error || !data?.outcome) throw await edgeError(error, data);
  return data;
}

/**
 * Set a new password on an account the org created, for a dispatcher who forgot
 * theirs. With no email provider there is no self-serve reset, so this is the
 * only way back in — and it only works on logins the org provisioned itself.
 */
export async function resetMemberPassword({ memberId, password = null }) {
  const { data, error } = await supabase.functions.invoke('member-accounts', {
    body: { action: 'reset_password', member_id: memberId, password },
  });
  if (error || !data?.password) throw await edgeError(error, data);
  return data;
}

/**
 * Change the signed-in user's own password.
 *
 * The dispatcher-facing half of provisioned accounts: an owner hands over a
 * generated password, and this is how it stops being the owner's to know.
 */
export async function changeOwnPassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * The team medians a dispatcher's own scorecard is read against.
 *
 * The verdict (performing / easy freight / not their fault / needs coaching) is
 * a comparison to peers, and peer loads are admin-only by RLS — so the
 * comparison can only exist server-side. This returns the two medians and how
 * many peers qualified, nothing per-person. Returns null on failure: the
 * scorecard degrades to "no one to compare against yet" rather than breaking.
 */
export async function fetchPeerMedians() {
  const { data, error } = await supabase.rpc('peer_medians');
  if (error) {
    console.warn('peer_medians failed:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    medianProcessScore: row.median_process_score ?? null,
    medianBookingRate: row.median_booking_rate ?? null,
    peerCount: row.peer_count ?? 0,
  };
}

/**
 * Ask the server to review a finished call against the rubric.
 *
 * Idempotent per load: a call already reviewed returns its stored result
 * without spending provider money again. The score is written server-side
 * because a dispatcher must not be able to write their own — see the column
 * grants in 20260814010000_call_quality.sql.
 */
export async function scoreCall(loadId) {
  const { data, error } = await supabase.functions.invoke('score-call', {
    body: { action: 'score', load_id: loadId },
  });
  if (error) throw await edgeError(error, data);
  return data;
}

/**
 * Review a batch of the org's unreviewed calls.
 *
 * Transcripts are already stored, so unlike outcomes, call quality is fully
 * backfillable — an org that has been capturing for weeks can score its history
 * rather than starting from nothing. Returns how many are left so the caller
 * can keep going.
 */
export async function scoreCallBacklog() {
  const { data, error } = await supabase.functions.invoke('score-call', {
    body: { action: 'backlog' },
  });
  if (error) throw await edgeError(error, data);
  return data;
}

/**
 * Report how long a capture ran, once it stops.
 *
 * Best-effort and intentionally silent on failure: this is analytics, and a
 * dropped row must never surface as an error to someone who just finished a
 * call. Server-side truth (load_extracted) is recorded separately.
 */
export async function reportCaptureEnded(captureId, audioSeconds) {
  if (!captureId) return;
  try {
    await supabase.functions.invoke('usage-report', {
      body: { capture_id: captureId, audio_seconds: audioSeconds },
    });
  } catch (err) {
    console.warn('usage report failed (non-fatal):', err);
  }
}
