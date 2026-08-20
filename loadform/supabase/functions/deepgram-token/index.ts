/**
 * deepgram-token — short-lived Deepgram credential broker.
 *
 * This is NOT a streaming proxy, and deliberately so. Supabase Edge Functions
 * hard-cap at 150s (Free) / 400s (Pro) of wall clock, and that cap applies to
 * WebSockets too — EdgeRuntime.waitUntil() stops a worker being retired early
 * but does not extend the limit. Piping a 5–15 minute call through here would
 * drop the socket mid-sentence, double our egress (audio in + transcript out),
 * and add a hop of latency to a real-time product.
 *
 * Instead we mint an ephemeral Deepgram access token. The token only has to be
 * valid at WebSocket *handshake* time — once the stream is established it stays
 * open for the whole call — so a 60-second TTL comfortably covers an hour-long
 * conversation. The long-lived API key never leaves the server, and this
 * function stays the server-side chokepoint where quota gets enforced.
 */

import { json, requireUser, serveJson } from '../_shared/auth.ts';
import { recordUsage } from '../_shared/usage.ts';
import { checkQuota, quotaExceededBody } from '../_shared/quota.ts';

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY')!;

// Long enough to survive a slow client hop from JS → Rust → Deepgram handshake,
// short enough that a leaked token is worthless.
const TOKEN_TTL_SECONDS = 60;

Deno.serve(
  serveJson(async (req) => {
    const { user } = await requireUser(req);

    // ─── Quota gate ──────────────────────────────────────────────────────
    // The chokepoint: no token means no transcription and no Deepgram spend,
    // and it cannot be bypassed client-side. Checked before the grant call so
    // an over-quota user costs us nothing at all.
    //
    // Counting here means the cap is spent on the press, before there is any
    // audio to justify it. That is the only place it *can* be spent — the
    // stream never touches a server we own — so the correction happens after
    // the fact instead: a session that stops within seconds having extracted
    // nothing is refunded by the rollup trigger (20260820000000).
    const quota = await checkQuota(user.id, 'capture');
    if (!quota.allowed) {
      return json(quotaExceededBody(quota), 402);
    }

    if (!DEEPGRAM_API_KEY) {
      return json({ error: 'DEEPGRAM_API_KEY secret is not configured' }, 500);
    }

    const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.error(`Deepgram grant failed ${res.status}: ${bodyText}`);

      // Surface Deepgram's own error code. It is the difference between "this
      // is broken" and "the key needs Member scope", and the Supabase CLI has
      // no `functions logs` subcommand — without this you are stuck reading the
      // dashboard to debug a one-line misconfiguration.
      let detail = '';
      try {
        const e = JSON.parse(bodyText);
        detail = e.err_code ?? e.error ?? e.err_msg ?? '';
      } catch {
        detail = bodyText.slice(0, 200);
      }

      const hint = res.status === 403
        ? ' — the DEEPGRAM_API_KEY needs at least "Member" scope to mint tokens'
        : '';

      return json(
        { error: `Deepgram token grant failed (${res.status})${detail ? `: ${detail}` : ''}${hint}` },
        502,
      );
    }

    const grant = JSON.parse(bodyText) as {
      access_token: string;
      expires_in: number;
    };

    // One id per capture session, threaded through the client so this grant,
    // every extraction it produces, and the session's end all correlate.
    const captureId = crypto.randomUUID();

    const body = await req.json().catch(() => ({}));
    const source = ['mic', 'system', 'mixed'].includes(body?.source) ? body.source : null;

    await recordUsage({
      user_id: user.id,
      capture_id: captureId,
      event_type: 'capture_started',
      source,
      idempotency_key: `capture_started:${captureId}`,
    });

    return json({
      access_token: grant.access_token,
      expires_in: grant.expires_in,
      capture_id: captureId,
      // Loads left today once this session is counted; null when unlimited.
      // Saves the client a follow-up round trip just to refresh the counter.
      captures_remaining: quota.remaining,
      captures_limit: quota.status?.captures_limit ?? null,
    });
  }),
);
