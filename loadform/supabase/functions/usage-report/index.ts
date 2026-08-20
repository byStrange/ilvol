/**
 * usage-report — client-reported session telemetry.
 *
 * Records how long a capture actually ran. This is the number that sets the
 * price: per-load COGS is dominated by Deepgram, Deepgram bills per minute, and
 * nothing server-side knows how long a WebSocket carried audio — the stream
 * goes client → Deepgram directly, by design (see deepgram-token).
 *
 * ⚠️ The duration is CLIENT-REPORTED and therefore untrusted. It is analytics
 * only: it must never gate access or compute a charge, because a user can send
 * whatever they like. Quota is spent in deepgram-token, at mint time, on a
 * server-observed capture_started row. For real Deepgram spend, reconcile
 * against Deepgram's own usage API.
 *
 * Calling this is nonetheless what lets an abandoned capture be refunded
 * (20260820000000): the row it writes is the second timestamp the trigger
 * needs to see that a session started and stopped seconds apart having
 * extracted nothing. Note which number that reads — `created_at`, set by
 * Postgres on both rows, not the `audio_seconds` in this body. A client that
 * streams for ten minutes and reports one second is billed for the session it
 * actually held. A session whose end is never reported at all simply keeps its
 * load; there is no way to tell an abort from a crash from silence.
 */

import { json, requireUser, serveJson } from '../_shared/auth.ts';
import { deepgramCostUsd, recordUsage } from '../_shared/usage.ts';

// A capture is auto-stopped well before this; anything longer is a stuck
// session or a forged number, and clamping keeps one bad row from skewing the
// averages we are collecting this data to compute.
const MAX_REPORTED_SECONDS = 4 * 60 * 60;

Deno.serve(
  serveJson(async (req) => {
    const { user } = await requireUser(req);

    const body = await req.json().catch(() => null);
    const captureId: string | null = body?.capture_id ?? null;
    const raw = Number(body?.audio_seconds);

    if (!captureId) {
      return json({ error: 'capture_id is required' }, 400);
    }
    if (!Number.isFinite(raw) || raw < 0) {
      return json({ error: 'audio_seconds must be a non-negative number' }, 400);
    }

    const audioSeconds = Math.min(Math.round(raw), MAX_REPORTED_SECONDS);

    await recordUsage({
      user_id: user.id,
      capture_id: captureId,
      event_type: 'capture_ended',
      audio_seconds: audioSeconds,
      est_cost_usd: deepgramCostUsd(audioSeconds),
      // One end per session. A retry or a double-fire from the widget and the
      // main window both collapse onto this key instead of double-counting.
      idempotency_key: `capture_ended:${captureId}`,
      metadata: { clamped: raw > MAX_REPORTED_SECONDS },
    });

    return json({ ok: true });
  }),
);
