/**
 * score-call — review how a broker call was run.
 *
 * Reads a load's stored transcript, asks the model which steps of the call the
 * dispatcher completed, and writes the result back. The rubric and all the
 * reasoning behind it live in _shared/rubric.ts.
 *
 * Why this runs server-side even though the transcript is already on the
 * client: the score has to be untrusted input from the dispatcher's point of
 * view. The column grants in 20260814010000 stop a dispatcher writing their own
 * score, and that only means anything if the writer is the service role, here.
 *
 * Scoring is idempotent per load. An already-reviewed load returns its existing
 * result rather than spending provider money to produce a slightly different
 * number — a score that drifts every time someone opens a page is not a score.
 */

import { AuthError, json, requireUser, serveJson } from '../_shared/auth.ts';
import { llmCostUsd, recordUsage, serviceClient } from '../_shared/usage.ts';
import { stripFences } from '../_shared/prompt.ts';
import {
  MIN_TRANSCRIPT_WORDS,
  buildRubricPrompt,
  scoreFromOutput,
  type RubricOutput,
} from '../_shared/rubric.ts';

const OLLAMA_BASE_URL = Deno.env.get('OLLAMA_BASE_URL') ?? 'https://ollama.com';
const OLLAMA_API_KEY = Deno.env.get('OLLAMA_API_KEY')!;
const OLLAMA_MODEL = Deno.env.get('OLLAMA_MODEL') ?? 'gemma4:31b-cloud';

/** How many loads one batch call will review. Bounded by the function's wall
 * clock: each load is a full LLM round trip, so a large batch would time out
 * halfway and leave the rest silently unscored. */
const BATCH_LIMIT = 8;

type LoadRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  transcript: string | null;
  outcome: string;
  call_scored_at: string | null;
  call_score: number | null;
  call_checks: unknown;
  call_score_skipped: string | null;
};

/**
 * Who may ask for a load to be scored: the dispatcher who captured it, or an
 * owner/admin of the org it belongs to. Anyone else gets a 404 rather than a
 * 403, so this can't be used to discover which load ids exist.
 */
async function loadForCaller(loadId: string, userId: string): Promise<LoadRow> {
  const db = serviceClient();
  const { data, error } = await db
    .from('loads')
    .select(
      'id, user_id, org_id, transcript, outcome, call_scored_at, call_score, call_checks, call_score_skipped'
    )
    .eq('id', loadId)
    .maybeSingle();

  if (error) {
    console.error('load lookup failed:', error.message);
    throw new AuthError('Could not load that call', 500);
  }
  if (!data) throw new AuthError('No such load', 404);

  if (data.user_id === userId) return data as LoadRow;

  if (data.org_id) {
    const { data: membership } = await db
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('org_id', data.org_id)
      .eq('status', 'active')
      .maybeSingle();
    if (membership && (membership.role === 'owner' || membership.role === 'admin')) {
      return data as LoadRow;
    }
  }

  throw new AuthError('No such load', 404);
}

async function skip(loadId: string, reason: string) {
  await serviceClient()
    .from('loads')
    .update({ call_score_skipped: reason, call_scored_at: new Date().toISOString() })
    .eq('id', loadId);
}

/**
 * Review one load. Returns what was written, or what was already there.
 *
 * `spend` reports whether provider money was actually spent, so the caller can
 * meter a batch without counting the loads it short-circuited.
 */
async function scoreLoad(
  load: LoadRow,
  userId: string
): Promise<{ result: Record<string, unknown>; spend: { input: number; output: number } | null }> {
  // Already reviewed, or already found unreviewable.
  if (load.call_scored_at) {
    return {
      result: {
        load_id: load.id,
        score: load.call_score,
        checks: load.call_checks,
        skipped: load.call_score_skipped,
        cached: true,
      },
      spend: null,
    };
  }

  const transcript = (load.transcript ?? '').trim();
  const words = transcript ? transcript.split(/\s+/).length : 0;

  // Cheap refusals first, before any provider call. A twenty-second call that
  // ended with "it's covered" contains no steps to review, and scoring it would
  // add a zero to someone's average for a call that never happened.
  if (words < MIN_TRANSCRIPT_WORDS) {
    const reason = words === 0 ? 'no_transcript' : 'too_short';
    await skip(load.id, reason);
    return { result: { load_id: load.id, skipped: reason }, spend: null };
  }
  if (load.outcome === 'pending') {
    // Still being worked — the call isn't over in any meaningful sense.
    return { result: { load_id: load.id, skipped: 'still_pending' }, spend: null };
  }

  const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildRubricPrompt(transcript),
      stream: false,
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`Ollama error ${res.status}: ${bodyText.slice(0, 300)}`);
    throw new AuthError(`Scoring provider error (${res.status})`, 502);
  }

  let raw: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const provider = JSON.parse(bodyText) as {
      response: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    raw = provider.response;
    inputTokens = provider.prompt_eval_count ?? 0;
    outputTokens = provider.eval_count ?? 0;
  } catch {
    throw new AuthError('Malformed response from scoring provider', 502);
  }

  let parsed: RubricOutput;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    console.error(`Unparseable rubric output for load ${load.id}: ${raw.slice(0, 300)}`);
    await skip(load.id, 'unparseable');
    return {
      result: { load_id: load.id, skipped: 'unparseable' },
      spend: { input: inputTokens, output: outputTokens },
    };
  }

  const scored = scoreFromOutput(parsed, transcript);
  if (!scored || scored.score === null) {
    const reason = scored ? 'no_applicable_steps' : (parsed.reason ?? 'unscoreable').slice(0, 200);
    await skip(load.id, reason);
    return {
      result: { load_id: load.id, skipped: reason },
      spend: { input: inputTokens, output: outputTokens },
    };
  }

  const { error: updateError } = await serviceClient()
    .from('loads')
    .update({
      call_checks: scored.checks,
      call_score: scored.score,
      call_scored_at: new Date().toISOString(),
      call_score_skipped: null,
    })
    .eq('id', load.id);

  if (updateError) {
    console.error('score write failed:', updateError.message);
    throw new AuthError('Could not save the review', 500);
  }

  await recordUsage({
    user_id: userId,
    load_id: load.id,
    event_type: 'call_scored',
    llm_input_tokens: inputTokens,
    llm_output_tokens: outputTokens,
    est_cost_usd: llmCostUsd(inputTokens, outputTokens),
    idempotency_key: `call_scored:${load.id}`,
    metadata: { model: OLLAMA_MODEL, applicable: scored.applicable, passed: scored.passed },
  });

  return {
    result: {
      load_id: load.id,
      score: scored.score,
      checks: scored.checks,
      passed: scored.passed,
      applicable: scored.applicable,
    },
    spend: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Review the org's backlog of unscored calls.
 *
 * Admin-only and explicitly bounded. This is the path that turns on scoring for
 * a team that has been capturing for weeks — transcripts are already stored, so
 * unlike outcomes, call quality is fully backfillable.
 */
async function scoreBacklog(userId: string): Promise<Response> {
  const db = serviceClient();
  const { data: membership } = await db
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw new AuthError('Only an organization owner or admin can review calls', 403);
  }

  const { data: pending, error } = await db
    .from('loads')
    .select(
      'id, user_id, org_id, transcript, outcome, call_scored_at, call_score, call_checks, call_score_skipped'
    )
    .eq('org_id', membership.org_id)
    .is('call_scored_at', null)
    .neq('outcome', 'pending')
    .order('created_at', { ascending: false })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error('backlog query failed:', error.message);
    throw new AuthError('Could not read the backlog', 500);
  }

  const results = [];
  for (const load of pending ?? []) {
    // Sequential rather than parallel: these are large prompts, and firing
    // eight at once is how you collect a rate limit instead of eight reviews.
    results.push((await scoreLoad(load as LoadRow, userId)).result);
  }

  const { count } = await db
    .from('loads')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)
    .is('call_scored_at', null)
    .neq('outcome', 'pending');

  return json({ reviewed: results.length, remaining: count ?? 0, results });
}

Deno.serve(
  serveJson(async (req) => {
    const { user } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      load_id?: string;
    };

    if (!OLLAMA_API_KEY) {
      return json({ error: 'OLLAMA_API_KEY secret is not configured' }, 500);
    }

    switch (body.action) {
      case 'score': {
        if (!body.load_id) return json({ error: 'load_id is required' }, 400);
        const load = await loadForCaller(body.load_id, user.id);
        const { result } = await scoreLoad(load, user.id);
        return json(result);
      }
      case 'backlog':
        return await scoreBacklog(user.id);
      default:
        return json({ error: `Unknown action: ${body.action || '(none)'}` }, 400);
    }
  }),
);
