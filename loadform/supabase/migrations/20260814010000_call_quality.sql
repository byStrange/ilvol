-- Why loads are lost, and how the call was run.
--
-- Two related additions, in the order they matter.
--
-- ─── 1. Loss reasons ────────────────────────────────────────────────────────
--
-- A lost load currently says nothing about whose problem it was, and most lost
-- loads are not the dispatcher's. Rate too low is a pricing decision; no truck
-- in the area is capacity planning; already covered is timing and belongs to
-- nobody. Only a load lost ON the call — no counter, no rapport, unprepared —
-- is a performance signal.
--
-- Without this split an owner reads a low booking rate as a bad dispatcher,
-- which is both unfair and expensive: the actual fix is often a rate target,
-- not a firing. The taxonomy is fixed rather than free text because a reason
-- that can't be counted can't be charted, and a field nobody aggregates is a
-- field nobody reads. The note carries the specifics on top.

alter table public.loads
  add column if not exists loss_reason text;

alter table public.loads
  add column if not exists loss_note text;

alter table public.loads
  drop constraint if exists loads_loss_reason_check;

alter table public.loads
  add constraint loads_loss_reason_check
  check (
    loss_reason is null
    or loss_reason in (
      'rate_too_low',      -- the money didn't work for us
      'already_covered',   -- gone before we called
      'no_truck',          -- no truck in the area, or wrong equipment
      'requirements',      -- authority, insurance, TWIC, hazmat endorsement
      'schedule',          -- couldn't hold the pickup or delivery window
      'lost_on_call',      -- we were in the running and didn't close it
      'other'
    )
  );

comment on column public.loads.loss_reason is
  'Why a load was lost, from a fixed taxonomy. Only lost_on_call reflects on '
  'the dispatcher; the rest are pricing, capacity or timing problems that '
  'happen to be recorded against a person.';

-- ─── 2. Call quality ────────────────────────────────────────────────────────
--
-- A per-call review of whether the dispatcher ran the play: nine observable
-- steps, each answered from the transcript with the quote that justifies it.
-- Deliberately NOT a holistic judgement of how well someone spoke.
--
-- The reason is not squeamishness, it's measurement error. These are ASR
-- transcripts of speakerphone calls in a noisy office, and word error rate
-- tracks accent — so a model asked to rate fluency or professionalism would be
-- scoring transcription quality, and by extension the accents of a workforce
-- that is heavily non-native-speaking. "Did they ask about detention" survives
-- a mangled transcript; "were they articulate" does not.
--
-- call_checks holds one entry per check:
--   { "rate_asked": { "result": "pass" | "miss" | "na", "quote": "..." } }
-- A pass without a verbatim quote is discarded by the scorer, which is the
-- strongest anti-hallucination constraint available here — and it means a
-- dispatcher can audit and dispute any mark against them.

alter table public.loads
  add column if not exists call_checks jsonb;

alter table public.loads
  add column if not exists call_score numeric(5, 2);

alter table public.loads
  add column if not exists call_scored_at timestamptz;

-- Why a call was not scored, when it wasn't: too short to contain the steps,
-- transcript too poor to judge, or the provider failed. Kept rather than left
-- null so "not scored" is never silently read as "scored badly".
alter table public.loads
  add column if not exists call_score_skipped text;

comment on column public.loads.call_score is
  'Share of applicable steps the dispatcher completed on this call, 0-100. '
  'NULL when the call was not scored — see call_score_skipped. Never mix with '
  'outcome metrics: this measures process, which the dispatcher controls.';

comment on column public.loads.call_checks is
  'Per-step result and the verbatim transcript quote justifying it. A pass '
  'with no quote is not a pass.';

-- ─── 3. Column grants ───────────────────────────────────────────────────────
--
-- The load owner policy is FOR ALL, so a dispatcher can currently UPDATE any
-- column on their own rows — including, as of this migration, their own score.
-- RLS has no column granularity, so grants are the only mechanism.
--
-- Everything a dispatcher legitimately edits is listed; the four scoring
-- columns are absent and therefore service-role-only. loss_reason and loss_note
-- ARE editable: they are the dispatcher's own account of what happened, and a
-- reason they cannot correct is a reason they will stop giving honestly.

revoke update on public.loads from authenticated;

grant update (
  title,
  status,
  outcome,
  loss_reason,
  loss_note,
  pickup_location,
  pickup_datetime,
  pickup_type,
  pickup_window,
  delivery_location,
  delivery_datetime,
  delivery_type,
  delivery_window,
  stops,
  commodity,
  equipment_type,
  trailer_instructions,
  rate,
  rate_usd,
  miles,
  weight,
  additional_notes,
  confidence,
  transcript,
  updated_at
) on public.loads to authenticated;

-- ─── 4. Usage event type ────────────────────────────────────────────────────
--
-- Scoring a call spends provider money, so it meters like every other billable
-- action rather than running free and invisible.

alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;

alter table public.usage_events
  add constraint usage_events_event_type_check
  check (event_type in ('capture_started', 'capture_ended', 'load_extracted', 'call_scored'));

-- Finding what still needs scoring is the scorer's hot path: resolved calls
-- carrying a transcript that nothing has looked at yet.
create index if not exists loads_unscored_idx
  on public.loads (org_id, created_at desc)
  where call_scored_at is null and call_score_skipped is null and outcome <> 'pending';
