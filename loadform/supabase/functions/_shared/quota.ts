/**
 * Quota enforcement — the gate side of metering.
 *
 * _shared/usage.ts records what happened and never throws, on purpose: a lost
 * analytics row must not break a call in progress. This module is the opposite
 * half — it is allowed to refuse a request, and it runs *before* any provider
 * money is spent.
 *
 * Limits come from the plan_limits table via quota_status() rather than from
 * constants here, so the free cap can be retuned with an UPDATE instead of
 * redeploying every function.
 */

import { serviceClient } from './usage.ts';

export type QuotaStatus = {
  plan: string;
  captures_used: number;
  captures_limit: number | null;
  extractions_used: number;
  extractions_limit: number | null;
};

export type QuotaKind = 'capture' | 'extraction';

export type QuotaDecision = {
  allowed: boolean;
  status: QuotaStatus | null;
  /** Remaining after this request would be counted; null when unlimited. */
  remaining: number | null;
  message?: string;
};

/**
 * Read the caller's plan limits and today's usage.
 *
 * Uses the service role, so it sees true totals rather than whatever RLS would
 * show the user. Returns null if the lookup fails — see checkQuota for why that
 * deliberately does not block the request.
 */
async function readQuota(userId: string): Promise<QuotaStatus | null> {
  const { data, error } = await serviceClient().rpc('quota_status', {
    p_user_id: userId,
  });
  if (error) {
    console.error('quota_status failed:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row as QuotaStatus) ?? null;
}

/**
 * Decide whether one more capture / extraction is allowed today.
 *
 * Fails OPEN when the quota lookup itself errors. That is a deliberate
 * trade-off in the same spirit as best-effort metering: a Postgres hiccup
 * should not stop a paying dispatcher mid-shift, and the blast radius of
 * briefly over-serving is a few cents of provider spend. Every such event is
 * logged above, and the ledger still records the usage either way.
 *
 * Not transactional: two captures started in the same instant can both read
 * used = limit - 1 and both be allowed. Bounding that would mean taking a lock
 * on the hot path of every capture to save at most one session's cost, which is
 * not a trade worth making.
 */
export async function checkQuota(
  userId: string,
  kind: QuotaKind,
): Promise<QuotaDecision> {
  const status = await readQuota(userId);
  if (!status) {
    return { allowed: true, status: null, remaining: null };
  }

  const used = kind === 'capture' ? status.captures_used : status.extractions_used;
  const limit = kind === 'capture' ? status.captures_limit : status.extractions_limit;

  // NULL limit means unlimited — that is how a paid plan is expressed.
  if (limit === null || limit === undefined) {
    return { allowed: true, status, remaining: null };
  }

  if (used >= limit) {
    return {
      allowed: false,
      status,
      remaining: 0,
      message:
        kind === 'capture'
          ? `You've used all ${limit} loads on your plan today. The limit resets at midnight US Central.`
          : `You've hit today's extraction limit (${limit}). The limit resets at midnight US Central.`,
    };
  }

  return { allowed: true, status, remaining: limit - used - 1 };
}

/**
 * Body returned with a 402 so the client can render the wall precisely rather
 * than showing a generic failure. api.js already maps 402 → quotaExceeded.
 */
export function quotaExceededBody(decision: QuotaDecision) {
  return {
    error: decision.message ?? 'Daily limit reached',
    quota: {
      plan: decision.status?.plan ?? 'free',
      captures_used: decision.status?.captures_used ?? 0,
      captures_limit: decision.status?.captures_limit ?? null,
      extractions_used: decision.status?.extractions_used ?? 0,
      extractions_limit: decision.status?.extractions_limit ?? null,
    },
  };
}
