#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * Extraction eval harness.
 *
 * Sends the REAL production prompt (imported from _shared/prompt.ts) against
 * realistic broker-call transcripts and scores the result field by field.
 *
 *   deno run --allow-net --allow-env evals/run.ts --provider ollama --model gemma3:12b
 *   deno run --allow-net --allow-env evals/run.ts --provider gemini --model gemini-2.5-flash
 *   deno run --allow-net --allow-env evals/run.ts --provider ollama --model qwen3:8b --only messy_asr_and_corrections
 *
 * Env: OLLAMA_API_KEY / OLLAMA_BASE_URL, or GEMINI_API_KEY.
 *
 * Two scores are reported and they mean different things:
 *   accuracy   — did it get stated fields right?
 *   discipline — did it leave unstated fields empty? A model that invents a
 *                delivery city is more dangerous than one that misses a rate,
 *                because the dispatcher pastes it straight to a driver.
 */

import { buildPrompt, FIELDS, stripFences } from '../supabase/functions/_shared/prompt.ts';
import { FIXTURES } from './fixtures.ts';

// ─── Args ───────────────────────────────────────────────────────────────────

function arg(name: string, fallback = ''): string {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : fallback;
}

const provider = arg('provider', 'ollama');
const model = arg('model', provider === 'gemini' ? 'gemini-2.5-flash' : 'gemma4:31b-cloud');
const only = arg('only');
const verbose = Deno.args.includes('--verbose');

// Dump the exact production prompt without calling any provider, for pasting
// into a playground or eyeballing what the model actually receives.
if (Deno.args.includes('--print-prompt')) {
  const picked = only ? FIXTURES.filter((f) => f.name === only) : FIXTURES.slice(0, 1);
  for (const fx of picked) {
    console.log(`${'='.repeat(70)}\n${fx.name}\n${'='.repeat(70)}`);
    console.log(buildPrompt(fx.transcript));
    console.log();
  }
  Deno.exit(0);
}

// ─── Providers ──────────────────────────────────────────────────────────────

type Result = { text: string; ms: number; inTok?: number; outTok?: number };

async function callOllama(prompt: string): Promise<Result> {
  const base = (Deno.env.get('OLLAMA_BASE_URL') ?? 'https://ollama.com').replace(/\/+$/, '');
  const key = Deno.env.get('OLLAMA_API_KEY') ?? '';
  const t0 = performance.now();
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return { text: j.response, ms, inTok: j.prompt_eval_count, outTok: j.eval_count };
}

async function callGemini(prompt: string): Promise<Result> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const t0 = performance.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return {
    text: j.candidates?.[0]?.content?.parts?.map((p: { text: string }) => p.text).join('') ?? '',
    ms,
    inTok: j.usageMetadata?.promptTokenCount,
    outTok: j.usageMetadata?.candidatesTokenCount,
  };
}

const call = provider === 'gemini' ? callGemini : callOllama;

// ─── Scoring ────────────────────────────────────────────────────────────────

/** Values models use to mean "not mentioned". All count as empty. */
const EMPTY = /^(|none|n\/?a|null|unknown|not specified|not mentioned|not provided|-+|\.\.\.)$/i;

const isEmpty = (v: unknown) => v == null || EMPTY.test(String(v).trim());

function fieldPasses(expected: RegExp[] | null, actual: unknown): boolean {
  if (expected === null) return isEmpty(actual);
  if (isEmpty(actual)) return false;
  const s = String(actual);
  // Any one accepted pattern is enough — "Amarillo, TX" and "Amarillo Texas"
  // are both right, and scoring them as wrong would just hide real failures.
  return expected.some((re) => re.test(s));
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', YEL = '\x1b[33m', OFF = '\x1b[0m';

// ─── Run ────────────────────────────────────────────────────────────────────

console.log(`\n${DIM}provider${OFF} ${provider}   ${DIM}model${OFF} ${model}\n`);

let accOk = 0, accTotal = 0;
let disOk = 0, disTotal = 0;
let totalMs = 0, totalIn = 0, totalOut = 0, jsonFailures = 0;

const fixtures = only ? FIXTURES.filter((f) => f.name === only) : FIXTURES;
if (!fixtures.length) {
  console.error(`No fixture named "${only}". Available: ${FIXTURES.map((f) => f.name).join(', ')}`);
  Deno.exit(2);
}

for (const fx of fixtures) {
  console.log(`${YEL}▸ ${fx.name}${OFF}`);
  console.log(`  ${DIM}${fx.why}${OFF}`);

  let out: Result;
  try {
    out = await call(buildPrompt(fx.transcript));
  } catch (err) {
    console.log(`  ${RED}REQUEST FAILED${OFF} ${(err as Error).message}\n`);
    jsonFailures++;
    continue;
  }
  totalMs += out.ms;
  totalIn += out.inTok ?? 0;
  totalOut += out.outTok ?? 0;

  let parsed: { data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(stripFences(out.text));
  } catch {
    // This is a hard failure: production returns 502 here, so the dispatcher
    // sees nothing at all. Worth calling out separately from a wrong field.
    console.log(`  ${RED}INVALID JSON${OFF} — production would 502 on this`);
    if (verbose) console.log(`  ${DIM}${out.text.slice(0, 400)}${OFF}`);
    console.log();
    jsonFailures++;
    continue;
  }

  const data = parsed.data ?? {};
  for (const [field, expected] of Object.entries(fx.expect)) {
    const actual = data[field];
    const pass = fieldPasses(expected, actual);
    const invented = expected === null;

    if (invented) { disTotal++; if (pass) disOk++; }
    else { accTotal++; if (pass) accOk++; }

    const shown = isEmpty(actual) ? `${DIM}(empty)${OFF}` : String(actual).slice(0, 58);
    const want = invented ? `${DIM}must stay empty${OFF}` : '';
    if (!pass || verbose) {
      console.log(`  ${pass ? GREEN + '✓' : RED + '✗'}${OFF} ${field.padEnd(22)} ${shown} ${want}`);
    }
  }

  // Any field the fixture didn't pin, but which the model filled with something
  // not in the transcript, is invisible to scoring — flag unpinned extras so a
  // hallucination in an unchecked field still gets a human look.
  const unpinned = FIELDS.filter((f) => !(f in fx.expect) && !isEmpty(data[f]));
  if (unpinned.length && verbose) {
    console.log(`  ${DIM}unpinned filled: ${unpinned.join(', ')}${OFF}`);
  }
  console.log();
}

// ─── Report ─────────────────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(0) : '—');
const n = fixtures.length;

console.log('─'.repeat(58));
console.log(`accuracy    ${pct(accOk, accTotal)}%  ${DIM}(${accOk}/${accTotal} stated fields correct)${OFF}`);
console.log(`discipline  ${pct(disOk, disTotal)}%  ${DIM}(${disOk}/${disTotal} unstated fields left empty)${OFF}`);
if (jsonFailures) console.log(`${RED}json failures ${jsonFailures}/${n}${OFF} ${DIM}— these 502 in production${OFF}`);
console.log(`${DIM}avg latency ${(totalMs / n / 1000).toFixed(1)}s   tokens ~${Math.round(totalIn / n)} in / ${Math.round(totalOut / n)} out per call${OFF}`);
console.log('─'.repeat(58));

// A model is only shippable if it never emits unparseable JSON and does not
// invent fields; raw accuracy can be recovered by the dispatcher editing, the
// other two cannot.
const shippable = jsonFailures === 0 && disOk === disTotal && accOk / accTotal >= 0.8;
console.log(shippable ? `${GREEN}SHIPPABLE${OFF}` : `${RED}NOT SHIPPABLE${OFF}`);
Deno.exit(shippable ? 0 : 1);
