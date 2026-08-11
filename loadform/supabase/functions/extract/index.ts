/**
 * extract — LLM extraction proxy.
 *
 * Unlike Deepgram, this is a true proxy: one short request/response per call,
 * which fits an Edge Function perfectly. The Ollama key stays server-side and
 * the client only ever sends a transcript and gets structured fields back.
 *
 * The prompt lives server-side (in _shared/prompt.ts) rather than in the Rust
 * binary on purpose — prompt tuning is the thing you iterate on most, and this
 * way it ships with a function deploy instead of a signed desktop release that
 * users must install. evals/run.ts imports the same module, so what the eval
 * scores is exactly what production sends.
 */

import { json, requireUser, serveJson } from '../_shared/auth.ts';
import { llmCostUsd, recordUsage } from '../_shared/usage.ts';
import { buildPrompt, stripFences } from '../_shared/prompt.ts';

const OLLAMA_BASE_URL = Deno.env.get('OLLAMA_BASE_URL') ?? 'https://ollama.com';
const OLLAMA_API_KEY = Deno.env.get('OLLAMA_API_KEY')!;
const OLLAMA_MODEL = Deno.env.get('OLLAMA_MODEL') ?? 'gemma4:31b-cloud';

Deno.serve(
  serveJson(async (req) => {
    const { user } = await requireUser(req);

    const body = await req.json().catch(() => null);
    const transcript = (body?.transcript ?? '').trim();
    const captureId: string | null = body?.capture_id ?? null;

    if (!transcript) {
      return json({ error: 'transcript is required' }, 400);
    }

    // ─── Quota gate ──────────────────────────────────────────────────────
    // TODO(billing): check plan + remaining quota before spending tokens, and
    // return 402 when exhausted.

    if (!OLLAMA_API_KEY) {
      return json({ error: 'OLLAMA_API_KEY secret is not configured' }, 500);
    }

    const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OLLAMA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildPrompt(transcript),
        stream: false,
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.error(`Ollama error ${res.status}: ${bodyText}`);
      return json({ error: `Extraction provider error (${res.status})` }, 502);
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
      // Server-observed counts straight from the provider — safe to bill on.
      inputTokens = provider.prompt_eval_count ?? 0;
      outputTokens = provider.eval_count ?? 0;
    } catch {
      return json({ error: 'Malformed response from extraction provider' }, 502);
    }

    let parsed: { data: Record<string, string>; confidence: Record<string, number> };
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      console.error(`Unparseable model output for user ${user.id}: ${raw.slice(0, 500)}`);
      return json({ error: 'Model returned invalid JSON' }, 502);
    }

    // Recorded only on success. A failed extraction produced nothing the
    // dispatcher can use, so charging for it would be indefensible — and the
    // 502 paths above return before reaching here.
    await recordUsage({
      user_id: user.id,
      capture_id: captureId,
      event_type: 'load_extracted',
      llm_input_tokens: inputTokens,
      llm_output_tokens: outputTokens,
      est_cost_usd: llmCostUsd(inputTokens, outputTokens),
      metadata: { model: OLLAMA_MODEL, transcript_chars: transcript.length },
    });

    return json({ data: parsed.data, confidence: parsed.confidence });
  }),
);
