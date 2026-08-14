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
import { CHECKS, scoreFromOutput, type RubricOutput } from './rubric.ts';

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
