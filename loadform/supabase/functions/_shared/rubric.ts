/**
 * The call rubric.
 *
 * What this measures: whether a dispatcher ran the steps of a broker call.
 * What it deliberately does NOT measure: how well they spoke.
 *
 * That line is the whole design. These are ASR transcripts of speakerphone
 * calls in a noisy office, and word error rate correlates with accent — US
 * dispatch is heavily staffed by non-native English speakers. A model asked to
 * rate fluency, professionalism or rapport would be scoring transcription
 * quality wearing the mask of a performance review, and nobody looking at the
 * number would be able to tell. Every check below is therefore a discrete
 * question about whether a topic was raised, which survives a mangled
 * transcript far better than any judgement of delivery.
 *
 * Three rules make the output auditable:
 *
 *   1. A `pass` must carry a verbatim quote from the transcript. The scorer
 *      discards a pass without one, so the model cannot assert competence it
 *      can't evidence — and a dispatcher can read the quote and argue with it.
 *
 *   2. `na` is a real answer. A call that ended in twenty seconds because the
 *      load was gone offers no chance to negotiate, and marking that a miss
 *      would penalise a dispatcher for the broker's news. N/A steps leave the
 *      denominator entirely.
 *
 *   3. Unscoreable is a real answer too. Too short, too garbled, not a broker
 *      call at all — the scorer says so instead of guessing, and the load is
 *      recorded as skipped rather than as a bad score.
 */

export type CheckId =
  | 'rate_asked'
  | 'rate_negotiated'
  | 'pickup_confirmed'
  | 'delivery_confirmed'
  | 'appointment_type'
  | 'freight_details'
  | 'equipment_confirmed'
  | 'accessorials_raised'
  | 'next_steps';

export type CheckResult = 'pass' | 'miss' | 'na';

export const CHECKS: { id: CheckId; label: string; asks: string }[] = [
  {
    id: 'rate_asked',
    label: 'Asked the rate',
    asks: 'Did the dispatcher find out what the load pays?',
  },
  {
    id: 'rate_negotiated',
    label: 'Negotiated',
    asks:
      'Did the dispatcher push back on the money at least once — a counter, a request for more, or a stated minimum? N/A if the first number was already acceptable or the load was gone before money came up.',
  },
  {
    id: 'pickup_confirmed',
    label: 'Pinned the pickup',
    asks: 'Did they establish both where it picks up and when?',
  },
  {
    id: 'delivery_confirmed',
    label: 'Pinned the delivery',
    asks: 'Did they establish both where it delivers and when?',
  },
  {
    id: 'appointment_type',
    label: 'Checked appointment vs FCFS',
    asks:
      'Did they establish whether either end is a firm appointment or first-come-first-served? This is what decides whether a driver waits six hours.',
  },
  {
    id: 'freight_details',
    label: 'Got the freight details',
    asks: 'Did they establish what is being shipped and roughly what it weighs?',
  },
  {
    id: 'equipment_confirmed',
    label: 'Confirmed equipment',
    asks:
      'Did they establish the trailer type or any special equipment requirement (reefer temperature, tarps, straps, load bars)?',
  },
  {
    id: 'accessorials_raised',
    label: 'Raised accessorials',
    asks:
      'Did they ask about anything beyond the line-haul rate — lumper fees, detention, extra stops, tarp pay, driver assist? This is where margin quietly disappears.',
  },
  {
    id: 'next_steps',
    label: 'Closed with next steps',
    asks:
      'Did the call end with an agreed next action — rate confirmation, carrier packet, driver details, a callback? N/A if the broker declined outright, since there is then nothing to arrange.',
  },
];

/** Below this the transcript cannot contain a real broker call. */
export const MIN_TRANSCRIPT_WORDS = 40;

export function buildRubricPrompt(transcript: string): string {
  return `You are reviewing a transcript of a phone call between a freight dispatcher and a broker. The dispatcher works for a trucking company and is trying to book the load for one of their trucks.

Your job is to record which steps of the call the dispatcher completed. You are NOT rating how well they spoke.

CRITICAL RULES — these override anything else:

1. Judge ONLY whether a topic was raised or a fact was established. Never judge grammar, vocabulary, accent, fluency, politeness, tone, confidence, or professionalism. A blunt dispatcher who covers every step scores full marks. A charming one who forgets to ask about detention does not.

2. Every "pass" MUST include a short verbatim quote from the transcript that shows it. Copy the words exactly as they appear. If you cannot find a quote, the answer is not "pass".

3. Use "na" when the call gave no opportunity for that step — for example, negotiation when the broker said the load was already covered before any rate was discussed. Do not use "na" simply because the dispatcher forgot; that is "miss".

4. This is a live call transcript and may be incomplete, mis-transcribed, or cut off. If it is too short, too garbled, or clearly not a broker call, return the unscoreable form below instead of guessing.

The steps:
${CHECKS.map((c) => `- ${c.id}: ${c.asks}`).join('\n')}

Return ONLY valid JSON, no markdown fences, in exactly this shape:
{
  "scoreable": true,
  "checks": {
${CHECKS.map((c) => `    "${c.id}": { "result": "pass" | "miss" | "na", "quote": "exact words from the transcript, or empty string" }`).join(',\n')}
  }
}

If the call cannot be reviewed, return instead:
{
  "scoreable": false,
  "reason": "one short sentence on why"
}

Transcript:
${transcript}`;
}

export type RubricOutput = {
  scoreable: boolean;
  reason?: string;
  checks?: Record<string, { result: string; quote?: string }>;
};

export type ScoredCall = {
  checks: Record<CheckId, { result: CheckResult; quote: string }>;
  score: number | null;
  passed: number;
  applicable: number;
};

/**
 * Turn raw model output into a score, discarding anything it can't evidence.
 *
 * The quote requirement is enforced here rather than trusted from the prompt:
 * a pass whose quote is empty, or whose quote does not actually appear in the
 * transcript, is downgraded to a miss. A model that invents evidence therefore
 * cannot inflate anyone's score, only deflate it — which is the safe direction
 * for a number attached to someone's job.
 */
export function scoreFromOutput(output: RubricOutput, transcript: string): ScoredCall | null {
  if (!output?.scoreable || !output.checks) return null;

  const haystack = normalize(transcript);
  const checks = {} as ScoredCall['checks'];
  let passed = 0;
  let applicable = 0;

  for (const { id } of CHECKS) {
    const raw = output.checks[id];
    const quote = typeof raw?.quote === 'string' ? raw.quote.trim() : '';
    let result: CheckResult =
      raw?.result === 'pass' || raw?.result === 'na' ? raw.result : 'miss';

    if (result === 'pass' && !quoteAppears(quote, haystack)) {
      // Claimed without evidence. Treated as not done rather than dropped, so
      // the miss is visible on the scorecard with no quote beside it.
      result = 'miss';
    }

    checks[id] = { result, quote: result === 'pass' ? quote : '' };
    if (result === 'na') continue;
    applicable += 1;
    if (result === 'pass') passed += 1;
  }

  return {
    checks,
    passed,
    applicable,
    // A call where every step was N/A has no score — not a zero.
    score: applicable > 0 ? Math.round((passed / applicable) * 10000) / 100 : null,
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ─── Why the load was lost ──────────────────────────────────────────────────
 *
 * The taxonomy splits into two kinds of reason, and they cannot be established
 * the same way.
 *
 * Six of them are things the broker says out loud. "It's already covered",
 * "that's all it pays", "I need a reefer" — each is a sentence in the
 * transcript, so each can be quoted, and the same rule as the rubric applies:
 * no quote, no reason.
 *
 * The seventh, lost_on_call, is an absence. Nobody announces it; it is what
 * happened when the dispatcher had a live load, a truck and an acceptable rate
 * and still did not come away with it. Asking a model to spot that would be
 * asking for an unevidenced judgement about a person — exactly what the rubric
 * was built to avoid — so it is not in the prompt at all. It is derived from
 * the checks, below.
 */

/** Reasons a broker states, and the model may therefore propose. */
export const QUOTABLE_LOSS_REASONS = [
  'rate_too_low',
  'already_covered',
  'no_truck',
  'requirements',
  'schedule',
  'other',
] as const;

export type LossReason = (typeof QUOTABLE_LOSS_REASONS)[number] | 'lost_on_call';

export type LossFinding = {
  reason: LossReason | null;
  quote: string;
  /** Set when nothing could be established, for the operator reading logs. */
  note?: string;
};

export function buildLossReasonPrompt(transcript: string): string {
  return `You are reading a transcript of a phone call between a freight dispatcher and a broker. The dispatcher did NOT end up hauling this load. Your job is to find out why, using only what was actually said.

CRITICAL RULES — these override anything else:

1. Report only a reason the broker or dispatcher stated out loud. You MUST include a short verbatim quote showing it. Copy the words exactly as they appear in the transcript. If you cannot find a quote, the answer is "unknown".

2. Do NOT infer a reason from the dispatcher's performance, tone, or from what they failed to ask. If the transcript does not say why the load was lost, the answer is "unknown". "Unknown" is a good answer and is expected often — many calls end without the reason being spoken.

3. Never guess between two reasons. If both a rate problem and a scheduling problem were mentioned, pick the one the call actually ended on.

The reasons:
- rate_too_low: the money did not work. The broker would not pay what was needed, or the rate offered was refused.
- already_covered: the load was gone before or during the call — another carrier had it.
- no_truck: no truck available for it, or the wrong trailer for the freight.
- requirements: could not meet something the broker required — authority, insurance limits, TWIC, hazmat, team drivers, a tracking app.
- schedule: could not make the pickup or delivery window.
- other: a reason clearly stated that fits none of the above.

Return ONLY valid JSON, no markdown fences, in exactly this shape:
{
  "reason": "rate_too_low" | "already_covered" | "no_truck" | "requirements" | "schedule" | "other" | "unknown",
  "quote": "exact words from the transcript, or empty string"
}

Transcript:
${transcript}`;
}

export type LossOutput = { reason?: string; quote?: string };

/**
 * Turn the model's answer into a recorded reason, or into nothing.
 *
 * Same enforcement as the rubric: the quote must actually appear in the
 * transcript, or the finding is discarded. A model that invents evidence here
 * cannot manufacture a reason, it can only fail to produce one — and a missing
 * reason is visible on the dashboard as "no reason recorded", which is honest.
 */
export function lossReasonFromOutput(output: LossOutput, transcript: string): LossFinding {
  const reason = String(output?.reason ?? '').trim();
  if (!reason || reason === 'unknown') return { reason: null, quote: '', note: 'not_stated' };

  if (!QUOTABLE_LOSS_REASONS.includes(reason as typeof QUOTABLE_LOSS_REASONS[number])) {
    // Includes the model reaching for lost_on_call, which it was never offered.
    return { reason: null, quote: '', note: 'invalid_reason' };
  }

  const quote = typeof output.quote === 'string' ? output.quote.trim() : '';
  if (!quoteAppears(quote, normalize(transcript))) {
    return { reason: null, quote: '', note: 'unevidenced' };
  }

  return { reason: reason as LossReason, quote };
}

/**
 * Was this load lost on the call itself?
 *
 * Only asked once the transcript has been searched for an external reason and
 * come back empty. The claim being made is narrow: nothing in the call explains
 * the loss, and the dispatcher neither pushed on the money nor arranged a next
 * step. A load that gets that far and still goes nowhere was lost in the room.
 *
 * Both misses are required, and an `na` on either is disqualifying. That is
 * deliberately hard to trigger: this is the one reason that lands on a person,
 * so the failure mode to avoid is a false positive. A call that negotiated but
 * arranged nothing, or arranged something but never argued the rate, comes back
 * unexplained instead — which costs an owner one row of missing data, where the
 * opposite error costs a dispatcher a conversation they did not earn.
 */
export function lostOnCall(checks: ScoredCall['checks'] | null | undefined): boolean {
  if (!checks) return false;
  return checks.rate_negotiated?.result === 'miss' && checks.next_steps?.result === 'miss';
}

/**
 * Does the quote actually appear in the transcript?
 *
 * Compared loosely — punctuation and case are stripped — because a model
 * reproducing speech will tidy commas even when quoting faithfully. Very short
 * quotes are rejected outright: "yes" appears in every transcript and evidences
 * nothing.
 */
function quoteAppears(quote: string, haystack: string): boolean {
  const needle = normalize(quote);
  if (needle.length < 12) return false;
  if (haystack.includes(needle)) return true;
  // Allow for a dropped filler word or a transcription wobble inside the quote
  // by requiring most of its words to appear in order.
  const words = needle.split(' ');
  if (words.length < 4) return false;
  let cursor = 0;
  let hits = 0;
  for (const word of words) {
    const at = haystack.indexOf(word, cursor);
    if (at === -1) continue;
    cursor = at + word.length;
    hits += 1;
  }
  return hits / words.length >= 0.8;
}
