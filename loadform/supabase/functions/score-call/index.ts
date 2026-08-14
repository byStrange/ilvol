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
  buildLossReasonPrompt,
  buildRubricPrompt,
  lossReasonFromOutput,
  lostOnCall,
  scoreFromOutput,
  type LossOutput,
  type RubricOutput,
  type ScoredCall,
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
  loss_reason: string | null;
  loss_reason_source: string | null;
};

// One unbroken literal, not a concatenation: supabase-js parses this string at
// the type level to infer the row shape, and a joined const arrives as plain
// `string`, which collapses every read below into an error type.
const LOAD_COLUMNS =
  'id, user_id, org_id, transcript, outcome, call_scored_at, call_score, call_checks, call_score_skipped, loss_reason, loss_reason_source' as const;

type Spend = { input: number; output: number };

/** One prompt to the provider. Split out because two passes now use it. */
async function askModel(prompt: string): Promise<{ raw: string; spend: Spend }> {
  const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`Ollama error ${res.status}: ${bodyText.slice(0, 300)}`);
    throw new AuthError(`Scoring provider error (${res.status})`, 502);
  }

  try {
    const provider = JSON.parse(bodyText) as {
      response: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      raw: provider.response,
      spend: { input: provider.prompt_eval_count ?? 0, output: provider.eval_count ?? 0 },
    };
  } catch {
    throw new AuthError('Malformed response from scoring provider', 502);
  }
}

/**
 * Who may ask for a load to be scored: the dispatcher who captured it, or an
 * owner/admin of the org it belongs to. Anyone else gets a 404 rather than a
 * 403, so this can't be used to discover which load ids exist.
 */
async function loadForCaller(loadId: string, userId: string): Promise<LoadRow> {
  const db = serviceClient();
  const { data, error } = await db
    .from('loads')
    .select(LOAD_COLUMNS)
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
 * Score the nine rubric steps. Returns null when the load was skipped, having
 * already recorded why.
 */
async function runChecks(
  load: LoadRow,
  transcript: string,
  userId: string,
  spent: Spend[]
): Promise<{ scored: ScoredCall | null; skipped: string | null }> {
  const { raw, spend } = await askModel(buildRubricPrompt(transcript));
  spent.push(spend);

  let parsed: RubricOutput;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    console.error(`Unparseable rubric output for load ${load.id}: ${raw.slice(0, 300)}`);
    await skip(load.id, 'unparseable');
    return { scored: null, skipped: 'unparseable' };
  }

  const scored = scoreFromOutput(parsed, transcript);
  if (!scored || scored.score === null) {
    const reason = scored ? 'no_applicable_steps' : (parsed.reason ?? 'unscoreable').slice(0, 200);
    await skip(load.id, reason);
    return { scored: null, skipped: reason };
  }

  const { error } = await serviceClient()
    .from('loads')
    .update({
      call_checks: scored.checks,
      call_score: scored.score,
      call_scored_at: new Date().toISOString(),
      call_score_skipped: null,
    })
    .eq('id', load.id);

  if (error) {
    console.error('score write failed:', error.message);
    throw new AuthError('Could not save the review', 500);
  }

  await recordUsage({
    user_id: userId,
    load_id: load.id,
    event_type: 'call_scored',
    llm_input_tokens: spend.input,
    llm_output_tokens: spend.output,
    est_cost_usd: llmCostUsd(spend.input, spend.output),
    idempotency_key: `call_scored:${load.id}`,
    metadata: { model: OLLAMA_MODEL, applicable: scored.applicable, passed: scored.passed },
  });

  return { scored, skipped: null };
}

/**
 * Work out why a lost load was lost, and record it.
 *
 * Two passes, in this order and not the other, because the second is an
 * accusation and the first is not:
 *
 *   1. Ask the transcript for a reason the broker stated, which must be
 *      quotable. This catches the large majority — brokers say why.
 *   2. Only if that finds nothing, ask whether the checks show a call that was
 *      never really worked (see lostOnCall). This is the one reason that lands
 *      on the dispatcher, so it is the last resort rather than the first guess.
 *
 * Either way `loss_reason_source` is stamped 'ai', including when the answer is
 * "no idea". That is what stops the backlog sweep from paying to re-read the
 * same unquotable call every night.
 */
async function runLossReason(
  load: LoadRow,
  transcript: string,
  checks: ScoredCall['checks'] | null,
  userId: string,
  spent: Spend[]
): Promise<Record<string, unknown>> {
  const { raw, spend } = await askModel(buildLossReasonPrompt(transcript));
  spent.push(spend);

  let finding;
  try {
    finding = lossReasonFromOutput(JSON.parse(stripFences(raw)) as LossOutput, transcript);
  } catch {
    console.error(`Unparseable loss output for load ${load.id}: ${raw.slice(0, 300)}`);
    finding = { reason: null, quote: '', note: 'unparseable' as const };
  }

  let reason = finding.reason;
  let quote = finding.quote;
  if (!reason && lostOnCall(checks)) {
    reason = 'lost_on_call';
    // Derived from missed steps rather than quoted, so there is deliberately no
    // quote here. The evidence a dispatcher disputes is the step breakdown
    // itself, which carries its own quotes.
    quote = '';
  }

  const { error } = await serviceClient()
    .from('loads')
    .update({
      loss_reason: reason,
      loss_reason_quote: quote || null,
      loss_reason_source: 'ai',
    })
    .eq('id', load.id);

  if (error) {
    console.error('loss reason write failed:', error.message);
    throw new AuthError('Could not save the loss reason', 500);
  }

  await recordUsage({
    user_id: userId,
    load_id: load.id,
    event_type: 'call_scored',
    llm_input_tokens: spend.input,
    llm_output_tokens: spend.output,
    est_cost_usd: llmCostUsd(spend.input, spend.output),
    idempotency_key: `loss_reason:${load.id}`,
    metadata: { model: OLLAMA_MODEL, loss_reason: reason, derived: reason === 'lost_on_call' },
  });

  return { loss_reason: reason, loss_reason_quote: quote || null, loss_note: finding.note };
}

/**
 * Review one load: how the call was run, and — when it was lost — why.
 *
 * The two halves are independently idempotent. A load scored before loss
 * inference existed still gets its reason on the next sweep without paying to
 * re-score steps that have not changed, and a load whose outcome flips from
 * booked to lost months later gets a reason without a second rubric pass.
 *
 * `spend` reports whether provider money was actually spent, so the caller can
 * meter a batch without counting the loads it short-circuited.
 */
async function scoreLoad(
  load: LoadRow,
  userId: string
): Promise<{ result: Record<string, unknown>; spend: Spend | null }> {
  const spent: Spend[] = [];
  const result: Record<string, unknown> = { load_id: load.id };

  const transcript = (load.transcript ?? '').trim();
  const words = transcript ? transcript.split(/\s+/).length : 0;
  const needsChecks = !load.call_scored_at;
  // A reason is wanted only for a lost load nothing has looked at yet. The
  // source column, not the reason column, is the flag: a load the scorer read
  // and could not explain has a null reason and must not be read again.
  const needsReason = load.outcome === 'lost' && !load.loss_reason && !load.loss_reason_source;

  if (!needsChecks && !needsReason) {
    return {
      result: {
        ...result,
        score: load.call_score,
        checks: load.call_checks,
        skipped: load.call_score_skipped,
        loss_reason: load.loss_reason,
        cached: true,
      },
      spend: null,
    };
  }

  // Cheap refusals first, before any provider call. A twenty-second call that
  // ended with "it's covered" contains no steps to review, and scoring it would
  // add a zero to someone's average for a call that never happened.
  if (words < MIN_TRANSCRIPT_WORDS) {
    const reason = words === 0 ? 'no_transcript' : 'too_short';
    if (needsChecks) await skip(load.id, reason);
    if (needsReason) {
      // Nothing to read, so nothing will ever be readable here. Stamped as
      // looked-at so the sweep stops offering it.
      await serviceClient()
        .from('loads')
        .update({ loss_reason_source: 'ai' })
        .eq('id', load.id);
    }
    return { result: { ...result, skipped: reason }, spend: null };
  }
  if (load.outcome === 'pending') {
    // Still being worked — the call isn't over in any meaningful sense.
    return { result: { ...result, skipped: 'still_pending' }, spend: null };
  }

  let checks: ScoredCall['checks'] | null =
    (load.call_checks as ScoredCall['checks'] | null) ?? null;

  if (needsChecks) {
    const { scored, skipped } = await runChecks(load, transcript, userId, spent);
    if (skipped) {
      // The steps could not be read, so lostOnCall has nothing to stand on and
      // the reason pass would be a guess. Left for a later sweep only if the
      // transcript itself might improve, which it will not — so it is stamped.
      if (needsReason) {
        await serviceClient()
          .from('loads')
          .update({ loss_reason_source: 'ai' })
          .eq('id', load.id);
      }
      return { result: { ...result, skipped }, spend: totalSpend(spent) };
    }
    checks = scored!.checks;
    Object.assign(result, {
      score: scored!.score,
      checks: scored!.checks,
      passed: scored!.passed,
      applicable: scored!.applicable,
    });
  } else {
    Object.assign(result, { score: load.call_score, checks: load.call_checks, cached_checks: true });
  }

  if (needsReason) {
    Object.assign(result, await runLossReason(load, transcript, checks, userId, spent));
  }

  return { result, spend: totalSpend(spent) };
}

function totalSpend(spent: Spend[]): Spend | null {
  if (spent.length === 0) return null;
  return spent.reduce(
    (acc, s) => ({ input: acc.input + s.input, output: acc.output + s.output }),
    { input: 0, output: 0 }
  );
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

  // Two kinds of outstanding work, and a load can need either or both: steps
  // never scored, or a lost load with no reason established yet. Expressed as
  // one OR so a load needing both is reviewed once rather than twice.
  const OUTSTANDING =
    'call_scored_at.is.null,and(outcome.eq.lost,loss_reason.is.null,loss_reason_source.is.null)';

  const { data: pending, error } = await db
    .from('loads')
    .select(LOAD_COLUMNS)
    .eq('org_id', membership.org_id)
    .neq('outcome', 'pending')
    .or(OUTSTANDING)
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
    .neq('outcome', 'pending')
    .or(OUTSTANDING);

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
