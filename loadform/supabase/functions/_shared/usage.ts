/**
 * Usage metering — the write side of usage_events.
 *
 * Every billable action passes through an Edge Function, so this is the only
 * place usage is recorded. Clients have SELECT on their own rows and no write
 * grant at all, which is what makes the numbers trustworthy.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Provider rates, overridable by secret so they can be recalibrated without a
 * code deploy.
 *
 * ⚠️ These are estimates and drift with provider pricing. Costs are snapshotted
 * onto each event at write time, so changing them only affects future rows —
 * history stays accurate. Reconcile against provider invoices before trusting
 * these for margin decisions.
 */
export const RATES = {
  // Deepgram nova-2 streaming (audio_capture.rs requests model=nova-2).
  deepgramUsdPerMinute: Number(Deno.env.get('COST_DEEPGRAM_USD_PER_MIN') ?? '0.0059'),
  llmUsdPer1mInput: Number(Deno.env.get('COST_LLM_USD_PER_1M_INPUT') ?? '0.10'),
  llmUsdPer1mOutput: Number(Deno.env.get('COST_LLM_USD_PER_1M_OUTPUT') ?? '0.40'),
};

export function llmCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * RATES.llmUsdPer1mInput +
    (outputTokens / 1_000_000) * RATES.llmUsdPer1mOutput
  );
}

export function deepgramCostUsd(audioSeconds: number): number {
  return (audioSeconds / 60) * RATES.deepgramUsdPerMinute;
}

export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type UsageEvent = {
  user_id: string;
  capture_id?: string | null;
  event_type: 'capture_started' | 'capture_ended' | 'load_extracted';
  load_id?: string | null;
  source?: 'mic' | 'system' | 'mixed' | null;
  llm_input_tokens?: number | null;
  llm_output_tokens?: number | null;
  audio_seconds?: number | null;
  est_cost_usd?: number;
  idempotency_key?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Record one usage event.
 *
 * Deliberately never throws. Metering must not be able to break capture or
 * extraction for a paying user — a lost analytics row is a far smaller problem
 * than a dispatcher unable to work mid-call. Once quota enforcement goes in,
 * the *gate* is what blocks; this stays best-effort.
 *
 * A duplicate idempotency_key (23505) is a successful no-op: it means the same
 * logical action was retried and is already counted.
 */
export async function recordUsage(event: UsageEvent): Promise<void> {
  try {
    const { error } = await serviceClient()
      .from('usage_events')
      .insert({ est_cost_usd: 0, ...event });

    if (error && error.code !== '23505') {
      console.error('usage insert failed:', error.message, error.code);
    }
  } catch (err) {
    console.error('usage insert threw:', err);
  }
}
