/**
 * Rubric scoring tests.
 *
 *   deno test supabase/functions/_shared/rubric.test.ts
 *
 * The cases that matter are the adversarial ones. This score is attached to a
 * person's job, so the questions worth asking are "can the model inflate it"
 * and "can a call be punished for something that never had a chance to happen".
 */

import { assertEquals } from 'jsr:@std/assert@1';
import {
  CHECKS,
  lossReasonFromOutput,
  lostOnCall,
  scoreFromOutput,
  type RubricOutput,
  type ScoredCall,
} from './rubric.ts';

const TRANSCRIPT = `Hey this is Mike over at TQL. I got a reefer load picking up in
Amarillo Texas tomorrow morning eight AM appointment, delivering Tulsa Oklahoma
Thursday by six AM. It's frozen chicken, forty three thousand pounds.
Dispatcher: what does it pay? Broker: I can do two thousand one hundred all in.
Dispatcher: that's low for that lane, I need twenty three hundred to make it work.
Broker: I can go to twenty two fifty. Dispatcher: alright let's do twenty two fifty.
Is there a lumper at delivery? Broker: yes about a hundred fifty, we cover it with
a T-check. Dispatcher: perfect, send me the rate confirmation and I'll get you the
driver info.`;

function output(checks: Record<string, { result: string; quote?: string }>): RubricOutput {
  return { scoreable: true, checks };
}

/** Every check passing, each with a real quote. */
function allPass(): Record<string, { result: string; quote: string }> {
  const quotes: Record<string, string> = {
    rate_asked: 'what does it pay',
    rate_negotiated: 'I need twenty three hundred to make it work',
    pickup_confirmed: 'Amarillo Texas tomorrow morning eight AM appointment',
    delivery_confirmed: 'delivering Tulsa Oklahoma Thursday by six AM',
    appointment_type: 'eight AM appointment',
    freight_details: 'frozen chicken, forty three thousand pounds',
    equipment_confirmed: 'I got a reefer load picking up',
    accessorials_raised: 'Is there a lumper at delivery',
    next_steps: 'send me the rate confirmation',
  };
  const out: Record<string, { result: string; quote: string }> = {};
  for (const { id } of CHECKS) out[id] = { result: 'pass', quote: quotes[id] };
  return out;
}

Deno.test('a fully-run call scores 100', () => {
  const scored = scoreFromOutput(output(allPass()), TRANSCRIPT)!;
  assertEquals(scored.score, 100);
  assertEquals(scored.applicable, 9);
  assertEquals(scored.passed, 9);
});

Deno.test('a pass with no quote is downgraded to a miss', () => {
  const checks = allPass();
  checks.accessorials_raised = { result: 'pass', quote: '' };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.checks.accessorials_raised.result, 'miss');
  assertEquals(scored.passed, 8);
});

Deno.test('a pass quoting words that are not in the transcript is downgraded', () => {
  const checks = allPass();
  // Plausible-sounding, entirely invented.
  checks.accessorials_raised = {
    result: 'pass',
    quote: 'I also asked about detention pay and driver assist charges',
  };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.checks.accessorials_raised.result, 'miss');
  assertEquals(scored.passed, 8);
});

Deno.test('a trivially short quote does not evidence anything', () => {
  const checks = allPass();
  checks.rate_asked = { result: 'pass', quote: 'yes' };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.checks.rate_asked.result, 'miss');
});

Deno.test('quotes still match when punctuation and case differ', () => {
  const checks = allPass();
  checks.rate_negotiated = {
    result: 'pass',
    quote: "I NEED twenty-three hundred, to make it work!",
  };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.checks.rate_negotiated.result, 'pass');
});

Deno.test('not-applicable steps leave the denominator entirely', () => {
  const checks = allPass();
  // The load was gone before money came up: negotiation never had a chance.
  checks.rate_negotiated = { result: 'na', quote: '' };
  checks.next_steps = { result: 'na', quote: '' };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.applicable, 7);
  assertEquals(scored.passed, 7);
  assertEquals(scored.score, 100); // not 78 — an N/A is not a failure
});

Deno.test('an unknown result value is treated as a miss, never a pass', () => {
  const checks = allPass();
  checks.rate_asked = { result: 'excellent', quote: 'what does it pay' };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.checks.rate_asked.result, 'miss');
});

Deno.test('a missing check is a miss rather than a crash', () => {
  const checks = allPass();
  delete checks.next_steps;
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.checks.next_steps.result, 'miss');
  assertEquals(scored.applicable, 9);
});

Deno.test('an unscoreable call yields no score at all', () => {
  assertEquals(scoreFromOutput({ scoreable: false, reason: 'too garbled' }, TRANSCRIPT), null);
});

Deno.test('a call where every step is N/A has no score, not a zero', () => {
  const checks: Record<string, { result: string; quote: string }> = {};
  for (const { id } of CHECKS) checks[id] = { result: 'na', quote: '' };
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.applicable, 0);
  assertEquals(scored.score, null);
});

Deno.test('a half-run call scores proportionally', () => {
  const checks = allPass();
  for (const id of ['accessorials_raised', 'appointment_type', 'next_steps']) {
    checks[id] = { result: 'miss', quote: '' };
  }
  const scored = scoreFromOutput(output(checks), TRANSCRIPT)!;
  assertEquals(scored.passed, 6);
  assertEquals(scored.applicable, 9);
  assertEquals(scored.score, 66.67);
});

/* ─── Loss reasons ──────────────────────────────────────────────────────────
 *
 * This inference decides what an owner is told about why their freight is not
 * moving, and in one case it names the dispatcher. The tests that matter are
 * therefore the ones asking whether it can say that without evidence.
 */

const LOST_TRANSCRIPT = `Hey it's Dave calling on that Kansas City to Denver load.
Broker: yeah that one's already covered, sorry man, went out about an hour ago.
Dispatcher: alright, anything else heading west? Broker: nothing today. Dispatcher: okay
thanks, I'll check back tomorrow.`;

Deno.test('a stated reason with a real quote is recorded', () => {
  const finding = lossReasonFromOutput(
    { reason: 'already_covered', quote: "that one's already covered" },
    LOST_TRANSCRIPT
  );
  assertEquals(finding.reason, 'already_covered');
});

Deno.test('a reason the transcript does not contain is discarded', () => {
  const finding = lossReasonFromOutput(
    // Plausible, and nowhere in the call.
    { reason: 'rate_too_low', quote: 'I can only pay seventeen hundred on that one' },
    LOST_TRANSCRIPT
  );
  assertEquals(finding.reason, null);
  assertEquals(finding.note, 'unevidenced');
});

Deno.test('a reason with no quote at all is discarded', () => {
  const finding = lossReasonFromOutput({ reason: 'no_truck', quote: '' }, LOST_TRANSCRIPT);
  assertEquals(finding.reason, null);
  assertEquals(finding.note, 'unevidenced');
});

Deno.test('"unknown" is a clean answer, not a failure', () => {
  const finding = lossReasonFromOutput({ reason: 'unknown', quote: '' }, LOST_TRANSCRIPT);
  assertEquals(finding.reason, null);
  assertEquals(finding.note, 'not_stated');
});

Deno.test('the model cannot reach for lost_on_call, however well it quotes', () => {
  // The one reason that lands on a person is never the model's to give: it is
  // derived from missed steps, and offering it here would be exactly the
  // unevidenced judgement the rubric exists to prevent.
  const finding = lossReasonFromOutput(
    { reason: 'lost_on_call', quote: "I'll check back tomorrow" },
    LOST_TRANSCRIPT
  );
  assertEquals(finding.reason, null);
  assertEquals(finding.note, 'invalid_reason');
});

Deno.test('an invented reason outside the taxonomy is discarded', () => {
  const finding = lossReasonFromOutput(
    { reason: 'dispatcher_was_rude', quote: "that one's already covered" },
    LOST_TRANSCRIPT
  );
  assertEquals(finding.reason, null);
  assertEquals(finding.note, 'invalid_reason');
});

/** Rubric checks with the two that decide lostOnCall set as given. */
function checksWith(
  negotiated: string,
  nextSteps: string
): ScoredCall['checks'] {
  const scored = scoreFromOutput(output(allPass()), TRANSCRIPT)!;
  scored.checks.rate_negotiated = { result: negotiated as 'pass', quote: '' };
  scored.checks.next_steps = { result: nextSteps as 'pass', quote: '' };
  return scored.checks;
}

Deno.test('neither pushed on money nor arranged anything: lost on the call', () => {
  assertEquals(lostOnCall(checksWith('miss', 'miss')), true);
});

Deno.test('one of the two done is not enough to blame the dispatcher', () => {
  // Deliberately conservative. A false positive here starts a conversation
  // somebody did not earn; a false negative costs one row of missing data.
  assertEquals(lostOnCall(checksWith('pass', 'miss')), false);
  assertEquals(lostOnCall(checksWith('miss', 'pass')), false);
});

Deno.test('steps that never had a chance to happen do not convict', () => {
  // The load was gone before money came up, so there was nothing to negotiate
  // and nothing to arrange. That is the broker's news, not a bad call.
  assertEquals(lostOnCall(checksWith('na', 'na')), false);
  assertEquals(lostOnCall(checksWith('na', 'miss')), false);
});

Deno.test('an unscored call cannot be lost on the call', () => {
  assertEquals(lostOnCall(null), false);
  assertEquals(lostOnCall(undefined), false);
});
